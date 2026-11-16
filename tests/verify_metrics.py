#!/usr/bin/env python3
"""Independently recompute the dashboard's headline numbers with pandas and
assert they match what the browser rendered.

    node tests/e2e.mjs data.csv --out tests/output --name run [--groups groups.csv] [--notes notes.csv]
    python3 tests/verify_metrics.py data.csv tests/output/run.json [--groups groups.csv] [--notes notes.csv]

This is a separate implementation (pandas/numpy, not a port of metrics.js)
of the rules in docs/csv-format.md. It checks exact cents, rates, top-5
concentration, retry chains, per-bucket revenue, every customer's trend slope,
RFM segment sizes and the KPI text shown on screen. Exits 1 on any mismatch.
Nothing is written anywhere; the CSV is opened read-only.
"""
from __future__ import annotations

import json
import re
import sys
from decimal import ROUND_HALF_UP, Decimal

import numpy as np
import pandas as pd

ONE_TIME = "One-Time Manual Charge"
ALIASES = {
    "date": ["datetime", "dateandtime", "transactiondate", "transactiondatetime", "date"],
    "customer": ["customernumber", "customername", "customer", "customerno"],
    "amount": ["amount", "amountcents", "transactionamount"],
    "card": ["cardtype", "cardscheme", "cardbrand"],
    "status": ["status", "transactionstatus", "result"],
}
OPTIONAL = {"cardholder": ["cardholdersname", "cardholdername", "cardholder", "nameoncard"]}


def load_groups(path: str | None) -> tuple[dict[str, str], dict[str, str]]:
    """Customer-groups file (read independently). Returns two maps:
    customer number → group, and cardholder → group for manual charges
    (rows whose Customer Number is blank)."""
    if not path:
        return {}, {}
    g = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    cols = {re.sub(r"[^a-z0-9]+", " ", c.lower()).strip(): c for c in g.columns}
    src, dst = cols["customer number"], cols["group as"]
    holder = next((c for k, c in cols.items() if k.startswith("cardholder")), None)
    tidy = lambda s: s.str.strip().str.replace(r"\s+", " ", regex=True)
    names, groups = tidy(g[src]), tidy(g[dst])
    holders = tidy(g[holder]) if holder else pd.Series([""] * len(g))
    by_name = {k: v for k, v in zip(names, groups) if k and v}
    by_holder = {h: v for k, h, v in zip(names, holders, groups) if not k and h and v}
    return by_name, by_holder


NORM = lambda s: re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()
PAYS = {"card": None, "eft": "EFT", "etransfer": "EFT", "e transfer": "EFT", "bank transfer": "EFT", "cheque": "cheque", "check": "cheque", "mixed": "mixed", "card and eft": "mixed"}
CYCLES = {"weekly": "weekly", "week": "weekly", "monthly": "monthly", "month": "monthly", "month to month": "monthly", "30 day terms": "monthly",
          "seasonal": "seasonal", "sporadic": "sporadic", "occasional": "sporadic", "irregular": "sporadic", "rare": "sporadic",
          "on request": "on request", "by request": "on request", "prior warning": "on request"}
STATUSES = {"active": None, "stopped ordering": "stopped ordering", "stopped": "stopped ordering", "closed": "closed", "shut down": "closed", "lost": "stopped ordering"}


UNKNOWN_WORDS = {"unknown", "not sure", "dont know", "don t know", "n a", "na", "tbc", "tbd"}
SEMI_ACTIVE = {"semi active", "semiactive", "partly active", "part active", "semi"}
CYCLE_DAYS = {"weekly": 7.0, "monthly": 365.25 / 12}


def osa(a: str, b: str) -> int:
    """Edit distance with adjacent transpositions (typos such as "Cheuqe")."""
    d = [[i] + [0] * len(b) for i in range(len(a) + 1)]
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def classify(raw: str, own: str):
    """(field, value, days) for one notes cell, read as clearly meant, or None."""
    tables = {"pays": PAYS, "cycle": CYCLES, "status": STATUSES}
    v = NORM(raw)
    if not v or v in UNKNOWN_WORDS or v == "?":
        return None
    if v in SEMI_ACTIVE:
        return ("status", "active", None)
    order = [own] + [f for f in tables if f != own]
    for f in order:
        if v in tables[f]:
            return (f, tables[f][v] or ("card" if f == "pays" else "active"), None)
    if v in ("fortnightly", "biweekly", "bi weekly", "every two weeks", "every 2 weeks"):
        return ("cycle", "every 14 days", 14)
    m = re.search(r"(\d{1,3})\s*(?:-\s*)?days?\b", v) or re.search(r"\bnet\s*(\d{1,3})\b", v)
    if m and 1 <= int(m.group(1)) <= 366:
        n = int(m.group(1))
        return ("cycle", "weekly" if n == 7 else "monthly" if 28 <= n <= 31 else f"every {n} days", n)
    for f in order:
        for k, val in tables[f].items():
            if len(k) >= 6 and osa(v, k) <= (2 if len(k) >= 8 else 1):
                return (f, val or ("card" if f == "pays" else "active"), None)
    return None


def load_notes(path: str | None) -> dict[str, dict]:
    """Customer-notes file (read independently): normalised name → {pays, cycle, days, status, since_end}.
    Read as clearly meant: a value in another column (\"sporadic\" under Status), a
    typo (\"Cheuqe\"), \"semi-active\", \"unknown\" or \"on 21 days\"; unreadable cells skipped."""
    if not path:
        return {}
    g = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    cols = {re.sub(r"[^a-z0-9]+", " ", c.lower()).strip(): c for c in g.columns}
    col = lambda *names: next((cols[n] for n in names if n in cols), None)
    ci = col("customer", "customer number", "customer name", "name")
    own = {"pays": col("pays by", "payment method", "pays"), "cycle": col("cycle", "rhythm", "terms"), "status": col("status")}
    si, ni = col("since"), col("note", "notes", "comment")
    out = {}
    for _, r in g.iterrows():
        name = NORM(r[ci])
        if not name:
            continue
        n = {"pays": None, "cycle": None, "days": None, "status": None, "since_end": None}
        cells = [(f, str(r[c]) if c else "") for f, c in own.items()]
        got = [(f, classify(raw, f)) for f, raw in cells]
        got.sort(key=lambda x: 0 if x[1] and x[1][0] == x[0] else 1)   # each column's own value first
        filled = set()
        for f, c in got:
            if not c or c[0] in filled:
                continue
            filled.add(c[0])
            n[c[0]] = c[1]
            if c[2]:
                n["days"] = c[2]
        if n["pays"] == "card":
            n["pays"] = None
        if n["status"] == "active":
            n["status"] = None
        since = str(r[si]).strip() if si else ""
        m = re.fullmatch(r"(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", since)
        if m:
            y = int(m.group(1))
            end = (pd.Timestamp(y, int(m.group(2)), int(m.group(3))) if m.group(3) else
                   pd.Timestamp(y, int(m.group(2)), 1) + pd.offsets.MonthEnd(0) if m.group(2) else pd.Timestamp(y, 12, 31))
            n["since_end"] = end.normalize()
        note_text = str(r[ni]).strip() if ni else ""
        if n["pays"] or n["cycle"] or n["status"] or note_text or n["since_end"] is not None:
            out[name] = n
    return out


def load(path: str, groups: tuple[dict[str, str], dict[str, str]] = ({}, {})) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig", skip_blank_lines=True)
    norm = {re.sub(r"[^a-z0-9]", "", c.lower()): c for c in raw.columns}
    cols = {}
    for key, names in ALIASES.items():
        cols[key] = next(norm[n] for n in names if n in norm)
    for key, names in OPTIONAL.items():
        hit = next((norm[n] for n in names if n in norm), None)
        if hit:
            cols[key] = hit
    df = pd.DataFrame({k: raw[v] for k, v in cols.items()})
    if "cardholder" not in df:
        df["cardholder"] = ""
    df["order"] = np.arange(len(df))

    # Day-first slash dates or year-first ISO dates; each format tried explicitly.
    stamp = df["date"].str.strip()
    ts = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
    for fmt in ["%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"]:
        ts = ts.fillna(pd.to_datetime(stamp, format=fmt, errors="coerce"))
    df["ts"] = ts
    df["cents"] = pd.to_numeric(df["amount"].str.replace(",", "").str.strip(), errors="coerce")
    st = df["status"].str.strip()
    low = st.str.lower()
    df["st"] = np.select([st == "", low.str.startswith("failed"), low == "batched", low.isin(["voided", "void"])],
                         ["Failed", "Failed", "Batched", "Voided"], default="")
    df = df[df["ts"].notna() & df["cents"].notna() & (df["st"] != "")].copy()
    df["cents"] = df["cents"].astype(np.int64)
    df["cust"] = df["customer"].str.strip().str.replace(r"\s+", " ", regex=True).replace("", ONE_TIME)
    df["one_time"] = df["cust"] == ONE_TIME
    df["card"] = df["card"].str.strip().str.upper().replace("", "UNKNOWN")
    df["day"] = df["ts"].dt.normalize()
    df = df.sort_values(["ts", "order"]).reset_index(drop=True)
    return apply_groups(df, groups)


def apply_groups(df: pd.DataFrame, groups: tuple[dict[str, str], dict[str, str]]) -> pd.DataFrame:
    by_name, by_holder = groups
    if "label" not in df:
        df["label"] = df["cust"]   # the name as exported, before groups
    if by_name:  # several export names → one customer
        df.loc[~df.one_time, "cust"] = df.loc[~df.one_time, "cust"].map(lambda c: by_name.get(c, c))
    if by_holder:  # manual charges assigned to a customer by their cardholder
        holder = df["cardholder"].str.strip().str.replace(r"\s+", " ", regex=True)
        hit = df.one_time & holder.isin(list(by_holder))
        df.loc[hit, "cust"] = holder[hit].map(by_holder)
        df.loc[hit, "one_time"] = False
    return df


def load_many(paths: list[str], groups: tuple[dict[str, str], dict[str, str]] = ({}, {})) -> pd.DataFrame:
    """Several exports (the processor caps each at 90 days) → one table. A row that
    appears in two files is counted once: rows match on day, time to the minute,
    customer as exported, amount, card and status. Within one file identical rows
    are all kept; across files the larger count wins. Files are taken earliest first."""
    if len(paths) == 1:
        return load(paths[0], groups)
    frames = sorted((load(p, ({}, {})) for p in paths), key=lambda d: d.ts.min() if len(d) else pd.Timestamp.max)
    seen: dict[str, int] = {}
    kept = []
    for fi, d in enumerate(frames):
        key = d.day.astype(str) + "|" + d.ts.dt.floor("min").astype(str) + "|" + d.cust + "|" + d.cents.astype(str) + "|" + d.card + "|" + d.st
        occurrence = key.groupby(key).cumcount()
        earlier = key.map(lambda k: seen.get(k, 0))
        for k, n in key.value_counts().items():
            seen[k] = max(seen.get(k, 0), int(n))
        kept.append(d[occurrence >= earlier].assign(file=fi))
    df = pd.concat(kept).sort_values(["ts", "file", "order"]).reset_index(drop=True)
    return apply_groups(df, groups)


def auto_unit(span_days: int) -> str:
    return "day" if span_days <= 60 else "week" if span_days <= 183 else "month" if span_days < 1826 else "quarter"


PERIOD = {"day": "D", "week": "W-SUN", "month": "M", "quarter": "Q"}


def money_text(cents: int) -> str:
    dollars = (Decimal(int(cents)) / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return f"${int(dollars):,}"


def main(csv_path: str, json_path: str, groups_path: str | None = None, notes_path: str | None = None) -> int:
    dash = json.load(open(json_path, encoding="utf-8"))["summary"]
    df = load_many(csv_path.split(","), load_groups(groups_path))
    notes = load_notes(notes_path)
    lo, hi = df["day"].min(), df["day"].max()
    span = (hi - lo).days + 1

    # Unknown days: 7+ days in a row with no transaction at all, from anyone.
    # They are missing data (an export not loaded), not silence.
    tdays = sorted(df["day"].unique())
    stretches = [(pd.Timestamp(a) + pd.Timedelta(days=1), pd.Timestamp(b) - pd.Timedelta(days=1))
                 for a, b in zip(tdays, tdays[1:]) if (pd.Timestamp(b) - pd.Timestamp(a)).days - 1 >= 7]

    def missing_in(x, y):
        return sum(max(0, (min(y, t) - max(x, f)).days + 1) for f, t in stretches)

    one = pd.Timedelta(days=1)
    observed = lambda a, b: (b - a).days - missing_in(a + one, b - one)
    mostly_missing = lambda x, y: 2 * missing_in(x, y) >= (y - x).days + 1

    # A note written under an export name applies to the customer it is grouped into.
    labels_of = df[~df.one_time].groupby("cust").label.unique()
    for cust_name, labels in labels_of.items():
        if NORM(cust_name) not in notes:
            hit = next((NORM(l) for l in labels if NORM(l) in notes), None)
            if hit:
                notes[NORM(cust_name)] = notes[hit]
    unit = dash["unit"]
    checks: list[tuple[str, object, object, bool]] = []

    def eq(name, mine, theirs, tol=None):
        if tol is None:
            ok = mine == theirs
        else:
            ok = theirs is not None and mine is not None and abs(float(mine) - float(theirs)) <= tol
        checks.append((name, mine, theirs, ok))

    sales = df[(df.st == "Batched") & (df.cents > 0)]
    refunds = df[(df.st == "Batched") & (df.cents < 0)]
    attempts = df[df.cents >= 0]
    gross = int(sales.cents.sum())

    eq("auto bucket", auto_unit(span), dash["autoUnit"])
    eq("rows parsed", len(df), dash["quality"]["parsed"])
    eq("gross revenue (cents)", gross, dash["gross"])
    eq("refunds (cents)", int(-refunds.cents.sum()), dash["refunds"])
    eq("net revenue (cents)", gross + int(refunds.cents.sum()), dash["net"])
    eq("transactions", len(sales), dash["count"])
    eq("charge attempts", len(attempts), dash["attempts"])
    succ = int((attempts.st == "Batched").sum())
    eq("success rate", succ / len(attempts), dash["successRate"], 1e-12)
    eq("success rate excl. voids", succ / int((attempts.st != "Voided").sum()), dash["successRateExVoids"], 1e-12)
    eq("active named customers", sales[~sales.one_time].cust.nunique(), dash["activeCustomers"])
    eq("voided (cents)", int(df[df.st == "Voided"].cents.sum()), dash["voidCents"])

    by_cust = sales[~sales.one_time].groupby("cust").cents.sum().sort_values(ascending=False)
    eq("top-5 concentration", by_cust.head(5).sum() / gross, dash["top5"], 1e-12)
    eq("top-10 concentration", by_cust.head(10).sum() / gross, dash["top10"], 1e-12)

    # Retry chains: in each (customer, amount, card) group, walk in time order;
    # pending failures followed by a success form one chain.
    fb = df[(df.cents > 0) & df.st.isin(["Failed", "Batched"])]
    chains, failed, recovered, days = 0, 0, 0, []
    for _, g in fb.groupby(["cust", "cents", "card"], sort=False):
        pending = []
        for st, day in zip(g.st, g.day):
            if st == "Failed":
                failed += 1
                pending.append(day)
            elif pending:
                chains += 1
                recovered += len(pending)
                days.append((day - pending[0]).days)
                pending = []
    eq("failed charges", failed, dash["failedTotal"])
    eq("retry chains", chains, dash["chains"])
    eq("recovered failures", recovered, dash["recovered"])
    eq("retry recovery rate", recovered / failed if failed else None, dash["recoveryRate"], 1e-12)
    eq("avg days to recover", float(np.mean(days)) if days else None, dash["avgDaysToRecover"], 1e-9)

    # Buckets: pandas periods (weeks end Sunday = Monday start, like the dashboard).
    freq = PERIOD[unit]
    periods = pd.period_range(lo.to_period(freq), hi.to_period(freq), freq=freq)
    partial = [(p.start_time.normalize() < lo) or (p.end_time.normalize() > hi) for p in periods]
    if unit == "day":
        partial = [False] * len(periods)
    sp = sales.day.dt.to_period(freq)
    rev = sales.groupby(sp).cents.sum().reindex(periods, fill_value=0)
    eq("bucket starts", [p.start_time.strftime("%Y-%m-%d") for p in periods], [b["start"] for b in dash["buckets"]])
    eq("partial buckets", partial, [b["partial"] for b in dash["buckets"]])
    no_data = [mostly_missing(max(p.start_time.normalize(), lo), min(p.end_time.normalize(), hi)) for p in periods]
    eq("no-data buckets", no_data, [b.get("noData", False) for b in dash["buckets"]])
    eq("revenue per bucket (cents)", [int(x) for x in rev.values], dash["grossByBucket"])

    # Timeframe profile (span in days, first to last transaction inclusive):
    # ≤45 short, ≤183 medium, ≤395 long, otherwise multi-year.
    tf = "short" if span <= 45 else "medium" if span <= 183 else "long" if span <= 395 else "multi"
    eq("timeframe", tf, dash["timeframe"])
    named = sales[~sales.one_time]

    # Tracking periods: 7-day blocks counted back from the last day (short,
    # medium) or complete calendar months (long, multi-year).
    if tf in ("short", "medium"):
        k = span // 7
        bounds = [(hi - pd.Timedelta(days=7 * j + 6), hi - pd.Timedelta(days=7 * j)) for j in range(k - 1, -1, -1)]
    else:
        months = pd.period_range(lo.to_period("M"), hi.to_period("M"), freq="M")
        bounds = [(m.start_time.normalize(), m.end_time.normalize()) for m in months
                  if m.start_time.normalize() >= lo and m.end_time.normalize() <= hi]
    eq("tracking periods", len(bounds), dash["trackingPeriods"])
    starts = pd.DatetimeIndex([b[0] for b in bounds])

    def period_of(day):
        if not bounds or day < bounds[0][0]:
            return -1
        i = int(starts.searchsorted(day, side="right")) - 1
        return i if day <= bounds[i][1] else len(bounds)

    pidx = named.day.map(period_of)
    inside = named[(pidx >= 0) & (pidx < len(bounds))]
    series = {c: np.zeros(len(bounds)) for c in named.cust.unique()}
    for c, i, v in zip(inside.cust, pidx[inside.index], inside.cents):
        series[c][i] += v

    # Card payments: 60+ days between two card payments is a spell off card;
    # 60+ days from the last one to the end of the range means the customer
    # stopped paying by card as of that day (presumed EFT or stopped trading).
    # Customer notes override: stopped ordering / closed → lost; EFT / cheque →
    # stopped now; monthly → stopped after 3 cycles; seasonal → never stopped.
    STOP = 60
    MONTH = 365.25 / 12
    pay_days = {c: sorted(set(d)) for c, d in named.groupby("cust").day}
    breaks = {c: [(a, b) for a, b in zip(d, d[1:]) if observed(a, b) >= STOP] for c, d in pay_days.items()}
    silent = {c: (hi - d[-1]).days - missing_in(d[-1] + one, hi) for c, d in pay_days.items()}   # known days since the last payment
    note = lambda c: notes.get(NORM(c), {})
    lost = {c for c in pay_days if note(c).get("status")}
    seasonal = {c for c in pay_days if note(c).get("cycle") == "seasonal"}
    no_rhythm = {c for c in pay_days if note(c).get("cycle") in ("sporadic", "on request") or note(c).get("pays") == "mixed"}
    declared = lambda c: CYCLE_DAYS.get(note(c).get("cycle")) or note(c).get("days")
    long_cycle = {c for c in pay_days if declared(c) and declared(c) >= 14}
    stop_days = lambda c: max(STOP, round(3 * declared(c))) if declared(c) else STOP
    stopped = {c for c, d in pay_days.items() if c not in lost and c not in seasonal
               and (note(c).get("pays") in ("EFT", "cheque") or silent[c] >= stop_days(c))}
    iso = lambda d: d.strftime("%Y-%m-%d")
    eq("notes applied", sum(1 for c in pay_days if NORM(c) in notes), dash["notes"]["applied"])
    eq("lost customers (name, status)", sorted((c, note(c)["status"]) for c in lost), sorted((x["name"], x["status"]) for x in dash["lost"]))
    eq("lost customers paid by card after their Since date",
       sorted(c for c in lost if note(c)["since_end"] is not None and pay_days[c][-1] > note(c)["since_end"]),
       sorted(x["name"] for x in dash["lost"] if x.get("paidAfter")))
    eq("seasonal customers off season", sorted(c for c in seasonal if silent[c] >= STOP), sorted(dash["seasonalOff"]))
    eq("stopped paying by card (name, as of, from notes)", sorted((c, iso(pay_days[c][-1]), note(c).get("pays") in ("EFT", "cheque")) for c in stopped),
       sorted((x["name"], x["lastDay"], x["declared"]) for x in dash["stopped"]))
    eq("back on card after a break (name, off, back)",
       sorted((c, iso(b[-1][0]), iso(b[-1][1])) for c, b in breaks.items() if b and c not in stopped and c not in lost),
       sorted((x["name"], x["offFrom"], x["backOn"]) for x in dash["backOnCard"]))

    def off_card(c, i):
        # A tracking period wholly inside a break is time spent paying another way.
        s0, s1 = bounds[i]
        return any(a < s0 and s1 < b for a, b in breaks[c])

    # Usual gap: on-card gaps only (breaks left out), current card payers with a
    # rhythm only; a declared weekly / monthly cycle replaces the measured gap.
    cad = {}
    for c, d in pay_days.items():
        if c in stopped or c in lost or c in seasonal or c in no_rhythm:
            continue
        gaps = [observed(a, b) for a, b in zip(d, d[1:]) if observed(a, b) < STOP]
        if declared(c):
            cad[c] = float(declared(c))
        elif len(gaps) >= 2:
            cad[c] = float(np.mean(gaps))
    eq("payment cadence customers", sorted(cad), sorted(dash["cadence"]))
    eq("max |usual gap difference| (days)", max((abs(v - dash["cadence"].get(c, np.inf)) for c, v in cad.items()), default=0.0), 0.0, 1e-9)
    eq("overdue against their own rhythm", sorted(c for c, g in cad.items() if silent[c] >= 7 and silent[c] / g >= 2), sorted(dash["late"]))
    no_data_p = [mostly_missing(a, b) for a, b in bounds]
    eq("tracking periods with no data", sum(no_data_p), len(dash.get("noDataPeriods", [])))

    # Trend slopes: last 12 months for multi-year exports, otherwise all
    # periods, from the customer's first period, skipping periods spent wholly
    # off card. Stopped, lost, seasonal and no-rhythm customers have no trend,
    # and monthly payers are only compared when periods are months. Short
    # exports need 3 periods with 2 active, the rest 4 with 3 active.
    untracked = stopped | lost | seasonal | no_rhythm | (long_cycle if tf in ("short", "medium") else set())
    need, need_active = (3, 2) if tf == "short" else (4, 3)
    t0 = max(0, len(bounds) - 12) if tf == "multi" else 0
    first_day = named.groupby("cust").day.min()
    mine = {}
    if len(bounds) - t0 >= need:
        for cust, ys_all in series.items():
            f = period_of(first_day[cust])
            if f >= len(bounds) or cust in untracked:
                continue
            xs = [i for i in range(max(t0, f, 0), len(bounds)) if not off_card(cust, i) and not no_data_p[i]]
            ys = ys_all[xs]
            if len(ys) < need or (ys > 0).sum() < need_active:
                continue
            mine[cust] = np.polyfit(np.array(xs, dtype=float), ys, 1)[0] / 100
    theirs = dash["slopes"]
    eq("customers with a trend slope", sorted(mine), sorted(theirs))
    worst = max((abs(mine[k] - theirs.get(k, np.inf)) for k in mine), default=0.0)
    eq("max |slope difference| ($/period)", round(worst, 9), 0.0, 1e-6)
    if mine:
        sample = max(mine, key=lambda k: by_cust.get(k, 0))
        eq(f"slope for {sample!r}", mine[sample], theirs.get(sample), 1e-6)

    # Needs attention: average per on-card period, recent vs baseline. Recent =
    # last 2 weeks (short), 4 weeks (medium) or 3 months; baseline = the same
    # number just before, or the same months a year earlier (multi-year).
    P = len(bounds)
    n_recent, n_base = (2, 2) if tf == "short" else (4, 4) if tf == "medium" else (3, 3)
    r_idx = b_idx = None
    if tf == "multi" and P >= n_recent + 12:
        r_idx = list(range(P - n_recent, P))
        b_idx = [i - 12 for i in r_idx]
    elif P >= 2:
        R = n_recent if P >= n_recent + n_base else max(1, P // 2)
        Bn = min(n_base, P - R)
        r_idx, b_idx = list(range(P - R, P)), list(range(P - R - Bn, P - R))
    attn = {}
    if r_idx:
        for cust, ys in series.items():
            if cust in untracked:
                continue
            b_on = [i for i in b_idx if not off_card(cust, i) and not no_data_p[i]]
            r_on = [i for i in r_idx if not off_card(cust, i) and not no_data_p[i]]
            if not b_on or not r_on:
                continue
            base, recent = ys[b_on].mean(), ys[r_on].mean()
            if base > 0 and (recent - base) / base <= -dash["threshold"]:
                attn[cust] = (base / 100, recent / 100)
    eq("needs attention", sorted(attn), sorted(dash["attention"]))
    got = {x["name"]: (x["baseAvg"], x["recentAvg"]) for x in dash["attentionDetail"]}
    eq("max |needs-attention average difference| ($)",
       max((abs(v[k] - got.get(c, (np.inf, np.inf))[k]) for c, v in attn.items() for k in (0, 1)), default=0.0), 0.0, 1e-9)

    # KPI comparison windows: last 7 days vs previous 7 (short); last 28/14/7
    # vs the same before (medium, the longest that fits twice); last complete
    # month vs previous (long) or vs the same month a year earlier (multi).
    def gross_between(a, b):
        return int(sales[(sales.day >= a) & (sales.day <= b)].cents.sum())
    cmp = None
    if tf in ("short", "medium"):
        w = next((d for d in ([7] if tf == "short" else [28, 14, 7]) if 2 * d <= span), None)
        if w:
            a = (hi - pd.Timedelta(days=w - 1), hi)
            b = (hi - pd.Timedelta(days=2 * w - 1), hi - pd.Timedelta(days=w))
            cmp = (a, b)
    else:
        whole = [m for m in pd.period_range(lo.to_period("M"), hi.to_period("M"), freq="M")
                 if m.start_time.normalize() >= lo and m.end_time.normalize() <= hi]
        if len(whole) >= 2:
            last = whole[-1]
            ago = last - 12
            other = ago if tf == "multi" and ago in whole else whole[-2]
            cmp = ((last.start_time.normalize(), last.end_time.normalize()), (other.start_time.normalize(), other.end_time.normalize()))
    if cmp and any(mostly_missing(a, b) for a, b in cmp):
        cmp = None   # no comparison against a window that is mostly unknown
    if cmp:
        (a0, a1), (b0, b1) = cmp
        iso = lambda d: d.strftime("%Y-%m-%d")
        eq("KPI comparison windows", [[iso(a0), iso(a1)], [iso(b0), iso(b1)]], [dash["compare"]["a"], dash["compare"]["b"]])
        eq("KPI comparison gross (cents)", [gross_between(a0, a1), gross_between(b0, b1)], [dash["compare"]["cur"], dash["compare"]["prev"]])
    else:
        eq("KPI comparison", None, dash["compare"])

    # Year over year (multi-year only): totals of complete calendar years.
    if tf == "multi":
        whole = {m: int(sales[sales.day.dt.to_period("M") == m].cents.sum())
                 for m in pd.period_range(lo.to_period("M"), hi.to_period("M"), freq="M")
                 if m.start_time.normalize() >= lo and m.end_time.normalize() <= hi
                 and not mostly_missing(m.start_time.normalize(), m.end_time.normalize())}
        years = sorted({m.year for m in pd.period_range(lo.to_period("M"), hi.to_period("M"), freq="M")})
        mine_y = {y: (sum(v for m, v in whole.items() if m.year == y) if sum(1 for m in whole if m.year == y) == 12 else None) for y in years}
        eq("year-over-year totals (cents)", mine_y, {y["year"]: y["total"] for y in dash["yoy"]})
    else:
        eq("year-over-year view", None, dash["yoy"])

    # RFM: quartiles of rank(method='first'), customers ordered by name.
    if by_cust.size >= 4:
        named = sales[~sales.one_time]
        g = named.groupby("cust").agg(last=("day", "max"), f=("cents", "size"), m=("cents", "sum")).sort_index()
        r = (hi - g["last"]).dt.days
        rs = pd.qcut(r.rank(method="first"), 4, labels=[4, 3, 2, 1]).astype(int)
        fs = pd.qcut(g.f.rank(method="first"), 4, labels=[1, 2, 3, 4]).astype(int)
        ms = pd.qcut(g.m.rank(method="first"), 4, labels=[1, 2, 3, 4]).astype(int)
        score = rs + fs + ms
        seg = np.select([score >= 10, score >= 7, score >= 5], ["High-Value Regular", "Loyal", "At Risk"], default="Dormant")
        counts = pd.Series(seg).value_counts().to_dict()
        eq("RFM segment sizes", {k: counts.get(k, 0) for k in ["High-Value Regular", "Loyal", "At Risk", "Dormant"]}, dash["rfmSegments"])

    # Customer explorer: only the ticked customers' rows (when the browser test ticked some).
    ex = dash.get("explorerCheck")
    if ex and ex.get("selected"):
        picked = set(ex["selected"])
        mine_sales = sales[sales.cust.isin(picked)]
        eq("explorer: ticked customers are the biggest by revenue", sorted(picked), sorted(by_cust.index[:len(picked)]))
        eq("explorer: gross of ticked customers (cents)", int(mine_sales.cents.sum()), ex["gross"])
        eq("explorer: successful charges of ticked customers", len(mine_sales), ex["count"])

    # What the tiles actually say on screen.
    kpi = {k["key"]: k["value"] for k in dash["kpiText"]}
    eq("tile text: gross revenue", money_text(gross), kpi["gross"])
    eq("tile text: net revenue", money_text(gross + int(refunds.cents.sum())), kpi["net"])
    eq("tile text: transactions", f"{len(sales):,}", kpi["count"])
    rate = Decimal(succ * 100) / Decimal(len(attempts))
    eq("tile text: success rate", f"{rate.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP)}%", kpi["successRate"])

    width = max(len(c[0]) for c in checks)
    bad = 0
    for name, a, b, ok in checks:
        show = lambda v: (json.dumps(v) if not isinstance(v, float) else f"{v:.10g}")[:70]
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  python={show(a)}" + ("" if ok else f"  dashboard={show(b)}"))
        bad += not ok
    shown = " + ".join(p.split("/")[-1] for p in csv_path.split(","))
    print(f"\n{len(checks) - bad}/{len(checks)} checks passed for {shown} ({unit} buckets)")
    return 1 if bad else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    groups = notes = None
    if "--groups" in args:
        i = args.index("--groups")
        groups = args[i + 1]
        del args[i:i + 2]
    if "--notes" in args:
        i = args.index("--notes")
        notes = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(args[0], args[1], groups, notes))
