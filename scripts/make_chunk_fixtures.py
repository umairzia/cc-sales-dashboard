#!/usr/bin/env python3
"""Split the synthetic sample into overlapping "90-day style" exports, as the
card processor delivers them, to test combining several files.

    python3 scripts/make_chunk_fixtures.py

Writes tests/fixtures/chunk_a_nov_jan.csv, chunk_b_jan_apr_newer_layout.csv and
chunk_c_apr_oct.csv from sample-data/sample_transactions.csv (synthetic only):

- A: 4 Nov 2024 – 31 Jan 2025, original layout (DD/MM/YYYY HH:MM).
- B: 25 Jan – 30 Apr 2025 in a newer layout: year-first dates with seconds,
  columns in another order, no card-number column. Overlaps A by 7 days.
- C: 28 Apr – 29 Oct 2025, original layout. Overlaps B by 3 days.

Combined, A + B + C must give exactly the figures of the single sample file.
A + C alone leave out February to April, which the dashboard must report.
"""
from __future__ import annotations

import csv
import hashlib
import io
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "sample-data" / "sample_transactions.csv"
OUT = ROOT / "tests" / "fixtures"


def write(path: Path, header: list[str], rows: list[list[str]]) -> None:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(header)
    w.writerows(rows)
    path.write_text("﻿" + buf.getvalue(), encoding="utf-8", newline="")


def main() -> None:
    with SAMPLE.open(encoding="utf-8-sig", newline="") as f:
        r = csv.reader(f)
        header = next(r)
        rows = list(r)
    di = header.index("Date & Time")
    when = lambda row: datetime.strptime(row[di], "%d/%m/%Y %H:%M")
    between = lambda a, b: [x for x in rows if a <= when(x).date() <= b]

    write(OUT / "chunk_a_nov_jan.csv", header, between(date(2024, 11, 4), date(2025, 1, 31)))
    write(OUT / "chunk_c_apr_oct.csv", header, between(date(2025, 4, 28), date(2025, 10, 29)))

    # Newer layout: Status first, year-first timestamps with seconds, card number dropped.
    keep = [h for h in header if h and h != "Card Number"]
    order = ["Status"] + [h for h in keep if h != "Status"]
    out = []
    for x in between(date(2025, 1, 25), date(2025, 4, 30)):
        rec = dict(zip(header, x))
        sec = int(hashlib.sha1("|".join(x).encode()).hexdigest(), 16) % 60   # deterministic seconds
        rec["Date & Time"] = when(x).strftime("%Y-%m-%d %H:%M:") + f"{sec:02d}"
        out.append([rec.get(h, "") for h in order])
    write(OUT / "chunk_b_jan_apr_newer_layout.csv", order, out)
    print("wrote chunk_a_nov_jan.csv, chunk_b_jan_apr_newer_layout.csv, chunk_c_apr_oct.csv to tests/fixtures/")


if __name__ == "__main__":
    main()
