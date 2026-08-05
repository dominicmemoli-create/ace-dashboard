#!/usr/bin/env node
// Administrator tool: approve a manager / shift-lead email for dashboard sign-in.
//   node scripts/admin/add-manager.mjs someone@example.com manager
//   node scripts/admin/add-manager.mjs someone@example.com shift_lead
//   node scripts/admin/add-manager.mjs someone@example.com --remove
//
// What it does:
//   1. adds the email to ace_approved_emails (role source for new sign-ins)
//   2. creates the Supabase Auth user if it does not exist (email pre-confirmed,
//      so their first magic link signs them straight in)
//   3. sets user_profiles.role for the user
//
// Equivalent SQL (documented for emergencies, run via scripts/admin/apply-sql.mjs):
//   insert into ace_approved_emails (email, role) values ('someone@example.com','manager')
//     on conflict (email) do update set role = excluded.role;
//   update user_profiles set role = 'manager'
//     where id = (select id from auth.users where lower(email) = 'someone@example.com');
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_DB_URL in .env.
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

const email = (process.argv[2] ?? '').trim().toLowerCase();
const roleArg = (process.argv[3] ?? '').trim();
const remove = process.argv.includes('--remove');
const VALID = ['executive', 'manager', 'shift_lead'];
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || (!remove && !VALID.includes(roleArg))) {
  console.error('Usage: node scripts/admin/add-manager.mjs <email> <executive|manager|shift_lead>');
  console.error('       node scripts/admin/add-manager.mjs <email> --remove');
  process.exit(1);
}

const admin = async (method, urlPath, body) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${urlPath}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${urlPath}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
};

const client = new pg.Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  if (remove) {
    await client.query('delete from ace_approved_emails where lower(email) = $1', [email]);
    await client.query(
      `update user_profiles set role = 'server'
       where id = (select id from auth.users where lower(email) = $1)`, [email]);
    console.log(`${email}: removed from approved list; role reset to 'server' (sign-in disabled for manager tools).`);
  } else {
    await client.query(
      `insert into ace_approved_emails (email, role, added_by) values ($1, $2, 'add-manager.mjs')
       on conflict (email) do update set role = excluded.role`, [email, roleArg]);

    const existing = await client.query('select id from auth.users where lower(email) = $1', [email]);
    let userId = existing.rows[0]?.id;
    if (!userId) {
      const user = await admin('POST', '/admin/users', { email, email_confirm: true });
      userId = user.id;
      console.log(`${email}: auth user created.`);
    }
    // trigger handles brand-new users; this covers pre-existing ones + role changes
    await client.query(
      `insert into user_profiles (id, role, display_name) values ($1, $2, split_part($3, '@', 1))
       on conflict (id) do update set role = excluded.role`, [userId, roleArg, email]);
    console.log(`${email}: approved as ${roleArg}. They can now use Manager Mode (email magic link) in the dashboard.`);
  }
} finally {
  await client.end();
}
