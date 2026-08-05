// Manager-product acceptance tests — the static half.
// Live counterparts (real Supabase, real sessions, real GitHub dispatch) run in
// scripts/admin/verify-live.mjs; the mapping is noted per test below.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rowHashOf, rowHashOfAsync } from '../src/opentable.mjs';
import { parseCostCsv, rowsFromWorkbookAoa, diffCosts, stillUncosted } from '../src/costs-shared.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const UPDATE_SCREENS = ['src/page-update.mjs', 'src/page-fixes.mjs', 'src/manager-mode.mjs'];

describe('3/23: no CLI or technical language on management screens', () => {
  it('management screens contain no commands or technical terminology', () => {
    for (const f of UPDATE_SCREENS) {
      const src = read(f);
      expect(src, f).not.toMatch(/npm run|node scripts\/|apply-corrections|corrections\.json/);
      expect(src, f).not.toMatch(/Supabase(?!\/)/);        // brand never displayed (path refs in comments ok)
      expect(src, f).not.toMatch(/ingestion(?!_runs|Runs)/i); // "update" language only (internal ids ok)
      expect(src, f).not.toMatch(/split check/i);
    }
  });
  it('the old technical review/import surfaces are gone', () => {
    const live = read('src/pages-live.mjs');
    expect(live).not.toMatch(/Draft fix|dlCorrections|download corrections|Import paths/);
    expect(live).not.toMatch(/kind\.replaceAll/);          // raw enum labels like REVIEW_REQUIRED
    expect(read('index.html')).not.toMatch(/npm run|node scripts\//);
  });
  it('raw enums are mapped to plain language in Fixes Needed', () => {
    const fx = read('src/page-fixes.mjs');
    expect(fx).toMatch(/REVIEW_REQUIRED: 'Needs a decision'/);
    // Half/Half is a guest-mix note, shown as information — never a fix kind
    expect(fx).toMatch(/half returning, half first-time/i);
    expect(fx).not.toMatch(/Mixed-menu table/);
  });
  it('CLI fallbacks live only behind Advanced Details / technical docs', () => {
    const live = read('src/pages-live.mjs');
    const adv = live.slice(live.indexOf('advDetTgl'), live.indexOf('registerPages'));
    // the only mention of the CLI in the app is the advanced-details pointer
    expect(adv).toMatch(/TECHNICAL_RUNBOOK/);
  });
});

describe('9: service credentials never reach the browser', () => {
  it('browser-loaded files never reference service-role or database secrets', () => {
    const browserFiles = ['index.html',
      ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`),
      'src/adapters/sources.mjs'];
    for (const f of browserFiles) {
      const src = read(f);
      expect(src, f).not.toMatch(/SERVICE_ROLE|SUPABASE_DB_URL|TOAST_CLIENT_SECRET|ghp_|github_pat_/);
    }
  });
  it('the published Supabase key is the publishable browser key only', () => {
    const raw = read('data/supabase_config.json');
    const cfg = JSON.parse(raw);
    expect(cfg.publishableKey).toMatch(/^sb_publishable_/);
    // no secret key, no service-role JWT, no legacy anon JWT
    expect(raw).not.toMatch(/sb_secret_|service_role|SUPABASE_SECRET/);
    expect(cfg.url).toMatch(/^https:\/\/[a-z]+\.supabase\.co$/);
  });
  it('the frontend points at the dedicated ace-dashboard project', () => {
    const cfg = JSON.parse(read('data/supabase_config.json'));
    expect(cfg.url).toBe('https://hgnijizgavveoadjeoqm.supabase.co');
    // the previously shared project must not survive anywhere in the tree
    for (const f of ['data/supabase_config.json', 'src/pages-live.mjs', 'docs/DEPLOY.md']) {
      expect(read(f), f).not.toMatch(/cdqbiwgxezaoaibypvsi/);
    }
  });
  it('the GitHub token lives in Vault, read only inside the definer function', () => {
    const sql = read('supabase/migrations/0003_manager_tools.sql');
    expect(sql).toMatch(/vault\.decrypted_secrets/);
    expect(sql).toMatch(/security definer/);
  });
});

describe('1/22: Toast automation intact; retry drives the same pipeline', () => {
  it('the scheduled workflow still runs without manager action', () => {
    const wf = read('.github/workflows/nightly-ingest.yml');
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/workflow_dispatch/);
    expect(wf).toMatch(/nightly\.mjs/);
  });
  it('retry-toast-update dispatches that exact workflow with cooldown protection', () => {
    const sql = read('supabase/migrations/0006_manager_writes.sql');
    expect(sql).toMatch(/nightly-ingest\.yml\/dispatches/);
    const fn = sql.slice(sql.indexOf('create or replace function ace_retry_toast_update'),
      sql.indexOf('create or replace function ace_retry_status'));
    expect(fn).toMatch(/ace_require_operator\(\)/);
    expect(fn).toMatch(/pg_try_advisory_xact_lock/);
    expect(fn).toMatch(/retry_cooldown/);
    expect(fn).toMatch(/retry_daily_limit/);
    // the cooldown must not be keyed on the caller-supplied business date,
    // which would let a caller cycle dates to dispatch unlimited runs
    const cooldown = fn.slice(fn.indexOf('retry_cooldown') - 400, fn.indexOf('retry_cooldown'));
    expect(cooldown).not.toMatch(/businessDate/);
  });
  // live proof: verify-live.mjs --with-retry → dispatch accepted (HTTP 204),
  // nightly run recorded, run finished success.
});

// Authorization and audit posture moved to test/authorization.test.mjs.

describe('18: no correction JSON downloads anywhere', () => {
  it('no dashboard surface creates a corrections file', () => {
    for (const f of ['index.html', 'src/pages-live.mjs', 'src/page-fixes.mjs', 'src/page-update.mjs']) {
      expect(read(f), f).not.toMatch(/corrections\.json|download.*corrections/i);
    }
  });
});

describe('24: presentation gate still works (and stays presentation-only)', () => {
  it('gate exists with the current passcode and honest labeling', () => {
    const html = read('index.html');
    expect(html).toMatch(/const PASS = "ACE2026"/);
    expect(html).toMatch(/presentation gate only/i);
  });
});

describe('25: pilot calculations and commission remain unchanged', () => {
  // hashes are computed over LF-normalized bytes so Windows/Linux checkouts agree
  const lfHash = (p) => crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, p)).toString('binary').replace(/\r\n/g, '\n'), 'binary').digest('hex');
  it('frozen pilot payload is content-identical (regression pin)', () => {
    expect(lfHash('data/ace_payload.js')).toBe('7bfd4f98f0fc5f1a65f6b75fa678415ae73ad76f65199f8a0033623cb71fbc44');
  });
  it('legacy pilot snapshot untouched', () => {
    expect(lfHash('legacy/index.html')).toBe('ee03618c4b45438c40b1e97f65d3e1dd699da91ab6d780468eee6fc7d24cd6f6');
  });
  it('commission program stays inactive with the pilot window preserved', () => {
    const ops = JSON.parse(read('config/operations.json'));
    expect(ops.commission.programActive).toBe(false);
    expect(ops.commission.activeFrom).toBe('20260731');
    expect(ops.commission.activeTo).toBe('20260802');
    expect(ops.commission.ratesPerCover).toEqual({ classic: 5, premium: 7.5, royalty: 10 });
  });
});

describe('2/4: browser upload path building blocks', () => {
  it('browser and CLI produce identical row hashes (idempotency across paths)', async () => {
    const raw = ['2026-08-03', '07:00 PM', 'G', '555', '2', 'Done', '12', '', 'Web', '', '100', '', '', 'UNDECIDED.', ''];
    expect(await rowHashOfAsync(raw)).toBe(rowHashOf(raw));
  });
  it('cost CSV parsing matches the import-script contract', () => {
    const rows = parseCostCsv('canonical_name,cost,portion,notes\nSnow Crab (1),7.82,per cluster,\nBad Row,,x,\n');
    expect(rows).toEqual([{ name: 'Snow Crab (1)', cost: 7.82, portion: 'per cluster', notes: '' }]);
    expect(parseCostCsv('Visit Date,Reservation Tags\n')).toBeNull(); // not a cost file
  });
  it('XLSX rows resolve via header row or the known workbook layout', () => {
    expect(rowsFromWorkbookAoa([['canonical_name', 'cost'], ['Lamb Chops', 4.1]]))
      .toEqual([{ name: 'Lamb Chops', cost: 4.1, portion: undefined, notes: undefined }]);
    expect(rowsFromWorkbookAoa([[null, 'Snow Crab (1)', 7.82], [null, 'Food Cost', 3]]))
      .toEqual([{ name: 'Snow Crab (1)', cost: 7.82 }]);
  });
  it('preview diff reports changed / unchanged / new / skipped correctly', () => {
    const master = [
      { canonicalName: 'A', costPerUnit: 5, effectiveFrom: '20260101', effectiveTo: null },
      { canonicalName: 'B', costPerUnit: 2, effectiveFrom: '20260101', effectiveTo: null },
      { canonicalName: 'C', costPerUnit: 9, effectiveFrom: '20270101', effectiveTo: null },
    ];
    const d = diffCosts([
      { name: 'A', cost: 6 }, { name: 'B', cost: 2 }, { name: 'C', cost: 1 }, { name: 'D', cost: 3 },
    ], master, '20260801');
    expect(d.changed.map((x) => x.name)).toEqual(['A']);
    expect(d.unchanged.map((x) => x.name)).toEqual(['B']);
    expect(d.skipped.map((x) => x.name)).toEqual(['C']);
    expect(d.added.map((x) => x.name)).toEqual(['D']);
  });
  it('still-uncosted list respects aliases', () => {
    expect(stillUncosted(['WDT', 'Lil Pink'], [{ name: 'Whole Dang Thing' }], { 'Whole Dang Thing': ['WDT'] }))
      .toEqual(['Lil Pink']);
  });
});
