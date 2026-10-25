// Unit tests for the pure parse + metrics layers.   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/parse.js');
const M = require('../src/metrics.js');

const iso = (day) => M.isoDate(day);
const HDR = 'Date & Time,Customer Number,Amount,Currency,Card Type,Status';
const csv = (...lines) => [HDR, ...lines].join('\n');

test('CSV tokenizer: quotes, escaped quotes, CRLF, BOM, newlines in quotes', () => {
  const t = '﻿a,b,c\r\n"x, y","he said ""hi""",3\r\n"multi\nline",,\r\n';
  const { rows } = P.parseCSV(t);
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', '3'], ['multi\nline', '', '']]);
  assert.throws(() => P.parseCSV('a,b\n"open,1\n'), /Unterminated quoted field starting on line 2/);
});

test('dates: day-first slashes or year-first ISO, never guessed', () => {
  const D = (v) => P.parseDate(v);
  assert.equal(iso(D('03/11/2025 14:05').day), '2025-11-03');
  assert.equal(D('03/11/2025 14:05').second, (14 * 60 + 5) * 60);
  assert.equal(D('03/11/2025 14:05').fmt, 'dmy');
  assert.equal(iso(D('3/1/2025').day), '2025-01-03');
  assert.equal(iso(D('29/02/2024 00:00').day), '2024-02-29');
  assert.equal(D('31/02/2025 10:00'), null);
  assert.equal(D('12/31/2025'), null); // month-first (US) input is rejected, not swapped
  // Year-first (the 2026 export): unambiguous, seconds kept for ordering.
  assert.equal(iso(D('2026-06-30 21:44:36').day), '2026-06-30');
  assert.equal(D('2026-06-30 21:44:36').second, 21 * 3600 + 44 * 60 + 36);
  assert.equal(D('2026-06-30 21:44:36').fmt, 'ymd');
  assert.equal(iso(D('2026-01-02T16:16:25').day), '2026-01-02');
  assert.equal(iso(D('2026/03/11').day), '2026-03-11'); // never 3 November
  assert.equal(D('2026-02-30 10:00:00'), null);
  assert.equal(D('2026-13-01 10:00:00'), null);
  assert.equal(D('2026-06-30 25:00:00'), null);
  assert.equal(D('30-06-26'), null); // 2-digit years are ambiguous
  assert.equal(D(''), null);
});

test('the 2026 export layout: repeated column names, quoted values, year-first dates', () => {
  const hdr = 'Batch ID,Date & Time,Order ID,Customer Number,Amount,Currency,Card Type,Settle time,Status,type,field01,type,field01,CTP';
  const r = P.parseTransactions([hdr,
    '"1",2026-06-30 21:44:36,"a","Fig Deli","550248","CAD","VISA",,"Failed - Result [101] Message [Declined]","","","","","0"',
    '"1",2026-06-30 21:44:59,"b","Fig Deli","550248","CAD","VISA",,"Batched","","","","","0"',
    '"1",2026-06-30 21:44:10,"c","Fig Deli","100","CAD","VISA",,"Voided","","","","","0"'].join('\r\n'));
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.quality.dateFormats, { ymd: 3 });
  // Same minute, listed newest first: seconds put the failure before the success.
  assert.deepEqual(r.rows.map((x) => x.status), ['Voided', 'Failed', 'Batched']);
  assert.equal(M.retryChains(r.rows).chains.length, 1);
  assert.throws(() => P.parseTransactions(csv('12/31/2025 14:05,x,1,CAD,VISA,Batched')), (e) => /expected DD\/MM\/YYYY HH:MM \(day first\) or YYYY-MM-DD/.test(e.detail));
});

test('amounts are integer cents', () => {
  assert.equal(P.parseCents('263391'), 263391);
  assert.equal(P.parseCents(' -177120 '), -177120);
  assert.equal(P.parseCents('1,234'), 1234);
  assert.equal(P.parseCents('12.50'), null);
  assert.equal(P.parseCents(''), null);
});

test('status normalisation', () => {
  assert.deepEqual(P.normaliseStatus('Batched'), { status: 'Batched' });
  assert.deepEqual(P.normaliseStatus(' VOIDED '), { status: 'Voided' });
  assert.equal(P.normaliseStatus('').status, 'Failed');
  assert.equal(P.normaliseStatus('').blank, true);
  const f = P.normaliseStatus('Failed - Result [101] Message [Expiry Date incorrect]');
  assert.equal(f.status, 'Failed');
  assert.equal(f.reason, 'Expiry Date incorrect');
  assert.equal(P.normaliseStatus('Pending').status, null);
});

test('column detection is case/spacing-insensitive and does not confuse "type" with "Card Type"', () => {
  const { found, missing } = P.detectColumns(['STATUS', ' amount ', 'type', 'card type', 'date & time', 'Customer Number']);
  assert.deepEqual(missing, []);
  assert.equal(found.card, 3);
  assert.equal(P.detectColumns(['type', 'Date & Time', 'Customer Number', 'Amount', 'Status']).missing[0], 'Card Type');
});

test('cleaning rules: blanks, negatives, zeros, readable failures', () => {
  const r = P.parseTransactions(csv(
    '03/11/2025 14:05,,10000,CAD,VISA,Batched',
    '04/11/2025 14:05,Fig Deli,20000,CAD,visa,',
    '05/11/2025 14:05,Fig Deli,-5000,CAD,VISA,Batched',
    '06/11/2025 14:05,Fig Deli,0,CAD,VISA,Batched',
    'not a date,Fig Deli,1,CAD,VISA,Batched',
    '',
  ));
  assert.equal(r.rows.length, 4);
  assert.equal(r.rows[0].customer, P.ONE_TIME);
  assert.equal(r.rows[0].oneTime, true);
  assert.equal(r.rows[1].status, 'Failed');
  assert.equal(r.rows[1].card, 'VISA');
  assert.equal(r.quality.blankCustomer, 1);
  assert.equal(r.quality.blankStatus, 1);
  assert.equal(r.quality.negative.length, 1);
  assert.equal(r.quality.zero.length, 1);
  assert.equal(r.quality.badDate[0].line, 6);

  assert.throws(() => P.parseTransactions('Date & Time,Customer Number,Amount\n01/01/2025,x,1'), /Missing required columns: Card Type, Status/);
  assert.throws(() => P.parseTransactions(csv('2025.01.01.,x,1,CAD,VISA,Batched')), (e) => /None of the 1 rows/.test(e.message) && /expected DD\/MM\/YYYY/.test(e.detail));
  assert.throws(() => P.parseTransactions('PK\u0003\u0004\u0000\u0000'), /does not look like a CSV/);
  assert.throws(() => P.parseTransactions(''), /empty/);
});

test('adaptive bucketing thresholds', () => {
  assert.equal(M.autoUnit(60), 'day');
  assert.equal(M.autoUnit(61), 'week');
  assert.equal(M.autoUnit(90), 'week');
  assert.equal(M.autoUnit(183), 'week');
  assert.equal(M.autoUnit(184), 'month');
  assert.equal(M.autoUnit(365), 'month');
  assert.equal(M.autoUnit(1825), 'month');
  assert.equal(M.autoUnit(1826), 'quarter');
});

test('buckets: Monday weeks, calendar months/quarters, partial edges', () => {
  const d = (s) => P.parseDate(s).day;
  const weeks = M.buildBuckets(d('08/01/2025'), d('22/01/2025'), 'week'); // Wed → Wed
  assert.deepEqual(weeks.map((b) => iso(b.start)), ['2025-01-06', '2025-01-13', '2025-01-20']);
  assert.deepEqual(weeks.map((b) => b.partial), [true, false, true]);
  const months = M.buildBuckets(d('06/01/2025'), d('28/11/2025'), 'month');
  assert.equal(months.length, 11);
  assert.equal(months[0].partial && months[10].partial && !months[5].partial, true);
  const q = M.buildBuckets(d('01/01/2021'), d('31/12/2025'), 'quarter');
  assert.equal(q.length, 20);
  assert.equal(q.some((b) => b.partial), false);
  assert.equal(q[0].short, "Q1 '21");
});

test('retry chains: sequential failure → success, never double counted', () => {
  const row = (day, status, cents = 5000, card = 'VISA', customer = 'A') => ({ day, second: 0, line: day, customer, cents, card, status, oneTime: false });
  let r = M.retryChains([row(1, 'Failed'), row(2, 'Failed'), row(4, 'Batched')]);
  assert.equal(r.chains.length, 1);
  assert.equal(r.chains[0].attempts, 3);
  assert.equal(r.chains[0].days, 3);
  assert.equal(r.recoveryRate, 1);
  r = M.retryChains([row(1, 'Batched'), row(8, 'Failed')]); // success came first: not a retry
  assert.equal(r.chains.length, 0);
  assert.equal(r.unrecovered.length, 1);
  assert.equal(r.mixedGroups, 1);
  r = M.retryChains([row(1, 'Failed'), row(2, 'Batched'), row(9, 'Batched'), row(15, 'Failed'), row(16, 'Batched')]);
  assert.equal(r.chains.length, 2);
  r = M.retryChains([row(1, 'Failed'), row(2, 'Batched', 5000, 'MC')]); // different card: separate groups
  assert.equal(r.chains.length, 0);
});

test('quartile scores match pandas qcut(rank(method="first"), 4)', () => {
  assert.deepEqual(M.quartileScores([5, 5, 5, 5, 1, 2, 3, 4]), [3, 3, 4, 4, 1, 1, 2, 2]);
  assert.deepEqual(M.quartileScores([10, 10, 10, 10, 10]), [1, 1, 2, 3, 4]);
  assert.deepEqual(M.quartileScores([3, 1, 2, 9, 9, 9, 4, 7, 7, 1, 0]), [2, 1, 2, 4, 4, 4, 2, 3, 3, 1, 1]);
});

test('slope is OLS $/bucket', () => {
  assert.equal(M.slope([0, 100, 200, 300]), 100);
  assert.equal(M.slope([5, 5, 5, 5]), 0);
  assert.ok(Math.abs(M.slope([400, 300, 250, 100]) - -95) < 1e-9);
});

test('revenue uses Batched only; refunds separate; one-time charge is not a named customer', () => {
  const { rows } = P.parseTransactions(csv(
    '06/01/2025 10:00,A,10000,CAD,VISA,Batched',
    '07/01/2025 10:00,A,10000,CAD,VISA,',
    '08/01/2025 10:00,A,10000,CAD,VISA,Batched',
    '09/01/2025 10:00,,99900,CAD,MC,Batched',
    '10/01/2025 10:00,B,-2500,CAD,VISA,Batched',
    '11/01/2025 10:00,B,7000,CAD,AMEX,Voided',
  ));
  const a = M.analyse(rows, {});
  assert.equal(a.unit, 'day');
  assert.equal(a.totals.gross, 10000 + 10000 + 99900);
  assert.equal(a.totals.refunds, 2500);
  assert.equal(a.totals.net, 10000 + 10000 + 99900 - 2500);
  assert.equal(a.totals.count, 3);
  assert.equal(a.totals.activeCustomers, 1);
  assert.equal(a.totals.oneTimeCharges, 1);
  assert.equal(a.totals.successRate, 3 / 5);
  assert.equal(a.retry.chains.length, 1);
  assert.equal(a.totals.voidCents, 7000);
  assert.equal(a.top15.find((c) => c.oneTime).name, P.ONE_TIME);
  assert.equal(a.pareto[a.pareto.length - 1].oneTime, true); // aggregate placed last
});
