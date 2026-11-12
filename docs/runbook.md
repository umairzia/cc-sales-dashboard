# Runbook: running the dashboard every week

Nothing is installed and nothing is hosted. The dashboard is one HTML file that
runs in a desktop browser; the data never leaves the computer.

## What lives where

Keep these three files together in one folder (a shared drive is fine, but the
two CSVs contain customer names, so not a public one):

| File | What it is | Who changes it |
|---|---|---|
| `dashboard.html` | the dashboard, one file | replaced when a new build is released |
| `customer-groups.csv` | export names that are one customer on several cards | you, through **Customer groups** → *Save groups file* |
| `customer-notes.csv` | what the export can't show: who pays by EFT or cheque, who pays monthly or seasonally, who stopped ordering | you, in Excel or through **Customer notes** → *Save notes file* |

The browser remembers the groups and notes you loaded, so on the same computer
you only load the CSVs once and again after you change them. On a new computer
(or after clearing browser data) load both files again.

## Each week

1. **Export** the transactions from the card processor as CSV, from **1 January
   of last year to today**. A long range is better than a short one: the
   dashboard adapts its comparisons to the length, and a year or more unlocks
   the year-over-year view and the "same month last year" baselines.
2. **Open** `dashboard.html` in Chrome or Edge (double-click it) and **drop the
   CSV** onto the page.
3. If the top-right buttons don't show a count badge, **load**
   `customer-groups.csv` (Customer groups → *Load groups file…*) and
   `customer-notes.csv` (Customer notes → *Load notes file…*).
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
- **The file won't load**: the message names the problem (a missing column,
  US-style dates, an Excel workbook saved as `.xlsx`). Re-export as CSV.
- **A new customer looks "new" but isn't**: the export only shows card payments,
  so a first card payment can be an existing account moving from EFT. The chart
  says "started paying by card" for that reason.

## Updating the dashboard

Replace `dashboard.html` with the new build. Groups and notes are unaffected:
they live in the browser and in your two CSVs, not in the dashboard file.
