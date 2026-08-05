// Temporary public-access RPC client.
//
// ACE2026 is only a presentation gate. After that gate, every visitor uses the
// public Supabase anon key and the database authorizes only the narrow
// security-definer functions granted to anon. No service credentials or guest
// PII are stored here.
const SESSION_KEY = 'ace.public.sessionId';
const ACTOR = 'public-site visitor';

let CFG = null;          // { url, anonKey }
const listeners = new Set();

export function initAuth(cfg) { CFG = cfg; }
export function onAuthChange(fn) { listeners.add(fn); }

function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* listener */ } }); }

export function publicSessionId() {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto?.randomUUID ? crypto.randomUUID() : `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export async function whoami() {
  return { role: 'public', email: ACTOR, sessionId: publicSessionId() };
}

export function currentActor() {
  return { role: 'public', email: ACTOR, sessionId: publicSessionId() };
}

export function resetPublicSessionForTests() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* test-only */ }
  emit();
}

/** Call an allowed database function as the public-site visitor. */
export async function rpc(name, args = {}) {
  if (!CFG?.url || !CFG?.anonKey) throw new Error('The shared update service is not configured for this page.');
  const body = { ...args, p_actor_session_id: publicSessionId() };
  const res = await fetch(`${CFG.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: CFG.anonKey, Authorization: `Bearer ${CFG.anonKey}`,
      'Content-Type': 'application/json', Prefer: 'params=single-object',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = json.message || json.error_description || `HTTP ${res.status}`;
    const ref = `E-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    console.error(`[${ref}] ${name} failed:`, json);
    const friendly = {
      not_authorized: 'This action is not available from the public dashboard.',
      github_token_not_configured: 'The update service is not connected yet - ask the administrator to finish setup.',
      retry_cooldown: 'A Toast retry was already started recently. Wait a few minutes before trying again.',
      retry_in_progress: 'A Toast retry is already starting. Wait a moment and check the status.',
      pilot_history_frozen: 'Pilot Review history is frozen. This item is informational and cannot be edited here.',
      reason_required: 'Choose a reason before saving.',
      empty_upload: 'The file did not contain any usable rows.',
      invalid_session: 'Refresh the page and try again.',
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

/** Public PostgREST read with RLS still preserved by Supabase. */
export async function restGet(pathAndQuery, { range } = {}) {
  if (!CFG?.url || !CFG?.anonKey) throw new Error('The shared dashboard data is not configured for this page.');
  const headers = { apikey: CFG.anonKey, Authorization: `Bearer ${CFG.anonKey}` };
  if (range) headers.Range = range;
  const res = await fetch(`${CFG.url}/rest/v1/${pathAndQuery}`, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`${pathAndQuery}: HTTP ${res.status}`);
  return res.json();
}
