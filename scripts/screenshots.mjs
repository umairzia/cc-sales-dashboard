#!/usr/bin/env node
/* Regenerate the README screenshots from the SYNTHETIC sample only.
 *   node scripts/screenshots.mjs
 * Never point this at a real export: the images are committed. */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });
const url = pathToFileURL(resolve(root, 'dashboard.html')).href;
const sample = resolve(root, 'sample-data', 'sample_transactions.csv');

const browser = await chromium.launch();
async function shoot(scheme, fn) {
  const ctx = await browser.newContext({ offline: true, viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(url);
  await fn(page);
  await ctx.close();
}
const load = async (page, file) => {
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => document.getElementById('app').dataset.state !== 'empty');
  // Element screenshots scroll; keep the sticky filter bar from covering them.
  await page.addStyleTag({ content: '.filters { position: static !important; }' });
};
const section = (page, heading) => page.locator('section.section', { has: page.locator(`h2#${heading}`) });

await shoot('light', async (page) => {
  await page.screenshot({ path: resolve(out, 'empty-state.png') });
  await load(page, sample);
  await page.screenshot({ path: resolve(out, 'overview.png'), clip: { x: 0, y: 0, width: 1360, height: 1180 } });
  await section(page, 'h-mom').screenshot({ path: resolve(out, 'momentum.png') });
  await section(page, 'h-cust').locator('.grid > article').nth(1).screenshot({ path: resolve(out, 'concentration.png') });
  await section(page, 'h-rfm').screenshot({ path: resolve(out, 'segments.png') });
  await section(page, 'h-risk').screenshot({ path: resolve(out, 'risk.png') });
  await page.click('#groupsBtn');
  await page.locator('#groupsDialog').screenshot({ path: resolve(out, 'customer-groups.png') });
  await page.click('#groupsClose');
  await page.click('#dq summary');
  await page.locator('#dq').screenshot({ path: resolve(out, 'data-quality.png') });
  await load(page, resolve(root, 'tests', 'fixtures', 'missing_status_column.csv'));
  await page.screenshot({ path: resolve(out, 'error-state.png'), clip: { x: 0, y: 0, width: 1360, height: 520 } });
});
await shoot('dark', async (page) => {
  await load(page, sample);
  await page.screenshot({ path: resolve(out, 'overview-dark.png'), clip: { x: 0, y: 0, width: 1360, height: 1180 } });
});
await browser.close();
console.log('wrote screenshots to docs/screenshots/');
