// Static security guards — enforceable now, before the backend exists.
// Full RLS behavior tests (brief items 20–22) run against a live Supabase
// instance and are listed as pending in docs/LIMITATIONS.md until then.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('RLS migration posture', () => {
  const rls = read('supabase/migrations/0002_rls.sql');
  it('enables RLS on every operational table (deny-by-default)', () => {
    for (const t of ['orders', 'checks', 'item_selections', 'payroll_summaries', 'commission_entries', 'employee_user_links']) {
      expect(rls).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`));
    }
  });
  it('grants anonymous users nothing', () => {
    // no policy may target the anon role; the word only appears in design notes
    expect(rls).not.toMatch(/to\s+anon/i);
    expect(rls).not.toMatch(/create policy[^;]*anon[^;]*;/i);
    expect(rls).toMatch(/anon key sees nothing/i); // the explicit design note
  });
  it('server access is keyed by employee link, not by name', () => {
    expect(rls).toMatch(/app_employee_ids\(\)/);
    expect(rls).not.toMatch(/display_name\s*=/);
  });
  it('payroll policies are separate and stricter than performance data', () => {
    expect(rls).toMatch(/payroll_server_own/);
    expect(rls).toMatch(/payroll_mgmt_read/);
  });
});

describe('secret hygiene', () => {
  it('.env.example contains placeholders only', () => {
    const env = read('.env.example');
    const KNOWN_PUBLIC = new Set(['e574444c-c511-4468-ab89-93d0abbec72b']); // restaurant GUID is not a secret
    for (const line of env.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*([^#\s]*)/.exec(line);
      if (!m || !m[2]) continue;
      const val = m[2];
      expect(
        val.startsWith('__') || KNOWN_PUBLIC.has(val),
        `${m[1]} value must be a __PLACEHOLDER__, got: ${val}`
      ).toBe(true);
    }
    expect(env).toMatch(/SERVER_SIDE_ONLY/);
  });
  it('.gitignore excludes .env and raw PII snapshots', () => {
    const gi = read('.gitignore');
    expect(gi).toMatch(/^\.env$/m);
    expect(gi).toMatch(/^data\/raw\/$/m);
  });
  it('no Toast credentials committed anywhere in frontend or scripts', () => {
    for (const f of ['index.html', 'src/pages-live.mjs', 'scripts/ingest-toast.mjs', 'scripts/lib/toast-client.mjs']) {
      const src = read(f);
      expect(src).not.toMatch(/clientSecret\s*[:=]\s*['"][A-Za-z0-9]/);
    }
  });
  it('payroll and server portal feature flags are OFF', () => {
    const flags = JSON.parse(read('config/feature_flags.json'));
    expect(flags.payroll.enabled).toBe(false);
    expect(flags.server_portal.enabled).toBe(false);
    expect(flags.commission_program.enabled).toBe(false);
  });
});

describe('pilot headline reconciliation (test 23)', () => {
  it('preserved legacy payload still carries the shipped headline metrics', () => {
    const payload = read('data/ace_payload.js');
    const json = JSON.parse(payload.slice(payload.indexOf('{'), payload.lastIndexOf('}') + 1).replace(/;\s*$/, ''));
    expect(json.overall.pilot.guests).toBe(851);
    expect(json.overall.pilot.aceCovers).toBe(311);
    expect(json.overall.pilot.revenue).toBeCloseTo(89932.08);
    expect(json.overall.conversion.convRateTables).toBeCloseTo(32.9);
    expect(json.overall.conversion.commission).toBe(1130);
    // legacy snapshot is byte-identical on the payload numbers
    const legacy = read('legacy/index.html');
    expect(legacy).toContain('"guests":851,"aceCovers":311');
  });
});
