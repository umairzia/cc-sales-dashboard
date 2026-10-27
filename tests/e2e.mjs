#!/usr/bin/env node
/* End-to-end check of the built dashboard in headless Chromium.
 *
 *   node tests/e2e.mjs <file.csv> --out <dir> [--name n] [--expect-unit week]
 *        [--expect-error "substring"] [--screenshot] [--dark] [--pdf] [--interact]
 *
 * - Opens dashboard.html from file:// (no server) in an OFFLINE browser context
 *   and fails if the page attempts any non-file network request.
 * - Loads the CSV through the real <input type=file>, waits for render.
 * - Fails on any console error or uncaught exception.
 * - Writes <out>/<name>.json with the dashboard's own numbers (for
 *   tests/verify_metrics.py) and optional screenshots / PDF.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const csv = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--') || ['--screenshot', '--dark', '--pdf', '--interact', '--empty-shot', '--hero-shot'].includes(args[i - 1])));
if (!csv) { console.error('usage: node tests/e2e.mjs <file.csv> --out <dir> [...]'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const html = resolve(opt('--html', resolve(here, '..', 'dashboard.html')));
const out = resolve(opt('--out', resolve(here, 'output')));
const name = opt('--name', basename(csv).replace(/\.[^.]+$/, ''));
mkdirSync(out, { recursive: true });

const failures = [];
const fail = (m) => { failures.push(m); };

const browser = await chromium.launch();
const [vw, vh] = opt('--viewport', '1440x1000').split('x').map(Number);
const ctx = await browser.newContext({ offline: true, viewport: { width: vw, height: vh }, deviceScaleFactor: 1, colorScheme: flag('--dark') ? 'dark' : 'light' });
const page = await ctx.newPage();
const external = [];
page.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) external.push(u); });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const url = pathToFileURL(html).href;
await page.goto(url);
if (!url.startsWith('file://')) fail('not loaded from file://');
if ((await page.getAttribute('#app', 'data-state')) !== 'empty') fail('initial state is not the empty state');
if (flag('--screenshot') && flag('--empty-shot')) await page.screenshot({ path: resolve(out, name + '-empty.png'), fullPage: true });

// Optional customer-groups file, loaded through the dialog's real file input.
if (opt('--groups')) await page.setInputFiles('#grpLoadInput', resolve(opt('--groups')));
await page.setInputFiles('#fileInput', resolve(csv));
await page.waitForFunction(() => document.getElementById('app').dataset.state !== 'empty', null, { timeout: 30000 });
const stateNow = await page.getAttribute('#app', 'data-state');
const result = { name, csv: basename(csv), state: stateNow };

const expectError = opt('--expect-error');
if (expectError) {
  const msg = (await page.textContent('#errorMsg')) + ' ' + (await page.textContent('#errorDetail'));
  result.error = msg.trim();
  if (stateNow !== 'error') fail('expected an error state, got ' + stateNow);
  else if (!msg.toLowerCase().includes(expectError.toLowerCase())) fail('error message "' + msg + '" does not contain "' + expectError + '"');
  if (flag('--screenshot')) await page.screenshot({ path: resolve(out, name + '.png'), fullPage: false });
} else {
  if (stateNow !== 'ready') fail('expected dashboard to render, got state ' + stateNow + ': ' + (await page.textContent('#errorMsg')));
  else {
    result.summary = await page.evaluate(() => window.ccDashboard.summary());
    result.charts = await page.evaluate(() => Object.keys(window.CCCharts.registry).sort());
    result.emptyCharts = await page.evaluate(() => Array.from(document.querySelectorAll('.chart-empty')).filter((n) => n.offsetParent).map((n) => n.parentElement.querySelector('canvas').id + ': ' + n.textContent));
    // Every chart box must show either a drawn chart or a designed empty message.
    const blank = await page.evaluate(() => Array.from(document.querySelectorAll('.chart-box canvas')).filter((c) => c.offsetParent && !window.CCCharts.registry[c.id.slice(2)] && !c.parentElement.querySelector('.chart-empty')).map((c) => c.id));
    if (blank.length) fail('chart boxes with neither a chart nor an empty message: ' + blank.join(', '));
    const kpis = await page.$$eval('.kpi-value', (n) => n.map((x) => x.textContent));
    if (kpis.length !== 8) fail('expected 8 KPI tiles, found ' + kpis.length);
    if (kpis.some((k) => /NaN|undefined|Infinity/.test(k))) fail('bad KPI text: ' + kpis.join(' | '));
    const bodyText = await page.textContent('#dashboard');
    if (/NaN|undefined|\[object/.test(bodyText)) fail('page text contains NaN/undefined/[object');
    const expUnit = opt('--expect-unit');
    if (expUnit && result.summary.unit !== expUnit) fail('expected auto bucket ' + expUnit + ', got ' + result.summary.unit);
    const expTf = opt('--expect-timeframe');
    if (expTf && result.summary.timeframe !== expTf) fail('expected timeframe ' + expTf + ', got ' + result.summary.timeframe);
    const yoyShown = await page.isVisible('#card-yoy');
    if (yoyShown !== (result.summary.timeframe === 'multi')) fail('year-over-year card ' + (yoyShown ? 'shown' : 'hidden') + ' for a ' + result.summary.timeframe + ' export');
    const tfNotice = await page.textContent('#notices');
    if (!/This export covers \d+ days/.test(tfNotice)) fail('timeframe explanation missing from the notices');

    if (flag('--screenshot')) await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true });
    if (flag('--screenshot') && flag('--hero-shot')) await page.screenshot({ path: resolve(out, name + '-top.png'), clip: { x: 0, y: 0, width: vw, height: +opt('--hero-height', 1250) } });

    if (flag('--interact')) {
      // Exercise every control; each must re-render without errors.
      const steps = [];
      for (const u of ['day', 'week', 'month', 'quarter', 'auto']) { await page.selectOption('#bucket', u); steps.push('bucket=' + u); }
      await page.selectOption('#statusFilter', 'success'); steps.push('status=success');
      const hiddenRisk = await page.isVisible('#riskFilteredNote');
      if (!hiddenRisk) fail('status=success did not show the filtered note');
      await page.selectOption('#statusFilter', 'all'); steps.push('status=all');
      for (const p of ['3', '6', '12', 'ytd', 'all']) { await page.selectOption('#preset', p); steps.push('preset=' + p); }
      await page.fill('#threshold', '50'); await page.dispatchEvent('#threshold', 'change'); steps.push('threshold=50');
      await page.fill('#threshold', '25'); await page.dispatchEvent('#threshold', 'change');
      if (await page.isVisible('#slopesToggle')) { await page.click('#slopesToggle'); await page.click('#slopesToggle'); steps.push('slopes toggle'); }
      if (await page.isVisible('#cadenceToggle')) { await page.click('#cadenceToggle'); await page.click('#cadenceToggle'); steps.push('cadence toggle'); }
      const chips = await page.$$('#rfmChips .chip');
      if (chips.length > 1) {
        await chips[1].click();
        const rows = await page.$$eval('#tbl-rfm tbody tr', (r) => r.length);
        const want = result.summary.rfmSegments ? Object.values(result.summary.rfmSegments)[0] : 0;
        if (rows !== want) fail('RFM chip filter showed ' + rows + ' rows, expected ' + want);
        await page.click('#rfmChips .chip >> nth=0');
        steps.push('rfm chip');
      }
      await page.click('#tbl-attention th >> nth=1').catch(() => {}); steps.push('table sort');
      // Customer groups: accept the first suggestion, check the customer count
      // drops, then ungroup and check it comes back.
      const before = await page.evaluate(() => window.ccDashboard.analysis.totals.activeCustomers);
      await page.click('#groupsBtn');
      if (!(await page.isVisible('#groupsDialog'))) fail('customer groups dialog did not open');
      const sugg = await page.$$('#grpSuggested .grp-card .btn.primary');
      if (sugg.length) {
        const n = await page.$$eval('#grpSuggested .grp-card >> nth=0 >> .grp-member', (m) => m.length).catch(() => 0);
        await sugg[0].click();
        const after = await page.evaluate(() => window.ccDashboard.analysis.totals.activeCustomers);
        const members = await page.evaluate(() => window.ccDashboard.summary().groups);
        result.groupCheck = { before, after, members };
        if (!(after < before)) fail('grouping a suggestion did not reduce active customers (' + before + ' → ' + after + ')');
        await page.click('#grpActive .grp-card .btn.small >> text=Ungroup');
        const back = await page.evaluate(() => window.ccDashboard.analysis.totals.activeCustomers);
        if (back !== before) fail('ungrouping did not restore active customers (' + back + ' vs ' + before + ')');
        steps.push('groups: grouped ' + n + ' names, ' + before + ' → ' + after + ' → ' + back + ' customers');
      }
      // Manual grouping of two names through the picker, then clear.
      const picks = await page.$$('#grpManual .grp-pick input[type=checkbox]');
      if (picks.length >= 2) {
        await picks[0].check(); await picks[1].check();
        await page.click('#grpManual .btn.primary');
        const g = await page.evaluate(() => window.ccDashboard.summary().groups.customers);
        if (g < 1) fail('manual grouping did not create a group');
        page.once('dialog', (d) => d.accept());
        await page.click('#grpClear');
        steps.push('groups: manual + clear');
      }
      await page.click('#groupsClose');
      await page.click('#dq summary'); steps.push('dq open');
      if (!(await page.isVisible('#dqBody'))) fail('data quality panel did not expand');
      // Custom date range narrowing re-buckets.
      const s = result.summary;
      await page.fill('#fromDate', s.to.slice(0, 8) + '01'); await page.dispatchEvent('#fromDate', 'change'); steps.push('custom from');
      const unitNarrow = await page.evaluate(() => window.ccDashboard.analysis.unit);
      result.narrowUnit = unitNarrow;
      await page.selectOption('#preset', 'all');
      result.interactions = steps;
      if (flag('--screenshot')) await page.screenshot({ path: resolve(out, name + '-dq.png'), fullPage: true });
      await page.click('#dq summary');
    }

    if (flag('--pdf')) {
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      await page.emulateMedia({ media: 'print' });
      await page.pdf({ path: resolve(out, name + '.pdf'), format: 'A4', printBackground: true });
      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      result.pdf = name + '.pdf';
    }
  }
}

if (external.length) fail('page attempted network requests: ' + external.slice(0, 5).join(', '));
if (consoleErrors.length) fail('console errors: ' + consoleErrors.slice(0, 5).join(' | '));
result.consoleErrors = consoleErrors;
result.externalRequests = external;
result.failures = failures;
writeFileSync(resolve(out, name + '.json'), JSON.stringify(result, null, 2));
await browser.close();

const tag = failures.length ? 'FAIL' : 'PASS';
console.log(`${tag}  ${name}` + (result.summary ? `  unit=${result.summary.unit} rows=${result.summary.quality.parsed} charts=${result.charts.length}` + (result.emptyCharts.length ? ` empty=${result.emptyCharts.length}` : '') : result.error ? `  error="${result.error.slice(0, 110)}"` : ''));
failures.forEach((f) => console.log('      - ' + f));
process.exit(failures.length ? 1 : 0);
