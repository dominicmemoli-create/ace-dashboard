// Manager sign-in — email magic links, one authenticated operator capability.
//
// The ACE2026 passcode is a presentation gate and authorizes nothing. Viewing
// the dashboard needs no account; every write is authorized server-side against
// the signed-in user (supabase/migrations/0006_manager_writes.sql). Hiding a
// button here is a courtesy, not a control — the database refuses the same call
// made directly against PostgREST.
//
// There is no persistent "mode" to enter: the sign-in prompt appears at the
// moment a signed-out person attempts a write.
import {
  initAuth, handleAuthCallback, signInWithEmail, signOut, whoami, onAuthChange, hasConfig,
} from './auth.mjs?v=20260806-manager-auth';

let APP = null;
let who = { role: 'none', email: '' };

// Legacy role names in user_profiles all map to the same operator capability.
const OPERATOR_ROLES = ['executive', 'manager', 'shift_lead'];

/** One capability: an approved, signed-in manager can do everything. */
export const isOperator = () => OPERATOR_ROLES.includes(who.role);
// kept as aliases so call sites read naturally
export const canUploadOpenTable = isOperator;
export const canFix = isOperator;
export const canUploadCosts = isOperator;
export const canRetryToast = isOperator;
export const currentUser = () => who;
export const isSignedInUnapproved = () => who.role === 'unauthorized' || who.role === 'server';

/* ------------------------------------------------------------- tiny toast -- */
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

/* ---------------------------------------------------------- sign-in modal -- */
let lastFocusEl = null;
function closeMm() {
  const wrap = document.getElementById('mmwrap');
  if (!wrap) return;
  wrap.remove();
  if (lastFocusEl && lastFocusEl.isConnected) lastFocusEl.focus();
  lastFocusEl = null;
}

export function openSignIn(message) {
  if (!hasConfig()) {
    notify('This build is showing backup data and cannot sign in.', 'err');
    return;
  }
  closeMm();
  lastFocusEl = document.activeElement;
  const esc = APP?.helpers?.esc ?? ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const wrap = document.createElement('div');
  wrap.id = 'mmwrap';
  const signedOut = !isOperator();
  wrap.innerHTML = `
  <div style="position:fixed;inset:0;background:rgba(14,18,24,.5);z-index:300" data-mm-close></div>
  <div class="modal show" role="dialog" aria-modal="true" aria-labelledby="mmTitle" style="z-index:310">
    <div class="mh"><div><h3 id="mmTitle">Manager sign-in</h3>
      <div class="s">${signedOut
        ? 'Sign in with your approved work email. We email you a sign-in link — no password to remember.'
        : `Signed in as <b>${esc(who.email)}</b>`}</div></div>
      <button class="xbtn" type="button" data-mm-close aria-label="Close">✕</button></div>
    <div class="mb" id="mmBody"></div>
  </div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('#mmBody');

  if (signedOut) {
    body.innerHTML = `
      ${message ? `<div class="note gold" style="margin:0 0 12px">${esc(message)}</div>` : ''}
      ${isSignedInUnapproved() ? `<div class="note warn" style="margin:0 0 12px">You are signed in as
        <b>${esc(who.email)}</b>, but that address is not on the approved manager list. Ask the
        administrator to approve it, or sign out and use your approved work email.</div>` : ''}
      <form id="mmForm" style="display:flex;gap:10px;flex-wrap:wrap">
        <label class="sr" for="mmEmail">Work email</label>
        <input id="mmEmail" type="email" required placeholder="you@example.com" autocomplete="email"
          style="flex:1;min-width:220px;padding:10px 14px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface-2)">
        <button class="bigbtn" type="submit">Email me a sign-in link</button>
      </form>
      <div id="mmErr" style="color:var(--neg);font-size:12.5px;min-height:18px;margin-top:8px" role="alert"></div>
      ${isSignedInUnapproved() ? `<div style="margin-top:14px;display:flex;justify-content:flex-end">
        <button class="bigbtn ghost" type="button" id="mmOut">Sign out</button></div>` : ''}
      <div class="note" style="margin-top:10px">Open the email on this device and tap the link — you stay
        signed in here afterwards. Viewing the dashboard never requires signing in; only saving changes does.</div>`;
    wrap.querySelector('#mmForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = wrap.querySelector('#mmErr');
      const btn = wrap.querySelector('button[type="submit"]');
      const addr = wrap.querySelector('#mmEmail').value.trim();
      btn.disabled = true; err.textContent = '';
      try {
        await signInWithEmail(addr);
        body.innerHTML = `<div class="note" style="border-left-color:var(--pos)"><b>Check your email.</b>
          We sent a sign-in link to <b>${esc(addr)}</b>.
          Open it on this device and you'll be signed in automatically. The link works once and expires.</div>`;
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
    wrap.querySelector('#mmOut')?.addEventListener('click', async () => {
      await signOut();
      await refreshIdentity();
      closeMm();
      notify('Signed out.');
    });
    setTimeout(() => wrap.querySelector('#mmEmail')?.focus(), 60);
  } else {
    body.innerHTML = `
      <div class="calcrow"><span class="cl">Signed in as</span><span class="cr">${esc(who.email)}</span></div>
      <div class="calcrow"><span class="cl">Access</span><span class="cr">Approved manager — uploads, fixes, retries and food costs</span></div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end">
        <button class="bigbtn ghost" type="button" id="mmOut">Sign out</button></div>`;
    wrap.querySelector('#mmOut').addEventListener('click', async () => {
      await signOut();
      await refreshIdentity();
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

/** Gate a write on being a signed-in manager. Returns true when allowed;
 * otherwise opens the sign-in modal at that moment and returns false. */
export function requireOperator(actionLabel) {
  if (isOperator()) return true;
  openSignIn(`${actionLabel} needs a signed-in manager. Sign in once and you're set.`);
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
  if (isOperator() || isSignedInUnapproved()) {
    btn.style.display = '';
    lbl.textContent = (who.email || '').split('@')[0] + (isOperator() ? '' : ' · no access');
  } else {
    btn.style.display = 'none'; // signed out: nothing to manage; writes will prompt
  }
}

export async function initManagerMode(app, cfg) {
  APP = app;
  if (!hasConfig(cfg)) return; // static backup mode — no sign-in available
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

/** Re-read the current identity (e.g. after token refresh or sign-out). */
export async function refreshIdentity() {
  who = await whoami();
  refreshButton();
  return who;
}
