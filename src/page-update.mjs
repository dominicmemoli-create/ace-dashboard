// Update Dashboard — the one place visitors keep data current.
// Three status cards (Toast Sales · OpenTable Guest Status · Food Costs),
// a compact green/yellow/red system panel, and complete in-browser upload
// workflows. Writes go through the protected database functions with the
// signed-in manager's identity; no commands, no JSON, no configuration.
import { parseGuestCenter, sanitizeVisitAsync, rowHashOfAsync } from './opentable.mjs?v=20260806-v2';
import { toastVisits, matchVisits } from './ot-matcher.mjs?v=20260806-v2';
import { triageIntents } from './triage.mjs?v=20260806-v2';
import { parseCostCsvDetailed, rowsFromWorkbookAoaDetailed, attachAliases, diffCosts, stillUncosted, normalizeName } from './costs-shared.mjs?v=20260806-v2';
import { buildMetricsForDate } from './metrics-builder.mjs?v=20260806-v2';
import { rpc, restGet } from './auth.mjs?v=20260806-v2';
import { requireOperator, notify, currentUser } from './manager-mode.mjs?v=20260806-v2';
import { icon } from './icons.mjs?v=20260806-v2';

let CTX = null;
export function initUpdatePage(ctx) { CTX = ctx; }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => (d && d.length === 8 ? `${MONTHS[+d.slice(4, 6) - 1]} ${+d.slice(6, 8)}` : '—');

function nyYesterday() {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setDate(ny.getDate() - 1);
  return `${ny.getFullYear()}${String(ny.getMonth() + 1).padStart(2, '0')}${String(ny.getDate()).padStart(2, '0')}`;
}
function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }) + ' ET';
  } catch { return '—'; }
}

/* ------------------------------------------------------------ status model -- */
export function toastStatus(DATA) {
  const dates = [...new Set(DATA.metrics.filter((r) => !r.serverGuid).map((r) => r.businessDate))].sort();
  const last = dates[dates.length - 1];
  const target = nyYesterday();
  const runs = (DATA.ingestionRuns ?? []).slice().sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  const running = runs.find((r) => r.status === 'running'
    && Date.now() - Date.parse(r.startedAt ?? 0) < 2 * 3600e3);
  const lastFailed = runs[0]?.status === 'failed';
  if (running) return { state: 'updating', label: 'Toast is currently updating', last, target };
  if (last >= target && !lastFailed) return { state: 'ok', label: `Toast updated through ${longDate(last)}`, last, target };
  return { state: 'attention', label: 'Toast update needs attention', last, target, lastFailed };
}

export function opentableStatus(DATA) {
  const toastLast = toastStatus(DATA).last;
  const otDates = [...new Set((DATA.intents ?? []).map((r) => r.businessDate))].sort();
  const otLast = otDates[otDates.length - 1];
  const runs = (DATA.importRuns ?? []).filter((r) => r.kind === 'opentable' && r.status === 'success');
  const lastUpload = runs[0]?.created_at ?? null;
  const behind = !!(toastLast && (!otLast || otLast < toastLast));
  return { otDates, otLast, lastUpload, behind, toastLast };
}

export function costsStatus(DATA) {
  let rough = 0, total = 0, matched = 0, qty = 0;
  for (const it of DATA.items ?? []) {
    if (!it.matched) continue;
    total += it.cost;
    // anything not chef-confirmed is a temporary estimate of some tier
    if (it.source !== 'chef_confirmed' && it.verification !== 'verified') rough += it.cost;
  }
  for (const r of DATA.metrics ?? []) {
    if (r.serverGuid) continue;
    matched += r.matchedQty ?? 0; qty += r.totalQty ?? 0;
  }
  const stamped = (DATA.costs ?? []).filter((c) => c.updatedAt)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const last = stamped[stamped.length - 1];
  return {
    roughShare: total > 0 ? (rough / total) * 100 : 0,
    coverage: qty > 0 ? (matched / qty) * 100 : null,
    lastUpdated: last?.updatedAt ?? null,
    lastUpdatedBy: last?.updatedBy ?? null,
  };
}

export function systemStatus(DATA, badge) {
  const t = toastStatus(DATA);
  const ot = opentableStatus(DATA);
  const c = costsStatus(DATA);
  const failedImport = (DATA.importRuns ?? [])[0]?.status === 'failed';
  if (t.lastFailed || failedImport) {
    return {
      color: 'red', head: 'Data update failed',
      action: t.lastFailed
        ? 'The overnight Toast update did not finish. Press Retry Toast Update below.'
        : 'The last upload did not finish. Try the upload again — nothing was half-saved.',
    };
  }
  const needs = [];
  if (t.state === 'attention') needs.push('Toast is behind. Press Retry Toast Update below.');
  if (ot.behind) needs.push(`Upload the OpenTable file for ${longDate(ot.toastLast)}.`);
  if (badge > 0) needs.push(`${badge} item${badge === 1 ? '' : 's'} under Fixes Needed ${badge === 1 ? 'needs' : 'need'} a decision.`);
  if (c.roughShare > 0) needs.push('Rough costs — waiting for chef confirmation.');
  if (needs.length) {
    return {
      color: 'yellow',
      head: needs.length === 1 ? 'One update needs attention' : `${needs.length} updates need attention`,
      action: needs.join(' '),
    };
  }
  return { color: 'green', head: 'Everything is up to date', action: 'Toast is current, guest status is loaded, and there is nothing waiting on a decision.' };
}

/* ------------------------------------------------------------------- page -- */
export function pgUpdate(host) {
  const { DATA, APP } = CTX;
  const badge = triageIntents(DATA.intents).badge;
  const sys = systemStatus(DATA, badge);
  const t = toastStatus(DATA);
  const ot = opentableStatus(DATA);
  const c = costsStatus(DATA);

  // each source card carries its own attention tone, so the three states are
  // distinguishable at a glance and not just three identical white cards
  const toastTone = t.state === 'ok' ? 'ok' : t.state === 'updating' ? 'busy' : 'alert';
  const otTone = ot.behind ? 'attn' : 'ok';
  const costTone = c.roughShare > 0 ? 'attn' : 'ok';

  host.innerHTML = `
  <div class="sys ${sys.color} rise" role="status">
    <span class="si" aria-hidden="true"></span>
    <div><div class="sh2">${esc(sys.head)}</div><div class="sm">${esc(sys.action)}</div></div>
  </div>

  <div class="sec g3 band srccards">
    <section class="card srccard ${toastTone}" aria-labelledby="srcToastTtl">
      <header><div><div class="ttl" id="srcToastTtl">Toast Sales</div>
        <div class="sub">Updates by itself every morning</div></div></header>
      <div class="body">
        <div class="srcstate">${t.state === 'ok' ? `<span class="st ok">${esc(t.label)}</span>`
          : t.state === 'updating' ? `<span class="st partial">${esc(t.label)}</span>`
          : `<span class="st rev">${esc(t.label)}</span>`}</div>
        <dl class="deflist">
          <div><dt>Sales through</dt><dd>${longDate(t.last)}</dd></div>
          <div><dt>Last update</dt><dd>${fmtWhen(DATA.manifest?.lastToastSync)}</dd></div>
        </dl>
        <p class="srcnote">Sales come in from Toast automatically around 6 AM for the previous day.
          You normally don't need to do anything here.</p>
        <div id="toastActions" class="srcactions"></div>
      </div></section>

    <section class="card srccard ${otTone}" aria-labelledby="srcOtTtl">
      <header><div><div class="ttl" id="srcOtTtl">OpenTable Guest Status</div>
        <div class="sub">Upload the GuestCenter file after each service</div></div></header>
      <div class="body">
        <div class="srcstate">${ot.behind
          ? `<span class="st partial">Upload needed${ot.toastLast ? ` for ${esc(longDate(ot.toastLast))}` : ''}</span>`
          : `<span class="st ok">Covers through ${esc(longDate(ot.otLast))}</span>`}</div>
        <dl class="deflist">
          <div><dt>Last upload</dt><dd>${fmtWhen(ot.lastUpload)}</dd></div>
          <div><dt>Days covered</dt><dd>${ot.otDates.length ? `${longDate(ot.otDates[0])} – ${longDate(ot.otLast)}` : 'none yet'}</dd></div>
        </dl>
        <p class="srcnote">${ot.behind
          ? 'Toast has newer sales than the guest-status file. Upload the latest GuestCenter export so conversion stays current.'
          : 'Guest status is level with Toast. Upload again after the next service.'}</p>
        <div class="srcactions"><button class="bigbtn" id="otUploadBtn" type="button">Upload OpenTable File</button></div>
      </div></section>

    <section class="card srccard ${costTone}" aria-labelledby="srcCostTtl">
      <header><div><div class="ttl" id="srcCostTtl">Food Costs</div>
        <div class="sub">Occasional — when the chef confirms costs</div></div></header>
      <div class="body">
        <div class="srcstate">${c.roughShare > 0
          ? '<span class="st partial">Rough costs — waiting for chef confirmation</span>'
          : '<span class="st ok">Chef-confirmed</span>'}</div>
        <dl class="deflist">
          <div><dt>Last updated</dt><dd>${fmtWhen(c.lastUpdated)}${c.lastUpdatedBy ? ` · ${esc(c.lastUpdatedBy.split('@')[0])}` : ''}</dd></div>
          <div><dt>AYCE items with costs entered</dt><dd>${c.coverage == null ? '—' : c.coverage.toFixed(0) + '%'}</dd></div>
        </dl>
        <p class="srcnote">${c.roughShare > 0
          ? `About ${c.roughShare.toFixed(0)}% of cost dollars still use rough costs. Numbers stay marked
             "waiting for chef confirmation" until the chef's confirmed costs are uploaded — uploading here replaces
             the rough values item by item.`
          : 'Costs are chef-confirmed. Upload a new file whenever prices change.'}</p>
        <div class="srcactions"><button class="bigbtn" id="costUploadBtn" type="button">Upload Food Costs</button></div>
      </div></section>
  </div>

  <div id="upStage" class="sec"></div>`;

  renderToastActions(host.querySelector('#toastActions'), t);
  host.querySelector('#otUploadBtn').addEventListener('click', () => {
    if (!requireOperator('Uploading the OpenTable file')) return;
    startOpenTableFlow(host.querySelector('#upStage'));
  });
  host.querySelector('#costUploadBtn').addEventListener('click', () => {
    if (!requireOperator('Uploading food costs')) return;
    startCostFlow(host.querySelector('#upStage'));
  });
}

/* --------------------------------------------------------- Toast retry UI -- */
function renderToastActions(el, t) {
  if (t.state !== 'attention') { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="bigbtn" id="retryBtn" type="button">Retry Toast Update</button>
    <div class="acc"><button type="button" aria-expanded="false" id="advTgl">
      Advanced<span class="ch">${icon('chevronRight', 14)}</span></button>
      <div class="ab" hidden id="advBody">
        <label class="field" for="advDate"><span>Business date to update</span>
          <input class="ctl" id="advDate" type="date" style="max-width:210px"></label>
        <div style="margin-top:10px"><button class="btn ghost sm" id="retryDateBtn" type="button">Update this date</button></div>
      </div></div>
    <div id="retryStage" class="sub" role="status"></div>`;
  el.querySelector('#advTgl').addEventListener('click', () => {
    const b = el.querySelector('#advBody'); const t2 = el.querySelector('#advTgl');
    const open = t2.getAttribute('aria-expanded') === 'true';
    t2.setAttribute('aria-expanded', String(!open)); b.hidden = open;
  });
  const kick = async (businessDate) => {
    if (!requireOperator('Retrying the Toast update')) return;
    const stage = el.querySelector('#retryStage');
    try {
      stage.textContent = 'Starting the update…';
      const res = await rpc('ace_retry_toast_update', { p_business_date: businessDate });
      notify('Update started.');
      stage.textContent = 'Update started — it usually takes a few minutes. This page will refresh itself.';
      pollRetry(res.requestId, stage);
    } catch (e) {
      stage.textContent = e.message;
      notify(e.message, 'err');
    }
  };
  el.querySelector('#retryBtn').addEventListener('click', () => kick(null));
  el.querySelector('#retryDateBtn').addEventListener('click', () => {
    const v = el.querySelector('#advDate').value; // yyyy-mm-dd
    if (!v) { notify('Pick a date first.', 'err'); return; }
    kick(v.replaceAll('-', ''));
  });
}

async function pollRetry(requestId, stage) {
  // 1) confirm the request reached the update service
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const st = await rpc('ace_retry_status', { p_request_id: requestId });
      if (st.done) {
        if (!st.accepted) {
          stage.textContent = 'The update service did not accept the request. Ask the administrator to check the connection.';
          return;
        }
        break;
      }
    } catch { /* keep polling */ }
  }
  // 2) wait for a fresh update run to land, then reload the data
  const startedAfter = Date.now() - 60e3;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const runs = await restGet('ace_ingestion_runs?select=payload&order=run_id.desc&limit=5');
      const fresh = runs.map((r) => r.payload).find((p) => Date.parse(p.startedAt ?? 0) > startedAfter);
      if (fresh?.status === 'success') {
        stage.textContent = 'Update finished successfully.';
        notify('Toast update finished.');
        CTX.reload();
        return;
      }
      if (fresh?.status === 'failed') {
        stage.textContent = 'The update ran but did not finish. Try again; if it keeps failing, the administrator can check the technical log.';
        return;
      }
      if (fresh) stage.textContent = 'Update is running…';
    } catch { /* transient */ }
  }
  stage.textContent = 'Still waiting — check back in a few minutes.';
}

/* ----------------------------------------------------- OpenTable workflow -- */
function fileHashOf(text) { return rowHashOfAsync(text); }

async function fetchDateData(date) {
  const grab = async (table) => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const batch = await restGet(`${table}?select=payload&business_date=eq.${date}`, { range: `${from}-${from + 999}` });
      out.push(...batch.map((r) => r.payload));
      if (batch.length < 1000) break;
    }
    return out;
  };
  const [checks, selections] = await Promise.all([grab('ace_checks'), grab('ace_selections')]);
  return { checks, selections };
}

function stageCard(stageHost, title, bodyHtml) {
  stageHost.innerHTML = `<div class="card rise"><header><div><div class="ttl">${esc(title)}</div></div>
    <span class="sp"></span><button class="xbtn" type="button" id="stageClose" aria-label="Close">${icon('close', 18)}</button></header>
    <div class="body" id="stageBody">${bodyHtml}</div></div>`;
  stageHost.querySelector('#stageClose').addEventListener('click', () => { stageHost.innerHTML = ''; });
  stageHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return stageHost.querySelector('#stageBody');
}

function pickFile(accept, cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = accept;
  inp.addEventListener('change', () => { if (inp.files[0]) cb(inp.files[0]); });
  inp.click();
}

export function startOpenTableFlow(stageHost) {
  const body = stageCard(stageHost, 'Upload OpenTable File', `
    <div class="dz" id="otDz" tabindex="0" role="button" aria-label="Choose or drop the OpenTable file">
      <div class="dzt">Drop the GuestCenter file here — or click to choose it</div>
      <div class="dzs">This is the normal CSV download from OpenTable GuestCenter. Uploading the same file twice is safe.</div>
    </div>
    <div id="otStage"></div>`);
  const dz = body.querySelector('#otDz');
  const stage = body.querySelector('#otStage');
  const onFile = (file) => handleOpenTableFile(file, stage).catch((e) => {
    stage.innerHTML = `<div class="errbox"><b>That file didn't work.</b> ${esc(e.message)}</div>`;
  });
  dz.addEventListener('click', () => pickFile('.csv', onFile));
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile('.csv', onFile); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
}

async function handleOpenTableFile(file, stage) {
  const { DATA } = CTX;
  if (file.size > 5 * 1024 * 1024) throw new Error('The file is larger than expected for a GuestCenter export. Check that you picked the right download.');
  const text = await file.text();
  const firstLine = (text.split(/\r?\n/)[0] ?? '').toLowerCase();
  if (!firstLine.includes('visit date') || !firstLine.includes('reservation tags')) {
    throw new Error('This doesn’t look like the GuestCenter reservations export. In OpenTable, download the standard reservations CSV and try again.');
  }
  stage.innerHTML = '<div class="sub" style="padding:12px 0">Reading the file…</div>';

  const visits = parseGuestCenter(text);
  const completed = visits.filter((v) => /^(done|completed|complete)$/i.test(v.status));
  const notCompleted = visits.length - completed.length; // canceled, no-show, etc.
  const runId = `ot-web-${Date.now()}`;
  const sanitized = [];
  for (const v of completed) sanitized.push(await sanitizeVisitAsync(v, runId));

  const dates = [...new Set(sanitized.map((s) => s.businessDate))].sort();
  if (!dates.length) throw new Error('No completed visits were found in the file.');

  // duplicates already in the shared database
  stage.innerHTML = '<div class="sub" style="padding:12px 0">Checking for rows already loaded…</div>';
  const existing = new Set();
  for (const d of dates) {
    const rows = await restGet(`ace_intents?select=row_hash&business_date=eq.${d}`, { range: '0-4999' });
    rows.forEach((r) => existing.add(r.row_hash));
  }
  const dup = sanitized.filter((s) => existing.has(s.rowHash)).length;

  // connect to Toast tables (same matching logic as always)
  const ops = DATA.ops;
  const cfg = { ...ops.opentableMatch, timezone: ops.servicePeriods.timezone };
  const opsFilter = (c) =>
    (c.serviceAreaGuid && c.serviceAreaGuid in ops.includedAreas.serviceAreaGuids) ||
    (!c.serviceAreaGuid && c.revenueCenterGuid in ops.includedAreas.revenueCenterGuids);
  const areaNameOf = (c) =>
    (c.serviceAreaGuid && ops.includedAreas.serviceAreaGuids[c.serviceAreaGuid]) ||
    (c.revenueCenterGuid && ops.includedAreas.revenueCenterGuids[c.revenueCenterGuid]) || null;
  const areaOf = (c) => {
    const n = areaNameOf(c);
    return n ? (/patio/i.test(n) ? 'patio' : 'dining') : null;
  };
  const all = [];
  for (const d of dates) {
    const rows = sanitized.filter((s) => s.businessDate === d);
    stage.innerHTML = `<div class="sub" style="padding:12px 0">Connecting ${longDate(d)} to Toast tables…</div>`;
    let dateData;
    try { dateData = await fetchDateData(d); } catch { dateData = { checks: [], selections: [] }; }
    if (!dateData.checks.length) { all.push(...rows); continue; }
    const tv = toastVisits(dateData.checks, DATA.reference, opsFilter, { areaOf });
    const matched = matchVisits(rows, tv, cfg);
    const ayceOrders = new Set(dateData.selections
      .filter((s) => !s.voided && /PER PERSON|\(kids\)/i.test(s.itemName ?? '')).map((s) => s.orderGuid));
    const orderServer = new Map(dateData.checks.map((ch) => [ch.orderGuid, ch.serverGuid]));
    for (const r of matched) {
      if (r.matchedOrderGuid) {
        r.hasAyceSales = ayceOrders.has(r.matchedOrderGuid);
        r.matchedServerGuid = orderServer.get(r.matchedOrderGuid) ?? null;
      }
    }
    all.push(...matched);
  }

  const recorded = all.filter((s) => s.intent !== 'UNKNOWN').length;
  const unmarked = all.length - recorded;
  const newRows = all.filter((s) => !existing.has(s.rowHash));
  const issues = triageIntents(newRows).badge;
  const fileHash = await fileHashOf(text);

  stage.innerHTML = `
    <div class="sh" style="margin:14px 0 6px;font-weight:650">Here's what's in the file — nothing is saved yet.</div>
    <div class="calcrow"><span class="cl">Dates included</span><span class="cr">${esc(dates.length === 1 ? longDate(dates[0]) : `${longDate(dates[0])} – ${longDate(dates[dates.length - 1])}`)}</span></div>
    <div class="calcrow"><span class="cl">Completed visits</span><span class="cr">${fmt(all.length)}</span></div>
    <div class="calcrow"><span class="cl">Guest status recorded</span><span class="cr">${fmt(recorded)}</span></div>
    <div class="calcrow"><span class="cl">Guest status not recorded</span><span class="cr">${fmt(unmarked)}</span></div>
    <div class="calcrow"><span class="cl">Duplicate rows already loaded</span><span class="cr">${fmt(dup)}</span></div>
    <div class="calcrow"><span class="cl">Possible issues requiring a decision</span><span class="cr">${fmt(issues)}</span></div>
    ${notCompleted ? `<div class="note" style="margin-top:10px">${fmt(notCompleted)} canceled or no-show rows are ignored automatically — that's normal.</div>` : ''}
    <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
      <button class="bigbtn" id="otGo" type="button">Update Dashboard</button>
      <span class="sub">Saves to the shared dashboard for everyone.</span></div>
    <div id="otResult" style="margin-top:12px" role="status"></div>`;

  stage.querySelector('#otGo').addEventListener('click', async () => {
    if (!requireOperator('Uploading the OpenTable file')) return;
    const btn = stage.querySelector('#otGo');
    const out = stage.querySelector('#otResult');
    btn.disabled = true;
    out.innerHTML = '<div class="sub">Saving…</div>';
    try {
      const clean = all.map(({ matchReasons, ...keep }) => keep);
      const res = await rpc('ace_upload_opentable', {
        p_rows: clean, p_file_name: file.name, p_file_hash: fileHash,
      });
      const connected = all.filter((s) => s.intent !== 'UNKNOWN' && s.matchStatus === 'matched').length;
      out.innerHTML = `<div class="note" style="border-left-color:var(--pos)">
        <b>Dashboard updated successfully</b> — ${fmtWhen(new Date().toISOString())} by ${esc(currentUser().email || 'manager')}.<br>
        ${fmt(connected)} visits connected to Toast.<br>
        ${fmt(unmarked)} visits had no recorded starting choice — they still count in sales, covers and food
        cost; only conversion rates leave them out.<br>
        ${res.duplicates ? `${fmt(res.duplicates)} rows were already loaded and skipped (re-uploading is always safe).<br>` : ''}
        ${issues ? `${fmt(issues)} item${issues === 1 ? '' : 's'} need${issues === 1 ? 's' : ''} a decision — see <b>Fixes Needed</b>.` : 'Nothing needs a decision.'}</div>`;
      notify('OpenTable file saved to the dashboard.');
      CTX.refreshData();
    } catch (e) {
      btn.disabled = false;
      out.innerHTML = `<div class="errbox"><b>The update didn't save.</b> ${esc(e.message)}</div>`;
    }
  });
}

/* ---------------------------------------------------- Food Costs workflow -- */
let xlsxReady = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxReady) {
    xlsxReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the spreadsheet reader. Save the file as CSV and try again.'));
      document.head.appendChild(s);
    });
  }
  return xlsxReady;
}

export function startCostFlow(stageHost) {
  if (!requireOperator('Uploading food costs')) return;
  const body = stageCard(stageHost, 'Upload Food Costs', `
    <div class="dz" id="cDz" tabindex="0" role="button" aria-label="Choose or drop the cost file">
      <div class="dzt">Drop the chef's cost file here — or click to choose it</div>
      <div class="dzs">CSV or Excel (.csv / .xlsx). One row per item with its cost per portion.</div>
    </div>
    <div class="note" style="margin-top:10px"><b>What the file needs:</b> a header row naming at least
      <b>canonical_name</b> (or “item” / “name”) and <b>cost</b> (or “cost_per_portion” / “unit_cost”);
      optional <b>portion</b> and <b>notes</b> columns. The management workbook layout (names in column B,
      costs in column C) is also understood. Costs are dollars per portion, above $0.
      Chef-confirmed values replace rough costs item by item, and past days keep the costs
      that were in effect at the time. Uploading the same file twice is safe.</div>
    <div id="cStage"></div>`);
  const dz = body.querySelector('#cDz');
  const stage = body.querySelector('#cStage');
  const onFile = (file) => handleCostFile(file, stage).catch((e) => {
    stage.innerHTML = `<div class="errbox"><b>That file didn't work.</b> ${esc(e.message)}</div>`;
  });
  dz.addEventListener('click', () => pickFile('.csv,.xlsx', onFile));
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile('.csv,.xlsx', onFile); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
}

async function handleCostFile(file, stage) {
  const { DATA } = CTX;
  if (file.size > 5 * 1024 * 1024) throw new Error('The file is unexpectedly large for a cost sheet.');
  stage.innerHTML = '<div class="sub" style="padding:12px 0">Reading the file…</div>';

  let incoming;
  let rejected = [];
  let workbookHeuristic = false;
  if (/\.xlsx?$/i.test(file.name)) {
    await loadXlsx();
    const wb = window.XLSX.read(await file.arrayBuffer());
    const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
    const parsed = rowsFromWorkbookAoaDetailed(aoa);
    incoming = parsed.rows;
    rejected = parsed.rejected;
    workbookHeuristic = parsed.layout === 'workbook';
  } else {
    const parsed = parseCostCsvDetailed(await file.text());
    if (parsed === null) throw new Error('The first row should name the columns — at least "canonical_name" (the item) and "cost". See the format guidance above the drop zone.');
    incoming = parsed.rows;
    rejected = parsed.rejected;
  }
  if (!incoming.length) {
    throw new Error('No usable cost rows were found (each row needs an item name and a cost above $0).'
      + (rejected.length ? ` ${rejected.length} row(s) were rejected: ${rejected.slice(0, 5).map((r) => `line ${r.line} — ${r.why}`).join('; ')}.` : ''));
  }

  // Duplicate handling: the same item twice with DIFFERENT costs is ambiguous
  // and must be fixed in the file — never silently accepted. Identical
  // duplicates collapse to one row.
  const byNorm = new Map();
  const ambiguous = [];
  for (const r of incoming) {
    const k = normalizeName(r.name);
    const prev = byNorm.get(k);
    if (!prev) byNorm.set(k, r);
    else if (Math.abs(prev.cost - r.cost) > 0.005) ambiguous.push(`${r.name} ($${prev.cost.toFixed(2)} vs $${r.cost.toFixed(2)})`);
  }
  if (ambiguous.length) {
    throw new Error(`The file lists the same item more than once with different costs: ${ambiguous.join(', ')}. Fix the file so each item appears once.`);
  }
  incoming = [...byNorm.values()];

  let aliasMap = {};
  try { aliasMap = await (await fetch('imports/alias_map.json', { cache: 'no-cache' })).json(); delete aliasMap._comment; } catch { /* optional */ }
  incoming = attachAliases(incoming, aliasMap);

  const today = (() => {
    const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${ny.getFullYear()}${String(ny.getMonth() + 1).padStart(2, '0')}${String(ny.getDate()).padStart(2, '0')}`;
  })();

  const renderPreview = (effectiveFrom) => {
    const diff = diffCosts(incoming, DATA.costs, effectiveFrom);
    const unmatchedNames = [...new Set((DATA.items ?? []).filter((i) => !i.matched).map((i) => i.name))];
    const uncosted = stillUncosted(unmatchedNames, incoming, aliasMap);
    const usd = (n) => (n == null ? 'new' : '$' + Number(n).toFixed(2));
    stage.innerHTML = `
      <div class="sh" style="margin:14px 0 6px;font-weight:650">Here's what this file changes — nothing is saved yet.</div>
      <div class="calcrow"><span class="cl">Items recognized</span><span class="cr">${fmt(diff.recognized)}</span></div>
      <div class="calcrow"><span class="cl">Costs that change</span><span class="cr">${fmt(diff.changed.length + diff.added.length)}</span></div>
      <div class="calcrow"><span class="cl">Costs staying the same</span><span class="cr">${fmt(diff.unchanged.length)}</span></div>
      <div class="calcrow"><span class="cl">Toast items still without a cost after this</span><span class="cr">${fmt(uncosted.length)}</span></div>
      ${rejected.length ? `<div class="note warn" style="margin-top:10px"><b>${rejected.length} row${rejected.length === 1 ? ' was' : 's were'} rejected</b> and will not be saved:
        ${rejected.slice(0, 8).map((r) => `line ${r.line}${r.name ? ` (${esc(r.name)})` : ''} — ${esc(r.why)}`).join('; ')}${rejected.length > 8 ? ` and ${rejected.length - 8} more` : ''}.</div>` : ''}
      ${workbookHeuristic ? `<div class="note" style="margin-top:10px">This file has no header row, so it was read using the known
        known workbook layout (item names in column B, costs in column C). Only rows that fit that shape are
        listed above — check the "Items recognized" count against the workbook before confirming.</div>` : ''}
      ${(diff.changed.length || diff.added.length) ? `
        <div style="max-height:210px;overflow-y:auto;margin-top:10px;border:1px solid var(--border);border-radius:8px">
        <table><thead><tr><th style="text-align:left">Item</th><th>Now</th><th>Becomes</th></tr></thead><tbody>
        ${[...diff.changed, ...diff.added].map((x) => `<tr><td style="text-align:left">${esc(x.name)}</td>
          <td>${usd(x.oldCost)}</td><td><b>$${Number(x.newCost).toFixed(2)}</b></td></tr>`).join('')}
        </tbody></table></div>` : ''}
      ${diff.skipped.length ? `<div class="note gold" style="margin-top:10px">${diff.skipped.length} item(s) skipped: ${esc(diff.skipped.map((s) => s.name).join(', '))} — a newer cost is already in place.</div>` : ''}
      ${uncosted.length ? `<div class="note" style="margin-top:10px">Still without a cost: ${esc(uncosted.slice(0, 12).join(', '))}${uncosted.length > 12 ? ` and ${uncosted.length - 12} more` : ''}. They stay out of the numbers (never counted as $0) until costed.</div>` : ''}
      <div class="acc" style="margin-top:12px"><button type="button" aria-expanded="false" id="cAdv">Advanced<span class="ch">${icon('chevronRight', 14)}</span></button>
        <div class="ab" hidden><label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-xs)">New costs take effect from
          <input id="cEff" type="date" value="${effectiveFrom.slice(0, 4)}-${effectiveFrom.slice(4, 6)}-${effectiveFrom.slice(6, 8)}"
            style="padding:7px 10px;border:1px solid var(--border-2);border-radius:7px;background:var(--surface-2);max-width:200px"></label>
          <div class="sub" style="margin-top:6px">Days before this date keep their old costs — history never changes.</div></div></div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button class="bigbtn" id="cGo" type="button">Confirm and Update</button>
        <span class="sub">Updates the shared cost list and recalculates affected days.</span></div>
      <div id="cResult" style="margin-top:12px" role="status"></div>`;
    stage.querySelector('#cAdv').addEventListener('click', () => {
      const b = stage.querySelector('.acc .ab'); const tg = stage.querySelector('#cAdv');
      const open = tg.getAttribute('aria-expanded') === 'true';
      tg.setAttribute('aria-expanded', String(!open)); b.hidden = open;
    });
    stage.querySelector('#cEff').addEventListener('change', (e) => {
      const v = e.target.value; if (v) renderPreview(v.replaceAll('-', ''));
    });
    stage.querySelector('#cGo').addEventListener('click', () => applyCosts(effectiveFrom));
  };

  const applyCosts = async (effectiveFrom) => {
    if (!requireOperator('Uploading food costs')) return;
    const btn = stage.querySelector('#cGo');
    const out = stage.querySelector('#cResult');
    btn.disabled = true;
    try {
      out.innerHTML = '<div class="sub">Saving the new costs…</div>';
      const fileHash = await rowHashOfAsync(`${file.name}:${file.size}:${effectiveFrom}`);
      const res = await rpc('ace_upload_costs', {
        p_records: incoming, p_effective_from: effectiveFrom,
        p_source: 'chef_confirmed', p_file_name: file.name, p_file_hash: fileHash,
      });
      // recalculate the days the new costs touch (effective date forward)
      const allDates = (DATA.manifest?.dates ?? []).filter((d) => d >= effectiveFrom).sort();
      const costs = (await restGet('ace_item_costs?select=payload', { range: '0-1999' })).map((r) => r.payload);
      let done = 0;
      const rowsAcc = [], itemsAcc = [], datesAcc = [];
      for (const d of allDates) {
        out.innerHTML = `<div class="sub">Recalculating ${longDate(d)} (${++done} of ${allDates.length})…</div>`;
        const { checks, selections } = await fetchDateData(d);
        const { rows, itemRows } = buildMetricsForDate(d, selections, checks, DATA.reference, costs, DATA.ops);
        rowsAcc.push(...rows); itemsAcc.push(...itemRows); datesAcc.push(d);
        if (datesAcc.length >= 8 || d === allDates[allDates.length - 1]) {
          await rpc('ace_replace_metrics', { p_dates: datesAcc.splice(0), p_rows: rowsAcc.splice(0), p_item_rows: itemsAcc.splice(0) });
        }
      }
      const skippedNote = (res.skipped ?? []).length
        ? `<br>${res.skipped.length} row${res.skipped.length === 1 ? '' : 's'} skipped by the database: ${esc(res.skipped.map((s) => `${s.name} (${s.why})`).join('; '))}.`
        : '';
      out.innerHTML = `<div class="note" style="border-left-color:var(--pos)">
        <b>Food costs updated</b> — ${fmtWhen(new Date().toISOString())} by ${esc(currentUser().email || 'manager')}.<br>
        ${fmt(res.changed)} cost${res.changed === 1 ? '' : 's'} changed, ${fmt(res.unchanged)} unchanged.
        Chef-confirmed values now replace rough costs for those items.${skippedNote}<br>
        ${allDates.length ? `${allDates.length} day${allDates.length === 1 ? '' : 's'} of numbers recalculated.` : 'No existing days needed recalculating.'}</div>`;
      notify('Food costs updated.');
      CTX.refreshData();
    } catch (e) {
      btn.disabled = false;
      out.innerHTML = `<div class="errbox"><b>The update didn't save.</b> ${esc(e.message)}</div>`;
    }
  };

  renderPreview(today);
}
