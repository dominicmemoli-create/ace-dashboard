#!/usr/bin/env node
// Administrator tool: apply a SQL file to the Supabase Postgres database.
//   node scripts/admin/apply-sql.mjs supabase/migrations/0003_manager_tools.sql
// Reads SUPABASE_DB_URL from .env (gitignored). Never needed by managers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/admin/apply-sql.mjs <file.sql>'); process.exit(1); }

const sql = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  console.log(`Applied ${file}`);
} finally {
  await client.end();
}
