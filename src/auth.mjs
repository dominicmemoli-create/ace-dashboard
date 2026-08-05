// Manager Mode authentication — Supabase Auth (email magic links) via the
// GoTrue REST API. No SDK, no service credentials: the browser only ever holds
// the public anon key plus the signed-in user's own JWT. Roles live in
// user_profiles and are enforced server-side (RLS + security-definer RPCs);
// nothing here grants access by itself.
const STORE_KEY = 'ace.auth.session';

let CFG = null;          // { url, anonKey }
let cached = null;       // { role, email } for the current session
const listeners = new Set();

export function initAuth(cfg) { CFG = cfg; }
export function onAuthChange(fn) { listeners.add(fn); }
function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* listener */ } }); }

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
  else localStorage.removeItem(STORE_KEY);
  cached = null;
  emit();
}

/** Pick up a magic-link callback (#access_token=… or ?token_hash=…). */
export async function handleAuthCallback() {
  if (!CFG) return false;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('access_token') && hash.get('refresh_token')) {
    saveSession({
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token'),
      expires_at: Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || 3600),
    });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }
  if (hash.get('error_description')) {
    history.replaceState(null, '', location.pathname + location.search);
    throw new Error(hash.get('error_description'));
  }
  const q = new URLSearchParams(location.search);
  if (q.get('token_hash') && /magiclink|email/.test(q.get('type') ?? '')) {
    const res = await fetch(`${CFG.url}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: q.get('token_hash') }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) {
      saveSession({
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + Number(json.expires_in || 3600),
      });
      history.replaceState(null, '', location.pathname);
      return true;
    }
    history.replaceState(null, '', location.pathname);
    throw new Error(json.error_description || json.msg || 'Sign-in link expired — request a new one.');
  }
  return false;
}

/** Request a magic link for an approved email. */
export async function signInWithEmail(email) {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const res = await fetch(`${CFG.url}/auth/v1/otp?redirect_to=${redirect}`, {
    method: 'POST',
    headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
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

/** Current valid session (refreshes when near expiry). Null when signed out. */
export async function getSession() {
  const s = loadSession();
  if (!s) return null;
  if (s.expires_at - 90 > Date.now() / 1000) return s;
  try {
    const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
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
  } catch { return null; }
}

export async function signOut() {
  const s = loadSession();
  if (s) {
    fetch(`${CFG.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: CFG.anonKey, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  }
  saveSession(null);
}

/** Signed-in identity + role ({role:'none'} when signed out). Cached. */
export async function whoami() {
  if (cached) return cached;
  const s = await getSession();
  if (!s) return { role: 'none', email: '' };
  try {
    const res = await fetch(`${CFG.url}/rest/v1/rpc/ace_whoami`, {
      method: 'POST',
      headers: {
        apikey: CFG.anonKey, Authorization: `Bearer ${s.access_token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) return { role: 'none', email: '' };
    cached = await res.json();
    return cached;
  } catch { return { role: 'none', email: '' }; }
}

/** Call a protected database function as the signed-in user. */
export async function rpc(name, args = {}) {
  const s = await getSession();
  if (!s) throw new Error('Please sign in with Manager Mode first.');
  const res = await fetch(`${CFG.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: CFG.anonKey, Authorization: `Bearer ${s.access_token}`,
      'Content-Type': 'application/json', Prefer: 'params=single-object',
    },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = json.message || json.error_description || `HTTP ${res.status}`;
    const ref = `E-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    console.error(`[${ref}] ${name} failed:`, json);
    const friendly = {
      not_authorized: 'Your account is not allowed to do this. A manager account is required.',
      manager_required_pilot_window: 'This item touches the frozen pilot weekend — a manager must decide it.',
      manager_required_mixed_menu: 'Mixed-menu policy exceptions need a manager decision.',
      github_token_not_configured: 'The update service is not connected yet — ask the administrator to finish setup.',
      reason_required: 'Choose a reason before saving.',
      empty_upload: 'The file did not contain any usable rows.',
      pii_field_rejected: 'The upload contained guest personal data and was rejected. Refresh and try again.',
    };
    for (const [code, msg] of Object.entries(friendly)) {
      if (raw.includes(code)) { const e = new Error(msg); e.ref = ref; throw e; }
    }
    const e = new Error(`Something went wrong saving this update (reference ${ref}). Try again, and mention the reference if it keeps failing.`);
    e.ref = ref;
    throw e;
  }
  return json;
}

/** Authenticated (or anon, when signed out) PostgREST read. */
export async function restGet(pathAndQuery, { range } = {}) {
  const s = await getSession();
  const headers = {
    apikey: CFG.anonKey,
    Authorization: `Bearer ${s ? s.access_token : CFG.anonKey}`,
  };
  if (range) headers.Range = range;
  const res = await fetch(`${CFG.url}/rest/v1/${pathAndQuery}`, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`${pathAndQuery}: HTTP ${res.status}`);
  return res.json();
}
