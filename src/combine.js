/* combine.js — several exports, one dataset.
 *
 * The card processor only exports up to 90 days at a time, so a year of
 * history arrives as several files, and consecutive exports usually overlap by
 * a day or more. This merges the parsed files into one set of rows:
 *
 *  - A transaction that appears in two files is counted once. Rows match on
 *    date, time to the minute, customer name (as exported), amount, card type
 *    and status. Minutes, not seconds, because older exports re-saved in Excel
 *    only keep HH:MM while newer ones have seconds; and no processor reference
 *    numbers, because Excel turns those into "1.74E+15".
 *  - Identical rows inside one file are kept (they can be genuine same-day
 *    duplicates, which the data-quality panel lists). Across files the larger
 *    count wins: if file A has a row twice and file B has it twice too, it is
 *    counted twice, not four times.
 *  - Overlapping files whose rows don't match (a different kind of export,
 *    shifted time zone) are reported, not silently doubled.
 *  - Gaps: any stretch of 7+ days with no transaction at all, in any file, is
 *    reported, because a missing chunk would otherwise make every regular
 *    customer look as if they had stopped paying by card.
 *
 * Pure functions, no DOM. window.CCCombine in the browser, require() in Node.
 */
(function (root) {
  'use strict';

  const GAP_DAYS = 7;          // a gap of this many days between two transaction days is reported
  const OVERLAP_MATCH = 0.9;   // overlapping files should agree on at least 90% of the smaller side

  const keyOf = (r) => r.day + '|' + Math.floor(r.second / 60) + '|' + r.customer + '|' + r.cents + '|' + r.card + '|' + r.status;

  /** Short label for a file, for line references ("Jan-Mar.csv line 12"). */
  const labelOf = (name) => String(name || 'file').replace(/^.*[\\/]/, '');

  /**
   * files: [{ name, rows, quality }] in the order chosen. Returns
   * { rows, quality, files: [{name, from, to, rows, kept, duplicates}], overlaps: [...], gaps: [...] }.
   */
  function combine(files) {
    if (!files.length) throw new Error('No files to combine.');
    // Earliest file first, so the overlap is always "the later file repeats the earlier one".
    const order = files.map((f, i) => ({ f, i, start: f.rows.length ? f.rows[0].day : Infinity })).sort((a, b) => a.start - b.start || a.i - b.i);
    const many = files.length > 1;
    const seen = new Map();           // key → how many rows with that key are already kept
    const out = [];
    const info = [];
    order.forEach(({ f }, fi) => {
      const src = many ? labelOf(f.name) : '';
      const here = new Map();         // key → occurrences so far in this file
      let kept = 0;
      for (const r of f.rows) {
        const k = keyOf(r);
        const j = here.get(k) || 0;
        here.set(k, j + 1);
        if (j < (seen.get(k) || 0)) continue;     // already counted from an earlier file
        out.push(many ? Object.assign({}, r, { src, fileIndex: fi }) : r);
        kept++;
      }
      for (const [k, n] of here) if (n > (seen.get(k) || 0)) seen.set(k, n);
      info.push({ name: labelOf(f.name), from: f.rows.length ? f.rows[0].day : null, to: f.rows.length ? f.rows[f.rows.length - 1].day : null, rows: f.rows.length, kept, duplicates: f.rows.length - kept });
    });
    out.sort((a, b) => a.day - b.day || a.second - b.second || (a.fileIndex || 0) - (b.fileIndex || 0) || a.line - b.line);

    // Overlap check: where two files cover the same days, they should hold the same rows.
    const overlaps = [];
    for (let x = 0; x < order.length; x++) {
      for (let y = x + 1; y < order.length; y++) {
        const A = order[x].f, B = order[y].f;
        if (!A.rows.length || !B.rows.length) continue;
        const lo = Math.max(A.rows[0].day, B.rows[0].day), hi = Math.min(A.rows[A.rows.length - 1].day, B.rows[B.rows.length - 1].day);
        if (lo > hi) continue;
        const inside = (rows) => rows.filter((r) => r.day >= lo && r.day <= hi);
        const a = inside(A.rows), b = inside(B.rows);
        const count = (rows) => { const m = new Map(); rows.forEach((r) => { const k = keyOf(r); m.set(k, (m.get(k) || 0) + 1); }); return m; };
        const ca = count(a), cb = count(b);
        let matched = 0;
        for (const [k, n] of ca) matched += Math.min(n, cb.get(k) || 0);
        const smaller = Math.min(a.length, b.length);
        overlaps.push({ a: labelOf(A.name), b: labelOf(B.name), from: lo, to: hi, rowsA: a.length, rowsB: b.length, matched, ok: !smaller || matched / smaller >= OVERLAP_MATCH });
      }
    }

    let quality = mergeQuality(order.map((o) => o.f));
    if (many) {
      // Rows repeated across files are read twice but used once: they are not rejected rows.
      const repeated = info.reduce((n, f) => n + f.duplicates, 0);
      quality = Object.assign({}, quality, { parsed: out.length, totalDataRows: quality.totalDataRows - repeated, repeatedAcrossFiles: repeated, files: info.length });
    }
    return { rows: out, quality, files: info, overlaps, gaps: findGaps(out) };
  }

  /** Stretches of GAP_DAYS+ between two consecutive days that have any transaction. */
  function findGaps(rows, minDays) {
    const n = minDays || GAP_DAYS;
    const days = [...new Set(rows.map((r) => r.day))].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < days.length; i++) if (days[i] - days[i - 1] >= n) gaps.push({ after: days[i - 1], before: days[i], empty: days[i] - days[i - 1] - 1 });
    return gaps;
  }

  /** Sum the per-file data-quality reports; sampled rows keep which file they came from. */
  function mergeQuality(files) {
    if (files.length === 1) return files[0].quality;
    const q = {
      totalDataRows: 0, parsed: 0, blankLines: 0,
      badDate: [], badAmount: [], shortRows: [], unknownStatus: [], dateFormats: {},
      blankCustomer: 0, blankStatus: 0, suffixedFailed: 0,
      negative: [], zero: [], currencies: {}, cardTypes: {}, columns: {}, ignoredColumns: 0,
    };
    const add = (into, from) => { for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v; };
    for (const f of files) {
      const fq = f.quality, src = labelOf(f.name);
      ['totalDataRows', 'parsed', 'blankLines', 'blankCustomer', 'blankStatus', 'suffixedFailed'].forEach((k) => { q[k] += fq[k] || 0; });
      ['badDate', 'badAmount', 'shortRows', 'unknownStatus', 'negative', 'zero'].forEach((k) => {
        (fq[k] || []).forEach((it) => q[k].push(Object.assign({}, it, { src })));
        if (fq[k] && fq[k].overflow) q[k].overflow = (q[k].overflow || 0) + fq[k].overflow;
      });
      add(q.dateFormats, fq.dateFormats); add(q.currencies, fq.currencies); add(q.cardTypes, fq.cardTypes);
      for (const [k, v] of Object.entries(fq.columns || {})) if (!q.columns[k]) q.columns[k] = v;
      q.ignoredColumns = Math.max(q.ignoredColumns, fq.ignoredColumns || 0);
    }
    return q;
  }

  /** "Jan-Mar.csv line 12" when rows came from several files, else "line 12". */
  const where = (r) => (r && r.src ? r.src + ' line ' : 'line ') + (r ? r.line : '');

  const api = { combine, findGaps, mergeQuality, keyOf, where, GAP_DAYS, OVERLAP_MATCH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCCombine = api;
})(typeof window !== 'undefined' ? window : globalThis);
