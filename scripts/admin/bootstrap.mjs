#!/usr/bin/env node
// Deterministic database bootstrap for a clean ACE Supabase project.
//
//   node scripts/admin/bootstrap.mjs              # live stack (recommended)
//   node scripts/admin/bootstrap.mjs --with-legacy-schema
//   node scripts/admin/bootstrap.mjs --dry-run
//
// Applies migrations in dependency order inside a single transaction per file,
// so a clean project reaches the exact production posture without anyone having
// to remember which ingestion script happens to create which table.
//
// Reads SUPABASE_DB_URL from .env (gitignored). Never prints secret values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// pg is imported lazily inside main() so the migration-order helpers below stay
// importable (and unit-testable) without the database driver present.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The live stack. 0001/0002 define an earlier fully-normalized schema that the
// running dashboard does not read; they are opt-in so a clean project is not
// littered with twenty unused tables.
export const LIVE_MIGRATIONS = [
  '0000_ace_core_tables.sql',   // flat ace_* tables, indexes, RLS enabled
  '0003_manager_tools.sql',     // user_profiles, ace_approved_emails, audit, import runs
  '0004_operator_role.sql',     // one operator capability
  '0005_upload_rematch.sql',    // opentable upload re-match behaviour
  '0006_manager_writes.sql',    // production authorization: policies, grants, RPCs
];

export const LEGACY_MIGRATIONS = ['0001_schema.sql', '0002_rls.sql'];

// Extensions the RPC layer genuinely needs. pg_net powers the Toast retry
// dispatch; supabase_vault stores the GitHub token. Nothing else is enabled.
const EXTENSIONS = [
  'create extension if not exists pg_net with schema extensions;',
  'create extension if not exists supabase_vault with schema vault cascade;',
];

export function migrationOrder({ withLegacy = false } = {}) {
  return withLegacy
    ? [LEGACY_MIGRATIONS[0], LEGACY_MIGRATIONS[1], ...LIVE_MIGRATIONS]
    : LIVE_MIGRATIONS;
}

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadDotEnv();
  const withLegacy = process.argv.includes('--with-legacy-schema');
  const dryRun = process.argv.includes('--dry-run');
  const order = migrationOrder({ withLegacy });

  if (dryRun) {
    console.log('Would apply, in order:');
    order.forEach((f, i) => console.log(`  ${i + 1}. supabase/migrations/${f}`));
    return;
  }

  if (!process.env.SUPABASE_DB_URL) {
    console.error('SUPABASE_DB_URL missing. Add it to .env (see docs/CREDENTIALS.md).');
    process.exit(1);
  }

  const pg = (await import('pg')).default;
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  // Never echo the connection string; the project ref alone is enough to
  // confirm the operator is pointed at the right database.
  const { rows } = await client.query('select current_database() db');
  console.log(`Connected to ${rows[0].db}.`);

  try {
    for (const stmt of EXTENSIONS) {
      try {
        await client.query(stmt);
      } catch (e) {
        console.warn(`  extension step skipped: ${e.message}`);
      }
    }

    for (const file of order) {
      const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('commit');
        console.log(`applied  ${file}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`${file} failed (rolled back): ${e.message}`);
      }
    }
    console.log('\nBootstrap complete. Next: node scripts/deploy-supabase.mjs (seed), then scripts/nightly.mjs.');
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bootstrap.mjs')) {
  await main();
}
