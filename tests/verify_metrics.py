#!/usr/bin/env python3
"""Independently recompute the dashboard's headline numbers with pandas and
assert they match what the browser rendered.

    node tests/e2e.mjs data.csv --out tests/output --name run [--groups groups.csv]
    python3 tests/verify_metrics.py data.csv tests/output/run.json [--groups groups.csv]

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


def load_groups(path: str | None) -> dict[str, str]:
    """Customer-groups file: "Customer Number" → "Group As" (read independently)."""
    if not path:
        return {}
    g = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    cols = {re.sub(r"[^a-z0-9]+", " ", c.lower()).strip(): c for c in g.columns}
    src, dst = cols["customer number"], cols["group as"]
    tidy = lambda s: s.str.strip().str.replace(r"\s+", " ", regex=True)
    return {k: v for k, v in zip(tidy(g[src]), tidy(g[dst])) if k and v}


def load(path: str, groups: dict[str, str] | None = None) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig", skip_blank_lines=True)
    norm = {re.sub(r"[^a-z0-9]", "", c.lower()): c for c in raw.columns}
    cols = {}
    for key, names in ALIASES.items():
        cols[key] = next(norm[n] for n in names if n in norm)
    df = pd.DataFrame({k: raw[v] for k, v in cols.items()})
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
    if groups:  # several export names → one customer (never the one-time aggregate)
        df.loc[~df.one_time, "cust"] = df.loc[~df.one_time, "cust"].map(lambda c: groups.get(c, c))
    df["card"] = df["card"].str.strip().str.upper().replace("", "UNKNOWN")
    df["day"] = df["ts"].dt.normalize()
    return df.sort_values(["ts", "order"]).reset_index(drop=True)


def auto_unit(span_days: int) -> str:
    return "day" if span_days <= 60 else "week" if span_days <= 183 else "month" if span_days < 1826 else "quarter"


PERIOD = {"day": "D", "week": "W-SUN", "month": "M", "quarter": "Q"}


def money_text(cents: int) -> str:
    dollars = (Decimal(int(cents)) / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return f"${int(dollars):,}"


def main(csv_path: str, json_path: str, groups_path: str | None = None) -> int:
    dash = json.load(open(json_path, encoding="utf-8"))["summary"]
    df = load(csv_path, load_groups(groups_path))
    lo, hi = df["day"].min(), df["day"].max()
    span = (hi - lo).days + 1
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
    eq("revenue per bucket (cents)", [int(x) for x in rev.values], dash["grossByBucket"])

    # Trend slopes for every eligible named customer (complete buckets only,
    # from the customer's first bucket; >= 4 buckets with >= 3 active).
    complete = [i for i, p in enumerate(partial) if not p]
    mine = {}
    if len(complete) >= 4:
        c0, c1 = complete[0], complete[-1]
        named = sales[~sales.one_time]
        mat = named.groupby([named.cust, named.day.dt.to_period(freq)]).cents.sum().unstack(fill_value=0).reindex(columns=periods, fill_value=0)
        for cust, row in mat.iterrows():
            first = int(np.argmax(row.values > 0))
            start = max(c0, first)
            ys = row.values[start:c1 + 1].astype(float)
            if len(ys) < 4 or (ys > 0).sum() < 3:
                continue
            mine[cust] = np.polyfit(np.arange(len(ys)), ys, 1)[0] / 100
    theirs = dash["slopes"]
    eq("customers with a trend slope", sorted(mine), sorted(theirs))
    worst = max((abs(mine[k] - theirs.get(k, np.inf)) for k in mine), default=0.0)
    eq("max |slope difference| ($/bucket)", round(worst, 9), 0.0, 1e-6)
    if mine:
        sample = max(mine, key=lambda k: by_cust.get(k, 0))
        eq(f"slope for {sample!r}", mine[sample], theirs.get(sample), 1e-6)

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
    print(f"\n{len(checks) - bad}/{len(checks)} checks passed for {csv_path.split('/')[-1]} ({unit} buckets)")
    return 1 if bad else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    groups = None
    if "--groups" in args:
        i = args.index("--groups")
        groups = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(args[0], args[1], groups))
