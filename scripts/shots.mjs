#!/usr/bin/env node
/* Screenshot harness for visual review of the dashboard.
   Not part of the app or the test suite — a local QA tool.
   Usage: node scripts/shots.mjs <out-dir> [base-url] */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = path.resolve(process.argv[2] || 'audit/after');
const BASE = process.argv[3] || 'http://localhost:4173/';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'tablet-landscape', width: 1112, height: 834 },
  { name: 'mobile', width: 390, height: 844 },
];
const PAGES = ['ops', 'servers', 'foodcost', 'update', 'fixes', 'pilot', 'help'];

fs.mkdirSync(OUT, { recursive: true });

/* CHROMIUM_PATH pins a specific binary (CI). Without it, drive an installed
   Chrome rather than a hard-coded Linux path, so the harness runs on a
   developer machine too. */
const browser = await chromium.launch(process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : { channel: process.env.BROWSER_CHANNEL || 'chrome' });
const THEME = process.env.THEME || 'light';
const errors = [];

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${vp.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${vp.name}] pageerror: ${e.message}`));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (vp.name === 'desktop') {
    await page.screenshot({ path: path.join(OUT, 'gate.png') });
  }
  /* the shell reads the saved theme on boot, so it has to be set before unlock */
  await page.evaluate((t) => localStorage.setItem('ace.theme', JSON.stringify(t)), THEME);
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#pw', 'ACE2026');
  await page.click('#gform button[type=submit]');
  await page.waitForTimeout(1400);

  for (const pg of PAGES) {
    const known = await page.evaluate((k) => {
      const app = window.__ACE_APP__;
      if (!app || !app.PAGES[k]) return false;
      app.setPage(k);
      return true;
    }, pg);
    if (!known) continue;
    await page.waitForTimeout(900);
    await page.screenshot({
      path: path.join(OUT, `${vp.name}-${pg}.png`),
      fullPage: vp.name !== 'mobile',
    });
  }
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'console-errors.txt'), errors.join('\n') || '(none)\n');
console.log(`wrote ${fs.readdirSync(OUT).length} files to ${OUT}`);
console.log('console errors:', errors.length ? '\n' + errors.join('\n') : 'none');
