/* parse.js — CSV reading + cleaning rules.
 *
 * Pure functions, no DOM. Loaded as a classic <script> in the browser (exposes
 * window.CCParse) and require()-able from Node for tests.
 *
 * Every rule here encodes business logic described in docs/csv-format.md.
 * The source file is never modified: we only ever read the text we are given.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // CSV tokenizer: RFC 4180-ish. Handles quoted fields with commas, escaped
  // quotes (""), newlines inside quotes, \r\n / \n / \r line endings and a
  // UTF-8 BOM. Returns { rows: string[][], lines: number[] } where lines[i] is
  // the 1-based physical line on which row i starts (used in error messages).
  // ---------------------------------------------------------------------------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    const lines = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let line = 1;
    let rowStartLine = 1;
    let quoteOpenLine = 0;
    const n = text.length;

    for (let i = 0; i < n; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          if (c === '\n') line++;
          else if (c === '\r' && text[i + 1] !== '\n') line++;
          field += c;
        }
        continue;
      }
      if (c === '"') {
        // A quote only opens a quoted field at the start of a field. A stray
        // quote mid-field is kept literally (common in hand-edited exports).
        if (field === '') { inQuotes = true; quoteOpenLine = line; }
        else field += c;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); lines.push(rowStartLine);
        row = [];
        line++;
        rowStartLine = line;
      } else {
        field += c;
      }
    }
    if (inQuotes) {
      const err = new Error(
        'Unterminated quoted field starting on line ' + quoteOpenLine +
        '. The file may be truncated or not a valid CSV.');
      err.line = quoteOpenLine;
      throw err;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); lines.push(rowStartLine); }
    return { rows, lines };
  }

  // ---------------------------------------------------------------------------
  // Column detection — case/spacing/punctuation-insensitive, with aliases.
  // ---------------------------------------------------------------------------
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  const COLUMNS = {
    date:     { label: 'Date & Time',     required: true,  aliases: ['datetime', 'dateandtime', 'transactiondate', 'transactiondatetime', 'date'] },
    customer: { label: 'Customer Number', required: true,  aliases: ['customernumber', 'customername', 'customer', 'customerno'] },
    amount:   { label: 'Amount',          required: true,  aliases: ['amount', 'amountcents', 'transactionamount'] },
    card:     { label: 'Card Type',       required: true,  aliases: ['cardtype', 'cardscheme', 'cardbrand'] },
    status:   { label: 'Status',          required: true,  aliases: ['status', 'transactionstatus', 'result'] },
    currency: { label: 'Currency',        required: false, aliases: ['currency', 'currencycode'] },
    // Optional extra (judgement call, see README): shown next to voided rows.
    voidNote: { label: 'Void Comment',    required: false, aliases: ['voidcomment', 'voidreason'] },
  };

  function detectColumns(header) {
    const normed = header.map(norm);
    const found = {};
    for (const key of Object.keys(COLUMNS)) {
      for (const alias of COLUMNS[key].aliases) {
        const idx = normed.indexOf(alias);
        if (idx !== -1) { found[key] = idx; break; }
      }
    }
    const missing = Object.keys(COLUMNS)
      .filter((k) => COLUMNS[k].required && found[k] === undefined)
      .map((k) => COLUMNS[k].label);
    return { found, missing };
  }

  // ---------------------------------------------------------------------------
  // Field parsers
  // ---------------------------------------------------------------------------
  const DAY_MS = 86400000;
  const DATE_RE = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/;

  /** Parse DD/MM/YYYY [HH:MM[:SS]] explicitly — day first. Never Date.parse().
   *  Returns { day, minute } where day = days since 1970-01-01 (UTC calendar,
   *  so no timezone drift) and minute = minute-of-day (used only for ordering
   *  same-day attempts), or null when invalid. */
  function parseDayFirst(raw) {
    const m = DATE_RE.exec(raw);
    if (!m) return null;
    const d = +m[1], mo = +m[2], y = +m[3];
    const hh = m[4] === undefined ? 0 : +m[4];
    const mi = m[5] === undefined ? 0 : +m[5];
    if (mo < 1 || mo > 12 || d < 1 || y < 1900 || y > 2200 || hh > 23 || mi > 59) return null;
    const ms = Date.UTC(y, mo - 1, d);
    const check = new Date(ms);
    if (check.getUTCDate() !== d) return null; // e.g. 31/02/2025
    return { day: Math.round(ms / DAY_MS), minute: hh * 60 + mi };
  }

  /** Amount is integer cents. Accepts an optional sign and thousands commas.
   *  Anything with a decimal point is rejected: the contract is cents. */
  function parseCents(raw) {
    const s = String(raw).trim().replace(/[\s,]/g, '');
    if (!/^[-+]?\d+$/.test(s)) return null;
    const v = parseInt(s, 10);
    return Number.isSafeInteger(v) ? v : null;
  }

  /** Status: Batched / Failed / Voided. Blank → Failed (an unsuccessful attempt
   *  is exported with an empty status). "Failed - Result [101] Message [...]"
   *  variants → Failed with the message kept as the failure reason. */
  function normaliseStatus(raw) {
    const s = String(raw).trim();
    if (s === '') return { status: 'Failed', blank: true, reason: 'Blank status' };
    const l = s.toLowerCase();
    if (l === 'batched') return { status: 'Batched' };
    if (l === 'voided' || l === 'void') return { status: 'Voided' };
    if (l.startsWith('failed') || l === 'declined') {
      const msg = /message\s*\[([^\]]*)\]/i.exec(s);
      const reason = msg ? msg[1].trim() : (s.replace(/^failed\s*[-:]?\s*/i, '') || 'Failed');
      return { status: 'Failed', suffixed: l !== 'failed', reason: reason || 'Failed' };
    }
    return { status: null, unknown: s };
  }

  const ONE_TIME = 'One-Time Manual Charge';

  // ---------------------------------------------------------------------------
  // Main entry: text → { rows, quality, meta } or throws a readable Error.
  // ---------------------------------------------------------------------------
  function parseTransactions(text, opts) {
    opts = opts || {};
    if (text == null || !String(text).trim()) throw userError('The file is empty.');
    if (/\u0000/.test(text.slice(0, 4096))) {
      throw userError('This does not look like a CSV file (it contains binary data). ' +
        'If it is an Excel workbook, open it and use “Save As → CSV” first.');
    }
    const { rows: table, lines } = parseCSV(String(text));
    // Skip leading blank lines before the header.
    let h = 0;
    while (h < table.length && table[h].every((c) => c.trim() === '')) h++;
    if (h >= table.length) throw userError('The file is empty.');
    const header = table[h].map((c) => c.trim());
    const { found, missing } = detectColumns(header);
    if (missing.length) {
      const shown = header.filter(Boolean).slice(0, 40).join(', ');
      throw userError(
        'Missing required column' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '.',
        'Columns found in this file: ' + (shown || '(none)') + '. Column names are matched case-insensitively; ' +
        'see the expected format below.');
    }

    const q = {
      totalDataRows: 0, parsed: 0, blankLines: 0,
      badDate: [], badAmount: [], shortRows: [], unknownStatus: [],
      blankCustomer: 0, blankStatus: 0, suffixedFailed: 0,
      negative: [], zero: [], currencies: {}, cardTypes: {},
      columns: Object.fromEntries(Object.entries(found).map(([k, i]) => [k, header[i]])),
      ignoredColumns: header.length - Object.keys(found).length,
    };
    const out = [];
    const maxIdx = Math.max(...Object.values(found));
    const sample = (arr, item) => { if (arr.length < 200) arr.push(item); else arr.overflow = (arr.overflow || 0) + 1; };

    for (let r = h + 1; r < table.length; r++) {
      const cells = table[r];
      const line = lines[r];
      if (cells.every((c) => c.trim() === '')) { q.blankLines++; continue; }
      q.totalDataRows++;
      if (cells.length <= maxIdx) {
        sample(q.shortRows, { line, got: cells.length, need: maxIdx + 1 });
        continue;
      }
      const rawDate = cells[found.date];
      const dt = parseDayFirst(rawDate);
      if (!dt) { sample(q.badDate, { line, value: rawDate }); continue; }
      const rawAmt = cells[found.amount];
      const cents = parseCents(rawAmt);
      if (cents === null) { sample(q.badAmount, { line, value: rawAmt }); continue; }
      const st = normaliseStatus(cells[found.status]);
      if (!st.status) { sample(q.unknownStatus, { line, value: st.unknown }); continue; }

      let customer = cells[found.customer].trim().replace(/\s+/g, ' ');
      const oneTime = customer === '';
      if (oneTime) { customer = ONE_TIME; q.blankCustomer++; }
      if (st.blank) q.blankStatus++;
      if (st.suffixed) q.suffixedFailed++;
      const card = (cells[found.card] || '').trim().toUpperCase() || 'UNKNOWN';
      const currency = found.currency !== undefined ? (cells[found.currency].trim().toUpperCase() || 'UNKNOWN') : 'UNKNOWN';
      q.currencies[currency] = (q.currencies[currency] || 0) + 1;
      q.cardTypes[card] = (q.cardTypes[card] || 0) + 1;

      const row = {
        line, day: dt.day, minute: dt.minute, customer, oneTime,
        cents, currency, card, status: st.status,
        reason: st.status === 'Failed' ? st.reason : '',
        voidNote: found.voidNote !== undefined ? (cells[found.voidNote] || '').trim() : '',
      };
      if (cents < 0) sample(q.negative, row);
      if (cents === 0) sample(q.zero, row);
      out.push(row);
      q.parsed++;
    }

    if (!q.totalDataRows) throw userError('The file has a header row but no transactions.');
    if (!out.length) {
      const first = q.badDate[0] || q.badAmount[0] || q.shortRows[0] || q.unknownStatus[0];
      let why = '';
      if (q.badDate.length) why = 'Row on line ' + first.line + ' has date “' + first.value + '”, expected DD/MM/YYYY HH:MM.';
      else if (q.badAmount.length) why = 'Row on line ' + first.line + ' has amount “' + first.value + '”, expected whole cents (e.g. 263391 for $2,633.91).';
      else if (q.shortRows.length) why = 'Row on line ' + first.line + ' has only ' + first.got + ' fields; ' + first.need + ' expected.';
      else if (q.unknownStatus.length) why = 'Row on line ' + first.line + ' has status “' + first.value + '”, expected Batched, Failed or Voided.';
      throw userError('None of the ' + q.totalDataRows + ' rows could be read.', why);
    }
    const rejected = q.totalDataRows - q.parsed;
    if (rejected / q.totalDataRows > 0.5) {
      throw userError('More than half of the rows (' + rejected + ' of ' + q.totalDataRows + ') could not be read, so the numbers would not be trustworthy.',
        describeFirstProblem(q));
    }

    out.sort((a, b) => a.day - b.day || a.minute - b.minute || a.line - b.line);
    return { rows: out, quality: q, meta: { header, fileName: opts.fileName || '' } };
  }

  function describeFirstProblem(q) {
    const parts = [];
    if (q.badDate.length) parts.push(q.badDate.length + ' with unreadable dates (first: line ' + q.badDate[0].line + ', “' + q.badDate[0].value + '”)');
    if (q.badAmount.length) parts.push(q.badAmount.length + ' with unreadable amounts (first: line ' + q.badAmount[0].line + ', “' + q.badAmount[0].value + '”)');
    if (q.shortRows.length) parts.push(q.shortRows.length + ' with too few fields (first: line ' + q.shortRows[0].line + ')');
    if (q.unknownStatus.length) parts.push(q.unknownStatus.length + ' with unknown status (first: line ' + q.unknownStatus[0].line + ', “' + q.unknownStatus[0].value + '”)');
    return 'Rows rejected: ' + parts.join('; ') + '.';
  }

  function userError(message, detail) {
    const e = new Error(message);
    e.userFacing = true;
    e.detail = detail || '';
    return e;
  }

  const api = { parseCSV, detectColumns, parseDayFirst, parseCents, normaliseStatus, parseTransactions, COLUMNS, ONE_TIME, DAY_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
