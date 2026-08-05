// Operator sign-in — email magic links, one authenticated operator role.
// There is no manager-versus-shift-lead hierarchy: every approved operator has
// equal capabilities. The passcode gate remains a presentation gate only;
// every write is authorized server-side against the signed-in user
// (see supabase/migrations/0004_operator_role.sql).
//
// There is no persistent "mode" to enter: viewing needs nothing, and the
// sign-in prompt appears at the moment a signed-out person attempts a write.
import {
  initAuth, handleAuthCallback, signInWithEmail, signOut, whoami, onAuthChange,
} from './auth.mjs';

let APP = null;
let who = { role: 'none', email: '' };

// Legacy role names in user_profiles all map to the same operator capability.
const OPERATOR_ROLES = ['executive', 'manager', 'shift_lead'];

/** One capability: an approved, signed-in operator can do everything. */
export const isOperator = () => OPERATOR_ROLES.includes(who.role);
// kept as aliases so call sites read naturally
export const canUploadOpenTable = isOperator;
export const canFix = isOperator;
export const canUploadCosts = isOperator;
export const canRetryToast = isOperator;
export const currentUser = () => who;

/* ------------------------------------------------------------- tiny toast -- */
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

/* ---------------------------------------------------------- sign-in modal -- */
function closeMm() {
  const wrap = document.getElementById('mmwrap');
  if (!wrap) return;
  wrap.remove();
  if (lastFocusEl && lastFocusEl.isConnected) lastFocusEl.focus();
  lastFocusEl = null;
}
let lastFocusEl = null;

export function openSignIn(message) {
  closeMm();
  lastFocusEl = document.activeElement;
  const esc = APP.helpers.esc;
  const wrap = document.createElement('div');
  wrap.id = 'mmwrap';
  wrap.innerHTML = `
  <div style="position:fixed;inset:0;background:rgba(14,18,24,.5);z-index:300" data-mm-close></div>
  <div class="modal show" role="dialog" aria-modal="true" aria-labelledby="mmTitle" style="z-index:310">
    <div class="mh"><div><h3 id="mmTitle">Operator sign-in</h3>
      <div class="s">${who.role === 'none' || who.role === 'server'
        ? 'Sign in with your approved work email. We email you a sign-in link — no password to remember.'
        : `Signed in as <b>${esc(who.email)}</b>`}</div></div>
      <button class="xbtn" type="button" data-mm-close aria-label="Close">✕</button></div>
    <div class="mb" id="mmBody"></div>
  </div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('#mmBody');

  if (who.role === 'none' || who.role === 'server') {
    body.innerHTML = `
      ${message ? `<div class="note gold" style="margin:0 0 12px">${esc(message)}</div>` : ''}
      ${who.role === 'server' ? `<div class="note warn" style="margin:0 0 12px">Your email is signed in but is not on the approved operator list. Ask the administrator to approve it.</div>` : ''}
      <form id="mmForm" style="display:flex;gap:10px;flex-wrap:wrap">
        <label class="sr" for="mmEmail">Work email</label>
        <input id="mmEmail" type="email" required placeholder="you@example.com" autocomplete="email"
          style="flex:1;min-width:220px;padding:10px 14px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface-2)">
        <button class="bigbtn" type="submit">Email me a sign-in link</button>
      </form>
      <div id="mmErr" style="color:var(--neg);font-size:12.5px;min-height:18px;margin-top:8px" role="alert"></div>
      <div class="note" style="margin-top:10px">Open the email on this device and tap the link — you stay signed in here afterwards. Viewing the dashboard never requires signing in; only saving changes does.</div>`;
    wrap.querySelector('#mmForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = wrap.querySelector('#mmErr');
      const btn = wrap.querySelector('.bigbtn');
      btn.disabled = true; err.textContent = '';
      try {
        await signInWithEmail(wrap.querySelector('#mmEmail').value.trim());
        body.innerHTML = `<div class="note" style="border-left-color:var(--pos)"><b>Check your email.</b>
          We sent a sign-in link to <b>${esc(wrap.querySelector('#mmEmail')?.value ?? 'your address')}</b>.
          Open it on this device and you'll be signed in automatically.</div>`;
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
    setTimeout(() => wrap.querySelector('#mmEmail')?.focus(), 60);
  } else {
    body.innerHTML = `
      <div class="calcrow"><span class="cl">Signed in as</span><span class="cr">${esc(who.email)}</span></div>
      <div class="calcrow"><span class="cl">Access</span><span class="cr">Approved operator — uploads, fixes, retries and food costs</span></div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end">
        <button class="bigbtn ghost" type="button" id="mmOut">Sign out</button></div>`;
    wrap.querySelector('#mmOut').addEventListener('click', async () => {
      await signOut();
      closeMm();
      notify('Signed out.');
    });
    setTimeout(() => wrap.querySelector('#mmOut')?.focus(), 60);
  }
  wrap.querySelectorAll('[data-mm-close]').forEach((el) => el.addEventListener('click', closeMm));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMm(); });
}

// legacy name kept for any external callers
export const openManagerModal = openSignIn;

/** Gate a write on being a signed-in operator. Returns true when allowed;
 * otherwise opens the sign-in modal at that moment and returns false. */
export function requireOperator(actionLabel) {
  if (isOperator()) return true;
  openSignIn(`${actionLabel} needs a signed-in operator. Sign in once and you're set.`);
  return false;
}

/** Back-compat shim for the old (check, label) signature. */
export function requireRole(check, actionLabel) {
  return check() ? true : requireOperator(actionLabel);
}

/* -------------------------------------------------------------- bootstrap -- */
function refreshButton() {
  const btn = document.getElementById('acctBtn');
  const lbl = document.getElementById('acctLabel');
  if (!btn || !lbl) return;
  if (isOperator() || who.role === 'server') {
    btn.style.display = '';
    lbl.textContent = who.email.split('@')[0] + (isOperator() ? '' : ' · no access');
  } else {
    btn.style.display = 'none'; // signed out: nothing to manage; writes will prompt
  }
}

export async function initManagerMode(app, cfg) {
  APP = app;
  if (!cfg?.url || !cfg?.anonKey) return; // static mode — no sign-in available
  initAuth(cfg);
  onAuthChange(async () => { who = await whoami(); refreshButton(); });
  try {
    const signedIn = await handleAuthCallback();
    if (signedIn) notify('Signed in.');
  } catch (e) {
    notify(e.message, 'err');
  }
  who = await whoami();
  refreshButton();
  document.getElementById('acctBtn')?.addEventListener('click', () => openSignIn());
}

/** Re-read the current identity (e.g. after token refresh). */
export async function refreshIdentity() {
  who = await whoami();
  refreshButton();
  return who;
}
