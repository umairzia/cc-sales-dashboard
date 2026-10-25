#!/usr/bin/env python3
"""Generate synthetic card-processor exports with fake customer names.

    python3 scripts/generate_sample.py             # sample-data/sample_transactions.csv
    python3 scripts/generate_sample.py --fixtures  # + tests/fixtures/*.csv edge cases

Everything is deterministic (fixed seed) so the committed files are
reproducible. No real customer data is used anywhere: names are built from
generic word lists, card numbers are masked test-range numbers, and banks,
merchant IDs and references are placeholders.

The main sample (~2,500 rows, 12 months, ~120 customers) deliberately contains
what the dashboard must cope with: a long-tail revenue distribution, ~85/10/5
VISA/MC/AMEX, blank customer names, ~10% blank statuses, a few
"Failed - Result [...]" statuses, negative amounts (refunds), one zero-amount
row, same-day duplicates, genuine retry chains, $1 test voids, customers who
join late or churn, two big accounts in deliberate decline and a few growers.
It is written with a UTF-8 BOM and CRLF line endings, like a Windows export.
"""
from __future__ import annotations

import argparse
import csv
import io
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HEADER = [
    "Date & Time", "Cardholder's Name", "Customer Number", "Variable Ref", "Amount", "Currency", "Card Type",
    "PASRef", "Autosettle flag", "Transaction Source", "Comment 1", "Comment 2", "Issuing Bank", "Issuer Country",
    "Issuer Country Code", "Settle time", "Void Comment", "Foreign Currency Amount", "Foreign Currency", "CCP Rate",
    "Currency Processor", "Account", "Status", "Security Code Result", "AVS Result", "Acquirer Reference",
    "User Department", "3D Secure CAVV", "3D Secure ECI", "Card Number", "Transaction Originating IP",
    "Customer IP Address", "Merchant ID", "Transaction Type", "type",
]

# Column names of the newer (2026) export: same fields plus repeated blocks.
_REPEAT = ["type"] + [f"field{i:02d}" for i in range(1, 15)]
HEADER_2026 = (["Batch ID", "Date & Time", "Order ID", "Cardholder's Name", "Customer Number", "Product ID", "Variable Ref",
                "Amount", "Currency", "Card Type", "PASRef", "Authcode", "Autosettle flag", "TSS Score", "Transaction Source",
                "Comment 1", "Comment 2", "Issuing Bank", "Issuer Country", "Issuer Country Code", "Settle time", "Void Comment",
                "Foreign Currency Amount", "Foreign Currency", "CCP Rate", "Currency Processor", "Account", "Status",
                "Security Code Result", "AVS Result", "Acquirer Reference", "User Department", "3D Secure CAVV", "3D Secure ECI",
                "Card Number", "Transaction Originating IP", "Customer IP Address", "Merchant ID", "Transaction Type"]
               + _REPEAT * 5 + ["Order Reference", "Fraud Result", "CTP"])

WORDS_A = [
    "Maple", "Harbour", "Copper", "Golden", "Willow", "Juniper", "Saffron", "Birch", "Cedar", "Lantern",
    "Marigold", "Pepper", "Olive", "Basil", "Thyme", "Fennel", "Sumac", "Clover", "Bramble", "Orchard",
    "Ember", "Granite", "Tidewater", "Northwind", "Sparrow", "Kettle", "Fig", "Lemon", "Quarry", "Meadow",
    "Stonefruit", "Wildflower", "Bluefin", "Hearth", "Parsnip", "Radish", "Cobalt", "Ironwood", "Silverbirch", "Larch",
]
WORDS_B = [
    "Kitchen", "Bistro", "Café", "Grill", "Eatery", "Juice Bar", "Pizzeria", "Deli", "Tavern", "Noodle House",
    "Bakery", "Smokehouse", "Taqueria", "Brasserie", "Canteen", "Diner", "Supper Club", "Burger Co", "Ramen Bar", "Bowl Co",
]
PLACES = ["Downtown", "Uptown", "Lakeshore", "Midtown", "Riverside", "North", "East End", "Westside", "Harbourfront", "Old Town"]
PEOPLE = ["A. Rivera", "J. Okafor", "M. Chen", "S. Patel", "L. Novak", "D. Haddad", "R. Silva", "K. Tanaka", "P. Murphy", "T. Nguyen"]
FAIL_MSGS = ["Declined", "Declined", "Declined", "Authorization Declined", "Expiry Date incorrect"]
CARD_PREFIX = {"VISA": "411111", "MC": "555555", "AMEX": "378282"}


@dataclass
class Txn:
    when: datetime
    customer: str
    cents: int
    card: str
    status: str            # "Batched" | "" (blank = failed) | "Failed - Result ..." | "Voided"
    cardholder: str = ""
    ref: str = ""
    last4: str = "0000"
    void_note: str = ""
    txn_type: str = "auth"


@dataclass
class Customer:
    name: str
    ref: int
    card: str
    last4: str
    base: float            # typical order in dollars
    every: float           # days between orders
    start: date
    stop: date
    trend: float = 0.0     # relative change in order size across the window (-0.7 = decline to 30%)
    freq_trend: float = 0.0
    fail_p: float = 0.04
    guide: list = field(default_factory=list)   # fixed order-guide amounts (cents)


def unique_names(rng: random.Random, n: int) -> list[str]:
    seen, out = set(), []
    while len(out) < n:
        nm = f"{rng.choice(WORDS_A)} {rng.choice(WORDS_B)}"
        if rng.random() < 0.25:
            nm += " " + rng.choice(PLACES)
        if nm not in seen:
            seen.add(nm)
            out.append(nm)
    return out


def pick_card(rng: random.Random) -> str:
    r = rng.random()
    return "VISA" if r < 0.85 else "MC" if r < 0.95 else "AMEX"


def assign_cards(rng: random.Random, custs: list[Customer], span: int) -> None:
    """Give each customer one card on file so that, weighted by how often they
    are charged, the row mix lands near 85% VISA / 10% MC / 5% AMEX."""
    target = {"VISA": 0.85, "MC": 0.10, "AMEX": 0.05}
    load = dict.fromkeys(target, 0.0)
    order = custs[:]
    rng.shuffle(order)
    for c in order:
        rows = max(1.0, (c.stop - c.start).days / c.every)
        total = sum(load.values()) + rows
        c.card = min(target, key=lambda k: (load[k] + rows) / total - target[k])
        load[c.card] += rows


def at(rng: random.Random, d: date) -> datetime:
    return datetime(d.year, d.month, d.day, rng.randint(14, 22), rng.randint(0, 59))


def build_customers(rng: random.Random, n: int, start: date, end: date) -> list[Customer]:
    span = (end - start).days
    custs = []
    for i, nm in enumerate(unique_names(rng, n)):
        w = min(rng.paretovariate(1.25), 30)
        kind = rng.random()
        every = 3.5 if kind < 0.015 else 7 if kind < 0.19 else 14 if kind < 0.50 else 30 if kind < 0.82 else rng.uniform(45, 90)
        late = rng.random() < 0.22
        s = start + timedelta(days=rng.randint(20, int(span * 0.8))) if late else start + timedelta(days=rng.randint(0, 6))
        stop = end
        if rng.random() < 0.09:
            stop = start + timedelta(days=rng.randint(int(span * 0.45), int(span * 0.85)))
        card = pick_card(rng)
        c = Customer(nm, 100 + i * 7, card, f"{rng.randint(0, 9999):04d}", base=180 * w * rng.uniform(0.8, 1.2),
                     every=every, start=s, stop=stop, fail_p=0.085 if rng.random() < 0.85 else rng.uniform(0.2, 0.45))
        if rng.random() < 0.22:
            c.guide = [int(round(c.base * f * 100)) for f in (rng.uniform(0.85, 1.0), rng.uniform(1.0, 1.15), rng.uniform(0.9, 1.1))]
        custs.append(c)
    assign_cards(rng, custs, span)

    # Deliberate shapes: two big established weekly accounts in steady decline,
    # three mild decliners and three growers (all from the start of the window).
    big = sorted(custs, key=lambda c: -c.base)
    for c, tr, ft in [(big[3], -0.75, -0.5), (big[6], -0.65, -0.4)]:
        c.trend, c.freq_trend, c.every, c.start, c.stop, c.guide = tr, ft, 7, start + timedelta(days=1), end, []
    for c in rng.sample(big[10:60], 3):
        c.trend = -0.35
    for c in rng.sample(big[10:60], 3):
        c.trend, c.start = 0.8, start + timedelta(days=2)
    return custs


def calibrate(custs: list[Customer], end: date, target_rows: int) -> None:
    """Stretch every customer's ordering interval by one common factor so the
    expected row count lands near the target (keeps relative shapes intact)."""
    expected = sum(max(0, (min(c.stop, end) - c.start).days) / c.every * (1 + 1.4 * c.fail_p) for c in custs)
    k = max(1.0, expected / target_rows)
    for c in custs:
        c.every *= k


def simulate(rng: random.Random, custs: list[Customer], start: date, end: date) -> list[Txn]:
    span = (end - start).days
    out: list[Txn] = []
    for c in custs:
        d = c.start
        first = True
        while d <= min(c.stop, end):
            prog = (d - start).days / span
            if d.weekday() == 6:            # no Sunday deliveries
                d += timedelta(days=1)
                continue
            size = c.base * (1 + c.trend * prog)
            if c.guide and rng.random() < 0.6:
                cents = int(rng.choice(c.guide) * (1 + c.trend * prog))
            else:
                cents = int(round(size * rng.uniform(0.75, 1.3) * 100))
            cents = max(cents, 2500)
            if first and rng.random() < 0.25:   # $1 card-on-file test, voided by an admin
                out.append(Txn(at(rng, d), c.name, 100, c.card, "Voided", c.name, str(c.ref), c.last4, rng.choice(["Test", "test", "TEST"])))
            first = False
            when = at(rng, d)
            if rng.random() < c.fail_p:
                out.append(Txn(when, c.name, cents, c.card, failed_status(rng), c.name, str(c.ref), c.last4))
                # Retry the same amount on the same card a few days later (sometimes twice).
                retry_d = d
                for attempt in range(3):
                    if rng.random() > (0.55 if attempt == 0 else 0.5):
                        break
                    retry_d = retry_d + timedelta(days=rng.choice([1, 1, 2, 3, 4, 7]))
                    if retry_d > end:
                        break
                    ok = rng.random() > 0.3
                    out.append(Txn(at(rng, retry_d), c.name, cents, c.card, "Batched" if ok else failed_status(rng), c.name, str(c.ref), c.last4))
                    if ok:
                        break
            else:
                out.append(Txn(when, c.name, cents, c.card, "Batched", c.name, str(c.ref), c.last4))
            gap = c.every * (1 - c.freq_trend * prog) * rng.uniform(0.85, 1.15)
            d += timedelta(days=max(1, round(gap)))
    return out


def failed_status(rng: random.Random) -> str:
    # The brief: blank status = failed. Real exports also write the reason.
    return "" if rng.random() < 0.9 else f"Failed - Result [101] Message [{rng.choice(FAIL_MSGS)}]"


def add_quirks(rng: random.Random, txns: list[Txn], start: date, end: date) -> None:
    span = (end - start).days
    batched = [t for t in txns if t.status == "Batched"]
    # One-time manual charges: blank customer name.
    for i in range(6):
        d = start + timedelta(days=rng.randint(5, span - 5))
        st = "Batched" if i != 3 else ""
        txns.append(Txn(at(rng, d), "", rng.randint(150_00, 2_500_00), pick_card(rng), st, rng.choice(PEOPLE), "", f"{rng.randint(0, 9999):04d}"))
    # Refunds / credits: negative, Batched.
    for t in rng.sample(batched, 4):
        refund = -int(t.cents * rng.choice([1, 0.5, 0.25]))
        txns.append(Txn(t.when + timedelta(days=rng.randint(2, 9)), t.customer, refund, t.card, "Batched", t.cardholder, t.ref, t.last4, txn_type="refund"))
    # A zero-amount row (should never happen; the dashboard must flag it).
    t = rng.choice(batched)
    txns.append(Txn(t.when + timedelta(hours=1), t.customer, 0, t.card, "Batched", t.cardholder, t.ref, t.last4))
    # Two same-day exact duplicates (both Batched) for the data-quality panel.
    for t in rng.sample(batched, 2):
        txns.append(Txn(t.when + timedelta(minutes=rng.randint(3, 40)), t.customer, t.cents, t.card, "Batched", t.cardholder, t.ref, t.last4))
    # A few real voids with admin comments.
    for note in ["Customer paying by e-transfer", "Duplicate keyed in error", "Order cancelled"]:
        t = rng.choice(batched)
        txns.append(Txn(t.when + timedelta(minutes=5), t.customer, t.cents, t.card, "Voided", t.cardholder, t.ref, t.last4, note))
    # A cardholder name with a comma, to exercise quoted fields.
    rng.choice(batched).cardholder = "Rivera, Ana"


def row(rng: random.Random, t: Txn) -> list[str]:
    r = dict.fromkeys(HEADER, "")
    r["Date & Time"] = t.when.strftime("%d/%m/%Y %H:%M")
    r["Cardholder's Name"] = t.cardholder
    r["Customer Number"] = t.customer
    r["Variable Ref"] = t.ref or ""
    r["Amount"] = str(t.cents)
    r["Currency"] = "CAD"
    r["Card Type"] = t.card
    r["PASRef"] = str(rng.randint(10**15, 10**16 - 1))
    r["Autosettle flag"] = "1"
    r["Transaction Source"] = "realcontrol auto"
    r["Comment 2"] = "SampleCo"
    r["Issuing Bank"] = "SAMPLE BANK OF CANADA"
    r["Issuer Country"] = "CANADA"
    r["Issuer Country Code"] = "CA"
    r["Void Comment"] = t.void_note
    r["Account"] = "moto"
    r["Status"] = t.status
    r["Card Number"] = CARD_PREFIX[t.card] + "XXX" + t.last4
    r["Merchant ID"] = "0000000000"
    r["Transaction Type"] = t.txn_type
    return [r[h] for h in HEADER]


def write_csv(path: Path, header: list[str], rows: list[list[str]], bom: bool = True, crlf: bool = True) -> None:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n" if crlf else "\n")
    w.writerow(header)
    w.writerows(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(("﻿" if bom else "") + buf.getvalue(), encoding="utf-8", newline="")


def export_rows(rng: random.Random, txns: list[Txn]) -> list[list[str]]:
    txns.sort(key=lambda t: t.when, reverse=True)   # exports list newest first
    return [row(rng, t) for t in txns]


def main_sample(out: Path) -> None:
    rng = random.Random(20250101)
    start, end = date(2024, 11, 4), date(2025, 10, 29)
    custs = build_customers(rng, 124, start, end)
    calibrate(custs, end, target_rows=2620)
    txns = simulate(rng, custs, start, end)
    add_quirks(rng, txns, start, end)
    write_csv(out, HEADER, export_rows(rng, txns))
    blank = sum(1 for t in txns if t.status == "")
    cards = {k: sum(1 for t in txns if t.card == k) for k in CARD_PREFIX}
    decliners = [c.name for c in custs if c.trend <= -0.6]
    print(f"wrote {out.relative_to(ROOT)}: {len(txns)} rows, {len({t.customer for t in txns if t.customer})} customers, "
          f"{blank} blank statuses ({blank / len(txns):.1%}), cards {cards}, deliberate decliners: {decliners}")


def fixtures(dirpath: Path) -> None:
    rng = random.Random(7)
    # 90-day export → weekly buckets.
    start, end = date(2025, 6, 2), date(2025, 8, 30)
    custs = build_customers(rng, 30, start, end)
    txns = simulate(rng, custs, start, end)
    write_csv(dirpath / "span_90_days.csv", HEADER, export_rows(rng, txns))

    # 5-year export → quarterly. Only the six used columns, shuffled order,
    # odd casing/spacing and an unknown extra column; LF endings, no BOM.
    start, end = date(2021, 1, 1), date(2025, 12, 31)
    custs = build_customers(rng, 25, start, end)
    for c in custs:
        c.every = max(c.every, 14)
    txns = simulate(rng, custs, start, end)
    txns.append(Txn(datetime(2021, 1, 1, 15, 0), custs[0].name, 50000, custs[0].card, "Batched"))
    txns.append(Txn(datetime(2025, 12, 31, 16, 0), custs[1].name, 50000, custs[1].card, "Batched"))
    hdr = ["STATUS", " amount ", "card type", "date & time", "Customer Number", "currency", "Notes"]
    rows = [[t.status, str(t.cents), t.card, t.when.strftime("%d/%m/%Y %H:%M"), t.customer, "CAD", ""] for t in sorted(txns, key=lambda t: t.when)]
    write_csv(dirpath / "span_5_years.csv", hdr, rows, bom=False, crlf=False)

    # A single customer, 6 months, weekly.
    start, end = date(2025, 1, 6), date(2025, 6, 27)
    c = Customer("Solo Test Kitchen", 1, "VISA", "4242", base=900, every=7, start=start, stop=end, fail_p=0.1)
    txns = simulate(rng, [c], start, end)
    write_csv(dirpath / "one_customer.csv", HEADER, export_rows(rng, txns))

    # Required column missing (no Status).
    hdr = ["Date & Time", "Customer Number", "Amount", "Currency", "Card Type"]
    write_csv(dirpath / "missing_status_column.csv", hdr, [["03/11/2025 14:05", "Maple Kitchen", "120000", "CAD", "VISA"]])

    # Malformed: an unterminated quote swallows the rest of the file.
    (dirpath / "malformed_quote.csv").write_text(
        "Date & Time,Customer Number,Amount,Currency,Card Type,Status\n"
        "03/11/2025 14:05,Maple Kitchen,120000,CAD,VISA,Batched\n"
        '04/11/2025 15:10,"Cedar Grill,98000,CAD,VISA,Batched\n'
        "05/11/2025 16:20,Fig Deli,45000,CAD,MC,Batched\n", encoding="utf-8")

    # Month-first (US) dates: 12/31/2025 cannot be day-first, so every row is
    # rejected with a readable reason rather than silently swapped.
    write_csv(dirpath / "us_dates.csv", ["Date & Time", "Customer Number", "Amount", "Currency", "Card Type", "Status"],
              [["12/31/2025 14:05", "Maple Kitchen", "120000", "CAD", "VISA", "Batched"],
               ["12/30/2025 09:30", "Fig Deli", "45000", "CAD", "MC", "Batched"]])

    # Not a CSV at all.
    (dirpath / "not_a_csv.csv").write_bytes(b"PK\x03\x04\x14\x00\x06\x00\x08\x00\x00\x00!\x00binary-xlsx-ish\x00\x00")

    # The 2026 export layout: ~117 columns with repeated names (type, field01-14
    # five times), every value quoted except the timestamp, and year-first
    # dates with seconds (2026-06-30 21:44:36). Six months → weekly buckets.
    start, end = date(2026, 1, 2), date(2026, 6, 30)
    custs = build_customers(rng, 40, start, end)
    txns = simulate(rng, custs, start, end)
    txns.sort(key=lambda t: t.when, reverse=True)
    q = lambda v: '"' + str(v).replace('"', '""') + '"'
    lines = [",".join(HEADER_2026)]
    for t in txns:
        r = dict.fromkeys(dict.fromkeys(HEADER_2026), "")
        r.update({"Batch ID": "20000001", "Order ID": f"{rng.getrandbits(100):025x}", "Cardholder's Name": t.cardholder,
                  "Customer Number": t.customer, "Variable Ref": t.ref, "Amount": str(t.cents), "Currency": "CAD",
                  "Card Type": t.card, "PASRef": str(rng.randint(10**15, 10**16 - 1)), "Autosettle flag": "1",
                  "Transaction Source": "realcontrol auto", "Comment 2": "accounting", "Void Comment": t.void_note,
                  "Account": "moto", "Status": t.status, "Card Number": CARD_PREFIX[t.card] + "XXX" + t.last4,
                  "Merchant ID": "0000000000", "Transaction Type": t.txn_type, "CTP": "0"})
        cells = []
        for h in HEADER_2026:
            if h == "Date & Time":
                cells.append(t.when.strftime("%Y-%m-%d %H:%M:") + f"{rng.randint(0, 59):02d}")
            elif h == "Settle time":
                cells.append("")
            else:
                cells.append(q(r[h]))
        lines.append(",".join(cells))
    (dirpath / "export_2026_layout.csv").write_text("\ufeff" + "\r\n".join(lines) + "\r\n", encoding="utf-8", newline="")
    print(f"wrote fixtures to {dirpath.relative_to(ROOT)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fixtures", action="store_true", help="also write tests/fixtures/*.csv")
    args = ap.parse_args()
    main_sample(ROOT / "sample-data" / "sample_transactions.csv")
    if args.fixtures:
        fixtures(ROOT / "tests" / "fixtures")
