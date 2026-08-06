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
   - ace_checks / ace_selections power the per-check drill-downs on demand
     (static per-date files are the backup).
   - The frozen pilot payload keeps powering Pilot Review untouched.

   Honesty rules:
   - Food cost = ESTIMATED AYCE consumption recorded in Toast. Not inventory,
     not waste. Unrecorded refills are not estimated.
   - Costs remain labeled provisional until chef-confirmed.
   - Visits without a recorded starting choice count in every operational
     figure (tables, covers, sales, food cost); ONLY conversion rates leave
     them out, where their rate is shown as unavailable — never as zero.
   - Commission: pilot ledger preserved; program inactive after Aug 2, 2026.
   ========================================================================== */
import {
  comparableBaselineDates, weekdayOf, DEFAULT_THRESHOLDS,
  computeFoodCost, filterAyceProgram, isIncludedCheck, servicePeriodOf,
  perCheckCostStats,
} from './food-cost-engine.mjs?v=20260806-v2';
import { resolveRange } from './date-range.mjs?v=20260806-v2';
import { toastVisits, scorePair } from './ot-matcher.mjs?v=20260806-v2';
import { triageIntents } from './triage.mjs?v=20260806-v2';
import { initManagerMode } from './manager-mode.mjs?v=20260806-v2';
import { hasConfig, browserKey } from './auth.mjs?v=20260806-v2';
import { initUpdatePage, pgUpdate } from './page-update.mjs?v=20260806-v2';
import { initFixesPage, pgFixes } from './page-fixes.mjs?v=20260806-v2';
import {
  panel, chartPanel, kpiBand, delta, linePlot, stackedBars, sparkline, drawPlots,
  skeletonOverview, plotEmpty, moneyK, segmented,
} from './ui.mjs?v=20260806-v2';
/* Importing the icon set here is what publishes it to the shell: index.html is
   a classic script and cannot import a module, so src/icons.mjs assigns
   window.ACE_ICON on load and the shell borrows it for its own chrome. */
import { icon } from './icons.mjs?v=20260806-v2';

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
};
let CFG = null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
// Stable pagination order per table — Range paging without ORDER BY lets
// PostgREST return pages in unspecified order, silently duplicating or
// skipping rows past the first 1000.
const PK_ORDER = {
  ace_metrics: 'unique_key', ace_item_metrics: 'unique_key', ace_intents: 'row_hash',
  ace_item_costs: 'id', ace_item_costs_public: 'id',
  ace_checks: 'check_guid', ace_selections: 'selection_guid',
};
async function sbRows(cfg, table, select, filter = '') {
  const out = [];
  const order = !/[&?]order=/.test(filter) && PK_ORDER[table] ? `&order=${PK_ORDER[table]}` : '';
  for (let from = 0; ; from += 1000) {
    const key = browserKey(cfg);
    const res = await fetch(`${cfg.url}/rest/v1/${table}?select=${select}${filter}${order}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` },
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
      if (hasConfig(cfg)) {
        try {
          // Public dashboard reads go through the sanitized views: identical
          // numbers, without operator emails or uploaded file names. Manager
          // flows read the base tables with a signed-in token (see auth.mjs).
          const [man, ref, costs, metrics, items, intents, imports, ing] = await Promise.all([
            sbRows(cfg, 'ace_manifest', '*'),
            sbRows(cfg, 'ace_reference', 'payload'),
            sbRows(cfg, 'ace_item_costs_public', 'payload'),
            sbRows(cfg, 'ace_metrics', 'payload'),
            sbRows(cfg, 'ace_item_metrics', 'payload'),
            sbRows(cfg, 'ace_intents', 'payload'),
            sbRows(cfg, 'ace_import_runs_public', 'kind,counts,status,error,created_at', '&order=created_at.desc&limit=40'),
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
      DATA.loaded = true;
      await reverifyStoredMatches();
      renderFreshness();
      refreshBadge();
    } catch (err) {
      DATA.error = String(err?.message ?? err);
    }
  })();
  return DATA.loading;
}

/**
 * Re-verify STORED match connections against the CURRENT matching rules
 * (time window, table overlap, party compatibility, area, candidate
 * exclusions — one scorePair call covers all of them). Rows imported under
 * the old, wider rules can carry connections today's rules would never make:
 *   - ambiguous suggestions → marked staleSuggestion (auto-excluded, no card)
 *   - automatic 'matched' rows → marked staleSuggestion too, so they leave
 *     conversion without creating new work for a visitor.
 * Manual connections and confirmed decisions are never touched, and the
 * stored rows themselves are untouched — this is an in-memory annotation.
 */
async function reverifyStoredMatches() {
  const ops = DATA.ops;
  const cfg = { ...ops.opentableMatch, timezone: ops.servicePeriods.timezone };
  const pending = DATA.intents.filter((r) =>
    (r.matchStatus === 'ambiguous' || r.matchStatus === 'matched')
    && r.matchedOrderGuid && !r.matchEvidence && r.matchMethod !== 'manual'
    && !r.excluded && r.reviewStatus !== 'confirmed');
  if (!pending.length) return;
  const opsFilter = (c) =>
    (c.serviceAreaGuid && c.serviceAreaGuid in ops.includedAreas.serviceAreaGuids) ||
    (!c.serviceAreaGuid && c.revenueCenterGuid in ops.includedAreas.revenueCenterGuids);
  const areaOf = (c) => {
    const n = (c.serviceAreaGuid && ops.includedAreas.serviceAreaGuids[c.serviceAreaGuid])
      || (c.revenueCenterGuid && ops.includedAreas.revenueCenterGuids[c.revenueCenterGuid]) || null;
    return n ? (/patio/i.test(n) ? 'patio' : 'dining') : null;
  };
  for (const d of [...new Set(pending.map((r) => r.businessDate))]) {
    let detail = null;
    try { detail = await fetchDetail(d); } catch { /* leave rows as-is */ }
    if (!detail) continue;
    const valid = new Map(toastVisits(detail.checks, DATA.reference, opsFilter, { areaOf }).map((v) => [v.orderGuid, v]));
    for (const r of pending.filter((x) => x.businessDate === d)) {
      const v = valid.get(r.matchedOrderGuid);
      const s = v ? scorePair(r, v, cfg) : null;   // null → fails the current rules
      if (s) { r.matchEvidence = s.evidence; continue; }   // still sound — keep, with fresh evidence
      r.matchStatus = 'ambiguous';                 // out of conversion
      r.matchEvidence = null;
      r.staleSuggestion = true;                    // no active card; current rules reject it
    }
  }
}

function reloadLive() {
  DATA.loading = null;
  DATA.loaded = false;
  detailCache.clear();
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

/* ---------------------------------------------- per-date raw detail cache -- */
const detailCache = new Map(); // businessDate -> Promise<{checks, selections}|null>
function fetchDetail(date) {
  if (detailCache.has(date)) return detailCache.get(date);
  const p = (async () => {
    if (DATA.source === 'supabase' && CFG) {
      try {
        const [checks, selections] = await Promise.all([
          sbRows(CFG, 'ace_checks', 'payload', `&business_date=eq.${date}`),
          sbRows(CFG, 'ace_selections', 'payload', `&business_date=eq.${date}`),
        ]);
        return { checks: checks.map((r) => r.payload), selections: selections.map((r) => r.payload) };
      } catch { /* fall through to static */ }
    }
    try {
      const [checks, selections] = await Promise.all([
        fetchJson(`data/live/checks_${date}.json`),
        fetchJson(`data/live/selections_${date}.json`),
      ]);
      return { checks, selections };
    } catch { return null; }
  })();
  detailCache.set(date, p);
  return p;
}

/**
 * Per-check AYCE detail for a range — the drill-down dataset. Every number
 * comes from the same canonical pipeline as the headline (filterAyceProgram →
 * computeFoodCost). Returns { checks: [...], missingDates: [...] }.
 */
async function rangeDetail(dates, periods) {
  const tbl = new Map((DATA.reference?.tables ?? []).map((t) => [t.guid, String(t.name).toUpperCase()]));
  const intentByOrder = new Map();
  for (const r of DATA.intents) {
    // only reliable connections attribute a recorded intent to a check —
    // ambiguous suggestions stay "Unknown" until a person confirms them
    if (r.matchStatus === 'matched' && r.matchedOrderGuid && !r.excluded && !r.staleSuggestion) intentByOrder.set(r.matchedOrderGuid, r);
  }
  const out = [];
  const missingDates = [];
  for (const d of dates) {
    const detail = await fetchDetail(d);
    if (!detail) { missingDates.push(d); continue; }
    const inScope = detail.checks.filter((c) => isIncludedCheck(c, DATA.ops) && periods.includes(servicePeriodOf(c, DATA.ops)));
    if (!inScope.length) continue;
    const guids = new Set(inScope.map((c) => c.checkGuid));
    const sels = detail.selections.filter((s) => guids.has(s.checkGuid));
    const ayce = filterAyceProgram(sels, inScope, DATA.reference);
    const fc = computeFoodCost(ayce.selections, ayce.checks, DATA.reference, DATA.costs);
    const checkByGuid = new Map(inScope.map((c) => [c.checkGuid, c]));
    for (const [checkGuid, b] of fc.perCheck.entries()) {
      const chk = checkByGuid.get(checkGuid);
      const entItems = b.items.filter((x) => x.cls === 'entitlement');
      const entNet = entItems.reduce((a, x) => a + x.net, 0);
      const entCovers = entItems.reduce((a, x) => a + x.qty, 0);
      const tierName = entItems.map((x) => x.name).find(Boolean) ?? null;
      const intentRec = intentByOrder.get(b.orderGuid) ?? null;
      out.push({
        businessDate: d,
        checkGuid,
        orderGuid: b.orderGuid,
        serverGuid: chk?.serverGuid ?? b.serverGuid,
        table: tbl.get(chk?.tableGuid ?? b.tableGuid) ?? '—',
        openedDate: chk?.openedDate ?? null,
        guests: chk?.numberOfGuests ?? 0,
        intent: intentRec ? (intentRec.intentEffective ?? intentRec.intent) : null,
        halfHalf: intentRec ? Boolean(intentRec.halfHalf || intentRec.mixedMenuException) : false,
        ayceTier: tierName,
        entitlementNet: entNet,
        entitlementCovers: entCovers,
        foodCostDollars: b.foodCostDollars,
        eligibleNetFoodRevenue: b.eligibleNetFoodRevenue,
        pctOfSales: b.eligibleNetFoodRevenue > 0 ? (b.foodCostDollars / b.eligibleNetFoodRevenue) * 100 : null,
        costPerCover: entCovers > 0 ? b.foodCostDollars / entCovers : null,
        itemQty: b.totalQty,
        matchedQty: b.matchedQty,
        items: b.items,
        excludedItems: b.excludedItems,
        unmatchedItems: b.unmatchedItems,
      });
    }
  }
  return { checks: out, missingDates };
}

/* -------------------------------------------------------- ops date state -- */
const OPS_KEY = 'ace.opsRange';
function opsState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(OPS_KEY) || '{}'); } catch { /* defaults */ }
  return { preset: 'week', from: null, to: null, period: 'all', ...s };
}
function saveOpsState(next) { localStorage.setItem(OPS_KEY, JSON.stringify(next)); }

function periodsOf(state) { return state.period === 'all' ? ['lunch', 'dinner'] : [state.period]; }

/* ------------------------------------------------------------ aggregation -- */
function sumMetrics(dates, periods, serverGuid = null) {
  const set = new Set(dates);
  const acc = { checks: 0, guests: 0, floorNet: 0, ayceChecks: 0, entitlementNet: 0, entitlementCovers: 0, roundCost: 0, matchedQty: 0, totalQty: 0, excludedModifierQty: 0, excludedDrinkQty: 0 };
  for (const r of DATA.metrics) {
    if ((r.serverGuid ?? null) !== serverGuid) continue;
    if (!set.has(r.businessDate) || !periods.includes(r.period)) continue;
    for (const k of Object.keys(acc)) acc[k] += r[k] ?? 0;
  }
  return acc;
}
function sumTiers(dates, periods) {
  const set = new Set(dates);
  const tiers = { confirmed: 0, override: 0, explicit_temp: 0, rough_estimate: 0, fallback_2: 0 };
  for (const r of DATA.metrics) {
    if (r.serverGuid || !set.has(r.businessDate) || !periods.includes(r.period) || !r.costByTier) continue;
    for (const k of Object.keys(tiers)) tiers[k] += r.costByTier[k] ?? 0;
  }
  return tiers;
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
// One consistent freshness component: what the dashboard covers, when Toast
// last synced, and when the last upload landed — all labeled ET.
function fmtEt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }) + ' ET';
  } catch { return '—'; }
}
function renderFreshness() {
  const bar = document.querySelector('#topbar .tb-meta') || document.querySelector('#topbar .tb-row');
  if (!bar || !DATA.manifest) return;
  let el = document.getElementById('freshness');
  if (!el) {
    el = document.createElement('span');
    el.id = 'freshness';
    bar.appendChild(el);
  }
  const dates = opDates();
  const last = dates[dates.length - 1];
  const otDates = [...new Set((DATA.intents ?? []).map((r) => r.businessDate))].sort();
  const otLast = otDates[otDates.length - 1] ?? null;
  const staleDays = Math.floor((Date.now() - Date.parse(`${last?.slice(0, 4)}-${last?.slice(4, 6)}-${last?.slice(6, 8)}T12:00:00-04:00`)) / 86400000);
  const lastImport = (DATA.importRuns ?? []).find((r) => r.status === 'success');
  const otBehind = !!(last && (!otLast || otLast < last));
  const needsUpdate = staleDays > 1 || otBehind;
  el.className = `prov${needsUpdate ? ' warn' : ''}`;
  el.textContent = `${DATA.source === 'supabase' ? 'Shared data' : 'Backup data'} · sales through ${fmtDate(last)} · OpenTable through ${fmtDate(otLast)}${needsUpdate ? ' · Update needed' : ''}`;
  el.title = [
    `Sales data through ${fmtDate(last)} (business date)`,
    `OpenTable data through ${fmtDate(otLast)} (business date)`,
    `Last Toast sync: ${fmtEt(DATA.manifest?.lastToastSync)}`,
    `Last upload: ${lastImport ? `${lastImport.kind} · ${fmtEt(lastImport.created_at)}` : 'none recorded'}`,
    DATA.source === 'supabase'
      ? 'Loading from the shared database; Toast refreshes automatically every morning (~6 AM ET).'
      : 'Showing saved backup data — the shared database was unreachable from this page load.',
  ].join('\n');
}
function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd ?? '');
  return s.length === 8 ? `${s.slice(4, 6)}/${s.slice(6, 8)}` : '—';
}

/* --------------------------------------------------------- shared header --- */
/**
 * Shared date-range + service-period control.
 *
 * `opts.variant === 'bar'` renders the ACE filter bar: the same controls and
 * the same resolved-range wording, presented as page chrome rather than as a
 * card of content. It is opt-in so pages adopt it as they are redesigned
 * instead of the app spending a release with two half-matching headers.
 */
/** Header provenance chip — where these figures came from, and how current. */
function setProvenance(text, tone = '') { APP.setProv?.(text, tone); }

function opsControls(state, onchange, opts = {}) {
  const presets = [
    ['yesterday', 'Latest day'], ['week', 'Current week'], ['prevweek', 'Previous week'],
    ['month', 'Current month'], ['prevmonth', 'Previous month'], ['pilot', 'Pilot weekend'], ['custom', 'Custom'],
  ];
  const avail = opDates();
  const range = resolveRange(state, avail);
  const bar = opts.variant === 'bar';

  const fields = `
    <label class="field"><span>Date range</span>
      <select class="ctl" id="opsPreset">
        ${presets.map(([v, l]) => `<option value="${v}" ${state.preset === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <label class="field" id="opsFromWrap" style="display:${state.preset === 'custom' ? 'flex' : 'none'}"><span>From</span>
      <select class="ctl" id="opsFrom">
        ${avail.map((d) => `<option value="${d}" ${state.from === d ? 'selected' : ''}>${fmtDate(d)}</option>`).join('')}
      </select></label>
    <label class="field" id="opsToWrap" style="display:${state.preset === 'custom' ? 'flex' : 'none'}"><span>To</span>
      <select class="ctl" id="opsTo">
        ${avail.map((d) => `<option value="${d}" ${(state.to ?? avail[avail.length - 1]) === d ? 'selected' : ''}>${fmtDate(d)}</option>`).join('')}
      </select></label>
    <div class="field"><span id="opsPeriodLbl">Service period</span>
      ${segmented({
    name: 'opsPeriod',
    value: state.period,
    label: 'Service period',
    options: [
      ['all', 'Lunch + dinner'],
      ['lunch', 'Lunch', `before ${DATA.ops.servicePeriods.lunchBeforeHour - 12} PM`],
      ['dinner', 'Dinner', `from ${DATA.ops.servicePeriods.lunchBeforeHour - 12} PM`],
    ],
  })}</div>
    <div class="rangenote sub" role="status">
      <span class="rn-1">Showing: <b>${esc(range.label)}</b>${range.invalid ? '' : ` · ${range.dates.length} day${range.dates.length === 1 ? '' : 's'}`}</span>
      <span class="rn-2">Available data: ${fmtDate(avail[0])}–${fmtDate(avail[avail.length - 1])} (${avail.length} days)</span>
    </div>`;

  const invalid = (style) => (range.invalid
    ? `<div class="errbox" role="alert"${style ? ` style="${style}"` : ''}><b>Check the custom range.</b>
    ${esc(range.invalid.message)} <button class="btn ghost sm" type="button" id="opsSwap" style="margin-left:8px">Swap dates</button></div>`
    : '');

  /* The resolved period also goes in the sticky header, where it stays visible
     after the filter bar has scrolled away. */
  const perEl = document.getElementById('pgperiod');
  if (perEl) perEl.textContent = range.invalid ? '' : range.label;
  setProvenance(`${DATA.source === 'supabase' ? 'Shared data' : 'Backup data'} through ${fmtDate(avail[avail.length - 1])}`,
    DATA.source === 'supabase' ? '' : 'warn');

  const el = document.createElement('div');
  if (bar) {
    el.className = 'fbar';
    el.innerHTML = `${fields}${invalid('')}`;
  } else {
    el.className = 'card';
    el.style.marginBottom = '14px';
    el.innerHTML = `<div class="body fieldrow">${fields}</div>
  ${invalid('margin:0 var(--sp-5) var(--sp-5)')}`;
  }
  const apply = () => {
    const next = {
      preset: el.querySelector('#opsPreset').value,
      from: el.querySelector('#opsFrom').value,
      to: el.querySelector('#opsTo').value,
      /* the service period is a radio group now; fall back to the state value
         so a missing checked input can never silently reset the filter */
      period: el.querySelector('input[name="opsPeriod"]:checked')?.value ?? state.period,
    };
    saveOpsState(next);
    onchange();
  };
  el.querySelector('#opsPreset').addEventListener('change', apply);
  el.querySelector('#opsFrom').addEventListener('change', apply);
  el.querySelector('#opsTo').addEventListener('change', apply);
  el.querySelector('[role="radiogroup"]')?.addEventListener('change', apply);
  el.querySelector('#opsSwap')?.addEventListener('click', () => {
    saveOpsState({ ...state, from: state.to, to: state.from });
    onchange();
  });
  return el;
}

function withData(host, renderFn, skeleton) {
  host.innerHTML = skeleton ?? '<div class="skel skel-hero" role="status" aria-label="Loading dashboard data"></div>';
  loadLive().then(() => {
    if (DATA.error) {
      host.innerHTML = `<div class="errbox"><b>The dashboard data could not load.</b>
        Check the internet connection and refresh the page. ${esc(DATA.error)}</div>`;
      return;
    }
    renderFn(host);
  });
}

/** Standard guard: invalid custom range renders the validation message and
 * nothing else — never an unexplained empty dashboard. */
function rangeOrExplain(host, state, renderFn, opts) {
  const range = resolveRange(state, opDates());
  host.innerHTML = '';
  host.appendChild(opsControls(state, () => renderFn(host), opts));
  return range.invalid ? null : range;
}

/* ==================================================== OPERATIONS OVERVIEW == */
function pgOps(host) { withData(host, renderOps, skeletonOverview()); }

/**
 * Operations overview.
 *
 * Ordered to answer, in this sequence: how are we performing, what changed,
 * where is it weak, what needs attention, what should I look at next. Every
 * figure below already existed on this page or is the same aggregate drawn per
 * day — no metric is introduced here.
 */
function renderOps(host) {
  const state = opsState();
  host.className = 'pg stack';
  const range = rangeOrExplain(host, state, renderOps, { variant: 'bar' });
  if (!range) return;
  const periods = periodsOf(state);
  const t = sumMetrics(range.dates, periods);
  const fc = fcPctOf(t);
  const base = baselineFor(range.dates, periods);
  const conv = conversionStatsFor(range.dates, periods);
  const triAll = triageIntents(DATA.intents);
  const tri = triageIntents(DATA.intents.filter((r) => range.dates.includes(r.businessDate)));

  const rows = range.dates.map((d) => {
    const a = sumMetrics([d], periods);
    return { d, ...a, fc: fcPctOf(a) };
  });

  const days = range.dates.length;
  const dayWord = `${days} day${days === 1 ? '' : 's'}`;
  const mix = t.guests ? (t.entitlementCovers / t.guests) * 100 : null;
  const vsUsual = (fc != null && base.pct != null) ? fc - base.pct : null;
  const costed = rows.filter((r) => r.fc != null);
  const aboveUsual = base.pct == null ? [] : costed.filter((r) => r.fc > base.pct);
  const unavailable = conv.unknown + conv.notConnected + conv.ambiguous;
  const dayLabel = (d) => `${WD[weekdayOf(d)].slice(0, 3)} ${fmtDate(d)}`;

  const frag = document.createDocumentFragment();
  const add = (html) => {
    const w = document.createElement('div');
    w.innerHTML = html;
    while (w.firstElementChild) frag.appendChild(w.firstElementChild);
  };

  /* Plots are drawn after insertion, sized to the box they land in, so axis
     type stays the same size on a phone as on a desktop. */
  const plotSpecs = [];
  const plotBox = (build) => {
    const id = `opsPlot${plotSpecs.length}`;
    plotSpecs.push({ id, build });
    return `<div class="plot" id="${id}"></div>`;
  };

  /* The resolved range, the service period and the scope used to be repeated in
     a context line here, under a filter bar that already states all three. What
     was worth keeping — where the figures came from and how current they are —
     is set by opsControls into the header, where it stays visible on scroll. */

  /* -- how are we performing, and what changed ----------------------------- */
  add(kpiBand([
    {
      lead: true,
      k: 'AYCE food cost (estimated)',
      v: pct(fc),
      delta: delta(vsUsual, { goodWhen: 'down', suffix: 'vs usual' }),
      m: base.pct == null
        ? 'No comparable shifts in the last four weeks to measure this against.'
        : `Usually <b>${pct(base.pct)}</b> on similar shifts, from ${base.found} comparable day${base.found === 1 ? '' : 's'}.`,
      spark: sparkline(rows.map((r) => r.fc), `AYCE food cost by day across ${dayWord}`),
    },
    {
      k: 'AYCE cover mix',
      v: pct(mix),
      m: `<b>${fmt(Math.round(t.entitlementCovers))}</b> AYCE covers of ${fmt(t.guests)} guests`,
    },
    {
      k: 'AYCE sales',
      v: usd0(t.entitlementNet),
      m: `on <b>${fmt(t.ayceChecks)}</b> AYCE checks · ${usd0(t.floorNet)} net floor sales`,
    },
    {
      k: 'Conversion rate',
      v: pct(conv.rate),
      m: conv.total === 0
        ? 'No OpenTable data in this range'
        : `<b>${conv.converted}</b> of ${conv.eligible} recorded &amp; connected tables`,
    },
    {
      k: 'Fixes needed',
      v: fmt(tri.badge),
      tone: tri.badge ? 'gold' : 'quiet',
      m: tri.badge
        ? `in this range · ${triAll.badge} total`
        : `nothing in this range · ${triAll.badge} total`,
    },
  ], 'Operations key figures'));

  /* -- where is performance weak ------------------------------------------- */
  const trend = costed.length
    ? plotBox((w) => linePlot({
      points: rows.map((r) => ({
        label: fmtDate(r.d),
        value: r.fc,
        tip: {
          /* the third element is the series slot the number came from, so the
             tooltip swatch matches the mark on the chart */
          title: dayLabel(r.d),
          rows: [
            ['Food cost', pct(r.fc), 1],
            ['AYCE sales', usd0(r.entitlementNet)],
            ['Estimated cost', usd0(r.roundCost)],
            ...(base.pct == null ? [] : [['Usual for similar shifts', pct(base.pct), 'dash']]),
          ],
        },
      })),
      reference: base.pct,
      referenceLabel: base.pct == null ? '' : `usual ${pct(base.pct)}`,
      fmtTick: (v) => `${v.toFixed(0)}%`,
      aria: `AYCE food cost percentage by business date across ${dayWord}${base.pct == null ? '' : `, against the usual ${pct(base.pct)} for similar shifts`}. The same figures appear in the by-day table below.`,
    }, w))
    : plotEmpty('No AYCE sales in this range',
      'Food cost is a share of AYCE sales, so there is no percentage to plot for these dates.');

  add(chartPanel({
    title: 'AYCE food cost by day',
    desc: 'Estimated cost of recorded AYCE rounds as a share of AYCE sales, per business date.',
    value: pct(fc),
    delta: delta(vsUsual, { goodWhen: 'down', suffix: 'vs usual' }),
    config: {
      fc: { label: 'Food cost', series: 1, kind: 'line' },
      ...(base.pct == null ? {} : { usual: { label: 'Usual for similar shifts', series: 4, kind: 'dash' } }),
    },
    body: trend,
    foot: `Estimated from items recorded in Toast — recorded consumption, not physical inventory
      usage or kitchen waste. Days with no AYCE sales have no percentage and break the line rather
      than being drawn as zero.`,
  }));

  /* -- supporting detail and the exception list ---------------------------- */
  const salesPlot = plotBox((w) => stackedBars({
    bars: rows.map((r) => {
      const other = Math.max(0, (r.floorNet ?? 0) - (r.entitlementNet ?? 0));
      return {
        label: fmtDate(r.d),
        base: r.entitlementNet,
        top: other,
        tip: {
          title: dayLabel(r.d),
          rows: [
            ['AYCE entitlement', usd0(r.entitlementNet), 1],
            ['Other floor sales', usd0(other), 2],
            ['Net floor sales', usd0(r.floorNet)],
          ],
          note: `${fmt(r.checks)} checks · ${fmt(r.guests)} guests`,
        },
      };
    }),
    fmtTick: moneyK,
    aria: `Net floor sales by business date, split into AYCE entitlement revenue and other floor sales, across ${dayWord}.`,
  }, w));

  const attnRow = (n, tone, title, detail, action = '') => `<li>
    <span class="an ${tone}">${n}</span>
    <span class="at"><b>${title}</b><span>${detail}</span>${action}</span></li>`;

  const attention = `<ul class="attn">
    ${attnRow(fmt(tri.badge), tri.badge ? 'warn' : 'ok', 'Visits needing a decision',
    tri.badge
      ? `Conflicting or unresolved starting choices in this range. ${triAll.badge} across all dates.`
      : `Nothing in this range. ${triAll.badge} across all dates.`,
    triAll.badge ? '<button class="linkbtn" type="button" id="opsGoFixes">Open Fixes Needed</button>' : '')}
    ${attnRow(fmt(aboveUsual.length), aboveUsual.length ? 'warn' : 'ok', 'Days above the usual food cost',
    base.pct == null
      ? 'No comparable shifts available to compare against.'
      : `Of ${costed.length} day${costed.length === 1 ? '' : 's'} with AYCE sales, measured against the usual ${pct(base.pct)}.`)}
    ${attnRow(fmt(unavailable), unavailable ? 'warn' : 'ok', 'Tables without a usable conversion',
    `${conv.unknown} with no recorded choice · ${conv.notConnected + conv.ambiguous} not reliably connected to a check. All of them still count in every sales, cover and food-cost figure.`)}
  </ul>`;

  /* one surface, one rule down the middle — the chart and the exception list are
     read together, so they should not look like two unrelated cards */
  add(`<div class="pair band">
    ${chartPanel({
    title: 'Sales by day',
    desc: 'Net floor sales per business date, split by what the AYCE entitlement contributed.',
    value: usd0(t.floorNet),
    config: {
      ayce: { label: 'AYCE entitlement', series: 1 },
      other: { label: 'Other floor sales', series: 2 },
    },
    body: salesPlot,
  })}
    ${panel({
    title: 'Needs attention',
    desc: 'Exceptions in this range, and where to resolve them.',
    body: attention,
  })}
  </div>`);

  /* -- what should I investigate next -------------------------------------- */
  add(panel({
    title: 'By day',
    desc: `${periods.join(' + ')} · AYCE program figures per business date.`,
    bodyCls: 'flush',
    body: `<div class="tw${rows.length > 12 ? ' tall' : ''}"><table>
      <caption class="sr">AYCE program figures for each business date in the selected range</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Day</th><th scope="col">Checks</th><th scope="col">Guests</th><th scope="col">Floor sales</th>
        <th scope="col">AYCE covers</th><th scope="col">AYCE sales</th><th scope="col">Est. food cost $</th><th scope="col">Food cost %</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td>${fmtDate(r.d)}</td><td>${WD[weekdayOf(r.d)].slice(0, 3)}</td>
        <td>${fmt(r.checks)}</td><td>${fmt(r.guests)}</td>
        <td>${usd0(r.floorNet)}</td>
        <td>${fmt(Math.round(r.entitlementCovers))}</td>
        <td>${usd0(r.entitlementNet)}</td>
        <td>${usd0(r.roundCost)}</td>
        <td><b>${pct(r.fc)}</b></td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td>Total</td><td>${dayWord}</td>
        <td>${fmt(t.checks)}</td><td>${fmt(t.guests)}</td><td>${usd0(t.floorNet)}</td>
        <td>${fmt(Math.round(t.entitlementCovers))}</td><td>${usd0(t.entitlementNet)}</td>
        <td>${usd0(t.roundCost)}</td><td>${pct(fc)}</td></tr></tfoot>
      </table></div>`,
    foot: `Totals are the range aggregate; the food-cost % is weighted (total estimated cost ÷ total
      AYCE sales), never an average of the daily percentages.`,
  }));

  /* -- scope, wording kept verbatim ----------------------------------------
     A closing footnote, not a seventh card: it qualifies everything above it
     rather than presenting a section of its own. */
  add(`<div class="note close-note"><b>Scope.</b> Dining-room and patio tables only — bar, takeout, delivery and
      non-table sales are excluded. AYCE food cost is <b>estimated from items recorded in Toast; it measures
      recorded consumption, not physical inventory usage or kitchen waste</b>. Every seated table counts in
      checks, covers, sales and food cost whether or not the host recorded a starting choice. Conversion rates
      use only tables with a recorded choice that connect to a Toast check — for the rest, conversion is simply
      unavailable.</div>`);

  host.appendChild(frag);
  drawPlots(host, plotSpecs);
  host.querySelector('#opsGoFixes')?.addEventListener('click', () => APP.setPage('fixes'));
}

/**
 * Conversion + classification census for a date range. Reconciles: every
 * OpenTable record lands in exactly one bucket, and the buckets sum to total.
 *   eligible/converted — recorded UNDECIDED/ALC, reliably connected
 *   predecided        — recorded AYCE (counts in mix, not a conversion opportunity)
 *   unknown           — no recorded starting choice (conversion unavailable)
 *   review            — conflicting recorded choices (pending decision)
 *   notConnected      — recorded choice, no reliable Toast connection
 *   ambiguous         — recorded choice, candidate not confirmed
 *   excluded          — visitor-excluded records
 * Half/Half is metadata and never affects any bucket.
 */
function conversionStatsFor(dates, periods = null) {
  const set = new Set(dates);
  // service-period filter mirrors servicePeriodOf: before the lunch cutoff is
  // lunch, everything else (including unknown times) is dinner
  const cutoff = (DATA.ops?.servicePeriods?.lunchBeforeHour ?? 16) * 60;
  const periodOf = (r) => (r.visitMinutes != null && r.visitMinutes < cutoff ? 'lunch' : 'dinner');
  const rows = DATA.intents.filter((r) => set.has(r.businessDate)
    && (!periods || periods.length === 2 || periods.includes(periodOf(r))));
  const st = { total: rows.length, eligible: 0, converted: 0, unknown: 0, review: 0, predecided: 0, ambiguous: 0, notConnected: 0, excluded: 0, halfHalf: 0 };
  for (const r of rows) {
    if (r.halfHalf || r.mixedMenuException) st.halfHalf++;   // metadata tally only
    if (r.excluded) { st.excluded++; continue; }             // visitor-excluded via correction
    const intent = r.intentEffective ?? r.intent;            // visitor correction overrides, audit preserved
    if (intent === 'REVIEW_REQUIRED') { st.review++; continue; }
    if (intent === 'UNKNOWN' || intent == null) { st.unknown++; continue; }
    if (intent === 'PREDECIDED_AYCE') { st.predecided++; continue; }
    if (r.staleSuggestion) { st.notConnected++; continue; }
    if (r.matchStatus === 'ambiguous') { st.ambiguous++; continue; }   // never counts either way
    if (r.matchStatus !== 'matched') { st.notConnected++; continue; }  // unconnected can't prove conversion
    st.eligible++;
    if (r.hasAyceSales) st.converted++;
  }
  st.rate = st.eligible > 0 ? (st.converted / st.eligible) * 100 : null;
  return st;
}

/* ================================================= SERVER PERFORMANCE (live) */
const SRV_KEY = 'ace.srvView';
function srvView() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SRV_KEY) || '{}'); } catch { /* defaults */ }
  return { search: '', sort: 'sales', dir: -1, ...s };
}
function saveSrvView(v) { localStorage.setItem(SRV_KEY, JSON.stringify(v)); }

function pgServersLive(host) { withData(host, renderServersLive); }
function renderServersLive(host) {
  const th = fcSettings();
  const state = opsState();
  const range = rangeOrExplain(host, state, renderServersLive);
  if (!range) return;
  const periods = periodsOf(state);
  const base = baselineFor(range.dates, periods);
  const emp = new Map((DATA.reference?.employees ?? []).map((e) => [e.guid, e.name]));
  const view = srvView();

  // conversion per server from recorded-and-connected visits, respecting the
  // service-period selector like every other figure on the page
  const set = new Set(range.dates);
  const cutoff = (DATA.ops?.servicePeriods?.lunchBeforeHour ?? 16) * 60;
  const periodOf = (r) => (r.visitMinutes != null && r.visitMinutes < cutoff ? 'lunch' : 'dinner');
  const convByServer = new Map();
  for (const r of DATA.intents) {
    if (!set.has(r.businessDate) || r.excluded) continue;
    if (periods.length !== 2 && !periods.includes(periodOf(r))) continue;
    const intent = r.intentEffective ?? r.intent;
    if (!['UNDECIDED', 'ALC'].includes(intent)) continue;
    if (r.staleSuggestion || r.matchStatus !== 'matched' || !r.matchedServerGuid) continue;
    const c = convByServer.get(r.matchedServerGuid) ?? { eligible: 0, converted: 0 };
    c.eligible++;
    if (r.hasAyceSales) c.converted++;
    convByServer.set(r.matchedServerGuid, c);
  }

  const per = perServerMetrics(range.dates, periods);
  let rows = [...per.entries()].map(([guid, a]) => {
    const p = fcPctOf(a);
    const cov = a.totalQty > 0 ? (a.matchedQty / a.totalQty) * 100 : null;
    // sample-size status and cost status are SEPARATE facts
    const smallSample = a.checks < th.minChecks || a.entitlementNet < th.minNetFoodSales;
    const lowCoverage = cov != null && cov < th.minCoveragePct;
    let cost = 'no_baseline';
    if (base.pct != null && p != null) {
      const v = p - base.pct;
      cost = v >= th.criticalPts ? 'critical' : v >= th.watchPts ? 'watch' : 'no_alert';
    }
    if (smallSample) cost = 'no_alert';
    const conv = convByServer.get(guid) ?? { eligible: 0, converted: 0 };
    return { guid, name: emp.get(guid) ?? '(unattributed)', a, p, cov, smallSample, lowCoverage, cost, conv, median: undefined };
  });

  if (view.search) rows = rows.filter((r) => r.name.toLowerCase().includes(view.search.toLowerCase()));
  const sorters = {
    name: (r) => r.name.toLowerCase(),
    checks: (r) => r.a.checks, covers: (r) => r.a.entitlementCovers, sales: (r) => r.a.entitlementNet,
    fc: (r) => (r.p ?? -Infinity), median: (r) => (r.median?.medianPct ?? -Infinity),
    conv: (r) => (r.conv.eligible ? r.conv.converted / r.conv.eligible : -Infinity),
  };

  const card = document.createElement('div');
  card.className = 'card sec';
  card.innerHTML = `<header><div><div class="ttl">Server performance — ${esc(range.label)}</div>
    <div class="sub">AYCE program only. Select a row for the check-by-check detail.</div></div>
    <span class="sp"></span>
    <span class="badge mute nowrap">${rows.length} server${rows.length === 1 ? '' : 's'}</span></header>
    <div class="toolbar">
      <div class="srch"><span class="si" aria-hidden="true">⌕</span>
        <input type="search" id="srvQ" placeholder="Search server…" aria-label="Search servers" value="${esc(view.search)}"></div>
      <span class="sub" id="srvDetailState" role="status" style="margin-left:auto"></span>
    </div>
    <div class="body tw"><table id="srvTbl">
    <caption class="sr">Server performance for the selected range: AYCE checks, covers, sales, food-cost percentages, conversion and status per server</caption>
    <thead><tr>
      ${srvTh('name', 'Server', view, 'style="text-align:left"')}
      ${srvTh('checks', 'Checks', view, '', 'AYCE checks attributed to this server in the selected range.')}
      ${srvTh('covers', 'Covers', view, '', 'AYCE covers (entitlement quantities) rung on this server\u2019s checks.')}
      ${srvTh('sales', 'AYCE sales', view)}
      ${srvTh('fc', 'Food cost %', view, '', 'Weighted mean: total estimated food cost ÷ total AYCE sales for this server. Represents the actual financial impact.')}
      ${srvTh('median', 'Median %', view, '', "The middle check's food-cost %. Shows the typical table and is not distorted by one expensive 'whale' table. Shown alongside — never instead of — the weighted mean.")}
      <th scope="col">Baseline<button class="inf" type="button" aria-label="Definition of restaurant baseline" data-tip="The restaurant-wide weighted food-cost % for the same weekday and service period over the previous ${DATA.ops.baseline.weeks} weeks. The same reference for every server — not a per-server figure.">i</button></th>
      ${srvTh('conv', 'Conversion', view)}
      <th scope="col">Status</th>
      <th scope="col">Sample</th>
    </tr></thead><tbody id="srvBody"></tbody></table></div>
    <div class="foot">Conversion counts recorded-and-connected tables only; tables without a recorded choice still
    appear in every sales and cost figure — only conversion leaves them out. Alerts stay off below ${th.minChecks}
    AYCE checks or ${usd0(th.minNetFoodSales)} AYCE sales. This table never implies a server caused kitchen waste —
    it reflects what was rung for their AYCE tables. “Median check %” and the drill-down load from the check-level
    records. Pilot-weekend history (with commission) lives under Pilot Review.</div>`;
  host.appendChild(card);

  const paintRows = () => {
    const sk = sorters[view.sort] ?? sorters.sales;
    const sorted = rows.slice().sort((x, y) => {
      const a = sk(x), b = sk(y);
      return (a < b ? -1 : a > b ? 1 : 0) * view.dir;
    });
    const body = card.querySelector('#srvBody');
    body.innerHTML = sorted.map((r) => `<tr class="rowlink" tabindex="0" role="button" data-srv="${esc(r.guid)}"
        aria-label="Open check-level detail for ${esc(r.name)}">
      <td style="text-align:left;white-space:nowrap">${esc(r.name)}</td>
      <td>${fmt(r.a.checks)}</td>
      <td>${fmt(Math.round(r.a.entitlementCovers))}</td>
      <td>${usd0(r.a.entitlementNet)}</td>
      <td><b>${pct(r.p)}</b></td>
      <td>${r.median === undefined ? '<span class="muted">…</span>' : r.median === null ? '—'
        : `${pct(r.median.medianPct)}${r.median.outlierCount ? ` <span class="badge neu" title="${r.median.outlierCount} check(s) above the outlier line (Q3 + 1.5×IQR = ${pct(r.median.outlierAbovePct)})">${r.median.outlierCount}⚠</span>` : ''}`}</td>
      <td>${pct(base.pct)}</td>
      <td>${r.conv.eligible ? `${pct((r.conv.converted / r.conv.eligible) * 100, 0)} <span class="muted">(${r.conv.converted}/${r.conv.eligible})</span>` : '<span class="muted" title="No recorded-and-connected eligible tables — conversion unavailable, not zero">n/a</span>'}</td>
      <td style="text-align:center">${costBadge(r)}</td>
      <td style="text-align:center">${sampleBadge(r)}</td></tr>`).join('');
    body.querySelectorAll('tr.rowlink').forEach((tr) => {
      const open = () => openServerDrawer(tr.dataset.srv, rows.find((r) => r.guid === tr.dataset.srv), range, periods, base);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  };
  paintRows();

  card.querySelector('#srvQ').addEventListener('input', (e) => {
    const v = { ...view, search: e.target.value };
    saveSrvView(v);
    const pos = e.target.selectionStart;
    renderServersLive(host);
    const nq = host.querySelector('#srvQ');
    if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); }
  });
  card.querySelectorAll('th .sortbtn').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.k;
    const v = { ...view, sort: k, dir: view.sort === k ? -view.dir : (k === 'name' ? 1 : -1) };
    saveSrvView(v);
    renderServersLive(host);
  }));
  card.querySelectorAll('[data-tip]').forEach((b) => { b.title = b.dataset.tip; });

  // check-level detail (median / IQR) loads asynchronously with a real state —
  // rows show "…" until it lands, never a stale or fabricated value
  const stateEl = card.querySelector('#srvDetailState');
  stateEl.textContent = 'Loading check-level detail…';
  rangeDetail(range.dates, periods).then(({ checks, missingDates }) => {
    if (!card.isConnected) return; // user navigated away — keep their new view untouched
    const byServer = new Map();
    for (const c of checks) {
      if (!byServer.has(c.serverGuid)) byServer.set(c.serverGuid, []);
      byServer.get(c.serverGuid).push(c);
    }
    for (const r of rows) {
      const list = byServer.get(r.guid) ?? [];
      r.median = list.length ? perCheckCostStats(list) : null;
      r.checksDetail = list;
    }
    stateEl.textContent = missingDates.length
      ? `Check-level detail unavailable for ${missingDates.length} day(s) in this range.`
      : '';
    paintRows();
    if (srvDrawerRepaint) srvDrawerRepaint();   // a drawer opened mid-load fills in live
  }).catch(() => { stateEl.textContent = 'Check-level detail could not load — totals above are unaffected.'; });
}

/** Sortable column header: aria-sort lives on the th; the inner button
 * carries the keyboard/click interaction. */
function srvTh(key, label, view, thAttrs = '', tip = null) {
  const on = view.sort === key;
  const ariaSort = on ? (view.dir === 1 ? ' aria-sort="ascending"' : ' aria-sort="descending"') : '';
  return `<th scope="col" ${thAttrs}${ariaSort}>
    <button type="button" class="sortbtn" data-k="${key}" aria-label="Sort by ${esc(label)}${on ? (view.dir === 1 ? ', currently ascending' : ', currently descending') : ''}"
      style="background:none;border:none;cursor:pointer;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit;padding:0">
      ${esc(label)}<span class="sarr" aria-hidden="true">${on ? (view.dir === 1 ? '▲' : '▼') : '▾'}</span></button>${
    tip ? `<button class="inf" type="button" aria-label="Definition of ${esc(label)}" data-tip="${esc(tip)}">i</button>` : ''}</th>`;
}
function costBadge(r) {
  if (r.lowCoverage) return '<span class="badge neu" title="Too many uncosted items for a fair comparison">Costs missing</span>';
  if (r.smallSample) return '<span class="badge mute" title="Below the sample threshold — the estimate is shown for completeness and alerts are suppressed">No alert</span>';
  const map = {
    no_alert: ['pos', 'No alert'], watch: ['neu', 'Watch'], critical: ['neg', 'Critical'],
    no_baseline: ['mute', '—'],
  };
  const [cls, label] = map[r.cost] ?? ['mute', r.cost];
  return `<span class="badge ${cls}">${label}</span>`;
}
function sampleBadge(r) {
  return r.smallSample
    ? '<span class="badge mute" title="Below the sample threshold — figures shown for completeness, alerts suppressed">Small</span>'
    : '<span class="badge pos">OK</span>';
}

async function loadPagesDeployment(el) {
  if (!el) return;
  try {
    const res = await fetch('https://api.github.com/repos/dominicmemoli-create/ace-dashboard/deployments?environment=github-pages&per_page=1', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const deployments = await res.json();
    const dep = deployments?.[0];
    const sha = dep?.sha ? String(dep.sha) : '';
    el.innerHTML = sha
      ? `<code>${esc(sha.slice(0, 12))}</code>${dep.ref ? ` · ${esc(dep.ref)}` : ''}`
      : 'No GitHub Pages deployment reported';
  } catch {
    el.textContent = 'Unavailable from the GitHub API';
  }
}

/* ----------------------------------------------------- server drill-down -- */
const INTENT_WORD = {
  UNDECIDED: 'Undecided', ALC: 'À la carte', PREDECIDED_AYCE: 'Pre-decided AYCE',
  REVIEW_REQUIRED: 'Conflicting', UNKNOWN: 'Unknown',
};
const TIER_WORD = (name) => {
  const n = String(name ?? '');
  if (/royalty/i.test(n)) return 'Royalty';
  if (/premium/i.test(n)) return 'Premium';
  if (/classic/i.test(n)) return 'Classic';
  return n || '—';
};
const TIER_LABEL_SRC = {
  confirmed: 'chef-confirmed', override: 'portion override', explicit_temp: 'temporary explicit',
  rough_estimate: 'temporary workbook', fallback_2: '$2 fallback',
};
let drawerLastFocus = null;
let srvDrawerRepaint = null;
function closeSrvDrawer() {
  const d = document.getElementById('srvDrawer'), s = document.getElementById('srvScrim');
  if (d) { d.classList.remove('show'); setTimeout(() => d.remove(), 260); }
  if (s) { s.classList.remove('show'); setTimeout(() => s.remove(), 260); }
  document.removeEventListener('keydown', srvDrawerKey, true);
  srvDrawerRepaint = null;
  if (drawerLastFocus && drawerLastFocus.isConnected) drawerLastFocus.focus();
  drawerLastFocus = null;
}
function srvDrawerKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeSrvDrawer(); }
}
function openServerDrawer(guid, row, range, periods, base) {
  if (!row) return;
  drawerLastFocus = document.activeElement;
  document.getElementById('srvDrawer')?.remove();
  document.getElementById('srvScrim')?.remove();
  const tz = DATA.ops?.servicePeriods?.timezone ?? 'America/New_York';
  const scrim = document.createElement('div');
  scrim.id = 'srvScrim';
  scrim.style.cssText = 'position:fixed;inset:0;background:rgba(14,18,24,.42);z-index:90;opacity:0;transition:opacity .22s';
  const dr = document.createElement('div');
  dr.id = 'srvDrawer'; dr.className = 'drawer';
  dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-modal', 'true');
  dr.setAttribute('aria-label', `Check-level detail: ${row.name}`);

  const paint = (sortKey = 'date', dir = 1) => {
    const list = (row.checksDetail ?? []).slice();
    const sorters = {
      date: (c) => `${c.businessDate}|${c.openedDate ?? ''}`,
      pct: (c) => c.pctOfSales ?? -1,
      cost: (c) => c.foodCostDollars,
      sales: (c) => c.entitlementNet,
    };
    const sf = sorters[sortKey] ?? sorters.date;
    list.sort((a, b) => { const x = sf(a), y = sf(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const stat = row.median;
    const fmtT = (iso) => {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch { return '—'; }
    };
    const outlier = (c) => stat?.outlierAbovePct != null && c.pctOfSales != null && c.pctOfSales > stat.outlierAbovePct;
    dr.innerHTML = `
    <div class="dh">
      <div style="min-width:0"><h3>${esc(row.name)}</h3>
        <div class="meta"><span>${esc(range.label)} · ${periods.join(' + ')}</span>
          <span>${fmt(row.a.checks)} AYCE checks · ${usd0(row.a.entitlementNet)} AYCE sales</span></div></div>
      <button class="xbtn" type="button" id="srvDrClose" aria-label="Close server detail">✕</button></div>
    <div class="db">
      <div class="dgrid">
        <div class="dcell"><div class="k">Weighted food cost</div><div class="v">${pct(row.p)}</div>
          <div class="m">Σ cost ÷ Σ AYCE sales — the financial impact</div></div>
        <div class="dcell"><div class="k">Median check</div><div class="v">${stat ? pct(stat.medianPct) : '—'}</div>
          <div class="m">the typical table — whales can't distort it</div></div>
        <div class="dcell"><div class="k">Middle 50% (IQR)</div><div class="v" style="font-size:15px">${stat && stat.q1Pct != null ? `${pct(stat.q1Pct, 0)}–${pct(stat.q3Pct, 0)}` : '—'}</div>
          <div class="m">${stat?.outlierCount ? `${stat.outlierCount} outlier check(s) above ${pct(stat.outlierAbovePct, 0)}` : 'no outlier checks'}</div></div>
        <div class="dcell"><div class="k">Restaurant baseline</div><div class="v">${pct(base.pct)}</div>
          <div class="m">same weekday + period, prior ${DATA.ops.baseline.weeks} wks</div></div>
      </div>
      <div class="note" style="margin-bottom:14px"><b>Two numbers on purpose.</b> The weighted mean is what the
        program actually cost against what it collected. The median shows the typical check so one unusually
        expensive table can't distort the read. Both stay visible — neither replaces the other.</div>
      ${row.checksDetail === undefined ? '<div class="sub" role="status">Loading checks…</div>'
      : !list.length ? '<div class="empty"><div class="et">No AYCE checks in this selection</div></div>' : `
      <div class="card"><header><div><div class="ttl">Checks (${list.length})</div>
        <div class="sub">Every figure below comes from the same calculation pipeline as the headline.</div></div></header>
      <div class="toolbar"><div class="seg" role="group" aria-label="Sort checks">
        ${[['date', 'By date'], ['pct', 'By food-cost %'], ['cost', 'By cost $'], ['sales', 'By sales']].map(([k, l]) =>
          `<button type="button" data-csort="${k}" aria-pressed="${sortKey === k}">${l}</button>`).join('')}
      </div></div>
      <div class="body tw"><table>
        <caption class="sr">Individual AYCE checks for ${esc(row.name)}</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Opened</th><th scope="col">Table</th><th scope="col">Guests</th>
          <th scope="col">Recorded intent</th><th scope="col">AYCE</th><th scope="col">Covers</th><th scope="col">Items</th>
          <th scope="col">AYCE sales</th><th scope="col">Est. cost</th><th scope="col">Cost %</th><th scope="col">$/cover</th><th scope="col"></th></tr></thead>
        <tbody>${list.map((c, i) => `
          <tr class="${outlier(c) ? 'sel' : ''}">
            <td>${fmtDate(c.businessDate)}</td>
            <td>${fmtT(c.openedDate)}</td>
            <td>${esc(c.table)}</td>
            <td>${fmt(c.guests)}</td>
            <td style="white-space:nowrap">${esc(INTENT_WORD[c.intent] ?? 'Unknown')}${c.halfHalf ? ' <span class="muted" title="Half returning / half first-time guests — informational note only">· ½/½</span>' : ''}</td>
            <td>${c.entitlementCovers > 0 ? `<span class="tag yes">${esc(TIER_WORD(c.ayceTier))}</span>` : '<span class="tag no">no</span>'}</td>
            <td>${fmt(Math.round(c.entitlementCovers))}</td>
            <td>${fmt(Math.round(c.itemQty))}</td>
            <td>${usd0(c.entitlementNet)}</td>
            <td>${usd(c.foodCostDollars)}</td>
            <td><b>${pct(c.pctOfSales)}</b>${outlier(c) ? ' <span class="badge neu" title="Above the outlier line (Q3 + 1.5×IQR)">outlier</span>' : ''}</td>
            <td>${usd(c.costPerCover)}</td>
            <td><button class="btn ghost sm" type="button" data-citems="${i}" aria-expanded="false" aria-label="Show ordered items for this check">items</button></td>
          </tr>
          <tr id="citems-${i}" hidden><td colspan="13" style="text-align:left;background:var(--surface-2)">
            ${checkItemsHtml(c)}</td></tr>`).join('')}
        </tbody></table></div></div>`}
    </div>`;
    dr.querySelector('#srvDrClose').addEventListener('click', closeSrvDrawer);
    dr.querySelectorAll('[data-csort]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.csort;
      paint(k, k === sortKey ? -dir : (k === 'date' ? 1 : -1));
    }));
    dr.querySelectorAll('[data-citems]').forEach((b) => b.addEventListener('click', () => {
      const rowEl = dr.querySelector(`#citems-${b.dataset.citems}`);
      const open = !rowEl.hidden;
      rowEl.hidden = open;
      b.setAttribute('aria-expanded', String(!open));
    }));
  };

  document.body.appendChild(scrim);
  document.body.appendChild(dr);
  paint();
  srvDrawerRepaint = () => { if (dr.isConnected) paint(); };
  requestAnimationFrame(() => { scrim.style.opacity = '1'; dr.classList.add('show'); });
  scrim.addEventListener('click', closeSrvDrawer);
  document.addEventListener('keydown', srvDrawerKey, true);
  dr.querySelector('#srvDrClose').focus();
}

/** Full ordered-item breakdown for one check: cost source per item, plus the
 * excluded modifiers clearly identified (they never carry cost). */
function checkItemsHtml(c) {
  const items = (c.items ?? []).filter((x) => x.cls !== 'entitlement');
  const ent = (c.items ?? []).filter((x) => x.cls === 'entitlement');
  return `
    <div style="padding:8px 4px;font-size:12.5px;line-height:1.6">
      ${ent.length ? `<div style="margin-bottom:6px"><b>AYCE entitlement:</b> ${ent.map((x) => `${esc(x.name)} × ${fmt(x.qty)} (${usd0(x.net)})`).join(' · ')}</div>` : ''}
      ${items.length ? `<table style="font-size:12.5px;max-width:640px">
        <caption class="sr">Ordered items and their cost sources</caption>
        <thead><tr><th scope="col" style="text-align:left">Item</th><th scope="col">Qty</th><th scope="col">Est. cost</th><th scope="col" style="text-align:left">Cost source</th></tr></thead>
        <tbody>${items.map((x) => `<tr>
          <td style="text-align:left">${esc(x.name)}</td>
          <td>${fmt(x.qty)}</td>
          <td>${x.cls === 'missing' ? '<span class="muted">no cost yet</span>' : usd(x.cost)}</td>
          <td style="text-align:left">${x.cls === 'missing' ? '<span class="st rev">missing — not counted as $0</span>'
            : `<span class="muted">${esc(TIER_LABEL_SRC[x.tier] ?? x.tier ?? '')}${x.costPerUnit != null ? ` · ${usd(x.costPerUnit)}/ea` : ''}</span>`}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="muted">No cost-bearing items on this check.</div>'}
      ${(c.excludedItems ?? []).length ? `<div style="margin-top:8px" class="muted">
        <b>Excluded (not food-cost items):</b> ${c.excludedItems.map((x) => `${esc(x.name)}${x.kind === 'drink' ? ' (drink)' : ''}`).join(', ')}
        — preparation notes, kitchen markers and trivial drinks carry no cost and never appear as missing.</div>` : ''}
    </div>`;
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
  const range = rangeOrExplain(host, state, renderFoodCost);
  if (!range) return;
  const periods = periodsOf(state);
  const t = sumMetrics(range.dates, periods);
  const scopePct = fcPctOf(t);
  const base = baselineFor(range.dates, periods);
  const variance = scopePct != null && base.pct != null ? scopePct - base.pct : null;
  const qtyCov = t.totalQty > 0 ? (t.matchedQty / t.totalQty) * 100 : null;
  const tiers = sumTiers(range.dates, periods);
  const totalCost = Object.values(tiers).reduce((a, b) => a + b, 0);
  const tempCost = totalCost - tiers.confirmed;
  // Metric rows built before the tier breakdown existed carry no costByTier —
  // fall back to the item-level sources so stale data can never claim
  // "chef-confirmed" by omission. Scoped to the SELECTED range: a mixed
  // database must not vouch for dates it has no tier data for.
  const rangeSet = new Set(range.dates);
  const tiersKnown = DATA.metrics.some((r) => !r.serverGuid && rangeSet.has(r.businessDate) && r.costByTier);
  const provisional = tiersKnown
    ? tempCost > 0
    : (DATA.items ?? []).some((i) => i.matched && i.source !== 'chef_confirmed' && i.verification !== 'verified');

  const hero = document.createElement('div');
  hero.innerHTML = `
  <section class="hero rise"><div class="hero-top">
    <div class="hero-verdict">
      <div class="hero-eyebrow">AYCE food cost — ${esc(range.label)}
        <span class="verdict-badge ${provisional ? 'neu' : 'pos'}">${provisional ? 'Rough costs — waiting for chef confirmation' : 'CHEF-CONFIRMED'}</span></div>
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
      <div class="hr-cell"><div class="k">Genuine AYCE items costed</div><div class="v">${pct(qtyCov)}</div>
        <div class="m">modifiers &amp; drinks removed from the denominator</div></div>
      <div class="hr-cell"><div class="k">Chef-confirmed share</div><div class="v">${tiersKnown ? pct(totalCost > 0 ? (tiers.confirmed / totalCost) * 100 : null, 0) : '—'}</div>
        <div class="m">${tiersKnown ? 'of cost dollars; the rest are rough costs awaiting chef confirmation' : 'available after the next data rebuild'}</div></div>
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

  // where the cost dollars come from — the provisional-cost breakdown
  const src = document.createElement('div');
  src.className = 'card sec';
  const tierRow = (label, dollars, hint, badgeCls) => totalCost > 0 || dollars > 0 ? `
    <div class="calcrow"><span class="cl">${label}
      <span class="sub" style="display:block">${hint}</span></span>
      <span class="cr">${usd0(dollars)} <span class="muted">(${pct(totalCost > 0 ? (dollars / totalCost) * 100 : null, 0)})</span></span></div>` : '';
  src.innerHTML = `<header><div><div class="ttl">Where the cost estimate comes from</div>
    <div class="sub">Exact costs, rough costs and gaps are kept separate — a headline coverage number
    never hides which kind is underneath.</div></div></header>
    <div class="body">
      ${tiersKnown ? '' : '<div class="note gold" style="margin-bottom:8px">The cost-source split appears after the next data rebuild; the totals above are unaffected.</div>'}
      ${tierRow('Chef-confirmed costs', tiers.confirmed, 'exact recipe costs uploaded by the chef', 'pos')}
      ${tierRow('Explicit temporary costs', tiers.explicit_temp + tiers.override, 'stated interim costs (incl. portion overrides such as ½-lb shrimp $2.50, 1-pc crab cake $4)', 'neu')}
      ${tierRow('Workbook estimates', tiers.rough_estimate, 'rough per-item estimates from the cost workbook', 'neu')}
      ${tierRow('$2 menu fallback', tiers.fallback_2, 'supplied-menu items awaiting a real cost — flat $2 placeholder', 'neu')}
      <div class="calcrow"><span class="cl">True missing food items
        <span class="sub" style="display:block">genuine items with no cost — left OUT of the estimate, never $0</span></span>
        <span class="cr">${fmt(t.totalQty - t.matchedQty)} item${t.totalQty - t.matchedQty === 1 ? '' : 's'}</span></div>
      <div class="calcrow"><span class="cl">Excluded from the model entirely
        <span class="sub" style="display:block">Toast modifiers, preparation notes, kitchen markers and trivial drinks — no cost, no coverage effect</span></span>
        <span class="cr">${fmt(Math.round(t.excludedModifierQty))} modifier rows · ${fmt(Math.round(t.excludedDrinkQty))} drink rows</span></div>
    </div>
    <div class="foot">Food cost stays labeled "Rough costs — waiting for chef confirmation" until chef-confirmed recipe costs are uploaded
      (Update Dashboard → Food Costs). The headline, server table and every drill-down use this same
      calculation pipeline.</div>`;
  host.appendChild(src);

  // item drivers + uncosted (from item metrics)
  const set = new Set(range.dates);
  const itemAgg = new Map();
  for (const it of DATA.items) {
    if (!set.has(it.businessDate) || !periods.includes(it.period)) continue;
    const key = `${it.matched ? 'm' : 'u'}|${it.name}`;
    if (!itemAgg.has(key)) itemAgg.set(key, { name: it.name, matched: it.matched, qty: 0, cost: 0, source: it.source, verification: it.verification, tier: it.tier });
    const a = itemAgg.get(key);
    a.qty += it.qty; a.cost += it.cost;
    if (it.tier && a.tier && it.tier !== a.tier) a.tier = 'mixed';   // cost source changed mid-range
  }
  const drivers = [...itemAgg.values()].filter((x) => x.matched && x.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 14);
  const unmatched = [...itemAgg.values()].filter((x) => !x.matched).sort((a, b) => b.qty - a.qty).slice(0, 20);
  const tierBadge = (d) => {
    if (d.tier === 'mixed') return '<span class="badge neu" title="The cost source for this item changed within the selected range (e.g. a chef confirmation took effect mid-range)">mixed sources</span>';
    if (d.tier === 'confirmed' || d.verification === 'verified') return '<span class="badge pos">chef-confirmed</span>';
    if (d.tier === 'fallback_2') return '<span class="badge neu">$2 fallback</span>';
    if (d.tier === 'override') return '<span class="badge neu">portion override</span>';
    if (d.tier === 'explicit_temp') return '<span class="badge neu">explicit temp</span>';
    return '<span class="badge neu">temp estimate</span>';
  };
  const two = document.createElement('div');
  two.className = 'sec g2';
  two.innerHTML = `
    <div class="card"><header><div><div class="ttl">Highest-cost AYCE items</div></div></header>
      <div class="body tw"><table>
      <caption class="sr">Highest-cost AYCE items with their cost source</caption>
      <thead><tr><th scope="col" style="text-align:left">Item</th><th scope="col">Qty</th><th scope="col">Est. cost</th><th scope="col">Cost source</th></tr></thead><tbody>
      ${drivers.map((d) => `<tr>
        <td style="text-align:left">${esc(d.name)}</td>
        <td>${fmt(Math.round(d.qty))}</td>
        <td><b>${usd0(d.cost)}</b></td>
        <td style="text-align:center">${tierBadge(d)}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="card"><header><div><div class="ttl">True missing food items (${unmatched.length ? unmatched.length : 'none'})</div>
      <div class="sub">Genuine menu items with no cost yet — left out of cost dollars (never counted as $0),
      so the true % is understated until they're costed. Modifiers and drinks never appear here.
      Add costs via Update Dashboard → Food Costs.</div></div></header>
      <div class="body tw"><table>
      <caption class="sr">Food items still missing a cost</caption>
      <thead><tr><th scope="col" style="text-align:left">Item</th><th scope="col">Qty</th></tr></thead><tbody>
      ${unmatched.length ? unmatched.map((u) => `<tr>
        <td style="text-align:left">${esc(u.name)}</td>
        <td>${fmt(Math.round(u.qty))}</td></tr>`).join('') : '<tr><td colspan="2" class="muted" style="text-align:left">Everything genuine is costed.</td></tr>'}
      </tbody></table></div></div>`;
  host.appendChild(two);
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
    <div class="alert warn"><b>Frozen history.</b> The pilot weekend
    (Jul 31 – Aug 2, 2026) is preserved exactly as reported. The commission program ended Aug 2 —
    figures here are informational and no new commission accrues.</div>
    <div class="seg tabbar" role="tablist" aria-label="Pilot Review sections">
      ${tabs.map(([k, l]) => `<button type="button" role="tab" id="ptab-${k}" data-ptab="${k}"
        aria-selected="${k === tab}" aria-controls="pilotBody" tabindex="${k === tab ? 0 : -1}">${l}</button>`).join('')}
    </div>
    <div id="pilotBody" role="tabpanel" aria-labelledby="ptab-${tab}"></div>`;
  const body = host.querySelector('#pilotBody');
  const btns = [...host.querySelectorAll('[data-ptab]')];
  const paint = () => {
    body.innerHTML = '';
    body.setAttribute('aria-labelledby', `ptab-${tab}`);
    legacy[tab].fn(body);
  };
  const activate = (k, focus = false) => {
    tab = k;
    localStorage.setItem(PILOT_TAB_KEY, tab);
    btns.forEach((x) => {
      const on = x.dataset.ptab === k;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      if (on && focus) x.focus();
    });
    paint();
  };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => activate(b.dataset.ptab));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = (i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length;
        activate(btns[next].dataset.ptab, true);
      } else if (e.key === 'Home') { e.preventDefault(); activate(btns[0].dataset.ptab, true); }
      else if (e.key === 'End') { e.preventDefault(); activate(btns[btns.length - 1].dataset.ptab, true); }
    });
  });
  paint();
}

/* =========================================================== HOW THIS WORKS */
function pgHelp(host) {
  withData(host, (h) => {
    const dates = opDates();
    // census over EVERY stored OpenTable record (including dates without Toast
    // metrics yet) so the reconciliation line always sums to the total
    const allIntentDates = [...new Set(DATA.intents.map((r) => r.businessDate))];
    const conv = conversionStatsFor(allIntentDates);
    const tri = triageIntents(DATA.intents);
    h.innerHTML = `
    <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
      <div class="hero-eyebrow">How This Works</div>
      <div class="hero-delta"><span class="big" style="font-size:26px;letter-spacing:-.6px;line-height:1.3">Three data sources.<br>Three simple jobs.</span></div>
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
        upload the cost sheet under <b>Update Dashboard → Food Costs</b>. Until then numbers
        are marked provisional. Past days keep their old costs — history never changes.</div></div>
    </div>

    <div class="card sec"><header><div><div class="ttl">What the numbers mean — in plain language</div></div></header>
      <div class="body"><dl style="display:grid;grid-template-columns:auto 1fr;gap:10px 18px;font-size:13.5px;line-height:1.6">
        <dt style="font-weight:650;white-space:nowrap">AYCE food cost</dt>
        <dd>The estimated cost of AYCE food the kitchen sent out, divided by what guests paid for AYCE.
          Estimated from what was recorded in Toast — it is not an inventory count and says nothing about waste.
          Preparation notes ("Medium", "No Corn") and soft drinks are never costed and never counted as missing.</dd>
        <dt style="font-weight:650;white-space:nowrap">Usual food cost</dt>
        <dd>The same weekday and meal period over the previous ${DATA.ops.baseline.weeks} weeks. A Friday dinner is
          compared to recent Friday dinners, never to a Tuesday lunch.</dd>
        <dt style="font-weight:650;white-space:nowrap">Conversion</dt>
        <dd>Of the tables where the host recorded "Undecided" or "À la carte" and we could connect the visit to a
          Toast check, how many ended up ordering AYCE. A table with no recorded choice still counts in every
          sales, cover and food-cost figure — only its conversion is unavailable, shown as "n/a", never as zero.</dd>
        <dt style="font-weight:650;white-space:nowrap">Half/Half</dt>
        <dd>A host note that about half the party are returning guests and half are first-timers. It is kept as
          information only — it is not a menu choice and never needs a decision.</dd>
        <dt style="font-weight:650;white-space:nowrap">Fixes Needed</dt>
        <dd>The short list of visits that genuinely need a decision — a conflicting starting choice or one likely
          table connection to confirm. Everything unclear is excluded automatically instead of becoming work.</dd>
        <dt style="font-weight:650;white-space:nowrap">Who can do what</dt>
        <dd>Anyone who passes the presentation gate can view the dashboard. Uploading files, updating food costs,
          resolving fixes and retrying Toast updates require signing in with an approved manager email — the
          database checks that on every write and records who made it.</dd>
      </dl></div></div>

    <div class="sec">
      <div class="acc"><button type="button" aria-expanded="false" id="advDetTgl">
        Advanced Details — data &amp; methodology (for technical readers)<span class="ch">▶</span></button>
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
        const lastImport = (DATA.importRuns ?? []).find((r) => r.status === 'success');
        // classification census — reconciles to the total row count
        const censusParts = [
          `${conv.eligible} eligible (recorded &amp; connected)`,
          `${conv.predecided} pre-decided AYCE`,
          `${conv.unknown} no recorded choice`,
          `${conv.review} conflicting`,
          `${conv.notConnected} recorded but not connected`,
          `${conv.ambiguous} ambiguous connection`,
          `${conv.excluded} visitor-excluded`,
        ];
        const censusSum = conv.eligible + conv.predecided + conv.unknown + conv.review + conv.notConnected + conv.ambiguous + conv.excluded;
        const wrap = document.createElement('div');
        wrap.innerHTML = `
        <table class="tb" style="width:100%;font-size:12.5px;border-collapse:collapse;margin-bottom:14px">
        <caption class="sr">Technical data and methodology details</caption><tbody>
          ${mrow('Data source', DATA.source === 'supabase' ? 'Shared database' : 'Static fallback files (database unreachable)')}
          ${mrow('Deployed commit', '<span id="deploySha">Checking GitHub Pages...</span>')}
          ${mrow('Data freshness (all times ET)', `Sales through ${fmtDate(dates[dates.length - 1])} · last Toast sync ${fmtEt(DATA.manifest?.lastToastSync)} · last upload ${lastImport ? `${esc(lastImport.kind)} ${fmtEt(lastImport.created_at)}` : '—'} · pilot extract generated ${esc(String(window.__ACE__?.generated ?? '—'))}`)}
          ${mrow('Last update run', lastRun ? `${esc(lastRun.runId ?? '')} · ${esc(lastRun.status ?? '')}${lastRun.error ? ' · ' + esc(lastRun.error) : ''}` : '—')}
          ${mrow('Included areas', Object.values(DATA.ops.includedAreas.serviceAreaGuids).join(', ') + ' — bar, takeout, delivery and non-table revenue excluded')}
          ${mrow('Service periods', `Lunch: opened before ${DATA.ops.servicePeriods.lunchBeforeHour - 12}:00 PM ${DATA.ops.servicePeriods.timezone}; Dinner: after. Configurable in config/operations.json.`)}
          ${mrow('Baseline', `Same weekday + same service period, previous ${DATA.ops.baseline.weeks} weeks, weighted dollars (Σcost ÷ Σrevenue). Never its own baseline; partial availability disclosed.`)}
          ${mrow('OpenTable classification census', `${DATA.intents.length} sanitized visits (no guest PII stored) = ${censusParts.join(' + ')}${censusSum === DATA.intents.length ? ' — reconciles exactly' : ` (sum ${censusSum})`} · ${conv.halfHalf} carry a Half/Half note (metadata) · ${tri.badge} actionable`)}
          ${mrow('Matching rules', `Reservation time vs check-open time within ±${DATA.ops.opentableMatch.timeToleranceMinutes} minutes; dining room requires table + party compatibility; patio relies on time/party/area (guests self-seat); online ordering, bar, takeout, no-table, $0 and Host To Go checks are never candidates.`)}
          ${mrow('Food-cost precedence', 'Toast modifiers/notes and trivial drinks excluded → chef-confirmed costs → explicit portion overrides (½-lb shrimp $2.50, 1-pc crab cake $4) → explicit temporary costs → workbook estimates → $2 supplied-menu fallback → true missing (never $0).')}
          ${mrow('Recent imports', (DATA.importRuns ?? []).slice(0, 5).map((r) => `${esc(r.kind)} · ${fmtEt(r.created_at)} · ${esc(r.status)}${r.counts?.inserted != null ? ` · ${r.counts.inserted} new` : ''}${r.created_by_email ? ` · ${esc(r.created_by_email.split('@')[0])}` : ''}`).join('<br>') || '—')}
          ${mrow('Commission', `Pilot rates $5/$7.50/$10 per converted COVER, active ${fmtDate(DATA.ops.commission.activeFrom)}–${fmtDate(DATA.ops.commission.activeTo)} only. Program inactive — no new accrual.`)}
          ${mrow('Access model', 'The passcode screen is a presentation gate and authorizes nothing. Anonymous visitors have read-only access to the published dashboard data. Every write requires a signed-in, approved manager (Supabase Auth magic link) and is authorized in the database, so a direct API call is refused the same way. Audit rows carry the authenticated user id and email. Service credentials never reach the browser.')}
          ${mrow('CLI fallback', 'Administrator command-line tools remain in scripts/ (see docs/TECHNICAL_RUNBOOK.md) for credentials, backfills and operational recovery.')}
        </tbody></table>
        <div id="legacyMethod"></div>`;
        body.appendChild(wrap);
        loadPagesDeployment(wrap.querySelector('#deploySha'));
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
  /* `icon` is a name in the src/icons.mjs set, not a glyph — the shell resolves
     it through window.ACE_ICON when it draws the navigation. */
  PAGES.ops = { label: 'Overview', icon: 'overview', fn: pgOps, title: 'Operations overview', group: 'Operations',
    desc: 'AYCE mix, food cost and conversion for the selected range — dining room and patio only.' };
  PAGES.servers = { label: 'Server Performance', icon: 'servers', fn: pgServersLive, title: 'Server performance', group: 'Operations',
    desc: 'AYCE checks, sales, food cost and conversion per server. Open a row for check-level detail.' };
  PAGES.foodcost = { label: 'AYCE Food Cost', icon: 'foodcost', fn: pgFoodCost, title: 'AYCE food cost', group: 'Operations',
    desc: 'Estimated cost of AYCE food recorded in Toast against AYCE sales collected.' };
  PAGES.update = { label: 'Update Dashboard', icon: 'update', fn: (h) => withData(h, pgUpdate), title: 'Update Dashboard', group: 'Operations',
    desc: 'Keep Toast sales, OpenTable guest status and food costs current.' };
  PAGES.fixes = { label: 'Fixes Needed', icon: 'fixes', fn: (h) => withData(h, pgFixes), title: 'Fixes Needed', group: 'Operations', badge: 0,
    desc: 'The short list of visits that genuinely need a decision — one card at a time.' };
  PAGES.pilot = { label: 'Pilot Review', icon: 'pilot', fn: pgPilot, title: 'Pilot Review', group: 'Historical', pilotFilters: true,
    desc: 'Frozen pilot weekend, Jul 31 – Aug 2, 2026. Commission figures are informational.' };
  PAGES.help = { label: 'How This Works', icon: 'help', fn: pgHelp, title: 'How This Works', group: 'Help',
    desc: 'Where the numbers come from, in plain language, with the technical detail one click away.' };

  // land on Operations Overview unless the visitor SAVED a page earlier;
  // stale saved pages from previous versions map to their nearest new home
  const remap = { overview: 'pilot', servers: 'servers', commission: 'pilot', method: 'help', review: 'fixes', import: 'update' };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('ace.page')); } catch { /* fresh visitor */ }
  if (saved && PAGES[saved]) S.page = saved;
  else if (saved && remap[saved]) S.page = remap[saved];
  else S.page = 'ops';
}
registerPages();

const CTX = {
  APP, DATA, helpers, fmtDate, opDates,
  reload: reloadLive,
  // background data refresh: updates badge + freshness but leaves the current
  // page DOM alone (so upload success messages and the user's active filters,
  // tabs and scroll position survive the refresh untouched)
  refreshData: () => { DATA.loading = null; DATA.loaded = false; return loadLive(); },
  loadLive,
  fetchDetail,
};
initUpdatePage(CTX);
initFixesPage(CTX);
configReady.then((cfg) => initManagerMode(APP, cfg));
loadLive();
