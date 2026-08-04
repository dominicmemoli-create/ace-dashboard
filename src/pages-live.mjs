/* =============================================================================
   Live operations pages — Operations Overview, AYCE Food Cost, Review Queue,
   Data Import — plus Pilot Review relabeling of the frozen pilot pages.

   Data architecture:
   - ace_metrics / ace_item_metrics (Supabase) carry per-(date × service period
     × server) AYCE-only aggregates so the browser never downloads 30+ days of
     raw selections. Static data/live/metrics.json is the fallback.
   - ace_intents carries the PII-stripped OpenTable records with match status
     and conversion facts.
   - The frozen pilot payload keeps powering the Pilot Review pages untouched.

   Honesty rules:
   - Food cost = ESTIMATED AYCE consumption recorded in Toast. Not inventory,
     not waste. Unrecorded refills are not estimated.
   - Costs remain labeled PROVISIONAL until chef-confirmed.
   - Baselines disclose exactly which comparable dates were available.
   - Commission: pilot ledger preserved; "Program inactive" after Aug 2, 2026.
   ========================================================================== */
import {
  comparableBaselineDates, weekdayOf, DEFAULT_THRESHOLDS,
} from './food-cost-engine.mjs';

const APP = window.__ACE_APP__;
if (!APP) throw new Error('pages-live: legacy shell did not expose __ACE_APP__');
const { PAGES, S, SRV, helpers } = APP;
const { $, esc, fmt, pct, usd, usd0, sgn } = helpers;

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ------------------------------------------------------------ data layer -- */
const DATA = {
  loaded: false, loading: null, error: null, source: null,
  ops: null,            // config/operations.json
  metrics: [],          // period/server aggregate rows
  items: [],            // per-item aggregates
  intents: [],          // sanitized OpenTable records
  costs: [], reference: null, manifest: null,
  pilotSelections: [], pilotChecks: [],   // static pilot raw (drilldown)
};

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

function loadLive() {
  if (DATA.loading) return DATA.loading;
  DATA.loading = (async () => {
    try {
      DATA.ops = await fetchJson('config/operations.json');
      let cfg = null;
      try { cfg = await fetchJson('data/supabase_config.json'); } catch { /* static mode */ }
      let db = false;
      if (cfg?.url && cfg?.anonKey) {
        try {
          const [man, ref, costs, metrics, items, intents] = await Promise.all([
            sbRows(cfg, 'ace_manifest', '*'),
            sbRows(cfg, 'ace_reference', 'payload'),
            sbRows(cfg, 'ace_item_costs', 'payload'),
            sbRows(cfg, 'ace_metrics', 'payload'),
            sbRows(cfg, 'ace_item_metrics', 'payload'),
            sbRows(cfg, 'ace_intents', 'payload'),
          ]);
          if (!metrics.length) throw new Error('ace_metrics empty');
          DATA.manifest = { restaurantGuid: man[0]?.restaurant_guid, dates: man[0]?.dates ?? [], lastToastSync: man[0]?.last_toast_sync };
          DATA.reference = ref[0]?.payload;
          DATA.costs = costs.map((r) => r.payload);
          DATA.metrics = metrics.map((r) => r.payload);
          DATA.items = items.map((r) => r.payload);
          DATA.intents = intents.map((r) => r.payload);
          DATA.source = 'supabase';
          db = true;
        } catch (e) { console.warn('Supabase unavailable → static fallback:', e?.message); }
      }
      if (!db) {
        DATA.manifest = await fetchJson('data/live/manifest.json');
        DATA.reference = await fetchJson('data/live/reference.json');
        DATA.costs = await fetchJson('data/live/item_costs.json');
        const m = await fetchJson('data/live/metrics.json');
        DATA.metrics = m.rows; DATA.items = m.items;
        DATA.intents = []; // OpenTable records live in the database only
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
    } catch (err) {
      DATA.error = String(err?.message ?? err);
    }
  })();
  return DATA.loading;
}

function opDates() {
  return [...new Set(DATA.metrics.filter((r) => !r.serverGuid).map((r) => r.businessDate))].sort();
}

/* -------------------------------------------------------- ops date state -- */
const OPS_KEY = 'ace.opsRange';
function opsState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(OPS_KEY) || '{}'); } catch { /* defaults */ }
  return { preset: 'pilot', from: null, to: null, period: 'all', ...s };
}
function saveOpsState(next) { localStorage.setItem(OPS_KEY, JSON.stringify(next)); }

/** Resolve the selected preset to concrete YYYYMMDD dates (dynamic — derived
 * from available business dates, no hard-coded ranges). */
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
  el.textContent = `${DATA.source === 'supabase' ? 'Supabase DB' : 'Static data'} · through ${fmtDate(last)}${staleDays > 1 ? ` · STALE (${staleDays}d old)` : ''}`;
  el.style.color = staleDays > 1 ? 'var(--neg, #e0705c)' : '';
  el.title = DATA.source === 'supabase'
    ? 'Live from Supabase Postgres. Toast data via the scheduled/manual ingestion pipeline.'
    : 'Static fallback files — database unreachable from this page load.';
}
function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd ?? '');
  return s.length === 8 ? `${s.slice(4, 6)}/${s.slice(6, 8)}` : '—';
}

/* --------------------------------------------------------- shared header --- */
function opsControls(state, onchange) {
  const presets = [
    ['pilot', 'Pilot weekend'], ['yesterday', 'Latest day'], ['week', 'Current week'],
    ['prevweek', 'Previous week'], ['month', 'Current month'], ['prevmonth', 'Previous month'], ['custom', 'Custom'],
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
    <span class="sub" style="margin-left:auto">Toast dates: ${fmtDate(avail[0])}–${fmtDate(avail[avail.length - 1])} (${avail.length})</span>
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

/* ==================================================== OPERATIONS OVERVIEW == */
function pgOps(host) {
  host.innerHTML = '<div class="skel skel-hero"></div>';
  loadLive().then(() => {
    if (DATA.error) { host.innerHTML = `<div class="errbox"><b>Data unavailable.</b> ${esc(DATA.error)}</div>`; return; }
    renderOps(host);
  });
}
function renderOps(host) {
  const state = opsState();
  const range = resolveRange(state);
  const periods = periodsOf(state);
  const t = sumMetrics(range.dates, periods);
  const fc = fcPctOf(t);
  const base = baselineFor(range.dates, periods);
  const conv = conversionStatsFor(range.dates);
  const C = DATA.ops.commission;

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
      <div class="hero-line"><b>${fmt(t.checks)}</b> floor/patio checks · <b>${usd0(t.floorNet)}</b> net floor sales ·
        <b>${usd0(t.entitlementNet)}</b> AYCE entitlement revenue on <b>${fmt(t.ayceChecks)}</b> AYCE checks.</div>
    </div>
    <div class="hero-rail">
      <div class="hr-cell"><div class="k">AYCE food cost (est.)</div><div class="v">${pct(fc)}</div>
        <div class="m">baseline ${pct(base.pct)} · ${base.found}/${base.requested} comparables</div></div>
      <div class="hr-cell"><div class="k">Conversion rate</div><div class="v">${pct(conv.rate)}</div>
        <div class="m">${conv.converted} of ${conv.eligible} eligible tables${conv.total === 0 ? ' · no OpenTable data in range' : ''}</div></div>
      <div class="hr-cell"><div class="k">Unknown / excluded intent</div><div class="v">${fmt(conv.unknown + conv.review + conv.mixed)}</div>
        <div class="m">${conv.unknown} unknown · ${conv.review} review · ${conv.mixed} mixed-menu</div></div>
      <div class="hr-cell"><div class="k">Commission</div><div class="v" style="font-size:16px">Program inactive</div>
        <div class="m">pilot ledger (${fmtDate(C.activeFrom)}–${fmtDate(C.activeTo)}) preserved in Pilot Review</div></div>
    </div>
  </div>
  <div class="hero-summary"><div class="sh">Scope</div>
    <p>Dining-room and patio tables only — bar, takeout, delivery and non-table revenue are excluded.
    AYCE food cost is <b>estimated from items recorded in Toast; it measures recorded consumption,
    not physical inventory usage or kitchen waste</b>. Conversion counts only tables with an explicit
    host-recorded intent; unknown or conflicting intent never helps or hurts anyone.</p></div>
  </section>`;
  host.appendChild(div);

  // by-day table
  const rows = range.dates.map((d) => {
    const a = sumMetrics([d], periods);
    return { d, ...a, fc: fcPctOf(a) };
  });
  const tbl = document.createElement('div');
  tbl.className = 'card sec';
  tbl.innerHTML = `<header><div><div class="ttl">By day</div>
    <div class="sub">${periods.join(' + ')} · AYCE program figures per business date.</div></div></header>
    <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
    <thead><tr><th>Date</th><th>Day</th><th>Checks</th><th>Guests</th><th>Floor net</th>
      <th>AYCE covers</th><th>AYCE revenue</th><th>Est. round cost</th><th>AYCE FC%</th></tr></thead><tbody>
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
    if (r.mixedMenuException) { st.mixed++; continue; }
    if (r.intent === 'REVIEW_REQUIRED') { st.review++; continue; }
    if (r.intent === 'UNKNOWN') { st.unknown++; continue; }
    if (r.intent === 'PREDECIDED_AYCE') { st.predecided++; continue; }
    if (r.matchStatus === 'ambiguous') { st.ambiguous++; continue; } // never counts either way
    if (r.matchStatus !== 'matched') { st.unknown++; continue; }     // unmatched can't prove conversion
    st.eligible++;
    if (r.hasAyceSales) st.converted++;
  }
  st.rate = st.eligible > 0 ? (st.converted / st.eligible) * 100 : null;
  return st;
}

/* ========================================================= AYCE FOOD COST == */
const FC_KEY = 'ace.fcSettings';
function fcSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(FC_KEY) || '{}'); } catch { /* defaults */ }
  return { ...DEFAULT_THRESHOLDS, ...s };
}
function pgFoodCost(host) {
  host.innerHTML = '<div class="skel skel-hero"></div>';
  loadLive().then(() => {
    if (DATA.error) { host.innerHTML = `<div class="errbox"><b>Data unavailable.</b> ${esc(DATA.error)}</div>`; return; }
    renderFoodCost(host);
  });
}
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
  const emp = new Map((DATA.reference?.employees ?? []).map((e) => [e.guid, e.name]));

  host.innerHTML = '';
  host.appendChild(opsControls(state, () => renderFoodCost(host)));

  const hero = document.createElement('div');
  hero.innerHTML = `
  <section class="hero rise"><div class="hero-top">
    <div class="hero-verdict">
      <div class="hero-eyebrow">AYCE food cost — ${esc(range.label)}
        <span class="verdict-badge ${roughShare > 0 ? 'neu' : 'pos'}">${roughShare > 0 ? 'PROVISIONAL — rough management estimate' : 'CHEF-CONFIRMED'}</span></div>
      <div class="hero-delta"><span class="big">${pct(scopePct)}</span>
        <span class="unit">est. AYCE round cost ÷<br>net AYCE entitlement revenue</span></div>
      <div class="hero-line"><b>${usd0(t.roundCost)}</b> estimated cost of recorded AYCE rounds ·
        <b>${usd0(t.entitlementNet)}</b> entitlement revenue · <b>${fmt(Math.round(t.entitlementCovers))}</b> covers
        (${usd(t.entitlementCovers ? t.roundCost / t.entitlementCovers : null)} / cover vs
        ${usd(t.entitlementCovers ? t.entitlementNet / t.entitlementCovers : null)} collected).</div>
    </div>
    <div class="hero-rail">
      <div class="hr-cell"><div class="k">4-week comparable baseline</div><div class="v">${pct(base.pct)}</div>
        <div class="m">${base.found} of ${base.requested} same weekday+period comparables</div></div>
      <div class="hr-cell"><div class="k">Variance</div>
        <div class="v ${variance != null && variance >= th.watchPts ? 'down' : ''}">${variance == null ? '—' : sgn(variance) + ' pts'}</div>
        <div class="m">watch ≥ +${th.watchPts} · critical ≥ +${th.criticalPts}</div></div>
      <div class="hr-cell"><div class="k">Round coverage (qty)</div><div class="v">${pct(qtyCov)}</div>
        <div class="m">of round quantity has a costed item</div></div>
      <div class="hr-cell"><div class="k">Provisional cost share</div><div class="v">${pct(roughShare, 0)}</div>
        <div class="m">of cost dollars from the rough workbook</div></div>
    </div>
  </div>
  <div class="hero-summary"><div class="sh">Definition</div>
    <p><b>Estimated AYCE food cost based on items recorded in Toast. This measures recorded consumption,
    not physical inventory usage or kitchen waste.</b> Unrecorded refills cannot be measured and are not
    estimated. Baseline: the same weekday and service period across the previous
    ${DATA.ops.baseline.weeks} weeks, weighted by dollars (Σcost ÷ Σrevenue — never an average of
    server percentages). Baseline dates used: ${base.dates.length ? base.dates.map(fmtDate).join(', ') : 'none available'}.
    Dining room + patio tables only.</p></div>
  </section>`;
  host.appendChild(hero);

  // server table
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
    return { name: emp.get(guid) ?? '(unattributed)', a, p, cov, status, variance: p != null && base.pct != null ? p - base.pct : null };
  }).sort((x, y) => y.a.entitlementNet - x.a.entitlementNet);

  const tbl = document.createElement('div');
  tbl.className = 'card sec';
  tbl.innerHTML = `<header><div><div class="ttl">Server comparison — AYCE program only</div>
    <div class="sub">Attribution: final Toast order owner. Flags suppress below ${th.minChecks} AYCE checks,
    ${usd0(th.minNetFoodSales)} entitlement revenue, or ${th.minCoveragePct}% cost coverage.</div></div></header>
    <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
    <thead><tr><th style="text-align:left">Server</th><th>AYCE checks</th><th>AYCE covers</th>
      <th>Entitlement rev</th><th>Est. round cost</th><th>AYCE FC%</th><th>Baseline</th><th>Variance</th><th>Coverage</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => `<tr style="border-top:1px solid var(--border-2)">
      <td style="text-align:left;padding:6px 8px;white-space:nowrap">${esc(r.name)}</td>
      <td style="text-align:right">${fmt(r.a.checks)}</td>
      <td style="text-align:right">${fmt(Math.round(r.a.entitlementCovers))}</td>
      <td style="text-align:right">${usd0(r.a.entitlementNet)}</td>
      <td style="text-align:right">${usd0(r.a.roundCost)}</td>
      <td style="text-align:right"><b>${pct(r.p)}</b></td>
      <td style="text-align:right">${pct(base.pct)}</td>
      <td style="text-align:right">${r.variance == null ? '—' : sgn(r.variance)}</td>
      <td style="text-align:right">${pct(r.cov, 0)}</td>
      <td style="text-align:center">${statusBadge(r.status)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="foot">This table never implies a server caused kitchen waste — it reflects what was rung for their AYCE tables.</div>`;
  host.appendChild(tbl);

  // item drivers + unmatched (from item metrics)
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
    <div class="card"><header><div><div class="ttl">Highest-cost AYCE round drivers</div></div></header>
      <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th style="text-align:left">Item</th><th>Qty</th><th>Est. cost</th><th>Cost source</th></tr></thead><tbody>
      ${drivers.map((d) => `<tr style="border-top:1px solid var(--border-2)">
        <td style="text-align:left;padding:4px 8px">${esc(d.name)}</td>
        <td style="text-align:right">${fmt(Math.round(d.qty))}</td>
        <td style="text-align:right"><b>${usd0(d.cost)}</b></td>
        <td style="text-align:center">${d.source === 'rough_workbook' ? '<span class="verdict-badge neu">PROVISIONAL</span>' : '<span class="verdict-badge pos">confirmed</span>'}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="card"><header><div><div class="ttl">Uncosted rounds — chef punch list (${unmatched.length ? 'top ' + unmatched.length : 'clear'})</div>
      <div class="sub">Excluded from cost dollars (never $0) — the true % is understated until costed.</div></div></header>
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
    insufficient_sample: ['', 'Sample'], insufficient_coverage: ['', 'Coverage'], no_baseline: ['', '—'],
  };
  const [cls, label] = map[status] ?? ['', status];
  return `<span class="verdict-badge ${cls}">${label}</span>`;
}

/* ============================================================ REVIEW QUEUE == */
function pgReview(host) {
  host.innerHTML = '<div class="skel skel-hero"></div>';
  loadLive().then(() => renderReview(host));
}
function renderReview(host) {
  const items = [];
  for (const r of DATA.intents) {
    if (r.mixedMenuException) items.push({ kind: 'MIXED_MENU_EXCEPTION', r, why: `Half/Half tag — table ${r.tableTokens.join(',')}` });
    if (r.intent === 'REVIEW_REQUIRED') items.push({ kind: 'CONFLICTING_INTENT', r, why: `tags: ${r.relevantTags.join(' + ')}` });
    if (r.matchStatus === 'ambiguous') items.push({ kind: 'AMBIGUOUS_MATCH', r, why: `confidence ${r.matchConfidence} — table ${r.tableTokens.join(',')}` });
    if (r.matchStatus === 'unmatched') items.push({ kind: 'UNMATCHED_VISIT', r, why: `no Toast visit found — table ${r.tableTokens.join(',') || '?'}` });
  }
  const corrections = JSON.parse(localStorage.getItem('ace.corrections') || '[]');

  host.innerHTML = `
  <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
    <div class="hero-eyebrow">Management review queue</div>
    <div class="hero-delta"><span class="big">${items.length}</span><span class="unit">items need a human decision<br>none of them affect conversion or commission until resolved</span></div>
    <div class="hero-line">Conflicting intents, Half/Half policy exceptions, ambiguous OpenTable matches and
      unmatched visits. Corrections drafted here are saved on this device and exported for a manager to apply
      with the import tools — <b>this screen does not write to the shared database</b> (management
      authentication comes first).</div>
  </div></div></section>
  <div class="card sec"><div class="body" style="overflow-x:auto">
    <table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
    <thead><tr><th style="text-align:left">Type</th><th>Date</th><th>Table</th><th>Party</th><th>Time</th>
      <th style="text-align:left">Detail</th><th>Correction</th></tr></thead><tbody>
    ${items.map((it, i) => `<tr style="border-top:1px solid var(--border-2)">
      <td style="text-align:left;padding:5px 8px"><span class="verdict-badge ${it.kind === 'MIXED_MENU_EXCEPTION' ? 'neu' : ''}">${it.kind.replaceAll('_', ' ')}</span></td>
      <td>${fmtDate(it.r.businessDate)}</td><td>${esc(it.r.tableTokens.join(','))}</td>
      <td style="text-align:right">${fmt(it.r.partySize)}</td><td>${esc(it.r.visitTime ?? '')}</td>
      <td style="text-align:left">${esc(it.why)}</td>
      <td style="text-align:center"><button type="button" class="themebtn" data-fix="${i}" style="font-size:12px">Draft fix</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="foot">${corrections.length} correction(s) drafted on this device ·
      <a href="#" id="dlCorrections">download corrections file</a> · apply with
      <code>node scripts/apply-corrections.mjs corrections.json</code></div></div>`;

  host.querySelectorAll('button[data-fix]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = items[Number(btn.dataset.fix)];
      const corrected = prompt(
        `Correction for ${it.kind} (${fmtDate(it.r.businessDate)} table ${it.r.tableTokens.join(',')}).\n` +
        `Enter corrected intent (UNDECIDED / ALC / PREDECIDED_AYCE / EXCLUDE):`, '');
      if (!corrected) return;
      const reason = prompt('Reason (required for the audit trail):', '');
      if (!reason) return;
      const user = prompt('Your name (MOD/shift lead):', '');
      if (!user) return;
      const rec = {
        rowHash: it.r.rowHash, kind: it.kind,
        original: { intent: it.r.intent, matchStatus: it.r.matchStatus, matchedOrderGuid: it.r.matchedOrderGuid },
        corrected: corrected.trim().toUpperCase(), reason, user, at: new Date().toISOString(),
      };
      const cur = JSON.parse(localStorage.getItem('ace.corrections') || '[]');
      cur.push(rec);
      localStorage.setItem('ace.corrections', JSON.stringify(cur));
      renderReview(host);
    });
  });
  host.querySelector('#dlCorrections')?.addEventListener('click', (e) => {
    e.preventDefault();
    const blob = new Blob([localStorage.getItem('ace.corrections') || '[]'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'corrections.json'; a.click();
  });
}

/* ============================================================ DATA IMPORT === */
function pgImport(host) {
  loadLive().then(() => {
    host.innerHTML = `
    <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
      <div class="hero-eyebrow">Data import</div>
      <div class="hero-delta"><span class="big">Import paths</span>
        <span class="unit">shared imports run via protected CLI tools;<br>this page validates files before you run them</span></div>
      <div class="hero-line">The shared dashboard database is updated only by the protected import commands
        below (service credentials never reach this browser). Drop a file here to <b>validate and preview</b>
        it first.</div>
    </div></div></section>
    <div class="card sec"><header><div><div class="ttl">Shared import commands (operator machine)</div></div></header>
      <div class="body"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse"><tbody>
        <tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px;white-space:nowrap"><code>npm run ingest:toast -- YYYYMMDD</code></td>
          <td style="text-align:left">Pull a business date from the Toast API → normalize → Supabase (also runs nightly at ~6 AM ET)</td></tr>
        <tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px"><code>npm run import:opentable -- file.csv</code></td>
          <td style="text-align:left">GuestCenter export → PII-stripped intents + Toast matching → Supabase (idempotent)</td></tr>
        <tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px"><code>npm run import:costs -- --csv chef.csv --source chef_confirmed</code></td>
          <td style="text-align:left">Chef cost sheet (CSV/XLSX) → effective-dated cost master → rebuild metrics → Supabase</td></tr>
        <tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px"><code>npm run build:metrics</code></td>
          <td style="text-align:left">Recompute all period aggregates after any cost change</td></tr>
      </tbody></table></div></div>
    <div class="card sec"><header><div><div class="ttl">Validate a file (preview only — nothing is written)</div></div></header>
      <div class="body">
        <div id="dropzone" style="border:2px dashed var(--border-2);border-radius:14px;padding:32px;text-align:center;cursor:pointer">
          <div style="font-size:15px;font-weight:600">Drop a CSV here to validate</div>
          <div class="sub" style="margin-top:6px">Chef cost CSV · OpenTable GuestCenter export</div>
          <input id="fileInput" type="file" accept=".csv" style="display:none">
        </div>
        <div id="importStage"></div>
      </div>
      <div class="foot">This browser preview never updates the shared dashboard — that requires the protected commands above.</div></div>`;
    const dz = host.querySelector('#dropzone');
    const fi = host.querySelector('#fileInput');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.style.borderColor = 'var(--accent)'; });
    dz.addEventListener('dragleave', () => { dz.style.borderColor = 'var(--border-2)'; });
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.style.borderColor = 'var(--border-2)'; if (e.dataTransfer.files[0]) validateFile(e.dataTransfer.files[0], host); });
    fi.addEventListener('change', () => { if (fi.files[0]) validateFile(fi.files[0], host); });
  });
}
function validateFile(file, host) {
  const stage = host.querySelector('#importStage');
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    const firstLine = text.split(/\r?\n/)[0]?.toLowerCase() ?? '';
    let kind, hint;
    if (firstLine.includes('canonical_name')) { kind = 'Chef cost CSV'; hint = 'npm run import:costs -- --csv "' + file.name + '" --source chef_confirmed'; }
    else if (firstLine.includes('visit date') && firstLine.includes('reservation tags')) { kind = 'OpenTable GuestCenter export'; hint = 'npm run import:opentable -- "' + file.name + '"'; }
    else { stage.innerHTML = '<div class="errbox">Unrecognized header. Expected a chef cost CSV (canonical_name,cost) or a GuestCenter export.</div>'; return; }
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).length - 1;
    stage.innerHTML = `<div class="sh" style="margin-top:14px">✓ Recognized as <b>${kind}</b> — ${rows} data rows.
      To apply to the shared dashboard, run:<br><code>${esc(hint)}</code></div>`;
  };
  reader.readAsText(file);
}

/* ================================================== METHODOLOGY ADDITIONS == */
const origMethod = PAGES.method.fn;
PAGES.method.fn = function (host) {
  origMethod(host);
  loadLive().then(() => {
    if (!DATA.manifest) return;
    const ops = DATA.ops;
    const dates = opDates();
    const conv = conversionStatsFor(dates);
    const div = document.createElement('div');
    div.className = 'card sec';
    const mrow = (k, v) => `<tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px;white-space:nowrap;color:var(--ink-3)">${esc(k)}</td><td style="text-align:left;padding:6px 8px">${v}</td></tr>`;
    div.innerHTML = `<header><div><div class="ttl">Operations data &amp; definitions</div></div></header>
      <div class="body"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse"><tbody>
      ${mrow('Data source', DATA.source === 'supabase' ? 'Supabase Postgres (live)' : 'Static fallback files')}
      ${mrow('Toast dates loaded', `${dates.length} business dates: ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`)}
      ${mrow('Included areas', Object.values(ops.includedAreas.serviceAreaGuids).join(', ') + ' — bar, takeout, delivery and non-table revenue excluded')}
      ${mrow('Service periods', `Lunch: opened before ${ops.servicePeriods.lunchBeforeHour - 12}:00 PM ${ops.servicePeriods.timezone}; Dinner: after. Configurable in config/operations.json (Toast exposes no reliable daypart field).`)}
      ${mrow('Food-cost baseline', `Same weekday + same service period, previous ${ops.baseline.weeks} weeks, weighted dollars (Σcost ÷ Σrevenue). The selected period is never its own baseline; partial availability is disclosed.`)}
      ${mrow('AYCE food cost', 'Estimated cost of recorded AYCE rounds ÷ net AYCE entitlement revenue. Measures recorded consumption, not inventory usage or waste. Unrecorded refills are not estimated.')}
      ${mrow('OpenTable intents', `${DATA.intents.length} sanitized visits (no guest PII stored) · ${conv.eligible} eligible · ${conv.unknown} unknown · ${conv.review} conflicting · ${conv.mixed} mixed-menu · ${conv.ambiguous} ambiguous matches excluded`)}
      ${mrow('Commission', `Pilot rates $5/$7.50/$10 per converted COVER, active ${fmtDate(ops.commission.activeFrom)}–${fmtDate(ops.commission.activeTo)} only. Program inactive — no new accrual until management sets a new effective date (config/operations.json).`)}
      ${mrow('Access model', 'The passcode screen is a presentation gate, not authentication. No payroll or sensitive employee data is stored in dashboard-readable tables.')}
      </tbody></table></div>`;
    host.appendChild(div);
  });
};

/* ---------------------------------------------------------- registration --- */
function registerPages() {
  const legacy = { ...PAGES };
  for (const k of Object.keys(PAGES)) delete PAGES[k];
  PAGES.ops = { label: 'Operations overview', icon: '◈', fn: pgOps, title: 'Operations overview' };
  PAGES.foodcost = { label: 'Food cost (AYCE)', icon: '◐', fn: pgFoodCost, title: 'AYCE food cost' };
  PAGES.review = { label: 'Review queue', icon: '▣', fn: pgReview, title: 'Management review queue' };
  PAGES.import = { label: 'Data import', icon: '⬆', fn: pgImport, title: 'Data import' };
  PAGES.overview = { ...legacy.overview, label: 'Pilot · Overview', title: 'Pilot Review — overview' };
  PAGES.servers = { ...legacy.servers, label: 'Pilot · Servers', title: 'Pilot Review — server performance' };
  PAGES.commission = { ...legacy.commission, label: 'Pilot · Commission', title: 'Pilot Review — commission ledger (program inactive)' };
  PAGES.method = { ...legacy.method, label: 'Data & methodology', title: 'Data & methodology' };
  if (!PAGES[S.page]) S.page = 'ops';
  if (S.page === 'overview' && !localStorage.getItem('ace.sawOps')) {
    S.page = 'ops';
    localStorage.setItem('ace.sawOps', '1');
  }
}
registerPages();
loadLive();
