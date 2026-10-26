/* app.js — wiring, filters, state and rendering of every section.
 * Data values are only ever inserted with textContent (never innerHTML). */
(function () {
  'use strict';

  const P = window.CCParse, M = window.CCMetrics, C = window.CCCharts, F = window.CCFormat, G = window.CCGroups;
  const $ = (id) => document.getElementById(id);

  const state = {
    rows: null, quality: null, fileName: '', fileSize: 0,
    from: null, to: null, preset: 'all', unit: 'auto', status: 'all', threshold: 0.25,
    slopesAll: false, cadenceAll: false, segment: null, analysis: null,
    // Customer groups: { "label in export": "customer it belongs to" }, kept in this browser.
    groups: {}, dismissed: [], storeOk: true,
    mapped: null, profiles: new Map(), suggestions: [], members: new Map(),
  };

  // ---------------------------------------------------------------------------
  // Customer groups: persistence (this browser only) and application
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'ccdash.customerGroups.v1';
  function loadStore() {
    try {
      const v = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (v && v.groups && typeof v.groups === 'object') { state.groups = v.groups; state.dismissed = Array.isArray(v.dismissed) ? v.dismissed : []; }
    } catch (e) { state.storeOk = false; }
  }
  function saveStore() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify({ groups: state.groups, dismissed: state.dismissed })); state.storeOk = true; }
    catch (e) { state.storeOk = false; }
  }
  const resolve = (label) => state.groups[label] || label;
  const sugKey = (s) => s.members.slice().sort().join('\u0000');

  /** Recompute grouped rows, suggestions and group membership for the loaded file. */
  function refreshGroups() {
    if (!state.rows) return;
    state.profiles = G.profiles(state.rows);
    state.suggestions = G.suggestGroups(state.rows);
    state.mapped = G.applyGroups(state.rows, state.groups);
    state.members = new Map();
    for (const label of state.profiles.keys()) {
      const g = resolve(label);
      if (g === label && !Object.values(state.groups).includes(label)) continue;
      if (!state.members.has(g)) state.members.set(g, []);
      state.members.get(g).push(label);
    }
    for (const [g, list] of state.members) if (list.length === 1 && list[0] === g) state.members.delete(g);
  }
  function pendingSuggestions() {
    return state.suggestions.filter((s) => !state.dismissed.includes(sugKey(s)) && new Set(s.members.map(resolve)).size > 1);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return n;
  }
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  const nameCell = (name, oneTime) => {
    const mem = state.members.get(name);
    return [name,
      oneTime ? el('span', { class: 'tag agg', title: 'Not a customer: an aggregate of unrelated cards keyed in once', text: 'aggregate †' }) : null,
      mem ? el('span', { class: 'tag grp', title: 'One customer, shown under these names in the export: ' + mem.join(' + '), text: mem.length > 1 ? mem.length + ' names' : 'grouped' }) : null];
  };

  /** Sortable table. columns: {key,label,num,fmt(row)→string|Node[],sort(row)→value} */
  function table(columns, rows, opts) {
    opts = opts || {};
    const wrap = el('div', { 'data-many': rows.length > 15 ? String(rows.length) : null });
    if (!rows.length) {
      wrap.append(el('p', { class: 'empty-row' + (opts.good ? ' good' : ''), text: opts.empty || 'Nothing to show.' }));
      return wrap;
    }
    let sortKey = opts.sort ? opts.sort.key : null;
    let dir = opts.sort ? opts.sort.dir : 1;
    const t = el('table', { class: 'data' });
    const thead = el('thead');
    const tbody = el('tbody');
    t.append(thead, tbody);
    const draw = () => {
      clear(thead); clear(tbody);
      const tr = el('tr');
      columns.forEach((c) => {
        const active = c.key === sortKey;
        const th = el('th', {
          class: (c.num ? 'num ' : '') + 'sortable', scope: 'col', tabindex: '0',
          'aria-sort': active ? (dir > 0 ? 'ascending' : 'descending') : 'none',
          onclick: () => { if (sortKey === c.key) dir = -dir; else { sortKey = c.key; dir = c.num ? -1 : 1; } draw(); },
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); } },
        }, c.label, active ? el('span', { class: 'arrow', text: dir > 0 ? '▲' : '▼' }) : null);
        tr.append(th);
      });
      thead.append(tr);
      let list = rows.slice();
      if (sortKey) {
        const col = columns.find((c) => c.key === sortKey);
        const val = col.sort || ((r) => r[col.key]);
        list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      }
      if (opts.max) list = list.slice(0, opts.max);
      list.forEach((r) => {
        tbody.append(el('tr', null, columns.map((c) => el('td', { class: c.num ? 'num' : c.name ? 'name' : '' }, c.fmt ? c.fmt(r) : r[c.key]))));
      });
    };
    draw();
    wrap.append(t);
    if (opts.max && rows.length > opts.max) wrap.append(el('p', { class: 'empty-row', text: 'Showing ' + opts.max + ' of ' + rows.length + '.' }));
    return wrap;
  }

  const noun = () => M.UNIT_NOUN[state.analysis.unit];
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const fmtDay = (d) => M.longDate(d);

  function isoToDay(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    return m ? M.dayOf(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  async function loadFile(file) {
    if (!file) return;
    let text;
    try { text = await file.text(); }
    catch (e) { return showError('The file could not be opened by the browser.', String(e && e.message || e)); }
    let parsed;
    try { parsed = P.parseTransactions(text, { fileName: file.name }); }
    catch (e) { return showError(e.message, e.detail || ''); }

    Object.assign(state, {
      rows: parsed.rows, quality: parsed.quality, fileName: file.name, fileSize: file.size,
      preset: 'all', unit: 'auto', status: 'all', segment: null, slopesAll: false, cadenceAll: false,
    });
    refreshGroups();
    const dMin = parsed.rows[0].day, dMax = parsed.rows[parsed.rows.length - 1].day;
    state.from = dMin; state.to = dMax;
    const t0 = M.ymd(dMin), t1 = M.ymd(dMax);
    state.minAllowed = M.dayOf(t0.y, t0.m, 1);
    state.maxAllowed = M.dayOf(t1.y, t1.m + 1, 1) - 1;
    $('preset').value = 'all';
    $('bucket').value = 'auto';
    $('statusFilter').value = 'all';
    $('threshold').value = String(Math.round(state.threshold * 100));
    $('errorCard').hidden = true;
    $('intro').hidden = true;
    $('dashboard').hidden = false;
    $('fileMeta').hidden = false;
    $('app').dataset.state = 'ready';
    render();
    window.scrollTo(0, 0);
  }

  function showError(message, detail) {
    C.destroyAll();
    $('dashboard').hidden = true;
    $('fileMeta').hidden = true;
    $('intro').hidden = false;
    $('errorCard').hidden = false;
    $('errorMsg').textContent = message;
    $('errorDetail').textContent = detail || '';
    $('app').dataset.state = 'error';
    $('fileInput').value = '';
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Render pipeline
  // ---------------------------------------------------------------------------
  function analyse() {
    state.analysis = M.analyse(state.mapped || state.rows, { from: state.from, to: state.to, unit: state.unit, status: state.status, threshold: state.threshold });
    return state.analysis;
  }

  function render() {
    const a = analyse();
    syncControls(a);
    renderMeta(a);
    if (a.empty) {
      C.destroyAll();
      clear($('kpis')).append(el('div', { class: 'notice warn span-2' }, el('span', { class: 'ico', text: '⚠' }), 'No transactions in the selected period. Widen the date range.'));
      clear($('notices'));
      document.querySelectorAll('#dashboard .section').forEach((s) => { s.hidden = true; });
      return;
    }
    document.querySelectorAll('#dashboard .section').forEach((s) => { s.hidden = false; });
    paint();
  }

  /** Everything that depends on theme colours or the analysis. */
  function paint() {
    const a = state.analysis;
    if (!a || a.empty) return;
    const t = C.theme();
    C.configure(t);
    renderNotices(a);
    renderKPIs(a);
    renderRevenue(a, t);
    renderMomentum(a, t);
    renderCustomers(a, t);
    renderRFM(a, t);
    renderAcquisition(a, t);
    renderRisk(a, t);
    renderDQ(a);
    updateGroupsBadge();
    $('footerMeta').textContent = 'Card Sales Dashboard · analysed ' + new Date().toLocaleString() + ' · ' + F.int(a.rowsInScope) + ' rows in view · works offline · MIT licence';
  }

  function syncControls(a) {
    const fromIn = $('fromDate'), toIn = $('toDate');
    [fromIn, toIn].forEach((i) => { i.min = M.isoDate(state.minAllowed); i.max = M.isoDate(state.maxAllowed); });
    fromIn.value = M.isoDate(state.from);
    toIn.value = M.isoDate(state.to);
    $('bucket').options[0].textContent = 'Auto (' + M.UNIT_LABEL[a.autoUnit || M.autoUnit(state.to - state.from + 1)] + ')';
  }

  function renderMeta(a) {
    const q = state.quality;
    const rows = state.rows;
    $('metaFile').textContent = state.fileName;
    $('metaFile').title = state.fileName;
    $('metaRange').textContent = fmtDay(rows[0].day) + ' – ' + fmtDay(rows[rows.length - 1].day) + ' (' + plural(rows[rows.length - 1].day - rows[0].day + 1, 'day') + ')';
    $('metaRows').textContent = F.int(q.parsed) + (q.totalDataRows !== q.parsed ? ' of ' + F.int(q.totalDataRows) : '');
    const cur = Object.keys(q.currencies);
    $('metaCurrency').textContent = cur.length === 1 ? cur[0] : cur.join(', ') + ' ⚠';
    const statusText = state.status === 'success' ? 'Successful charges only' : 'All attempts';
    $('printSummary').textContent = state.fileName + ' · ' + fmtDay(a.from) + ' – ' + fmtDay(a.to) + ' · grouped by ' + (a.unit || '') + ' · ' + statusText + ' · printed ' + new Date().toLocaleDateString();
  }

  function notice(kind, text, action) {
    return el('div', { class: 'notice ' + kind }, el('span', { class: 'ico', text: kind === 'warn' ? '⚠' : 'ℹ' }), el('span', null, text),
      action ? el('button', { type: 'button', class: 'btn small', onclick: action.onclick }, action.label) : null);
  }

  function renderNotices(a) {
    const box = clear($('notices'));
    const q = state.quality;
    const pend = pendingSuggestions();
    if (pend.length) {
      const eg = pend.slice(0, 3).map((x) => x.name + ' ×' + x.members.length).join(', ');
      box.append(notice('info', plural(pend.length, 'set') + ' of customer names look like one customer on several cards (' + eg + (pend.length > 3 ? ', …' : '') + '). Until they are grouped, each name counts as a separate customer.',
        { label: 'Review customer groups', onclick: openGroups }));
    }
    const cur = Object.keys(q.currencies);
    if (cur.length > 1) box.append(notice('warn', 'This file mixes currencies (' + cur.map((c) => c + ': ' + q.currencies[c]).join(', ') + '). Amounts are added together as-is, so totals mix currencies. Filter the export to one currency for accurate figures.'));
    const rejected = q.totalDataRows - q.parsed;
    if (rejected) box.append(notice('warn', plural(rejected, 'row') + ' could not be read and ' + (rejected === 1 ? 'was' : 'were') + ' left out. See Data quality at the bottom for line numbers.'));
    const partial = a.buckets.filter((b) => b.partial);
    if (partial.length && a.unit !== 'day') {
      const n = noun();
      box.append(notice('info', partial.map((b) => b.short).join(' and ') + (partial.length > 1 ? ' are partial ' + n + 's' : ' is a partial ' + n) +
        ' (the selected range starts ' + fmtDay(a.from) + ' and ends ' + fmtDay(a.to) + '). Partial ' + n + 's are hatched in the charts and left out of comparisons, trends and the change figures on the tiles. ' +
        'If your export covers the whole ' + n + ', set From/To to its first and last day.'));
    }
    if (a.complete.length < 2) box.append(notice('warn', 'Fewer than two complete ' + noun() + 's in this range, so period-over-period changes are unavailable. Try a finer grouping.'));
    if (a.buckets.length > 400) box.append(notice('warn', a.buckets.length + ' periods is a lot to chart. Try a coarser grouping.'));
    if (state.status === 'success') box.append(notice('info', 'Showing successful charges only. Success rate, retries, failures and voids are hidden.'));
  }

  // ---------------------------------------------------------------------------
  // B. KPIs
  // ---------------------------------------------------------------------------
  function renderKPIs(a) {
    const T = a.totals;
    const box = clear($('kpis'));
    const na = state.status === 'success';
    const tiles = [
      { key: 'gross', hero: true, label: 'Gross revenue', value: F.money(T.gross / 100), sub: 'Successful charges, before refunds', up: true },
      { key: 'net', label: 'Net revenue', value: F.money(T.net / 100), sub: T.refundCount ? 'After ' + F.money(T.refunds / 100) + ' in ' + plural(T.refundCount, 'refund') : 'No refunds in this period', up: true },
      { key: 'count', label: 'Transactions', value: F.int(T.count), sub: na ? 'Successful charges' : 'Successful charges · ' + F.int(T.attempts) + ' attempts', up: true },
      { key: 'avg', label: 'Average transaction', value: F.money(T.avg / 100), sub: 'Gross revenue ÷ successful charges', up: true },
      { key: 'activeCustomers', label: 'Active customers', value: F.int(T.activeCustomers), sub: T.oneTimeCharges ? '+ ' + plural(T.oneTimeCharges, 'one-time manual charge') : 'With a successful charge', up: true },
      { key: 'successRate', label: 'Success rate', value: na ? 'n/a' : F.pct(T.successRate), sub: na ? 'Hidden: successful only' : F.pct(T.successRateExVoids) + ' if voids are excluded', up: true },
      { key: 'recoveryRate', label: 'Retry recovery rate', value: na ? 'n/a' : F.pct(T.recoveryRate), sub: na ? 'Hidden: successful only' : a.retry.recovered + ' of ' + a.retry.failedTotal + ' failed charges recovered', up: true },
      { key: 'voidCents', label: 'Voided amount', value: na ? 'n/a' : F.money(T.voidCents / 100), sub: na ? 'Hidden: successful only' : plural(T.voidCount, 'voided transaction'), up: false },
    ];
    tiles.forEach((tile) => {
      const card = el('div', { class: 'kpi' + (tile.hero ? ' hero' : ''), 'data-kpi': tile.key },
        el('div', { class: 'kpi-label', text: tile.label }),
        el('div', { class: 'kpi-value', text: tile.value }),
        el('div', { class: 'kpi-sub', text: tile.sub, title: tile.sub }),
        deltaNode(a, tile, na && ['successRate', 'recoveryRate', 'voidCents'].includes(tile.key)));
      box.append(card);
    });
  }

  function deltaNode(a, tile, hidden) {
    const d = el('div', { class: 'kpi-delta' });
    if (hidden) return d;
    if (!a.deltas) { d.append(el('span', { class: 'chg na', text: '—' }), el('span', { class: 'vs', text: 'needs 2 complete ' + noun() + 's' })); return d; }
    const v = a.deltas.values[tile.key];
    const vs = el('span', { class: 'vs', text: a.deltas.lastLabel + ' vs ' + a.deltas.prevLabel });
    if (!v || v.change == null) { d.append(el('span', { class: 'chg na', text: 'n/a' }), vs); return d; }
    const c = v.change;
    const flat = Math.abs(c) < 0.0005;
    const good = (c > 0) === tile.up;
    const arrow = flat ? '●' : c > 0 ? '▲' : '▼';
    const txt = v.kind === 'pp' ? F.pp(c) : F.signedPct(c);
    d.title = 'Last complete ' + noun() + ' (' + a.deltas.lastLabel + ') compared with the one before (' + a.deltas.prevLabel + ')';
    d.append(el('span', { class: 'chg ' + (flat ? 'flat' : good ? 'good' : 'bad'), text: arrow + ' ' + txt }), vs);
    return d;
  }

  // ---------------------------------------------------------------------------
  // C. Revenue over time
  // ---------------------------------------------------------------------------
  function renderRevenue(a, t) {
    const n = noun();
    $('t-revenue').textContent = 'Revenue per ' + n;
    $('s-revenue').textContent = 'Gross revenue from successful (Batched) charges · refunds are shown separately in Net revenue above';
    C.revenue(a, t, n);
    const cap = clear($('cap-revenue'));
    const c = a.complete;
    const parts = ['Each bar is one ' + n + '’s revenue; the dark line is the ' + a.rollingWindow + '-' + n + ' rolling average, which smooths out noise so the direction is easier to see.'];
    const r = a.series.rolling;
    const lastC = c[c.length - 1];
    if (lastC != null && r[lastC] != null && lastC - a.rollingWindow >= 0 && r[lastC - a.rollingWindow] != null && r[lastC - a.rollingWindow] > 0) {
      const ch = (r[lastC] - r[lastC - a.rollingWindow]) / r[lastC - a.rollingWindow];
      parts.push(' The rolling average is ');
      cap.append(...parts);
      cap.append(el('strong', { text: (ch >= 0 ? '▲ up ' : '▼ down ') + F.pct(Math.abs(ch)) }), ' over the last ' + a.rollingWindow + ' complete ' + n + 's (to ' + a.buckets[lastC].short + ').');
    } else cap.append(...parts);
    if (a.series.hi != null) cap.append(' Highest complete ' + n + ': ' + a.buckets[a.series.hi].short + ' (' + F.money(a.series.gross[a.series.hi] / 100) + '); lowest: ' + a.buckets[a.series.lo].short + ' (' + F.money(a.series.gross[a.series.lo] / 100) + ').');
    if (a.buckets.some((b) => b.partial)) cap.append(' Hatched bars (*) are partial ' + n + 's.');

    if (a.series.pop.every((x) => x == null)) C.setEmpty('pop', 'Needs at least two consecutive complete ' + n + 's.');
    else C.pop(a, t);
    const vals = a.series.pop.filter((x) => x != null);
    const up = vals.filter((x) => x > 0).length;
    $('cap-pop').textContent = 'Green bars above zero (▲) mean revenue grew compared with the ' + n + ' before; red bars below zero (▼) mean it shrank. A run of red bars is a slowdown even when the level still looks healthy. ' +
      up + ' of ' + vals.length + ' ' + n + '-to-' + n + ' comparisons were up.' + (a.buckets.some((b) => b.partial) ? ' Comparisons involving a partial ' + n + ' are skipped.' : '');
  }

  // ---------------------------------------------------------------------------
  // D. Momentum
  // ---------------------------------------------------------------------------
  function renderMomentum(a, t) {
    const n = noun(), mo = a.momentum;
    const box = $('box-slopes');
    $('s-slopes').textContent = 'Linear trend of each customer’s revenue per complete ' + n + ', from their first ' + n + ' with us (at least 4 ' + n + 's, 3 of them active)';
    const toggle = $('slopesToggle');
    if (mo.completeCount < 4) {
      C.setEmpty('slopes', 'Needs at least 4 complete ' + n + 's. Choose a longer period or a finer grouping.');
      toggle.hidden = true;
      $('cap-slopes').textContent = '';
    } else if (!mo.slopes.length) {
      C.setEmpty('slopes', 'No customer has enough history in this period yet.');
      toggle.hidden = true;
      $('cap-slopes').textContent = '';
    } else {
      const all = mo.slopes;
      const K = 15;
      let list = all;
      toggle.hidden = all.length <= K * 2;
      if (!state.slopesAll && all.length > K * 2) list = all.slice(0, K).concat(all.slice(-K));
      toggle.textContent = state.slopesAll ? 'Top & bottom ' + K : 'Show all ' + all.length;
      toggle.setAttribute('aria-pressed', String(state.slopesAll));
      C.slopes(list, t, n, box);
      const g = all.filter((x) => x.slope > 0).length, d = all.filter((x) => x.slope < 0).length;
      const worst = all[all.length - 1], best = all[0];
      const cap = clear($('cap-slopes'));
      cap.append('Bars to the right (green, ▲) are customers whose spending is growing; bars to the left (red, ▼) are shrinking. Darker means steeper. ',
        el('strong', { text: g + ' growing, ' + d + ' declining' }), ' of ' + all.length + ' customers with enough history.');
      if (worst && worst.slope < 0) cap.append(' Steepest decline: ' + worst.name + ' (' + F.signedMoney(worst.slope) + ' per ' + n + ').');
      if (best && best.slope > 0) cap.append(' Fastest growth: ' + best.name + ' (' + F.signedMoney(best.slope) + ' per ' + n + ').');
      if (!state.slopesAll && all.length > K * 2) cap.append(' Showing the ' + K + ' fastest-growing and ' + K + ' fastest-declining.');
    }
    renderAttention(a);

    // Gone quiet
    const qbox = clear($('tbl-quiet'));
    if (mo.quietSince == null) {
      $('s-quiet').textContent = '';
      qbox.append(el('p', { class: 'empty-row', text: 'Needs at least 3 complete ' + n + 's.' }));
      $('cap-quiet').textContent = '';
    } else {
      $('s-quiet').textContent = 'No successful charge in ' + mo.quietLabels.join(' or ') + ' (or since), after at least 2 charges before that · biggest accounts first';
      qbox.append(table([
        { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
        { key: 'gross', label: 'Lifetime revenue', num: true, fmt: (r) => F.money(r.gross) },
        { key: 'count', label: 'Charges', num: true },
        { key: 'lastDay', label: 'Last charge', num: true, fmt: (r) => fmtDay(r.lastDay) },
        { key: 'since', label: 'Days since', num: true, fmt: (r) => F.int(r.since) },
      ], mo.quiet, { sort: { key: 'gross', dir: -1 }, empty: 'Every recently active customer has bought in the last 2 ' + n + 's.', good: true }));
      const lost = mo.quiet.reduce((s, r) => s + r.gross, 0);
      $('cap-quiet').textContent = mo.quiet.length ? plural(mo.quiet.length, 'customer') + ' with ' + F.money(lost) + ' of revenue between them have stopped buying. A big account going silent matters more than a small one, so they’re sorted by lifetime revenue.' : '';
    }
  }

  function renderAttention(a) {
    const n = noun(), mo = a.momentum;
    const box = clear($('tbl-attention'));
    if (!mo.window) {
      $('s-attention').textContent = '';
      box.append(el('p', { class: 'empty-row', text: 'Needs at least 6 complete ' + n + 's (3 baseline + 3 recent). Choose a longer period or a finer grouping.' }));
      $('cap-attention').textContent = '';
      return;
    }
    const w = mo.window;
    const range = (arr) => arr[0] + '–' + arr[arr.length - 1];
    $('s-attention').textContent = 'Recent = average revenue per ' + n + ' in ' + range(w.recent) + '; baseline = ' + range(w.base) + '. Listed when recent is at least ' + Math.round(state.threshold * 100) + '% below baseline.';
    box.append(table([
      { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
      { key: 'baseAvg', label: 'Baseline', num: true, fmt: (r) => F.money(r.baseAvg) },
      { key: 'recentAvg', label: 'Recent', num: true, fmt: (r) => F.money(r.recentAvg) },
      { key: 'change', label: 'Change', num: true, fmt: (r) => el('span', { class: 'neg', text: '▼ ' + F.signedPct(r.change, 0) }) },
      { key: 'gap', label: 'Shortfall', num: true, fmt: (r) => F.money(r.gap) },
      { key: 'since', label: 'Days since', num: true, fmt: (r) => F.int(r.since) },
    ], mo.attention, { sort: { key: 'gap', dir: -1 }, empty: 'No customer’s recent average is ' + Math.round(state.threshold * 100) + '% or more below their baseline.', good: true }));
    const total = mo.attention.reduce((s, r) => s + r.gap, 0);
    $('cap-attention').textContent = mo.attention.length
      ? plural(mo.attention.length, 'customer') + (mo.attention.length === 1 ? ' is' : ' are') + ' spending ' + F.money(total) + ' less per ' + n + ' than their baseline, in total. Shortfall = baseline − recent, per ' + n + '. Sorted by shortfall; click a column header to re-sort.'
      : '';
  }

  // ---------------------------------------------------------------------------
  // E. Customers
  // ---------------------------------------------------------------------------
  function renderCustomers(a, t) {
    const n = noun();
    const gross = a.totals.gross;
    // Top 15
    if (!a.top15.length) C.setEmpty('top15', 'No successful charges in this period.');
    else C.hbar('top15', a.top15, t, {
      box: $('box-top15'), label: 'Gross revenue', color: t.accent, value: (x) => x.gross / 100, axis: 'Gross revenue',
      tick: (v) => F.compact(v), labelFmt: (v) => F.compact(v),
      tooltip: (x) => [' ' + F.money(x.gross / 100) + ' · ' + plural(x.count, 'charge'), ' ' + F.pct(x.gross / gross) + ' of all revenue'],
      aria: 'Horizontal bar chart of the top 15 customers by revenue',
    });
    const top15Share = a.top15.reduce((s, x) => s + x.gross, 0) / (gross || 1);
    const cap = clear($('cap-top15'));
    cap.append('These ' + a.top15.length + ' accounts bring in ', el('strong', { text: F.pct(top15Share) }), ' of revenue.');
    if (a.top15.some((x) => x.oneTime)) cap.append(' † “One-Time Manual Charge” is not a customer: it adds up unrelated cards keyed in once, so its rank is not meaningful.');

    // Pareto
    const c = a.concentration;
    const call = clear($('concCallout'));
    call.className = 'callout' + (c.risk ? ' warn' : '');
    call.append('Top 5 customers hold ', el('strong', { text: F.pct(c.top5) }), ' of revenue. ');
    if (c.risk) call.append(el('span', { class: 'flag', text: '⚠ Concentration risk' }), ': above the 25% guideline, so losing one large account would hurt.');
    else call.append(el('span', { class: 'pos', text: '✓ Below the 25% risk guideline.' }));
    if (a.pareto.length < 2) C.setEmpty('pareto', 'Needs at least two customers.');
    else C.pareto(a, t);
    $('cap-pareto').textContent = 'Read left to right: the steeper the early rise, the more revenue depends on a few accounts. Top 10 hold ' + F.pct(c.top10) + ', top 20 hold ' + F.pct(c.top20) +
      (c.n80 ? ', and ' + c.n80 + ' of ' + c.customers + ' customers make up 80% of revenue.' : '.') + (a.oneTime ? ' One-Time Manual Charge is placed last because it is not a single account.' : '');

    // Average per active bucket
    $('t-perActive').textContent = 'Average revenue per active ' + n;
    $('s-perActive').textContent = 'Top 20 · revenue ÷ ' + n + 's with at least one successful charge';
    if (!a.perActive.length) C.setEmpty('perActive', 'No successful charges in this period.');
    else C.hbar('perActive', a.perActive, t, {
      box: $('box-perActive'), label: 'Average per active ' + n, color: t.accent, value: (x) => x.avg / 100, axis: 'Average revenue per active ' + n,
      tick: (v) => F.compact(v), labelFmt: (v) => F.compact(v),
      tooltip: (x) => [' ' + F.money(x.avg / 100) + ' per active ' + n, ' Active in ' + plural(x.active, n)],
      aria: 'Horizontal bar chart of average revenue per active period, top 20 customers',
    });
    $('cap-perActive').textContent = 'Shows how big each customer is when they do buy. It divides by the ' + n + 's they were actually active, so a customer who joined late isn’t averaged over ' + n + 's before they started.' +
      (a.perActive.some((x) => x.oneTime) ? ' † One-Time Manual Charge is an aggregate, not a customer.' : '');

    // Cadence
    const cad = a.cadence;
    const tog = $('cadenceToggle');
    const LIMIT = 25;
    if (!cad.length) {
      C.setEmpty('cadence', 'No customer has 3 or more charge days in this period.');
      tog.hidden = true;
      $('s-cadence').textContent = '';
      $('cap-cadence').textContent = '';
    } else {
      let list = cad;
      if (!state.cadenceAll && cad.length > LIMIT) {
        const top = new Set(cad.slice().sort((x, y) => y.gross - x.gross).slice(0, LIMIT).map((x) => x.name));
        list = cad.filter((x) => top.has(x.name));
      }
      tog.hidden = cad.length <= LIMIT;
      tog.textContent = state.cadenceAll ? 'Top ' + LIMIT + ' by revenue' : 'Show all ' + cad.length;
      tog.setAttribute('aria-pressed', String(state.cadenceAll));
      $('s-cadence').textContent = 'Usual gap between successful charges (bars) and days since the last one (◆) · ' + (list.length < cad.length ? 'top ' + list.length + ' customers by revenue' : 'all ' + cad.length + ' customers with 3+ charge days') + ', most frequent first';
      C.cadence(list, t, $('box-cadence'));
      const gaps = cad.map((x) => x.avgGap).sort((x, y) => x - y);
      const med = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
      $('cap-cadence').textContent = 'The typical customer pays every ' + med.toFixed(1) + ' days (median). A ◆ far to the right of its bar means that customer is overdue compared with their own habit; amber ◆ = at least twice their usual gap. ' + plural(a.drifting.length, 'customer') + ' overdue in total.';
    }
    const dt = clear($('tbl-drifting'));
    dt.append(table([
      { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
      { key: 'avgGap', label: 'Usual gap', num: true, fmt: (r) => r.avgGap.toFixed(1) + ' days' },
      { key: 'since', label: 'Days since last charge', num: true, fmt: (r) => F.int(r.since) },
      { key: 'ratio', label: '× usual gap', num: true, fmt: (r) => el('span', { class: 'neg', text: r.ratio.toFixed(1) + '×' }) },
      { key: 'gross', label: 'Revenue in period', num: true, fmt: (r) => F.money(r.gross / 100) },
    ], a.drifting, { sort: { key: 'gross', dir: -1 }, empty: 'Nobody is overdue against their usual rhythm.', good: true }));
  }

  // ---------------------------------------------------------------------------
  // F. RFM
  // ---------------------------------------------------------------------------
  function renderRFM(a, t) {
    const chips = clear($('rfmChips'));
    const tbl = clear($('tbl-rfm'));
    if (!a.rfm) {
      C.setEmpty('rfmCount', 'Needs at least 4 named customers with a successful charge.');
      C.setEmpty('rfmRevenue', 'Needs at least 4 named customers with a successful charge.');
      $('cap-rfmCount').textContent = ''; $('cap-rfmRevenue').textContent = '';
      tbl.append(el('p', { class: 'empty-row', text: 'Not enough customers to segment.' }));
      return;
    }
    const segs = a.rfm.segments;
    if (state.segment && !segs.some((s) => s.name === state.segment)) state.segment = null;
    const pick = (name) => { state.segment = state.segment === name ? null : name; renderRFM(a, C.theme()); };
    C.rfmBar('rfmCount', segs, t, (s) => s.count, { axis: (v) => v, full: (v) => plural(v, 'customer'), label: (v) => String(v) }, 'Customers', pick, state.segment);
    C.rfmBar('rfmRevenue', segs, t, (s) => s.revenue, { axis: (v) => F.compact(v), full: (v) => F.money(v), label: (v) => F.compact(v) }, 'Revenue', pick, state.segment);
    const total = segs.reduce((s, x) => s + x.count, 0);
    const totalRev = segs.reduce((s, x) => s + x.revenue, 0) || 1;
    const hv = segs[0];
    $('cap-rfmCount').textContent = total + ' named customers scored on recency, frequency and spend. High-Value Regular = 10–12 points, Loyal = 7–9, At Risk = 5–6, Dormant = 3–4.';
    const cap = clear($('cap-rfmRevenue'));
    cap.append('Few customers, most of the money: High-Value Regulars are ', el('strong', { text: F.pct(hv.count / (total || 1), 0) + ' of customers' }), ' but bring in ', el('strong', { text: F.pct(hv.revenue / totalRev, 0) + ' of revenue' }), '.');

    const colors = C.segColors(t);
    const mk = (label, name, count) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.segment === name), onclick: () => pick(name) },
      name ? el('span', { class: 'seg-dot', style: 'background:' + colors[M.SEGMENTS.indexOf(name)] }) : null, label + ' (' + count + ')');
    chips.append(mk('All', null, total));
    segs.forEach((s) => chips.append(mk(s.name, s.name, s.count)));
    // "All" chip: pressed when no segment chosen; clicking it clears.
    chips.firstChild.setAttribute('aria-pressed', String(!state.segment));
    chips.firstChild.onclick = () => { state.segment = null; renderRFM(a, C.theme()); };

    const members = a.rfm.members.filter((m) => !state.segment || m.segment === state.segment);
    $('t-rfmTable').textContent = state.segment ? state.segment + ' customers' : 'All segmented customers';
    tbl.append(table([
      { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
      { key: 'segment', label: 'Segment', fmt: (r) => [el('span', { class: 'seg-dot', style: 'background:' + colors[M.SEGMENTS.indexOf(r.segment)] }), r.segment], sort: (r) => M.SEGMENTS.indexOf(r.segment) },
      { key: 'recency', label: 'Recency (days)', num: true },
      { key: 'frequency', label: 'Frequency', num: true },
      { key: 'monetary', label: 'Monetary', num: true, fmt: (r) => F.money(r.monetary) },
      { key: 'r', label: 'R', num: true },
      { key: 'f', label: 'F', num: true },
      { key: 'm', label: 'M', num: true },
      { key: 'score', label: 'Score', num: true, fmt: (r) => el('strong', { text: String(r.score) }) },
    ], members, { sort: { key: 'monetary', dir: -1 } }));
  }

  // ---------------------------------------------------------------------------
  // G. Acquisition
  // ---------------------------------------------------------------------------
  function renderAcquisition(a, t) {
    const n = noun();
    C.acquisition(a, t);
    const cum = a.acq.cumulative;
    const c = a.complete;
    const cap = clear($('cap-acq'));
    cap.append('Orange = customers making their first purchase in this export; blue = customers who had bought before. The line is the running count of unique customers: if it flattens while the bars hold steady, the base is churning sideways rather than growing. ');
    cap.append('Everyone in the first ' + n + ' counts as new, because the export has no earlier history. ');
    if (c.length >= 2) {
      const lastC = c[c.length - 1];
      const half = Math.max(1, Math.floor(c.length / 2));
      const recentNew = c.slice(-half).reduce((s, i) => s + a.acq.newC[i], 0);
      cap.append(el('strong', { text: recentNew + ' new customers' }), ' in the last ' + half + ' complete ' + n + 's; ' + cum[cum.length - 1] + ' unique customers in total; ' + (a.acq.newC[lastC] + a.acq.returning[lastC]) + ' active in ' + a.buckets[lastC].short + '.');
    }
  }

  // ---------------------------------------------------------------------------
  // H. Risk & operations
  // ---------------------------------------------------------------------------
  function renderRisk(a, t) {
    const R = a.risk;
    const hide = state.status === 'success';
    $('riskFilteredNote').hidden = !hide;
    document.querySelectorAll('[data-needs-failures]').forEach((n) => { n.hidden = hide; });
    if (!hide) {
      $('s-failCust').textContent = 'Customers with at least ' + R.MIN_TX + ' attempts (' + R.eligibleForFailure + ' qualify) · top 20 by failure rate';
      const list = R.failureByCustomer.slice(0, 20);
      if (!list.length) C.setEmpty('failCust', R.eligibleForFailure ? 'No failed charges among customers with ' + R.MIN_TX + '+ attempts. ✓' : 'No customer has ' + R.MIN_TX + ' or more attempts in this period.');
      else C.hbar('failCust', list, t, {
        box: $('box-failCust'), label: 'Failure rate', color: t.bad, value: (x) => x.rate * 100, axis: 'Failed attempts (%)', max: undefined, grace: '30%',
        tick: (v) => v + '%', labelFmt: (v, x) => v.toFixed(1) + '% · ' + x.failed + ' of ' + x.attempts,
        tooltip: (x) => ' ' + x.failed + ' failed of ' + x.attempts + ' attempts (' + F.pct(x.rate) + ')',
        aria: 'Horizontal bar chart of failure rate by customer',
      });
      $('cap-failCust').textContent = 'Threshold: only customers with ' + R.MIN_TX + ' or more charge attempts are ranked, so one failure on a two-order account doesn’t top the chart. A high rate usually means a card on file that is expired, over its limit or being declined by the bank.' +
        (list.some((x) => x.oneTime) ? ' † One-Time Manual Charge is an aggregate of unrelated cards.' : '');

      const cards = R.cardMix.filter((x) => x.attempts > 0);
      C.cardFail(cards, t);
      $('cap-cardFail').textContent = 'Shows whether one card network declines more often than the others: ' + cards.map((x) => x.card + ' ' + F.pct(x.attempts ? x.failed / x.attempts : 0)).join(', ') + '.';

      if (!R.reasons.length) { C.setEmpty('reasons', 'No failed charges in this period. ✓'); $('cap-reasons').textContent = ''; }
      else {
        C.hbar('reasons', R.reasons.map((r) => ({ name: r.reason, count: r.count, cents: r.cents })), t, {
          box: $('box-reasons'), rowH: 30, label: 'Failed charges', color: t.bad, value: (x) => x.count, axis: 'Failed charges', grace: '45%',
          tick: (v) => F.int(v), labelFmt: (v, x) => F.int(v) + ' · ' + F.compact(x.cents / 100),
          tooltip: (x) => ' ' + plural(x.count, 'failed charge') + ' worth ' + F.money(x.cents / 100),
          aria: 'Bar chart of failure reasons',
        });
        $('cap-reasons').textContent = 'Taken from the processor’s status message. “Blank status” means the export left the status empty, which the cleaning rules treat as a failed charge.';
      }

      // Retry chains
      const rt = a.retry;
      const sbox = clear($('retryStats'));
      const stat = (k, v, s) => el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), el('div', { class: 's', text: s || '' }));
      const dist = Object.keys(rt.attemptsDist).sort((x, y) => x - y).map((k) => rt.attemptsDist[k] + '× ' + k + ' attempts').join(' · ');
      const unrecCents = rt.unrecovered.reduce((s, r) => s + r.cents, 0);
      const longChains = rt.chains.filter((c) => c.days > 14).length;
      sbox.append(
        stat('Retry chains', F.int(rt.chains.length), dist || 'none'),
        stat('Recovery rate', F.pct(rt.recoveryRate), rt.recovered + ' of ' + rt.failedTotal + ' failed charges later succeeded'),
        stat('Days to success', rt.avgDays == null ? '—' : rt.avgDays.toFixed(1), 'average, first failure → success' + (longChains ? ' · ' + longChains + ' took over 14 days' : '')),
        stat('Recovered revenue', F.money(rt.recoveredCents / 100), 'counted once: only the successful row is revenue'),
        stat('Not recovered', F.int(rt.unrecovered.length), F.money(unrecCents / 100) + ' in failed charges with no matching success'),
        stat('Possibly paid another way', F.int(rt.looseRecovered), 'of those: same customer paid a different amount or card within 7 days'),
      );
      $('cap-retry').textContent = 'A chain is one or more failed attempts followed by a successful one for the same customer, amount and card type. Identical amounts on different dates without a failure in between are normal repeat orders and are not chains. “Possibly paid another way” is context only and is not included in the recovery rate.' +
        (longChains ? ' Chains that took over 14 days may be a new order for the same amount rather than a retry; the rule has no time limit, so they still count.' : '');

      // Voids
      const voids = R.voidCustomers;
      $('s-voids').textContent = plural(a.totals.voidCount, 'voided transaction') + ' totalling ' + F.money(a.totals.voidCents / 100) + ' · cancelled by an admin, never revenue';
      clear($('tbl-voids')).append(table([
        { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name, r.oneTime) },
        { key: 'count', label: 'Voids', num: true },
        { key: 'cents', label: 'Amount', num: true, fmt: (r) => F.money(r.cents / 100, 2) },
        { key: 'notes', label: 'Void comment', fmt: (r) => el('span', { class: 'dq-note', text: r.notes.join('; ') || '—' }), sort: (r) => r.notes.join(';') },
      ], voids, { sort: { key: 'cents', dir: -1 }, empty: 'No voided transactions in this period.', good: true }));
    }

    // Card mix (successful revenue — shown in both status modes)
    const mix = R.cardMix.filter((x) => x.cents > 0);
    const legend = clear($('cardLegend'));
    if (!mix.length) { C.setEmpty('cardMix', 'No successful charges.'); $('cap-cardMix').textContent = ''; return; }
    C.cardMix(mix, t);
    const tot = mix.reduce((s, x) => s + x.cents, 0);
    mix.forEach((x) => legend.append(el('div', { class: 'legend-row' },
      el('span', { class: 'sw', style: 'background:' + C.cardColor(x.card, t) }),
      el('span', { text: x.card }),
      el('span', { class: 'val', text: F.money(x.cents / 100) }),
      el('span', { class: 'pct', text: F.pct(x.cents / tot) + ' of revenue · ' + plural(x.count, 'charge') }))));
    const lead = mix[0];
    $('cap-cardMix').textContent = lead.card + ' carries ' + F.pct(lead.cents / tot) + ' of card revenue. Processing fees usually differ by network, so a shift in this mix changes what card sales cost.';
  }

  // ---------------------------------------------------------------------------
  // I. Data quality
  // ---------------------------------------------------------------------------
  function renderDQ(a) {
    const q = state.quality;
    const body = clear($('dqBody'));
    const rows = [];
    const add = (status, label, value, note, detail) => rows.push({ status, label, value, note, detail });
    const rejected = q.totalDataRows - q.parsed;
    const sampleLines = (arr, f) => arr.slice(0, 8).map(f).join('; ') + (arr.length > 8 ? '; …' : '');
    add(rejected ? 'warn' : 'ok', 'Rows parsed', F.int(q.parsed) + ' of ' + F.int(q.totalDataRows), q.blankLines ? plural(q.blankLines, 'blank line') + ' skipped' : '');
    add(q.badDate.length ? 'warn' : 'ok', 'Rows with unparseable dates', F.int(q.badDate.length), q.badDate.length ? 'Excluded. ' + sampleLines(q.badDate, (r) => 'line ' + r.line + ': “' + r.value + '”') : '');
    const fmts = Object.keys(q.dateFormats);
    add(fmts.length > 1 ? 'warn' : 'info', 'Date format', fmts.map((f) => P.DATE_FORMATS[f]).join(' + '),
      fmts.length > 1 ? 'This file mixes formats (' + fmts.map((f) => F.int(q.dateFormats[f]) + ' ' + P.DATE_FORMATS[f]).join(', ') + '). Both are unambiguous, so every row was still read correctly, but check how the export was produced.'
        : 'Detected automatically. Slash dates are always read day first (03/11/2025 = 3 November); month-first dates are rejected.');
    if (q.badAmount.length) add('warn', 'Rows with unreadable amounts', F.int(q.badAmount.length), 'Excluded. Amount must be whole cents. ' + sampleLines(q.badAmount, (r) => 'line ' + r.line + ': “' + r.value + '”'));
    if (q.shortRows.length) add('warn', 'Rows with too few fields', F.int(q.shortRows.length), 'Excluded. ' + sampleLines(q.shortRows, (r) => 'line ' + r.line + ' (' + r.got + ' fields)'));
    if (q.unknownStatus.length) add('warn', 'Unrecognised status values', F.int(q.unknownStatus.length), 'Excluded. ' + sampleLines(q.unknownStatus, (r) => 'line ' + r.line + ': “' + r.value + '”'));
    const grouped = [...state.members.values()].reduce((n, l) => n + l.length, 0);
    const pendN = pendingSuggestions().length;
    add(pendN ? 'warn' : 'info', 'Customer names grouped', grouped ? F.int(grouped) + ' → ' + F.int(state.members.size) : '0',
      (grouped ? 'Your customer groups combine ' + F.int(grouped) + ' export names into ' + plural(state.members.size, 'customer') + '. ' : '') +
      (pendN ? plural(pendN, 'suggested group') + ' waiting for review under Customer groups.' : grouped ? '' : 'Each name in the export is treated as its own customer.'));
    add('info', 'Blank customer names relabelled', F.int(q.blankCustomer), 'Shown as “One-Time Manual Charge”: cards keyed in once, treated as one aggregate pseudo-customer');
    add('info', 'Blank statuses relabelled', F.int(q.blankStatus), 'Blank status = an unsuccessful attempt → Failed');
    if (q.suffixedFailed) add('info', '“Failed – Result …” statuses', F.int(q.suffixedFailed), 'Normalised to Failed; the processor message is kept as the failure reason');
    const negTotal = q.negative.reduce((s, r) => s + r.cents, 0);
    add(q.negative.length ? 'warn' : 'ok', 'Negative amounts (refunds / credits)', F.int(q.negative.length), q.negative.length ? 'Total ' + F.money(negTotal / 100, 2) + '. Kept out of gross revenue and subtracted only in net revenue.' : '', q.negative);
    add(q.zero.length ? 'warn' : 'ok', 'Zero-amount transactions', F.int(q.zero.length), q.zero.length ? 'These should not exist. Kept and listed for review.' : '', q.zero);
    add(a.duplicates.length ? 'warn' : 'ok', 'Same-day exact duplicates', F.int(a.duplicates.length), a.duplicates.length ? 'Same customer, amount, card type and date, both successful. Not removed; check with the processor.' : 'Repeat orders for identical amounts on different dates are normal and not flagged', null, a.duplicates);
    add('info', 'Retry chains detected', F.int(a.retry.chains.length), a.retry.mixedGroups + ' customer/amount/card groups contain both a failed and a successful charge; ' + a.retry.chains.length + ' chains have a failure followed by a later success');
    const cur = Object.keys(q.currencies);
    add(cur.length > 1 ? 'warn' : 'ok', 'Currencies', cur.map((c) => c + ' (' + F.int(q.currencies[c]) + ')').join(', '), cur.length > 1 ? 'Mixed currencies are summed as-is' : '');
    add('info', 'Card types', Object.keys(q.cardTypes).map((c) => c + ' ' + F.int(q.cardTypes[c])).join(' · '), '');
    add('info', 'Columns used', Object.entries(q.columns).map(([k, v]) => v).join(', '), q.ignoredColumns + ' other columns ignored');

    const warnCount = rows.filter((r) => r.status === 'warn' && r.value !== '0').length;
    $('dqSummary').textContent = F.int(q.parsed) + ' rows read · ' + F.int(rejected) + ' rejected · ' + (warnCount ? plural(warnCount, 'item') + ' to review' : 'no issues found');

    const icon = { ok: '✓', warn: '⚠', info: 'ℹ' };
    const tbl = el('table', { class: 'data dq-table' },
      el('thead', null, el('tr', null, el('th', { text: '' }), el('th', { text: 'Check' }), el('th', { class: 'num', text: 'Count' }), el('th', { text: 'Notes' }))),
      el('tbody', null, rows.map((r) => el('tr', null,
        el('td', null, el('span', { class: 'dq-status ' + (r.status === 'warn' && r.value === '0' ? 'ok' : r.status), text: r.status === 'warn' && r.value === '0' ? icon.ok : icon[r.status], 'aria-label': r.status })),
        el('td', { text: r.label }), el('td', { class: 'num', text: r.value }), el('td', null, el('span', { class: 'dq-note', text: r.note || '' }))))));
    body.append(el('div', { class: 'table-wrap' }, tbl));

    const rowList = (title, list) => {
      if (!list || !list.length) return;
      body.append(el('h4', { text: title }));
      body.append(table([
        { key: 'line', label: 'Line', num: true },
        { key: 'day', label: 'Date', fmt: (r) => fmtDay(r.day) },
        { key: 'customer', label: 'Customer', name: true, fmt: (r) => nameCell(r.customer, r.oneTime) },
        { key: 'cents', label: 'Amount', num: true, fmt: (r) => F.money(r.cents / 100, 2) },
        { key: 'card', label: 'Card' },
        { key: 'status', label: 'Status' },
      ], list, { sort: { key: 'day', dir: 1 } }));
    };
    rowList('Negative amounts', q.negative);
    rowList('Zero amounts', q.zero);
    if (a.duplicates.length) {
      body.append(el('h4', { text: 'Same-day exact duplicates (in the selected period)' }));
      body.append(table([
        { key: 'day', label: 'Date', fmt: (r) => fmtDay(r.day) },
        { key: 'customer', label: 'Customer', name: true, fmt: (r) => nameCell(r.customer) },
        { key: 'cents', label: 'Amount', num: true, fmt: (r) => F.money(r.cents / 100, 2) },
        { key: 'card', label: 'Card' },
        { key: 'rows', label: 'Rows', num: true },
        { key: 'lines', label: 'CSV lines', fmt: (r) => r.lines.join(', ') },
      ], a.duplicates, { sort: { key: 'day', dir: 1 } }));
    }
    body.append(el('p', { class: 'dq-note', text: 'Row-level checks cover the whole file. Duplicates and retry chains reflect the selected period and status filter.' }));
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function applyPreset(p) {
    const rows = state.rows;
    const dMin = rows[0].day, dMax = rows[rows.length - 1].day;
    const t = M.ymd(dMax);
    let from = dMin;
    if (p === 'ytd') from = M.dayOf(t.y, 0, 1);
    else if (/^\d+$/.test(p)) from = M.dayOf(t.y, t.m - (+p - 1), 1);
    // Presets never reach before the first transaction; only an explicit
    // custom date can declare a partial-looking first month complete.
    state.from = Math.max(from, dMin);
    state.to = dMax;
    state.preset = p;
  }

  function bind() {
    const input = $('fileInput');
    input.addEventListener('change', () => { loadFile(input.files[0]); });
    $('dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    $('loadAnother').addEventListener('click', () => { input.value = ''; input.click(); });

    // Drag & drop anywhere on the page.
    let depth = 0;
    const overlay = $('dropOverlay');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
    document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; overlay.hidden = true;
      loadFile(e.dataTransfer.files[0]);
    });

    $('preset').addEventListener('change', (e) => { if (e.target.value === 'custom') return; applyPreset(e.target.value); render(); });
    const onDate = () => {
      let f = isoToDay($('fromDate').value), t = isoToDay($('toDate').value);
      if (f == null || t == null) return;
      f = Math.max(state.minAllowed, Math.min(f, state.maxAllowed));
      t = Math.max(state.minAllowed, Math.min(t, state.maxAllowed));
      if (f > t) [f, t] = [t, f];
      state.from = f; state.to = t; state.preset = 'custom';
      $('preset').value = 'custom';
      render();
    };
    $('fromDate').addEventListener('change', onDate);
    $('toDate').addEventListener('change', onDate);
    $('bucket').addEventListener('change', (e) => { state.unit = e.target.value; render(); });
    $('statusFilter').addEventListener('change', (e) => { state.status = e.target.value; render(); });
    $('threshold').addEventListener('change', (e) => {
      const v = Math.max(5, Math.min(95, Math.round(+e.target.value || 25)));
      e.target.value = String(v);
      state.threshold = v / 100;
      analyse();
      renderAttention(state.analysis);
    });
    $('slopesToggle').addEventListener('click', () => { state.slopesAll = !state.slopesAll; renderMomentum(state.analysis, C.theme()); });
    $('cadenceToggle').addEventListener('click', () => { state.cadenceAll = !state.cadenceAll; renderCustomers(state.analysis, C.theme()); });
    $('printBtn').addEventListener('click', () => window.print());

    // Theme changes repaint the canvases (their colours are baked in).
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    (dark.addEventListener ? dark.addEventListener.bind(dark, 'change') : dark.addListener.bind(dark))(() => { if (!printing) paint(); });

    // Print: force light theme + print width, redraw crisp canvases, restore after.
    let printing = false;
    const enter = () => {
      if (printing || !state.analysis) return;
      printing = true;
      document.documentElement.dataset.theme = 'light';
      document.body.classList.add('printing');
      $('dq').dataset.wasOpen = $('dq').open ? '1' : '';
      window.__ccPrintDPR = 2;
      paint();
      // Freeze each chart as an image so it scales cleanly to any paper width.
      Object.entries(C.registry).forEach(([id, chart]) => {
        const canvas = chart.canvas;
        const img = el('img', { class: 'print-img', alt: canvas.getAttribute('aria-label') || '', src: chart.toBase64Image('image/png', 1) });
        canvas.after(img);
        canvas.style.display = 'none';
      });
    };
    const exit = () => {
      if (!printing) return;
      printing = false;
      delete document.documentElement.dataset.theme;
      document.body.classList.remove('printing');
      window.__ccPrintDPR = 0;
      document.querySelectorAll('.print-img').forEach((n) => n.remove());
      paint();
    };
    window.addEventListener('beforeprint', enter);
    window.addEventListener('afterprint', exit);
    const pm = window.matchMedia('print');
    (pm.addEventListener ? pm.addEventListener.bind(pm, 'change') : pm.addListener.bind(pm))((e) => (e.matches ? enter() : exit()));
  }

  // ---------------------------------------------------------------------------
  // Test / automation hook (read-only summary of what is on screen).
  // ---------------------------------------------------------------------------
  window.ccDashboard = {
    get state() { return $('app').dataset.state; },
    get analysis() { return state.analysis; },
    loadText(text, name) { return loadFile(new File([text], name || 'test.csv', { type: 'text/csv' })); },
    summary() {
      const a = state.analysis;
      if (!a || a.empty) return null;
      const T = a.totals;
      return {
        unit: a.unit, autoUnit: a.autoUnit, from: M.isoDate(a.from), to: M.isoDate(a.to), spanDays: a.spanDays,
        buckets: a.buckets.map((b) => ({ start: M.isoDate(b.start), label: b.short, partial: b.partial })),
        grossByBucket: a.series.gross, gross: T.gross, refunds: T.refunds, net: T.net, count: T.count, avg: T.avg,
        attempts: T.attempts, successRate: T.successRate, successRateExVoids: T.successRateExVoids, activeCustomers: T.activeCustomers,
        recoveryRate: T.recoveryRate, failedTotal: a.retry.failedTotal, recovered: a.retry.recovered, chains: a.retry.chains.length,
        avgDaysToRecover: a.retry.avgDays, voidCents: T.voidCents, voidCount: T.voidCount,
        top5: a.concentration.top5, top10: a.concentration.top10, n80: a.concentration.n80,
        slopes: Object.fromEntries(a.momentum.slopes.map((s) => [s.name, s.slope])),
        rfmSegments: a.rfm ? Object.fromEntries(a.rfm.segments.map((s) => [s.name, s.count])) : null,
        attention: a.momentum.attention.map((x) => x.name), quiet: a.momentum.quiet.map((x) => x.name),
        duplicates: a.duplicates.length,
        groups: { namesGrouped: [...state.members.values()].reduce((n, l) => n + l.length, 0), customers: state.members.size, pending: pendingSuggestions().length, suggested: state.suggestions.map((x) => ({ name: x.name, members: x.members })) },
        quality: { parsed: state.quality.parsed, total: state.quality.totalDataRows, blankCustomer: state.quality.blankCustomer, blankStatus: state.quality.blankStatus, negative: state.quality.negative.length, zero: state.quality.zero.length, badDate: state.quality.badDate.length },
        kpiText: Array.from(document.querySelectorAll('.kpi')).map((k) => ({ key: k.dataset.kpi, value: k.querySelector('.kpi-value').textContent, delta: k.querySelector('.kpi-delta').textContent })),
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Customer groups dialog
  // ---------------------------------------------------------------------------
  const cents$ = (c) => F.money(c / 100);
  function memberRow(label, onRemove) {
    const p = state.profiles.get(label);
    const kids = p
      ? [el('span', { class: 'nm', text: label }), el('span', { class: 'num', text: cents$(p.gross) }),
        el('span', { class: 'mut', text: [...p.cards.keys()].join(', ') || '—' }),
        el('span', { class: 'mut', text: p.holders.size ? 'Cardholder: ' + [...p.holders].slice(0, 2).join(', ') : '' })]
      : [el('span', { class: 'nm', text: label }), el('span', { class: 'num mut', text: '—' }), el('span', { class: 'mut', text: 'not in this file' }), el('span')];
    kids.push(onRemove ? el('button', { type: 'button', class: 'x', title: 'Remove “' + label + '” from this group', 'aria-label': 'Remove ' + label, onclick: onRemove, text: '×' }) : el('span'));
    return el('div', { class: 'grp-member' }, kids);
  }

  function commitGroups(note) {
    saveStore();
    refreshGroups();
    if (state.rows) render();
    renderGroupsDialog();
    if (note) $('grpNote').textContent = note;
  }
  function groupAs(name, labels) {
    name = (name || '').trim().replace(/\s+/g, ' ') || labels[0];
    labels.forEach((l) => { state.groups[l] = name; });
    commitGroups('Grouped ' + labels.length + ' names as “' + name + '”.');
  }
  function groupsByName() {
    const out = new Map();
    for (const [label, g] of Object.entries(state.groups)) { if (!out.has(g)) out.set(g, []); out.get(g).push(label); }
    for (const [g, list] of out) if (list.length === 1 && list[0] === g) out.delete(g);
    return out;
  }

  function renderGroupsDialog() {
    const sug = clear($('grpSuggested')), act = clear($('grpActive')), man = clear($('grpManual'));
    if (!state.rows) {
      sug.append(el('h3', { text: 'Suggested' }), el('p', { class: 'grp-empty', text: 'Load an export to see suggestions.' }));
    } else {
      const pend = pendingSuggestions();
      sug.append(el('h3', null, 'Suggested (' + pend.length + ')', pend.length > 1 ? el('button', { type: 'button', class: 'btn small', onclick: () => {
        pend.forEach((x, i) => {
          const v = (($('grpSugName' + i) || {}).value || '').trim().replace(/\s+/g, ' ') || x.name;
          x.members.forEach((l) => { state.groups[l] = v; });
        });
        commitGroups('Grouped ' + pend.length + ' suggestions.');
      } }, 'Group all suggestions') : null));
      if (!pend.length) sug.append(el('p', { class: 'grp-empty', text: state.suggestions.length ? 'Every suggestion for this file has been grouped or dismissed.' : 'No names in this file look like the same customer on several cards.' }));
      pend.forEach((x, i) => {
        const input = el('input', { type: 'text', value: x.name, 'aria-label': 'Customer name for this group', id: 'grpSugName' + i });
        sug.append(el('div', { class: 'grp-card suggested' },
          el('div', { class: 'grp-row' }, input, el('span', { class: 'spacer' }),
            el('button', { type: 'button', class: 'btn primary small', onclick: () => groupAs(input.value, x.members) }, 'Group as one customer'),
            el('button', { type: 'button', class: 'btn small', title: 'Keep these as separate customers and stop suggesting it', onclick: () => { state.dismissed.push(sugKey(x)); commitGroups('Kept separate.'); } }, 'Not the same')),
          el('div', { class: 'grp-members' }, x.members.map((l) => memberRow(l))),
          el('ul', { class: 'grp-reasons' }, x.reasons.map((r) => el('li', { text: r })))));
      });
      if (state.dismissed.length) sug.append(el('p', { class: 'grp-empty' }, plural(state.dismissed.length, 'suggestion') + ' marked “not the same”. ',
        el('button', { type: 'button', class: 'btn small', onclick: () => { state.dismissed = []; commitGroups('Dismissed suggestions restored.'); } }, 'Show them again')));
    }

    const groups = [...groupsByName()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    act.append(el('h3', { text: 'Your groups (' + groups.length + ')' }));
    if (!groups.length) act.append(el('p', { class: 'grp-empty', text: 'No groups yet. Accept a suggestion above or pick names below.' }));
    groups.forEach(([g, labels]) => {
      const input = el('input', { type: 'text', value: g, 'aria-label': 'Rename group ' + g });
      input.addEventListener('change', () => {
        const nv = input.value.trim().replace(/\s+/g, ' ');
        if (!nv || nv === g) { input.value = g; return; }
        for (const k of Object.keys(state.groups)) if (state.groups[k] === g) state.groups[k] = nv;
        commitGroups('Renamed to “' + nv + '”.');
      });
      const inFile = labels.filter((l) => state.profiles.has(l)).length;
      act.append(el('div', { class: 'grp-card' },
        el('div', { class: 'grp-row' }, input, el('span', { class: 'spacer' }),
          el('span', { class: 'mut', text: state.rows ? inFile + ' of ' + labels.length + ' names in this file' : plural(labels.length, 'name') }),
          el('button', { type: 'button', class: 'btn small', onclick: () => { labels.forEach((l) => delete state.groups[l]); commitGroups('Ungrouped “' + g + '”.'); } }, 'Ungroup')),
        el('div', { class: 'grp-members' }, labels.sort().map((l) => memberRow(l, () => {
          delete state.groups[l];
          const left = Object.keys(state.groups).filter((k) => state.groups[k] === g);
          if (left.length === 1 && left[0] === g) delete state.groups[g];
          commitGroups('Removed “' + l + '”.');
        })))));
    });

    if (state.rows) {
      man.append(el('h3', { text: 'Group names yourself' }));
      const search = el('input', { type: 'search', placeholder: 'Filter customer names…', 'aria-label': 'Filter customer names' });
      const nameIn = el('input', { type: 'text', placeholder: 'Customer name for the group', 'aria-label': 'Name for the new group' });
      const pick = el('div', { class: 'grp-pick' });
      const labels = [...state.profiles.keys()].sort((a, b) => a.localeCompare(b));
      const boxes = new Map();
      labels.forEach((l) => {
        const p = state.profiles.get(l);
        const cb = el('input', { type: 'checkbox', value: l });
        boxes.set(l, cb);
        pick.append(el('label', null, cb, el('span', { text: l }), el('span', { class: 'num', text: cents$(p.gross) }),
          el('span', { class: 'mut', text: [...p.cards.keys()].join(', ') }), el('span', { class: 'mut', text: resolve(l) !== l ? 'in “' + resolve(l) + '”' : '' })));
      });
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        for (const [l, cb] of boxes) cb.parentElement.hidden = q && !l.toLowerCase().includes(q);
      });
      pick.addEventListener('change', () => {
        const chosen = labels.filter((l) => boxes.get(l).checked);
        if (chosen.length && !nameIn.dataset.touched) nameIn.value = chosen.slice().sort((a, b) => state.profiles.get(b).gross - state.profiles.get(a).gross)[0];
      });
      nameIn.addEventListener('input', () => { nameIn.dataset.touched = '1'; });
      man.append(el('div', { class: 'grp-row' }, search, el('span', { class: 'spacer' }), nameIn,
        el('button', { type: 'button', class: 'btn primary small', onclick: () => {
          const chosen = labels.filter((l) => boxes.get(l).checked);
          if (chosen.length < 1) { $('grpNote').textContent = 'Tick the names that belong to one customer first.'; return; }
          groupAs(nameIn.value, chosen);
        } }, 'Group selected')), pick);
    }
    $('grpNote').textContent = state.storeOk ? 'Saved in this browser only. Use “Save groups file” to keep a copy or use them on another computer.'
      : 'This browser is not allowing pages opened from disk to save settings, so groups last until the tab closes. Use “Save groups file” to keep them.';
    $('grpClear').disabled = !Object.keys(state.groups).length;
    updateGroupsBadge();
  }

  function updateGroupsBadge() {
    const b = $('groupsBadge');
    const pend = state.rows ? pendingSuggestions().length : 0;
    b.hidden = !pend && !state.members.size;
    b.className = 'badge' + (pend ? ' warn' : '');
    b.textContent = pend ? pend + ' to review' : String(state.members.size);
    b.title = pend ? plural(pend, 'suggested group') + ' to review' : plural(state.members.size, 'grouped customer') + ' in this file';
  }
  function openGroups() { renderGroupsDialog(); $('groupsDialog').showModal(); }

  function bindGroups() {
    $('groupsBtn').addEventListener('click', openGroups);
    $('groupsClose').addEventListener('click', () => $('groupsDialog').close());
    $('grpSave').addEventListener('click', () => {
      const blob = new Blob([G.toCSV(state.groups)], { type: 'text/csv' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'customer-groups.csv' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      $('grpNote').textContent = 'Saved customer-groups.csv. Keep it out of shared folders: it contains customer names.';
    });
    $('grpLoadInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const mapping = G.fromCSV(await f.text(), P.parseCSV);
        Object.assign(state.groups, mapping);
        commitGroups('Loaded ' + plural(Object.keys(mapping).length, 'name') + ' from ' + f.name + '.');
      } catch (err) { $('grpNote').textContent = err.message; }
    });
    $('grpClear').addEventListener('click', () => {
      if (!window.confirm('Remove all customer groups saved in this browser? Every export name will count as its own customer again.')) return;
      state.groups = {};
      commitGroups('All groups removed.');
    });
    C.setNameNote((name) => { const m = state.members.get(name); return m ? 'Combines: ' + m.join(' + ') : null; });
  }

  loadStore();
  bindGroups();
  bind();
})();
