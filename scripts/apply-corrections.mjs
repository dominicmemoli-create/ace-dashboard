#!/usr/bin/env node
// Apply MOD/shift-lead corrections exported from the Review Queue page.
//   node scripts/apply-corrections.mjs corrections.json
//
// Each correction carries { rowHash, kind, original, corrected, reason, user, at }.
// The intent row keeps its original source value; the correction is stored
// alongside it (auditable and reversible — re-apply with corrected:'REVERT').
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/apply-corrections.mjs <corrections.json>'); process.exit(1); }
const VALID = new Set(['UNDECIDED', 'ALC', 'PREDECIDED_AYCE', 'EXCLUDE', 'REVERT']);

async function main() {
  const corrections = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let applied = 0, skipped = 0;
  for (const c of corrections) {
    if (!c.rowHash || !VALID.has(c.corrected) || !c.reason || !c.user) {
      console.warn(`SKIP invalid correction: ${JSON.stringify(c).slice(0, 120)}`);
      skipped++; continue;
    }
    const patch = c.corrected === 'REVERT'
      ? { correction: null, intentEffective: null, reviewStatus: 'pending_review' }
      : {
          correction: { original: c.original, corrected: c.corrected, reason: c.reason, user: c.user, at: c.at ?? new Date().toISOString() },
          intentEffective: c.corrected === 'EXCLUDE' ? null : c.corrected,
          reviewStatus: 'confirmed',
          excluded: c.corrected === 'EXCLUDE',
        };
    const res = await client.query(
      `update ace_intents set payload = payload || $2 where row_hash = $1`,
      [c.rowHash, JSON.stringify(patch)]);
    if (res.rowCount) applied++; else { console.warn(`SKIP unknown rowHash ${c.rowHash}`); skipped++; }
  }
  await client.end();
  console.log(`Applied ${applied} correction(s), skipped ${skipped}. Original source values preserved in payload.`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
