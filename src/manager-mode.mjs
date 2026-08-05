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
    // one persistent live region: screen readers announce each message that
    // lands in it without the container itself stealing focus
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'false');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toastmsg${kind === 'err' ? ' err' : ''}`;
  // the container is already a polite live region, so ordinary confirmations
  // need no role of their own; errors escalate to assertive
  if (kind === 'err') t.setAttribute('role', 'alert');
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
