// Manager authentication — Supabase Auth (email magic links) over the GoTrue
// REST API. No SDK and no service credentials: the browser only ever holds the
// project's publishable key plus the signed-in user's own JWT.
//
// Nothing here grants access. Approval lives in user_profiles and is enforced
// server-side by RLS and the security-definer RPCs in
// supabase/migrations/0006_manager_writes.sql. A caller who bypasses this file
// and posts straight to PostgREST gets exactly the same answer from the database.
const STORE_KEY = 'ace.auth.session';

let CFG = null;          // { url, publishableKey }
let cached = null;       // { role, email } for the current session
const listeners = new Set();

/** The browser key. `publishableKey` is the current name; `anonKey` is accepted
 *  so an older cached copy of data/supabase_config.json still works. */
export const browserKey = (cfg = CFG) => cfg?.publishableKey ?? cfg?.anonKey ?? null;
export const hasConfig = (cfg = CFG) => Boolean(cfg?.url && browserKey(cfg));

export function initAuth(cfg) { CFG = cfg; }
export function onAuthChange(fn) { listeners.add(fn); }
function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* listener */ } }); }

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
function saveSession(s) {
  try {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* private browsing: nothing persists, the page session still works */ }
  cached = null;
  emit();
}

function storeTokens({ access_token, refresh_token, expires_in }) {
  saveSession({
    access_token,
    refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(expires_in || 3600),
  });
}

/** Pick up a magic-link callback (#access_token=… or ?token_hash=…).
 *  Returns true when a session was established. Throws with a readable message
 *  when the link was already used or has expired. */
export async function handleAuthCallback() {
  if (!hasConfig()) return false;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('access_token') && hash.get('refresh_token')) {
    storeTokens({
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token'),
      expires_in: hash.get('expires_in'),
    });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }
  if (hash.get('error_description') || hash.get('error')) {
    const msg = hash.get('error_description') || hash.get('error');
    history.replaceState(null, '', location.pathname + location.search);
    throw new Error(/expired|invalid/i.test(msg)
      ? 'That sign-in link has expired or was already used. Request a new one.'
      : msg);
  }
  const q = new URLSearchParams(location.search);
  if (q.get('token_hash') && /magiclink|email/.test(q.get('type') ?? '')) {
    const res = await fetch(`${CFG.url}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: browserKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: q.get('token_hash') }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) {
      storeTokens(json);
      history.replaceState(null, '', location.pathname);
      return true;
    }
    history.replaceState(null, '', location.pathname);
    throw new Error(json.error_description || json.msg
      || 'That sign-in link has expired or was already used. Request a new one.');
  }
  return false;
}

/** Request a magic link for an approved email. `create_user: false` means an
 *  address that is not already an auth user is refused by Supabase itself. */
export async function signInWithEmail(email) {
  if (!hasConfig()) throw new Error('Sign-in is not available on this build.');
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const res = await fetch(`${CFG.url}/auth/v1/otp?redirect_to=${redirect}`, {
    method: 'POST',
    headers: { apikey: browserKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, create_user: false }),
  });
  if (res.ok) return true;
  const json = await res.json().catch(() => ({}));
  const msg = json.error_description || json.msg || json.message || '';
  if (res.status === 422 || /signup|not allowed|not found/i.test(msg)) {
    throw new Error('That email is not on the approved manager list. Ask the administrator to add it.');
  }
  if (res.status === 429) {
    throw new Error('Too many sign-in emails just now — wait a minute and try again.');
  }
  throw new Error('Could not send the sign-in email. Check the address and try again.');
}

/** Current valid session (refreshes when near expiry). Null when signed out.
 *  Refresh is single-flight: refresh tokens are one-time-use, so concurrent
 *  callers (a page load after the laptop wakes up) must share one request
 *  instead of racing each other into a spurious sign-out. */
let refreshing = null;
export async function getSession() {
  const s = loadSession();
  if (!s || !hasConfig()) return null;
  if (s.expires_at - 90 > Date.now() / 1000) return s;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { apikey: browserKey(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: s.refresh_token }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.access_token) { saveSession(null); return null; }
        const next = {
          access_token: json.access_token,
          refresh_token: json.refresh_token ?? s.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + Number(json.expires_in || 3600),
        };
        saveSession(next);
        return next;
      } catch {
        return s;   // transient network failure: keep the stored session
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

export async function signOut() {
  const s = loadSession();
  if (s && hasConfig()) {
    fetch(`${CFG.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: browserKey(), Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  }
  saveSession(null);
  cached = null;
}

/** Signed-in identity and role.
 *   { role: 'none' }         signed out
 *   { role: 'unauthorized' } signed in, not an approved operator
 *   { role: 'manager' … }    approved operator
 *  The role is reported by the database, not decided here. */
export async function whoami() {
  if (cached) return cached;
  const s = await getSession();
  if (!s) return { role: 'none', email: '' };
  try {
    const res = await fetch(`${CFG.url}/rest/v1/rpc/ace_whoami`, {
      method: 'POST',
      headers: {
        apikey: browserKey(), Authorization: `Bearer ${s.access_token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) return { role: 'none', email: '' };
    const json = await res.json();
    cached = json?.role === 'public' ? { role: 'none', email: '' } : json;
    return cached;
  } catch { return { role: 'none', email: '' }; }
}

export function forgetIdentityCache() { cached = null; }

export const FRIENDLY = {
  not_signed_in: 'Please sign in first — saving changes needs a signed-in manager.',
  not_authorized: 'Your account is not on the approved manager list. Ask the administrator to approve it.',
  github_token_not_configured: 'The update service is not connected yet — ask the administrator to finish setup.',
  retry_cooldown: 'A Toast update was already started in the last 10 minutes. Wait a few minutes before trying again.',
  retry_daily_limit: 'The daily limit for Toast updates has been reached. Try again tomorrow, or ask the administrator.',
  retry_in_progress: 'A Toast update is already starting. Wait a moment and check the status.',
  unknown_request: 'That update reference is no longer available.',
  pilot_history_frozen: 'Pilot history (Jul 31 – Aug 2) is frozen and cannot be changed.',
  reason_required: 'Choose a reason before saving.',
  empty_upload: 'The file did not contain any usable rows.',
  too_many_rows: 'That file is larger than the upload limit. Split it and try again.',
  pii_field_rejected: 'The upload contained guest personal data and was rejected. Refresh and try again.',
};

/** Call a protected database function as the signed-in manager. */
export async function rpc(name, args = {}) {
  if (!hasConfig()) throw new Error('The shared update service is not configured for this page.');
  const s = await getSession();
  if (!s) throw new Error(FRIENDLY.not_signed_in);
  const res = await fetch(`${CFG.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: browserKey(), Authorization: `Bearer ${s.access_token}`,
      'Content-Type': 'application/json', Prefer: 'params=single-object',
    },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = json.message || json.error_description || `HTTP ${res.status}`;
    const ref = `E-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    console.error(`[${ref}] ${name} failed:`, json);
    // An expired or revoked session reads as 401 from PostgREST. Say so plainly
    // and clear it, instead of showing a generic failure nobody can act on.
    if (res.status === 401) {
      saveSession(null);
      const e = new Error('Your session expired. Sign in again to save this change.');
      e.ref = ref; e.signedOut = true;
      throw e;
    }
    for (const [code, msg] of Object.entries(FRIENDLY)) {
      if (raw.includes(code)) { const e = new Error(msg); e.ref = ref; e.code = code; throw e; }
    }
    const e = new Error(`Something went wrong saving this update (reference ${ref}). Try again, and mention the reference if it keeps failing.`);
    e.ref = ref;
    throw e;
  }
  return json;
}

/** PostgREST read — as the signed-in manager when there is a session, otherwise
 *  as the anonymous public visitor. RLS decides what comes back either way. */
export async function restGet(pathAndQuery, { range } = {}) {
  if (!hasConfig()) throw new Error('The shared dashboard data is not configured for this page.');
  const s = await getSession();
  const key = browserKey();
  const headers = { apikey: key, Authorization: `Bearer ${s ? s.access_token : key}` };
  if (range) headers.Range = range;
  const res = await fetch(`${CFG.url}/rest/v1/${pathAndQuery}`, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`${pathAndQuery}: HTTP ${res.status}`);
  return res.json();
}
