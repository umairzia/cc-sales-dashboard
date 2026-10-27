# Input contract and cleaning rules

This is the contract between the card processor's export and the dashboard.
`src/parse.js` implements the reading and cleaning; `src/metrics.js` implements
the calculations. `tests/verify_metrics.py` re-implements the same rules
independently in pandas and asserts that the two agree.

## File

| Property | Accepted |
|---|---|
| Format | Comma-separated values, first non-blank row is the header |
| Encoding | UTF-8, with or without a byte-order mark |
| Line endings | `\r\n`, `\n` or `\r` |
| Quoting | RFC 4180: fields may be wrapped in `"…"`, may contain commas and line breaks, and `""` is a literal quote |
| Extra columns | Ignored. Older exports have ~35 columns; newer ones ~117, with repeated names such as `type` and `field01`–`field14` |
| Column order | Any |
| Size | Tested to 100,000 rows (about 2 seconds to parse and analyse) |

The file is read with the browser's File API and never written back. Nothing
is uploaded.

## Columns

Column names are matched after lower-casing and removing everything that is not
a letter or digit, so `Date & Time`, `date and time` and `DATE_TIME` all match.

| Purpose | Required | Names recognised | Notes |
|---|---|---|---|
| `date` | yes | Date & Time, Date and Time, Transaction Date, Date | `DD/MM/YYYY HH:MM` (**day first**, older exports) or `YYYY-MM-DD HH:MM:SS` (year first, newer exports). Time optional, seconds allowed. `03/11/2025` is 3 November. |
| `customer_name` | yes | Customer Number, Customer Name, Customer | Despite the name, this column holds the customer *name*. |
| `amount` | yes | Amount, Amount Cents, Transaction Amount | **Integer cents.** `263391` = $2,633.91. Thousands separators are tolerated; decimals are rejected. |
| `card_type` | yes | Card Type, Card Scheme, Card Brand | Upper-cased. A bare `type` column is **not** treated as card type. |
| `status` | yes | Status, Transaction Status, Result | See below. |
| `currency` | no | Currency, Currency Code | Shown in the header; mixed currencies raise a warning. |
| `void_comment` | no | Void Comment, Void Reason | Shown next to voided transactions (judgement call: not in the original brief). |
| `cardholder` | no | Cardholder's Name, Cardholder Name, Name on Card | Only used to suggest customer groups. |
| `card_number` | no | Card Number, Masked Card Number | Already masked by the processor (`45207100XXX6592`). Only the last 4 digits are kept, to suggest customer groups. |

If a required column is missing, the dashboard stops and names the missing
column(s), along with the columns it did find.

## Cleaning rules

1. **Dates are parsed explicitly**, never with `Date.parse()`. Two formats are
   accepted, each with an optional time (`HH:MM` or `HH:MM:SS`):
   - `DD/MM/YYYY`: slashes (or dots/dashes) with the year *last* are always
     read **day first**, so `03/11/2025` is 3 November.
   - `YYYY-MM-DD`: a 4-digit year *first* is unambiguous (newer exports
     write `2026-06-30 21:44:36`).

   The format is detected per row, and the data-quality panel reports which
   one the file used (and warns if a file mixes them). Impossible dates
   (`31/02/2025`), month-first US dates (`12/31/2025`) and two-digit years
   are rejected and listed with their line numbers; nothing is guessed or
   swapped. The time (to the second) is used only to order attempts made on
   the same day.
2. **Amount is divided by 100.** Internally everything stays in integer cents
   so totals are exact.
3. **Status** is normalised to exactly three values:
   - `Batched` = a successful charge.
   - `Failed`: from an empty status, the literal `Failed`, or any value
     *starting with* `Failed` (real exports write
     `Failed - Result [101] Message [Declined]`). The `Message [...]` text is
     kept as the failure reason.
   - `Voided` = cancelled by an admin.
   - Anything else is rejected and listed in the data-quality panel.
4. **A blank customer name** becomes `One-Time Manual Charge`: cards keyed into
   the terminal once and never stored against an account. It is treated as a
   single pseudo-customer, marked with † and an "aggregate" tag wherever it
   could rank, and left out of per-customer behaviour analysis (trends, needs
   attention, gone quiet, cadence, RFM, acquisition, active-customer count).
5. **Negative amounts** (refunds, chargebacks, credits) are never netted into
   gross revenue. They are counted and listed separately; *net revenue* =
   gross − refunds.
6. **Zero amounts** should not exist. They are kept and flagged for review.
7. **Revenue uses `Batched` rows with a positive amount only**, except in
   sections that are explicitly about failures or voids.

## Retry chains

A failed charge is often re-attempted days later for the same amount.

- Rows are grouped by `(customer_name, amount, card_type)`.
- Within a group, rows are walked in time order. One or more `Failed` rows
  followed by a `Batched` row form **one chain**. The chain records the number
  of attempts and the days from the first failure to the success.
- A group can contain several chains, or none: a success that came *before* a
  failure is not a recovery.
- **Retry recovery rate** = failed charges followed by a matching success ÷
  all failed charges.
- Revenue is never double-counted: only the `Batched` row is revenue.
- Identical amounts on different dates with no failure between them are normal
  repeat orders (customers order against a fixed order guide) and are not
  flagged.

## Customer groups

`Customer Number` is one label per card on file, so one customer can have several.
A groups mapping (`label → customer`) is applied to every row before any
calculation. Manual charges (blank `Customer Number`) can also be mapped, by
their cardholder name; once mapped they leave the one-time aggregate and count
as that customer. Manual charges without a cardholder are never mapped.

Suggestions link two labels when:

1. their names match ignoring case and punctuation, or one is the other plus a
   trailing card tag: `OTO`, `One Time Only`, `One Time`, `Temp`, `V<n>`, or a
   4-digit number **equal to the last 4 digits of that label's own card**. Other
   numbers are store numbers and are kept; or
2. the cardholder name on one label (with the same tags removed) is another
   label's name.

A manual charge takes part through its cardholder name (rule 1): the manual
charges by `Fig Deli Temp` are suggested for `Fig Deli`. A manual charge is only
ever suggested alongside a named customer. A card number shared by two labels is
**not** treated as a link, because chains often pay for several locations with
one corporate card.

Linked labels form one suggestion. Its proposed name is the tag-free name that
covers the most revenue. Suggestions are never applied automatically.

Groups are stored in the browser's `localStorage` and can be exported or
imported as a CSV:

```csv
Customer Number,Cardholder (manual charges),Group As
"Fig Deli OTO","","Fig Deli"
"Fig Deli 4242","","Fig Deli"
"","Fig Deli Temp","Fig Deli"
```

The cardholder column is only filled for manual charges, and older two-column
files (`Customer Number,Group As`) still load.

## Duplicates

A **same-day exact duplicate** is two or more `Batched` rows with the same
customer, amount, card type *and date*. They are listed for review and never
removed automatically.

## Time buckets

| Span of the selected range (first to last day, inclusive) | Default bucket |
|---|---|
| ≤ 60 days | Daily |
| 61–183 days | Weekly (ISO weeks, Monday start) |
| 184 days to under 5 years (< 1,826 days) | Monthly |
| 5 years or more (≥ 1,826 days) | Quarterly |

The dropdown overrides the default. A bucket is **partial** when the selected
range starts after its first day or ends before its last day (daily buckets are
never partial). Partial buckets are drawn hatched and marked `*`, and they are
excluded from the % change chart and rolling averages.

## Timeframes

Chart buckets only decide how bars are drawn. Comparisons follow a timeframe
chosen from the same span:

| Timeframe | Span | KPI comparison | Customer tracking | Needs attention baseline | "New" customers |
|---|---|---|---|---|---|
| a few weeks | ≤ 45 days | last 7 days vs the 7 before | 7-day blocks counted back from the last day | previous 2 weeks (recent: last 2) | not determined |
| a few months | 46–183 days | last 28 (or 14, 7) days vs the same before | 7-day blocks | previous 4 weeks (recent: last 4) | first seen after day 35 |
| about a year | 184–395 days | last complete month vs the previous one | complete months | previous 3 months (recent: last 3) | first seen after day 45 |
| more than a year | 396+ days | last complete month vs the same month a year earlier | complete months, trend over the last 12 | same 3 months a year earlier | first seen after day 45 |

The % change chart compares each day with the same weekday a week earlier, and
(more than a year) each month or quarter with the same one a year earlier.
"Gone quiet" means no successful charge in the last two tracking periods, after
at least two charges, and a silence longer than twice the customer's usual gap.
