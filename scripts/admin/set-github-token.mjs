#!/usr/bin/env node
// Administrator tool: store the GitHub token that lets the dashboard's
// "Retry Toast Update" button dispatch the protected ingestion workflow.
//
//   GITHUB_TOKEN=ghp_xxx node scripts/admin/set-github-token.mjs
//   node scripts/admin/set-github-token.mjs           (uses `gh auth token`)
//
// The token is stored in Supabase Vault (name 'ace_github_pat') and is only
// ever read inside the ace_retry_toast_update() database function — it never
// reaches the browser. Recommended token: a FINE-GRAINED personal access token
// scoped to the ace-dashboard repository with Actions read/write only.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

let token = (process.env.GITHUB_TOKEN ?? '').trim();
if (!token) {
  try { token = execSync('gh auth token', { encoding: 'utf8' }).trim(); }
  catch { /* gh not available */ }
}
if (!token) {
  console.error('No token. Pass GITHUB_TOKEN=... or log in with `gh auth login` first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const existing = await client.query(`select id from vault.secrets where name = 'ace_github_pat'`);
  if (existing.rows.length) {
    await client.query(`select vault.update_secret($1::uuid, $2)`, [existing.rows[0].id, token]);
    console.log('Vault secret ace_github_pat updated.');
  } else {
    await client.query(`select vault.create_secret($1, 'ace_github_pat')`, [token]);
    console.log('Vault secret ace_github_pat created.');
  }
  console.log('Retry Toast Update is now enabled for managers in the dashboard.');
} finally {
  await client.end();
}
