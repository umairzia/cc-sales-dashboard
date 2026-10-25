/* charts.js — number formatting + chart construction (Chart.js, vendored).
 *
 * Colours are read from the CSS custom properties on :root at render time, so
 * light/dark/print all come from styles.css. Text never wears a series colour;
 * every coloured mark is paired with a sign, arrow or label.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const MINUS = '−';
  const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const twoFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const Fmt = {
    /** $1,234,567 (headline). digits=2 → $1,234.56 */
    money(dollars, digits) {
      if (dollars == null || !isFinite(dollars)) return '—';
      const f = digits === 2 ? twoFmt : intFmt;
      const s = '$' + f.format(Math.abs(digits === 2 ? dollars : Math.round(dollars)));
      return dollars < 0 && Math.abs(dollars) >= (digits === 2 ? 0.005 : 0.5) ? MINUS + s : s;
    },
    /** $1.23M / $450K / $12.5K / $950 (axes, labels) */
    compact(dollars) {
      if (dollars == null || !isFinite(dollars)) return '—';
      const a = Math.abs(dollars);
      let s;
      if (a >= 1e6) s = (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
      else if (a >= 1e5) s = Math.round(a / 1e3) + 'K';
      else if (a >= 1e3) s = (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
      else s = String(Math.round(a));
      return (dollars < 0 && a >= 0.5 ? MINUS : '') + '$' + s;
    },
    int(n) { return n == null ? '—' : intFmt.format(n); },
    pct(x, d) { return x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; },
    signedPct(x, d) {
      if (x == null || !isFinite(x)) return '—';
      const v = (x * 100).toFixed(d == null ? 1 : d);
      return (+v > 0 ? '+' : +v < 0 ? MINUS : '') + v.replace('-', '') + '%';
    },
    signedMoney(dollars) {
      if (dollars == null || !isFinite(dollars)) return '—';
      return (dollars > 0 ? '+' : '') + Fmt.compact(dollars);
    },
    pp(x) {
      if (x == null || !isFinite(x)) return '—';
      const v = (x * 100).toFixed(1);
      return (+v > 0 ? '+' : +v < 0 ? MINUS : '') + v.replace('-', '') + ' pp';
    },
    days(n) { return n == null ? '—' : n === 1 ? '1 day' : intFmt.format(Math.round(n)) + ' days'; },
  };

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue('--' + n).trim();
    const keys = ['bg', 'surface', 'surface-2', 'text', 'text-2', 'muted', 'grid', 'axis', 'accent', 'accent-soft', 'accent-ink',
      'series-2', 'series-3', 'series-4', 'neutral-mark', 'good', 'good-deep', 'bad', 'bad-deep', 'warn', 'warn-text',
      'seg-1', 'seg-2', 'seg-3', 'seg-4', 'font'];
    const t = {};
    keys.forEach((k) => { t[k.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase())] = v(k); });
    return t;
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
  }
  /** Linear mix between two hex colours, t in [0,1]. */
  function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return 'rgb(' + x.map((c, i) => Math.round(c + (y[i] - c) * t)).join(',') + ')';
  }
  function alpha(hex, a) { const [r, g, b] = hexToRgb(hex); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }

  /** Diagonal-hatch fill: marks partial periods without relying on colour. */
  function hatch(base, line) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 8, 8);
    g.strokeStyle = line; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
    return g.createPattern(c, 'repeat');
  }

  // ---------------------------------------------------------------------------
  // Plugins (local, opt-in via options.plugins.<id>)
  // ---------------------------------------------------------------------------
  const valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw(chart, args, opts) {
      if (!opts || !opts.format) return;
      const { ctx } = chart;
      const horizontal = chart.options.indexAxis === 'y';
      const sets = opts.datasets || [0];
      ctx.save();
      ctx.font = (opts.weight || '600') + ' 11.5px ' + chart.options.font.family;
      ctx.fillStyle = opts.color;
      sets.forEach((di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach((el, i) => {
          const raw = chart.data.datasets[di].data[i];
          if (raw == null) return;
          const text = opts.format(raw, i, di);
          if (!text) return;
          const neg = raw < 0;
          if (horizontal) {
            ctx.textBaseline = 'middle';
            ctx.textAlign = neg ? 'right' : 'left';
            ctx.fillText(text, el.x + (neg ? -5 : 5), el.y);
          } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = neg ? 'top' : 'bottom';
            ctx.fillText(text, el.x, el.y + (neg ? 4 : -4));
          }
        });
      });
      ctx.restore();
    },
  };

  const extremes = {
    id: 'extremes',
    afterDatasetsDraw(chart, args, opts) {
      if (!opts || opts.hi == null) return;
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = '600 11.5px ' + chart.options.font.family;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const mark = (i, text, color) => {
        const el = meta.data[i];
        if (!el) return;
        ctx.fillStyle = color;
        ctx.fillText(text, el.x, el.y - 6);
      };
      if (opts.lo != null && opts.lo !== opts.hi) mark(opts.lo, opts.loText, opts.color);
      mark(opts.hi, opts.hiText, opts.color);
      ctx.restore();
    },
  };

  const refLines = {
    id: 'refLines',
    afterDatasetsDraw(chart, args, opts) {
      if (!opts) return;
      const { ctx, chartArea: a, scales } = chart;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = opts.color;
      ctx.fillStyle = opts.textColor;
      ctx.font = '600 11px ' + chart.options.font.family;
      (opts.x || []).forEach((r) => {
        const x = scales.x.getPixelForValue(r.value);
        if (x < a.left || x > a.right) return;
        const yTop = r.at != null ? scales.y.getPixelForValue(r.at) : a.top;
        ctx.beginPath(); ctx.moveTo(x, a.bottom); ctx.lineTo(x, yTop); ctx.stroke();
        if (r.at != null) {
          ctx.save(); ctx.setLineDash([]);
          ctx.fillStyle = opts.dot; ctx.strokeStyle = opts.ring; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, yTop, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.restore();
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(r.label, x + 9, yTop + 9);
      });
      (opts.y || []).forEach((r) => {
        const y = scales.y.getPixelForValue(r.value);
        ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(r.label, a.right - 4, y - 3);
      });
      ctx.restore();
    },
  };

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------
  const registry = {};
  let configured = false;

  function configure(t) {
    const C = root.Chart;
    if (!configured) { C.register(valueLabels, extremes, refLines); configured = true; }
    C.defaults.font.family = getComputedStyle(document.body).fontFamily;
    C.defaults.font.size = 12;
    C.defaults.color = t.text2;
    C.defaults.borderColor = t.grid;
    C.defaults.animation = false;
    C.defaults.maintainAspectRatio = false;
    C.defaults.responsive = true;
    C.defaults.plugins.legend.labels.boxWidth = 12;
    C.defaults.plugins.legend.labels.boxHeight = 12;
    C.defaults.plugins.legend.labels.color = t.text2;
    C.defaults.plugins.legend.align = 'start';
    C.defaults.plugins.legend.labels.sort = (x, y) => x.datasetIndex - y.datasetIndex;
    Object.assign(C.defaults.plugins.tooltip, {
      backgroundColor: t.text, titleColor: t.surface, bodyColor: t.surface, footerColor: t.surface,
      padding: 9, cornerRadius: 6, displayColors: true, boxPadding: 4, titleFont: { weight: '600' },
    });
  }

  function canvasOf(id) { return document.getElementById('c-' + id); }

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }
  function destroyAll() { Object.keys(registry).forEach(destroy); }

  function setEmpty(id, message) {
    destroy(id);
    const canvas = canvasOf(id);
    const box = canvas.parentElement;
    canvas.hidden = true;
    let div = box.querySelector('.chart-empty');
    if (!div) { div = document.createElement('div'); div.className = 'chart-empty'; box.appendChild(div); }
    div.textContent = message;
    box.style.height = '';
  }

  function make(id, config, ariaLabel) {
    destroy(id);
    const canvas = canvasOf(id);
    canvas.hidden = false;
    canvas.style.display = '';
    const empty = canvas.parentElement.querySelector('.chart-empty');
    if (empty) empty.remove();
    if (ariaLabel) canvas.setAttribute('aria-label', ariaLabel);
    if (root.__ccPrintDPR) config.options = Object.assign({ devicePixelRatio: root.__ccPrintDPR }, config.options);
    registry[id] = new root.Chart(canvas, config);
    return registry[id];
  }

  const axisTitle = (text, t) => ({ display: !!text, text, color: t.muted, font: { size: 11.5, weight: '600' } });
  const gridOpts = (t, zero) => ({
    color: zero ? (ctx) => (ctx.tick && ctx.tick.value === 0 ? t.axis : t.grid) : t.grid,
    lineWidth: zero ? (ctx) => (ctx.tick && ctx.tick.value === 0 ? 1.5 : 1) : 1,
    drawTicks: false,
  });
  const ticks = (t, extra) => Object.assign({ color: t.muted, padding: 6 }, extra || {});
  const nameTick = (max) => (v) => (typeof v === 'string' && v.length > max ? v.slice(0, max - 1) + '…' : v);

  // ---------------------------------------------------------------------------
  // C. Revenue over time
  // ---------------------------------------------------------------------------
  function revenue(a, t, unitNoun) {
    const labels = a.buckets.map((b) => b.short + (b.partial ? '*' : ''));
    const gross = a.series.gross.map((c) => c / 100);
    const partialFill = hatch(t.accentSoft, t.accent);
    const max = Math.max(...gross, 1);
    const hi = a.series.hi, lo = a.series.lo;
    return make('revenue', {
      data: {
        labels,
        datasets: [
          {
            type: 'bar', label: 'Revenue (successful charges)', data: gross, order: 2,
            backgroundColor: a.buckets.map((b) => (b.partial ? partialFill : t.accent)),
            borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start',
            maxBarThickness: 34, barPercentage: 0.82, categoryPercentage: 0.9,
          },
          {
            type: 'line', label: a.rollingWindow + '-' + unitNoun + ' rolling average', data: a.series.rolling.map((c) => (c == null ? null : c / 100)),
            order: 1, borderColor: t.text, backgroundColor: t.text, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
            tension: 0.3, spanGaps: false, pointStyle: 'line',
          },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 8 } },
        scales: {
          x: { grid: { display: false }, ticks: ticks(t, { maxRotation: 0, autoSkip: true, autoSkipPadding: 10 }), title: axisTitle('Period (* = partial)', t), border: { color: t.axis } },
          y: { beginAtZero: true, suggestedMax: max * 1.14, grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { callback: (v) => Fmt.compact(v), maxTicksLimit: 7 }), title: axisTitle('Revenue', t) },
        },
        plugins: {
          legend: { labels: {
            usePointStyle: true, pointStyleWidth: 18,
            generateLabels: (chart) => root.Chart.defaults.plugins.legend.labels.generateLabels(chart).map((l) => (l.datasetIndex === 0 ? Object.assign(l, { fillStyle: t.accent, strokeStyle: t.accent, pointStyle: 'rect' }) : l)),
          } },
          tooltip: {
            callbacks: {
              title: (items) => { const b = a.buckets[items[0].dataIndex]; return b.label + (b.partial ? ' (partial)' : ''); },
              label: (ctx) => ' ' + ctx.dataset.label + ': ' + (ctx.raw == null ? 'n/a' : Fmt.money(ctx.raw)),
              afterBody: (items) => { const i = items[0].dataIndex; return a.series.count[i] + ' successful charges'; },
            },
          },
          extremes: hi == null ? null : {
            hi, lo, color: t.text,
            hiText: '▲ High ' + Fmt.compact(gross[hi]),
            loText: '▼ Low ' + Fmt.compact(gross[lo]),
          },
        },
      },
    }, 'Bar chart of revenue per period with a rolling average line');
  }

  function pop(a, t) {
    const labels = a.buckets.map((b) => b.short + (b.partial ? '*' : ''));
    const vals = a.series.pop.map((x) => (x == null ? null : x * 100));
    const finite = vals.filter((v) => v != null);
    const raw = Math.max(10, ...finite.map(Math.abs)) * 1.2;
    const step = raw > 100 ? 50 : raw > 40 ? 20 : 10;
    const ext = Math.ceil(raw / step) * step;
    return make('pop', {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '% change vs previous period', data: vals,
          backgroundColor: vals.map((v) => (v == null ? 'transparent' : v >= 0 ? t.good : t.bad)),
          borderRadius: 3, borderSkipped: 'start', maxBarThickness: 28,
        }],
      },
      options: {
        scales: {
          x: { grid: { display: false }, ticks: ticks(t, { maxRotation: 0, autoSkipPadding: 10 }), border: { display: false } },
          y: { min: -ext, max: ext, grid: gridOpts(t, true), border: { display: false }, ticks: ticks(t, { callback: (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(Math.round(v)) + '%', stepSize: step }), title: axisTitle('Change', t) },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: (items) => a.buckets[items[0].dataIndex].label,
            label: (ctx) => ctx.raw == null ? ' n/a (partial period)' : ' ' + Fmt.signedPct(ctx.raw / 100) + ' vs previous period',
          } },
          valueLabels: { color: t.text2, format: (v) => (v >= 0 ? '▲ +' : '▼ ' + MINUS) + Math.abs(v).toFixed(1) + '%' },
        },
      },
    }, 'Diverging bar chart of percent change in revenue from the previous period');
  }

  // ---------------------------------------------------------------------------
  // D. Momentum
  // ---------------------------------------------------------------------------
  function slopes(list, t, unitNoun, boxEl) {
    const maxAbs = Math.max(...list.map((x) => Math.abs(x.slope)), 1);
    const color = (s) => {
      const k = 0.18 + 0.82 * Math.min(1, Math.abs(s) / maxAbs);
      return s >= 0 ? mix(t.surface, t.goodDeep, k) : mix(t.surface, t.badDeep, k);
    };
    boxEl.style.height = Math.max(160, list.length * 21 + 70) + 'px';
    const per = '/' + (unitNoun === 'month' ? 'mo' : unitNoun === 'week' ? 'wk' : unitNoun === 'day' ? 'day' : 'qtr');
    return make('slopes', {
      type: 'bar',
      data: {
        labels: list.map((x) => x.name),
        datasets: [{ label: 'Trend ($ per ' + unitNoun + ')', data: list.map((x) => x.slope), backgroundColor: list.map((x) => color(x.slope)), borderRadius: 3, borderSkipped: 'start', barPercentage: 0.8, maxBarThickness: 16 }],
      },
      options: {
        indexAxis: 'y',
        layout: { padding: { left: 4, right: 4 } },
        scales: {
          x: { grace: '32%', grid: gridOpts(t, true), border: { display: false }, ticks: ticks(t, { callback: (v) => Fmt.signedMoney(v), maxTicksLimit: 7, maxRotation: 0 }), title: axisTitle('Revenue change per ' + unitNoun + ' (linear trend)', t), position: 'top' },
          y: { grid: { display: false }, border: { display: false }, ticks: ticks(t, { autoSkip: false, callback: function (v) { return nameTick(26)(this.getLabelForValue(v)); }, font: { size: 11.5 } }) },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: (ctx) => { const x = list[ctx.dataIndex]; return [' Trend: ' + Fmt.signedMoney(x.slope) + per, ' Active in ' + x.active + ' of ' + x.buckets + ' ' + unitNoun + 's', ' Revenue: ' + Fmt.money(x.gross / 100)]; },
          } },
          valueLabels: { color: t.text2, weight: '500', format: (v) => (v >= 0 ? '▲ +' : '▼ ' + MINUS) + Fmt.compact(Math.abs(v)) + per },
        },
      },
    }, 'Diverging bar chart of each customer’s revenue trend');
  }

  // ---------------------------------------------------------------------------
  // E. Customers
  // ---------------------------------------------------------------------------
  function hbar(id, items, t, o) {
    o.box.style.height = Math.max(150, items.length * (o.rowH || 22) + 60) + 'px';
    return make(id, {
      type: 'bar',
      data: {
        labels: items.map((x) => (x.oneTime ? x.name + ' †' : x.name)),
        datasets: [{
          label: o.label, data: items.map(o.value),
          backgroundColor: items.map((x) => (x.oneTime ? hatch(t.surface2, t.neutralMark) : o.color)),
          borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'start', barPercentage: 0.78, maxBarThickness: 18,
        }],
      },
      options: {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grace: o.grace || '28%', max: o.max, grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { callback: o.tick, maxTicksLimit: 6, maxRotation: 0 }), title: axisTitle(o.axis, t) },
          y: { grid: { display: false }, border: { color: t.axis }, ticks: ticks(t, { autoSkip: false, callback: function (v) { return nameTick(28)(this.getLabelForValue(v)); }, font: { size: 11.5 } }) },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => o.tooltip(items[ctx.dataIndex]) } },
          valueLabels: { color: t.text2, weight: '500', format: (v, i) => o.labelFmt(v, items[i]) },
        },
      },
    }, o.aria);
  }

  function pareto(a, t) {
    const pts = [{ x: 0, y: 0 }].concat(a.pareto.map((p) => ({ x: p.rank, y: p.cumShare * 100 })));
    const c = a.concentration;
    const n = pts.length - 1;
    const refs = [5, 10, 20].filter((k) => k < n).map((k) => ({ value: k, at: pts[k].y, label: 'Top ' + k + ': ' + Fmt.pct(pts[k].y / 100) }));
    return make('pareto', {
      type: 'line',
      data: { datasets: [{
        label: 'Cumulative share of revenue', data: pts, parsing: false,
        borderColor: t.accent, backgroundColor: alpha(t.accent.length === 7 ? t.accent : '#2a78d6', 0.10), fill: 'origin',
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0,
      }] },
      options: {
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: 0, max: n, grid: { display: false }, border: { color: t.axis }, ticks: ticks(t, { precision: 0, maxTicksLimit: 8 }), title: axisTitle('Number of customers (largest first)', t) },
          y: { min: 0, max: 100, grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { callback: (v) => v + '%', stepSize: 20 }), title: axisTitle('Cumulative revenue', t) },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: (items) => 'Top ' + items[0].raw.x + ' customer' + (items[0].raw.x === 1 ? '' : 's'),
            label: (ctx) => ctx.raw.x === 0 ? '' : ' ' + Fmt.pct(ctx.raw.y / 100) + ' of revenue (#' + ctx.raw.x + ': ' + a.pareto[ctx.raw.x - 1].name + ')',
          } },
          refLines: { color: t.muted, textColor: t.text, dot: t.text, ring: t.surface, x: refs, y: [{ value: 80, label: '80% of revenue' + (c.n80 ? ' · ' + c.n80 + ' customers' : '') }] },
        },
      },
    }, 'Pareto curve of cumulative revenue share by number of customers');
  }

  function cadence(list, t, boxEl) {
    boxEl.style.height = Math.max(170, list.length * 21 + 90) + 'px';
    const maxGap = Math.max(...list.map((x) => x.avgGap), 1);
    const cstep = maxGap * 3 <= 42 ? 7 : maxGap * 3 <= 98 ? 14 : 28;
    const cap = Math.max(28, Math.ceil((maxGap * 3) / cstep) * cstep);
    const off = (x) => x.since > cap;
    return make('cadence', {
      type: 'bar',
      data: {
        labels: list.map((x) => x.name),
        datasets: [
          { type: 'bar', label: 'Usual gap (average days between charges)', data: list.map((x) => +x.avgGap.toFixed(1)), backgroundColor: t.accent, pointStyle: 'rect', borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'start', barPercentage: 0.7, maxBarThickness: 14, order: 2 },
          { type: 'line', label: 'Days since last charge (◆ amber = overdue, ▶ = off the scale)', data: list.map((x) => Math.min(x.since, cap)), showLine: false,
            pointStyle: list.map((x) => (off(x) ? 'triangle' : 'rectRot')), rotation: list.map((x) => (off(x) ? 90 : 0)), pointRadius: 5.5, pointHoverRadius: 7, pointBorderWidth: 2, pointBorderColor: t.surface,
            pointBackgroundColor: list.map((x) => (x.since >= 7 && x.ratio >= 2 ? t.warn : t.text2)), backgroundColor: t.text2, order: 1 },
        ],
      },
      options: {
        indexAxis: 'y',
        interaction: { mode: 'index', intersect: false, axis: 'y' },
        scales: {
          x: { beginAtZero: true, max: cap, grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { stepSize: cstep, maxRotation: 0, callback: (v) => v + (v === cap ? '+' : '') }), title: axisTitle('Days', t), position: 'top' },
          y: { grid: { display: false }, border: { color: t.axis }, ticks: ticks(t, { autoSkip: false, callback: function (v) { return nameTick(26)(this.getLabelForValue(v)); }, font: { size: 11.5 } }) },
        },
        plugins: {
          legend: { labels: { usePointStyle: true } },
          tooltip: { callbacks: {
            label: (ctx) => {
              const x = list[ctx.dataIndex];
              return ctx.datasetIndex === 0 ? ' Usual gap: ' + x.avgGap.toFixed(1) + ' days (' + x.chargeDays + ' charge days)'
                : ' Since last charge: ' + Fmt.days(x.since) + (x.ratio >= 2 && x.since >= 7 ? '  ⚠ ' + x.ratio.toFixed(1) + '× usual' : '');
            },
          } },
        },
      },
    }, 'Bar chart of average days between charges per customer');
  }

  // ---------------------------------------------------------------------------
  // F. RFM
  // ---------------------------------------------------------------------------
  function segColors(t) { return [t.seg1, t.seg2, t.seg3, t.seg4]; }

  function rfmBar(id, segs, t, valueOf, fmt, axis, onPick, selected) {
    const total = segs.reduce((s, x) => s + valueOf(x), 0) || 1;
    const cols = segColors(t);
    return make(id, {
      type: 'bar',
      data: {
        labels: segs.map((s) => s.name),
        datasets: [{
          label: axis, data: segs.map(valueOf),
          backgroundColor: segs.map((s, i) => (selected && selected !== s.name ? alpha(hexOr(cols[i]), 0.35) : cols[i])),
          borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 56,
        }],
      },
      options: {
        onClick: (e, els) => { if (els.length) onPick(segs[els[0].index].name); },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        layout: { padding: { left: 6, right: 18 } },
        scales: {
          x: { grid: { display: false }, border: { color: t.axis }, ticks: ticks(t) },
          y: { beginAtZero: true, grace: '16%', grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { callback: fmt.axis, maxTicksLimit: 6 }), title: axisTitle(axis, t) },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ' ' + fmt.full(ctx.raw) + ' (' + Fmt.pct(ctx.raw / total) + ')' } },
          valueLabels: { color: t.text, format: (v) => fmt.label(v) + ' · ' + Fmt.pct(v / total, 0) },
        },
      },
    }, axis + ' by RFM segment');
  }
  function hexOr(c) { return /^#[0-9a-f]{6}$/i.test(c) ? c : '#2a78d6'; }

  // ---------------------------------------------------------------------------
  // G. Acquisition
  // ---------------------------------------------------------------------------
  function acquisition(a, t) {
    const labels = a.buckets.map((b) => b.short + (b.partial ? '*' : ''));
    return make('acq', {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Returning customers', data: a.acq.returning, backgroundColor: t.accent, stack: 'c', order: 2, maxBarThickness: 34, borderSkipped: 'start' },
          { type: 'bar', label: 'New customers', data: a.acq.newC, backgroundColor: t.series2, stack: 'c', order: 2, maxBarThickness: 34, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start' },
          { type: 'line', label: 'Cumulative unique customers', data: a.acq.cumulative, borderColor: t.text, backgroundColor: t.text, borderWidth: 2, pointRadius: 3, pointBorderWidth: 2, pointBorderColor: t.surface, stack: 'cum', order: 1, tension: 0.2, pointStyle: 'circle' },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, border: { color: t.axis }, ticks: ticks(t, { maxRotation: 0, autoSkipPadding: 10 }), title: axisTitle('Period (* = partial)', t) },
          y: { stacked: true, beginAtZero: true, grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { precision: 0, maxTicksLimit: 7 }), title: axisTitle('Customers', t) },
        },
        plugins: {
          legend: { labels: { usePointStyle: true } },
          tooltip: { callbacks: { title: (items) => a.buckets[items[0].dataIndex].label } },
        },
      },
    }, 'Stacked bars of new and returning customers per period with a cumulative line');
  }

  // ---------------------------------------------------------------------------
  // H. Risk
  // ---------------------------------------------------------------------------
  const CARD_ORDER = ['VISA', 'MC', 'AMEX'];
  function cardColor(card, t) {
    const i = CARD_ORDER.indexOf(card);
    return [t.accent, t.series2, t.series3][i] || (card === 'UNKNOWN' ? t.neutralMark : t.series4);
  }

  function cardMix(list, t) {
    const total = list.reduce((s, x) => s + x.cents, 0) || 1;
    return make('cardMix', {
      type: 'doughnut',
      data: {
        labels: list.map((x) => x.card),
        datasets: [{ data: list.map((x) => x.cents / 100), backgroundColor: list.map((x) => cardColor(x.card, t)), borderColor: t.surface, borderWidth: 2, hoverOffset: 4 }],
      },
      options: {
        cutout: '62%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ' ' + Fmt.money(ctx.raw) + ' (' + Fmt.pct((ctx.raw * 100) / total) + ')' } },
        },
      },
    }, 'Donut chart of revenue by card type');
  }

  function cardFail(list, t) {
    return make('cardFail', {
      type: 'bar',
      data: {
        labels: list.map((x) => x.card),
        datasets: [{ label: 'Failure rate', data: list.map((x) => (x.attempts ? (x.failed / x.attempts) * 100 : 0)), backgroundColor: t.bad, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 48 }],
      },
      options: {
        scales: {
          x: { grid: { display: false }, border: { color: t.axis }, ticks: ticks(t) },
          y: { beginAtZero: true, grace: '20%', grid: gridOpts(t), border: { display: false }, ticks: ticks(t, { callback: (v) => v + '%', maxTicksLimit: 5 }), title: axisTitle('Failed attempts', t) },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => { const x = list[ctx.dataIndex]; return ' ' + ctx.raw.toFixed(1) + '% — ' + x.failed + ' of ' + Fmt.int(x.attempts) + ' attempts'; } } },
          valueLabels: { color: t.text, format: (v, i) => v.toFixed(1) + '% (' + list[i].failed + '/' + Fmt.int(list[i].attempts) + ')' },
        },
      },
    }, 'Bar chart of failure rate by card type');
  }

  root.CCFormat = Fmt;
  root.CCCharts = {
    theme, configure, destroy, destroyAll, setEmpty, make, mix, alpha, hatch,
    revenue, pop, slopes, hbar, pareto, cadence, rfmBar, acquisition, cardMix, cardFail, cardColor, segColors,
    registry,
  };
})(window);
