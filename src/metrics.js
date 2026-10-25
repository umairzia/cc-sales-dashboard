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
    const recByBucket = zeros(), failByBucket = zeros();
    for (const c of retry.chains) for (const f of c.failures) recByBucket[idxOf(f.day)]++;
    for (const r of failed) if (r.cents > 0) failByBucket[idxOf(r.day)]++;
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

    // KPI deltas: last complete bucket vs the one before ------------------------
    const perBucket = {
      gross: s.gross, net,
      count: s.count,
      avg: s.gross.map((g, i) => (s.count[i] ? g / s.count[i] : null)),
      activeCustomers: s.customers.map((x) => x.size),
      successRate: s.attempts.map((a, i) => (a ? s.success[i] / a : null)),
      recoveryRate: failByBucket.map((f, i) => (f ? recByBucket[i] / f : null)),
      voidCents: s.voidCents,
    };
    let deltas = null;
    if (complete.length >= 2) {
      const a = complete[complete.length - 1], b = complete[complete.length - 2];
      deltas = { last: a, prev: b, lastLabel: buckets[a].short, prevLabel: buckets[b].short, values: {} };
      for (const k of Object.keys(perBucket)) {
        const cur = perBucket[k][a], prev = perBucket[k][b];
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
    const pop = buckets.map((b, i) => {
      if (i === 0 || b.partial || buckets[i - 1].partial || s.gross[i - 1] === 0) return null;
      return (s.gross[i] - s.gross[i - 1]) / s.gross[i - 1];
    });

    // Per-customer aggregates ------------------------------------------------------
    const cust = new Map();
    const getC = (r) => {
      let c = cust.get(r.customer);
      if (!c) cust.set(r.customer, (c = {
        name: r.customer, oneTime: r.oneTime, gross: 0, count: 0, firstDay: Infinity, lastDay: -Infinity,
        days: [], series: zeros(), attempts: 0, failed: 0, voidCount: 0, voidCents: 0, voidNotes: [],
      }));
      return c;
    };
    for (const r of sales) {
      const c = getC(r);
      c.gross += r.cents; c.count++;
      if (r.day < c.firstDay) c.firstDay = r.day;
      if (r.day > c.lastDay) c.lastDay = r.day;
      if (c.days[c.days.length - 1] !== r.day) c.days.push(r.day);
      c.series[idxOf(r.day)] += r.cents;
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

    // Average revenue per *active* bucket (buckets with ≥1 successful charge).
    const perActive = buyers.map((c) => {
      const active = c.series.filter((v) => v > 0).length;
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

    // Momentum: complete buckets only, named customers only -------------------------
    const momentum = { slopes: [], attention: [], quiet: [], completeCount: complete.length, unit };
    if (complete.length >= 4) {
      const c0 = complete[0], c1 = complete[complete.length - 1];
      for (const c of named) {
        const firstIdx = idxOf(c.firstDay);
        const startIdx = Math.max(c0, firstIdx);
        if (startIdx > c1) continue;
        const ys = c.series.slice(startIdx, c1 + 1);
        const activeN = ys.filter((v) => v > 0).length;
        if (ys.length < 4 || activeN < 3) continue;
        momentum.slopes.push({ name: c.name, slope: slope(ys) / 100, buckets: ys.length, active: activeN, gross: c.gross });
      }
      momentum.slopes.sort((a, b) => b.slope - a.slope || (a.name < b.name ? -1 : 1));
    }
    if (complete.length >= 6) {
      const recent = complete.slice(-3), base = complete.slice(-6, -3);
      momentum.window = { recent: recent.map((i) => buckets[i].short), base: base.map((i) => buckets[i].short) };
      for (const c of named) {
        const baseAvg = mean(base.map((i) => c.series[i]));
        const recentAvg = mean(recent.map((i) => c.series[i]));
        if (baseAvg <= 0) continue;
        const change = (recentAvg - baseAvg) / baseAvg;
        if (change <= -threshold) {
          momentum.attention.push({ name: c.name, baseAvg: baseAvg / 100, recentAvg: recentAvg / 100, change, gap: (baseAvg - recentAvg) / 100, since: to - c.lastDay });
        }
      }
      momentum.attention.sort((a, b) => b.gap - a.gap || (a.name < b.name ? -1 : 1));
    }
    if (complete.length >= 3) {
      const quietStart = buckets[complete[complete.length - 2]].start;
      momentum.quietSince = quietStart;
      momentum.quietLabels = complete.slice(-2).map((i) => buckets[i].short);
      momentum.quiet = named.filter((c) => c.lastDay < quietStart && c.count >= 2)
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
    const firstBucket = new Map(named.map((c) => [c.name, idxOf(c.firstDay)]));
    const acq = { newC: zeros(), returning: zeros(), cumulative: zeros() };
    s.customers.forEach((set, i) => {
      for (const name of set) { if (firstBucket.get(name) === i) acq.newC[i]++; else acq.returning[i]++; }
    });
    let cum = 0;
    acq.newC.forEach((n, i) => { cum += n; acq.cumulative[i] = cum; });

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
      buckets, complete, rollingWindow: w,
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
    ymd, dayOf, isoDate, longDate, UNITS, UNIT_LABEL, UNIT_NOUN, ROLLING, SEGMENTS, MONTHS, ONE_TIME, DAY_MS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
