# Runbook: running the dashboard every week

Nothing is installed and nothing is hosted. The dashboard is one HTML file that
runs in a desktop browser; the data never leaves the computer.

## What lives where

One shared folder (not a public one: the CSVs contain customer names and
payments), with a sub-folder per file and a numbered folder per version:

```
Card-Sales-Dashboard/
├── README.txt                  ← which versions are live, and what changed in each
├── dashboard/
│   └── v3/dashboard_v3.html
├── customer-groups/
│   ├── v1/  v2/                ← kept for the record, not used
│   └── v3_FINAL/customer-groups_v3.csv
├── customer-notes/
│   ├── v1/  v2/                ← kept for the record, not used
│   └── v3_FINAL/customer-notes_v3.csv
├── exports/                    ← every card-processor export, named by its dates, never edited
│   ├── 2025-01-06_to_2025-11-28.csv
│   └── …
├── docs/runbook.md
└── reviews/                    ← review workbooks, named by date
```

| File | What it is | Who changes it |
|---|---|---|
| `dashboard_vN.html` | the dashboard, one file | replaced when a new build is released |
| `exports/*.csv` | card-processor exports, up to 90 days each | you, one new file each week |
| `customer-groups_vN.csv` | export names that are one customer on several cards | you, through **Customer groups** → *Save groups file* |
| `customer-notes_vN.csv` | what the export can't show: who pays by EFT or cheque, who pays monthly or seasonally, who stopped ordering | you, in Excel or through **Customer notes** → *Save notes file* |

**Versions.** Exactly one folder per file ends in `_FINAL`: that is the one to
load. To change groups or notes: save the new file as the next version in a new
folder (`v4_FINAL/customer-notes_v4.csv`), rename the old folder from
`v3_FINAL` to `v3`, and add one line to `README.txt` saying what changed. Never
edit an old version in place.

The browser remembers the groups and notes you loaded, so on the same computer
you only load the CSVs once and again after you change them. On a new computer
(or after clearing browser data) load the `_FINAL` versions again.

## Building the history (once)

The processor exports at most 90 days per file, so a year of history is several
files. The dashboard combines them:

- Export consecutive stretches of **up to 90 days**, each **starting on the last
  day of the one before** (overlap by a day). A transaction that appears in two
  files is counted once, so overlaps are harmless; gaps are not.
- Name each file by its dates, for example `2025-11-28_to_2026-01-02.csv`, and
  keep it in `exports/` as downloaded. Don't open and re-save it in Excel: Excel
  rewrites dates and reference numbers.
- When loaded, the dashboard lists every file with its dates, says how many rows
  were repeated across files, and warns about any stretch of 7+ days with no
  transactions at all, which usually means a missing file.

## Each week

1. **Export** the days since your last export (start on the last day of the
   previous file) as CSV and save it in `exports/`.
2. **Open** `dashboard.html` in Chrome or Edge (double-click it), select **all
   the files in `exports/`** and drop them onto the page together (or click the
   page and pick them all). Already open? **Add files…** adds the new one.
   The first time on a computer, also load `customer-groups/…_FINAL` and
   `customer-notes/…_FINAL` (see step 3).
   Check the blue "files combined" notice and that there is no gap warning.
3. If the top-right buttons don't show a count badge, **load** the `_FINAL`
   groups file (Customer groups → *Load groups file…*) and the `_FINAL` notes
   file (Customer notes → *Load notes file…*).
4. Read the four lists under **Momentum and slowdown** and **Customers**:

   | List | Means | Do |
   |---|---|---|
   | **Needs attention** | still paying by card, recent weeks well below their own baseline | call |
   | **Overdue against their own rhythm** | still a card payer, but late against their usual gap (under 60 days) | call |
   | **Stopped paying by card** | no card payment for 60+ days (3 months for monthly payers), or your notes say EFT / cheque | if "Why" says *presumed switched*, find out, then record it in Customer notes |
   | **Lost customers** | your notes say stopped ordering or closed | nothing; it's the record |

5. To look at particular customers, switch to the **Customer explorer** tab,
   open **Select customers** and tick them (or click any customer name in the
   Overview). Only their figures and charts are shown, side by side. The quick
   picks (Top 5, Needs attention, Overdue, Stopped paying by card) are a fast way
   to work through each list.
6. When you learn something the export can't show (switched to EFT, closed,
   pays monthly, seasonal), add it under **Customer notes** and **save the notes
   file** so the next person gets it too.
7. **Print / PDF** gives a one-click report for the week (of whichever tab is
   open). The **Light / Dark** switch top right changes the screen theme only.

## Reading the top of the page

The blue notice under the filters says, in one sentence, how this much history
is being read: what the tiles compare, how customers are tracked, and the
settling-in and 60-day rules. If the file is only a few weeks long, some lists
say so instead of guessing.

## When something looks wrong

- **A name appears twice** (one business, several cards): Customer groups →
  group them, save the groups file.
- **Someone is listed as stopped but still orders**: they pay another way now.
  Customer notes → *Pays by* EFT or cheque, with the month, save the notes file.
- **Someone is flagged who pays monthly or seasonally**: Customer notes →
  *Cycle* monthly or seasonal.
- **The file won't load**: the message names the problem and the file (a
  missing column, US-style dates, an Excel workbook saved as `.xlsx`).
  Re-export that one as CSV.
- **"No transactions at all between … and …"**: a stretch is missing from the
  files loaded. Export it (overlapping a day on each side) and add it. If it
  can't be exported (December 2025 can't), leave it: the dashboard treats those
  days as unknown, shows "No data" for that month and doesn't count the days
  towards anyone's 60-day silence.
- **"… both cover … but only N of their rows match"**: two overlapping files
  disagree, usually because one is from a different account or was re-saved in
  Excel. Re-export the overlap from the processor.
- **A new customer looks "new" but isn't**: the export only shows card payments,
  so a first card payment can be an existing account moving from EFT. The chart
  says "started paying by card" for that reason.

## Updating the dashboard

Replace `dashboard.html` with the new build. Groups and notes are unaffected:
they live in the browser and in your two CSVs, not in the dashboard file.
