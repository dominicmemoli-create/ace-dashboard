// Fixes Needed — small, clear, actionable exceptions only.
// Everything else (unmarked visits, unreliable matches, canceled/no-shows,
// bar/takeout/delivery) is excluded automatically and summarized in one line —
// never presented as work. Decisions save straight to the shared database with
// the signed-in user's identity and are reversible from the audit history.
import { triageIntents, exclusionSummaryLines, KIND } from './triage.mjs';
import { rpc, restGet } from './auth.mjs';
import { canFix, requireRole, notify, currentUser } from './manager-mode.mjs';

let CTX = null;
export function initFixesPage(ctx) { CTX = ctx; }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const midDate = (d) => (d && d.length === 8 ? `${MONTHS[+d.slice(4, 6) - 1]} ${+d.slice(6, 8)}` : '—');

const KIND_LABEL = {
  [KIND.CONFLICT]: ['Conflicting starting choice', 'neg'],
  [KIND.MIXED]: ['Mixed-menu table', 'neu'],
  [KIND.MATCH]: ['Likely table match', ''],
  [KIND.TRANSFER]: ['Table transfer', ''],
  [KIND.REOPENED]: ['Reopened for review', 'neu'],
};
const CHOICE_LABEL = {
  UNDECIDED: 'Undecided', ALC: 'À la carte', PREDECIDED_AYCE: 'Already chose AYCE',
  UNKNOWN: 'Not recorded', REVIEW_REQUIRED: 'Needs a decision',
};
const REASONS = ['Host entry correction', 'Table moved', 'Approved policy exception', 'OpenTable table was incorrect', 'Other'];

/* ---------------------------------------------------------------- helpers -- */
const dateCache = new Map();
async function checksFor(date) {
  if (dateCache.has(date)) return dateCache.get(date);
  const out = [];
  for (let from = 0; ; from += 1000) {
    const batch = await restGet(`ace_checks?select=payload&business_date=eq.${date}`, { range: `${from}-${from + 999}` });
    out.push(...batch.map((r) => r.payload));
    if (batch.length < 1000) break;
  }
  dateCache.set(date, out);
  return out;
}
function visitsOf(checks, reference) {
  const tbl = new Map((reference?.tables ?? []).map((t) => [t.guid, String(t.name).toUpperCase()]));
  const emp = new Map((reference?.employees ?? []).map((e) => [e.guid, e.name]));
  const byOrder = new Map();
  for (const c of checks) {
    if (c.voided || !c.tableGuid) continue;
    if (!byOrder.has(c.orderGuid)) {
      byOrder.set(c.orderGuid, {
        orderGuid: c.orderGuid, table: tbl.get(c.tableGuid) ?? '?',
        server: emp.get(c.serverGuid) ?? '', opened: c.openedDate,
        guests: c.numberOfGuests ?? 0, net: 0,
      });
    }
    byOrder.get(c.orderGuid).net += c.amount ?? 0;
  }
  return [...byOrder.values()];
}
const fmtTime = (iso, tz) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};

/* ------------------------------------------------------------------- page -- */
export function pgFixes(host) {
  const { DATA } = CTX;
  const { actionable, excluded } = triageIntents(DATA.intents);
  const notes = exclusionSummaryLines(excluded);

  host.innerHTML = `
  <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
    <div class="hero-eyebrow">Fixes Needed</div>
    <div class="hero-delta"><span class="big">${actionable.length}</span>
      <span class="unit">${actionable.length === 1 ? 'item needs' : 'items need'} a decision<br>everything else was handled automatically</span></div>
    <div class="hero-line">Only clear, answerable questions land here — a conflicting starting choice, a
      mixed-menu table, or one likely Toast table to confirm. Your decision saves immediately for everyone
      and can be undone later.</div>
  </div></div></section>
  ${notes.map((n) => `<div class="note" style="margin-top:12px">${esc(n)} They don't affect anyone's numbers and need no action.</div>`).join('')}
  <div id="fixList"></div>
  <div id="doneList" class="sec"></div>`;

  const list = host.querySelector('#fixList');
  if (!actionable.length) {
    list.innerHTML = `<div class="empty sec"><div class="ei">✓</div><div class="et">Nothing needs a decision</div>
      <div class="es">New items appear here after an OpenTable upload when something genuinely needs a manager's call.</div></div>`;
  } else {
    actionable.forEach((item, i) => list.appendChild(fixCard(item, i)));
  }
  renderDecided(host.querySelector('#doneList'));
}

function fixCard(item, idx) {
  const { DATA } = CTX;
  const r = item.r;
  const [kindLabel, kindCls] = KIND_LABEL[item.kind] ?? [item.kind, ''];
  const tz = DATA.ops?.servicePeriods?.timezone ?? 'America/New_York';
  const el = document.createElement('div');
  el.className = 'fixcard rise';
  el.style.animationDelay = `${Math.min(idx, 8) * 50}ms`;

  const saidOT = `${CHOICE_LABEL[r.intent] ?? r.intent}${r.mixedMenuException ? ' · Half/Half noted' : ''}` +
    (r.relevantTags?.length ? `<div class="sub" style="margin-top:4px">Host tags: ${esc(r.relevantTags.join(', '))}</div>` : '');

  const why = item.kind === KIND.CONFLICT
      ? 'The reservation carries two different starting choices — pick the one the host meant.'
    : item.kind === KIND.MIXED
      ? 'The table was noted Half/Half. Confirm how it should count.'
    : item.kind === KIND.MATCH
      ? 'One Toast table looks right but the table number or time is slightly off — confirm the connection.'
    : item.kind === KIND.TRANSFER
      ? 'The table changed hands during service — confirm who it belongs to.'
      : 'A manager asked for another look at this visit.';

  el.innerHTML = `
    <div class="fk">
      <span class="verdict-badge ${kindCls}">${esc(kindLabel)}</span>
      ${item.pilot ? '<span class="verdict-badge neu">Pilot weekend — manager only</span>' : ''}
    </div>
    <div class="facts">
      <div class="fact"><div class="k">Date</div><div class="v">${esc(midDate(r.businessDate))}</div></div>
      <div class="fact"><div class="k">Time</div><div class="v">${esc(r.visitTime ?? '—')}</div></div>
      <div class="fact"><div class="k">Table</div><div class="v">${esc(r.tableTokens?.join(', ') || '—')}</div></div>
      <div class="fact"><div class="k">Party size</div><div class="v">${esc(r.partySize ?? '—')}</div></div>
    </div>
    <div class="said">
      <div><div class="k">What OpenTable said</div>${saidOT}</div>
      <div><div class="k">What Toast found</div><div id="toastSide">${
        r.matchStatus === 'matched' ? 'Connected to a Toast table.' :
        r.matchedOrderGuid ? '<span class="sub">Looking up the suggested table…</span>' :
        'No confident table connection.'}</div></div>
    </div>
    <div class="sub" style="margin-bottom:10px">${esc(why)}</div>
    <div class="fixbtns" role="group" aria-label="Decision"></div>
    <div id="pickWrap"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <select id="fixReason" style="padding:8px 10px;border:1px solid var(--border-2);border-radius:7px;background:var(--surface-2);font-size:13px">
        <option value="">Reason…</option>
        ${REASONS.map((x) => `<option>${x}</option>`).join('')}
      </select>
      <input id="fixNote" placeholder="Note (optional)" style="flex:1;min-width:160px;padding:8px 10px;border:1px solid var(--border-2);border-radius:7px;background:var(--surface-2);font-size:13px">
      <button class="bigbtn" id="fixSave" type="button" disabled>Save</button>
    </div>
    <div id="fixErr" style="color:var(--neg);font-size:12.5px;min-height:16px;margin-top:6px" role="alert"></div>`;

  // ---- decision buttons per kind
  const btns = el.querySelector('.fixbtns');
  let chosen = null;
  const options = item.kind === KIND.CONFLICT ? [
    ['UNDECIDED', 'Guest was undecided'],
    ['ALC', 'Guest wanted à la carte'],
    ['PREDECIDED_AYCE', 'Guest already chose AYCE'],
    ['EXCLUDE', 'Exclude — unclear'],
  ] : item.kind === KIND.MIXED ? [
    ['KEEP_FINAL', 'Approved mixed-menu exception'],
    ['PREDECIDED_AYCE', 'Treat as AYCE'],
    ['ALC', 'Treat as à la carte'],
    ['EXCLUDE', 'Exclude — unclear'],
  ] : item.kind === KIND.MATCH ? [
    ['CONNECT', 'Connect to suggested table'],
    ['PICK', 'Choose another table'],
    ['EXCLUDE', 'Exclude — not enough information'],
  ] : item.kind === KIND.TRANSFER ? [
    ['KEEP_FINAL', 'Keep final server'],
    ['PICK_SERVER', 'Choose another server'],
  ] : [
    ['UNDECIDED', 'Guest was undecided'],
    ['ALC', 'Guest wanted à la carte'],
    ['PREDECIDED_AYCE', 'Guest already chose AYCE'],
    ['EXCLUDE', 'Exclude — unclear'],
  ];
  let pickedOrderGuid = r.matchedOrderGuid ?? null;
  let pickedServerGuid = null;
  const saveBtn = el.querySelector('#fixSave');
  const syncSave = () => { saveBtn.disabled = !(chosen && el.querySelector('#fixReason').value); };
  options.forEach(([val, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fixbtn'; b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      chosen = val;
      btns.querySelectorAll('.fixbtn').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      renderPicker(val);
      syncSave();
    });
    btns.appendChild(b);
  });
  el.querySelector('#fixReason').addEventListener('change', syncSave);

  // ---- suggested-table details + alternate pickers
  const toastSide = el.querySelector('#toastSide');
  let dateVisits = null;
  const loadVisits = async () => {
    if (dateVisits) return dateVisits;
    const checks = await checksFor(r.businessDate);
    dateVisits = visitsOf(checks, DATA.reference);
    return dateVisits;
  };
  if (item.kind === KIND.MATCH && r.matchedOrderGuid) {
    loadVisits().then((vs) => {
      const v = vs.find((x) => x.orderGuid === r.matchedOrderGuid);
      toastSide.innerHTML = v
        ? `Suggested: <b>Table ${esc(v.table)}</b> · ${esc(fmtTime(v.opened, tz))} · ${v.guests || '?'} guests · $${Math.round(v.net)}${v.server ? ` · ${esc(v.server)}` : ''}`
        : 'Suggested table could not be loaded.';
    }).catch(() => { toastSide.textContent = 'Suggested table could not be loaded.'; });
  }
  function renderPicker(val) {
    const wrap = el.querySelector('#pickWrap');
    wrap.innerHTML = '';
    if (val === 'PICK') {
      wrap.innerHTML = '<div class="sub" style="margin-bottom:8px">Loading that day\'s tables…</div>';
      loadVisits().then((vs) => {
        wrap.innerHTML = `<select id="pickSel" style="margin-bottom:10px;max-width:100%;padding:8px 10px;border:1px solid var(--border-2);border-radius:7px;background:var(--surface-2);font-size:13px">
          <option value="">Pick the correct table…</option>
          ${vs.sort((a, b) => String(a.table).localeCompare(String(b.table), 'en', { numeric: true }))
            .map((v) => `<option value="${esc(v.orderGuid)}">Table ${esc(v.table)} · ${esc(fmtTime(v.opened, tz))} · ${v.guests || '?'} guests · $${Math.round(v.net)}${v.server ? ` · ${esc(v.server)}` : ''}</option>`).join('')}
        </select>`;
        wrap.querySelector('#pickSel').addEventListener('change', (e) => { pickedOrderGuid = e.target.value || null; syncSave(); });
      }).catch(() => { wrap.innerHTML = '<div class="errbox">Could not load that day\'s tables.</div>'; });
    } else if (val === 'PICK_SERVER') {
      const emps = (DATA.reference?.employees ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      wrap.innerHTML = `<select id="pickSrv" style="margin-bottom:10px;padding:8px 10px;border:1px solid var(--border-2);border-radius:7px;background:var(--surface-2);font-size:13px">
        <option value="">Pick the server…</option>
        ${emps.map((e2) => `<option value="${esc(e2.guid)}">${esc(e2.name)}</option>`).join('')}
      </select>`;
      wrap.querySelector('#pickSrv').addEventListener('change', (e) => { pickedServerGuid = e.target.value || null; syncSave(); });
    }
  }

  // ---- save
  saveBtn.addEventListener('click', async () => {
    if (!requireRole(canFix, 'Saving a fix')) return;
    const err = el.querySelector('#fixErr');
    err.textContent = '';
    const reason = el.querySelector('#fixReason').value;
    const note = el.querySelector('#fixNote').value.trim() || null;
    let action = chosen, orderGuid = null, serverGuid = null;
    if (chosen === 'PICK') {
      if (!pickedOrderGuid) { err.textContent = 'Pick the correct table first.'; return; }
      action = 'CONNECT'; orderGuid = pickedOrderGuid;
    } else if (chosen === 'CONNECT') {
      orderGuid = r.matchedOrderGuid;
    } else if (chosen === 'PICK_SERVER') {
      if (!pickedServerGuid) { err.textContent = 'Pick the server first.'; return; }
      action = 'SET_SERVER'; serverGuid = pickedServerGuid;
    }
    saveBtn.disabled = true;
    try {
      await rpc('ace_save_review_fix', {
        p_row_hash: r.rowHash, p_action: action, p_reason: reason, p_note: note,
        p_order_guid: orderGuid, p_server_guid: serverGuid,
      });
      notify('Saved. On to the next one.');
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateY(-6px)';
      setTimeout(() => { el.remove(); CTX.reload(); }, 320);
    } catch (e) {
      saveBtn.disabled = false;
      err.textContent = e.message;
    }
  });

  return el;
}

/* ------------------------------------------------- recently decided / undo -- */
function renderDecided(host) {
  const { DATA } = CTX;
  const decided = DATA.intents
    .filter((r) => r.correction && r.reviewStatus === 'confirmed')
    .sort((a, b) => String(b.correction.at ?? '').localeCompare(String(a.correction.at ?? '')))
    .slice(0, 10);
  if (!decided.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="card"><header><div><div class="ttl">Recently decided</div>
    <div class="sub">Every decision keeps the original value and can be undone.</div></div></header>
    <div class="body" style="overflow-x:auto"><table>
    <thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Table</th>
      <th style="text-align:left">Decision</th><th style="text-align:left">By</th><th></th></tr></thead>
    <tbody>${decided.map((r, i) => `<tr>
      <td style="text-align:left">${esc(midDate(r.businessDate))}</td>
      <td style="text-align:left">${esc(r.tableTokens?.join(', ') || '—')}</td>
      <td style="text-align:left">${esc(describeDecision(r))}</td>
      <td style="text-align:left">${esc((r.correction.user ?? '').split('@')[0])}</td>
      <td><button class="btn ghost sm" type="button" data-undo="${i}">Undo</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  host.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    if (!requireRole(canFix, 'Undoing a decision')) return;
    const r = decided[Number(b.dataset.undo)];
    b.disabled = true;
    try {
      await rpc('ace_save_review_fix', {
        p_row_hash: r.rowHash, p_action: 'REVERT',
        p_reason: 'Other', p_note: 'Undo from Recently decided',
      });
      notify('Decision undone — the item is back in Fixes Needed.');
      CTX.reload();
    } catch (e) {
      b.disabled = false;
      notify(e.message, 'err');
    }
  }));
}

function describeDecision(r) {
  const c = r.correction?.corrected;
  if (r.excluded) return 'Excluded';
  if (typeof c === 'string') {
    return { UNDECIDED: 'Undecided', ALC: 'À la carte', PREDECIDED_AYCE: 'Chose AYCE', KEEP_FINAL: 'Confirmed as-is' }[c] ?? c;
  }
  if (c && typeof c === 'object') {
    if (c.matchedOrderGuid) return 'Connected to a Toast table';
    if (c.attributedServerGuid) return 'Server corrected';
  }
  return 'Decided';
}
