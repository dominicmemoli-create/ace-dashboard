// UI-facing contracts from the management brief that are testable without a
// browser: operational inclusion of unknown-intent tables, custom-range
// validation, public RPC write shape, unique fix-card ids, and
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

describe('20 — writes go only through authenticated RPC calls', () => {
  // vitest runs in plain node: give auth.mjs the one browser API it persists to
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
  const CFG = { url: 'https://example.invalid', publishableKey: 'sb_publishable_test' };
  const SESSION = {
    access_token: 'manager-jwt',
    refresh_token: 'r',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  it('rpc() refuses to call anything while signed out', async () => {
    initAuth(CFG);
    localStorage.removeItem('ace.auth.session');
    const oldFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
    try {
      await expect(rpc('ace_upload_costs', { p_records: [] })).rejects.toThrow(/sign in/i);
    } finally {
      globalThis.fetch = oldFetch;
    }
    expect(called).toBe(false);   // nothing even reaches the network
  });

  it('rpc() sends the signed-in session token, never the publishable key', async () => {
    initAuth(CFG);
    localStorage.setItem('ace.auth.session', JSON.stringify(SESSION));
    const oldFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = { url: String(url), opts, body: JSON.parse(opts.body) };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await rpc('ace_upload_costs', { p_records: [] });
    } finally {
      globalThis.fetch = oldFetch;
      localStorage.removeItem('ace.auth.session');
    }
    expect(captured.url).toBe('https://example.invalid/rest/v1/rpc/ace_upload_costs');
    expect(captured.opts.method).toBe('POST');
    expect(captured.opts.headers.Authorization).toBe('Bearer manager-jwt');
    expect(captured.opts.headers.apikey).toBe('sb_publishable_test');
    expect(captured.body.p_records).toEqual([]);
    expect(captured.body.p_actor_session_id).toBeUndefined();
  });

  it('a 401 clears the session and asks the manager to sign in again', async () => {
    initAuth(CFG);
    localStorage.setItem('ace.auth.session', JSON.stringify(SESSION));
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'JWT expired' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
    try {
      await expect(rpc('ace_save_review_fix', {})).rejects.toThrow(/session expired/i);
    } finally {
      globalThis.fetch = oldFetch;
    }
    expect(localStorage.getItem('ace.auth.session')).toBeNull();
  });

  it('database refusals surface as plain language, not error codes', async () => {
    initAuth(CFG);
    localStorage.setItem('ace.auth.session', JSON.stringify(SESSION));
    const oldFetch = globalThis.fetch;
    const cases = [
      ['not_authorized', /approved manager list/i],
      ['pilot_history_frozen', /frozen/i],
      ['retry_cooldown', /10 minutes/i],
    ];
    try {
      for (const [code, expected] of cases) {
        globalThis.fetch = async () => new Response(JSON.stringify({ message: code }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
        await expect(rpc('ace_retry_toast_update', {})).rejects.toThrow(expected);
      }
    } finally {
      globalThis.fetch = oldFetch;
      localStorage.removeItem('ace.auth.session');
    }
  });
  it('there is no direct table write path in the browser code', () => {
    for (const f of ['src/page-update.mjs', 'src/page-fixes.mjs']) {
      const src = read(f);
      // every mutation goes through rpc(); no direct POST/PATCH to tables
      expect(src, f).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)/);
    }
  });
});
