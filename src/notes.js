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

  /** Parse a notes file. Returns { byKey: {normName: note}, count }. Throws with a
   *  message naming each bad value and its line, so a typo is fixed, not guessed. */
  function fromCSV(text, parseCSV) {
    const { rows } = parseCSV(String(text));
    if (!rows.length) throw new Error('The notes file is empty.');
    const h = rows[0].map(norm);
    const col = (names) => h.findIndex((x) => names.includes(x));
    const ci = col(['customer', 'customer number', 'customer name', 'name']);
    if (ci < 0) throw new Error('The notes file needs a "Customer" column. Columns found: ' + rows[0].join(', '));
    const pi = col(['pays by', 'payment method', 'pays']), yi = col(['cycle', 'rhythm', 'terms']), si = col(['status']), di = col(['since']), ni = col(['note', 'notes', 'comment']);
    const byKey = {};
    const problems = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const name = String(r[ci] || '').trim().replace(/\s+/g, ' ');
      if (!name) return;
      const get = (k) => (k >= 0 ? String(r[k] || '').trim() : '');
      const pick = (table, raw, what) => {
        if (!raw) return null;
        const v = table[norm(raw)];
        if (!v) problems.push('line ' + line + ': ' + what + ' "' + raw + '" is not one of ' + [...new Set(Object.values(table))].join(', '));
        return v || null;
      };
      const note = {
        name, paysBy: pick(PAYS_BY, get(pi), 'Pays by'), cycle: pick(CYCLE, get(yi), 'Cycle'), status: pick(STATUS, get(si), 'Status'),
        since: null, sinceText: get(di), note: get(ni),
      };
      const since = parseSince(get(di));
      if (since === undefined) problems.push('line ' + line + ': Since "' + get(di) + '" should be YYYY-MM-DD or YYYY-MM');
      else note.since = since;
      if (note.paysBy === 'card') note.paysBy = null;
      if (note.status === 'active') note.status = null;
      if (!note.paysBy && !note.cycle && !note.status && !note.note && note.since == null) return; // nothing said
      byKey[norm(name)] = note;
    });
    if (problems.length) throw new Error('The notes file has ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ': ' + problems.slice(0, 5).join('; ') + (problems.length > 5 ? '; …' : ''));
    return { byKey, count: Object.keys(byKey).length };
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

  const api = { norm, fromCSV, toCSV, parseSince, describe, COLUMNS, CYCLE_DAYS, PAYS_BY, CYCLE, STATUS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCNotes = api;
})(typeof window !== 'undefined' ? window : globalThis);
