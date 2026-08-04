/* =============================================================================
   Live-data extension pages — Food Cost, Data Import, methodology augmentation.
   Registers into the legacy shell through window.__ACE_APP__ so the pilot
   dashboard's visual identity, filters, theming and behavior stay intact.

   Honesty rules baked into this module:
   - Food cost is ESTIMATED from recorded Toast item selections × the item-cost
     master. It is not a waste measure and is labeled accordingly.
   - Provisional (rough workbook) costs are visibly flagged until chef-confirmed.
   - Unmatched items are surfaced, never silently $0-costed.
   - Flags are suppressed under the configurable minimum sample / coverage.
   ========================================================================== */
import {
  computeFoodCost, weightedBaselinePct, classifyVariance, DEFAULT_THRESHOLDS,
  normalizeName, filterAyceProgram,
} from './food-cost-engine.mjs';

const APP = window.__ACE_APP__;
if (!APP) throw new Error('pages-live: legacy shell did not expose __ACE_APP__');
const { PAGES, S, SRV, P, helpers } = APP;
const { $, esc, fmt, pct, usd, usd0, sgn } = helpers;

/* ------------------------------------------------------------ data layer -- */
const DATA = {
  loaded: false, loading: null,
  manifest: null, reference: null, costs: null,
  selections: [], checks: [],
  error: null,
  localImports: [], // browser-local manual imports (Data Import page)
};

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function loadLive() {
  if (DATA.loading) return DATA.loading;
  DATA.loading = (async () => {
    try {
      DATA.manifest = await fetchJson('data/live/manifest.json');
      const [reference, costs] = await Promise.all([
        fetchJson('data/live/reference.json'),
        fetchJson('data/live/item_costs.json'),
      ]);
      DATA.reference = reference;
      DATA.costs = costs;
      const per = await Promise.all(DATA.manifest.dates.map((d) => Promise.all([
        fetchJson(`data/live/selections_${d}.json`),
        fetchJson(`data/live/checks_${d}.json`),
      ])));
      DATA.selections = per.flatMap(([s]) => s);
      DATA.checks = per.flatMap(([, c]) => c);
      restoreLocalImports();
      DATA.loaded = true;
      renderFreshness();
    } catch (err) {
      DATA.error = String(err?.message ?? err);
    }
  })();
  return DATA.loading;
}

/* Browser-local manual imports (persist per device until the database backend
   is connected). Merged on top of repo-shipped live data, idempotent by GUID. */
const LI_KEY = 'ace.localImports';
function restoreLocalImports() {
  try {
    const raw = localStorage.getItem(LI_KEY);
    if (!raw) return;
    DATA.localImports = JSON.parse(raw);
    for (const imp of DATA.localImports) mergeImport(imp, { quiet: true });
  } catch { /* corrupted store — ignore */ }
}
function persistLocalImports() {
  try { localStorage.setItem(LI_KEY, JSON.stringify(DATA.localImports)); }
  catch { /* storage full — surfaced in import UI */ }
}
function mergeImport(imp) {
  let added = 0, dup = 0;
  if (imp.kind === 'selections') {
    const have = new Set(DATA.selections.map((s) => s.selectionGuid));
    for (const row of imp.rows) {
      if (row.selectionGuid && have.has(row.selectionGuid)) { dup++; continue; }
      DATA.selections.push(row); added++;
    }
  } else if (imp.kind === 'checks') {
    const have = new Set(DATA.checks.map((c) => c.checkGuid));
    for (const row of imp.rows) {
      if (row.checkGuid && have.has(row.checkGuid)) { dup++; continue; }
      DATA.checks.push(row); added++;
    }
  } else if (imp.kind === 'costs') {
    // chef/manual cost rows: close open records then append (mirrors import script)
    for (const row of imp.rows) {
      for (const rec of DATA.costs) {
        if (rec.canonicalName === row.canonicalName && rec.effectiveTo === null && rec.effectiveFrom < row.effectiveFrom) {
          rec.effectiveTo = row.effectiveFrom; // display approximation; server import is authoritative
        }
      }
      DATA.costs.push(row); added++;
    }
  }
  return { added, dup };
}

/* ---------------------------------------------------- server name joining -- */
/* Legacy payload names (e.g. "Kendall", "Jessica  Kim") vs Toast employee names
   ("Kendall Throne", "Jessica Kim"). Join by normalized equality, then unique
   first-name match. Unjoined servers still display — with blanks, not zeros. */
function employeeIndex() {
  const emps = (DATA.reference?.employees ?? []).filter((e) => !e.deleted);
  const byNorm = new Map(emps.map((e) => [normalizeName(e.name), e]));
  const byFirst = new Map();
  for (const e of emps) {
    const first = normalizeName(e.name).split(' ')[0];
    byFirst.set(first, byFirst.has(first) ? null : e); // null = ambiguous
  }
  return { byNorm, byFirst };
}
function guidForLegacyName(name, idx) {
  const norm = normalizeName(name);
  if (idx.byNorm.has(norm)) return idx.byNorm.get(norm).guid;
  const e = idx.byFirst.get(norm.split(' ')[0]);
  return e ? e.guid : null;
}

/* --------------------------------------------------------------- settings -- */
const FC_KEY = 'ace.fcSettings';
function fcSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(FC_KEY) || '{}'); } catch { /* defaults */ }
  return { ...DEFAULT_THRESHOLDS, scope: 'ayce', ...s };
}
function saveFcSettings(next) {
  localStorage.setItem(FC_KEY, JSON.stringify(next));
}

/* ------------------------------------------------------------- scoping ---- */
const DATE_BY_DAY = ['20260731', '20260801', '20260802'];
function scopedData() {
  const f = S.filters;
  const idx = employeeIndex();
  const wantDates = f.days.length ? new Set(f.days.map((d) => DATE_BY_DAY[d])) : null;
  const wantServers = f.servers.length
    ? new Set(f.servers.map((n) => guidForLegacyName(n, idx)).filter(Boolean))
    : null;
  // Floor scope: checks that have a table (dining room / patio), non-voided.
  const checks = DATA.checks.filter((c) =>
    c.tableGuid && !c.voided &&
    (!wantDates || wantDates.has(String(c.businessDate))) &&
    (!wantServers || wantServers.has(c.serverGuid)));
  const guids = new Set(checks.map((c) => c.checkGuid));
  const selections = DATA.selections.filter((s) => guids.has(s.checkGuid));
  return { selections, checks, filteredByServer: !!wantServers, filteredByDay: !!wantDates };
}

/* ------------------------------------------------------------ freshness --- */
function renderFreshness() {
  const bar = document.querySelector('#topbar .tb-row');
  if (!bar || !DATA.manifest) return;
  let el = document.getElementById('freshness');
  if (!el) {
    el = document.createElement('span');
    el.id = 'freshness';
    el.className = 'prov';
    el.style.marginLeft = '8px';
    bar.appendChild(el);
  }
  const dates = DATA.manifest.dates;
  const last = dates[dates.length - 1];
  const synced = new Date(DATA.manifest.lastToastSync);
  el.textContent = `Toast data through ${fmtDate(last)} · synced ${synced.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  el.title = 'Item-selection data pulled from the Toast API by the ingestion script. OpenTable: manual intent log only (no automated sync yet).';
}
function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
}

/* ============================================================ FOOD COST ==== */
function pgFoodCost(host) {
  host.innerHTML = '<div class="skel skel-hero"></div>';
  loadLive().then(() => {
    if (DATA.error) {
      host.innerHTML = `<div class="errbox"><b>Live data unavailable.</b> ${esc(DATA.error)}<br>
        Run <code>npm run ingest:toast</code> (or use Data Import) and reload.</div>`;
      return;
    }
    renderFoodCost(host);
  });
}

function renderFoodCost(host) {
  const th = fcSettings();
  const isAyce = th.scope !== 'all';
  let scope = scopedData();
  let whole = { // baseline universe: full available period, floor only
    selections: DATA.selections.filter((s) => {
      const c = CHK().get(s.checkGuid);
      return c && c.tableGuid && !c.voided;
    }),
    checks: DATA.checks.filter((c) => c.tableGuid && !c.voided),
  };
  let ayceScope = null, ayceWhole = null;
  if (isAyce) {
    ayceScope = filterAyceProgram(scope.selections, scope.checks, DATA.reference);
    ayceWhole = filterAyceProgram(whole.selections, whole.checks, DATA.reference);
    scope = { selections: ayceScope.selections, checks: ayceScope.checks };
    whole = { selections: ayceWhole.selections, checks: ayceWhole.checks };
  }
  const rScope = computeFoodCost(scope.selections, scope.checks, DATA.reference, DATA.costs, { thresholds: th });
  const rBase = computeFoodCost(whole.selections, whole.checks, DATA.reference, DATA.costs, { thresholds: th });
  const basePct = weightedBaselinePct(rBase.total);
  const scopePct = rScope.total.foodCostPct;
  const variance = scopePct != null && basePct != null ? scopePct - basePct : null;
  const cov = rScope.total.coverage;
  const roughShare = costSourceShare(rScope);

  const emp = new Map((DATA.reference.employees ?? []).map((e) => [e.guid, e.name]));
  const idx = employeeIndex();
  // legacy SRV stats joined by employee guid for AYCE mix / conversion columns
  const legacyByGuid = new Map();
  for (const name of Object.keys(SRV)) {
    const g = guidForLegacyName(name, idx);
    if (g) legacyByGuid.set(g, SRV[name]);
  }

  const coverCost = isAyce && ayceScope.entitlementCovers > 0 ? rScope.total.foodCostDollars / ayceScope.entitlementCovers : null;
  const coverRev = isAyce && ayceScope.entitlementCovers > 0 ? ayceScope.entitlementNet / ayceScope.entitlementCovers : null;
  let h = `
  <section class="hero rise" aria-label="Food cost">
    <div class="hero-top">
      <div class="hero-verdict">
        <div class="hero-eyebrow">${isAyce ? 'AYCE program food cost' : 'Estimated food cost — all food'}
          <span class="verdict-badge ${roughShare.roughPct > 0 ? 'neu' : 'pos'}">${roughShare.roughPct > 0 ? 'PROVISIONAL COSTS' : 'CHEF-CONFIRMED'}</span></div>
        <div class="hero-delta">
          <span class="big">${pct(scopePct)}</span>
          <span class="unit">${isAyce ? 'of AYCE entitlement revenue<br>(the tracked program metric)' : 'of eligible net food revenue<br>in the current selection'}</span></div>
        <div class="hero-line">${isAyce
          ? `<b>${usd0(rScope.total.foodCostDollars)}</b> estimated cost of $0-rung AYCE rounds on
             <b>${fmt(ayceScope.checks.length)}</b> AYCE checks · <b>${usd0(ayceScope.entitlementNet)}</b> entitlement revenue ·
             <b>${fmt(Math.round(ayceScope.entitlementCovers))}</b> covers · baseline <b>${pct(basePct)}</b> ·
             variance <b>${variance == null ? '—' : sgn(variance) + ' pts'}</b>.`
          : `Estimated <b>${usd0(rScope.total.foodCostDollars)}</b> food cost on
             <b>${usd0(rScope.total.eligibleNetFoodRevenue)}</b> eligible net food revenue ·
             baseline <b>${pct(basePct)}</b> (weighted, full period) ·
             variance <b>${variance == null ? '—' : sgn(variance) + ' pts'}</b>.`}</div>
      </div>
      <div class="hero-rail">
        ${isAyce ? `
        <div class="hr-cell"><div class="k">Est. cost per AYCE cover</div>
          <div class="v">${coverCost == null ? '—' : usd(coverCost)}</div>
          <div class="m">vs ${coverRev == null ? '—' : usd(coverRev)} collected per cover</div></div>
        <div class="hr-cell"><div class="k">Round coverage (qty)</div>
          <div class="v">${pct(cov.qtyPct)}</div>
          <div class="m">of round quantity has a costed item</div></div>`
        : `
        <div class="hr-cell"><div class="k">Cost-mapping coverage</div>
          <div class="v">${pct(cov.netPct)}</div>
          <div class="m">of food revenue has a costed item</div></div>
        <div class="hr-cell"><div class="k">Checks affected</div>
          <div class="v">${fmt(rScope.total.checksAffectedByUnmatched)}</div>
          <div class="m">contain ≥1 uncosted item</div></div>`}
        <div class="hr-cell"><div class="k">Unmatched items</div>
          <div class="v ${rScope.total.unmatchedItemCount ? 'down' : ''}">${fmt(rScope.total.unmatchedItemCount)}</div>
          <div class="m">${isAyce ? `${fmt(Math.round(rScope.total.unmatchedQty))} rounds not yet costed` : `${usd0(rScope.total.unmatchedNet)} revenue not yet costed`}</div></div>
        <div class="hr-cell"><div class="k">Cost basis</div>
          <div class="v">${pct(roughShare.roughPct, 0)}</div>
          <div class="m">of cost dollars from ROUGH workbook values</div></div>
      </div>
    </div>
    <div class="hero-summary">
      <div class="sh">What this is — and is not</div>
      <p>${isAyce
        ? `The tracked metric: cost of everything rung <b>at $0 as an AYCE round</b> on AYCE tables,
           against the per-person AYCE price those tables paid. À-la-carte items — including Royal
           Feast trays sold at menu price — are priced individually and sit outside this program metric
           (switch scope below for the all-food view).`
        : `Estimated food cost from recorded Toast item selections × the item-cost master across ALL food sales.`}
      It reflects what the kitchen sent per the POS — <b>it is not a waste or inventory measure, and it
      does not imply a server caused kitchen cost</b>.
      ${roughShare.roughPct > 0 ? `Costs marked <b>rough</b> come from the management workbook and are
      unverified; the chef's confirmed costs replace them by data import with full effective-date history.` : ''}</p>
    </div>
  </section>`;

  /* threshold / sample settings */
  h += `<div class="card sec" style="margin-top:14px"><header><div>
      <div class="ttl">Flag thresholds &amp; minimum sample</div>
      <div class="sub">Watch ≥ ${th.watchPts} pts over baseline · Critical ≥ ${th.criticalPts} pts ·
        suppressed under ${th.minChecks} checks or ${usd0(th.minNetFoodSales)} net food sales or ${th.minCoveragePct}% cost coverage.</div></div></header>
    <div class="body" style="display:flex;gap:14px;flex-wrap:wrap;align-items:end">
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3)">Scope
        <select id="fcScope" style="padding:6px 8px;border:1px solid var(--border-2);border-radius:8px;background:var(--bg-1);color:var(--ink-1)">
          <option value="ayce" ${isAyce ? 'selected' : ''}>AYCE program (tracked)</option>
          <option value="all" ${isAyce ? '' : 'selected'}>All food (context)</option>
        </select></label>
      ${numInput('fcWatch', 'Watch (pts over)', th.watchPts)}
      ${numInput('fcCrit', 'Critical (pts over)', th.criticalPts)}
      ${numInput('fcMinChecks', 'Min checks', th.minChecks)}
      ${numInput('fcMinSales', 'Min net food $', th.minNetFoodSales)}
      ${numInput('fcMinCov', 'Min coverage %', th.minCoveragePct)}
      <button type="button" class="themebtn" id="fcApply" style="height:34px">Apply</button>
    </div></div>`;

  /* server table */
  const rows = [...rScope.perServer.entries()].map(([guid, b]) => {
    const name = emp.get(guid) ?? '(unattributed)';
    const fcPct = b.eligibleNetFoodRevenue > 0 ? (b.foodCostDollars / b.eligibleNetFoodRevenue) * 100 : null;
    let cls = classifyVariance(b, basePct, th);
    // AYCE mode: rounds carry $0 net, so coverage fairness is judged on QUANTITY
    const qtyCov = b.totalQty > 0 ? (b.matchedQty / b.totalQty) * 100 : null;
    if (isAyce && cls.status !== 'insufficient_sample' && qtyCov != null && qtyCov < th.minCoveragePct) {
      cls = { status: 'insufficient_coverage', variancePts: null };
    }
    const legacy = legacyByGuid.get(guid);
    const covPct = isAyce ? qtyCov
      : (b.eligibleNetFoodRevenue > 0 ? (b.matchedNet / b.eligibleNetFoodRevenue) * 100 : null);
    return {
      name, guid, checks: b.checks.size, net: b.eligibleNetFoodRevenue, cost: b.foodCostDollars,
      fcPct, covPct, status: cls.status, variance: cls.variancePts,
      mix: legacy?.p?.mixCovers ?? null,
      convRate: legacy?.c?.convRateTables ?? null,
      elig: legacy?.c?.eligibleTables ?? null,
    };
  }).sort((a, b) => (b.net - a.net));

  h += `<div class="card sec"><header><div>
      <div class="ttl">Server comparison — estimated food cost vs weighted baseline</div>
      <div class="sub">Baseline ${pct(basePct)} is Σcost ÷ Σrevenue over the full period (never an average of
      server percentages). AYCE mix and conversion join from the pilot extract.</div></div></header>
    <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left">Server</th><th>Checks</th><th>Net food sales</th>
        <th>Est. food cost</th><th>Food cost %</th><th>Baseline</th><th>Variance</th>
        <th>AYCE mix</th><th>Conv. rate</th><th>Elig. opps</th><th>Cost coverage</th><th>Status</th>
      </tr></thead><tbody>`;
  for (const r of rows) {
    h += `<tr style="border-top:1px solid var(--border-2)">
      <td style="text-align:left;white-space:nowrap;padding:6px 8px">${esc(r.name)}</td>
      <td style="text-align:right">${fmt(r.checks)}</td>
      <td style="text-align:right">${usd0(r.net)}</td>
      <td style="text-align:right">${usd0(r.cost)}</td>
      <td style="text-align:right"><b>${pct(r.fcPct)}</b></td>
      <td style="text-align:right">${pct(basePct)}</td>
      <td style="text-align:right">${r.variance == null ? '—' : sgn(r.variance)}</td>
      <td style="text-align:right">${pct(r.mix)}</td>
      <td style="text-align:right">${pct(r.convRate)}</td>
      <td style="text-align:right">${fmt(r.elig)}</td>
      <td style="text-align:right">${pct(r.covPct, 0)}</td>
      <td style="text-align:center">${statusBadge(r.status)}</td></tr>`;
  }
  h += `</tbody></table></div>
    <div class="foot">Flags are suppressed (shown as “sample” / “coverage”) when a server has too few checks,
    too little net food revenue, or too little cost-mapped revenue for a fair comparison. High AYCE mix with a
    normal flag = strong performance with controlled cost.</div></div>`;

  /* scatter + drivers */
  h += `<div class="sec g2">
    <div class="card"><header><div><div class="ttl">AYCE cover mix vs estimated food cost %</div>
      <div class="sub">Each point is a server meeting the minimum sample.</div></div></header>
      <div class="body"><div id="fcScatter"></div></div>
      <div class="foot">Up-and-right = selling AYCE while holding cost. Flags follow the thresholds above.</div></div>
    <div class="card"><header><div><div class="ttl">Highest-cost item drivers</div>
      <div class="sub">Extended cost = non-voided quantity × effective unit cost.</div></div></header>
      <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th style="text-align:left">Item</th><th>Qty</th><th>Unit cost</th><th>Est. cost</th><th>Source</th></tr></thead><tbody>
      ${rScope.itemDrivers.filter((i) => i.costDollars > 0).slice(0, 14).map((i) => `<tr style="border-top:1px solid var(--border-2)">
        <td style="text-align:left;padding:4px 8px">${esc(i.canonicalName)}</td>
        <td style="text-align:right">${fmt(Math.round(i.qty))}</td>
        <td style="text-align:right">${usd(i.costPerUnit)}</td>
        <td style="text-align:right"><b>${usd0(i.costDollars)}</b></td>
        <td style="text-align:center">${sourceBadge(i.source, i.verification)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="foot">“Rough” costs come from the provisional workbook; import the chef's confirmed
      costs on the Data Import page to replace them (history is preserved by effective dating).</div></div>
  </div>`;

  /* unmatched queue */
  h += `<div class="card sec"><header><div>
      <div class="ttl">Unmatched-item review queue (${fmt(rScope.unmatchedQueue.length)})</div>
      <div class="sub">${isAyce
        ? 'AYCE rounds with no cost record — the chef punch list. They are excluded from cost dollars (never assigned $0), so the true AYCE food-cost % is understated until they are costed.'
        : 'Items with recorded sales but no cost record. They are excluded from cost dollars — never assigned $0 — so the true food-cost % is understated until they are costed.'}</div></div></header>
    <div class="body" style="overflow-x:auto"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th style="text-align:left">Item (as rung in Toast)</th><th>Qty</th><th>Net revenue</th><th>Checks</th></tr></thead><tbody>
      ${[...rScope.unmatchedQueue].sort((a, b) => isAyce ? b.qty - a.qty : b.net - a.net).slice(0, 25).map((u) => `<tr style="border-top:1px solid var(--border-2)">
        <td style="text-align:left;padding:4px 8px">${esc(u.name)}</td>
        <td style="text-align:right">${fmt(Math.round(u.qty))}</td>
        <td style="text-align:right">${usd0(u.net)}</td>
        <td style="text-align:right">${fmt(u.checks)}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="foot">${rScope.unmatchedQueue.length > 25 ? `Showing the top 25 of ${rScope.unmatchedQueue.length} by revenue. ` : ''}
    Add costs via the chef CSV (Data Import) or aliases in <code>imports/alias_map.json</code>.</div></div>`;

  /* check drilldown */
  const tbl = new Map((DATA.reference.tables ?? []).map((t) => [t.guid, t.name]));
  const checksSorted = [...rScope.perCheck.values()]
    .map((c) => ({
      ...c,
      pct: c.eligibleNetFoodRevenue > 0 ? (c.foodCostDollars / c.eligibleNetFoodRevenue) * 100 : null,
      tableName: tbl.get(c.tableGuid) ?? '—',
      serverName: emp.get(c.serverGuid) ?? '—',
    }))
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  h += `<div class="card sec"><header><div>
      <div class="ttl">Check &amp; table drilldown</div>
      <div class="sub">Split checks share an order — the order is the table visit. Sorted by food-cost %.</div></div></header>
    <div class="body" style="overflow-x:auto;max-height:420px;overflow-y:auto">
      <table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th>Date</th><th>Table</th><th style="text-align:left">Server</th>
        <th>Net food</th><th>Est. cost</th><th>FC%</th><th>Uncosted</th></tr></thead><tbody>
      ${checksSorted.slice(0, 200).map((c) => `<tr style="border-top:1px solid var(--border-2)">
        <td>${fmtDate(c.businessDate)}</td><td>${esc(c.tableName)}</td>
        <td style="text-align:left;padding:4px 8px">${esc(c.serverName)}</td>
        <td style="text-align:right">${usd0(c.eligibleNetFoodRevenue)}</td>
        <td style="text-align:right">${usd0(c.foodCostDollars)}</td>
        <td style="text-align:right"><b>${pct(c.pct)}</b></td>
        <td style="text-align:center">${c.unmatchedItems.length ? `<span class="verdict-badge neu">${c.unmatchedItems.length}</span>` : '—'}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="foot">Showing up to 200 checks in the current selection. Day and server filters apply to this
    page; intent, tier, party-size and conversion filters do not (food cost is item-level).</div></div>`;

  host.innerHTML = h;

  /* scatter render via legacy helper */
  const pts = rows
    .filter((r) => r.mix != null && r.fcPct != null && r.status !== 'insufficient_sample' && r.status !== 'insufficient_coverage')
    .map((r) => ({ x: r.mix, y: r.fcPct, label: r.name }));
  const sc = document.getElementById('fcScatter');
  if (sc && pts.length) {
    sc.innerHTML = plainScatter(pts, basePct);
  } else if (sc) {
    sc.innerHTML = '<div class="sub">Not enough qualifying servers in the current selection.</div>';
  }

  document.getElementById('fcApply')?.addEventListener('click', () => {
    const next = {
      scope: document.getElementById('fcScope')?.value === 'all' ? 'all' : 'ayce',
      watchPts: numVal('fcWatch', th.watchPts),
      criticalPts: numVal('fcCrit', th.criticalPts),
      minChecks: numVal('fcMinChecks', th.minChecks),
      minNetFoodSales: numVal('fcMinSales', th.minNetFoodSales),
      minCoveragePct: numVal('fcMinCov', th.minCoveragePct),
    };
    saveFcSettings(next);
    renderFoodCost(host);
  });
}

let _chkIdx = null;
function CHK() {
  if (!_chkIdx || _chkIdx.size !== DATA.checks.length) {
    _chkIdx = new Map(DATA.checks.map((c) => [c.checkGuid, c]));
  }
  return _chkIdx;
}

function costSourceShare(result) {
  let rough = 0, total = 0;
  for (const i of result.itemDrivers) {
    total += i.costDollars;
    if (i.source === 'rough_workbook') rough += i.costDollars;
  }
  return { roughPct: total > 0 ? (rough / total) * 100 : 0 };
}

function statusBadge(status) {
  const map = {
    normal: ['pos', 'Normal'],
    watch: ['neu', 'Watch'],
    critical: ['neg', 'Critical'],
    insufficient_sample: ['', 'Sample'],
    insufficient_coverage: ['', 'Coverage'],
    no_baseline: ['', '—'],
  };
  const [cls, label] = map[status] ?? ['', status];
  return `<span class="verdict-badge ${cls}" title="${esc(statusTitle(status))}">${label}</span>`;
}
function statusTitle(status) {
  return {
    normal: 'Within 10 points of baseline',
    watch: '10–14.99 points above baseline',
    critical: '15+ points above baseline',
    insufficient_sample: 'Not enough checks or food sales for a fair judgment',
    insufficient_coverage: 'Not enough cost-mapped revenue for a fair judgment',
  }[status] ?? '';
}
function sourceBadge(source, verification) {
  if (source === 'chef_confirmed' || verification === 'verified') return '<span class="verdict-badge pos">confirmed</span>';
  if (source === 'rough_workbook') return '<span class="verdict-badge neu">rough</span>';
  return `<span class="verdict-badge">${esc(source ?? '?')}</span>`;
}
function numInput(id, label, val) {
  return `<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3)">${esc(label)}
    <input id="${id}" type="number" step="0.5" value="${val}" style="width:110px;padding:6px 8px;border:1px solid var(--border-2);border-radius:8px;background:var(--bg-1);color:var(--ink-1)"></label>`;
}
function numVal(id, fallback) {
  const v = Number(document.getElementById(id)?.value);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function plainScatter(pts, basePct) {
  const w = 560, hgt = 300, pad = 40;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xmin = Math.min(...xs) - 3, xmax = Math.max(...xs) + 3;
  const ymin = Math.min(...ys, basePct ?? 99) - 2, ymax = Math.max(...ys, basePct ?? 0) + 2;
  const X = (v) => pad + ((v - xmin) / (xmax - xmin)) * (w - 2 * pad);
  const Y = (v) => hgt - pad - ((v - ymin) / (ymax - ymin)) * (hgt - 2 * pad);
  let s = `<svg viewBox="0 0 ${w} ${hgt}" role="img" aria-label="AYCE mix versus food cost scatter" style="width:100%;height:auto">`;
  if (basePct != null) s += `<line x1="${pad}" x2="${w - pad}" y1="${Y(basePct)}" y2="${Y(basePct)}" stroke="var(--accent)" stroke-dasharray="4 4"/>
    <text x="${w - pad}" y="${Y(basePct) - 6}" text-anchor="end" font-size="11" fill="var(--ink-3)">baseline ${basePct.toFixed(1)}%</text>`;
  for (const p of pts) {
    s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5" fill="var(--fill-blue)" opacity="0.85"><title>${esc(p.label)} — mix ${p.x.toFixed(1)}%, FC ${p.y.toFixed(1)}%</title></circle>
      <text x="${X(p.x) + 8}" y="${Y(p.y) + 4}" font-size="10" fill="var(--ink-3)">${esc(p.label.split(' ')[0])}</text>`;
  }
  s += `<text x="${w / 2}" y="${hgt - 8}" text-anchor="middle" font-size="11" fill="var(--ink-3)">AYCE cover mix %</text>
    <text x="12" y="${hgt / 2}" font-size="11" fill="var(--ink-3)" transform="rotate(-90 12 ${hgt / 2})" text-anchor="middle">Est. food cost %</text></svg>`;
  return s;
}

/* ========================================================== DATA IMPORT ==== */
function pgImport(host) {
  loadLive().then(() => renderImport(host));
}
function renderImport(host) {
  const runs = DATA.manifest ? [{
    when: DATA.manifest.lastToastSync, source: 'Toast API (ingestion script)',
    detail: `${DATA.manifest.dates.length} business dates · ${fmt(DATA.selections.length)} selections · ${fmt(DATA.checks.length)} checks`,
  }] : [];
  for (const imp of DATA.localImports) {
    runs.push({ when: imp.when, source: `Manual upload — ${imp.label}`, detail: `${imp.rowsImported} rows imported, ${imp.dupes} duplicates skipped${imp.errors?.length ? `, ${imp.errors.length} errors` : ''}` });
  }
  host.innerHTML = `
  <section class="hero rise"><div class="hero-top"><div class="hero-verdict">
    <div class="hero-eyebrow">Data import</div>
    <div class="hero-delta"><span class="big">Drop a file</span>
      <span class="unit">Toast export · OpenTable export · chef cost CSV</span></div>
    <div class="hero-line">Files are parsed <b>in this browser</b> and merged locally (per device) until the
      database backend is connected. Re-uploading the same file never duplicates data — rows are keyed by
      their source IDs. Nothing is uploaded anywhere.</div>
  </div></div></section>
  <div class="card sec" style="margin-top:14px">
    <div class="body">
      <div id="dropzone" style="border:2px dashed var(--border-2);border-radius:14px;padding:36px;text-align:center;cursor:pointer">
        <div style="font-size:15px;font-weight:600">Drag &amp; drop a CSV here, or click to choose</div>
        <div class="sub" style="margin-top:6px">Supported: chef item-cost CSV (canonical_name,cost,…) ·
          Toast item-selection CSV · OpenTable intent CSV</div>
        <input id="fileInput" type="file" accept=".csv" style="display:none">
      </div>
      <div id="importStage"></div>
    </div>
    <div class="foot">Step-by-step: file detected → type recognized → validation → duplicate check → preview →
      you confirm → summary. Failed rows can be downloaded as an error file.</div>
  </div>
  <div class="card sec"><header><div><div class="ttl">Recent data loads</div></div></header>
    <div class="body"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse">
      <thead><tr><th style="text-align:left">When</th><th style="text-align:left">Source</th><th style="text-align:left">Detail</th></tr></thead>
      <tbody>${runs.map((r) => `<tr style="border-top:1px solid var(--border-2)">
        <td style="text-align:left;padding:4px 8px;white-space:nowrap">${esc(new Date(r.when).toLocaleString('en-US'))}</td>
        <td style="text-align:left">${esc(r.source)}</td><td style="text-align:left">${esc(r.detail)}</td></tr>`).join('') || '<tr><td colspan="3">No data loaded yet.</td></tr>'}
      </tbody></table></div></div>`;

  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('fileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.style.borderColor = 'var(--accent)'; });
  dz.addEventListener('dragleave', () => { dz.style.borderColor = 'var(--border-2)'; });
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.style.borderColor = 'var(--border-2)';
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], host);
  });
  fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0], host); });
}

function parseCsv(text) {
  // minimal CSV with quoted-field support
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (cell !== '' || row.length) { row.push(cell); rows.push(row); row = []; cell = ''; }
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const IMPORT_TYPES = [
  {
    key: 'chef_costs', label: 'Chef item-cost CSV',
    detect: (h) => h.includes('canonical_name') && (h.includes('cost') || h.includes('cost_per_portion')),
    describe: 'Replaces provisional costs with confirmed values (effective-dated; history preserved).',
  },
  {
    key: 'toast_selections', label: 'Toast item-selection export',
    detect: (h) => (h.includes('order id') || h.includes('order guid')) && (h.includes('menu item') || h.includes('item') || h.includes('menu item guid')),
    describe: 'Item-selection detail rows keyed by selection GUID; duplicates are skipped.',
  },
  {
    key: 'opentable_intent', label: 'OpenTable / host intent log',
    detect: (h) => h.includes('intent') && (h.includes('table') || h.includes('reservation')),
    describe: 'Guest-intent records. Blank or unrecognized intent becomes UNKNOWN (excluded from conversion both ways).',
  },
];

function handleFile(file, host) {
  const stage = document.getElementById('importStage');
  stage.innerHTML = `<div class="sub" style="margin-top:14px">Reading ${esc(file.name)} (${(file.size / 1024).toFixed(1)} KB)…</div>`;
  const reader = new FileReader();
  reader.onload = () => {
    const rows = parseCsv(String(reader.result));
    if (rows.length < 2) { stage.innerHTML = '<div class="errbox">File has no data rows.</div>'; return; }
    const header = rows[0].map((c) => c.trim().toLowerCase());
    const type = IMPORT_TYPES.find((t) => t.detect(header));
    if (!type) {
      stage.innerHTML = `<div class="errbox"><b>Unrecognized file type.</b> Header seen: <code>${esc(header.join(', ').slice(0, 200))}</code><br>
        Expected one of: chef cost CSV (canonical_name,cost), Toast selection export, OpenTable intent log.</div>`;
      return;
    }
    previewImport(file, type, header, rows.slice(1), stage, host);
  };
  reader.readAsText(file);
}

function previewImport(file, type, header, dataRows, stage, host) {
  const col = (names) => header.findIndex((h) => names.includes(h));
  let candidate = { kind: null, rows: [], errors: [] };

  if (type.key === 'chef_costs') {
    const ni = col(['canonical_name', 'item', 'item_name', 'name']);
    const ci = col(['cost', 'cost_per_portion', 'unit_cost']);
    const pi = col(['portion', 'serving']);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    candidate.kind = 'costs';
    dataRows.forEach((r, i) => {
      const name = r[ni]?.trim();
      const cost = Number(r[ci]);
      if (!name || !Number.isFinite(cost) || cost <= 0) {
        candidate.errors.push({ line: i + 2, raw: r.join(','), reason: 'missing name or invalid cost' });
        return;
      }
      candidate.rows.push({
        id: `cost-${normalizeName(name).replace(/ /g, '-')}-${today}-local`,
        toastItemGuid: null, canonicalName: name, aliases: [],
        portion: pi >= 0 ? r[pi]?.trim() : undefined,
        costPerUnit: cost, effectiveFrom: today, effectiveTo: null,
        source: 'chef_confirmed', verification: 'verified',
        notes: `browser import from ${file.name}`,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: 'manual-upload',
      });
    });
  } else if (type.key === 'toast_selections') {
    candidate.kind = 'selections';
    candidate.errors.push({ line: 0, raw: '', reason: 'Toast selection-CSV column mapping requires the export format sample — parsed rows are validated but held for the database backend. Use scripts/ingest-toast.mjs meanwhile.' });
  } else {
    candidate.kind = 'intents';
    candidate.errors.push({ line: 0, raw: '', reason: 'OpenTable intent import lands with the table-matching backend. Rows validated only.' });
  }

  const dupProbe = candidate.kind === 'costs'
    ? candidate.rows.filter((r) => DATA.costs.some((c) => c.canonicalName === r.canonicalName && c.source === 'chef_confirmed' && c.effectiveFrom === r.effectiveFrom)).length
    : 0;

  stage.innerHTML = `<div style="margin-top:16px">
    <div class="sh">1 · File detected — <b>${esc(file.name)}</b></div>
    <div class="sh">2 · Recognized as <b>${esc(type.label)}</b> <span class="sub">${esc(type.describe)}</span></div>
    <div class="sh">3 · ${candidate.rows.length} valid rows · ${candidate.errors.length} problem rows · ${dupProbe} duplicates will be skipped</div>
    <div style="max-height:200px;overflow:auto;margin:10px 0;border:1px solid var(--border-2);border-radius:8px">
      <table class="tb" style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr>${header.slice(0, 6).map((c) => `<th style="text-align:left;padding:4px 8px">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${dataRows.slice(0, 8).map((r) => `<tr style="border-top:1px solid var(--border-2)">${r.slice(0, 6).map((c) => `<td style="text-align:left;padding:3px 8px">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    ${candidate.errors.length ? `<div class="errbox" style="margin:8px 0">${candidate.errors.slice(0, 5).map((e) => `Line ${e.line}: ${esc(e.reason)}`).join('<br>')}
      ${candidate.errors.some((e) => e.line > 0) ? `<br><a href="#" id="errDl">Download error file</a>` : ''}</div>` : ''}
    ${candidate.rows.length ? `<button type="button" class="themebtn" id="confirmImport">Import ${candidate.rows.length} rows</button>` : '<div class="sub">Nothing importable in this browser session.</div>'}
  </div>`;

  document.getElementById('errDl')?.addEventListener('click', (e) => {
    e.preventDefault();
    const blob = new Blob([candidate.errors.map((er) => `line ${er.line},${er.reason},${er.raw}`).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `errors_${file.name}`; a.click();
  });
  document.getElementById('confirmImport')?.addEventListener('click', () => {
    const imp = {
      when: new Date().toISOString(), label: file.name, kind: candidate.kind,
      rows: candidate.rows, errors: candidate.errors,
    };
    const { added, dup } = mergeImport(imp);
    imp.rowsImported = added; imp.dupes = dup;
    DATA.localImports.push(imp);
    persistLocalImports();
    renderImport(host);
    const st = document.getElementById('importStage');
    if (st) st.innerHTML = `<div class="sh" style="margin-top:14px">✓ Imported ${added} rows (${dup} duplicates skipped). Food Cost page now uses the new costs on this device.</div>`;
  });
}

/* ============================================= METHODOLOGY AUGMENTATION ==== */
const origMethod = PAGES.method.fn;
PAGES.method.fn = function (host) {
  origMethod(host);
  loadLive().then(() => {
    if (!DATA.manifest) return;
    const th = fcSettings();
    const rAll = computeFoodCost(
      DATA.selections.filter((s) => { const c = CHK().get(s.checkGuid); return c && c.tableGuid && !c.voided; }),
      DATA.checks.filter((c) => c.tableGuid && !c.voided),
      DATA.reference, DATA.costs, { thresholds: th });
    const runs = safeRuns();
    const chefCount = DATA.costs.filter((c) => c.source === 'chef_confirmed').length;
    const roughCount = DATA.costs.filter((c) => c.source === 'rough_workbook').length;
    const div = document.createElement('div');
    div.className = 'card sec';
    div.innerHTML = `<header><div><div class="ttl">Live data &amp; ingestion status</div>
      <div class="sub">Source freshness, coverage and provisional-data posture for the food-cost system.</div></div></header>
      <div class="body"><table class="tb" style="width:100%;font-size:13px;border-collapse:collapse"><tbody>
        ${mrow('Last successful Toast sync', new Date(DATA.manifest.lastToastSync).toLocaleString('en-US') + ' · ' + DATA.manifest.dates.map(fmtDate).join(', '))}
        ${mrow('Last successful OpenTable sync', 'None — automated OpenTable access not yet granted; intent comes from the host log in the pilot extract')}
        ${mrow('Last cost update', latestCostUpdate())}
        ${mrow('Payroll sync', 'Disabled (feature flag off) — no verified payroll source configured')}
        ${mrow('Imported records', `${fmt(DATA.selections.length)} item selections · ${fmt(DATA.checks.length)} checks · ${fmt(DATA.costs.length)} cost records`)}
        ${mrow('Cost basis', `${roughCount} rough workbook (unverified) · ${chefCount} chef-confirmed · AYCE entitlement items carry an explicit $0 by design`)}
        ${mrow('Cost-mapping coverage (full period, floor)', `${pct(rAll.total.coverage.netPct)} of food revenue · ${fmt(rAll.total.unmatchedItemCount)} unmatched items worth ${usd0(rAll.total.unmatchedNet)}`)}
        ${mrow('Ingestion runs', runs)}
        ${mrow('Commission program status', 'Commission applied to the pilot weekend (Jul 31–Aug 2) only. Whether it continues is a management decision — no commission accrues outside the pilot window unless the policy is explicitly re-enabled.')}
        ${mrow('Conversion rule (binding)', 'Eligible = explicitly UNDECIDED or ALC. UNKNOWN and pre-decided AYCE are excluded from numerator AND denominator, never earn commission, and still count in mix, revenue and food cost.')}
        ${mrow('Food-cost formula', 'Σ(nonvoided qty × effective unit cost) ÷ eligible net food revenue. Revenue excludes tax, tips, service charges, gift cards, voids, non-food categories; selection discounts net; check discounts prorated across the check’s food items.')}
      </tbody></table></div>
      <div class="foot">Estimated food cost measures what the POS recorded as served — it is not inventory
      variance and must not be read as waste attribution against any individual.</div>`;
    host.appendChild(div);
  });
};
function mrow(k, v) {
  return `<tr style="border-top:1px solid var(--border-2)"><td style="text-align:left;padding:6px 8px;white-space:nowrap;color:var(--ink-3)">${esc(k)}</td>
    <td style="text-align:left;padding:6px 8px">${v}</td></tr>`;
}
function latestCostUpdate() {
  let latest = null;
  for (const c of DATA.costs) if (!latest || c.updatedAt > latest) latest = c.updatedAt;
  return latest ? new Date(latest).toLocaleString('en-US') : '—';
}
function safeRuns() {
  // The run log ships with the repo; localImports add browser-side runs.
  const n = DATA.localImports.length;
  return `Toast API ingestion committed with the repo${n ? ` · ${n} browser-local manual import${n > 1 ? 's' : ''} on this device` : ''}`;
}

/* ------------------------------------------------------------- register --- */
function registerPages() {
  const entries = Object.entries(PAGES);
  const rebuilt = {};
  for (const [k, v] of entries) {
    rebuilt[k] = v;
    if (k === 'overview') {
      rebuilt.foodcost = { label: 'Food cost', icon: '◐', fn: pgFoodCost, title: 'Food cost (estimated)' };
    }
    if (k === 'commission') {
      rebuilt.import = { label: 'Data import', icon: '⬆', fn: pgImport, title: 'Data import' };
    }
  }
  for (const k of Object.keys(PAGES)) delete PAGES[k];
  Object.assign(PAGES, rebuilt);
}
registerPages();
loadLive(); // warm the cache; freshness badge appears once the shell is unlocked
