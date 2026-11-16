/* notes.js — what the card export cannot show, one row per customer.
 *
 * The export only lists card payments. It cannot tell a customer who stopped
 * ordering from one who now pays by EFT, or a monthly payer from a weekly one
 * who is late. The people who run the accounts can, so they keep a small
 * customer-notes file (edited in a spreadsheet, loaded in the dashboard) and
 * the dashboard applies it to every list:
 *
 *   Pays by   card (default) | EFT | cheque | mixed
 *             EFT / cheque: "stopped paying by card" at once, with the reason;
 *             mixed: card share varies, so never flagged for a drop or lateness.
 *   Cycle     weekly | monthly | seasonal | sporadic | on request
 *             (blank = measured from their card payments)
 *             monthly: compared month to month; stopped only after 3 cycles;
 *             seasonal: never stopped / overdue / slipping, shown as off season;
 *             sporadic, on request: no rhythm to compare against, so never
 *             overdue or slipping; still "stopped" after 60 days.
 *   Status    active (default) | stopped ordering | closed
 *             either one moves the customer to "Lost customers" as of Since.
 *   Since     YYYY-MM-DD or YYYY-MM, optional: the switch, stop or closure date.
 *   Note      free text, shown next to the name.
 *
 * Pure functions, no DOM. window.CCNotes in the browser, require() in Node.
 */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const PAYS_BY = { card: 'card', eft: 'EFT', etransfer: 'EFT', 'e transfer': 'EFT', 'bank transfer': 'EFT', cheque: 'cheque', check: 'cheque', mixed: 'mixed', 'card and eft': 'mixed' };
  const CYCLE = { weekly: 'weekly', week: 'weekly', monthly: 'monthly', month: 'monthly', 'month to month': 'monthly', '30 day terms': 'monthly', seasonal: 'seasonal', sporadic: 'sporadic', occasional: 'sporadic', irregular: 'sporadic', rare: 'sporadic', 'on request': 'on request', 'by request': 'on request', 'prior warning': 'on request' };
  const STATUS = { active: 'active', 'stopped ordering': 'stopped ordering', stopped: 'stopped ordering', closed: 'closed', 'shut down': 'closed', lost: 'stopped ordering' };
  const CYCLE_DAYS = { weekly: 7, monthly: 365.25 / 12 };
  const COLUMNS = ['Customer', 'Pays by', 'Cycle', 'Status', 'Since', 'Note'];

  /** "2026-06" → first of that month, "2026-06-15" → that day, as days since epoch. */
  function parseSince(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(s);
    if (!m) return undefined;
    const y = +m[1], mo = m[2] ? +m[2] - 1 : 0, d = m[3] ? +m[3] : 1;
    const t = Date.UTC(y, mo, d);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return undefined;
    return Math.round(t / DAY_MS);
  }

  /** Last day the Since text can mean: "2025" → 31 Dec 2025, "2026-09" → 30 Sep 2026. */
  function sinceEnd(v) {
    const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(String(v || '').trim());
    if (!m) return null;
    const y = +m[1];
    if (m[3]) return parseSince(v);
    if (m[2]) return Math.round(Date.UTC(y, +m[2], 1) / DAY_MS) - 1;
    return Math.round(Date.UTC(y + 1, 0, 1) / DAY_MS) - 1;
  }

  /** Edit distance, for typos such as "Cheuqe" or "spordaic". */
  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(new Array(b.length).fill(0)));
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  const TABLES = { paysBy: PAYS_BY, cycle: CYCLE, status: STATUS };
  const FIELD_NAME = { paysBy: 'Pays by', cycle: 'Cycle', status: 'Status' };
  const UNKNOWN = ['unknown', 'not sure', 'dont know', 'don t know', 'n a', 'na', 'tbc', 'tbd', '?'];
  const SEMI_ACTIVE = ['semi active', 'semiactive', 'partly active', 'part active', 'semi'];

  /** What one cell means: a known value (own column first, then the others,
   *  then typos), a cycle in days ("21 days"), or nothing. */
  function classify(raw, own) {
    const v = norm(raw);
    if (!v || UNKNOWN.includes(v)) return { kind: 'blank' };
    if (SEMI_ACTIVE.includes(v)) return { kind: 'value', field: 'status', value: 'active', why: 'active (still a customer, ordering irregularly)' };
    const order = [own].concat(Object.keys(TABLES).filter((f) => f !== own));
    for (const f of order) if (TABLES[f][v]) return { kind: 'value', field: f, value: TABLES[f][v] };
    if (['fortnightly', 'biweekly', 'bi weekly', 'every two weeks', 'every 2 weeks'].includes(v)) return { kind: 'value', field: 'cycle', value: 'every 14 days', days: 14, why: 'cycle every 14 days' };
    const days = /(\d{1,3})\s*(?:-\s*)?days?\b/.exec(v) || /\bnet\s*(\d{1,3})\b/.exec(v);
    if (days) {
      const n = +days[1];
      if (n >= 1 && n <= 366) {
        const value = n === 7 ? 'weekly' : n >= 28 && n <= 31 ? 'monthly' : 'every ' + n + ' days';
        return { kind: 'value', field: 'cycle', value, days: n, why: 'cycle ' + value };
      }
    }
    for (const f of order) {
      for (const k of Object.keys(TABLES[f])) {
        if (k.length >= 6 && distance(v, k) <= (k.length >= 8 ? 2 : 1)) return { kind: 'value', field: f, value: TABLES[f][k] };
      }
    }
    return { kind: 'unknown' };
  }

  /**
   * Parse a notes file. Returns { byKey: {normName: note}, count, interpreted, ignored }.
   * Forgiving, and open about it: a value in the wrong column ("sporadic" under
   * Status), a typo ("Cheuqe"), "semi-active", "unknown" or "on 21 days" are read
   * as clearly meant and listed in `interpreted`; a value that can't be read is
   * skipped (the rest of the row still counts) and listed in `ignored`. Only a
   * file with no Customer column is rejected.
   */
  function fromCSV(text, parseCSV) {
    const { rows } = parseCSV(String(text));
    if (!rows.length) throw new Error('The notes file is empty.');
    const h = rows[0].map(norm);
    const col = (names) => h.findIndex((x) => names.includes(x));
    const ci = col(['customer', 'customer number', 'customer name', 'name']);
    if (ci < 0) throw new Error('The notes file needs a "Customer" column. Columns found: ' + rows[0].join(', '));
    const cols = { paysBy: col(['pays by', 'payment method', 'pays']), cycle: col(['cycle', 'rhythm', 'terms']), status: col(['status']) };
    const di = col(['since']), ni = col(['note', 'notes', 'comment']);
    const byKey = {};
    const interpreted = [], ignored = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const name = String(r[ci] || '').trim().replace(/\s+/g, ' ');
      if (!name) return;
      const get = (k) => (k >= 0 ? String(r[k] || '').trim() : '');
      const where = 'line ' + line + ' (' + name + ')';
      const note = { name, paysBy: null, cycle: null, cycleDays: null, status: null, since: null, sinceText: '', sinceEnd: null, note: get(ni) };
      const set = { paysBy: false, cycle: false, status: false };
      // Each column's own value first, so a value that strays into another column never overrides it.
      const cells = Object.keys(cols).map((f) => ({ f, raw: get(cols[f]), c: classify(get(cols[f]), f) }));
      cells.sort((a, b) => (a.c.field === a.f ? 0 : 1) - (b.c.field === b.f ? 0 : 1));
      for (const { f, raw, c } of cells) {
        if (c.kind === 'blank') { if (raw && norm(raw) !== '') interpreted.push(where + ': ' + FIELD_NAME[f] + ' "' + raw + '" read as blank'); continue; }
        if (c.kind === 'unknown') { ignored.push(where + ': ' + FIELD_NAME[f] + ' "' + raw + '" is not one of ' + [...new Set(Object.values(TABLES[f]))].join(', ')); continue; }
        if (set[c.field]) { ignored.push(where + ': ' + FIELD_NAME[f] + ' "' + raw + '" would also set ' + FIELD_NAME[c.field] + ', which is already given'); continue; }
        set[c.field] = true;
        note[c.field] = c.value;
        if (c.days) note.cycleDays = c.days;
        const exact = c.field === f && (norm(raw) === norm(c.value) || TABLES[f][norm(raw)] === c.value);
        if (!exact) interpreted.push(where + ': ' + FIELD_NAME[f] + ' "' + raw + '" read as ' + (c.why || (c.field === f ? '' : FIELD_NAME[c.field] + ' ') + c.value));
        if (c.days && !/^\s*\d{1,3}\s*days?\s*$/i.test(raw)) {
          const rest = raw.replace(/,?\s*(on\s+)?\d{1,3}\s*(-\s*)?days?\b/i, '').trim();
          if (rest) note.note = (rest + (note.note ? ' · ' + note.note : '')).trim();
        }
      }
      const sinceRaw = get(di);
      if (sinceRaw) {
        const since = parseSince(sinceRaw);
        if (since === undefined) ignored.push(where + ': Since "' + sinceRaw + '" should be YYYY-MM-DD, YYYY-MM or YYYY');
        else { note.since = since; note.sinceText = sinceRaw; note.sinceEnd = sinceEnd(sinceRaw); }
      }
      if (note.paysBy === 'card') note.paysBy = null;
      if (note.status === 'active') note.status = null;
      if (!note.paysBy && !note.cycle && !note.status && !note.note && note.since == null) return; // nothing said
      byKey[norm(name)] = note;
    });
    return { byKey, count: Object.keys(byKey).length, interpreted, ignored };
  }

  function toCSV(byKey) {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [COLUMNS.map(q).join(',')];
    Object.values(byKey).sort((a, b) => a.name.localeCompare(b.name))
      .forEach((n) => lines.push([n.name, n.paysBy || '', n.cycle || '', n.status || '', n.sinceText || '', n.note || ''].map(q).join(',')));
    return lines.join('\r\n') + '\r\n';
  }

  /** One line describing a note, for tooltips and tables. */
  function describe(n) {
    if (!n) return '';
    const bits = [];
    if (n.status) bits.push(n.status + (n.sinceText ? ' since ' + n.sinceText : ''));
    if (n.paysBy) bits.push('pays by ' + n.paysBy + (!n.status && n.sinceText ? ' since ' + n.sinceText : ''));
    if (n.cycle) bits.push(n.cycle);
    if (n.note) bits.push(n.note);
    return bits.join(' · ');
  }

  const api = { norm, fromCSV, toCSV, parseSince, sinceEnd, describe, distance, COLUMNS, CYCLE_DAYS, PAYS_BY, CYCLE, STATUS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCNotes = api;
})(typeof window !== 'undefined' ? window : globalThis);
