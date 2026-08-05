// Temporary public-access model.
//
// The ACE2026 passcode remains a presentation gate only. After that, every
// visitor has the same browser capabilities. Server-side safety comes from
// narrow security-definer RPC functions, RLS, validation, and audit logging.
import { initAuth, currentActor } from './auth.mjs?v=20260805-open-access';

let who = currentActor();

export const isOperator = () => true;
export const canUploadOpenTable = isOperator;
export const canFix = isOperator;
export const canUploadCosts = isOperator;
export const canRetryToast = isOperator;
export const currentUser = () => who;

export function notify(msg, kind = 'ok') {
  let host = document.getElementById('acetoast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'acetoast';
    host.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:400;display:flex;flex-direction:column;gap:8px;align-items:center';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.setAttribute('role', 'status');
  t.style.cssText = `background:${kind === 'err' ? 'var(--neg)' : 'var(--nav-bg)'};color:#fff;padding:10px 18px;border-radius:99px;font-size:13.5px;font-weight:600;box-shadow:var(--shadow-3);max-width:min(560px,90vw)`;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, kind === 'err' ? 6000 : 3500);
}

export function openSignIn() {
  notify('No sign-in is needed in this temporary presentation build.');
}
export const openManagerModal = openSignIn;

export function requireOperator() {
  return true;
}

export function requireRole() {
  return true;
}

function refreshButton() {
  const btn = document.getElementById('acctBtn');
  if (btn) btn.style.display = 'none';
}

export async function initManagerMode(app, cfg) {
  if (cfg?.url && cfg?.anonKey) initAuth(cfg);
  who = currentActor();
  refreshButton();
}

export async function refreshIdentity() {
  who = currentActor();
  refreshButton();
  return who;
}
