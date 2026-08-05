#!/usr/bin/env node
/* Visual review harness for the states that need OpenTable records to exist —
   the Fixes Needed queue, the one-card decision flow and the server drill-down.
   Supabase is not reachable from a local browser, so the REST reads are stubbed
   at the network layer with fixtures derived from the checked-in backup data.
   This is a QA tool only: no application code is stubbed or changed.

   Usage: node scripts/shots-fixtures.mjs <out-dir> [base-url] */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = path.resolve(process.argv[2] || 'audit/after');
const BASE = process.argv[3] || 'http://localhost:4173/';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

fs.mkdirSync(OUT, { recursive: true });

const manifest = read('data/live/manifest.json');
const reference = read('data/live/reference.json');
const itemCosts = read('data/live/item_costs.json');
const metrics = read('data/live/metrics.json');
const checks = read('data/live/checks_20260802.json');
const selections = read('data/live/selections_20260802.json');

// A few sanitized OpenTable records that exercise every queue state. The dates
// sit outside the frozen pilot window so they are actionable.
const DAY = '20260803';
const sample = checks.filter((c) => c.tableGuid && !c.voided).slice(0, 6);
const tblName = new Map((reference.tables ?? []).map((t) => [t.guid, String(t.name).toUpperCase()]));
const srvName = new Map((reference.employees ?? []).map((e) => [e.guid, e.name]));

const intents = [
  {
    rowHash: 'fx-conflict-1', businessDate: DAY, intent: 'REVIEW_REQUIRED', visitTime: '7:15 PM',
    visitMinutes: 19 * 60 + 15, partySize: 4, tableTokens: ['24'], diningArea: 'Dining Room',
    relevantTags: ['AYCE', 'A la carte'], matchStatus: 'unmatched', halfHalf: false,
  },
  {
    rowHash: 'fx-match-1', businessDate: DAY, intent: 'UNDECIDED', visitTime: '6:40 PM',
    visitMinutes: 18 * 60 + 40, partySize: 2, tableTokens: [tblName.get(sample[0]?.tableGuid) ?? '31'],
    diningArea: 'Dining Room', matchStatus: 'ambiguous', matchConfidence: 0.62,
    matchedOrderGuid: sample[0]?.orderGuid ?? null,
    matchEvidence: { timeDiffMin: 8, tableOverlap: true, overlappingTable: tblName.get(sample[0]?.tableGuid), partyDiff: 0, area: 'dining' },
    halfHalf: true,
  },
  {
    rowHash: 'fx-match-2', businessDate: DAY, intent: 'ALC', visitTime: '8:05 PM',
    visitMinutes: 20 * 60 + 5, partySize: 6, tableTokens: ['52'], diningArea: 'Patio',
    matchStatus: 'ambiguous', matchConfidence: 0.44, matchedOrderGuid: sample[1]?.orderGuid ?? null,
    matchEvidence: { timeDiffMin: 17, tableOverlap: false, partyDiff: 1, area: 'patio' },
  },
  // resolved item so "Recently decided" and its undo control are visible
  {
    rowHash: 'fx-done-1', businessDate: DAY, intent: 'UNDECIDED', visitTime: '5:50 PM',
    partySize: 3, tableTokens: ['18'], matchStatus: 'matched', reviewStatus: 'confirmed',
    matchedOrderGuid: sample[2]?.orderGuid ?? null, hasAyceSales: true,
    matchedServerGuid: sample[2]?.serverGuid ?? null,
    correction: { corrected: 'UNDECIDED', at: '2026-08-04T20:00:00Z', user: 'public-site visitor' },
  },
  // unmarked + not-connected records feed the honest exclusion summary
  ...Array.from({ length: 9 }, (_, i) => ({
    rowHash: `fx-unknown-${i}`, businessDate: DAY, intent: 'UNKNOWN', partySize: 2,
    tableTokens: [], matchStatus: 'unmatched',
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    rowHash: `fx-nc-${i}`, businessDate: DAY, intent: 'ALC', partySize: 2,
    tableTokens: ['9'], matchStatus: 'unmatched',
  })),
  // connected + converted rows so conversion figures are non-empty
  ...sample.slice(3).map((c, i) => ({
    rowHash: `fx-ok-${i}`, businessDate: '20260802', intent: 'UNDECIDED', visitMinutes: 19 * 60,
    partySize: c.numberOfGuests ?? 2, tableTokens: [tblName.get(c.tableGuid)],
    matchStatus: 'matched', matchedOrderGuid: c.orderGuid, matchedServerGuid: c.serverGuid,
    hasAyceSales: i % 2 === 0, matchEvidence: { timeDiffMin: 3, tableOverlap: true, partyDiff: 0 },
  })),
];

const wrap = (rows) => rows.map((payload) => ({ payload }));
const TABLES = {
  ace_manifest: [{ restaurant_guid: manifest.restaurantGuid, dates: manifest.dates, last_toast_sync: manifest.lastToastSync }],
  ace_reference: wrap([reference]),
  ace_item_costs: wrap(itemCosts),
  ace_metrics: wrap(metrics.rows),
  ace_item_metrics: wrap(metrics.items),
  ace_intents: wrap(intents),
  ace_import_runs: [{ kind: 'opentable', file_name: 'guestcenter.csv', counts: { inserted: 41 }, status: 'success', error: null, created_by_email: 'public-site visitor', created_at: '2026-08-04T22:10:00Z' }],
  ace_ingestion_runs: wrap([{ runId: 'run-20260804', status: 'success', startedAt: '2026-08-04T10:00:00Z' }]),
  ace_checks: wrap(checks),
  ace_selections: wrap(selections),
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const errors = [];

for (const vp of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
  await ctx.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.split('/').pop();
    const rows = TABLES[table] ?? [];
    // honour Range paging the way PostgREST does, otherwise the client's
    // "keep fetching until a short page" loop never terminates
    const range = route.request().headers().range;
    const m = /^(\d+)-(\d+)$/.exec(range ?? '');
    const page = m ? rows.slice(Number(m[1]), Number(m[2]) + 1) : rows;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${vp.name}] ${e.message}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.fill('#pw', 'ACE2026');
  await page.click('#gform button[type=submit]');
  await page.waitForTimeout(2000);

  // Fixes Needed — queue + active card
  await page.evaluate(() => window.__ACE_APP__.setPage('fixes'));
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-fixes-queue.png`), fullPage: vp.name === 'desktop' });

  // one-card flow: choose a decision and a reason so the save button enables
  const radio = page.locator('.fixcard input[type=radio]').first();
  if (await radio.count()) {
    await radio.check();
    await page.selectOption('.fixcard select.ctl', { index: 1 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-fixes-card-active.png`), fullPage: vp.name === 'desktop' });
  }

  // Update Dashboard with live-ish status, and the server drill-down drawer
  await page.evaluate(() => window.__ACE_APP__.setPage('update'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-update-live.png`), fullPage: vp.name === 'desktop' });

  await page.evaluate(() => window.__ACE_APP__.setPage('servers'));
  await page.waitForTimeout(2500);
  const row = page.locator('#srvBody tr.rowlink').first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-server-drawer.png`) });
  }
  await ctx.close();
}

await browser.close();
fs.appendFileSync(path.join(OUT, 'console-errors.txt'), `\n[fixtures]\n${errors.join('\n') || '(none)'}\n`);
console.log(`fixture shots written to ${OUT}`);
console.log('page errors:', errors.length ? '\n' + errors.join('\n') : 'none');
