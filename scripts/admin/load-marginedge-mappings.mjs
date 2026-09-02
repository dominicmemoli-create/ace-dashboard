#!/usr/bin/env node
// Load Toast <-> MarginEdge mappings into ace_marginedge_mappings.
//
//   node scripts/admin/load-marginedge-mappings.mjs                    # dry run
//   node scripts/admin/load-marginedge-mappings.mjs --apply
//   node scripts/admin/load-marginedge-mappings.mjs --file path.json --apply
//
// Toast item GUIDs are resolved from audit/marginedge_reconciliation.json by
// canonical name, so the seed file does not have to carry them by hand.
//
// SAFETY
//   * a mapping already marked 'confirmed' in the database is NEVER downgraded
//     or overwritten by a 'proposed' row from a seed file — chef decisions stick.
//   * every row is validated before anything is written.
//   * dry run is the default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotEnv } from '../lib/marginedge-client.mjs';
import { validateMapping, normalizeName } from '../../src/marginedge-cost.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PLACEHOLDER_GUID = /^[0-9a-f]{4}0000-0000-0000-0000-0{12}\d*$/i;

function resolveGuids(mappings) {
  const artifactPath = path.join(ROOT, 'audit', 'marginedge_reconciliation.json');
  if (!fs.existsSync(artifactPath)) return { mappings, unresolved: [] };
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const byName = new Map();
  for (const it of artifact.items ?? []) {
    if (it.toastItemGuid) byName.set(normalizeName(it.toastItemName), it.toastItemGuid);
  }
  const unresolved = [];
  const out = mappings.map((m) => {
    const looked = byName.get(normalizeName(m.canonicalName));
    if (looked) return { ...m, toastItemGuid: looked };
    if (!m.toastItemGuid || PLACEHOLDER_GUID.test(m.toastItemGuid)) {
      unresolved.push(m.canonicalName);
      return { ...m, toastItemGuid: null };
    }
    return m;
  });
  return { mappings: out, unresolved };
}

async function main() {
  loadDotEnv(ROOT);
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const iFile = argv.indexOf('--file');
  const file = iFile >= 0 ? argv[iFile + 1] : path.join(ROOT, 'config', 'marginedge_mappings.seed.json');

  if (!process.env.SUPABASE_DB_URL) {
    console.error('Missing SUPABASE_DB_URL. See docs/CREDENTIALS.md.');
    process.exit(1);
  }

  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const unitId = seed.marginedgeRestaurantUnitId
    ?? Number(process.env.MARGINEDGE_RESTAURANT_UNIT_ID);
  const { mappings: resolved, unresolved } = resolveGuids(seed.mappings ?? []);

  if (unresolved.length) {
    console.warn(
      `${unresolved.length} mapping(s) have no Toast item GUID and will be keyed on `
      + `canonical name only: ${unresolved.join(', ')}`);
    console.warn('Run `node scripts/audit-marginedge-costs.mjs` first so GUIDs can be resolved.');
  }

  const rows = [];
  const rejected = [];
  for (const m of resolved) {
    const payload = {
      ...m,
      locationId: m.locationId ?? seed.locationId ?? process.env.TOAST_RESTAURANT_GUID ?? null,
      marginedgeRestaurantUnitId: m.marginedgeRestaurantUnitId ?? unitId,
      reviewStatus: m.reviewStatus ?? 'proposed',
    };
    const problems = validateMapping(payload);
    if (problems.length) { rejected.push({ name: m.canonicalName, problems }); continue; }
    const id = m.id ?? `memap-${normalizeName(m.canonicalName).replace(/ /g, '-')}`;
    rows.push({ id, payload: { ...payload, id } });
  }

  console.log(`${rows.length} valid mapping(s); ${rejected.length} rejected.`);
  for (const r of rejected) console.log(`  REJECT ${r.name}: ${r.problems.join('; ')}`);

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const existing = await client.query('select id, review_status from ace_marginedge_mappings');
    const confirmed = new Set(existing.rows.filter((r) => r.review_status === 'confirmed').map((r) => r.id));

    let willInsert = 0, willUpdate = 0, protectedCount = 0;
    for (const r of rows) {
      if (confirmed.has(r.id) && r.payload.reviewStatus !== 'confirmed') { protectedCount++; continue; }
      if (existing.rows.some((e) => e.id === r.id)) willUpdate++; else willInsert++;
    }
    console.log(`Plan — insert ${willInsert}, update ${willUpdate}, protected (already confirmed) ${protectedCount}.`);

    if (!apply) {
      console.log('DRY RUN — nothing written. Re-run with --apply.');
      return;
    }
    const now = new Date().toISOString();
    for (const r of rows) {
      if (confirmed.has(r.id) && r.payload.reviewStatus !== 'confirmed') continue;
      await client.query(
        `insert into ace_marginedge_mappings (id, payload, updated_at)
         values ($1, $2, now())
         on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
        [r.id, JSON.stringify({ ...r.payload, createdAt: r.payload.createdAt ?? now, updatedAt: now })]);
    }
    console.log(`Loaded ${rows.length - protectedCount} mapping(s).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('LOAD FAILED:', e.message); process.exit(1); });
