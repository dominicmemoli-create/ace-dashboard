// Update Dashboard — the one place managers keep data current.
// Three status cards (Toast Sales · OpenTable Guest Status · Food Costs),
// a compact green/yellow/red system panel, and complete in-browser upload
// workflows. Writes go through the protected database functions with the
// signed-in user's identity; no commands, no JSON, no configuration.
import { parseGuestCenter, sanitizeVisitAsync, rowHashOfAsync } from './opentable.mjs';
import { toastVisits, matchVisits } from './ot-matcher.mjs';
import { triageIntents } from './triage.mjs';
import { parseCostCsv, rowsFromWorkbookAoa, attachAliases, diffCosts, stillUncosted } from './costs-shared.mjs';
import { buildMetricsForDate } from './metrics-builder.mjs';
import { rpc, restGet } from './auth.mjs';
import {
  canUploadOpenTable, canUploadCosts, canRetryToast, requireRole, notify, refreshIdentity,
} from './manager-mode.mjs';

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
    });
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
    if (it.source === 'rough_workbook') rough += it.cost;
  }
  for (const r of DATA.metrics ?? []) {
    if (r.serverGuid) continue;
    matched += r.matchedQty ?? 0; qty += r.totalQty ?? 0;
  }
  const updatedAts = (DATA.costs ?? []).map((c) => c.updatedAt).filter(Boolean).sort();
  return {
    roughShare: total > 0 ? (rough / total) * 100 : 0,
    coverage: qty > 0 ? (matched / qty) * 100 : null,
    lastUpdated: updatedAts[updatedAts.length - 1] ?? null,
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
  if (t.state === 'attention') {
    return { color: 'yellow', head: 'One update is needed', action: 'Toast is behind. Press Retry Toast Update below.' };
  }
  const needs = [];
  if (ot.behind) needs.push(`Upload the OpenTable file for ${longDate(ot.toastLast)}.`);
  if (badge > 0) needs.push(`${badge} item${badge === 1 ? '' : 's'} under Fixes Needed ${badge === 1 ? 'needs' : 'need'} a decision.`);
  if (c.roughShare > 0) needs.push('Food costs are still rough estimates — upload the chef’s confirmed costs when ready.');
  if (needs.length) return { color: 'yellow', head: 'One update is needed', action: needs.join(' ') };
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

  host.innerHTML = `
  <div class="sys ${sys.color} rise" role="status">
    <span class="si" aria-hidden="true"></span>
    <div><div class="sh2">${esc(sys.head)}</div><div class="sm">${esc(sys.action)}</div></div>
  </div>

  <div class="sec g3">
    <div class="card"><header><div><div class="ttl">Toast Sales</div>
      <div class="sub">Updates by itself every morning</div></div></header>
      <div class="body">
        <div style="margin-bottom:10px">${t.state === 'ok' ? `<span class="st ok">${esc(t.label)}</span>`
          : t.state === 'updating' ? `<span class="st partial">${esc(t.label)}</span>`
          : `<span class="st rev">${esc(t.label)}</span>`}</div>
        <div class="calcrow"><span class="cl">Sales through</span><span class="cr">${longDate(t.last)}</span></div>
        <div class="calcrow"><span class="cl">Last update</span><span class="cr">${fmtWhen(DATA.manifest?.lastToastSync)}</span></div>
        <div class="note" style="margin-top:12px">Sales come in from Toast automatically around 6 AM for the
          previous day. You normally don't need to do anything here.</div>
        <div id="toastActions" style="margin-top:12px"></div>
      </div></div>

    <div class="card"><header><div><div class="ttl">OpenTable Guest Status</div>
      <div class="sub">Upload the GuestCenter file after each service</div></div></header>
      <div class="body">
        <div style="margin-bottom:10px">${ot.behind
          ? `<span class="st partial">Upload needed${ot.toastLast ? ` for ${esc(longDate(ot.toastLast))}` : ''}</span>`
          : `<span class="st ok">Covers through ${esc(longDate(ot.otLast))}</span>`}</div>
        <div class="calcrow"><span class="cl">Last upload</span><span class="cr">${fmtWhen(ot.lastUpload)}</span></div>
        <div class="calcrow"><span class="cl">Days covered</span><span class="cr">${ot.otDates.length ? `${longDate(ot.otDates[0])} – ${longDate(ot.otLast)}` : 'none yet'}</span></div>
        ${ot.behind ? `<div class="note gold" style="margin-top:12px">Toast has newer sales than the guest-status file.
          Upload the latest GuestCenter export so conversion stays current.</div>` : ''}
        <div style="margin-top:12px"><button class="bigbtn" id="otUploadBtn" type="button">Upload OpenTable File</button></div>
      </div></div>

    <div class="card"><header><div><div class="ttl">Food Costs</div>
      <div class="sub">Occasional — when the chef confirms costs</div></div></header>
      <div class="body">
        <div style="margin-bottom:10px">${c.roughShare > 0
          ? `<span class="st partial">Rough estimates in use</span>`
          : `<span class="st ok">Chef-confirmed</span>`}</div>
        <div class="calcrow"><span class="cl">Last updated</span><span class="cr">${fmtWhen(c.lastUpdated)}</span></div>
        <div class="calcrow"><span class="cl">AYCE items with costs entered</span><span class="cr">${c.coverage == null ? '—' : c.coverage.toFixed(0) + '%'}</span></div>
        <div class="note" style="margin-top:12px">${c.roughShare > 0
          ? `About ${c.roughShare.toFixed(0)}% of cost dollars still use rough estimates. Numbers stay marked
             provisional until the chef's confirmed costs are uploaded.`
          : 'Costs are chef-confirmed. Upload a new file whenever prices change.'}</div>
        <div style="margin-top:12px" id="costBtnWrap"></div>
      </div></div>
  </div>

  <div id="upStage" class="sec"></div>`;

  renderToastActions(host.querySelector('#toastActions'), t);
  host.querySelector('#otUploadBtn').addEventListener('click', () => {
    if (!requireRole(canUploadOpenTable, 'Uploading the OpenTable file')) return;
    startOpenTableFlow(host.querySelector('#upStage'));
  });
  // Food-cost upload is manager-only; shift leads don't see the button at all.
  // Identity resolves asynchronously (token may need a refresh after the
  // device slept), so paint the button once the role is actually known.
  refreshIdentity().then(() => {
    const w = host.querySelector('#costBtnWrap');
    if (!w || !canUploadCosts() || w.querySelector('#costUploadBtn')) return;
    w.innerHTML = `<button class="bigbtn" id="costUploadBtn" type="button">Update Food Costs</button>`;
    w.querySelector('#costUploadBtn').addEventListener('click', () => startCostFlow(host.querySelector('#upStage')));
  });
}

/* --------------------------------------------------------- Toast retry UI -- */
function renderToastActions(el, t) {
  if (t.state !== 'attention') { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="bigbtn" id="retryBtn" type="button">Retry Toast Update</button>
    <div class="acc" style="margin-top:10px"><button type="button" aria-expanded="false" id="advTgl">
      Advanced<span class="ch">▶</span></button>
      <div class="ab" hidden id="advBody">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">Business date to update
          <input id="advDate" type="date" style="padding:7px 10px;border:1px solid var(--border-2);border-radius:7px;background:var(--surface-2);max-width:200px"></label>
        <div style="margin-top:8px"><button class="btn ghost sm" id="retryDateBtn" type="button">Update this date</button></div>
      </div></div>
    <div id="retryStage" class="sub" style="margin-top:8px" role="status"></div>`;
  el.querySelector('#advTgl').addEventListener('click', () => {
    const b = el.querySelector('#advBody'); const t2 = el.querySelector('#advTgl');
    const open = t2.getAttribute('aria-expanded') === 'true';
    t2.setAttribute('aria-expanded', String(!open)); b.hidden = open;
  });
  const kick = async (businessDate) => {
    if (!requireRole(canRetryToast, 'Retrying the Toast update')) return;
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
    <span class="sp"></span><button class="xbtn" type="button" id="stageClose" aria-label="Close">✕</button></header>
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
  const emp = new Map((DATA.reference?.employees ?? []).map((e) => [e.guid, e.name]));
  const all = [];
  for (const d of dates) {
    const rows = sanitized.filter((s) => s.businessDate === d);
    stage.innerHTML = `<div class="sub" style="padding:12px 0">Connecting ${longDate(d)} to Toast tables…</div>`;
    let dateData;
    try { dateData = await fetchDateData(d); } catch { dateData = { checks: [], selections: [] }; }
    if (!dateData.checks.length) { all.push(...rows); continue; }
    const tv = toastVisits(dateData.checks, DATA.reference, opsFilter)
      .map((v) => ({ ...v, serverName: emp.get(v.serverGuid) ?? '' }));
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
    <div class="calcrow"><span class="cl">Possible issues requiring a manager decision</span><span class="cr">${fmt(issues)}</span></div>
    ${notCompleted ? `<div class="note" style="margin-top:10px">${fmt(notCompleted)} canceled or no-show rows are ignored automatically — that's normal.</div>` : ''}
    <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
      <button class="bigbtn" id="otGo" type="button">Update Dashboard</button>
      <span class="sub">Saves to the shared dashboard for everyone.</span></div>
    <div id="otResult" style="margin-top:12px" role="status"></div>`;

  stage.querySelector('#otGo').addEventListener('click', async () => {
    if (!requireRole(canUploadOpenTable, 'Uploading the OpenTable file')) return;
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
        <b>Dashboard updated successfully.</b><br>
        ${fmt(connected)} visits connected to Toast.<br>
        ${fmt(unmarked)} unmarked visits were excluded automatically.<br>
        ${res.duplicates ? `${fmt(res.duplicates)} rows were already loaded and skipped.<br>` : ''}
        ${issues ? `${fmt(issues)} item${issues === 1 ? '' : 's'} may require a manager decision — see <b>Fixes Needed</b>.` : 'Nothing needs a manager decision.'}</div>`;
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
  if (!requireRole(canUploadCosts, 'Updating food costs')) return;
  const body = stageCard(stageHost, 'Update Dashboard → Food Costs', `
    <div class="dz" id="cDz" tabindex="0" role="button" aria-label="Choose or drop the cost file">
      <div class="dzt">Drop the chef's cost file here — or click to choose it</div>
      <div class="dzs">CSV or Excel. One row per item with its cost per portion.</div>
    </div>
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
  if (/\.xlsx?$/i.test(file.name)) {
    await loadXlsx();
    const wb = window.XLSX.read(await file.arrayBuffer());
    const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
    incoming = rowsFromWorkbookAoa(aoa);
  } else {
    incoming = parseCostCsv(await file.text());
    if (incoming === null) throw new Error('The first row should name the columns — at least "canonical_name" (the item) and "cost".');
  }
  if (!incoming.length) throw new Error('No usable cost rows were found (each row needs an item name and a cost above $0).');

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
      ${(diff.changed.length || diff.added.length) ? `
        <div style="max-height:210px;overflow-y:auto;margin-top:10px;border:1px solid var(--border);border-radius:8px">
        <table><thead><tr><th style="text-align:left">Item</th><th>Now</th><th>Becomes</th></tr></thead><tbody>
        ${[...diff.changed, ...diff.added].map((x) => `<tr><td style="text-align:left">${esc(x.name)}</td>
          <td>${usd(x.oldCost)}</td><td><b>$${Number(x.newCost).toFixed(2)}</b></td></tr>`).join('')}
        </tbody></table></div>` : ''}
      ${diff.skipped.length ? `<div class="note gold" style="margin-top:10px">${diff.skipped.length} item(s) skipped: ${esc(diff.skipped.map((s) => s.name).join(', '))} — a newer cost is already in place.</div>` : ''}
      ${uncosted.length ? `<div class="note" style="margin-top:10px">Still without a cost: ${esc(uncosted.slice(0, 12).join(', '))}${uncosted.length > 12 ? ` and ${uncosted.length - 12} more` : ''}. They stay out of the numbers (never counted as $0) until costed.</div>` : ''}
      <div class="acc" style="margin-top:12px"><button type="button" aria-expanded="false" id="cAdv">Advanced<span class="ch">▶</span></button>
        <div class="ab" hidden><label style="display:flex;flex-direction:column;gap:4px;font-size:12px">New costs take effect from
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
    if (!requireRole(canUploadCosts, 'Updating food costs')) return;
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
      out.innerHTML = `<div class="note" style="border-left-color:var(--pos)"><b>Food costs updated.</b><br>
        ${fmt(res.changed)} cost${res.changed === 1 ? '' : 's'} changed, ${fmt(res.unchanged)} unchanged.<br>
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
