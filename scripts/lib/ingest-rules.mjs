// Pure ingestion rules — no database, no Toast client, no side effects.
// Kept separate from scripts/nightly.mjs so the date, secret and freeze rules
// can be unit-tested without pulling in the whole ingestion chain.

// Jul 31 – Aug 2 2026 is the frozen pilot record. Nightly ingestion must never
// re-pull or recalculate those days, even when they are missing from the
// manifest: the published pilot numbers are the ones that were reported.
export const PILOT_WINDOW = ['20260731', '20260802'];
export const isPilotDate = (d) => d >= PILOT_WINDOW[0] && d <= PILOT_WINDOW[1];

/** Yesterday's business date in America/New_York, DST included. */
export function nyYesterday(now = new Date()) {
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setDate(ny.getDate() - 1);
  return `${ny.getFullYear()}${String(ny.getMonth() + 1).padStart(2, '0')}${String(ny.getDate()).padStart(2, '0')}`;
}

/** Business date to ingest: an explicit YYYYMMDD argument, else yesterday in
 *  New York. GitHub's workflow_dispatch input arrives as a string or empty. */
export function resolveTargetDate(arg, now = new Date()) {
  if (/^\d{8}$/.test(arg ?? '')) return arg;
  return nyYesterday(now);
}

/** Every secret the run needs, checked before any network call so a missing
 *  GitHub secret fails with a clear message instead of a driver stack trace. */
export function missingSecrets(env = process.env) {
  return ['SUPABASE_DB_URL', 'TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET']
    .filter((k) => !String(env[k] ?? '').trim());
}
