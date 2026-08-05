/* =============================================================================
   AYCE Performance Dashboard — live pages.

   Navigation:
     Operations — Overview · Server Performance · AYCE Food Cost ·
                  Update Dashboard · Fixes Needed
     Historical — Pilot Review (frozen pilot pages under one entry)
     Help       — How This Works (plain language; technical detail collapsed
                  under Advanced Details)

   Data architecture (unchanged):
   - ace_metrics / ace_item_metrics carry per-(date × service period × server)
     AYCE-only aggregates. Static data/live/metrics.json is the backup.
   - ace_intents carries the PII-stripped OpenTable records with match status.
   - The frozen pilot payload keeps powering Pilot Review untouched.

   Honesty rules:
   - Food cost = ESTIMATED AYCE consumption recorded in Toast. Not inventory,
     not waste. Unrecorded refills are not estimated.
   - Costs remain labeled provisional until chef-confirmed.
   - Unknown / unmarked visits never help or hurt anyone and never create work.
   - Commission: pilot ledger preserved; program inactive after Aug 2, 2026.
   ========================================================================== */
import { comparableBaselineDates, weekdayOf, DEFAULT_THRESHOLDS } from './food-cost-engine.mjs';
import { triageIntents } from './triage.mjs';
import { initManagerMode } from './manager-mode.mjs';
import { initUpdatePage, pgUpdate } from './page-update.mjs';
import { initFixesPage, pgFixes } from './page-fixes.mjs';

const APP = window.__ACE_APP__;
if (!APP) throw new Error('pages-live: legacy shell did not expose __ACE_APP__');
const { PAGES, S, helpers } = APP;
const { esc, fmt, pct, usd, usd0, sgn } = helpers;

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ------------------------------------------------------------ data layer -- */
const DATA = {
  loaded: false, loading: null, error: null, source: null,
  ops: null,            // config/operations.json
  metrics: [],          // period/server aggregate rows
  items: [],            // per-item aggregates
  intents: [],          // sanitized OpenTable records
  costs: [], reference: null, manifest: null,
  importRuns: [],       // upload history (newest first)
  ingestionRuns: [],    // Toast update history (payloads)
  pilotSelections: [], pilotChecks: [],   // static pilot raw (drilldown)
};
let CFG = null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
async function sbRows(cfg, table, select, filter = '') {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${cfg.url}/rest/v1/${table}?select=${select}${filter}`, {
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, Range: `${from}-${from + 999}` },
    });
    if (!res.ok && res.status !== 206) throw new Error(`${table}: HTTP ${res.status}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

const configReady = (async () => {
  try { CFG = await fetchJson('data/supabase_config.json'); } catch { CFG = null; }
  return CFG;
})();

function loadLive() {
  if (DATA.loading) return DATA.loading;
  DATA.loading = (async () => {
    try {
      DATA.ops = await fetchJson('config/operations.json');
      const cfg = await configReady;
      let db = false;
      if (cfg?.url && cfg?.anonKey) {
        try {
          const [man, ref, costs, metrics, items, intents, imports, ing] = await Promise.all([
            sbRows(cfg, 'ace_manifest', '*'),
            sbRows(cfg, 'ace_reference', 'payload'),
            sbRows(cfg, 'ace_item_costs', 'payload'),
            sbRows(cfg, 'ace_metrics', 'payload'),
            sbRows(cfg, 'ace_item_metrics', 'payload'),
            sbRows(cfg, 'ace_intents', 'payload'),
            sbRows(cfg, 'ace_import_runs', 'kind,file_name,counts,status,error,created_by_email,created_at', '&order=created_at.desc&limit=40'),
            sbRows(cfg, 'ace_ingestion_runs', 'payload', '&order=run_id.desc&limit=25'),
          ]);
          if (!metrics.length) throw new Error('ace_metrics empty');
          DATA.manifest = { restaurantGuid: man[0]?.restaurant_guid, dates: man[0]?.dates ?? [], lastToastSync: man[0]?.last_toast_sync };
          DATA.reference = ref[0]?.payload;
          DATA.costs = costs.map((r) => r.payload);
          DATA.metrics = metrics.map((r) => r.payload);
          DATA.items = items.map((r) => r.payload);
          DATA.intents = intents.map((r) => r.payload);
          DATA.importRuns = imports;
          DATA.ingestionRuns = ing.map((r) => r.payload);
          DATA.source = 'supabase';
          db = true;
        } catch (e) { console.warn('Database unavailable → backup data:', e?.message); }
      }
      if (!db) {
        DATA.manifest = await fetchJson('data/live/manifest.json');
        DATA.reference = await fetchJson('data/live/reference.json');
        DATA.costs = await fetchJson('data/live/item_costs.json');
        const m = await fetchJson('data/live/metrics.json');
        DATA.metrics = m.rows; DATA.items = m.items;
        DATA.intents = []; // OpenTable records live in the database only
        DATA.importRuns = [];
        try { DATA.ingestionRuns = await fetchJson('data/live/ingestion_runs.json'); } catch { DATA.ingestionRuns = []; }
        DATA.source = 'static';
      }
      // pilot raw for drilldown — static, tolerate absence
      for (const d of ['20260731', '20260801', '20260802']) {
        try {
          DATA.pilotSelections.push(...await fetchJson(`data/live/selections_${d}.json`));
          DATA.pilotChecks.push(...await fetchJson(`data/live/checks_${d}.json`));
        } catch { /* not bundled */ }
      }
      DATA.loaded = true;
      renderFreshness();
      refreshBadge();
    } catch (err) {
      DATA.error = String(err?.message ?? err);
    }
  })();
  return DATA.loading;
}

function reloadLive() {
  DATA.loading = null;
  DATA.loaded = false;
  DATA.pilotSelections = []; DATA.pilotChecks = [];
  loadLive().then(() => APP.render());
}

function refreshBadge() {
  const { badge } = triageIntents(DATA.intents);
  const changed = (PAGES.fixes && PAGES.fixes.badge !== (badge || 0));
  if (PAGES.fixes) PAGES.fixes.badge = badge || 0;
  if (changed) APP.renderNav();
}

function opDates() {
  return [...new Set(DATA.metrics.filter((r) => !r.serverGuid).map((r) => r.businessDate))].sort();
}

/* -------------------------------------------------------- ops date state -- */
const OPS_KEY = 'ace.opsRange';
function opsState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(OPS_KEY) || '{}'); } catch { /* defaults */ }
  return { preset: 'week', from: null, to: null, period: 'all', ...s };
}
function saveOpsState(next) { localStorage.setItem(OPS_KEY, JSON.stringify(next)); }

function resolveRange(state) {
  const avail = opDates();
  if (!avail.length) return { dates: [], label: 'no data' };
  const latest = avail[avail.length - 1];
  const D = (yyyymmdd) => new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  const K = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const latestD = D(latest);
  const inRange = (from, to) => avail.filter((x) => x >= from && x <= to);
  switch (state.preset) {
    case 'yesterday': return { dates: [latest], label: `latest day (${fmtDate(latest)})` };
    case 'week': {
      const start = new Date(latestD); start.setUTCDate(start.getUTCDate() - start.getUTCDay());
      return { dates: inRange(K(start), latest), label: 'current week' };
    }
    case 'prevweek': {
      const start = new Date(latestD); start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7);
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
      return { dates: inRange(K(start), K(end)), label: 'previous week' };
    }
    case 'month': return { dates: avail.filter((x) => x.slice(0, 6) === latest.slice(0, 6)), label: 'current month' };
    case 'prevmonth': {
      const pm = new Date(latestD); pm.setUTCMonth(pm.getUTCMonth() - 1);
      const key = K(pm).slice(0, 6);
      return { dates: avail.filter((x) => x.slice(0, 6) === key), label: 'previous month' };
    }
    case 'custom': {
      const from = state.from ?? latest, to = state.to ?? latest;
      return { dates: inRange(from, to), label: `custom ${fmtDate(from)}–${fmtDate(to)}` };
    }
    case 'pilot': default:
      return { dates: avail.filter((x) => x >= '20260731' && x <= '20260802'), label: 'pilot weekend' };
  }
}

function periodsOf(state) { return state.period === 'all' ? ['lunch', 'dinner'] : [state.period]; }

/* ------------------------------------------------------------ aggregation -- */
function sumMetrics(dates, periods, serverGuid = null) {
  const set = new Set(dates);
  const acc = { checks: 0, guests: 0, floorNet: 0, ayceChecks: 0, entitlementNet: 0, entitlementCovers: 0, roundCost: 0, matchedQty: 0, totalQty: 0 };
  for (const r of DATA.metrics) {
    if ((r.serverGuid ?? null) !== serverGuid) continue;
    if (!set.has(r.businessDate) || !periods.includes(r.period)) continue;
    for (const k of Object.keys(acc)) acc[k] += r[k] ?? 0;
  }
  return acc;
}
function perServerMetrics(dates, periods) {
  const set = new Set(dates);
  const out = new Map();
  for (const r of DATA.metrics) {
    if (!r.serverGuid || !set.has(r.businessDate) || !periods.includes(r.period)) continue;
    if (!out.has(r.serverGuid)) out.set(r.serverGuid, { checks: 0, entitlementNet: 0, entitlementCovers: 0, roundCost: 0, matchedQty: 0, totalQty: 0 });
    const a = out.get(r.serverGuid);
    for (const k of Object.keys(a)) a[k] += r[k] ?? 0;
  }
  return out;
}
const fcPctOf = (a) => (a.entitlementNet > 0 ? (a.roundCost / a.entitlementNet) * 100 : null);

function baselineFor(dates, periods) {
  const { dates: bDates, perDate } = comparableBaselineDates(dates, opDates(), DATA.ops?.baseline?.weeks ?? 4);
  const agg = sumMetrics(bDates, periods);
  const found = Object.values(perDate).reduce((a, p) => a + p.found.length, 0);
  const requested = Object.values(perDate).reduce((a, p) => a + p.requested.length, 0);
  return { dates: bDates, agg, pct: fcPctOf(agg), found, requested };
}

/* ------------------------------------------------------------ freshness --- */
function renderFreshness() {
  const bar = document.querySelector('#topbar .tb-row');
  if (!bar || !DATA.manifest) return;
  let el = document.getElementById('freshness');
  if (!el) {
    el = document.createElement('span');
    el.id = 'freshness'; el.className = 'prov'; el.style.marginLeft = '8px';
    bar.appendChild(el);
  }
  const dates = opDates();
  const last = dates[dates.length - 1];
  const staleDays = Math.floor((Date.now() - Date.parse(`${last?.slice(0, 4)}-${last?.slice(4, 6)}-${last?.slice(6, 8)}T12:00:00-04:00`)) / 86400000);
  el.textContent = `${DATA.source === 'supabase' ? 'Live data' : 'Backup data'} · through ${fmtDate(last)}${staleDays > 1 ? ' · Update needed' : ''}`;
  el.style.color = staleDays > 1 ? 'var(--neg, #e0705c)' : '';
  el.title = DATA.source === 'supabase'
    ? 'Sales load live from the shared database. Toast refreshes automatically every morning.'
    : 'Showing saved backup data — the shared database was unreachable from this page load.';
}
function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd ?? '');
  return s.length === 8 ? `${s.slice(4, 6)}/${s.slice(6, 8)}` : '—';
}

/* --------------------------------------------------------- shared header --- */
function opsControls(state, onchange) {
  const presets = [
    ['yesterday', 'Latest day'], ['week', 'Current week'], ['prevweek', 'Previous week'],
    ['month', 'Current month'], ['prevmonth', 'Previous month'], ['pilot', 'Pilot weekend'], ['custom', 'Custom'],
  ];
  const avail = opDates();
  const el = document.createElement('div');
  el.className = 'card';
  el.style.marginBottom = '14px';
  el.innerHTML = `<div class="body" style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3)">Date range
      <select id="opsPreset" style="padding:6px 8px;border:1px solid var(--border-2);border-radius:8px;background:var(--bg-1);color:var(--ink-1)">
        ${presets.map(([v, l]) => `<option value="${v}" ${state.preset === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <label id="opsFromWrap" style="display:${state.preset === 'custom' ? 'flex' : 'none'};flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3)">From
      <select id="opsFrom" style="padding:6px 8px;border:1px solid var(--border-2);border-radius:8px;background:var(--bg-1);color:var(--ink-1)">
        ${avail.map((d) => `<option value="${d}" ${state.from === d ? 'selected' : ''}>${fmtDate(d)}</option>`).join('')}
      </select></label>
    <label id="opsToWrap" style="display:${state.preset === 'custom' ? 'flex' : 'none'};flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3)">To
      <select id="opsTo" style="padding:6px 8px;border:1px solid var(--border-2);border-radius:8px;background:var(--bg-1);color:var(--ink-1)">
        ${avail.map((d) => `<option value="${d}" ${(state.to ?? avail[avail.length - 1]) === d ? 'selected' : ''}>${fmtDate(d)}</option>`).join('')}
      </select></label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3)">Service period
      <select id="opsPeriod" style="padding:6px 8px;border:1px solid var(--border-2);border-radius:8px;background:var(--bg-1);color:var(--ink-1)">
        <option value="all" ${state.period === 'all' ? 'selected' : ''}>Lunch + dinner</option>
        <option value="lunch" ${state.period === 'lunch' ? 'selected' : ''}>Lunch (before ${DATA.ops.servicePeriods.lunchBeforeHour - 12} PM)</option>
        <option value="dinner" ${state.period === 'dinner' ? 'selected' : ''}>Dinner</option>
      </select></label>
    <span class="sub" style="margin-left:auto">Sales data: ${fmtDate(avail[0])}–${fmtDate(avail[avail.length - 1])} (${avail.length} days)</span>
  </div>`;
  const apply = () => {
    const next = {
      preset: el.querySelector('#opsPreset').value,
      from: el.querySelector('#opsFrom').value,
      to: el.querySelector('#opsTo').value,
      period: el.querySelector('#opsPeriod').value,
    };
    saveOpsState(next);
    onchange();
  };
  el.querySelector('#opsPreset').addEventListener('change', apply);
  el.querySelector('#opsFrom').addEventListener('change', apply);
  el.querySelector('#opsTo').addEventListener('change', apply);
  el.querySelector('#opsPeriod').addEventListener('change', apply);
  return el;
}

function withData(host, renderFn) {
  host.innerHTML = '<div class="skel skel-hero"></div>';
  loadLive().then(() => {
    if (DATA.error) {
      host.innerHTML = `<div class="errbox"><b>The dashboard data could not load.</b>
        Check the internet connection and refresh the page. ${esc(DATA.error)}</div>`;
      return;
    }
    renderFn(host);
  });
}

/* ==================================================== OPERATIONS OVERVIEW == */
function pgOps(host) { withData(host, renderOps); }
function renderOps(host) {
  const state = opsState();
  const range = resolveRange(state);
  const periods = periodsOf(state);
  const t = sumMetrics(range.dates, periods);
  const fc = fcPctOf(t);
  const base = baselineFor(range.dates, periods);
  const conv = conversionStatsFor(range.dates);
  const tri = triageIntents(DATA.intents.filter((r) => range.dates.includes(r.businessDate)));

  host.innerHTML = '';
  host.appendChild(opsControls(state, () => renderOps(host)));

  const div = document.createElement('div');
  div.innerHTML = `
  <section class="hero rise"><div class="hero-top">
    <div class="hero-verdict">
      <div class="hero-eyebrow">Operations — ${esc(range.label)}
        <span class="verdict-badge neu">LIVE DATA</span></div>
      <div class="hero-delta"><span class="big">${pct(t.guests ? (t.entitlementCovers / t.guests) * 100 : null)}</span>
        <span class="unit">AYCE cover mix<br>${fmt(Math.round(t.entitlementCovers))} AYCE covers of ${fmt(t.guests)} guests</span></div>
      <div class="hero-line"><b>${fmt(t.checks)}</b> dining-room &amp; patio checks · <b>${usd0(t.floorNet)}</b> net floor sales ·
        <b>${usd0(t.entitlementNet)}</b> AYCE sales on <b>${fmt(t.ayceChecks)}</b> AYCE checks.</div>
    </div>
    <div class="hero-rail">
      <div class="hr-cell"><div class="k">AYCE food cost (est.)</div><div class="v">${pct(fc)}</div>
        <div class="m">usually ${pct(base.pct)} on similar shifts</div></div>
      <div class="hr-cell"><div class="k">Conversion rate</div><div class="v">${pct(conv.rate)}</div>
        <div class="m">${conv.converted} of ${conv.eligible} recorded &amp; connected tables${conv.total === 0 ? ' · no OpenTable data in range' : ''}</div></div>
      <div class="hr-cell"><div class="k">Excluded automatically</div><div class="v">${fmt(tri.excluded.unmarked + tri.excluded.markedNotConnected)}</div>
        <div class="m">${tri.excluded.unmarked} no recorded choice · ${tri.excluded.markedNotConnected} no reliable table</div></div>
      <div class="hr-cell"><div class="k">Fixes needed</div><div class="v">${fmt(tri.badge)}</div>
        <div class="m">${tri.badge ? 'waiting under Fixes Needed' : 'nothing needs a decision'}</div></div>
    </div>
  </div>
  <div class="hero-summary"><div class="sh">Scope</div>
    <p>Dining-room and patio tables only — bar, takeout, delivery and non-table sales are excluded.
    AYCE food cost is <b>estimated from items recorded in Toast; it measures recorded consumption,
    not physical inventory usage or kitchen waste</b>. Conversion counts only tables with a recorded
    guest starting choice that connect to a Toast table; visits without a recorded choice never help
    or hurt anyone.</p></div>
  </section>`;
  host.appendChild(div);

  const rows = range.dates.map((d) => {
    const a = sumMetrics([d], periods);
    return { d, ...a, fc: fcPctOf(a) };
  });
  const tbl = document.createElement('div');
  tbl.className = 'card sec';
  tbl.innerHTML = `<header><div><div class="ttl">By day</div>
    <div class="sub">${periods.join(' + ')} · AYCE program figures per business date.</div></div></header>
    <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
    <thead><tr><th>Date</th><th>Day</th><th>Checks</th><th>Guests</th><th>Floor sales</th>
      <th>AYCE covers</th><th>AYCE sales</th><th>Est. food cost $</th><th>Food cost %</th></tr></thead><tbody>
    ${rows.map((r) => `<tr style="border-top:1px solid var(--border-2)">
      <td>${fmtDate(r.d)}</td><td>${WD[weekdayOf(r.d)].slice(0, 3)}</td>
      <td style="text-align:right">${fmt(r.checks)}</td><td style="text-align:right">${fmt(r.guests)}</td>
      <td style="text-align:right">${usd0(r.floorNet)}</td>
      <td style="text-align:right">${fmt(Math.round(r.entitlementCovers))}</td>
      <td style="text-align:right">${usd0(r.entitlementNet)}</td>
      <td style="text-align:right">${usd0(r.roundCost)}</td>
      <td style="text-align:right"><b>${pct(r.fc)}</b></td></tr>`).join('')}
    </tbody></table></div>`;
  host.appendChild(tbl);
}

function conversionStatsFor(dates) {
  const set = new Set(dates);
  const rows = DATA.intents.filter((r) => set.has(r.businessDate));
  const st = { total: rows.length, eligible: 0, converted: 0, unknown: 0, review: 0, mixed: 0, predecided: 0, ambiguous: 0 };
  for (const r of rows) {
    if (r.excluded) continue;                       // manager-excluded via correction
    const intent = r.intentEffective ?? r.intent;   // manager correction overrides, audit preserved
    const resolved = r.reviewStatus === 'confirmed';
    if (r.mixedMenuException && !resolved) { st.mixed++; continue; }
    if (intent === 'REVIEW_REQUIRED') { st.review++; continue; }
    if (intent === 'UNKNOWN') { st.unknown++; continue; }
    if (intent === 'PREDECIDED_AYCE') { st.predecided++; continue; }
    if (r.matchStatus === 'ambiguous') { st.ambiguous++; continue; } // never counts either way
    if (r.matchStatus !== 'matched') { st.unknown++; continue; }     // unconnected can't prove conversion
    st.eligible++;
    if (r.hasAyceSales) st.converted++;
  }
  st.rate = st.eligible > 0 ? (st.converted / st.eligible) * 100 : null;
  return st;
}

/* ================================================= SERVER PERFORMANCE (live) */
function pgServersLive(host) { withData(host, renderServersLive); }
function renderServersLive(host) {
  const th = fcSettings();
  const state = opsState();
  const range = resolveRange(state);
  const periods = periodsOf(state);
  const base = baselineFor(range.dates, periods);
  const emp = new Map((DATA.reference?.employees ?? []).map((e) => [e.guid, e.name]));

  // conversion per server from recorded-and-connected visits
  const set = new Set(range.dates);
  const convByServer = new Map();
  for (const r of DATA.intents) {
    if (!set.has(r.businessDate) || r.excluded) continue;
    const intent = r.intentEffective ?? r.intent;
    if (r.mixedMenuException && r.reviewStatus !== 'confirmed') continue;
    if (!['UNDECIDED', 'ALC'].includes(intent)) continue;
    if (r.matchStatus !== 'matched' || !r.matchedServerGuid) continue;
    const c = convByServer.get(r.matchedServerGuid) ?? { eligible: 0, converted: 0 };
    c.eligible++;
    if (r.hasAyceSales) c.converted++;
    convByServer.set(r.matchedServerGuid, c);
  }

  host.innerHTML = '';
  host.appendChild(opsControls(state, () => renderServersLive(host)));

  const per = perServerMetrics(range.dates, periods);
  const rows = [...per.entries()].map(([guid, a]) => {
    const p = fcPctOf(a);
    const cov = a.totalQty > 0 ? (a.matchedQty / a.totalQty) * 100 : null;
    let status = 'normal';
    if (a.checks < th.minChecks || a.entitlementNet < th.minNetFoodSales) status = 'insufficient_sample';
    else if (cov != null && cov < th.minCoveragePct) status = 'insufficient_coverage';
    else if (base.pct == null || p == null) status = 'no_baseline';
    else if (p - base.pct >= th.criticalPts) status = 'critical';
    else if (p - base.pct >= th.watchPts) status = 'watch';
    const conv = convByServer.get(guid) ?? { eligible: 0, converted: 0 };
    return { name: emp.get(guid) ?? '(unattributed)', a, p, cov, status, conv };
  }).sort((x, y) => y.a.entitlementNet - x.a.entitlementNet);

  const tbl = document.createElement('div');
  tbl.className = 'card sec';
  tbl.innerHTML = `<header><div><div class="ttl">Server performance — ${esc(range.label)}</div>
    <div class="sub">AYCE program only. Conversion counts recorded-and-connected tables — missing host data
    never helps or hurts a server. Flags stay off below ${th.minChecks} AYCE checks or ${usd0(th.minNetFoodSales)} AYCE sales.</div></div></header>
    <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
    <thead><tr><th style="text-align:left">Server</th><th>AYCE checks</th><th>AYCE covers</th>
      <th>AYCE sales</th><th>Food cost %</th><th>Usual %</th><th>Conversion</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => `<tr style="border-top:1px solid var(--border-2)">
      <td style="text-align:left;padding:6px 8px;white-space:nowrap">${esc(r.name)}</td>
      <td style="text-align:right">${fmt(r.a.checks)}</td>
      <td style="text-align:right">${fmt(Math.round(r.a.entitlementCovers))}</td>
      <td style="text-align:right">${usd0(r.a.entitlementNet)}</td>
      <td style="text-align:right"><b>${pct(r.p)}</b></td>
      <td style="text-align:right">${pct(base.pct)}</td>
      <td style="text-align:right">${r.conv.eligible ? `${pct((r.conv.converted / r.conv.eligible) * 100, 0)} <span class="muted">(${r.conv.converted}/${r.conv.eligible})</span>` : '—'}</td>
      <td style="text-align:center">${statusBadge(r.status)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="foot">This table never implies a server caused kitchen waste — it reflects what was rung for their
    AYCE tables. Pilot-weekend history (with commission) lives under Pilot Review.</div>`;
  host.appendChild(tbl);
}

/* ========================================================= AYCE FOOD COST == */
const FC_KEY = 'ace.fcSettings';
function fcSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(FC_KEY) || '{}'); } catch { /* defaults */ }
  return { ...DEFAULT_THRESHOLDS, ...s };
}
function pgFoodCost(host) { withData(host, renderFoodCost); }
function renderFoodCost(host) {
  const th = fcSettings();
  const state = opsState();
  const range = resolveRange(state);
  const periods = periodsOf(state);
  const t = sumMetrics(range.dates, periods);
  const scopePct = fcPctOf(t);
  const base = baselineFor(range.dates, periods);
  const variance = scopePct != null && base.pct != null ? scopePct - base.pct : null;
  const qtyCov = t.totalQty > 0 ? (t.matchedQty / t.totalQty) * 100 : null;
  const roughShare = provisionalShare(range.dates, periods);

  host.innerHTML = '';
  host.appendChild(opsControls(state, () => renderFoodCost(host)));

  const hero = document.createElement('div');
  hero.innerHTML = `
  <section class="hero rise"><div class="hero-top">
    <div class="hero-verdict">
      <div class="hero-eyebrow">AYCE food cost — ${esc(range.label)}
        <span class="verdict-badge ${roughShare > 0 ? 'neu' : 'pos'}">${roughShare > 0 ? 'PROVISIONAL — rough estimates in use' : 'CHEF-CONFIRMED'}</span></div>
      <div class="hero-delta"><span class="big">${pct(scopePct)}</span>
        <span class="unit">est. cost of AYCE food sent ÷<br>AYCE sales collected</span></div>
      <div class="hero-line"><b>${usd0(t.roundCost)}</b> estimated cost of recorded AYCE rounds ·
        <b>${usd0(t.entitlementNet)}</b> AYCE sales · <b>${fmt(Math.round(t.entitlementCovers))}</b> covers
        (${usd(t.entitlementCovers ? t.roundCost / t.entitlementCovers : null)} / cover vs
        ${usd(t.entitlementCovers ? t.entitlementNet / t.entitlementCovers : null)} collected).</div>
    </div>
    <div class="hero-rail">
      <div class="hr-cell"><div class="k">Usual food cost for similar shifts</div><div class="v">${pct(base.pct)}</div>
        <div class="m">${base.found} of ${base.requested} same weekday+period days available</div></div>
      <div class="hr-cell"><div class="k">Compared to usual</div>
        <div class="v ${variance != null && variance >= th.watchPts ? 'down' : ''}">${variance == null ? '—' : sgn(variance) + ' pts'}</div>
        <div class="m">watch ≥ +${th.watchPts} · critical ≥ +${th.criticalPts}</div></div>
      <div class="hr-cell"><div class="k">AYCE items with costs entered</div><div class="v">${pct(qtyCov)}</div>
        <div class="m">of recorded AYCE items have a cost</div></div>
      <div class="hr-cell"><div class="k">Rough-estimate share</div><div class="v">${pct(roughShare, 0)}</div>
        <div class="m">of cost dollars still from rough estimates</div></div>
    </div>
  </div>
  <div class="hero-summary"><div class="sh">Definition</div>
    <p><b>Estimated AYCE food cost based on items recorded in Toast. This measures recorded consumption,
    not physical inventory usage or kitchen waste.</b> Unrecorded refills cannot be measured and are not
    estimated. "Usual" = the same weekday and service period across the previous
    ${DATA.ops.baseline.weeks} weeks, weighted by dollars. Days used: ${base.dates.length ? base.dates.map(fmtDate).join(', ') : 'none available yet'}.
    Dining room + patio tables only.</p></div>
  </section>`;
  host.appendChild(hero);

  // item drivers + uncosted (from item metrics)
  const set = new Set(range.dates);
  const itemAgg = new Map();
  for (const it of DATA.items) {
    if (!set.has(it.businessDate) || !periods.includes(it.period)) continue;
    const key = `${it.matched ? 'm' : 'u'}|${it.name}`;
    if (!itemAgg.has(key)) itemAgg.set(key, { name: it.name, matched: it.matched, qty: 0, cost: 0, source: it.source, verification: it.verification });
    const a = itemAgg.get(key);
    a.qty += it.qty; a.cost += it.cost;
  }
  const drivers = [...itemAgg.values()].filter((x) => x.matched && x.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 14);
  const unmatched = [...itemAgg.values()].filter((x) => !x.matched).sort((a, b) => b.qty - a.qty).slice(0, 20);
  const two = document.createElement('div');
  two.className = 'sec g2';
  two.innerHTML = `
    <div class="card"><header><div><div class="ttl">Highest-cost AYCE items</div></div></header>
      <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th style="text-align:left">Item</th><th>Qty</th><th>Est. cost</th><th>Cost source</th></tr></thead><tbody>
      ${drivers.map((d) => `<tr style="border-top:1px solid var(--border-2)">
        <td style="text-align:left;padding:4px 8px">${esc(d.name)}</td>
        <td style="text-align:right">${fmt(Math.round(d.qty))}</td>
        <td style="text-align:right"><b>${usd0(d.cost)}</b></td>
        <td style="text-align:center">${d.source === 'rough_workbook' ? '<span class="verdict-badge neu">rough estimate</span>' : '<span class="verdict-badge pos">chef-confirmed</span>'}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="card"><header><div><div class="ttl">Items without a cost yet (${unmatched.length ? 'top ' + unmatched.length : 'none'})</div>
      <div class="sub">Left out of cost dollars (never counted as $0) — the true % is understated until costed.
      Add them via Update Dashboard → Food Costs.</div></div></header>
      <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th style="text-align:left">Item</th><th>Qty</th></tr></thead><tbody>
      ${unmatched.map((u) => `<tr style="border-top:1px solid var(--border-2)">
        <td style="text-align:left;padding:4px 8px">${esc(u.name)}</td>
        <td style="text-align:right">${fmt(Math.round(u.qty))}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  host.appendChild(two);
}

function provisionalShare(dates, periods) {
  const set = new Set(dates);
  let rough = 0, total = 0;
  for (const it of DATA.items) {
    if (!set.has(it.businessDate) || !periods.includes(it.period) || !it.matched) continue;
    total += it.cost;
    if (it.source === 'rough_workbook') rough += it.cost;
  }
  return total > 0 ? (rough / total) * 100 : 0;
}
function statusBadge(status) {
  const map = {
    normal: ['pos', 'Normal'], watch: ['neu', 'Watch'], critical: ['neg', 'Critical'],
    insufficient_sample: ['', 'Small sample'], insufficient_coverage: ['', 'Costs missing'], no_baseline: ['', '—'],
  };
  const [cls, label] = map[status] ?? ['', status];
  return `<span class="verdict-badge ${cls}">${label}</span>`;
}

/* ============================================================ PILOT REVIEW == */
const PILOT_TAB_KEY = 'ace.pilotTab';
function pgPilot(host) {
  const legacy = LEGACY;
  let tab = localStorage.getItem(PILOT_TAB_KEY) || 'overview';
  if (!legacy[tab]) tab = 'overview';
  const tabs = [
    ['overview', 'Overview'], ['servers', 'Server performance'], ['commission', 'Commission ledger'],
  ];
  host.innerHTML = `
    <div class="note gold" style="margin-bottom:14px"><b>Frozen history.</b> The pilot weekend
    (Jul 31 – Aug 2, 2026) is preserved exactly as reported. The commission program ended Aug 2 —
    figures here are informational and no new commission accrues.</div>
    <div class="seg" style="display:inline-flex;margin-bottom:16px" role="tablist" aria-label="Pilot Review sections">
      ${tabs.map(([k, l]) => `<button type="button" role="tab" data-ptab="${k}" aria-pressed="${k === tab}">${l}</button>`).join('')}
    </div>
    <div id="pilotBody"></div>`;
  const body = host.querySelector('#pilotBody');
  const paint = () => {
    body.innerHTML = '';
    legacy[tab].fn(body);
  };
  host.querySelectorAll('[data-ptab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.ptab;
    localStorage.setItem(PILOT_TAB_KEY, tab);
    host.querySelectorAll('[data-ptab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  }));
  paint();
}

/* =========================================================== HOW THIS WORKS */
function pgHelp(host) {
  withData(host, (h) => {
    const dates = opDates();
    const conv = conversionStatsFor(dates);
    const tri = triageIntents(DATA.intents);
    h.innerHTML = `
    <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
      <div class="hero-eyebrow">How This Works</div>
      <div class="hero-delta"><span class="big" style="font-size:34px;letter-spacing:-1px">Three data sources.<br>Three simple jobs.</span></div>
    </div></div></section>

    <div class="sec g3">
      <div class="card"><header><div><div class="ttl">1 · Toast sales — automatic</div></div></header>
        <div class="body" style="font-size:13.5px;line-height:1.65">Every morning around 6 AM the previous
        day's sales arrive from Toast by themselves. Nobody needs to do anything. If a morning is missed,
        <b>Update Dashboard</b> shows a Retry button.</div></div>
      <div class="card"><header><div><div class="ttl">2 · OpenTable file — after service</div></div></header>
        <div class="body" style="font-size:13.5px;line-height:1.65">Download the reservations file from
        OpenTable GuestCenter and upload it under <b>Update Dashboard</b>. It carries each table's recorded
        starting choice (Undecided, À la carte, or AYCE) so conversion can be measured. Uploading the same
        file twice is always safe.</div></div>
      <div class="card"><header><div><div class="ttl">3 · Food costs — occasional</div></div></header>
        <div class="body" style="font-size:13.5px;line-height:1.65">When the chef confirms item costs,
        a manager uploads the cost sheet under <b>Update Dashboard → Food Costs</b>. Until then numbers
        are marked provisional. Past days keep their old costs — history never changes.</div></div>
    </div>

    <div class="card sec"><header><div><div class="ttl">What the numbers mean — in plain language</div></div></header>
      <div class="body"><dl style="display:grid;grid-template-columns:auto 1fr;gap:10px 18px;font-size:13.5px;line-height:1.6">
        <dt style="font-weight:650;white-space:nowrap">AYCE food cost</dt>
        <dd>The estimated cost of AYCE food the kitchen sent out, divided by what guests paid for AYCE.
          Estimated from what was recorded in Toast — it is not an inventory count and says nothing about waste.</dd>
        <dt style="font-weight:650;white-space:nowrap">Usual food cost</dt>
        <dd>The same weekday and meal period over the previous ${DATA.ops.baseline.weeks} weeks. A Friday dinner is
          compared to recent Friday dinners, never to a Tuesday lunch.</dd>
        <dt style="font-weight:650;white-space:nowrap">Conversion</dt>
        <dd>Of the tables where the host recorded "Undecided" or "À la carte" and we could connect the visit to a
          Toast table, how many ended up ordering AYCE. Tables with no recorded choice are left out completely —
          they never help or hurt a server.</dd>
        <dt style="font-weight:650;white-space:nowrap">Fixes Needed</dt>
        <dd>The short list of visits that genuinely need a manager's call — a conflicting starting choice, a
          Half/Half table, or one likely table connection to confirm. Everything unclear is excluded automatically
          instead of becoming work.</dd>
        <dt style="font-weight:650;white-space:nowrap">Who can do what</dt>
        <dd>Shift leads: upload OpenTable files and resolve everyday fixes. Managers: everything, including food
          costs, Toast retries, and pilot-weekend or mixed-menu decisions. Sign-in is by emailed link — no passwords.</dd>
      </dl></div></div>

    <div class="sec">
      <div class="acc"><button type="button" aria-expanded="false" id="advDetTgl">
        Advanced Details — data &amp; methodology (for technical operators)<span class="ch">▶</span></button>
        <div class="ab" hidden id="advDetBody"></div></div>
    </div>`;

    const tgl = h.querySelector('#advDetTgl');
    const body = h.querySelector('#advDetBody');
    let filled = false;
    tgl.addEventListener('click', () => {
      const open = tgl.getAttribute('aria-expanded') === 'true';
      tgl.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      if (!filled) {
        filled = true;
        const mrow = (k, v) => `<tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px;white-space:nowrap;color:var(--text-3)">${esc(k)}</td><td style="text-align:left;padding:6px 8px">${v}</td></tr>`;
        const lastRun = DATA.ingestionRuns[0];
        const wrap = document.createElement('div');
        wrap.innerHTML = `
        <table class="tb" style="width:100%;font-size:12.5px;border-collapse:collapse;margin-bottom:14px"><tbody>
          ${mrow('Data source', DATA.source === 'supabase' ? 'Supabase Postgres (live database)' : 'Static fallback files (database unreachable)')}
          ${mrow('Toast dates loaded', `${dates.length} business dates: ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}; last sync ${esc(String(DATA.manifest?.lastToastSync ?? '—'))}`)}
          ${mrow('Last update run', lastRun ? `${esc(lastRun.runId ?? '')} · ${esc(lastRun.status ?? '')}${lastRun.error ? ' · ' + esc(lastRun.error) : ''}` : '—')}
          ${mrow('Included areas', Object.values(DATA.ops.includedAreas.serviceAreaGuids).join(', ') + ' — bar, takeout, delivery and non-table revenue excluded')}
          ${mrow('Service periods', `Lunch: opened before ${DATA.ops.servicePeriods.lunchBeforeHour - 12}:00 PM ${DATA.ops.servicePeriods.timezone}; Dinner: after. Configurable in config/operations.json.`)}
          ${mrow('Baseline', `Same weekday + same service period, previous ${DATA.ops.baseline.weeks} weeks, weighted dollars (Σcost ÷ Σrevenue). Never its own baseline; partial availability disclosed.`)}
          ${mrow('OpenTable records', `${DATA.intents.length} sanitized visits (no guest PII stored) · ${conv.eligible} eligible · ${conv.unknown} unknown · ${conv.review} conflicting · ${conv.mixed} mixed-menu · ${conv.ambiguous} ambiguous excluded · ${tri.badge} actionable`)}
          ${mrow('Recent imports', (DATA.importRuns ?? []).slice(0, 5).map((r) => `${esc(r.kind)} · ${esc(String(r.created_at ?? '').slice(0, 16))} · ${esc(r.status)}${r.counts?.inserted != null ? ` · ${r.counts.inserted} new` : ''}`).join('<br>') || '—')}
          ${mrow('Commission', `Pilot rates $5/$7.50/$10 per converted COVER, active ${fmtDate(DATA.ops.commission.activeFrom)}–${fmtDate(DATA.ops.commission.activeTo)} only. Program inactive — no new accrual.`)}
          ${mrow('Access model', 'The passcode screen is a presentation gate, not authentication. Writes require Supabase Auth (magic link) + role checks in security-definer database functions. Service credentials never reach the browser.')}
          ${mrow('CLI fallback', 'Administrator command-line tools remain in scripts/ (see docs/TECHNICAL_RUNBOOK.md). Managers never need them.')}
        </tbody></table>
        <div id="legacyMethod"></div>`;
        body.appendChild(wrap);
        try { LEGACY.method.fn(wrap.querySelector('#legacyMethod')); } catch { /* legacy content optional */ }
      }
    });
  });
}

/* ---------------------------------------------------------- registration --- */
let LEGACY = null;
function registerPages() {
  LEGACY = { ...PAGES };
  for (const k of Object.keys(PAGES)) delete PAGES[k];
  PAGES.ops = { label: 'Overview', icon: '◈', fn: pgOps, title: 'Operations overview', group: 'Operations' };
  PAGES.servers = { label: 'Server Performance', icon: '◑', fn: pgServersLive, title: 'Server performance', group: 'Operations' };
  PAGES.foodcost = { label: 'AYCE Food Cost', icon: '◐', fn: pgFoodCost, title: 'AYCE food cost', group: 'Operations' };
  PAGES.update = { label: 'Update Dashboard', icon: '⬆', fn: (h) => withData(h, pgUpdate), title: 'Update Dashboard', group: 'Operations' };
  PAGES.fixes = { label: 'Fixes Needed', icon: '▣', fn: (h) => withData(h, pgFixes), title: 'Fixes Needed', group: 'Operations', badge: 0 };
  PAGES.pilot = { label: 'Pilot Review', icon: '◆', fn: pgPilot, title: 'Pilot Review', group: 'Historical', pilotFilters: true };
  PAGES.help = { label: 'How This Works', icon: '◇', fn: pgHelp, title: 'How This Works', group: 'Help' };

  // stale saved pages from earlier versions → nearest new home
  const remap = { overview: 'pilot', commission: 'pilot', method: 'help', review: 'fixes', import: 'update' };
  if (remap[S.page]) S.page = remap[S.page];
  if (!PAGES[S.page]) S.page = 'ops';
}
registerPages();

const CTX = {
  APP, DATA, helpers, fmtDate, opDates,
  reload: reloadLive,
  // background data refresh: updates badge + freshness but leaves the current
  // page DOM alone (so upload success messages stay readable)
  refreshData: () => { DATA.loading = null; DATA.loaded = false; return loadLive(); },
  loadLive,
};
initUpdatePage(CTX);
initFixesPage(CTX);
configReady.then((cfg) => initManagerMode(APP, cfg));
loadLive();
