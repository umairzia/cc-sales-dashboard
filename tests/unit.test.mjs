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

test('dates are day-first and never guessed', () => {
  assert.equal(iso(P.parseDayFirst('03/11/2025 14:05').day), '2025-11-03');
  assert.equal(P.parseDayFirst('03/11/2025 14:05').minute, 14 * 60 + 5);
  assert.equal(iso(P.parseDayFirst('3/1/2025').day), '2025-01-03');
  assert.equal(iso(P.parseDayFirst('29/02/2024 00:00').day), '2024-02-29');
  assert.equal(P.parseDayFirst('31/02/2025 10:00'), null);
  assert.equal(P.parseDayFirst('11/13/2025'), null); // month 13: month-first input is rejected
  assert.equal(P.parseDayFirst('2025-11-03 14:05'), null);
  assert.equal(P.parseDayFirst(''), null);
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
  assert.throws(() => P.parseTransactions(csv('2025-01-01,x,1,CAD,VISA,Batched')), (e) => /None of the 1 rows/.test(e.message) && /expected DD\/MM\/YYYY/.test(e.detail));
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
  const d = (s) => P.parseDayFirst(s).day;
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
  const row = (day, status, cents = 5000, card = 'VISA', customer = 'A') => ({ day, minute: 0, line: day, customer, cents, card, status, oneTime: false });
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
