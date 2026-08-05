#!/usr/bin/env node
// Live integration verification against the configured Supabase project.
// Exercises the protected manager-tool functions with REAL authenticated
// sessions for each role, asserts the authorization matrix, idempotency,
// audit identity, and reversal — then cleans up every synthetic row it wrote.
//
//   node scripts/admin/verify-live.mjs            # full run
//   node scripts/admin/verify-live.mjs --with-retry  # also dispatch a real Toast retry
//
// Test users (provisioned via scripts/admin/add-manager.mjs):
//   manager.test@example.com   role manager
//   lead.test@example.com      role shift_lead
//   outsider.test@example.com  authenticated but NOT approved (role server)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
const ANON = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'supabase_config.json'), 'utf8')).anonKey;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
};

/** Mint a real session for a user via admin generate_link + verify. */
async function mintSession(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`generate_link ${email}: ${JSON.stringify(j).slice(0, 200)}`);
  const v = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: j.hashed_token }),
  });
  const s = await v.json();
  if (!v.ok || !s.access_token) throw new Error(`verify ${email}: ${JSON.stringify(s).slice(0, 200)}`);
  return s;
}

async function rpcAs(session, name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${session ? session.access_token : ANON}`,
      'Content-Type': 'application/json', Prefer: 'params=single-object',
    },
    body: JSON.stringify(args ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const T = (n) => `itest${String(n).padStart(3, '0')}${'0'.repeat(15)}`; // synthetic row hashes
const TEST_DATE = '20260901'; // outside pilot window, no real Toast data
const PILOT_DATE = '20260801';

function syntheticRow(n, over = {}) {
  return {
    rowHash: T(n), runId: 'verify-live', businessDate: TEST_DATE,
    visitTime: '07:00 PM', visitMinutes: 1140, partySize: 2, status: 'Done',
    tableTokens: ['99'], serverSoftLabel: '', intent: 'UNDECIDED',
    mixedMenuException: false, relevantTags: ['UNDECIDED'], posSubtotal: 100,
    matchStatus: 'unmatched', matchedOrderGuid: null, matchConfidence: null,
    reviewStatus: 'auto', ...over,
  };
}

async function main() {
  const withRetry = process.argv.includes('--with-retry');
  const db = new pg.Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('Minting sessions…');
  const mgr = await mintSession('manager.test@example.com');
  const lead = await mintSession('lead.test@example.com');
  const out = await mintSession('outsider.test@example.com');

  try {
    console.log('\n[whoami / roles]');
    ok('manager role', (await rpcAs(mgr, 'ace_whoami')).body.role === 'manager');
    ok('shift_lead role', (await rpcAs(lead, 'ace_whoami')).body.role === 'shift_lead');
    ok('unapproved user has no manager role', (await rpcAs(out, 'ace_whoami')).body.role === 'server');

    console.log('\n[authorization matrix — writes]');
    const rows = [syntheticRow(1), syntheticRow(2, { intent: 'REVIEW_REQUIRED', relevantTags: ['AYCE', 'UNDECIDED'], reviewStatus: 'pending_review' })];
    let r = await rpcAs(null, 'ace_upload_opentable', { p_rows: rows, p_file_name: 'verify.csv', p_file_hash: 'itestfile1' });
    ok('anon cannot upload OpenTable', r.status === 401 || r.status === 403 || r.status === 404, `got ${r.status}`);
    r = await rpcAs(out, 'ace_upload_opentable', { p_rows: rows, p_file_name: 'verify.csv', p_file_hash: 'itestfile1' });
    ok('unapproved user cannot upload OpenTable', r.status >= 400, `got ${r.status}`);
    r = await rpcAs(lead, 'ace_upload_opentable', { p_rows: rows, p_file_name: 'verify.csv', p_file_hash: 'itestfile1' });
    ok('shift lead CAN upload OpenTable', r.status === 200 && r.body.inserted === 2, JSON.stringify(r.body).slice(0, 120));
    r = await rpcAs(lead, 'ace_upload_opentable', { p_rows: rows, p_file_name: 'verify.csv', p_file_hash: 'itestfile1' });
    ok('re-upload is idempotent (0 inserted, 2 duplicates)', r.status === 200 && r.body.inserted === 0 && r.body.duplicates === 2, JSON.stringify(r.body).slice(0, 120));
    ok('duplicate file flagged', r.body.duplicateFile === true);

    const costRec = [{ name: 'TEST ITEM ZZZ', cost: 4.25, portion: 'per test', aliases: [] }];
    r = await rpcAs(lead, 'ace_upload_costs', { p_records: costRec, p_effective_from: TEST_DATE });
    ok('shift lead CANNOT upload costs', r.status >= 400 && JSON.stringify(r.body).includes('not_authorized'), `got ${r.status}`);
    r = await rpcAs(mgr, 'ace_upload_costs', { p_records: costRec, p_effective_from: TEST_DATE, p_file_name: 'verify-costs.csv', p_file_hash: 'itestfile2' });
    ok('manager CAN upload costs', r.status === 200 && r.body.recognized === 1, JSON.stringify(r.body).slice(0, 160));
    ok('new item reported as changed', r.body.changed === 1);
    r = await rpcAs(mgr, 'ace_upload_costs', { p_records: costRec, p_effective_from: TEST_DATE, p_file_name: 'verify-costs.csv', p_file_hash: 'itestfile2' });
    ok('cost re-upload idempotent (unchanged)', r.status === 200 && r.body.unchanged === 1, JSON.stringify(r.body).slice(0, 160));

    console.log('\n[PII guard]');
    r = await rpcAs(mgr, 'ace_upload_opentable', { p_rows: [{ ...syntheticRow(9), guestName: 'A Person' }], p_file_name: 'x.csv' });
    ok('rows carrying PII fields are rejected', r.status >= 400 && JSON.stringify(r.body).includes('pii_field_rejected'));

    console.log('\n[save-review-fix: direct save, audit identity, queue removal, reversal]');
    r = await rpcAs(lead, 'ace_save_review_fix', { p_row_hash: T(2), p_action: 'UNDECIDED', p_reason: 'Host entry correction', p_note: 'verify-live' });
    ok('shift lead saves a conflicting-choice fix', r.status === 200 && r.body.saved === true, JSON.stringify(r.body).slice(0, 120));
    let row = (await db.query('select payload from ace_intents where row_hash = $1', [T(2)])).rows[0].payload;
    ok('correction saved directly to shared DB', row.intentEffective === 'UNDECIDED' && row.reviewStatus === 'confirmed');
    ok('original value preserved', row.correction?.original?.intent === 'REVIEW_REQUIRED');
    ok('audit identity from authenticated user (not typed)', row.correction?.user === 'lead.test@example.com');
    const audit = (await db.query('select user_email, action, reason from ace_correction_audit where row_hash = $1 order by created_at desc limit 1', [T(2)])).rows[0];
    ok('append-only audit row written', audit?.user_email === 'lead.test@example.com' && audit?.action === 'UNDECIDED' && audit?.reason === 'Host entry correction');

    r = await rpcAs(mgr, 'ace_save_review_fix', { p_row_hash: T(2), p_action: 'REVERT', p_reason: 'Other', p_note: 'verify reversal' });
    ok('manager reverts the fix', r.status === 200);
    row = (await db.query('select payload from ace_intents where row_hash = $1', [T(2)])).rows[0].payload;
    ok('reversal restores original intent state', row.intentEffective == null && row.reviewStatus === 'pending_review' && (row.correction == null));

    console.log('\n[shift-lead restrictions]');
    await db.query(
      `insert into ace_intents (row_hash, business_date, payload) values ($1, $2, $3)
       on conflict (row_hash) do update set payload = excluded.payload`,
      [T(3), PILOT_DATE, JSON.stringify(syntheticRow(3, { businessDate: PILOT_DATE, intent: 'REVIEW_REQUIRED', reviewStatus: 'pending_review' }))]);
    r = await rpcAs(lead, 'ace_save_review_fix', { p_row_hash: T(3), p_action: 'UNDECIDED', p_reason: 'Host entry correction' });
    ok('shift lead blocked on pilot-window item', r.status >= 400 && JSON.stringify(r.body).includes('manager_required_pilot_window'));
    r = await rpcAs(mgr, 'ace_save_review_fix', { p_row_hash: T(3), p_action: 'UNDECIDED', p_reason: 'Host entry correction' });
    ok('manager allowed on pilot-window item', r.status === 200);

    console.log('\n[replace-metrics authorization]');
    r = await rpcAs(lead, 'ace_replace_metrics', { p_dates: [TEST_DATE], p_rows: [], p_item_rows: [] });
    ok('shift lead cannot replace metrics', r.status >= 400);
    r = await rpcAs(mgr, 'ace_replace_metrics', {
      p_dates: [TEST_DATE],
      p_rows: [{ businessDate: TEST_DATE, period: 'dinner', serverGuid: null, checks: 0, guests: 0, floorNet: 0, ayceChecks: 0, entitlementNet: 0, entitlementCovers: 0, roundCost: 0, matchedQty: 0, totalQty: 0 }],
      p_item_rows: [] });
    ok('manager can replace metrics for declared dates', r.status === 200 && r.body.rows === 1, JSON.stringify(r.body).slice(0, 120));
    r = await rpcAs(mgr, 'ace_replace_metrics', { p_dates: [TEST_DATE], p_rows: [{ businessDate: '20260101', period: 'dinner' }], p_item_rows: [] });
    ok('rows outside declared dates rejected', r.status >= 400 && JSON.stringify(r.body).includes('row_outside_declared_dates'));

    if (withRetry) {
      console.log('\n[retry-toast-update — REAL workflow dispatch]');
      r = await rpcAs(lead, 'ace_retry_toast_update', {});
      ok('shift lead cannot retry Toast', r.status >= 400);
      r = await rpcAs(mgr, 'ace_retry_toast_update', {});
      ok('manager retry returns "Update started"', r.status === 200 && r.body.status === 'Update started', JSON.stringify(r.body).slice(0, 120));
      if (r.status === 200) {
        let accepted = false;
        for (let i = 0; i < 12 && !accepted; i++) {
          await new Promise((res2) => setTimeout(res2, 5000));
          const st = await rpcAs(mgr, 'ace_retry_status', { p_request_id: r.body.requestId });
          if (st.body.done) {
            accepted = st.body.accepted;
            ok(`GitHub accepted the dispatch (HTTP ${st.body.statusCode})`, st.body.accepted, JSON.stringify(st.body));
            break;
          }
        }
        if (accepted) {
          console.log('  … waiting for the ingestion run to appear (GitHub Actions)…');
          const t0 = Date.now();
          let seen = null;
          while (Date.now() - t0 < 8 * 60e3 && !seen) {
            await new Promise((res2) => setTimeout(res2, 20000));
            const runs = await db.query(`select payload from ace_ingestion_runs where run_id like 'nightly-%' order by run_id desc limit 3`);
            seen = runs.rows.map((x) => x.payload).find((p) => Date.parse(p.startedAt ?? 0) > t0 - 60e3);
          }
          ok('nightly ingestion run recorded by the workflow', !!seen, seen ? '' : '(no run within 8 min)');
          if (seen) {
            const t1 = Date.now();
            let final = seen;
            while (Date.now() - t1 < 6 * 60e3 && final.status === 'running') {
              await new Promise((res2) => setTimeout(res2, 20000));
              const runs = await db.query('select payload from ace_ingestion_runs where run_id = $1', [final.runId]);
              final = runs.rows[0]?.payload ?? final;
            }
            ok(`ingestion run finished: ${final.status}`, final.status === 'success', JSON.stringify(final).slice(0, 200));
          }
        }
      }
    } else {
      console.log('\n[retry-toast-update] skipped (pass --with-retry to dispatch the real workflow)');
    }
  } finally {
    console.log('\nCleaning up synthetic rows…');
    await db.query(`delete from ace_intents where row_hash like 'itest%'`);
    await db.query(`delete from ace_correction_audit where row_hash like 'itest%'`);
    await db.query(`delete from ace_item_costs where canonical_name = 'TEST ITEM ZZZ'`);
    await db.query(`delete from ace_metrics where business_date = $1`, [TEST_DATE]);
    await db.query(`delete from ace_item_metrics where business_date = $1`, [TEST_DATE]);
    await db.query(`delete from ace_import_runs where file_hash like 'itest%' or (kind = 'metrics_rebuild' and counts->'dates' ? $1)`, [TEST_DATE]);
    await db.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('VERIFY FAILED:', e); process.exit(1); });
