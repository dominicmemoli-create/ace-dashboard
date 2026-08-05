// UI-facing contracts from the management brief that are testable without a
// browser: operational inclusion of unknown-intent tables, custom-range
// validation, unauthenticated write blocking, unique fix-card ids, and
// filter/tab persistence across async refreshes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMetricsForDate } from '../src/metrics-builder.mjs';
import { resolveRange } from '../src/date-range.mjs';
import { initAuth, rpc } from '../src/auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OPS = JSON.parse(read('config/operations.json'));

describe('1/2 — operational metrics never depend on OpenTable intent', () => {
  const DINING = Object.keys(OPS.includedAreas.serviceAreaGuids)[0];
  const REF = {
    salesCategories: [{ guid: 'cat-food', name: 'Food' }],
    employees: [{ guid: 'srv-a', name: 'Server A' }], tables: [{ guid: 't1', name: '21' }],
  };
  const check = (n, guests) => ({
    businessDate: '20260810', orderGuid: `o${n}`, checkGuid: `k${n}`, serverGuid: 'srv-a',
    tableGuid: 't1', voided: false, amount: 100, checkLevelDiscount: 0, numberOfGuests: guests,
    serviceAreaGuid: DINING, openedDate: '2026-08-10T23:00:00.000+0000',
  });
  const entSel = (n) => ({
    businessDate: '20260810', orderGuid: `o${n}`, checkGuid: `k${n}`, selectionGuid: `e${n}`,
    parentSelectionGuid: null, itemGuid: null, itemName: 'PREMIUM PER PERSON', quantity: 2,
    gross: 100, discount: 0, net: 100, voided: false, salesCategoryGuid: 'cat-food',
    serverGuid: 'srv-a', tableGuid: 't1',
  });
  it('a table without any recorded starting classification still contributes everywhere', () => {
    // buildMetricsForDate takes NO intent data at all — inclusion is structural.
    // Three seated tables (host recorded nothing for any of them) all count.
    const { rows } = buildMetricsForDate('20260810',
      [entSel(1), entSel(2), entSel(3)], [check(1, 2), check(2, 4), check(3, 2)], REF, [], OPS);
    const total = rows.find((r) => !r.serverGuid);
    expect(total.checks).toBe(3);
    expect(total.guests).toBe(8);
    expect(total.floorNet).toBe(300);
    expect(total.ayceChecks).toBe(3);          // AYCE mix includes them
    expect(total.entitlementNet).toBe(300);    // AYCE sales include them
    expect(total.entitlementCovers).toBe(6);   // cover mix includes them
    const server = rows.find((r) => r.serverGuid === 'srv-a');
    expect(server.checks).toBe(3);             // server performance includes them
  });
  it('the metrics builder cannot even receive intent — conversion lives elsewhere', () => {
    const src = read('src/metrics-builder.mjs');
    expect(src).not.toMatch(/intent/i);
  });
});

describe('17 — reversed custom ranges are blocked with a message, not an empty page', () => {
  const avail = ['20260801', '20260802', '20260803', '20260804'];
  it('From after To resolves to no dates and an explanation', () => {
    const r = resolveRange({ preset: 'custom', from: '20260804', to: '20260801' }, avail);
    expect(r.invalid).not.toBeNull();
    expect(r.invalid.message).toMatch(/start date .* after the end date/i);
    expect(r.dates).toEqual([]);
  });
  it('a well-ordered custom range resolves normally', () => {
    const r = resolveRange({ preset: 'custom', from: '20260801', to: '20260803' }, avail);
    expect(r.invalid).toBeNull();
    expect(r.dates).toEqual(['20260801', '20260802', '20260803']);
  });
  it('equal From and To is a valid one-day range', () => {
    const r = resolveRange({ preset: 'custom', from: '20260802', to: '20260802' }, avail);
    expect(r.invalid).toBeNull();
    expect(r.dates).toEqual(['20260802']);
  });
  it('the pages render the validation message instead of an empty dashboard', () => {
    const live = read('src/pages-live.mjs');
    expect(live).toMatch(/rangeOrExplain/);
    expect(live).toMatch(/range\.invalid/);
    // the misleading label is gone: availability is not the selection
    expect(live).toMatch(/Available data:/);
    expect(live).toMatch(/Showing: /);
    expect(live).not.toMatch(/>Sales data: \$\{/);
  });
});

describe('18 — active tabs and user selections survive async data loading', () => {
  const live = read('src/pages-live.mjs');
  it('background refresh never re-renders over the user (DOM left alone)', () => {
    const refresh = live.slice(live.indexOf('refreshData:'), live.indexOf('loadLive,\n'));
    expect(refresh).not.toMatch(/APP\.render|renderNav/);
  });
  it('pilot tab, date range, server view and fix filters persist in storage', () => {
    expect(live).toMatch(/ace\.pilotTab/);
    expect(live).toMatch(/ace\.opsRange/);
    expect(live).toMatch(/ace\.srvView/);
    expect(read('src/page-fixes.mjs')).toMatch(/ace\.fixFilters/);
  });
  it('the pilot tabs are a real tablist with keyboard support', () => {
    expect(live).toMatch(/role="tablist"/);
    expect(live).toMatch(/role="tab"/);
    expect(live).toMatch(/aria-selected/);
    expect(live).toMatch(/role="tabpanel"/);
    expect(live).toMatch(/ArrowRight|ArrowLeft/);
  });
  it('a stale detail response cannot clobber a newer view', () => {
    expect(live).toMatch(/isConnected/); // detail apply is guarded on the card still being mounted
  });
});

describe('19 — fix cards produce no duplicate DOM ids', () => {
  const fx = read('src/page-fixes.mjs');
  it('every element id inside a card goes through the per-card fid() helper', () => {
    const cardSrc = fx.slice(fx.indexOf('function fixCard'), fx.indexOf('function matchWhy'));
    const staticIds = [...cardSrc.matchAll(/id="([^"$]+)"/g)].map((m) => m[1]);
    expect(staticIds, `static ids found: ${staticIds.join(', ')}`).toEqual([]);
    // the previously duplicated ids are gone
    for (const bad of ['id="fixReason"', 'id="fixNote"', 'id="fixSave"', 'id="pickWrap"', 'id="fixErr"', 'id="toastSide"']) {
      expect(fx).not.toContain(bad);
    }
    expect(cardSrc).toMatch(/const fid = \(name\) => `fix-\$\{idx\}-\$\{name\}`/);
  });
  it('decisions are native radio groups with per-card names and labels', () => {
    expect(fx).toMatch(/type="radio"/);
    expect(fx).toMatch(/name="\$\{fid\('decision'\)\}"/);
    expect(fx).toMatch(/<fieldset/);
    expect(fx).toMatch(/<legend/);
  });
  it('reason and note fields have programmatic labels', () => {
    expect(fx).toMatch(/for="\$\{fid\('reason'\)\}"/);
    expect(fx).toMatch(/for="\$\{fid\('note'\)\}"/);
  });
});

describe('20 — unauthenticated users cannot perform writes', () => {
  it('rpc() refuses to call any write endpoint without a session', async () => {
    initAuth({ url: 'https://example.invalid', anonKey: 'anon' });
    await expect(rpc('ace_upload_costs', {})).rejects.toThrow(/sign in/i);
  });
  it('there is no unauthenticated write path in the browser code', () => {
    for (const f of ['src/page-update.mjs', 'src/page-fixes.mjs']) {
      const src = read(f);
      // every mutation goes through rpc(); no direct POST/PATCH to tables
      expect(src, f).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)/);
    }
  });
});
