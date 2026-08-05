// Authorization posture — the static half.
//
// These tests read the migration and the browser modules and assert the shape
// of the production access model: anonymous read-only, every write behind a
// signed-in approved manager, audit attribution taken from the verified JWT.
// The live counterparts (real Supabase, real sessions, real refusals) run in
// scripts/admin/verify-live.mjs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const sql6 = read('supabase/migrations/0006_manager_writes.sql');
const WRITE_RPCS = [
  'ace_upload_opentable', 'ace_upload_costs', 'ace_replace_metrics',
  'ace_save_review_fix', 'ace_retry_toast_update', 'ace_retry_status',
];
const bodyOf = (name) => {
  const start = sql6.indexOf(`create or replace function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = sql6.slice(start + 10);
  const next = rest.indexOf('create or replace function ');
  return rest.slice(0, next === -1 ? undefined : next);
};

describe('the open-access migration is fully withdrawn', () => {
  it('the insecure file no longer exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'supabase/migrations/0006_public_access_rpc.sql'))).toBe(false);
  });

  it('its anon-executable overloads are dropped by exact signature', () => {
    for (const sig of [
      'ace_upload_opentable\\(jsonb, text, text, text\\)',
      'ace_upload_costs\\(jsonb, text, text, text, text, text\\)',
      'ace_replace_metrics\\(jsonb, jsonb, jsonb, text\\)',
      'ace_save_review_fix\\(text, text, text, text, text, text, text\\)',
      'ace_retry_toast_update\\(text, text\\)',
      'ace_retry_status\\(bigint, text\\)',
      'ace_public_can_write\\(\\)',
      'ace_public_actor\\(text\\)',
    ]) {
      expect(sql6, sig).toMatch(new RegExp(`drop function if exists ${sig}`));
    }
  });

  it('no anon write grant survives anywhere in the migration set', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'supabase/migrations'))) {
      const sql = read(`supabase/migrations/${f}`);
      expect(sql, f).not.toMatch(/grant execute on function[^;]*\bto\b[^;]*\banon\b[^;]*;/g.source
        ? /grant execute on function\s+ace_(upload|replace|save|retry_toast)[^;]*to[^;]*anon/i
        : /$^/);
      expect(sql, f).not.toMatch(/grant\s+(insert|update|delete|all)\s+on\s+(table\s+)?ace_[a-z_]*[^;]*to[^;]*anon/i);
    }
  });
});

describe('every write requires a signed-in approved manager', () => {
  it('each write RPC calls the operator guard first', () => {
    for (const fn of WRITE_RPCS) {
      expect(bodyOf(fn), fn).toMatch(/ace_require_operator\(\)/);
    }
  });

  it('the guard rejects signed-out and unapproved callers', () => {
    const guard = bodyOf('ace_require_operator');
    expect(guard).toMatch(/auth\.uid\(\)/);
    expect(guard).toMatch(/not_signed_in/);
    expect(guard).toMatch(/not_authorized/);
    expect(guard).toMatch(/ace_is_operator\(\)/);
  });

  it('operator status is read from user_profiles, not from the request', () => {
    const isOp = bodyOf('ace_is_operator');
    expect(isOp).toMatch(/from user_profiles where id = auth\.uid\(\)/);
    expect(isOp).toMatch(/'executive','manager','shift_lead'/);
  });

  it('execute is granted to authenticated and service_role only', () => {
    expect(sql6).toMatch(/revoke all on function %s from public, anon/);
    expect(sql6).toMatch(/grant execute on function %s to authenticated, service_role/);
    for (const fn of WRITE_RPCS) {
      expect(sql6, fn).not.toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to [^;]*anon`));
    }
  });

  it('identity lookup stays public so the signed-out UI can render', () => {
    expect(sql6).toMatch(/grant execute on function ace_whoami\(\) to anon, authenticated, service_role/);
    const who = bodyOf('ace_whoami');
    expect(who).toMatch(/'unauthorized'/);   // signed in but not approved is a distinct state
    expect(who).toMatch(/'public'/);
  });

  it('no client role may write to any table directly', () => {
    expect(sql6).toMatch(/revoke insert, update, delete on/);
    const revoke = sql6.slice(sql6.indexOf('revoke insert, update, delete on'));
    expect(revoke).toMatch(/from anon, authenticated/);
    for (const t of ['ace_metrics', 'ace_item_costs', 'ace_intents', 'ace_correction_audit']) {
      expect(revoke, t).toMatch(new RegExp(t));
    }
  });
});

describe('audit attribution cannot be spoofed', () => {
  it('the client-supplied actor session is removed everywhere', () => {
    expect(sql6).toMatch(/drop column if exists actor_session_id/);
    expect(sql6).not.toMatch(/p_actor_session_id/);
    expect(read('src/auth.mjs')).not.toMatch(/publicSessionId|actorSessionId|p_actor_session_id/);
    expect(read('src/manager-mode.mjs')).not.toMatch(/currentActor|publicSessionId/);
  });

  it('audit rows are written with auth.uid() and the JWT email', () => {
    expect(sql6).toMatch(/ace_correction_audit \(row_hash, action, original, corrected, reason, note, user_id, user_email\)/);
    const guard = bodyOf('ace_require_operator');
    expect(guard).toMatch(/auth\.jwt\(\) ->> 'email'/);
  });

  it('the NOT NULL constraint on the audit user is restored', () => {
    expect(sql6).toMatch(/alter column user_id set not null/);
  });

  it('the browser sends the session token, not the publishable key, on writes', () => {
    const auth = read('src/auth.mjs');
    const rpcFn = auth.slice(auth.indexOf('export async function rpc'));
    expect(rpcFn).toMatch(/Authorization: `Bearer \$\{s\.access_token\}`/);
    expect(rpcFn).toMatch(/if \(!s\) throw new Error/);
  });
});

describe('anonymous read access is least privilege', () => {
  it('operational detail is operator-only', () => {
    expect(sql6).toMatch(/create policy operator_read on %I for select using \(ace_is_operator\(\)\)/);
    expect(sql6).toMatch(/revoke all on ace_checks, ace_selections, ace_item_costs, ace_import_runs from anon/);
  });

  it('only PII-free dashboard tables carry a public read policy', () => {
    const publicBlock = sql6.slice(sql6.indexOf("-- Dashboard-visible"), sql6.indexOf('-- Operator-only'));
    expect(publicBlock).toMatch(/create policy public_read on %I for select using \(true\)/);
    for (const t of ['ace_checks', 'ace_selections', 'ace_import_runs']) {
      expect(publicBlock, t).not.toMatch(new RegExp(`'${t}'`));
    }
  });

  it('sanitized views strip operator identity and file names', () => {
    expect(sql6).toMatch(/create or replace view ace_item_costs_public/);
    expect(sql6).toMatch(/payload - 'updatedBy'/);
    expect(sql6).toMatch(/create or replace view ace_import_runs_public/);
    expect(sql6).toMatch(/counts - 'actor'/);
    const view = sql6.slice(sql6.indexOf('create or replace view ace_import_runs_public'));
    expect(view.slice(0, 300)).not.toMatch(/created_by_email|file_name/);
  });

  it('the public dashboard reads the views, not the base tables', () => {
    const live = read('src/pages-live.mjs');
    expect(live).toMatch(/ace_item_costs_public/);
    expect(live).toMatch(/ace_import_runs_public/);
    expect(live).not.toMatch(/created_by_email,created_at/);
  });

  it('retry status cannot enumerate unrelated pg_net responses', () => {
    const fn = bodyOf('ace_retry_status');
    expect(fn).toMatch(/unknown_request/);
    expect(fn).toMatch(/from ace_import_runs/);
  });
});

describe('retry abuse is bounded', () => {
  const retry = bodyOf('ace_retry_toast_update');

  it('holds a global cooldown that date-cycling cannot bypass', () => {
    expect(retry).toMatch(/retry_cooldown/);
    const window = retry.slice(0, retry.indexOf('retry_cooldown'));
    const guardClause = window.slice(window.lastIndexOf('if exists ('));
    expect(guardClause).toMatch(/kind = 'toast_retry'/);
    expect(guardClause).toMatch(/interval '10 minutes'/);
    expect(guardClause).not.toMatch(/businessDate/);   // the bypass that was fixed
  });

  it('caps dispatches per day and serializes concurrent attempts', () => {
    expect(retry).toMatch(/retry_daily_limit/);
    expect(retry).toMatch(/interval '24 hours'/);
    expect(retry).toMatch(/pg_try_advisory_xact_lock/);
  });
});

describe('frozen pilot history', () => {
  it('has one authoritative definition', () => {
    expect(sql6).toMatch(/function ace_pilot_window\(\)/);
    expect(sql6).toMatch(/array\['20260731','20260802'\]/);
  });

  it('is enforced on every write path that could change it', () => {
    for (const fn of ['ace_upload_opentable', 'ace_upload_costs', 'ace_replace_metrics', 'ace_save_review_fix']) {
      expect(bodyOf(fn), fn).toMatch(/v_pilot|pilot_history_frozen/);
    }
  });

  it('is enforced in nightly ingestion too', () => {
    const nightly = read('scripts/nightly.mjs');
    expect(nightly).toMatch(/PILOT_WINDOW/);
    expect(nightly).toMatch(/isPilotDate/);
    expect(nightly).toMatch(/filter\(\(d\) => !isPilotDate\(d\)\)/);
  });
});

describe('the frontend sign-in flow', () => {
  const auth = read('src/auth.mjs');
  const mm = read('src/manager-mode.mjs');

  it('uses Supabase magic links and refuses unknown addresses', () => {
    expect(auth).toMatch(/auth\/v1\/otp/);
    expect(auth).toMatch(/create_user: false/);
    expect(auth).toMatch(/not on the approved manager list/);
  });

  it('redirects back to the page it was launched from, not localhost', () => {
    expect(auth).toMatch(/location\.origin \+ location\.pathname/);
    expect(auth).not.toMatch(/localhost/);
  });

  it('persists the session and refreshes it single-flight', () => {
    expect(auth).toMatch(/localStorage\.setItem\(STORE_KEY/);
    expect(auth).toMatch(/let refreshing = null/);
    expect(auth).toMatch(/grant_type=refresh_token/);
  });

  it('handles both callback shapes and an expired link', () => {
    expect(auth).toMatch(/access_token/);
    expect(auth).toMatch(/token_hash/);
    expect(auth).toMatch(/expired or was already used/);
  });

  it('clears the session on sign-out and on a 401', () => {
    expect(auth).toMatch(/auth\/v1\/logout/);
    const rpcFn = auth.slice(auth.indexOf('export async function rpc'));
    expect(rpcFn).toMatch(/res\.status === 401/);
    expect(rpcFn).toMatch(/saveSession\(null\)/);
  });

  it('shows signed-out, signed-in and unauthorized states', () => {
    expect(mm).toMatch(/isSignedInUnapproved/);
    expect(mm).toMatch(/no access/);
    expect(mm).toMatch(/Signed in as/);
    expect(mm).toMatch(/Manager sign-in/);
  });

  it('does not decide authorization in the browser', () => {
    expect(mm).toMatch(/OPERATOR_ROLES\.includes\(who\.role\)/);
    expect(mm).not.toMatch(/isOperator = \(\) => true/);
    // the role comes from the database, never from a local flag
    expect(auth).toMatch(/rpc\/ace_whoami/);
  });
});
