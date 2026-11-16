/* app.js — wiring, filters, state and rendering of every section.
 * Data values are only ever inserted with textContent (never innerHTML). */
(function () {
  'use strict';

  const P = window.CCParse, M = window.CCMetrics, C = window.CCCharts, F = window.CCFormat, G = window.CCGroups, N = window.CCNotes, X = window.CCCombine;
  const $ = (id) => document.getElementById(id);

  const state = {
    rows: null, quality: null, fileName: '', fileSize: 0,
    // Every export loaded (the processor caps each at 90 days), parsed separately, then combined.
    files: [], coverage: null, loadWarning: '', notesReport: null,
    from: null, to: null, preset: 'all', unit: 'auto', status: 'all', threshold: 0.25,
    slopesAll: false, cadenceAll: false, segment: null, analysis: null,
    // Customer groups: { "label in export": "customer it belongs to" }, kept in this browser.
    groups: {}, dismissed: [], storeOk: true,
    mapped: null, profiles: new Map(), suggestions: [], members: new Map(),
    // Customer notes: { normalised name: {name, paysBy, cycle, status, since, sinceText, note} }, kept in this browser.
    notes: {},
    // Customer explorer: which view is showing, and the ticked customers (in tick order).
    view: 'overview', selected: [], xSort: 'revenue',
  };

  // ---------------------------------------------------------------------------
  // Customer groups: persistence (this browser only) and application
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'ccdash.customerGroups.v1';
  const NOTES_KEY = 'ccdash.customerNotes.v1';
  function loadStore() {
    try {
      const v = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (v && v.groups && typeof v.groups === 'object') { state.groups = v.groups; state.dismissed = Array.isArray(v.dismissed) ? v.dismissed : []; }
      const n = JSON.parse(window.localStorage.getItem(NOTES_KEY) || 'null');
      if (n && typeof n === 'object') state.notes = n;
    } catch (e) { state.storeOk = false; }
  }
  function saveStore() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ groups: state.groups, dismissed: state.dismissed }));
      window.localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes));
      state.storeOk = true;
    } catch (e) { state.storeOk = false; }
  }
  /** The note for a customer: under its own name, or under one of its export
   *  names (a notes file written before a group or rename still applies). */
  function noteOf(name) {
    const direct = state.notes[N.norm(name)];
    if (direct) return direct;
    for (const label of state.members.get(name) || []) {
      if (G.isManual(label)) continue;
      const n = state.notes[N.norm(label)];
      if (n) return n;
    }
    return null;
  }
  /** Notes keyed for the analysis: each grouped customer also gets a note written under an export name. */
  function effectiveNotes() {
    const out = Object.assign({}, state.notes);
    for (const name of state.members.keys()) {
      const k = N.norm(name);
      if (!out[k]) { const n = noteOf(name); if (n) out[k] = Object.assign({}, n, { name }); }
    }
    return out;
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
    state.manualAssigned = state.rows.filter((r) => r.oneTime && r.cardholder && state.groups[G.manualKey(r.cardholder)]).length;
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
    const note = oneTime ? null : noteOf(name);
    // Named customers link to the explorer, showing only that customer.
    const label = oneTime || !state.rows ? name : el('a', { href: '#', class: 'cust-link', title: 'Open ' + name + ' in the Customer explorer', onclick: (e) => { e.preventDefault(); exploreOnly(name); } }, name);
    return [label,
      oneTime ? el('span', { class: 'tag agg', title: 'Not a customer: an aggregate of unrelated cards keyed in once', text: 'aggregate †' }) : null,
      mem ? el('span', { class: 'tag grp', title: 'One customer, shown under these names in the export: ' + mem.map(G.display).join(' + '), text: mem.length > 1 ? mem.length + ' names' : 'grouped' }) : null,
      note ? el('span', { class: 'tag note', title: 'Customer note: ' + N.describe(note), text: note.status ? note.status : note.paysBy ? note.paysBy : note.cycle ? note.cycle : 'note' }) : null];
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
  /** Load one or more exports. append = add them to the files already loaded. */
  async function loadFiles(fileList, append) {
    const list = Array.from(fileList || []).filter(Boolean);
    if (!list.length) return;
    const parsedFiles = [];
    for (const file of list) {
      let text;
      try { text = await file.text(); }
      catch (e) { return failLoad(append, (list.length > 1 || append ? file.name + ': ' : '') + 'the file could not be opened by the browser.', String(e && e.message || e)); }
      try { parsedFiles.push(Object.assign(P.parseTransactions(text, { fileName: file.name }), { name: file.name, size: file.size })); }
      catch (e) { return failLoad(append, (list.length > 1 || append ? file.name + ': ' : '') + e.message, e.detail || ''); }
    }
    const files = (append ? state.files : []).concat(parsedFiles);
    const combined = X.combine(files);
    const newNames = new Set(parsedFiles.map((p) => p.name.replace(/^.*[\\/]/, '')));
    const added = append ? combined.files.filter((f) => newNames.has(f.name)).reduce((n, f) => n + f.kept, 0) : null;
    state.loadWarning = append && added === 0 ? 'The added file' + (list.length > 1 ? 's' : '') + ' contained nothing new: every row was already in the files loaded.' : '';

    Object.assign(state, {
      files, rows: combined.rows, quality: combined.quality, coverage: combined,
      fileName: files.length === 1 ? files[0].name : files.length + ' files', fileSize: files.reduce((n, f) => n + (f.size || 0), 0),
      preset: 'all', unit: 'auto', status: 'all', segment: null, slopesAll: false, cadenceAll: false,
    });
    refreshGroups();
    pruneSelection();
    const dMin = state.rows[0].day, dMax = state.rows[state.rows.length - 1].day;
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

  function failLoad(append, message, detail) {
    if (append && state.rows) {      // keep what is loaded; say what went wrong
      state.loadWarning = 'Nothing was added. ' + message + (detail ? ' ' + detail : '');
      render();
      return;
    }
    showError(message, detail);
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
    state.analysis = M.analyse(state.mapped || state.rows, { from: state.from, to: state.to, unit: state.unit, status: state.status, threshold: state.threshold, notes: effectiveNotes() });
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
    renderExplorer();
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
    $('metaFile').title = state.files.map((f) => f.name).join('\n') || state.fileName;
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

  /** One line explaining how this much history is analysed. */
  function timeframeText(a) {
    const tf = a.timeframe, mo = a.momentum;
    const days = plural(a.spanDays, 'day');
    const cmp = !a.deltas ? 'there is not yet enough history for the tiles to compare two periods'
      : a.deltas.kind === 'yoy' ? 'the tiles compare the last complete month with the same month a year earlier'
      : a.deltas.kind === 'month' ? 'the tiles compare the last complete month with the month before'
      : 'the tiles compare the ' + a.deltas.label.replace(/^Last /, 'last ').replace(' vs ', ' with the ');
    const track = tf.period === 'week' ? 'customers are tracked week by week (7-day blocks counted back from ' + fmtDay(a.to) + ')'
      : 'customers are tracked month by month' + (tf.trendMax ? ', with trends over the last 12 months and the baseline taken from the same months a year earlier' : '');
    const fresh = a.acq.newKnown ? 'a first card payment after the first ' + plural(a.acq.warmupDays, 'day') + ' counts as starting to pay by card'
      : 'it is too short to tell who started paying by card (some regulars only pay monthly)';
    const stop = a.cardStop.known ? 'customers with no card payment in the last ' + a.cardStop.days + ' days are recorded as having stopped paying by card'
      : 'it is too short to tell who stopped paying by card (that takes ' + a.cardStop.days + ' days without a card payment)';
    return (state.files.length > 1 ? 'These ' + state.files.length + ' exports cover ' : 'This export covers ') + days + ' (' + tf.label + '), so ' + cmp + '; ' + track + '; ' + fresh + '; and ' + stop + '. Charts are grouped by ' + a.unit + '.';
  }

  function renderNotices(a) {
    const box = clear($('notices'));
    box.append(notice('info', timeframeText(a)));
    if (a.notesApplied) {
      const cs = a.cardStop;
      const bits = [];
      if (cs.lost.length) bits.push(plural(cs.lost.length, 'lost customer'));
      const eft = cs.stopped.filter((r) => r.declared).length; if (eft) bits.push(eft + ' on EFT or cheque');
      const mon = Object.values(state.notes).filter((x) => x.cycle === 'monthly').length; if (mon) bits.push(mon + ' monthly');
      const sea = Object.values(state.notes).filter((x) => x.cycle === 'seasonal').length; if (sea) bits.push(sea + ' seasonal');
      const spo = Object.values(state.notes).filter((x) => x.cycle === 'sporadic' || x.cycle === 'on request' || x.paysBy === 'mixed').length; if (spo) bits.push(spo + ' with no regular rhythm');
      box.append(notice('info', 'Customer notes apply to ' + plural(a.notesApplied, 'customer') + ' in this file' + (bits.length ? ' (' + bits.join(', ') + ')' : '') + '. Lists that need a rhythm or a baseline leave out customers the notes say have none.',
        { label: 'Customer notes', onclick: openNotes }));
    } else if (Object.keys(state.notes).length) {
      box.append(notice('info', plural(Object.keys(state.notes).length, 'customer note') + ' loaded, but none match a customer name in this file (names are matched after customer groups).', { label: 'Customer notes', onclick: openNotes }));
    }
    const q = state.quality;
    const pend = pendingSuggestions();
    if (pend.length) {
      const eg = pend.slice(0, 3).map((x) => x.name + ' ×' + x.members.length).join(', ');
      box.append(notice('info', plural(pend.length, 'set') + ' of customer names look like one customer on several cards (' + eg + (pend.length > 3 ? ', …' : '') + '). Until they are grouped, each name counts as a separate customer.',
        { label: 'Review customer groups', onclick: openGroups }));
    }
    if (state.loadWarning) box.append(notice('warn', state.loadWarning));
    if (state.notesReport && state.notesReport.ignored.length) box.append(notice('warn', 'Customer notes: ' + plural(state.notesReport.ignored.length, 'value') + ' in ' + state.notesReport.file + ' could not be read and ' + (state.notesReport.ignored.length === 1 ? 'was' : 'were') + ' skipped (' + state.notesReport.ignored.slice(0, 2).join('; ') + (state.notesReport.ignored.length > 2 ? '; …' : '') + ').', { label: 'Customer notes', onclick: openNotes }));
    const cov = state.coverage;
    if (cov && cov.files.length > 1) {
      const dup = cov.files.reduce((n, f) => n + f.duplicates, 0);
      box.append(notice('info', plural(cov.files.length, 'file') + ' combined: ' + cov.files.map((f) => f.name + ' (' + (f.from == null ? 'empty' : fmtDay(f.from) + ' – ' + fmtDay(f.to)) + ', ' + F.int(f.rows) + ' rows)').join('; ') + '. ' +
        (dup ? F.int(dup) + ' rows appeared in more than one file and were counted once.' : 'No file repeats another.')));
      cov.overlaps.filter((o) => !o.ok).forEach((o) => box.append(notice('warn', o.a + ' and ' + o.b + ' both cover ' + fmtDay(o.from) + ' – ' + fmtDay(o.to) + ', but only ' + o.matched + ' of their rows match (' + o.rowsA + ' and ' + o.rowsB + ' rows on those days). They may be different kinds of export or use different time zones, so those days may be counted twice. Check both files are for the same account.')));
    }
    if (cov) {
      const gaps = cov.gaps.filter((g) => g.before > a.from && g.after < a.to);
      if (gaps.length) {
        const nd = a.buckets.filter((b) => b.noData).map((b) => b.short);
        box.append(notice('warn', 'No transactions at all ' + gaps.map((g) => 'between ' + fmtDay(g.after) + ' and ' + fmtDay(g.before) + ' (' + plural(g.empty, 'day') + ')').join('; ') +
          '. That stretch is missing from the files loaded, so it is treated as unknown, not as zero: those days don’t count towards the 60-day rule or anyone’s usual gap' +
          (nd.length ? ', and ' + nd.join(', ') + ' ' + (nd.length > 1 ? 'are' : 'is') + ' shown as “No data” and left out of trends, comparisons and yearly totals' : '') +
          '. If the export for those dates turns up, add it.', { label: 'Add files…', onclick: () => $('addInput').click() }));
      }
    }
    const cur = Object.keys(q.currencies);
    if (cur.length > 1) box.append(notice('warn', 'The data mixes currencies (' + cur.map((c) => c + ': ' + q.currencies[c]).join(', ') + '). Amounts are added together as-is, so totals mix currencies. Filter the export to one currency for accurate figures.'));
    const rejected = q.totalDataRows - q.parsed;
    if (rejected) box.append(notice('warn', plural(rejected, 'row') + ' could not be read and ' + (rejected === 1 ? 'was' : 'were') + ' left out. See Data quality at the bottom for line numbers.'));
    const partial = a.buckets.filter((b) => b.partial);
    if (partial.length && a.unit !== 'day') {
      const n = noun();
      box.append(notice('info', partial.map((b) => b.short).join(' and ') + (partial.length > 1 ? ' are partial ' + n + 's' : ' is a partial ' + n) +
        ' (the selected range starts ' + fmtDay(a.from) + ' and ends ' + fmtDay(a.to) + '). ' + (partial.length > 1 ? 'They are' : 'It is') + ' hatched in the charts and skipped in the % change chart' +
        (a.timeframe.period === 'week' ? '; the tiles and customer tracking use complete 7-day blocks, so they are not affected.' : '; the tiles and customer tracking use complete months only.') +
        (n === 'month' || n === 'quarter' ? ' If your export covers the whole ' + n + ', set From/To to its first and last day.' : '')));
    }
    if (a.buckets.length > 400) box.append(notice('warn', a.buckets.length + ' periods is a lot to chart. Try a coarser grouping.'));
    if (state.status === 'success') box.append(notice('info', 'Showing successful charges only. Success rate, retries, failures and voids are hidden.'));
  }

  // ---------------------------------------------------------------------------
  // B. KPIs
  // ---------------------------------------------------------------------------
  function renderKPIs(a, box) {
    const T = a.totals;
    box = clear(box || $('kpis'));
    const na = state.status === 'success';
    const tiles = [
      { key: 'gross', hero: true, label: 'Gross revenue', value: F.money(T.gross / 100), up: true,
        sub: 'Before refunds · ≈ ' + (a.timeframe.period === 'week' ? F.money(a.runRate.perWeek / 100) + ' per week' : F.money(a.runRate.perMonth / 100) + ' per month') },
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
    if (!a.deltas) { d.append(el('span', { class: 'chg na', text: '—' }), el('span', { class: 'vs', text: 'not enough history to compare' })); return d; }
    const v = a.deltas.values[tile.key];
    const vs = el('span', { class: 'vs', text: a.deltas.label });
    if (!v || v.change == null) { d.append(el('span', { class: 'chg na', text: 'n/a' }), vs); return d; }
    const c = v.change;
    const flat = Math.abs(c) < 0.0005;
    const good = (c > 0) === tile.up;
    const arrow = flat ? '●' : c > 0 ? '▲' : '▼';
    const txt = v.kind === 'pp' ? F.pp(c) : F.signedPct(c);
    d.title = a.deltas.title;
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
    if (a.buckets.some((b) => b.noData)) cap.append(' Shaded “No data” ' + n + 's are missing from the files loaded, not $0.');

    const against = a.popLag === 7 ? 'the same weekday a week earlier' : a.popLag === 12 ? 'the same month a year earlier' : a.popLag === 4 ? 'the same quarter a year earlier' : 'the ' + n + ' before';
    $('t-pop').textContent = 'Change vs ' + against;
    $('s-pop').textContent = 'Percent change in revenue for each ' + n + ' compared with ' + against;
    if (a.series.pop.every((x) => x == null)) C.setEmpty('pop', 'Not enough history yet to compare each ' + n + ' with ' + against + '.');
    else C.pop(a, t);
    const vals = a.series.pop.filter((x) => x != null);
    const up = vals.filter((x) => x > 0).length;
    const why = a.popLag === 7 ? ' Each day is compared with the same weekday, because a quiet Sunday would otherwise look like a collapse.'
      : a.popLag === 12 || a.popLag === 4 ? ' With more than a year of data the comparison is year on year, so a seasonal summer peak or January dip doesn’t look like growth or a slowdown.' : '';
    $('cap-pop').textContent = 'Green bars above zero (▲) mean revenue grew compared with ' + against + '; red bars below zero (▼) mean it shrank. A run of red bars is a slowdown even when the level still looks healthy.' + why + ' ' +
      up + ' of ' + vals.length + ' comparisons were up.' + (a.buckets.some((b) => b.partial) ? ' Comparisons involving a partial ' + n + ' are skipped.' : '');
    renderYoY(a, t);
  }

  /** Year over year: only for exports covering more than a year. */
  function renderYoY(a, t) {
    const card = $('card-yoy');
    card.hidden = !a.yoy;
    if (!a.yoy) { C.destroy('yoy'); return; }
    C.yoy(a, t);
    const tbl = clear($('tbl-yoy'));
    const years = a.yoy.years;
    tbl.append(table([
      { key: 'year', label: 'Year', fmt: (r) => String(r.year) },
      { key: 'total', label: 'Revenue', num: true, fmt: (r) => r.complete ? F.money(r.total / 100) : 'partial year', sort: (r) => r.total || 0 },
      { key: 'change', label: 'vs previous year', num: true, fmt: (r) => r.change == null ? '—' : el('span', { class: r.change >= 0 ? 'pos' : 'neg', text: (r.change >= 0 ? '▲ ' : '▼ ') + F.signedPct(r.change) }), sort: (r) => r.change == null ? -Infinity : r.change },
    ], years.slice().reverse(), {}));
    const y = a.yoy.ytd;
    const cap = clear($('cap-yoy'));
    cap.append('Each line is one calendar year, so the same month can be compared across years and seasonal patterns stand out. Partial months at the start or end of the export' + (a.buckets.some((b) => b.noData) ? ', and months with no data,' : '') + ' are left out, so a year with any of them has no full-year total. ');
    if (y && y.change != null) {
      const span = y.months.length === 12 ? 'Full year ' + y.year : y.year + ' to date (' + y.months[0] + '–' + y.months[y.months.length - 1] + ')';
      cap.append(el('strong', { text: span + ': ' + F.money(y.cur / 100) + ', ' + (y.change >= 0 ? '▲ ' : '▼ ') + F.signedPct(y.change) }), ' vs the same months of ' + y.prevYear + ' (' + F.money(y.prev / 100) + ').');
    }
  }

  // ---------------------------------------------------------------------------
  // D. Momentum
  // ---------------------------------------------------------------------------
  function renderMomentum(a, t) {
    const mo = a.momentum, n = mo.periodNoun;
    const box = $('box-slopes');
    $('s-slopes').textContent = 'Linear trend of each customer’s revenue per ' + n + (mo.trendFrom ? ', ' + mo.trendFrom + ' to ' + mo.trendTo : '') + ', from their first ' + n + ' with us (at least ' + mo.needTrend + ' ' + n + 's with purchases in most of them)';
    const toggle = $('slopesToggle');
    if (mo.periods < mo.needTrend) {
      C.setEmpty('slopes', 'Needs at least ' + mo.needTrend + ' full ' + n + 's of data; this export has ' + mo.periods + '. Load a longer export to see customer trends.');
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
      cap.append(' Customers who stopped paying by card are left out, and ' + n + 's a customer spent entirely off card (a break of ' + a.cardStop.days + '+ days between card payments) are skipped rather than counted as $0.');
    }
    renderAttention(a);
    renderCardStop(a);
  }

  /** Stopped paying by card: 60+ days since the last card payment. A record of
   *  when card payments ended (presumed moved to EFT or another method), not a
   *  churn alarm. Customers back on card after a break are summarised below. */
  function renderCardStop(a) {
    const cs = a.cardStop;
    const box = clear($('tbl-stopped'));
    const cap = clear($('cap-stopped'));
    if (!cs.known) {
      $('s-stopped').textContent = '';
      box.append(el('p', { class: 'empty-row', text: 'Needs more than ' + cs.days + ' days of data; this export covers ' + plural(a.spanDays, 'day') + '. Customers who are late against their usual rhythm are listed under Overdue against their own rhythm.' }));
      return;
    }
    $('s-stopped').textContent = 'No successful card payment in the last ' + cs.days + ' days (since ' + fmtDay(cs.since) + '; 3 months for monthly payers), or a note saying they pay by EFT or cheque now. “Stopped as of” is their last card payment · biggest accounts first';
    const known = cs.stopped.filter((r) => r.declared).length;
    box.append(table([
      { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
      { key: 'lastDay', label: 'Stopped as of', num: true, fmt: (r) => fmtDay(r.lastDay) },
      { key: 'gross', label: 'Card revenue', num: true, fmt: (r) => F.money(r.gross) },
      { key: 'since', label: 'Days since', num: true, fmt: (r) => F.int(r.since) },
      { key: 'why', label: 'Why', fmt: (r) => el('span', { class: 'why', text: r.why || 'presumed switched' }), sort: (r) => r.why || '' },
    ], cs.stopped, { sort: { key: 'gross', dir: -1 }, empty: 'Every customer in this range has paid by card in the last ' + cs.days + ' days.', good: true }));
    if (cs.stopped.length) {
      const tot = cs.stopped.reduce((x, r) => x + r.gross, 0);
      cap.append(plural(cs.stopped.length, 'customer') + ' (' + F.money(tot) + ' of card revenue in this range) stopped paying by card' + (known ? ', ' + known + ' of them confirmed by your notes' : '') +
        '. A gap of ' + cs.days + '+ days almost always means the account moved to EFT or another payment method, occasionally that it stopped trading, so treat this as a record of when card payments ended rather than lost sales. Customers you know have stopped ordering belong in Customer notes, which moves them to Lost customers below. These customers are left out of the trend chart, Needs attention and Payment cadence. ');
    }
    if (cs.seasonal.length) {
      cap.append(el('strong', { text: plural(cs.seasonal.length, 'seasonal customer') + ' off season' }), ' (no card payment for ' + cs.days + '+ days, not counted as stopped): ' + cs.seasonal.map((r) => r.name + ' (last ' + fmtDay(r.lastDay) + ')').join('; ') + '. ');
    }
    if (cs.back.length) {
      const eg = cs.back.slice(0, 4).map((r) => r.name + ' (off card ' + fmtDay(r.offFrom) + ' – ' + fmtDay(r.backOn) + ')');
      cap.append(el('strong', { text: plural(cs.back.length, 'customer') + ' came back to card after a break of ' + cs.days + '+ days' }),
        ': ' + eg.join('; ') + (cs.back.length > 4 ? '; and ' + (cs.back.length - 4) + ' more' : '') + '. The time they spent off card is skipped in their trend and Needs attention rather than counted as a slump.');
    }
    renderLost(a);
  }

  /** Lost customers: only ever from the notes file (status stopped ordering / closed). */
  function renderLost(a) {
    const cs = a.cardStop;
    const box = clear($('tbl-lost'));
    const cap = clear($('cap-lost'));
    const anyNotes = Object.keys(state.notes).length > 0;
    box.append(table([
      { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
      { key: 'status', label: 'Status', fmt: (r) => r.status },
      { key: 'since', label: 'Since', num: true, fmt: (r) => r.sinceText || '—', sort: (r) => r.since == null ? -Infinity : r.since },
      { key: 'lastDay', label: 'Last card payment', num: true, fmt: (r) => [fmtDay(r.lastDay), r.paidAfter ? el('span', { class: 'status-pill warn', style: 'margin-left:6px', title: 'Your note says ' + r.status + ' since ' + r.sinceText + ', but this card payment came after that. Check the date or the status.', text: 'after “since”' }) : null] },
      { key: 'gross', label: 'Card revenue in range', num: true, fmt: (r) => F.money(r.gross) },
      { key: 'count', label: 'Payments', num: true },
      { key: 'note', label: 'Note', fmt: (r) => el('span', { class: 'why', text: r.note || '' }) },
    ], cs.lost, { sort: { key: 'gross', dir: -1 }, empty: anyNotes ? 'No customer in this range is marked stopped ordering or closed in your notes.' : 'No customer notes loaded. Use Customer notes (top right) to record who stopped ordering, who pays by EFT or cheque, and who pays monthly or seasonally.', good: anyNotes }));
    if (cs.lost.length) {
      const tot = cs.lost.reduce((x, r) => x + r.gross, 0);
      const odd = cs.lost.filter((r) => r.paidAfter);
      cap.textContent = plural(cs.lost.length, 'customer') + ' with ' + F.money(tot) + ' of card revenue in this range. They are left out of every other customer list; their history still counts in totals and rankings.' +
        (odd.length ? ' ' + odd.map((r) => r.name).join(', ') + (odd.length > 1 ? ' paid' : ' paid') + ' by card after the “since” date in your notes: check the date or the status.' : '');
    }
  }

  function renderAttention(a) {
    const mo = a.momentum, n = mo.periodNoun;
    const box = clear($('tbl-attention'));
    if (!mo.window) {
      $('s-attention').textContent = '';
      box.append(el('p', { class: 'empty-row', text: 'Needs at least 2 full ' + n + 's of data to compare recent spending with a baseline.' }));
      $('cap-attention').textContent = '';
      return;
    }
    const w = mo.window;
    $('s-attention').textContent = 'Recent = average revenue per ' + n + ' in ' + w.recent + '; baseline = ' + w.base + (w.kind === 'yoy' ? ' (the same months a year earlier, so seasonal swings don’t count)' : '') +
      '. Listed when recent is at least ' + Math.round(state.threshold * 100) + '% below baseline.';
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
      ? plural(mo.attention.length, 'customer') + (mo.attention.length === 1 ? ' is' : ' are') + ' spending ' + F.money(total) + ' less per ' + n + ' than their baseline, in total. Shortfall = baseline − recent, per ' + n + '. Sorted by shortfall; click a column header to re-sort.' +
        (w.recentN === 1 && n === 'week' ? ' With only a few weeks of data one late order is enough to appear here; check Days since before calling.' : '') +
        ' Customers who stopped paying by card, lost customers and customers with no regular rhythm (sporadic, on request, mixed payment) are not listed here, and ' + n + 's spent entirely off card are left out of both averages.' +
        (mo.monthlySkipped ? ' ' + plural(mo.monthlySkipped, 'monthly payer') + ' from your notes ' + (mo.monthlySkipped === 1 ? 'is' : 'are') + ' only compared month to month, so not on a weekly export.' : '')
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
    const an = a.perActiveNoun;
    $('t-perActive').textContent = 'Average revenue per active ' + an;
    $('s-perActive').textContent = 'Top 20 · revenue ÷ ' + an + 's with at least one successful charge';
    if (!a.perActive.length) C.setEmpty('perActive', 'No successful charges in this period.');
    else C.hbar('perActive', a.perActive, t, {
      box: $('box-perActive'), label: 'Average per active ' + an, color: t.accent, value: (x) => x.avg / 100, axis: 'Average revenue per active ' + an,
      tick: (v) => F.compact(v), labelFmt: (v) => F.compact(v),
      tooltip: (x) => [' ' + F.money(x.avg / 100) + ' per active ' + an, ' Active in ' + plural(x.active, an)],
      aria: 'Horizontal bar chart of average revenue per active period, top 20 customers',
    });
    $('cap-perActive').textContent = 'Shows how big each customer is when they do buy. It divides by the ' + an + 's they were actually active, so a customer who joined late isn’t averaged over ' + an + 's before they started.' +
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
      $('cap-cadence').textContent = 'The typical customer pays every ' + med.toFixed(1) + ' days (median). A ◆ far to the right of its bar means that customer is overdue compared with their own habit; amber ◆ = at least twice their usual gap. ' + plural(a.drifting.length, 'customer') + ' overdue in total. Only customers still paying by card with a regular rhythm are shown; breaks of ' + a.cardStop.days + '+ days are left out of the usual gap, and a cycle from your notes (weekly, monthly) replaces the measured gap.';
    }
    const dt = clear($('tbl-drifting'));
    dt.append(table([
      { key: 'name', label: 'Customer', name: true, fmt: (r) => nameCell(r.name) },
      { key: 'avgGap', label: 'Usual gap', num: true, fmt: (r) => r.avgGap.toFixed(1) + ' days' + (r.declared ? ' (' + r.declared + ')' : '') },
      { key: 'since', label: 'Days since last charge', num: true, fmt: (r) => F.int(r.since) },
      { key: 'ratio', label: '× usual gap', num: true, fmt: (r) => el('span', { class: 'neg', text: r.ratio.toFixed(1) + '×' }) },
      { key: 'gross', label: 'Revenue in period', num: true, fmt: (r) => F.money(r.gross / 100) },
    ], a.drifting, { sort: { key: 'gross', dir: -1 }, empty: 'Nobody is overdue against their usual rhythm.', good: true }));
    $('cap-drifting').textContent = a.drifting.length ? 'These customers still count as card payers (under ' + a.cardStop.days + ' days since their last card payment) but are late against their own habit, so this is the list worth a call. At ' + a.cardStop.days + ' days they move to Stopped paying by card.' : '';
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
    const totalNew = a.acq.newC.reduce((x, y) => x + y, 0);
    if (!a.acq.newKnown) {
      cap.append('Bars show customers with a successful charge in each ' + n + '; the line is the running count of unique customers. ');
      cap.append(el('strong', { text: 'A few weeks of data can’t show who started paying by card' }), ': most customers pay every 1–2 weeks but some only monthly, so a regular can appear for the first time late in a short export. Load at least two months to see this. ');
      cap.append(cum[cum.length - 1] + ' unique customers in total.');
    } else {
      cap.append('Orange = customers making their first card payment of this export; blue = customers who had already paid by card in it. The line is the running count of unique card-paying customers. ');
      cap.append('An export starts part-way through every relationship, so the ' + plural(a.acq.existingAtStart, 'customer') + ' first seen in the first ' + plural(a.acq.warmupDays, 'day') +
        ' count as already paying by card. A first card payment after that is not necessarily a new customer: it can be an existing account moving from EFT to card, or coming back after a break, which one export cannot tell apart. ');
      cap.append(el('strong', { text: plural(totalNew, 'customer') + ' started paying by card' }), ' in this export; ' + cum[cum.length - 1] + ' unique card-paying customers in total.');
    }
    if (c.length) { const lastC = c[c.length - 1]; cap.append(' ' + (a.acq.newC[lastC] + a.acq.returning[lastC]) + ' active in ' + a.buckets[lastC].short + '.'); }
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
    if (q.files > 1) add('ok', 'Rows repeated across files', F.int(q.repeatedAcrossFiles), 'From ' + plural(q.files, 'file') + '. The same transaction in two overlapping exports (same day, minute, customer, amount, card and status) is counted once.');
    add(q.badDate.length ? 'warn' : 'ok', 'Rows with unparseable dates', F.int(q.badDate.length), q.badDate.length ? 'Excluded. ' + sampleLines(q.badDate, (r) => X.where(r) + ': “' + r.value + '”') : '');
    const fmts = Object.keys(q.dateFormats);
    add(fmts.length > 1 ? 'warn' : 'info', 'Date format', fmts.map((f) => P.DATE_FORMATS[f]).join(' + '),
      fmts.length > 1 ? 'This file mixes formats (' + fmts.map((f) => F.int(q.dateFormats[f]) + ' ' + P.DATE_FORMATS[f]).join(', ') + '). Both are unambiguous, so every row was still read correctly, but check how the export was produced.'
        : 'Detected automatically. Slash dates are always read day first (03/11/2025 = 3 November); month-first dates are rejected.');
    if (q.badAmount.length) add('warn', 'Rows with unreadable amounts', F.int(q.badAmount.length), 'Excluded. Amount must be whole cents. ' + sampleLines(q.badAmount, (r) => X.where(r) + ': “' + r.value + '”'));
    if (q.shortRows.length) add('warn', 'Rows with too few fields', F.int(q.shortRows.length), 'Excluded. ' + sampleLines(q.shortRows, (r) => X.where(r) + ' (' + r.got + ' fields)'));
    if (q.unknownStatus.length) add('warn', 'Unrecognised status values', F.int(q.unknownStatus.length), 'Excluded. ' + sampleLines(q.unknownStatus, (r) => X.where(r) + ': “' + r.value + '”'));
    const grouped = [...state.members.values()].reduce((n, l) => n + l.length, 0);
    const pendN = pendingSuggestions().length;
    add(pendN ? 'warn' : 'info', 'Customer names grouped', grouped ? F.int(grouped) + ' → ' + F.int(state.members.size) : '0',
      (grouped ? 'Your customer groups combine ' + F.int(grouped) + ' export names into ' + plural(state.members.size, 'customer') + '. ' : '') +
      (pendN ? plural(pendN, 'suggested group') + ' waiting for review under Customer groups.' : grouped ? '' : 'Each name in the export is treated as its own customer.'));
    add('info', 'Blank customer names relabelled', F.int(q.blankCustomer), 'Shown as “One-Time Manual Charge”: cards keyed in once, treated as one aggregate pseudo-customer' +
      (state.manualAssigned ? '. ' + F.int(state.manualAssigned) + ' of them belong to a customer through your customer groups (matched by cardholder) and are counted there instead' : ''));
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
        { key: 'line', label: 'Line', num: true, fmt: (r) => (r.src ? r.src + ' · ' + r.line : r.line) },
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
    input.addEventListener('change', () => { loadFiles(input.files, false); });
    $('addInput').addEventListener('change', (e) => { loadFiles(Array.from(e.target.files), true); e.target.value = ''; });
    $('addFiles').addEventListener('click', () => $('addInput').click());
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
      // Dropping onto a loaded dashboard adds to it; on the start page it starts fresh.
      loadFiles(e.dataTransfer.files, !!state.rows && !$('dashboard').hidden);
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

    // Light / Dark switch. Light is the default; the choice is remembered in this browser.
    $('themeSwitch').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-theme-value]');
      if (!b || printing) return;
      applyTheme(b.dataset.themeValue, true);
      if (state.analysis && !state.analysis.empty) { paint(); renderExplorer(); }
    });
    $('themeSwitch').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      applyTheme(theme === 'dark' ? 'light' : 'dark', true);
      $('themeSwitch').querySelector('[aria-checked="true"]').focus();
      if (state.analysis && !state.analysis.empty) { paint(); renderExplorer(); }
    });

    // Tabs: Overview / Customer explorer.
    $('tab-overview').addEventListener('click', () => showView('overview'));
    $('tab-explorer').addEventListener('click', () => showView('explorer'));
    document.querySelector('.tabs').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      showView(state.view === 'overview' ? 'explorer' : 'overview');
      $('tab-' + state.view).focus();
    });
    bindExplorer();

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
      renderExplorer();
      if (state.view === 'explorer' && state.selected.length) $('printSummary').textContent += ' · Customer explorer: ' + state.selected.join(', ');
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
      applyTheme(theme, false);
      document.body.classList.remove('printing');
      window.__ccPrintDPR = 0;
      document.querySelectorAll('.print-img').forEach((n) => n.remove());
      paint();
      renderExplorer();
      if (state.analysis && !state.analysis.empty) renderMeta(state.analysis);
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
    loadText(text, name) { return loadFiles([new File([text], name || 'test.csv', { type: 'text/csv' })], false); },
    summary() {
      const a = state.analysis;
      if (!a || a.empty) return null;
      const T = a.totals;
      return {
        unit: a.unit, autoUnit: a.autoUnit, from: M.isoDate(a.from), to: M.isoDate(a.to), spanDays: a.spanDays,
        buckets: a.buckets.map((b) => ({ start: M.isoDate(b.start), label: b.short, partial: b.partial, noData: !!b.noData })),
        missing: a.missing.map((m) => [M.isoDate(m.from), M.isoDate(m.to)]), noDataPeriods: a.momentum.noData,
        grossByBucket: a.series.gross, gross: T.gross, refunds: T.refunds, net: T.net, count: T.count, avg: T.avg,
        attempts: T.attempts, successRate: T.successRate, successRateExVoids: T.successRateExVoids, activeCustomers: T.activeCustomers,
        recoveryRate: T.recoveryRate, failedTotal: a.retry.failedTotal, recovered: a.retry.recovered, chains: a.retry.chains.length,
        avgDaysToRecover: a.retry.avgDays, voidCents: T.voidCents, voidCount: T.voidCount,
        top5: a.concentration.top5, top10: a.concentration.top10, n80: a.concentration.n80,
        slopes: Object.fromEntries(a.momentum.slopes.map((s) => [s.name, s.slope])),
        rfmSegments: a.rfm ? Object.fromEntries(a.rfm.segments.map((s) => [s.name, s.count])) : null,
        attention: a.momentum.attention.map((x) => x.name), threshold: a.threshold,
        stopped: a.cardStop.stopped.map((x) => ({ name: x.name, lastDay: M.isoDate(x.lastDay), gross: x.gross, declared: !!x.declared })),
        lost: a.cardStop.lost.map((x) => ({ name: x.name, status: x.status, since: x.sinceText || '', paidAfter: x.paidAfter == null ? null : M.isoDate(x.paidAfter) })),
        notesRead: state.notesReport ? { interpreted: state.notesReport.interpreted.length, ignored: state.notesReport.ignored.length } : null, seasonalOff: a.cardStop.seasonal.map((x) => x.name),
        notes: { loaded: Object.keys(state.notes).length, applied: a.notesApplied, monthlySkipped: a.momentum.monthlySkipped },
        theme: document.documentElement.dataset.theme || 'light', view: state.view,
        coverage: state.coverage ? { files: state.coverage.files.map((f) => ({ name: f.name, from: f.from == null ? null : M.isoDate(f.from), to: f.to == null ? null : M.isoDate(f.to), rows: f.rows, kept: f.kept })),
          overlapsOk: state.coverage.overlaps.every((o) => o.ok), gaps: state.coverage.gaps.map((g) => [M.isoDate(g.after), M.isoDate(g.before)]) } : null,
        explorer: { selected: state.selected.slice(), gross: state.explorer && !state.explorer.empty && state.selected.length ? state.explorer.totals.gross : null,
          count: state.explorer && !state.explorer.empty && state.selected.length ? state.explorer.totals.count : null,
          failed: state.explorer && !state.explorer.empty && state.selected.length ? state.explorer.retry.failedTotal : null },
        backOnCard: a.cardStop.back.map((x) => ({ name: x.name, offFrom: M.isoDate(x.offFrom), backOn: M.isoDate(x.backOn) })),
        late: a.drifting.map((x) => x.name), cadence: Object.fromEntries(a.cadence.map((x) => [x.name, x.avgGap])),
        attentionDetail: a.momentum.attention.map((x) => ({ name: x.name, baseAvg: x.baseAvg, recentAvg: x.recentAvg })),
        duplicates: a.duplicates.length,
        timeframe: a.timeframe.key, popLag: a.popLag, trackedBy: a.momentum.periodNoun, trackingPeriods: a.momentum.periods,
        compare: a.deltas ? { kind: a.deltas.kind, label: a.deltas.label, a: a.deltas.a.map(M.isoDate), b: a.deltas.b.map(M.isoDate), cur: a.deltas.values.gross.cur, prev: a.deltas.values.gross.prev } : null,
        attentionWindow: a.momentum.window || null, stoppedCount: a.cardStop.stopped.length, startedByCard: a.acq.newC.reduce((x, y) => x + y, 0),
        yoy: a.yoy ? a.yoy.years.map((y) => ({ year: y.year, total: y.total, months: y.months })) : null,
        groups: { namesGrouped: [...state.members.values()].reduce((n, l) => n + l.length, 0), customers: state.members.size, pending: pendingSuggestions().length, suggested: state.suggestions.map((x) => ({ name: x.name, members: x.members.map(G.display) })), manualAssigned: state.manualAssigned || 0 },
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
      ? [el('span', { class: 'nm', text: G.display(label) }), el('span', { class: 'num', text: cents$(p.gross) }),
        el('span', { class: 'mut', text: [...p.cards.keys()].join(', ') || '—' }),
        el('span', { class: 'mut', text: p.manual ? plural(p.rows, 'charge') + ' keyed in with no customer name' : p.holders.size ? 'Cardholder: ' + [...p.holders].slice(0, 2).join(', ') : '' })]
      : [el('span', { class: 'nm', text: G.display(label) }), el('span', { class: 'num mut', text: '—' }), el('span', { class: 'mut', text: 'not in this file' }), el('span')];
    kids.push(onRemove ? el('button', { type: 'button', class: 'x', title: 'Remove “' + G.display(label) + '” from this group', 'aria-label': 'Remove ' + G.display(label), onclick: onRemove, text: '×' }) : el('span'));
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
    name = (name || '').trim().replace(/\s+/g, ' ') || G.nameOf(labels.find((l) => !G.isManual(l)) || labels[0]);
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
          commitGroups('Removed “' + G.display(l) + '”.');
        })))));
    });

    if (state.rows) {
      man.append(el('h3', { text: 'Group names yourself' }));
      const search = el('input', { type: 'search', placeholder: 'Filter customer names…', 'aria-label': 'Filter customer names' });
      const nameIn = el('input', { type: 'text', placeholder: 'Customer name for the group', 'aria-label': 'Name for the new group' });
      const pick = el('div', { class: 'grp-pick' });
      // Named customers first, then manual charges (by cardholder).
      const labels = [...state.profiles.keys()].sort((a, b) => (G.isManual(a) - G.isManual(b)) || G.nameOf(a).localeCompare(G.nameOf(b)));
      const boxes = new Map();
      labels.forEach((l) => {
        const p = state.profiles.get(l);
        const cb = el('input', { type: 'checkbox', value: l });
        boxes.set(l, cb);
        pick.append(el('label', null, cb, el('span', { text: G.display(l) }), el('span', { class: 'num', text: cents$(p.gross) }),
          el('span', { class: 'mut', text: [...p.cards.keys()].join(', ') }), el('span', { class: 'mut', text: resolve(l) !== l ? 'in “' + resolve(l) + '”' : '' })));
      });
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        for (const [l, cb] of boxes) cb.parentElement.hidden = q && !G.display(l).toLowerCase().includes(q);
      });
      pick.addEventListener('change', () => {
        const chosen = labels.filter((l) => boxes.get(l).checked);
        const named = chosen.filter((l) => !G.isManual(l));
        if (chosen.length && !nameIn.dataset.touched) nameIn.value = G.nameOf((named.length ? named : chosen).slice().sort((a, b) => state.profiles.get(b).gross - state.profiles.get(a).gross)[0]);
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
    C.setNameNote((name) => {
      const m = state.members.get(name), n = noteOf(name);
      const bits = [];
      if (m) bits.push('Combines: ' + m.map(G.display).join(' + '));
      if (n) bits.push('Note: ' + N.describe(n));
      return bits.length ? bits.join(' · ') : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Customer notes dialog
  // ---------------------------------------------------------------------------
  function commitNotes(msg) {
    saveStore();
    if (state.rows) render();
    renderNotesDialog();
    if (msg) $('noteNote').textContent = msg;
  }
  const noteTag = (text) => (text ? el('span', { class: 'tag', text }) : el('span', { class: 'mut', text: '—' }));

  function renderNotesDialog() {
    const add = clear($('noteAdd')), list = clear($('noteList'));
    const customers = state.rows ? [...new Set((state.mapped || state.rows).filter((r) => !r.oneTime).map((r) => r.customer))].sort((a, b) => a.localeCompare(b)) : [];
    // Add / edit one note
    add.append(el('h3', { text: 'Add or change a note' }));
    const dl = el('datalist', { id: 'noteNames' }, customers.map((c) => el('option', { value: c })));
    const nameIn = el('input', { type: 'text', list: 'noteNames', placeholder: 'Customer name (as shown in the dashboard)', 'aria-label': 'Customer' });
    const sel = (opts, label) => el('select', { 'aria-label': label }, opts.map(([v, t]) => el('option', { value: v, text: t })));
    const paysIn = sel([['', 'card'], ['EFT', 'EFT'], ['cheque', 'cheque'], ['mixed', 'mixed']], 'Pays by');
    const cycleIn = sel([['', 'measured'], ['weekly', 'weekly'], ['every 14 days', 'every 14 days'], ['every 21 days', 'every 21 days'], ['monthly', 'monthly'], ['seasonal', 'seasonal'], ['sporadic', 'sporadic'], ['on request', 'on request']], 'Cycle');
    const statusIn = sel([['', 'active'], ['stopped ordering', 'stopped ordering'], ['closed', 'closed']], 'Status');
    const sinceIn = el('input', { type: 'text', placeholder: 'YYYY-MM', 'aria-label': 'Since', pattern: '\\d{4}(-\\d{1,2}(-\\d{1,2})?)?' });
    const textIn = el('input', { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Note' });
    const fill = (n) => {
      if (n.cycle && ![...cycleIn.options].some((o) => o.value === n.cycle)) cycleIn.append(el('option', { value: n.cycle, text: n.cycle }));
      nameIn.value = n.name; paysIn.value = n.paysBy || ''; cycleIn.value = n.cycle || ''; statusIn.value = n.status || ''; sinceIn.value = n.sinceText || ''; textIn.value = n.note || '';
    };
    // Picking a customer who already has a note loads it, unless other fields were already chosen.
    const untouched = () => !paysIn.value && !cycleIn.value && !statusIn.value && !sinceIn.value.trim() && !textIn.value.trim();
    nameIn.addEventListener('change', () => { const n = noteOf(nameIn.value); if (n && untouched()) fill(Object.assign({}, n, { name: nameIn.value })); });
    const saveBtn = el('button', { type: 'button', class: 'btn primary small', onclick: () => {
      const name = nameIn.value.trim().replace(/\s+/g, ' ');
      if (!name) { $('noteNote').textContent = 'Type or pick the customer name first.'; return; }
      const since = N.parseSince(sinceIn.value);
      if (since === undefined) { $('noteNote').textContent = 'Since should be YYYY-MM-DD, YYYY-MM or YYYY.'; return; }
      const cycleDays = /^every (\d+) days$/.exec(cycleIn.value || '');
      const note = { name, paysBy: paysIn.value || null, cycle: cycleIn.value || null, cycleDays: cycleDays ? +cycleDays[1] : null, status: statusIn.value || null, since, sinceText: sinceIn.value.trim(), sinceEnd: N.sinceEnd(sinceIn.value.trim()), note: textIn.value.trim() };
      if (!note.paysBy && !note.cycle && !note.status && !note.note && since == null) { delete state.notes[N.norm(name)]; commitNotes('Removed the note for “' + name + '”.'); return; }
      state.notes[N.norm(name)] = note;
      commitNotes('Saved the note for “' + name + '”' + (customers.length && !customers.some((c) => N.norm(c) === N.norm(name)) ? ' (no customer with that name in this file; check the spelling)' : '') + '.');
      fill({ name: '' });
    } }, 'Save note');
    add.append(dl, el('div', { class: 'note-form' },
      el('label', null, 'Customer', nameIn), el('label', null, 'Pays by', paysIn), el('label', null, 'Cycle', cycleIn),
      el('label', null, 'Status', statusIn), el('label', null, 'Since', sinceIn), el('label', null, 'Note', textIn), saveBtn));

    // How the last loaded file was read: anything interpreted or skipped, by line.
    const rep = state.notesReport;
    if (rep && (rep.interpreted.length || rep.ignored.length)) {
      const box = el('div', { class: 'grp-card' }, el('strong', { text: 'How your file was read (' + rep.file + ')' }));
      if (rep.interpreted.length) box.append(el('p', { class: 'mut', style: 'margin:6px 0 2px', text: 'Read as you clearly meant them (save the notes file to keep them this way):' }), el('ul', { class: 'grp-reasons' }, rep.interpreted.map((x) => el('li', { text: x }))));
      if (rep.ignored.length) box.append(el('p', { class: 'neg', style: 'margin:6px 0 2px', text: 'Skipped (the rest of each row still counts):' }), el('ul', { class: 'grp-reasons' }, rep.ignored.map((x) => el('li', { text: x }))));
      add.append(box);
    }
    // Current notes
    const notes = Object.values(state.notes).sort((a, b) => a.name.localeCompare(b.name));
    list.append(el('h3', { text: 'Your notes (' + notes.length + ')' }));
    if (!notes.length) list.append(el('p', { class: 'grp-empty', text: 'No notes yet. Add one above or load a notes file (a CSV with the columns Customer, Pays by, Cycle, Status, Since, Note).' }));
    else {
      list.append(el('div', { class: 'note-row head' }, ['Customer', 'Pays by', 'Cycle', 'Status', 'Since', 'Note', ''].map((t) => el('span', { text: t }))));
      const inFile = new Set(customers.map(N.norm));
      const groupOfLabel = new Map();
      for (const [g, labels] of state.members) labels.forEach((l) => { if (!G.isManual(l)) groupOfLabel.set(N.norm(l), g); });
      notes.forEach((n) => {
        list.append(el('div', { class: 'note-row' },
          el('span', { class: 'nm' }, n.name, !state.rows || inFile.has(N.norm(n.name)) ? null
            : groupOfLabel.has(N.norm(n.name)) ? el('span', { class: 'mut', text: ' · applies to ' + groupOfLabel.get(N.norm(n.name)) })
            : el('span', { class: 'mut', text: ' · not in this file' })),
          noteTag(n.paysBy), noteTag(n.cycle), noteTag(n.status), el('span', { class: 'mut', text: n.sinceText || '—' }), el('span', { class: 'mut', text: n.note || '' }),
          el('button', { type: 'button', class: 'x', title: 'Remove the note for ' + n.name, 'aria-label': 'Remove note for ' + n.name, text: '×', onclick: () => { delete state.notes[N.norm(n.name)]; commitNotes('Removed the note for “' + n.name + '”.'); } })));
      });
    }
    $('noteNote').textContent = state.storeOk ? 'Saved in this browser only. Use “Save notes file” to keep a copy, edit it in a spreadsheet, or use it on another computer.'
      : 'This browser is not allowing pages opened from disk to save settings, so notes last until the tab closes. Use “Save notes file” to keep them.';
    $('noteClear').disabled = !notes.length;
    updateNotesBadge();
  }
  function updateNotesBadge() {
    const b = $('notesBadge');
    const n = Object.keys(state.notes).length;
    b.hidden = !n;
    b.className = 'badge';
    b.textContent = String(n);
    b.title = plural(n, 'customer note');
  }
  function openNotes() { renderNotesDialog(); $('notesDialog').showModal(); }
  function bindNotes() {
    $('notesBtn').addEventListener('click', openNotes);
    $('notesClose').addEventListener('click', () => $('notesDialog').close());
    $('noteSave').addEventListener('click', () => {
      const blob = new Blob([N.toCSV(state.notes)], { type: 'text/csv' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'customer-notes.csv' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      $('noteNote').textContent = 'Saved customer-notes.csv. It contains customer names, so keep it with the groups file, not in shared folders.';
    });
    $('noteLoadInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const { byKey, count, interpreted, ignored } = N.fromCSV(await f.text(), P.parseCSV);
        Object.assign(state.notes, byKey);
        state.notesReport = { file: f.name, count, interpreted, ignored };
        commitNotes('Loaded ' + plural(count, 'note') + ' from ' + f.name + '.' + (interpreted.length ? ' ' + plural(interpreted.length, 'value') + ' read as you meant them' : '') + (ignored.length ? (interpreted.length ? ',' : '') + ' ' + plural(ignored.length, 'value') + ' skipped' : '') + (interpreted.length || ignored.length ? ': see “How your file was read”.' : ''));
      } catch (err) { $('noteNote').textContent = err.message; }
    });
    $('noteClear').addEventListener('click', () => {
      if (!window.confirm('Remove all customer notes saved in this browser?')) return;
      state.notes = {};
      commitNotes('All notes removed.');
    });
    updateNotesBadge();
  }

  // ---------------------------------------------------------------------------
  // Theme: light by default, navy dark on request (remembered in this browser)
  // ---------------------------------------------------------------------------
  const THEME_KEY = 'ccdash.theme.v1';
  let theme = 'light';
  function applyTheme(value, remember) {
    theme = value === 'dark' ? 'dark' : 'light';
    if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll('#themeSwitch button').forEach((b) => {
      const on = b.dataset.themeValue === theme;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (remember) { try { window.localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private window: not remembered */ } }
  }
  function loadTheme() {
    let v = 'light';
    try { v = window.localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { /* default */ }
    applyTheme(v, false);
  }

  // ---------------------------------------------------------------------------
  // Customer explorer: tick customers, see only their metrics and charts
  // ---------------------------------------------------------------------------
  const X_CHARTS = ['xRevenue', 'xPayments', 'xShare'];
  const MAX_LINES = 7;  // customers drawn individually; the rest share one "other" series

  function showView(view) {
    state.view = view === 'explorer' ? 'explorer' : 'overview';
    const ex = state.view === 'explorer';
    $('view-overview').hidden = ex;
    $('view-explorer').hidden = !ex;
    $('tab-overview').setAttribute('aria-selected', String(!ex));
    $('tab-explorer').setAttribute('aria-selected', String(ex));
    $('tab-overview').tabIndex = ex ? -1 : 0;
    $('tab-explorer').tabIndex = ex ? 0 : -1;
    if (!state.analysis || state.analysis.empty) return;
    if (ex) renderExplorer(); else { closePicker(); paint(); }
  }
  function exploreOnly(name) {
    state.selected = [name];
    showView('explorer');
    window.scrollTo(0, 0);
  }
  /** Customer names in the loaded file (after groups), named customers only. */
  function allCustomerNames() {
    const set = new Set();
    for (const r of state.mapped || state.rows || []) if (!r.oneTime) set.add(r.customer);
    return set;
  }
  function pruneSelection() {
    const names = allCustomerNames();
    state.selected = state.selected.filter((n) => names.has(n));
  }
  const colorOf = (t) => { const pal = C.custColors(t); return (name) => { const i = state.selected.indexOf(name); return i >= 0 && i < MAX_LINES ? pal[i] : pal[pal.length - 1]; }; };

  /** Picker options: every named customer in the file, with in-range revenue. */
  function pickerOptions() {
    const a = state.analysis;
    const inRange = new Map((a && a.customers || []).map((c) => [c.name, c]));
    const opts = [...allCustomerNames()].map((name) => ({ name, gross: inRange.has(name) ? inRange.get(name).gross : 0 }));
    return state.xSort === 'name' ? opts.sort((x, y) => x.name.localeCompare(y.name)) : opts.sort((x, y) => y.gross - x.gross || x.name.localeCompare(y.name));
  }
  function renderPickerList() {
    const q = $('xSearch').value.trim().toLowerCase();
    const list = clear($('xList'));
    const opts = pickerOptions().filter((o) => !q || o.name.toLowerCase().includes(q));
    opts.forEach((o) => {
      const checked = state.selected.includes(o.name);
      const cb = el('input', { type: 'checkbox', value: o.name, 'aria-label': o.name });
      cb.checked = checked;
      const note = noteOf(o.name);
      list.append(el('label', { class: 'x-opt' + (checked ? ' checked' : ''), role: 'option', 'aria-selected': String(checked) },
        cb, el('span', { class: 'nm', text: o.name, title: o.name }),
        note ? el('span', { class: 'tag note', text: note.status || note.paysBy || note.cycle || 'note' }) : el('span'),
        el('span', { class: 'num', text: o.gross ? F.money(o.gross / 100) : 'no sales in period' })));
    });
    if (!opts.length) list.append(el('p', { class: 'grp-empty', style: 'padding: 10px 14px', text: 'No customer name contains “' + q + '”.' }));
    $('xShownCount').textContent = opts.length + ' shown · ' + state.selected.length + ' ticked';
    list.dataset.shown = JSON.stringify(opts.map((o) => o.name));
  }
  function openPicker() {
    $('xPanel').hidden = false;
    $('xPickerBtn').setAttribute('aria-expanded', 'true');
    $('xSort').value = state.xSort;
    renderPickerList();
    $('xSearch').focus();
  }
  function closePicker() {
    if ($('xPanel').hidden) return;
    $('xPanel').hidden = true;
    $('xPickerBtn').setAttribute('aria-expanded', 'false');
  }
  function setSelected(names) {
    state.selected = names;
    renderExplorer();
    if (!$('xPanel').hidden) renderPickerList();
  }
  function bindExplorer() {
    $('xPickerBtn').addEventListener('click', () => ($('xPanel').hidden ? openPicker() : closePicker()));
    $('xSearch').addEventListener('input', renderPickerList);
    $('xSort').addEventListener('change', (e) => { state.xSort = e.target.value; renderPickerList(); });
    $('xList').addEventListener('change', (e) => {
      const cb = e.target;
      if (cb.type !== 'checkbox') return;
      const name = cb.value;
      const next = cb.checked ? state.selected.concat(state.selected.includes(name) ? [] : [name]) : state.selected.filter((n) => n !== name);
      cb.closest('.x-opt').classList.toggle('checked', cb.checked);
      cb.closest('.x-opt').setAttribute('aria-selected', String(cb.checked));
      state.selected = next;
      $('xShownCount').textContent = JSON.parse($('xList').dataset.shown || '[]').length + ' shown · ' + next.length + ' ticked';
      renderExplorer();
    });
    $('xSelectShown').addEventListener('click', () => {
      const shown = JSON.parse($('xList').dataset.shown || '[]');
      setSelected(state.selected.concat(shown.filter((n) => !state.selected.includes(n))));
    });
    $('xClear').addEventListener('click', () => setSelected([]));
    document.addEventListener('mousedown', (e) => { if (!$('xPicker').contains(e.target)) closePicker(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('xPanel').hidden) { closePicker(); $('xPickerBtn').focus(); } });
  }

  /** Status pills for one customer, from the same lists the Overview shows. */
  function statusPills(name, a) {
    const has = (list) => list.some((x) => x.name === name);
    const out = [];
    const lost = a.cardStop.lost.find((x) => x.name === name);
    if (lost) out.push(['bad', lost.status === 'closed' ? 'Closed' : 'Lost', 'Your notes: ' + lost.status + (lost.sinceText ? ' since ' + lost.sinceText : '')]);
    const st = a.cardStop.stopped.find((x) => x.name === name);
    if (st) out.push(['warn', 'Stopped paying by card', (st.why || 'No card payment for ' + a.cardStop.days + '+ days') + ' · last card payment ' + fmtDay(st.lastDay)]);
    if (has(a.cardStop.seasonal)) out.push(['mute', 'Off season', 'Seasonal customer, no card payment for ' + a.cardStop.days + '+ days']);
    if (has(a.momentum.attention)) out.push(['bad', 'Needs attention', 'Recent spending at least ' + Math.round(a.threshold * 100) + '% below their baseline']);
    if (has(a.drifting)) out.push(['warn', 'Overdue', 'At least twice their usual gap since the last card payment']);
    const back = a.cardStop.back.find((x) => x.name === name);
    if (back) out.push(['info', 'Back on card', 'Off card ' + fmtDay(back.offFrom) + ' – ' + fmtDay(back.backOn)]);
    if (!out.length) out.push(['ok', 'Active', 'Paying by card, nothing flagged']);
    return out.map(([cls, text, title]) => el('span', { class: 'status-pill ' + cls, text, title }));
  }

  function renderExplorer() {
    const a = state.analysis;
    const n = state.selected.length;
    $('explorerCount').hidden = !n;
    $('explorerCount').textContent = String(n);
    $('xPickerText').textContent = !n ? 'Select customers' : n === 1 ? state.selected[0] : n + ' customers selected';
    if (state.view !== 'explorer' || !a || a.empty) return;
    const t = C.theme();
    C.configure(t);
    const color = colorOf(t);

    // Ticked customers as removable chips.
    const chips = clear($('xChips'));
    state.selected.forEach((name, i) => {
      chips.append(el('span', { class: 'x-chip', style: '--chip: ' + color(name) }, el('span', { class: 'dot' }), el('span', { text: name }),
        el('button', { type: 'button', title: 'Remove ' + name, 'aria-label': 'Remove ' + name, text: '×', onclick: () => setSelected(state.selected.filter((x) => x !== name)) })));
      if (i === MAX_LINES - 1 && n > MAX_LINES) chips.append(el('span', { class: 'mut', style: 'font-size:12px', text: 'Charts draw the first ' + MAX_LINES + ' individually and the rest as one grey line.' }));
    });

    const box = clear($('xContent'));
    X_CHARTS.forEach((id) => C.destroy(id));
    if (!n) {
      const top = a.customers.filter((c) => c.count > 0);
      const quick = (label, names) => (names.length ? el('button', { type: 'button', class: 'btn small', onclick: () => setSelected(names) }, label + ' (' + names.length + ')') : null);
      box.append(el('div', { class: 'x-empty' },
        el('h3', { text: 'Pick the customers to look at' }),
        el('p', { text: 'Open “Select customers” and tick one customer to see only their metrics and charts, or tick several to compare them side by side. The period, grouping and status filters above apply here too. Any customer name in the Overview tables also opens here.' }),
        el('div', { class: 'x-panel-actions' },
          quick('Top 5 by revenue', top.slice(0, 5).map((c) => c.name)),
          quick('Needs attention', a.momentum.attention.map((x) => x.name)),
          quick('Overdue', a.drifting.map((x) => x.name)),
          quick('Stopped paying by card', a.cardStop.stopped.map((x) => x.name)),
          el('button', { type: 'button', class: 'btn small primary', onclick: openPicker }, 'Select customers…'))));
      return;
    }

    // Analyse only the ticked customers' rows, with the same filters as the Overview.
    const set = new Set(state.selected);
    const rows = (state.mapped || state.rows).filter((r) => !r.oneTime && set.has(r.customer));
    // Same unknown days as the Overview: a ticked customer's own silence is not missing data.
    const xa = rows.length ? M.analyse(rows, { from: state.from, to: state.to, unit: state.unit, status: state.status, threshold: state.threshold, notes: effectiveNotes(), missing: a.missing }) : { empty: true };
    state.explorer = xa;
    const share = a.totals.gross ? (xa.empty ? 0 : xa.totals.gross) / a.totals.gross : 0;
    const noun = M.UNIT_NOUN[a.unit];

    box.append(el('p', { class: 'x-lede' }, n === 1 ? 'Showing only ' : 'Showing only these ' + n + ' customers: ',
      n === 1 ? el('strong', { text: state.selected[0] }) : null,
      n === 1 ? ', ' : '', el('strong', { text: F.pct(share) }), ' of all revenue in ' + fmtDay(a.from) + ' – ' + fmtDay(a.to) + '.'));
    if (xa.empty) {
      box.append(el('div', { class: 'x-empty' }, el('h3', { text: 'No activity in this period' }), el('p', { text: 'The ticked customers have no transactions between ' + fmtDay(a.from) + ' and ' + fmtDay(a.to) + '. Widen the period above.' })));
      return;
    }
    const kpis = el('section', { class: 'kpis', id: 'xKpis', 'aria-label': 'Key figures for the ticked customers' });
    box.append(kpis);
    renderKPIs(xa, kpis);

    // Per-period revenue, one series per customer (the rest combined).
    const idx = M.makeIndexer(xa.buckets);
    const sales = rows.filter((r) => r.status === 'Batched' && r.cents > 0 && r.day >= xa.from && r.day <= xa.to);
    const zeros = () => new Array(xa.buckets.length).fill(0);
    const lines = state.selected.slice(0, MAX_LINES).map((name) => ({ name, color: color(name), data: zeros() }));
    const other = n > MAX_LINES ? { name: 'Other ticked customers (' + (n - MAX_LINES) + ')', color: color(null), data: zeros(), other: true } : null;
    const lineOf = new Map(lines.map((l) => [l.name, l]));
    for (const r of sales) (lineOf.get(r.customer) || other).data[idx(r.day)] += r.cents;

    const grid = el('div', { class: 'grid' });
    box.append(grid);
    const chartCard = (id, title, sub, cls, height) => {
      const canvas = el('canvas', { id: 'c-' + id, role: 'img' });
      const cbox = el('div', { class: 'chart-box', id: 'box-' + id, style: height ? 'height:' + height + 'px' : null }, canvas);
      const cap = el('p', { class: 'caption', id: 'cap-' + id });
      grid.append(el('article', { class: 'card ' + (cls || ''), 'data-chart': id },
        el('header', { class: 'card-head' }, el('div', null, el('h3', { text: title }), el('p', { class: 'card-sub', text: sub }))), cbox, cap));
      return { box: cbox, cap };
    };
    const rev = chartCard('xRevenue', 'Revenue per ' + noun + (n > 1 ? ' by customer' : ''), 'Gross revenue from successful charges' + (n > 1 ? ', one line per ticked customer' : '') + ' · * = partial ' + noun, 'span-2');
    C.xRevenue(xa.buckets, other ? lines.concat(other) : lines, t, noun);
    const best = lines.map((l) => ({ l, total: l.data.reduce((x, y) => x + y, 0) })).sort((x, y) => y.total - x.total)[0];
    rev.cap.textContent = n === 1 ? 'Each bar is one ' + noun + '’s revenue from this customer. Gaps are ' + noun + 's with no successful card payment.'
      : 'Lines that move together are customers on the same ordering rhythm; a line that drops to zero and stays there has stopped paying by card. Biggest in this period: ' + best.l.name + ' (' + F.money(best.total / 100) + ').';

    // Every payment attempt as a dot.
    const inR = rows.filter((r) => r.day >= xa.from && r.day <= xa.to && r.cents >= 0 && (state.status !== 'success' || r.status === 'Batched'));
    const pts = inR.map((r) => ({ x: r.day, y: r.cents / 100, customer: r.customer, status: r.status, reason: r.reason || r.voidNote || '',
      series: lineOf.has(r.customer) ? r.customer : other ? other.name : r.customer }));
    const pay = chartCard('xPayments', 'Every payment', 'Each dot is one charge: date across, amount up · ✕ = failed, hollow = voided', 'span-2', 300);
    C.xPayments(pts, other ? lines.concat(other) : lines, xa.from, xa.to, t);
    const failedN = inR.filter((r) => r.status === 'Failed').length;
    pay.cap.textContent = 'Regular dots at the same height are a standing order; a widening gap between dots is a customer slowing down. ' +
      plural(inR.filter((r) => r.status === 'Batched').length, 'successful charge') + (state.status === 'success' ? '' : ', ' + plural(failedN, 'failed charge') + ', ' + plural(inR.filter((r) => r.status === 'Voided').length, 'void')) + ' in this period.';

    // Share of the selection (2+ customers).
    const stats = new Map(a.customers.map((c) => [c.name, c]));
    if (n > 1) {
      const items = state.selected.map((name) => ({ name, gross: (stats.get(name) || { gross: 0 }).gross })).sort((x, y) => y.gross - x.gross);
      const tot = items.reduce((x, y) => x + y.gross, 0);
      const sh = chartCard('xShare', 'Share of the ticked customers’ revenue', 'Gross revenue in this period', '');
      C.hbar('xShare', items, t, { box: sh.box, label: 'Revenue', value: (x) => x.gross / 100, color: t.accent, tick: (v) => F.compact(v), axis: 'Revenue',
        tooltip: (x) => ' ' + F.money(x.gross / 100) + ' · ' + F.pct(tot ? x.gross / tot : 0) + ' of the ticked customers', labelFmt: (v, x) => F.compact(v) + ' · ' + F.pct(tot ? x.gross / tot : 0, 0), aria: 'Bar chart of revenue per ticked customer' });
      const chart = C.registry.xShare;
      chart.data.datasets[0].backgroundColor = items.map((x) => color(x.name));
      chart.update();
      sh.cap.textContent = items[0].name + ' brings in ' + F.pct(tot ? items[0].gross / tot : 0) + ' of what these ' + n + ' customers paid by card.';
    }

    // Card types for the selection.
    const cards = xa.risk.cardMix.filter((c) => c.cents > 0);
    if (cards.length) {
      const cm = el('article', { class: 'card' + (n > 1 ? '' : ' span-2') },
        el('header', { class: 'card-head' }, el('div', null, el('h3', { text: 'Cards used' }), el('p', { class: 'card-sub', text: 'Revenue and failure rate by card type, ticked customers only' }))));
      cm.append(table([
        { key: 'card', label: 'Card', fmt: (r) => [el('span', { class: 'swatch', style: 'background:' + C.cardColor(r.card, t) }), r.card] },
        { key: 'cents', label: 'Revenue', num: true, fmt: (r) => F.money(r.cents / 100) },
        { key: 'count', label: 'Payments', num: true },
        { key: 'rate', label: 'Failed', num: true, fmt: (r) => state.status === 'success' ? 'n/a' : r.failed + ' of ' + r.attempts + ' (' + F.pct(r.attempts ? r.failed / r.attempts : 0) + ')', sort: (r) => (r.attempts ? r.failed / r.attempts : 0) },
      ], cards, { sort: { key: 'cents', dir: -1 } }));
      grid.append(cm);
    }

    // Side by side.
    const slope = new Map(a.momentum.slopes.map((x) => [x.name, x.slope]));
    const gap = new Map(a.cadence.map((x) => [x.name, x]));
    const seg = new Map(a.rfm ? a.rfm.members.map((x) => [x.name, x.segment]) : []);
    const perNoun = a.perActiveNoun;
    const rowsT = state.selected.map((name) => {
      const c = stats.get(name) || { name, gross: 0, count: 0, attempts: 0, success: 0, failed: 0, voidCount: 0, voidCents: 0, activePeriods: 0, firstDay: null, lastDay: null };
      return Object.assign({}, c, { share: a.totals.gross ? c.gross / a.totals.gross : 0, avg: c.count ? c.gross / c.count : null, perActive: c.activePeriods ? c.gross / c.activePeriods : null,
        since: c.lastDay == null ? null : a.to - c.lastDay, gap: gap.has(name) ? gap.get(name).avgGap : null, declared: gap.has(name) ? gap.get(name).declared : null,
        slope: slope.has(name) ? slope.get(name) : null, rate: c.attempts ? c.success / c.attempts : null, segment: seg.get(name) || null });
    });
    const na = state.status === 'success';
    const side = el('article', { class: 'card span-2' },
      el('header', { class: 'card-head' }, el('div', null, el('h3', { text: n === 1 ? 'Customer profile' : 'Side by side' }),
        el('p', { class: 'card-sub', text: 'Every figure for the period above; status comes from the same lists as the Overview, including your customer notes. Click a column to sort.' }))),
      el('div', { class: 'table-wrap' }, table([
        { key: 'name', label: 'Customer', name: true, fmt: (r) => [el('span', { class: 'swatch', style: 'background:' + color(r.name) })].concat(nameCell(r.name)) },
        { key: 'status', label: 'Status', fmt: (r) => statusPills(r.name, a), sort: (r) => statusPills(r.name, a).map((p) => p.textContent).join() },
        { key: 'gross', label: 'Revenue', num: true, fmt: (r) => F.money(r.gross / 100) },
        { key: 'share', label: 'Share', num: true, fmt: (r) => F.pct(r.share) },
        { key: 'count', label: 'Payments', num: true },
        { key: 'avg', label: 'Avg', num: true, fmt: (r) => (r.avg == null ? '—' : F.money(r.avg / 100)), sort: (r) => r.avg || 0 },
        { key: 'perActive', label: 'Per active ' + (perNoun === 'month' ? 'mo' : 'wk'), num: true, fmt: (r) => (r.perActive == null ? '—' : F.money(r.perActive / 100)), sort: (r) => r.perActive || 0 },
        { key: 'lastDay', label: 'Last paid', num: true, fmt: (r) => (r.lastDay == null ? 'none in period' : fmtDay(r.lastDay)), sort: (r) => r.lastDay || 0 },
        { key: 'since', label: 'Days', num: true, fmt: (r) => (r.since == null ? '—' : F.int(r.since)), sort: (r) => (r.since == null ? Infinity : r.since) },
        { key: 'gap', label: 'Usual gap', num: true, fmt: (r) => (r.gap == null ? '—' : r.gap.toFixed(1) + ' d' + (r.declared ? ' (' + r.declared + ')' : '')), sort: (r) => r.gap || 0 },
        { key: 'slope', label: 'Trend /' + (a.momentum.periodNoun === 'month' ? 'mo' : 'wk'), num: true, fmt: (r) => (r.slope == null ? '—' : el('span', { class: r.slope >= 0 ? 'pos' : 'neg', text: (r.slope >= 0 ? '▲ ' : '▼ ') + F.signedMoney(r.slope) })), sort: (r) => (r.slope == null ? -Infinity : r.slope) },
        { key: 'rate', label: 'Success', num: true, fmt: (r) => (na || r.rate == null ? '—' : F.pct(r.rate)), sort: (r) => r.rate || 0 },
        { key: 'failed', label: 'Failed', num: true, fmt: (r) => (na ? '—' : F.int(r.failed)) },
        { key: 'voidCents', label: 'Voided', num: true, fmt: (r) => (na ? '—' : F.money(r.voidCents / 100)) },
        { key: 'segment', label: 'Segment', fmt: (r) => r.segment || '—', sort: (r) => r.segment || '' },
      ], rowsT, { sort: { key: 'gross', dir: -1 } })));
    side.querySelector('table').classList.add('compact');
    grid.append(side);

    // Failed and voided charges, newest first.
    if (!na) {
      const recovered = new Map();
      xa.retry.chains.forEach((ch) => ch.failures.forEach((f) => recovered.set(f, ch.successDay)));
      const probs = inR.filter((r) => r.status !== 'Batched').sort((x, y) => y.day - x.day || y.second - x.second);
      grid.append(el('article', { class: 'card span-2' },
        el('header', { class: 'card-head' }, el('div', null, el('h3', { text: 'Failed and voided charges' }), el('p', { class: 'card-sub', text: 'Newest first · “Recovered” = the same amount on the same card went through later' }))),
        el('div', { class: 'table-wrap scroll mid' }, table([
          { key: 'day', label: 'Date', num: true, fmt: (r) => fmtDay(r.day) },
          { key: 'customer', label: 'Customer', name: true, fmt: (r) => r.customer },
          { key: 'cents', label: 'Amount', num: true, fmt: (r) => F.money(r.cents / 100) },
          { key: 'card', label: 'Card' },
          { key: 'status', label: 'Status', fmt: (r) => el('span', { class: 'status-pill ' + (r.status === 'Failed' ? 'bad' : 'mute'), text: r.status }) },
          { key: 'reason', label: 'Reason / void note', fmt: (r) => el('span', { class: 'why', text: r.reason || r.voidNote || '' }), sort: (r) => r.reason || r.voidNote || '' },
          { key: 'rec', label: 'Recovered', fmt: (r) => (r.status !== 'Failed' ? '' : recovered.has(r) ? el('span', { class: 'pos', text: '✓ ' + fmtDay(recovered.get(r)) }) : el('span', { class: 'neg', text: 'no' })), sort: (r) => (recovered.has(r) ? 1 : 0) },
        ], probs, { empty: 'No failed or voided charges for these customers in this period.', good: true }))));
    }
  }

  loadTheme();
  loadStore();
  bindGroups();
  bindNotes();
  bind();
})();
