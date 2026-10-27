/* metrics.js — every calculation, as pure functions over parsed rows.
 *
 * Money is held in integer cents throughout and only converted to dollars for
 * display, so totals are exact and match an independent pandas computation.
 * Days are integers (days since 1970-01-01, UTC calendar).
 */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ONE_TIME = 'One-Time Manual Charge';

  // ---------------------------------------------------------------------------
  // Calendar helpers
  // ---------------------------------------------------------------------------
  function ymd(day) {
    const d = new Date(day * DAY_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
  }
  const dayOf = (y, m, d) => Math.round(Date.UTC(y, m, d) / DAY_MS);
  const isoDate = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
  const longDate = (day) => { const t = ymd(day); return t.d + ' ' + MONTHS[t.m] + ' ' + t.y; };

  // ---------------------------------------------------------------------------
  // Adaptive bucketing
  // ---------------------------------------------------------------------------
  const UNITS = ['day', 'week', 'month', 'quarter'];
  const UNIT_LABEL = { day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly' };
  const UNIT_NOUN = { day: 'day', week: 'week', month: 'month', quarter: 'quarter' };
  // Rolling-average window per unit: 7-day, 4-week, 3-month, 4-quarter.
  const ROLLING = { day: 7, week: 4, month: 3, quarter: 4 };

  /** Span thresholds (inclusive day count, first to last transaction):
   *  ≤ 60 days → daily, ≤ 183 (~6 months) → weekly, < 1826 (5 full years) →
   *  monthly, otherwise quarterly. See README for the 5-year boundary note. */
  function autoUnit(spanDays) {
    if (spanDays <= 60) return 'day';
    if (spanDays <= 183) return 'week';
    if (spanDays < 1826) return 'month';
    return 'quarter';
  }

  function bucketStart(day, unit) {
    if (unit === 'day') return day;
    if (unit === 'week') return day - (((day + 3) % 7) + 7) % 7; // ISO week, Monday start
    const t = ymd(day);
    if (unit === 'month') return dayOf(t.y, t.m, 1);
    return dayOf(t.y, t.m - (t.m % 3), 1);
  }

  function nextStart(start, unit) {
    if (unit === 'day') return start + 1;
    if (unit === 'week') return start + 7;
    const t = ymd(start);
    return dayOf(t.y, t.m + (unit === 'month' ? 1 : 3), 1);
  }

  function bucketLabels(start, unit) {
    const t = ymd(start);
    const yy = "'" + String(t.y).slice(2);
    if (unit === 'day') return { label: longDate(start), short: t.d + ' ' + MONTHS[t.m] };
    if (unit === 'week') return { label: 'Week of ' + longDate(start), short: t.d + ' ' + MONTHS[t.m] + ' ' + yy };
    if (unit === 'month') return { label: MONTHS[t.m] + ' ' + t.y, short: MONTHS[t.m] + ' ' + yy };
    const qn = Math.floor(t.m / 3) + 1;
    return { label: 'Q' + qn + ' ' + t.y, short: 'Q' + qn + ' ' + yy };
  }

  /** Contiguous buckets covering [from, to]. A bucket is `partial` when the
   *  active range starts after its first day or ends before its last day. */
  function buildBuckets(from, to, unit) {
    const out = [];
    for (let s = bucketStart(from, unit); s <= to; s = nextStart(s, unit)) {
      const end = nextStart(s, unit) - 1;
      const lab = bucketLabels(s, unit);
      out.push({ start: s, end, label: lab.label, short: lab.short, partial: s < from || end > to });
    }
    return out;
  }

  function makeIndexer(buckets) {
    const first = buckets[0].start;
    const unit = buckets.unit;
    if (unit === 'day') return (day) => day - first;
    if (unit === 'week') return (day) => Math.floor((day - first) / 7);
    // Month / quarter: binary search on starts.
    return (day) => {
      let lo = 0, hi = buckets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (buckets[mid].start <= day) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
  }

  // ---------------------------------------------------------------------------
  // Timeframe profiles. The chart grouping (above) only decides how bars are
  // drawn; the profile decides what each comparison means for this much
  // history, so a 3-week, 3-month or 3-year export each gets the version of
  // every metric that is meaningful for it. Calibrated on real exports: about
  // 75% of customers order at least every 14 days and ~95% at least every 35,
  // so customer tracking never uses periods shorter than a week, short exports
  // compare two weeks with two weeks, and "new customer" needs a 35–45 day
  // settling-in window (which a few weeks of data can't provide).
  // ---------------------------------------------------------------------------
  const TIMEFRAMES = [
    { key: 'short', maxDays: 45, label: 'a few weeks', period: 'week', compare: 'trailing', compareDays: [7],
      recent: 2, base: 2, trendMin: 3, trendActive: 2, warmupDays: null },
    { key: 'medium', maxDays: 183, label: 'a few months', period: 'week', compare: 'trailing', compareDays: [28, 14, 7],
      recent: 4, base: 4, trendMin: 4, trendActive: 3, warmupDays: 35 },
    { key: 'long', maxDays: 395, label: 'about a year', period: 'month', compare: 'month',
      recent: 3, base: 3, trendMin: 4, trendActive: 3, warmupDays: 45 },
    { key: 'multi', maxDays: Infinity, label: 'more than a year', period: 'month', compare: 'yoy', yoy: true,
      recent: 3, base: 3, trendMin: 4, trendActive: 3, trendMax: 12, warmupDays: 45 },
  ];
  const timeframeOf = (spanDays) => TIMEFRAMES.find((t) => spanDays <= t.maxDays);
  const dayShort = (day) => { const t = ymd(day); return t.d + ' ' + MONTHS[t.m]; };
  const dayRange = (lo, hi) => (ymd(lo).m === ymd(hi).m ? ymd(lo).d + '–' + dayShort(hi) : dayShort(lo) + '–' + dayShort(hi));

  /** Periods used to track customers: 7-day windows counted back from the
   *  last day of the range (every one complete), or complete calendar months. */
  function trackingPeriods(from, to, period) {
    if (period === 'week') {
      const K = Math.floor((to - from + 1) / 7);
      const out = [];
      for (let k = K - 1; k >= 0; k--) { const hi = to - 7 * k; out.push({ start: hi - 6, end: hi, label: dayRange(hi - 6, hi) }); }
      return out;
    }
    return buildBuckets(from, to, 'month').filter((b) => !b.partial).map((b) => ({ start: b.start, end: b.end, label: b.short }));
  }
  /** Index of the period containing `day`, -1 before the first, P after the last. */
  function periodIndex(periods, day) {
    if (!periods.length || day < periods[0].start) return -1;
    let lo = 0, hi = periods.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (periods[mid].start <= day) lo = mid; else hi = mid - 1; }
    return day <= periods[lo].end ? lo : periods.length;
  }

  // ---------------------------------------------------------------------------
  // Small numeric helpers
  // ---------------------------------------------------------------------------
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);

  /** Ordinary least squares slope of y against x = 0..n-1. */
  function slope(ys) {
    const n = ys.length;
    if (n < 2) return 0;
    const xm = (n - 1) / 2;
    const ym = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i] - ym); den += (i - xm) * (i - xm); }
    return den ? num / den : 0;
  }

  /** pandas `qcut(series.rank(method='first'), 4)` → 1..4, ties broken by the
   *  order of `items` (callers sort by customer name first, as the verifier does). */
  function quartileScores(values) {
    const n = values.length;
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b] || a - b);
    const rank = new Array(n);
    order.forEach((idx, pos) => { rank[idx] = pos + 1; });
    const edges = [1, 2, 3].map((k) => 1 + ((n - 1) * k) / 4);
    return rank.map((r) => 1 + edges.filter((e) => r > e).length);
  }

  function segmentOf(score) {
    if (score >= 10) return 'High-Value Regular';
    if (score >= 7) return 'Loyal';
    if (score >= 5) return 'At Risk';
    return 'Dormant';
  }
  const SEGMENTS = ['High-Value Regular', 'Loyal', 'At Risk', 'Dormant'];

  // ---------------------------------------------------------------------------
  // Retry chains
  // ---------------------------------------------------------------------------
  /** Group (customer, amount, card type). Walk each group in time order:
   *  consecutive Failed attempts followed by a Batched one form one chain.
   *  Only the Batched row is revenue; failed rows never are. */
  function retryChains(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (r.cents <= 0 || (r.status !== 'Failed' && r.status !== 'Batched')) continue;
      const key = r.customer + '\u0000' + r.cents + '\u0000' + r.card;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(r);
    }
    const chains = [];
    const unrecovered = [];
    let failedTotal = 0;
    let mixedGroups = 0;
    for (const g of groups.values()) {
      let hasF = false, hasB = false;
      let pending = [];
      for (const r of g) { // rows arrive sorted by day, second, line
        if (r.status === 'Failed') { hasF = true; failedTotal++; pending.push(r); continue; }
        hasB = true;
        if (pending.length) {
          chains.push({
            customer: r.customer, oneTime: r.oneTime, cents: r.cents, card: r.card,
            attempts: pending.length + 1, failures: pending.slice(),
            firstFailDay: pending[0].day, successDay: r.day, days: r.day - pending[0].day,
          });
          pending = [];
        }
      }
      unrecovered.push(...pending);
      if (hasF && hasB) mixedGroups++;
    }
    const recovered = sum(chains.map((c) => c.attempts - 1));
    const attemptsDist = {};
    chains.forEach((c) => { attemptsDist[c.attempts] = (attemptsDist[c.attempts] || 0) + 1; });
    return {
      chains, unrecovered, failedTotal, recovered, mixedGroups, attemptsDist,
      recoveryRate: failedTotal ? recovered / failedTotal : null,
      avgDays: chains.length ? mean(chains.map((c) => c.days)) : null,
      recoveredCents: sum(chains.map((c) => c.cents)),
    };
  }

  // ---------------------------------------------------------------------------
  // Main analysis
  // ---------------------------------------------------------------------------
  /**
   * @param {Array} allRows  parsed rows (sorted by day/second/line)
   * @param {Object} opt     { from, to, unit ('auto'|...), status ('all'|'success'), threshold (0..1) }
   */
  function analyse(allRows, opt) {
    opt = opt || {};
    const dataMin = allRows[0].day;
    const dataMax = allRows[allRows.length - 1].day;
    // The range may extend past the first/last transaction (the app allows up
    // to the surrounding month boundaries) so a user can declare that their
    // export genuinely covers a whole first/last month — it is then "complete".
    const from = opt.from != null ? opt.from : dataMin;
    const to = opt.to != null ? opt.to : dataMax;
    const spanDays = to - from + 1;
    const unit = opt.unit && opt.unit !== 'auto' ? opt.unit : autoUnit(spanDays);
    const tf = timeframeOf(spanDays);
    const threshold = opt.threshold != null ? opt.threshold : 0.25;
    const successOnly = opt.status === 'success';

    const inRange = allRows.filter((r) => r.day >= from && r.day <= to);
    const scope = successOnly ? inRange.filter((r) => r.status === 'Batched') : inRange;
    if (!scope.length) return { empty: true, from, to, unit, dataMin, dataMax };

    const buckets = buildBuckets(from, to, unit);
    buckets.unit = unit;
    const B = buckets.length;
    const idxOf = makeIndexer(buckets);
    const complete = buckets.map((b, i) => (b.partial ? -1 : i)).filter((i) => i >= 0);

    // Row classes ------------------------------------------------------------
    const sales = scope.filter((r) => r.status === 'Batched' && r.cents > 0);   // revenue rows
    const refunds = scope.filter((r) => r.status === 'Batched' && r.cents < 0); // credits / chargebacks
    const attempts = scope.filter((r) => r.cents >= 0);                          // charge attempts
    const failed = attempts.filter((r) => r.status === 'Failed');
    const voided = scope.filter((r) => r.status === 'Voided');

    // Per-bucket series --------------------------------------------------------
    const zeros = () => new Array(B).fill(0);
    const s = {
      gross: zeros(), refunds: zeros(), count: zeros(), attempts: zeros(), attemptsExVoid: zeros(),
      success: zeros(), failed: zeros(), voidCents: zeros(), voidCount: zeros(),
      customers: buckets.map(() => new Set()),
    };
    for (const r of sales) { const i = idxOf(r.day); s.gross[i] += r.cents; s.count[i]++; if (!r.oneTime) s.customers[i].add(r.customer); }
    for (const r of refunds) s.refunds[idxOf(r.day)] += -r.cents;
    for (const r of attempts) {
      const i = idxOf(r.day);
      s.attempts[i]++;
      if (r.status !== 'Voided') s.attemptsExVoid[i]++;
      if (r.status === 'Batched') s.success[i]++;
      if (r.status === 'Failed') s.failed[i]++;
    }
    for (const r of voided) { const i = idxOf(r.day); s.voidCents[i] += r.cents; s.voidCount[i]++; }
    const net = s.gross.map((g, i) => g - s.refunds[i]);

    // Retry chains (within the active range) ---------------------------------
    const retry = retryChains(scope);
    // Context only: unrecovered failures where the customer had some other
    // successful charge (any amount / card) within 7 days afterwards.
    const salesByCust = new Map();
    for (const r of sales) { if (!salesByCust.has(r.customer)) salesByCust.set(r.customer, []); salesByCust.get(r.customer).push(r); }
    const looseRecovered = retry.unrecovered.filter((f) => !f.oneTime &&
      (salesByCust.get(f.customer) || []).some((x) => (x.day > f.day || (x.day === f.day && x.second > f.second)) && x.day - f.day <= 7)).length;

    // Totals -------------------------------------------------------------------
    const gross = sum(s.gross);
    const refundTotal = sum(s.refunds);
    const namedActive = new Set(sales.filter((r) => !r.oneTime).map((r) => r.customer));
    const successCount = attempts.filter((r) => r.status === 'Batched').length;
    const attemptsExVoid = attempts.filter((r) => r.status !== 'Voided').length;
    const totals = {
      gross, refunds: refundTotal, net: gross - refundTotal, refundCount: refunds.length,
      count: sales.length, avg: sales.length ? gross / sales.length : 0,
      activeCustomers: namedActive.size, oneTimeCharges: sales.filter((r) => r.oneTime).length,
      attempts: attempts.length,
      successRate: successOnly ? null : attempts.length ? successCount / attempts.length : null,
      successRateExVoids: successOnly ? null : attemptsExVoid ? successCount / attemptsExVoid : null,
      recoveryRate: successOnly ? null : retry.recoveryRate,
      voidCents: sum(s.voidCents), voidCount: voided.length,
      failedCount: failed.length, failedCents: sum(failed.map((r) => r.cents)),
    };

    // KPI deltas: two equal windows chosen by the timeframe ------------------------
    //   short/medium: the last 7 (or 28) days vs the 7 (or 28) before;
    //   about a year: last complete month vs the month before;
    //   more than a year: last complete month vs the same month a year earlier.
    const recoveredSet = new Set(retry.chains.flatMap((c) => c.failures));
    const windowStats = (lo, hi) => {
      const inW = (r) => r.day >= lo && r.day <= hi;
      const sl = sales.filter(inW), at = attempts.filter(inW), fl = failed.filter((r) => r.cents > 0 && inW(r));
      const g = sum(sl.map((r) => r.cents));
      return {
        gross: g, net: g - sum(refunds.filter(inW).map((r) => -r.cents)), count: sl.length, avg: sl.length ? g / sl.length : null,
        activeCustomers: new Set(sl.filter((r) => !r.oneTime).map((r) => r.customer)).size,
        successRate: at.length ? at.filter((r) => r.status === 'Batched').length / at.length : null,
        recoveryRate: fl.length ? fl.filter((r) => recoveredSet.has(r)).length / fl.length : null,
        voidCents: sum(voided.filter(inW).map((r) => r.cents)),
      };
    };
    let cmp = null;
    if (tf.compare === 'trailing') {
      const W = tf.compareDays.find((d) => 2 * d <= spanDays);
      if (W) {
        const n = W === 7 ? '7 days' : (W / 7) + ' weeks';
        cmp = { kind: 'trailing', a: [to - W + 1, to], b: [to - 2 * W + 1, to - W], label: 'Last ' + n + ' vs previous ' + n,
          title: dayRange(to - W + 1, to) + ' compared with ' + dayRange(to - 2 * W + 1, to - W) };
      }
    } else {
      const months = buildBuckets(from, to, 'month').filter((b) => !b.partial);
      const last = months[months.length - 1];
      const yearAgo = last && months.find((b) => b.start === dayOf(ymd(last.start).y - 1, ymd(last.start).m, 1));
      const prev = months[months.length - 2];
      const other = tf.compare === 'yoy' && yearAgo ? yearAgo : prev;
      if (last && other) {
        cmp = { kind: other === yearAgo ? 'yoy' : 'month', a: [last.start, last.end], b: [other.start, other.end],
          label: last.short + ' vs ' + other.short,
          title: other === yearAgo ? last.label + ' compared with the same month a year earlier (' + other.label + '), so seasonal swings cancel out'
            : last.label + ' (the last complete month) compared with ' + other.label };
      }
    }
    let deltas = null;
    if (cmp) {
      const A = windowStats(cmp.a[0], cmp.a[1]), Bw = windowStats(cmp.b[0], cmp.b[1]);
      deltas = Object.assign({}, cmp, { values: {} });
      for (const k of Object.keys(A)) {
        const cur = A[k], prev = Bw[k];
        const isRate = k === 'successRate' || k === 'recoveryRate';
        deltas.values[k] = {
          cur, prev,
          change: cur == null || prev == null ? null : isRate ? cur - prev : prev === 0 ? null : (cur - prev) / Math.abs(prev),
          kind: isRate ? 'pp' : 'pct',
        };
      }
    }

    // Revenue over time ----------------------------------------------------------
    const w = ROLLING[unit];
    const rolling = buckets.map((b, i) => {
      if (i < w - 1) return null;
      for (let j = i - w + 1; j <= i; j++) if (buckets[j].partial) return null;
      return mean(s.gross.slice(i - w + 1, i + 1));
    });
    let hi = null, lo = null;
    for (const i of complete) {
      if (hi === null || s.gross[i] > s.gross[hi]) hi = i;
      if (lo === null || s.gross[i] < s.gross[lo]) lo = i;
    }
    // % change against a comparable earlier period: the same weekday a week
    // before for daily bars (weekends would otherwise swing ±100%), the same
    // month/quarter a year before once there is more than a year of data.
    const lag = unit === 'day' ? 7 : tf.yoy && unit === 'month' ? 12 : tf.yoy && unit === 'quarter' ? 4 : 1;
    const pop = buckets.map((b, i) => {
      const j = i - lag;
      if (j < 0 || b.partial || buckets[j].partial || s.gross[j] === 0) return null;
      return (s.gross[i] - s.gross[j]) / s.gross[j];
    });

    // Per-customer aggregates ------------------------------------------------------
    const cust = new Map();
    const getC = (r) => {
      let c = cust.get(r.customer);
      if (!c) cust.set(r.customer, (c = {
        name: r.customer, oneTime: r.oneTime, gross: 0, count: 0, firstDay: Infinity, lastDay: -Infinity,
        days: [], attempts: 0, failed: 0, voidCount: 0, voidCents: 0, voidNotes: [],
      }));
      return c;
    };
    for (const r of sales) {
      const c = getC(r);
      c.gross += r.cents; c.count++;
      if (r.day < c.firstDay) c.firstDay = r.day;
      if (r.day > c.lastDay) c.lastDay = r.day;
      if (c.days[c.days.length - 1] !== r.day) c.days.push(r.day);
    }
    for (const r of attempts) { const c = getC(r); c.attempts++; if (r.status === 'Failed') c.failed++; }
    for (const r of voided) { const c = getC(r); c.voidCount++; c.voidCents += r.cents; if (r.voidNote && !c.voidNotes.includes(r.voidNote)) c.voidNotes.push(r.voidNote); }

    const buyers = [...cust.values()].filter((c) => c.count > 0);
    const named = buyers.filter((c) => !c.oneTime);
    const oneTimeCust = buyers.find((c) => c.oneTime) || null;
    const byGross = (a, b) => b.gross - a.gross || (a.name < b.name ? -1 : 1);

    const top15 = buyers.slice().sort(byGross).slice(0, 15);

    // Pareto: named customers by revenue, the one-time aggregate placed last.
    const paretoList = named.slice().sort(byGross).concat(oneTimeCust ? [oneTimeCust] : []);
    let run = 0;
    const pareto = paretoList.map((c, i) => { run += c.gross; return { rank: i + 1, name: c.name, oneTime: c.oneTime, cumShare: gross ? run / gross : 0 }; });
    const namedSorted = named.slice().sort(byGross);
    const topShare = (k) => (gross ? sum(namedSorted.slice(0, k).map((c) => c.gross)) / gross : 0);
    const n80 = pareto.findIndex((p) => p.cumShare >= 0.8) + 1 || null;
    const concentration = { top5: topShare(5), top10: topShare(10), top20: topShare(20), n80, customers: paretoList.length, risk: topShare(5) > 0.25 };

    // Average revenue per *active* week/month (calendar periods with ≥1
    // successful charge); weeks for exports of up to ~6 months, else months.
    const activeOf = new Map();
    for (const r of sales) {
      if (!activeOf.has(r.customer)) activeOf.set(r.customer, new Set());
      activeOf.get(r.customer).add(bucketStart(r.day, tf.period));
    }
    const perActive = buyers.map((c) => {
      const active = activeOf.get(c.name).size;
      return { name: c.name, oneTime: c.oneTime, avg: active ? c.gross / active : 0, active };
    }).sort((a, b) => b.avg - a.avg || (a.name < b.name ? -1 : 1)).slice(0, 20);

    // Payment cadence: mean gap between distinct successful-charge days.
    const cadence = named.filter((c) => c.days.length >= 3).map((c) => {
      const gaps = c.days.slice(1).map((d, i) => d - c.days[i]);
      const avg = mean(gaps);
      const since = to - c.lastDay;
      return { name: c.name, avgGap: avg, since, ratio: avg ? since / avg : null, gross: c.gross, chargeDays: c.days.length };
    }).sort((a, b) => a.avgGap - b.avgGap || (a.name < b.name ? -1 : 1));
    const drifting = cadence.filter((c) => c.since >= 7 && c.ratio >= 2).sort((a, b) => b.gross - a.gross);

    // Momentum: named customers, tracked by week or month per the timeframe ----------
    const periods = trackingPeriods(from, to, tf.period);
    const P = periods.length;
    const momentum = { slopes: [], attention: [], quiet: [], periods: P, periodNoun: tf.period, timeframe: tf.key, needTrend: tf.trendMin };
    const pseries = new Map(named.map((c) => [c.name, new Array(P).fill(0)]));
    for (const r of sales) {
      if (r.oneTime) continue;
      const i = periodIndex(periods, r.day);
      if (i >= 0 && i < P) pseries.get(r.customer)[i] += r.cents;
    }
    const gapOf = new Map(cadence.map((c) => [c.name, c.avgGap]));
    // Trend: linear slope per period (the last 12 months for multi-year exports).
    const t0 = tf.trendMax ? Math.max(0, P - tf.trendMax) : 0;
    momentum.trendFrom = P ? periods[t0].label : null;
    momentum.trendTo = P ? periods[P - 1].label : null;
    if (P - t0 >= tf.trendMin) {
      for (const c of named) {
        const first = periodIndex(periods, c.firstDay);
        if (first >= P) continue;
        const ys = pseries.get(c.name).slice(Math.max(t0, first, 0));
        const activeN = ys.filter((v) => v > 0).length;
        if (ys.length < tf.trendMin || activeN < tf.trendActive) continue;
        momentum.slopes.push({ name: c.name, slope: slope(ys) / 100, buckets: ys.length, active: activeN, gross: c.gross });
      }
      momentum.slopes.sort((a, b) => b.slope - a.slope || (a.name < b.name ? -1 : 1));
    }
    // Needs attention: recent periods vs a baseline (same months a year earlier
    // when there is enough history, so seasonality doesn't raise false alarms).
    let rIdx = null, bIdx = null, wKind = 'sequential';
    if (tf.yoy && P >= tf.recent + 12) {
      rIdx = [...Array(tf.recent).keys()].map((k) => P - tf.recent + k);
      bIdx = rIdx.map((i) => i - 12);
      wKind = 'yoy';
    } else if (P >= 2) {
      const R = P >= tf.recent + tf.base ? tf.recent : Math.max(1, Math.floor(P / 2));
      const Bn = Math.min(tf.base, P - R);
      rIdx = [...Array(R).keys()].map((k) => P - R + k);
      bIdx = [...Array(Bn).keys()].map((k) => P - R - Bn + k);
    }
    if (rIdx) {
      const span = (idx) => (tf.period === 'week' ? dayRange(periods[idx[0]].start, periods[idx[idx.length - 1]].end)
        : idx.length === 1 ? periods[idx[0]].label : periods[idx[0]].label + ' – ' + periods[idx[idx.length - 1]].label);
      momentum.window = { kind: wKind, recent: span(rIdx), base: span(bIdx), recentN: rIdx.length, baseN: bIdx.length };
      for (const c of named) {
        const ys = pseries.get(c.name);
        const baseAvg = mean(bIdx.map((i) => ys[i]));
        const recentAvg = mean(rIdx.map((i) => ys[i]));
        if (baseAvg <= 0) continue;
        const change = (recentAvg - baseAvg) / baseAvg;
        if (change <= -threshold) {
          momentum.attention.push({ name: c.name, baseAvg: baseAvg / 100, recentAvg: recentAvg / 100, change, gap: (baseAvg - recentAvg) / 100, since: to - c.lastDay });
        }
      }
      momentum.attention.sort((a, b) => b.gap - a.gap || (a.name < b.name ? -1 : 1));
    }
    // Gone quiet: nothing in the last 2 periods (or since), after buying before,
    // and longer than twice the customer's own usual gap when that is known.
    if (P >= 3) {
      const quietStart = periods[P - 2].start;
      momentum.quietSince = quietStart;
      momentum.quietLabels = [periods[P - 2].label, periods[P - 1].label];
      momentum.quiet = named.filter((c) => c.lastDay < quietStart && c.count >= 2 && !(gapOf.has(c.name) && to - c.lastDay <= 2 * gapOf.get(c.name)))
        .map((c) => ({ name: c.name, gross: c.gross / 100, lastDay: c.lastDay, since: to - c.lastDay, count: c.count }))
        .sort((a, b) => b.gross - a.gross || (a.name < b.name ? -1 : 1));
    }

    // RFM ----------------------------------------------------------------------------
    let rfm = null;
    if (named.length >= 4) {
      const list = named.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const rec = list.map((c) => to - c.lastDay);
      const fScore = quartileScores(list.map((c) => c.count));
      const mScore = quartileScores(list.map((c) => c.gross));
      const rScore = quartileScores(rec).map((x) => 5 - x); // fewer days since = better
      const members = list.map((c, i) => {
        const score = rScore[i] + fScore[i] + mScore[i];
        return { name: c.name, recency: rec[i], frequency: c.count, monetary: c.gross / 100, r: rScore[i], f: fScore[i], m: mScore[i], score, segment: segmentOf(score) };
      });
      const segs = SEGMENTS.map((name) => {
        const m = members.filter((x) => x.segment === name);
        return { name, count: m.length, revenue: sum(m.map((x) => x.monetary)) };
      });
      rfm = { members, segments: segs };
    }

    // Acquisition -------------------------------------------------------------------
    // Customers first seen in the opening weeks were almost certainly customers
    // already (the export just starts mid-relationship), so "new" only counts
    // first purchases after that settling-in window.
    // (warmupDays null = too little history to tell new from existing at all.)
    const newKnown = tf.warmupDays != null && spanDays > tf.warmupDays;
    const warmEnd = newKnown ? from + tf.warmupDays - 1 : to;
    const firstBucket = new Map(named.map((c) => [c.name, c.firstDay > warmEnd ? idxOf(c.firstDay) : -1]));
    const acq = { newC: zeros(), returning: zeros(), cumulative: zeros(), newKnown, warmupDays: tf.warmupDays, existingAtStart: named.filter((c) => c.firstDay <= warmEnd).length };
    s.customers.forEach((set, i) => {
      for (const name of set) { if (firstBucket.get(name) === i) acq.newC[i]++; else acq.returning[i]++; }
    });
    const seen = new Set();
    s.customers.forEach((set, i) => { for (const name of set) seen.add(name); acq.cumulative[i] = seen.size; });

    // Risk & operations -----------------------------------------------------------------
    const MIN_TX = 10;
    const failureByCustomer = [...cust.values()].filter((c) => c.attempts >= MIN_TX && c.failed > 0)
      .map((c) => ({ name: c.name, oneTime: c.oneTime, rate: c.failed / c.attempts, failed: c.failed, attempts: c.attempts }))
      .sort((a, b) => b.rate - a.rate || b.failed - a.failed || (a.name < b.name ? -1 : 1));
    const eligibleForFailure = [...cust.values()].filter((c) => c.attempts >= MIN_TX).length;
    const cards = {};
    for (const r of attempts) {
      const k = r.card;
      if (!cards[k]) cards[k] = { card: k, cents: 0, count: 0, attempts: 0, failed: 0 };
      cards[k].attempts++;
      if (r.status === 'Failed') cards[k].failed++;
      if (r.status === 'Batched' && r.cents > 0) { cards[k].cents += r.cents; cards[k].count++; }
    }
    const cardMix = Object.values(cards).sort((a, b) => b.cents - a.cents || b.attempts - a.attempts);
    const reasons = {};
    for (const r of failed) {
      const k = r.reason || 'Failed';
      if (!reasons[k]) reasons[k] = { reason: k, count: 0, cents: 0 };
      reasons[k].count++; reasons[k].cents += r.cents;
    }
    const voidCustomers = [...cust.values()].filter((c) => c.voidCount > 0)
      .map((c) => ({ name: c.name, oneTime: c.oneTime, count: c.voidCount, cents: c.voidCents, notes: c.voidNotes }))
      .sort((a, b) => b.cents - a.cents || b.count - a.count);

    // Year over year: complete calendar months laid out by year -----------------------
    let yoy = null;
    if (tf.yoy) {
      const months = buildBuckets(from, to, 'month');
      const byMonth = new Map(months.map((b) => [b.start, 0]));
      for (const r of sales) byMonth.set(bucketStart(r.day, 'month'), byMonth.get(bucketStart(r.day, 'month')) + r.cents);
      const years = [];
      for (const b of months) {
        const t = ymd(b.start);
        let y = years.find((x) => x.year === t.y);
        if (!y) years.push((y = { year: t.y, months: new Array(12).fill(null) }));
        if (!b.partial) y.months[t.m] = byMonth.get(b.start);
      }
      years.forEach((y) => { y.complete = y.months.every((v) => v !== null); y.total = y.complete ? sum(y.months) : null; });
      years.forEach((y, i) => { const p = years[i - 1]; y.change = y.complete && p && p.complete && p.total ? (y.total - p.total) / p.total : null; });
      // Year to date: the latest year's complete months vs the same months a year earlier.
      const cur = years[years.length - 1], prv = years[years.length - 2];
      let ytd = null;
      if (cur && prv) {
        const ms = cur.months.map((v, m) => m).filter((m) => cur.months[m] !== null && prv.months[m] !== null);
        if (ms.length) {
          const a = sum(ms.map((m) => cur.months[m])), b = sum(ms.map((m) => prv.months[m]));
          ytd = { year: cur.year, prevYear: prv.year, months: ms.map((m) => MONTHS[m]), cur: a, prev: b, change: b ? (a - b) / b : null };
        }
      }
      yoy = { years, ytd };
    }

    // Data-quality items that depend on the analysis -------------------------------------
    const dupMap = new Map();
    for (const r of sales.concat(refunds)) {
      const k = r.customer + '\u0000' + r.cents + '\u0000' + r.card + '\u0000' + r.day;
      if (!dupMap.has(k)) dupMap.set(k, []);
      dupMap.get(k).push(r);
    }
    const duplicates = [...dupMap.values()].filter((g) => g.length > 1)
      .map((g) => ({ customer: g[0].customer, cents: g[0].cents, card: g[0].card, day: g[0].day, rows: g.length, lines: g.map((r) => r.line) }));

    return {
      from, to, spanDays, unit, autoUnit: autoUnit(spanDays), dataMin, dataMax, successOnly, threshold,
      timeframe: tf, buckets, complete, rollingWindow: w, popLag: lag, yoy, perActiveNoun: tf.period,
      runRate: { perWeek: (gross / spanDays) * 7, perMonth: (gross / spanDays) * (365.25 / 12) },
      series: { gross: s.gross, net, refunds: s.refunds, count: s.count, rolling, pop, hi, lo },
      totals, deltas, retry: Object.assign({}, retry, { looseRecovered }),
      top15, pareto, concentration, perActive, cadence, drifting, momentum, rfm, acq,
      risk: { MIN_TX, failureByCustomer, eligibleForFailure, cardMix, reasons: Object.values(reasons).sort((a, b) => b.count - a.count), voidCustomers },
      duplicates, rowsInScope: scope.length, rowsInRange: inRange.length,
      oneTime: oneTimeCust ? { gross: oneTimeCust.gross, count: oneTimeCust.count } : null,
    };
  }

  const api = {
    analyse, retryChains, buildBuckets, bucketStart, nextStart, autoUnit, slope, quartileScores, segmentOf,
    TIMEFRAMES, timeframeOf, trackingPeriods, periodIndex, dayRange,
    ymd, dayOf, isoDate, longDate, UNITS, UNIT_LABEL, UNIT_NOUN, ROLLING, SEGMENTS, MONTHS, ONE_TIME, DAY_MS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
