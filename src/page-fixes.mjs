// Fixes Needed — small, clear, actionable exceptions only.
// Everything else (unmarked visits, unreliable matches, canceled/no-shows,
// bar/takeout/delivery) is excluded from the QUEUE automatically and
// summarized honestly: unmarked visits still count in every operational
// figure — only conversion leaves them out. Half/Half is a guest-mix note and
// never creates work. Decisions save straight to the shared database with a
// signed-in manager and are reversible from the audit history.
//
// Accessibility: every field id is unique per card (no duplicate DOM ids),
// decisions are native radio groups inside a fieldset, and the queue offers
// filters by issue type, date and server with the global count always shown
// next to the filtered count.
import { triageIntents, exclusionSummaryLines, KIND } from './triage.mjs?v=20260806-v2';
import { rpc, restGet } from './auth.mjs?v=20260806-v2';
import { requireOperator, notify } from './manager-mode.mjs?v=20260806-v2';

let CTX = null;
export function initFixesPage(ctx) { CTX = ctx; }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const midDate = (d) => (d && d.length === 8 ? `${MONTHS[+d.slice(4, 6) - 1]} ${+d.slice(6, 8)}` : '—');

const KIND_LABEL = {
  [KIND.CONFLICT]: ['Conflicting starting choice', 'neg'],
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
function areaNameOf(c) {
  const ops = CTX.DATA.ops;
  return (c.serviceAreaGuid && ops.includedAreas.serviceAreaGuids[c.serviceAreaGuid])
    || (c.revenueCenterGuid && ops.includedAreas.revenueCenterGuids[c.revenueCenterGuid]) || null;
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
        area: areaNameOf(c),
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
const minutesWord = (n) => (n == null ? null : n === 0 ? 'exactly on time' : `${n} minute${n === 1 ? '' : 's'} apart`);

/* ---------------------------------------------------------- filter state --- */
const FIX_FILTER_KEY = 'ace.fixFilters';
function fixFilters() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(FIX_FILTER_KEY) || '{}'); } catch { /* defaults */ }
  return { kind: 'all', date: 'all', server: 'all', ...s };
}
function saveFixFilters(f) { localStorage.setItem(FIX_FILTER_KEY, JSON.stringify(f)); }

/* ------------------------------------------------------------------- page -- */
export function pgFixes(host) {
  const { DATA } = CTX;
  const { actionable, excluded } = triageIntents(DATA.intents);
  const notes = exclusionSummaryLines(excluded);
  const filters = fixFilters();
  const emp = new Map((DATA.reference?.employees ?? []).map((e) => [e.guid, e.name]));
  const serverOf = (item) => {
    const g = item.r.matchedServerGuid;
    return g ? (emp.get(g) ?? '') : (item.r.serverSoftLabel || '');
  };

  const dates = [...new Set(actionable.map((a) => a.r.businessDate))].sort().reverse();
  const servers = [...new Set(actionable.map(serverOf).filter(Boolean))].sort();
  const kindsPresent = [...new Set(actionable.map((a) => a.kind))];
  // a persisted filter value that no longer exists in the queue must not keep
  // filtering invisibly while the select displays "All"
  if (filters.kind !== 'all' && !kindsPresent.includes(filters.kind)) filters.kind = 'all';
  if (filters.date !== 'all' && !dates.includes(filters.date)) filters.date = 'all';
  if (filters.server !== 'all' && !servers.includes(filters.server)) filters.server = 'all';

  const visible = actionable.filter((a) =>
    (filters.kind === 'all' || a.kind === filters.kind)
    && (filters.date === 'all' || a.r.businessDate === filters.date)
    && (filters.server === 'all' || serverOf(a) === filters.server));
  const filtered = filters.kind !== 'all' || filters.date !== 'all' || filters.server !== 'all';

  host.innerHTML = `
  <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
    <div class="hero-eyebrow">Fixes Needed</div>
    <div class="hero-delta"><span class="big">${filtered ? visible.length : actionable.length}</span>
      <span class="unit">${filtered
        ? `of <b>${actionable.length} total</b> item${actionable.length === 1 ? '' : 's'} shown by the current filter`
        : `item${actionable.length === 1 ? ' needs' : 's need'} a decision<br>everything else was handled automatically`}</span></div>
    <div class="hero-line">Only clear, answerable questions land here — a conflicting starting choice or one
      likely Toast table to confirm. Your decision saves immediately for everyone and can be undone later.</div>
  </div></div></section>
  ${notes.length ? `<div class="card sec"><header><div><div class="ttl">Handled automatically</div>
    <div class="sub">Nothing below needs a decision — it is listed so the totals stay honest.</div></div></header>
    <div class="body"><ul class="autolist">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></div>` : ''}
  ${actionable.length ? `
  <div class="card sec"><div class="body fieldrow">
    <label class="field" for="fixFilterKind"><span>Issue type</span>
      <select class="ctl" id="fixFilterKind">
        <option value="all">All types</option>
        ${kindsPresent.map((k) => `<option value="${esc(k)}" ${filters.kind === k ? 'selected' : ''}>${esc(KIND_LABEL[k]?.[0] ?? k)}</option>`).join('')}
      </select></label>
    <label class="field" for="fixFilterDate"><span>Date</span>
      <select class="ctl" id="fixFilterDate">
        <option value="all">All dates</option>
        ${dates.map((d) => `<option value="${d}" ${filters.date === d ? 'selected' : ''}>${midDate(d)}</option>`).join('')}
      </select></label>
    <label class="field" for="fixFilterServer"><span>Server</span>
      <select class="ctl" id="fixFilterServer">
        <option value="all">All servers</option>
        ${servers.map((s) => `<option value="${esc(s)}" ${filters.server === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select></label>
    <div class="rangenote sub" role="status">
      <span>Showing <b>${visible.length}</b> of ${actionable.length} open item${actionable.length === 1 ? '' : 's'}</span>
      ${filtered ? '<span>Filters are active</span>' : '<span>No filters applied</span>'}
    </div>
  </div></div>` : ''}
  <div id="fixList"></div>
  <div id="doneList" class="sec"></div>`;

  for (const [id, key] of [['fixFilterKind', 'kind'], ['fixFilterDate', 'date'], ['fixFilterServer', 'server']]) {
    host.querySelector(`#${id}`)?.addEventListener('change', (e) => {
      saveFixFilters({ ...fixFilters(), [key]: e.target.value });
      pgFixes(host);
    });
  }

  const list = host.querySelector('#fixList');
  if (!actionable.length) {
    list.innerHTML = `<div class="empty sec"><div class="ei" aria-hidden="true">✓</div>
      <div class="et">Nothing needs a decision</div>
      <div class="es">New items appear here after an OpenTable upload when something genuinely needs a call.</div></div>`;
  } else if (!visible.length) {
    list.innerHTML = `<div class="empty sec"><div class="ei" aria-hidden="true">⌕</div>
      <div class="et">Nothing matches this filter</div>
      <div class="es">${actionable.length} open item${actionable.length === 1 ? '' : 's'} exist${actionable.length === 1 ? 's' : ''} outside the current filter.</div></div>`;
  } else {
    list.innerHTML = `<div class="queuebar sec" role="status">
      <span class="qcount"><b>1</b> of ${visible.length}</span>
      <span class="qtext">One card at a time${filtered ? ' in this filter' : ''} — save this decision and the next
        item takes its place.</span>
      <span class="qprog" aria-hidden="true"><i style="width:${Math.max(4, 100 / visible.length)}%"></i></span>
    </div>`;
    list.appendChild(fixCard(visible[0], 0));
  }
  renderDecided(host.querySelector('#doneList'));
}

function fixCard(item, idx) {
  const { DATA } = CTX;
  const r = item.r;
  const [kindLabel, kindCls] = KIND_LABEL[item.kind] ?? [item.kind, ''];
  const tz = DATA.ops?.servicePeriods?.timezone ?? 'America/New_York';
  // unique id helper — no id is ever repeated across cards
  const fid = (name) => `fix-${idx}-${name}`;
  const el = document.createElement('section');
  el.className = 'fixcard rise';
  el.setAttribute('aria-label', `${kindLabel} — ${midDate(r.businessDate)}${r.tableTokens?.length ? `, table ${r.tableTokens.join(', ')}` : ''}`);
  el.style.animationDelay = `${Math.min(idx, 8) * 50}ms`;

  const saidOT = `${esc(CHOICE_LABEL[r.intent] ?? r.intent)}${(r.halfHalf || r.mixedMenuException) ? ' <span class="muted">· Half/Half note (half returning, half first-time — informational)</span>' : ''}` +
    (r.relevantTags?.length ? `<div class="sub" style="margin-top:4px">Host tags: ${esc(r.relevantTags.join(', '))}</div>` : '');

  const ev = r.matchEvidence ?? null;
  const why = item.kind === KIND.CONFLICT
      ? 'The reservation carries two different starting choices — pick the one the host meant.'
    : item.kind === KIND.MATCH
      ? matchWhy(r, ev)
    : item.kind === KIND.TRANSFER
      ? 'The table changed hands during service — confirm who it belongs to.'
      : 'A visitor asked for another look at this visit.';

  el.innerHTML = `
    <div class="fk">
      <span class="badge ${kindCls}">${esc(kindLabel)}</span>
      <span class="sub">${esc(midDate(r.businessDate))}${r.visitTime ? ` · ${esc(r.visitTime)}` : ''}${
        r.tableTokens?.length ? ` · table ${esc(r.tableTokens.join(', '))}` : ''}</span>
    </div>
    <div class="facts">
      <div class="fact"><div class="k">Date</div><div class="v">${esc(midDate(r.businessDate))}</div></div>
      <div class="fact"><div class="k">Time</div><div class="v">${esc(r.visitTime ?? '—')}</div></div>
      <div class="fact"><div class="k">OpenTable table${(r.tableTokens?.length ?? 0) > 1 ? 's' : ''}</div><div class="v">${esc(r.tableTokens?.join(', ') || '—')}</div></div>
      <div class="fact"><div class="k">Party size</div><div class="v">${esc(r.partySize ?? '—')}</div></div>
      <div class="fact"><div class="k">Area</div><div class="v" style="font-size:12px">${esc(r.diningArea || 'not recorded by host')}</div></div>
    </div>
    <div class="said">
      <div><div class="k">What OpenTable said</div>${saidOT}</div>
      <div><div class="k">What Toast found</div><div id="${fid('toastSide')}">${
        r.matchStatus === 'matched' ? 'Connected to a Toast table.' :
        r.matchedOrderGuid ? '<span class="sub">Looking up the suggested table…</span>' :
        'No confident table connection.'}</div></div>
    </div>
    <p class="fixwhy">${why}</p>
    <fieldset>
      <legend class="flegend">Decision</legend>
      <div class="fixbtns" id="${fid('opts')}"></div>
    </fieldset>
    <div id="${fid('pickWrap')}"></div>
    <div class="fixactions">
      <label class="field" for="${fid('reason')}"><span>Reason for this decision</span>
        <select class="ctl" id="${fid('reason')}">
          <option value="">Choose a reason…</option>
          ${REASONS.map((x) => `<option>${x}</option>`).join('')}
        </select></label>
      <label class="field grow" for="${fid('note')}"><span>Note <span class="muted">(optional)</span></span>
        <input class="ctl" id="${fid('note')}" placeholder="Anything the next person should know"></label>
      <button class="bigbtn" id="${fid('save')}" type="button" disabled>Save decision</button>
    </div>
    <div id="${fid('err')}" class="fixerr" role="alert"></div>`;

  // ---- decision options: native radios, one group per card
  const optsHost = el.querySelector(`#${fid('opts')}`);
  let chosen = null;
  const options = item.kind === KIND.CONFLICT ? [
    ['UNDECIDED', 'Guest was undecided'],
    ['ALC', 'Guest wanted à la carte'],
    ['PREDECIDED_AYCE', 'Guest already chose AYCE'],
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
  const saveBtn = el.querySelector(`#${fid('save')}`);
  const syncSave = () => { saveBtn.disabled = !(chosen && el.querySelector(`#${fid('reason')}`).value); };
  options.forEach(([val, label], oi) => {
    const rid = fid(`opt-${oi}`);
    const wrap = document.createElement('label');
    wrap.className = 'fixbtn';
    wrap.setAttribute('for', rid);
    wrap.innerHTML = `<input type="radio" id="${rid}" name="${fid('decision')}" value="${esc(val)}">${esc(label)}`;
    wrap.querySelector('input').addEventListener('change', () => {
      chosen = val;
      optsHost.querySelectorAll('label.fixbtn').forEach((x) => x.classList.remove('on'));
      wrap.classList.add('on');
      renderPicker(val);
      syncSave();
    });
    optsHost.appendChild(wrap);
  });
  el.querySelector(`#${fid('reason')}`).addEventListener('change', syncSave);

  // ---- suggested-table details + alternate pickers
  const toastSide = el.querySelector(`#${fid('toastSide')}`);
  let dateVisits = null;
  const loadVisits = async () => {
    if (dateVisits) return dateVisits;
    const checks = await checksFor(r.businessDate);
    dateVisits = visitsOf(checks, DATA.reference);
    return dateVisits;
  };
  if (r.matchedOrderGuid) {   // any card with a stored candidate resolves it (never a stuck "Looking up…")
    loadVisits().then((vs) => {
      const v = vs.find((x) => x.orderGuid === r.matchedOrderGuid);
      if (!v) { toastSide.textContent = 'Suggested table could not be loaded.'; return; }
      // recompute the evidence against the CURRENT rules, so suggestions stored
      // under the old (wider) matching window are visibly re-checked here
      const tol = DATA.ops?.opentableMatch?.timeToleranceMinutes ?? 25;
      let diff = r.matchEvidence?.timeDiffMin ?? null;
      if (diff == null && r.visitMinutes != null && v.opened) {
        try {
          const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(v.opened));
          const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
          const m = Number(parts.find((p) => p.type === 'minute')?.value);
          if (Number.isFinite(h) && Number.isFinite(m)) diff = Math.abs(r.visitMinutes - (h * 60 + m));
        } catch { /* leave unknown */ }
      }
      const overlap = r.tableTokens?.includes(v.table);
      toastSide.innerHTML = `Suggested: <b>Table ${esc(v.table)}</b> · opened ${esc(fmtTime(v.opened, tz))} · ${v.guests || '?'} guests
         · $${Math.round(v.net)}${v.server ? ` · ${esc(v.server)}` : ''}${v.area ? ` · ${esc(v.area)}` : ''}
        <div class="sub" style="margin-top:4px">
          ${diff != null ? `Time: <b>${esc(minutesWord(diff))}</b>${diff > tol ? ` <span class="st rev">outside the ±${tol}-minute window — probably not this table</span>` : ''}` : 'Time difference unknown'}
          · Table ${overlap ? `<b>${esc(v.table)}</b> matches the reservation` : 'number differs'}
          ${r.partySize != null && v.guests ? ` · party ${r.partySize === v.guests ? 'matches' : `${Math.abs(r.partySize - v.guests)} off`}` : ''}
        </div>`;
    }).catch(() => { toastSide.textContent = 'Suggested table could not be loaded.'; });
  }
  function renderPicker(val) {
    const wrap = el.querySelector(`#${fid('pickWrap')}`);
    wrap.innerHTML = '';
    if (val === 'PICK') {
      wrap.innerHTML = '<div class="sub pickload" role="status">Loading that day\'s tables…</div>';
      loadVisits().then((vs) => {
        wrap.innerHTML = `<label class="field pickfield" for="${fid('pickSel')}"><span>Pick the correct table</span>
          <select class="ctl" id="${fid('pickSel')}">
          <option value="">Pick the correct table…</option>
          ${vs.sort((a, b) => String(a.table).localeCompare(String(b.table), 'en', { numeric: true }))
            .map((v) => `<option value="${esc(v.orderGuid)}">Table ${esc(v.table)} · ${esc(fmtTime(v.opened, tz))} · ${v.guests || '?'} guests · $${Math.round(v.net)}${v.server ? ` · ${esc(v.server)}` : ''}</option>`).join('')}
        </select></label>`;
        wrap.querySelector(`#${fid('pickSel')}`).addEventListener('change', (e) => { pickedOrderGuid = e.target.value || null; syncSave(); });
      }).catch(() => { wrap.innerHTML = '<div class="errbox">Could not load that day\'s tables.</div>'; });
    } else if (val === 'PICK_SERVER') {
      const emps = (DATA.reference?.employees ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      wrap.innerHTML = `<label class="field pickfield" for="${fid('pickSrv')}"><span>Pick the server</span>
        <select class="ctl" id="${fid('pickSrv')}">
        <option value="">Pick the server…</option>
        ${emps.map((e2) => `<option value="${esc(e2.guid)}">${esc(e2.name)}</option>`).join('')}
      </select></label>`;
      wrap.querySelector(`#${fid('pickSrv')}`).addEventListener('change', (e) => { pickedServerGuid = e.target.value || null; syncSave(); });
    }
  }

  // ---- save
  saveBtn.addEventListener('click', async () => {
    if (!requireOperator('Saving a fix')) return;
    const err = el.querySelector(`#${fid('err')}`);
    err.textContent = '';
    const reason = el.querySelector(`#${fid('reason')}`).value;
    const note = el.querySelector(`#${fid('note')}`).value.trim() || null;
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

/** Plain-language explanation of WHY a candidate was suggested, built from the
 * stored match evidence (time difference, table overlap, party-size delta). */
function matchWhy(r, ev) {
  if (!ev) return 'One Toast table looks right but the evidence fell just short of the automatic threshold — confirm the connection.';
  const bits = [];
  if (ev.timeDiffMin != null) bits.push(`the check opened <b>${esc(minutesWord(ev.timeDiffMin))}</b> from the reservation time`);
  if (ev.tableOverlap) {
    bits.push((r.tableTokens?.length ?? 0) > 1
      ? `Toast table <b>${esc(ev.overlappingTable)}</b> is one of the reserved tables (${esc(r.tableTokens.join(', '))})`
      : 'the table number matches');
  } else if (ev.area === 'patio') {
    bits.push('the table number differs, which is normal on the patio (guests choose their own seats)');
  } else {
    bits.push('the table number differs');
  }
  if (ev.partyDiff != null) {
    bits.push(ev.partyDiff === 0 ? 'the party size matches exactly'
      : `the party size is ${ev.partyDiff} off`);
  }
  return `Suggested because ${bits.join('; ')}. It fell short of the automatic threshold, so a person decides.`;
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
    <div class="body tw"><table>
    <caption class="sr">Recently decided fixes with undo controls</caption>
    <thead><tr><th scope="col" style="text-align:left">Date</th><th scope="col" style="text-align:left">Table</th>
      <th scope="col" style="text-align:left">Decision</th><th scope="col" style="text-align:left">By</th><th scope="col"><span class="sr">Undo</span></th></tr></thead>
    <tbody>${decided.map((r, i) => `<tr>
      <td style="text-align:left">${esc(midDate(r.businessDate))}</td>
      <td style="text-align:left">${esc(r.tableTokens?.join(', ') || '—')}</td>
      <td style="text-align:left">${esc(describeDecision(r))}</td>
      <td style="text-align:left">${esc(r.correction.user || 'manager')}</td>
      <td><button class="btn ghost sm" type="button" data-undo="${i}"
        aria-label="Undo the decision for ${esc(midDate(r.businessDate))} table ${esc(r.tableTokens?.join(', ') || '')}">Undo</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  host.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    if (!requireOperator('Undoing a decision')) return;
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
