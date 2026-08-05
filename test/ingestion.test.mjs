// Toast ingestion contracts — date selection, DST, secrets, idempotence and
// failure handling, all testable without a database or the Toast API.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nyYesterday, resolveTargetDate, missingSecrets, isPilotDate, PILOT_WINDOW } from '../scripts/lib/ingest-rules.mjs';
import { migrationOrder, LIVE_MIGRATIONS } from '../scripts/admin/bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const nightly = read('scripts/nightly.mjs');
const workflow = read('.github/workflows/nightly-ingest.yml');

describe('business date selection', () => {
  it('defaults to yesterday in New York, not UTC', () => {
    // 2026-03-02 00:30 UTC is still 2026-03-01 19:30 in New York, so "yesterday"
    // is Feb 28 in New York and would wrongly be Mar 1 under UTC.
    expect(nyYesterday(new Date('2026-03-02T00:30:00Z'))).toBe('20260228');
  });

  it('honours an explicit YYYYMMDD override', () => {
    expect(resolveTargetDate('20260814')).toBe('20260814');
    expect(resolveTargetDate('2026-08-14', new Date('2026-08-20T15:00:00Z'))).toBe('20260819');
    expect(resolveTargetDate(undefined, new Date('2026-08-20T15:00:00Z'))).toBe('20260819');
  });

  it('is correct on both sides of the DST switch', () => {
    // EDT (UTC-4): 10:00 UTC is 06:00 New York
    expect(nyYesterday(new Date('2026-07-15T10:00:00Z'))).toBe('20260714');
    // EST (UTC-5): 11:00 UTC is 06:00 New York
    expect(nyYesterday(new Date('2026-12-15T11:00:00Z'))).toBe('20261214');
  });

  it('the workflow fires both DST slots and gates on the New York hour', () => {
    expect(workflow).toMatch(/cron: '0 10 \* \* \*'/);
    expect(workflow).toMatch(/cron: '0 11 \* \* \*'/);
    expect(workflow).toMatch(/TZ=America\/New_York date \+%H/);
    expect(workflow).toMatch(/NY_HOUR" = "06"/);
  });

  it('manual dispatch accepts a business date and bypasses the hour gate', () => {
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/businessDate:/);
    expect(workflow).toMatch(/github\.event_name.*workflow_dispatch/);
    expect(workflow).toMatch(/nightly\.mjs \$\{\{ inputs\.businessDate \}\}/);
  });
});

describe('required secrets', () => {
  it('names every secret the run needs', () => {
    expect(missingSecrets({})).toEqual(['SUPABASE_DB_URL', 'TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET']);
    expect(missingSecrets({ SUPABASE_DB_URL: 'x', TOAST_CLIENT_ID: 'y', TOAST_CLIENT_SECRET: 'z' })).toEqual([]);
    expect(missingSecrets({ SUPABASE_DB_URL: '  ', TOAST_CLIENT_ID: 'y', TOAST_CLIENT_SECRET: 'z' }))
      .toEqual(['SUPABASE_DB_URL']);
  });

  it('fails fast with a readable message rather than a driver stack trace', () => {
    expect(nightly).toMatch(/Missing required secret\(s\)/);
    expect(nightly).toMatch(/process\.exit\(1\)/);
  });

  it('the workflow passes exactly those secrets and no others', () => {
    expect(workflow).toMatch(/TOAST_CLIENT_ID: \$\{\{ secrets\.TOAST_CLIENT_ID \}\}/);
    expect(workflow).toMatch(/TOAST_CLIENT_SECRET: \$\{\{ secrets\.TOAST_CLIENT_SECRET \}\}/);
    expect(workflow).toMatch(/SUPABASE_DB_URL: \$\{\{ secrets\.SUPABASE_DB_URL \}\}/);
    expect(workflow).not.toMatch(/SERVICE_ROLE|sb_secret_|PUBLISHABLE/);
  });

  it('ingestion never depends on a browser session', () => {
    expect(nightly).not.toMatch(/auth\.mjs|access_token|localStorage/);
    expect(workflow).not.toMatch(/magic|sign-in|session/i);
  });
});

describe('idempotence and failure handling', () => {
  it('re-running a date replaces that date inside one transaction', () => {
    const upsert = nightly.slice(nightly.indexOf('async function upsertDate'));
    expect(upsert).toMatch(/client\.query\('begin'\)/);
    expect(upsert).toMatch(/delete from ace_selections where business_date = \$1/);
    expect(upsert).toMatch(/delete from ace_checks where business_date = \$1/);
    expect(upsert).toMatch(/delete from ace_metrics where business_date = \$1/);
    expect(upsert).toMatch(/on conflict \(check_guid\) do update/);
    expect(upsert).toMatch(/on conflict \(selection_guid\) do update/);
    expect(upsert).toMatch(/client\.query\('commit'\)/);
    expect(upsert).toMatch(/rollback/);
  });

  it('metrics are rebuilt only after the source rows land, in the same transaction', () => {
    const upsert = nightly.slice(nightly.indexOf('async function upsertDate'));
    expect(upsert.indexOf('insert into ace_checks')).toBeLessThan(upsert.indexOf('buildMetricsForDate'));
    expect(upsert.indexOf('buildMetricsForDate')).toBeLessThan(upsert.indexOf("client.query('commit')"));
  });

  it('a partial failure stops the run instead of publishing mixed data', () => {
    const loop = nightly.slice(nightly.indexOf('for (const date of toIngest)'));
    expect(loop).toMatch(/failed = `\$\{date\}: \$\{e\.message\}`/);
    expect(loop).toMatch(/break;/);
  });

  it('setup failures are still recorded as a failed run', () => {
    expect(nightly).toMatch(/failed = failed \?\? `setup: \$\{e\.message\}`/);
    const finalize = nightly.slice(nightly.indexOf('update ace_ingestion_runs set payload'));
    expect(finalize).toMatch(/status: failed \? 'failed' : 'success'/);
    expect(finalize).toMatch(/finally/);
  });

  it('a seeded reference row is required before ingesting', () => {
    expect(nightly).toMatch(/ace_reference is empty/);
  });
});

describe('frozen pilot history', () => {
  it('has the same window as the database', () => {
    expect(PILOT_WINDOW).toEqual(['20260731', '20260802']);
    const sql = read('supabase/migrations/0006_manager_writes.sql');
    expect(sql).toMatch(/array\['20260731','20260802'\]/);
  });

  it('classifies the boundary days as frozen', () => {
    expect(isPilotDate('20260730')).toBe(false);
    expect(isPilotDate('20260731')).toBe(true);
    expect(isPilotDate('20260801')).toBe(true);
    expect(isPilotDate('20260802')).toBe(true);
    expect(isPilotDate('20260803')).toBe(false);
  });

  it('refuses an explicit pilot-date run and filters pilot baseline gaps', () => {
    expect(nightly).toMatch(/Refusing to ingest .*pilot history is frozen/);
    expect(nightly).toMatch(/filter\(\(d\) => !isPilotDate\(d\)\)/);
  });
});

describe('bootstrap order', () => {
  it('creates the core tables before anything references them', () => {
    const order = migrationOrder();
    expect(order[0]).toBe('0000_ace_core_tables.sql');
    expect(order.indexOf('0003_manager_tools.sql')).toBeLessThan(order.indexOf('0006_manager_writes.sql'));
    expect(order.at(-1)).toBe('0006_manager_writes.sql');
  });

  it('every listed migration exists on disk', () => {
    for (const f of migrationOrder({ withLegacy: true })) {
      expect(fs.existsSync(path.join(ROOT, 'supabase/migrations', f)), f).toBe(true);
    }
  });

  it('the core migration defines every table the dashboard reads', () => {
    const core = read('supabase/migrations/0000_ace_core_tables.sql');
    for (const t of ['ace_manifest', 'ace_reference', 'ace_checks', 'ace_selections',
      'ace_ingestion_runs', 'ace_item_costs', 'ace_metrics', 'ace_item_metrics', 'ace_intents']) {
      expect(core, t).toMatch(new RegExp(`create table if not exists ${t}`));
      expect(core, t).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`));
    }
    // the remaining tables come from 0003, which bootstrap runs next
    const mgr = read('supabase/migrations/0003_manager_tools.sql');
    for (const t of ['user_profiles', 'ace_approved_emails', 'ace_import_runs', 'ace_correction_audit']) {
      expect(mgr, t).toMatch(new RegExp(`create table if not exists ${t}`));
    }
    expect(LIVE_MIGRATIONS).toContain('0003_manager_tools.sql');
  });

  it('enables only the extensions the RPC layer needs', () => {
    const boot = read('scripts/admin/bootstrap.mjs');
    expect(boot).toMatch(/create extension if not exists pg_net/);
    expect(boot).toMatch(/create extension if not exists supabase_vault/);
    expect(boot).not.toMatch(/create extension if not exists (?!pg_net|supabase_vault)/);
  });

  it('never echoes the connection string', () => {
    const boot = read('scripts/admin/bootstrap.mjs');
    expect(boot).not.toMatch(/console\.log\([^)]*SUPABASE_DB_URL/);
    expect(boot).not.toMatch(/console\.log\([^)]*connectionString/);
  });
});
