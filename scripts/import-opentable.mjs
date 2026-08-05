#!/usr/bin/env node
// OpenTable GuestCenter import → sanitized intent records in Supabase.
//   npm run import:opentable -- "path/to/GuestCenter_export.csv"
//
// PII policy: guest name, phone, guest requests and visit notes are read for
// parsing only and NEVER written to the database or any dashboard-readable
// store. The published record is the sanitized shape in src/opentable.mjs.
// Idempotent: rows are keyed by a source-row hash; re-importing the same file
// changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGuestCenter, sanitizeVisit } from '../src/opentable.mjs';
import { toastVisits, matchVisits } from '../src/ot-matcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const OPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operations.json'), 'utf8'));

const file = process.argv[2];
if (!file) { console.error('Usage: npm run import:opentable -- <GuestCenter.csv>'); process.exit(1); }

async function main() {
  const runId = `ot-${Date.now()}`;
  const visits = parseGuestCenter(fs.readFileSync(file, 'utf8'));
  console.log(`Parsed ${visits.length} rows from ${path.basename(file)}`);

  const completed = visits.filter((v) => /^(done|completed|complete)$/i.test(v.status));
  const rejected = visits.length - completed.length;
  const sanitized = completed.map((v) => sanitizeVisit(v, runId));

  // intent census
  const byIntent = {};
  for (const s of sanitized) byIntent[s.intent] = (byIntent[s.intent] ?? 0) + 1;
  const halfHalf = sanitized.filter((s) => s.halfHalf).length;
  console.log('Intent counts:', JSON.stringify(byIntent), '| Half/Half noted (metadata only):', halfHalf, '| rejected (not completed):', rejected);

  // ---- match against Toast visits per business date (from local normalized data)
  const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live', 'reference.json'), 'utf8'));
  const dates = [...new Set(sanitized.map((s) => s.businessDate))].sort();
  const cfg = {
    ...OPS.opentableMatch,
    timezone: OPS.servicePeriods.timezone,
  };
  const opsFilter = (c) =>
    (c.serviceAreaGuid && c.serviceAreaGuid in OPS.includedAreas.serviceAreaGuids) ||
    (!c.serviceAreaGuid && c.revenueCenterGuid in OPS.includedAreas.revenueCenterGuids);
  const areaNameOf = (c) =>
    (c.serviceAreaGuid && OPS.includedAreas.serviceAreaGuids[c.serviceAreaGuid]) ||
    (c.revenueCenterGuid && OPS.includedAreas.revenueCenterGuids[c.revenueCenterGuid]) || null;
  const areaOf = (c) => {
    const n = areaNameOf(c);
    return n ? (/patio/i.test(n) ? 'patio' : 'dining') : null;
  };

  let all = [];
  for (const date of dates) {
    const checksPath = path.join(ROOT, 'data', 'live', `checks_${date}.json`);
    const rows = sanitized.filter((s) => s.businessDate === date);
    if (!fs.existsSync(checksPath)) {
      console.warn(`No Toast data for ${date} — ${rows.length} OT rows stay unmatched`);
      all.push(...rows);
      continue;
    }
    const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
    const tv = toastVisits(checks, reference, opsFilter, { areaOf });
    const matched = matchVisits(rows, tv, cfg);
    // annotate conversion facts: did the matched Toast visit ring an AYCE
    // entitlement, and which server owns it (final-owner attribution)?
    // A missing selections file (partial sync) degrades to "no AYCE evidence"
    // for that date instead of aborting the whole import.
    const selPath = path.join(ROOT, 'data', 'live', `selections_${date}.json`);
    const selections = fs.existsSync(selPath) ? JSON.parse(fs.readFileSync(selPath, 'utf8')) : [];
    const ayceOrders = new Set(selections.filter((s) => !s.voided && /PER PERSON|\(kids\)/i.test(s.itemName ?? '')).map((s) => s.orderGuid));
    const orderServer = new Map(checks.map((c) => [c.orderGuid, c.serverGuid]));
    for (const r of matched) {
      if (r.matchedOrderGuid) {
        r.hasAyceSales = ayceOrders.has(r.matchedOrderGuid);
        r.matchedServerGuid = orderServer.get(r.matchedOrderGuid) ?? null;
      }
    }
    all.push(...matched);
  }

  const st = { matched: 0, ambiguous: 0, unmatched: 0 };
  for (const r of all) st[r.matchStatus]++;
  console.log(`Match results: ${st.matched} matched, ${st.ambiguous} ambiguous, ${st.unmatched} unmatched`);

  // ---- write to Supabase
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`
    create table if not exists ace_intents (
      row_hash text primary key,
      business_date text not null,
      payload jsonb not null,
      imported_at timestamptz not null default now()
    );
    create index if not exists ace_intents_date_idx on ace_intents (business_date);
    alter table ace_intents enable row level security;
    do $$ begin
      if not exists (select 1 from pg_policies where tablename='ace_intents' and policyname='poc_read') then
        create policy poc_read on ace_intents for select using (true);
      end if;
    end $$;`);
  let added = 0, dup = 0;
  for (let i = 0; i < all.length; i += 200) {
    const batch = all.slice(i, i + 200);
    const res = await client.query(
      `insert into ace_intents (row_hash, business_date, payload)
       select x->>'rowHash', x->>'businessDate', x from jsonb_array_elements($1::jsonb) x
       on conflict (row_hash) do nothing`,
      [JSON.stringify(batch)]);
    added += res.rowCount;
  }
  dup = all.length - added;
  const n = await client.query('select count(*) n from ace_intents');
  console.log(`Supabase: ${added} inserted, ${dup} already present (idempotent); ace_intents holds ${n.rows[0].n} rows.`);
  await client.end();

  // PII assertion: nothing sensitive in what we stored
  const leaky = all.filter((r) => 'guestName' in r || 'phone' in r || 'guestRequests' in r || 'visitNotes' in r);
  if (leaky.length) throw new Error('PII leak detected in sanitized rows — aborting');
  console.log('PII check: clean (no name/phone/requests/notes stored).');
}

main().catch((e) => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
