/* groups.js — combine customer names that are really one customer.
 *
 * The card processor stores each card on file under its own customer label,
 * so one business can appear as "Fig Deli", "Fig Deli OTO" and "Fig Deli 4242".
 * Groups map those labels onto one customer name. They are the user's own
 * data: suggested from the export, confirmed by the user, kept in their
 * browser (never in this code, never uploaded).
 *
 * Pure functions, no DOM. window.CCGroups in the browser, require() in Node.
 */
(function (root) {
  'use strict';

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Trailing tokens that mark an extra card rather than a different business.
  // A 4-digit number only counts when it equals that label's own card ending,
  // so store numbers ("Harbour Grill 7018", "QM3467") are never stripped.
  const TAGS = [/ one time only$/, / one time$/, / onetime$/, / oto$/, / temp$/, / v\d{1,2}$/];

  /** { base, tags[] } for a normalised name, given the card endings seen on it. */
  function cardTagBase(name, last4s) {
    let base = norm(name);
    const tags = [];
    for (let changed = true; changed && base.includes(' ');) {
      changed = false;
      for (const re of TAGS) {
        const m = re.exec(base);
        if (m) { tags.push(m[0].trim()); base = base.slice(0, m.index).trim(); changed = true; }
      }
      const d = / (\d{4})$/.exec(base);
      if (d && last4s && last4s.has(d[1])) { tags.push(d[1]); base = base.slice(0, d.index).trim(); changed = true; }
    }
    return { base, tags };
  }

  /** Split an original label into its display base and card-tag text. */
  function splitTag(label, info) {
    const words = label.trim().split(/\s+/);
    const n = info.tags.length ? norm(info.tags.join(' ')).split(' ').length : 0;
    return n && n < words.length ? { base: words.slice(0, -n).join(' ').replace(/[\s\-–]+$/, ''), tag: words.slice(-n).join(' ') } : { base: label, tag: '' };
  }

  /** Last four digits of a masked card number ("45207100XXX6592" → "6592"). */
  function cardLast4(masked) {
    const m = /(\d{4})\s*$/.exec(String(masked || ''));
    return m ? m[1] : '';
  }

  /** Per-label profile from parsed rows (one-time manual charges excluded). */
  function profiles(rows) {
    const out = new Map();
    for (const r of rows) {
      if (r.oneTime) continue;
      let p = out.get(r.customer);
      if (!p) out.set(r.customer, (p = { name: r.customer, rows: 0, gross: 0, cards: new Map(), holders: new Set(), last4s: new Set() }));
      p.rows++;
      if (r.status === 'Batched' && r.cents > 0) p.gross += r.cents;
      if (r.last4) { p.last4s.add(r.last4); p.cards.set(r.card + ' …' + r.last4, true); } else p.cards.set(r.card, true);
      if (r.cardholder) p.holders.add(r.cardholder);
    }
    return out;
  }

  /** Suggest groups. Returns [{ name, members: [label…], reasons: [text…] }]
   *  sorted by combined revenue. Two labels are linked when:
   *   1. their names match ignoring case/punctuation, or one is the other plus
   *      a card tag (OTO, One Time Only, Temp, V2, or its own card ending); or
   *   2. the cardholder name on one label is another label's name. */
  function suggestGroups(rows) {
    const prof = profiles(rows);
    const labels = [...prof.keys()];
    const info = new Map(labels.map((l) => {
      const p = prof.get(l);
      return [l, Object.assign({ n: norm(l) }, cardTagBase(l, p.last4s))];
    }));
    const parent = new Map(labels.map((l) => [l, l]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const reasons = [];
    const link = (a, b, why) => {
      if (a === b) return;
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
      reasons.push({ label: a, text: why });
    };

    // Rule 1: same name, or same name plus a card tag.
    const byKey = new Map();
    for (const l of labels) {
      const i = info.get(l);
      for (const k of new Set([i.n, i.base])) {
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(l);
      }
    }
    for (const l of labels) {
      const i = info.get(l);
      for (const other of byKey.get(i.base) || []) {
        if (other === l) continue;
        const j = info.get(other);
        if (j.n === i.n) link(l, other, '“' + l + '” and “' + other + '” are the same name');
        else if (i.tags.length && (j.n === i.base || j.base === i.base)) {
          const t = splitTag(l, i);
          link(l, other, '“' + l + '” is “' + t.base + '” plus the card tag “' + t.tag + '”');
        }
      }
    }
    // Rule 2: a cardholder name that is another customer's name.
    for (const l of labels) {
      for (const h of prof.get(l).holders) {
        const hb = cardTagBase(h, prof.get(l).last4s).base;
        const own = info.get(l);
        if (!hb || hb === own.n || hb === own.base) continue; // cardholder just repeats the label
        for (const other of byKey.get(hb) || []) {
          if (other !== l) link(l, other, 'The cardholder on “' + l + '” is “' + h + '”');
        }
      }
    }

    const sets = new Map();
    for (const l of labels) { const r = find(l); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(l); }
    const out = [];
    for (const members of sets.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => prof.get(b).gross - prof.get(a).gross || (a < b ? -1 : 1));
      const why = [];
      for (const r of reasons) if (members.includes(r.label) && !why.includes(r.text)) why.push(r.text);
      out.push({ name: suggestName(members, prof, info), members, reasons: why, gross: members.reduce((s, m) => s + prof.get(m).gross, 0) });
    }
    return out.sort((a, b) => b.gross - a.gross);
  }

  /** The candidate name (a member's tag-free base, in its original casing)
   *  that prefixes the most revenue among the members. */
  function suggestName(members, prof, info) {
    const cands = new Map();
    for (const m of members) {
      // Members arrive biggest first, so the biggest label's casing wins.
      const target = info.get(m).base;
      if (!cands.has(target)) cands.set(target, splitTag(m, info.get(m)).base);
    }
    let best = null, bestScore = -1;
    for (const [n, display] of cands) {
      const score = members.filter((m) => info.get(m).n === n || info.get(m).n.startsWith(n + ' ')).reduce((s, m) => s + prof.get(m).gross + 1, 0);
      if (score > bestScore || (score === bestScore && display.length < best.length)) { best = display; bestScore = score; }
    }
    return best;
  }

  /** Rows with customer replaced by its group; the original label is kept as `alias`. */
  function applyGroups(rows, mapping) {
    const keys = mapping ? Object.keys(mapping) : [];
    if (!keys.length) return rows;
    return rows.map((r) => {
      const g = !r.oneTime && Object.prototype.hasOwnProperty.call(mapping, r.customer) ? mapping[r.customer] : null;
      return g && g !== r.customer ? Object.assign({}, r, { customer: g, alias: r.customer }) : r;
    });
  }

  /** Groups file (CSV): "Customer Number","Group As". */
  function toCSV(mapping) {
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = ['Customer Number,Group As'];
    Object.keys(mapping).sort((a, b) => (mapping[a] + a < mapping[b] + b ? -1 : 1)).forEach((k) => lines.push(q(k) + ',' + q(mapping[k])));
    return lines.join('\r\n') + '\r\n';
  }

  function fromCSV(text, parseCSV) {
    const { rows } = parseCSV(String(text));
    if (!rows.length) throw new Error('The groups file is empty.');
    const h = rows[0].map(norm);
    const ci = h.findIndex((x) => ['customer number', 'customer', 'customer name', 'name'].includes(x));
    const gi = h.findIndex((x) => ['group as', 'group', 'group name', 'combine as', 'parent'].includes(x));
    if (ci < 0 || gi < 0) throw new Error('A groups file needs two columns: “Customer Number” and “Group As”.');
    const mapping = {};
    for (const r of rows.slice(1)) {
      const c = (r[ci] || '').trim().replace(/\s+/g, ' '), g = (r[gi] || '').trim().replace(/\s+/g, ' ');
      if (c && g) mapping[c] = g;
    }
    return mapping;
  }

  const api = { norm, cardTagBase, cardLast4, profiles, suggestGroups, applyGroups, toCSV, fromCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCGroups = api;
})(typeof window !== 'undefined' ? window : globalThis);
