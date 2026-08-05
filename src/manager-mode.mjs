// Manager Mode UI — email magic-link sign-in, role display, and action gating.
// The passcode gate remains a presentation gate only; every write is authorized
// server-side against the signed-in user's role (see supabase/migrations/0003).
import {
  initAuth, handleAuthCallback, signInWithEmail, signOut, whoami, onAuthChange,
} from './auth.mjs';

let APP = null;
let who = { role: 'none', email: '' };

const ROLE_LABEL = {
  executive: 'Executive', manager: 'Manager', shift_lead: 'Shift lead',
  server: 'No manager access', none: 'Signed out',
};

export const canUploadOpenTable = () => ['executive', 'manager', 'shift_lead'].includes(who.role);
export const canFix = () => ['executive', 'manager', 'shift_lead'].includes(who.role);
export const canUploadCosts = () => ['executive', 'manager'].includes(who.role);
export const canRetryToast = () => ['executive', 'manager'].includes(who.role);
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
function closeMm() { document.getElementById('mmwrap')?.remove(); }

export function openManagerModal(message) {
  closeMm();
  const esc = APP.helpers.esc;
  const wrap = document.createElement('div');
  wrap.id = 'mmwrap';
  wrap.innerHTML = `
  <div style="position:fixed;inset:0;background:rgba(14,18,24,.5);z-index:300" data-mm-close></div>
  <div class="modal show" role="dialog" aria-modal="true" aria-label="Manager Mode" style="z-index:310">
    <div class="mh"><div><h3>Manager Mode</h3>
      <div class="s">${who.role === 'none' || who.role === 'server'
        ? 'Sign in with your approved work email. We email you a sign-in link — no password to remember.'
        : `Signed in as <b>${esc(who.email)}</b> · ${ROLE_LABEL[who.role]}`}</div></div>
      <button class="xbtn" type="button" data-mm-close aria-label="Close">✕</button></div>
    <div class="mb" id="mmBody"></div>
  </div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('#mmBody');

  if (who.role === 'none' || who.role === 'server') {
    body.innerHTML = `
      ${message ? `<div class="note gold" style="margin:0 0 12px">${esc(message)}</div>` : ''}
      ${who.role === 'server' ? `<div class="note warn" style="margin:0 0 12px">Your email is signed in but has no manager access. Ask the administrator to approve it.</div>` : ''}
      <form id="mmForm" style="display:flex;gap:10px;flex-wrap:wrap">
        <input id="mmEmail" type="email" required placeholder="you@example.com" autocomplete="email"
          style="flex:1;min-width:220px;padding:10px 14px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface-2)">
        <button class="bigbtn" type="submit">Email me a sign-in link</button>
      </form>
      <div id="mmErr" style="color:var(--neg);font-size:12.5px;min-height:18px;margin-top:8px" role="alert"></div>
      <div class="note" style="margin-top:10px">Open the email on this device and tap the link — you stay signed in here afterwards.</div>`;
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
      <div class="calcrow"><span class="cl">Access level</span><span class="cr">${ROLE_LABEL[who.role]}</span></div>
      <div class="calcrow"><span class="cl">Can do</span><span class="cr" style="font-weight:500;text-align:right">${
        who.role === 'shift_lead'
          ? 'Upload OpenTable files · resolve everyday fixes'
          : 'Upload OpenTable files · update food costs · resolve fixes · retry Toast updates'}</span></div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end">
        <button class="bigbtn ghost" type="button" id="mmOut">Sign out</button></div>`;
    wrap.querySelector('#mmOut').addEventListener('click', async () => {
      await signOut();
      closeMm();
      notify('Signed out.');
    });
  }
  wrap.querySelectorAll('[data-mm-close]').forEach((el) => el.addEventListener('click', closeMm));
}

/** Gate an action on a role set. Returns true when allowed; otherwise opens
 * the sign-in modal (with a plain explanation) and returns false. */
export function requireRole(check, actionLabel) {
  if (check()) return true;
  openManagerModal(`${actionLabel} needs Manager Mode.`);
  return false;
}

/* -------------------------------------------------------------- bootstrap -- */
function refreshButton() {
  const btn = document.getElementById('mmBtn');
  const lbl = document.getElementById('mmLabel');
  if (!btn || !lbl) return;
  btn.style.display = '';
  lbl.textContent = (who.role === 'none') ? 'Sign in'
    : (who.role === 'server') ? 'No access'
    : `${who.email.split('@')[0]} · ${ROLE_LABEL[who.role]}`;
}

export async function initManagerMode(app, cfg) {
  APP = app;
  if (!cfg?.url || !cfg?.anonKey) return; // static mode — no manager tools
  initAuth(cfg);
  onAuthChange(async () => { who = await whoami(); refreshButton(); });
  try {
    const signedIn = await handleAuthCallback();
    if (signedIn) notify('Signed in — Manager Mode is on.');
  } catch (e) {
    notify(e.message, 'err');
  }
  who = await whoami();
  refreshButton();
  document.getElementById('mmBtn')?.addEventListener('click', () => openManagerModal());
}

/** Re-read the current identity (e.g. after token refresh). */
export async function refreshIdentity() {
  who = await whoami();
  refreshButton();
  return who;
}
