#!/usr/bin/env node
// MarginEdge → ACE cost sync. Runs in GitHub Actions on its own daily schedule
// (.github/workflows/marginedge-costs.yml) or manually:
//
//   node scripts/sync-marginedge-costs.mjs --dry-run          # default: change nothing
//   node scripts/sync-marginedge-costs.mjs --apply
//   node scripts/sync-marginedge-costs.mjs --apply --verbose
//   node scripts/sync-marginedge-costs.mjs --effective-from 20260905 --apply
//
// INDEPENDENCE (docs/METRICS.md): this script never touches ace_checks,
// ace_selections, ace_metrics or ace_intents. It cannot break Toast ingestion or
// the OpenTable upload, and neither of those can block it. It only ever appends
// effective-dated rows to ace_item_costs and records its own status.
//
// SAFETY POSTURE
//   * dry-run is the DEFAULT; --apply is required to write.
//   * only chef-confirmed mappings produce costs (src/marginedge-cost.mjs).
//   * a questionable derived value HOLDS: the last trustworthy cost stays live
//     and the anomaly is recorded as an exception, never published.
//   * an existing valid cost is never replaced by null or by an unexpected $0.
//   * identical MarginEdge inputs produce an identical sourceHash, so re-running
//     against unchanged data inserts nothing.
//   * pilot history (Jul 31 – Aug 2 2026) is frozen and refused outright.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { clientFromEnv, indexProducts, loadDotEnv, sanitizeError } from './lib/marginedge-client.mjs';
import {
  deriveCostPerToastUnit, decideCostChange, DEFAULT_GUARDS, MARGINEDGE_SOURCE, normalizeName,
} from '../src/marginedge-cost.mjs';
import { PILOT_WINDOW, isPilotDate } from './lib/ingest-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** YYYYMMDD for "today" in the restaurant's timezone. */
export function nyToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).replace(/-/g, '');
}

/** Stable idempotency marker over the MarginEdge inputs behind one cost. */
export function sourceHashFor({ mappingId, components }) {
  const canonical = JSON.stringify({
    mappingId: String(mappingId ?? ''),
    components: (components ?? [])
      .map((c) => ({
        productId: String(c.productId),
        latestPrice: Number(c.latestPrice),
        reportByUnit: String(c.reportByUnit ?? ''),
        quantityPerToastUnit: Number(c.quantityPerToastUnit),
        unit: String(c.unit ?? ''),
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const iEff = argv.indexOf('--effective-from');
  return {
    apply,
    dryRun: !apply,
    verbose: argv.includes('--verbose'),
    effectiveFrom: iEff >= 0 ? argv[iEff + 1] : null,
  };
}

/* --------------------------------------------------------------- planning -- */
/**
 * Pure planner — decides what WOULD be written. Fully unit-testable with no
 * database and no network.
 *
 * @param mappings  rows from ace_marginedge_mappings (payloads)
 * @param products  normalized MarginEdge products
 * @param openCosts Map canonicalName -> open ace_item_costs payload (effectiveTo null)
 * @param effectiveFrom YYYYMMDD
 */
export function planSync({ mappings, products, openCosts, effectiveFrom, guards = DEFAULT_GUARDS }) {
  const productIndex = indexProducts(products);
  const plan = { insert: [], unchanged: [], hold: [], skip: [] };

  for (const m of mappings) {
    const name = m.canonicalName || m.toastItemName;
    const open = openCosts.get(name) ?? null;
    const label = { mappingId: m.id, canonicalName: name, toastItemGuid: m.toastItemGuid ?? null };

    if (m.reviewStatus !== 'confirmed') {
      plan.skip.push({ ...label, reason: `mapping review status is "${m.reviewStatus ?? 'unset'}" — only confirmed mappings are costed` });
      continue;
    }

    const derived = deriveCostPerToastUnit(m, productIndex);
    if (derived.cost == null) {
      // Recipe/product data went incomplete upstream: hold, never publish a
      // partial or zero cost over a working one.
      plan.hold.push({ ...label, reason: derived.problems.join('; '), currentCost: open?.costPerUnit ?? null, derivedCost: null });
      continue;
    }

    const decision = decideCostChange({
      derived: derived.cost,
      current: open?.costPerUnit ?? null,
      guards,
      mapping: m,
    });

    const hash = sourceHashFor({ mappingId: m.id, components: derived.components });

    if (decision.action === 'unchanged' || (open?.marginEdge?.sourceHash && open.marginEdge.sourceHash === hash)) {
      plan.unchanged.push({ ...label, cost: derived.cost, reason: open?.marginEdge?.sourceHash === hash ? 'identical MarginEdge source hash already recorded' : decision.reason });
      continue;
    }
    if (decision.action === 'hold') {
      plan.hold.push({ ...label, reason: decision.reason, currentCost: open?.costPerUnit ?? null, derivedCost: derived.cost });
      continue;
    }
    if (decision.action === 'skip') {
      plan.skip.push({ ...label, reason: decision.reason });
      continue;
    }

    // Effective dating: a newer open record must never be silently rewritten.
    if (open && String(open.effectiveFrom) > String(effectiveFrom)) {
      plan.skip.push({ ...label, reason: `a newer cost is already effective ${open.effectiveFrom}` });
      continue;
    }

    plan.insert.push({
      ...label,
      previousCost: open?.costPerUnit ?? null,
      previousSource: open?.source ?? null,
      cost: Math.round(derived.cost * 10000) / 10000,
      components: derived.components,
      sourceHash: hash,
      portionBasis: m.portionBasis ?? '',
      // A MarginEdge number is only "verified" because a human confirmed the
      // portion mapping behind it — never because the API answered.
      verification: m.reviewStatus === 'confirmed' ? 'verified' : 'unverified',
      closesRecordId: open && String(open.effectiveFrom) < String(effectiveFrom) ? open.id : null,
      effectiveFrom,
    });
  }
  return plan;
}

/* ------------------------------------------------------------------ main --- */
async function readState(client) {
  const maps = await client.query('select id, payload from ace_marginedge_mappings');
  const costs = await client.query('select id, payload from ace_item_costs');
  const openCosts = new Map();
  for (const r of costs.rows) {
    const p = r.payload;
    if (p?.effectiveTo != null) continue;
    const prev = openCosts.get(p.canonicalName);
    if (!prev || String(p.effectiveFrom) > String(prev.effectiveFrom)) {
      openCosts.set(p.canonicalName, { ...p, id: r.id });
    }
  }
  return { mappings: maps.rows.map((r) => ({ ...r.payload, id: r.id })), openCosts };
}

async function applyPlan(client, plan, { effectiveFrom, unitId }) {
  const now = new Date().toISOString();
  const dayBefore = (() => {
    const d = new Date(Date.UTC(+effectiveFrom.slice(0, 4), +effectiveFrom.slice(4, 6) - 1, +effectiveFrom.slice(6, 8)));
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  })();

  await client.query('begin');
  try {
    for (const ins of plan.insert) {
      if (ins.closesRecordId) {
        await client.query(
          `update ace_item_costs
             set payload = payload || jsonb_build_object('effectiveTo', $2::text, 'updatedAt', $3::text),
                 updated_at = now()
           where id = $1`,
          [ins.closesRecordId, dayBefore, now]);
      }
      const id = `cost-${normalizeName(ins.canonicalName).replace(/ /g, '-')}-${effectiveFrom}`;
      const payload = {
        id,
        toastItemGuid: ins.toastItemGuid,
        toastSelectionGuid: null,
        canonicalName: ins.canonicalName,
        aliases: [],
        portion: ins.portionBasis || 'per recorded Toast selection quantity',
        costPerUnit: ins.cost,
        effectiveFrom,
        effectiveTo: null,
        source: MARGINEDGE_SOURCE,
        verification: ins.verification,
        notes: `Derived from MarginEdge ingredient pricing via mapping ${ins.mappingId}`,
        marginEdge: {
          restaurantUnitId: unitId,
          mappingId: ins.mappingId,
          components: ins.components.map((c) => ({
            productId: c.productId, productName: c.productName,
            latestPrice: c.latestPrice, reportByUnit: c.reportByUnit,
            quantityPerToastUnit: c.quantityPerToastUnit, unit: c.unit,
          })),
          sourceEffectiveDate: effectiveFrom,
          syncedAt: now,
          sourceHash: ins.sourceHash,
          mappingVerified: ins.verification === 'verified',
        },
        createdAt: now,
        updatedAt: now,
        updatedBy: 'marginedge-sync',
      };
      await client.query(
        `insert into ace_item_costs (id, payload, updated_at) values ($1, $2, now())
         on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
        [id, JSON.stringify(payload)]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');   // every previously valid cost stays live
    throw e;
  }
}

/**
 * Record the attempt against ace_source_status.
 *
 * Three distinct outcomes — "did not publish" is NOT the same as "failed":
 *   apply + no error   → success. Stamp last_success_at and status 'ok'.
 *   error              → status 'failed'. last_success_at is preserved, so the
 *                        UI can say "using the last successful snapshot".
 *   dry run + no error → the source is reachable but nothing was published.
 *                        Record the attempt and LEAVE the existing status alone;
 *                        a healthy dry run must never make the dashboard claim
 *                        the cost feed is broken.
 */
async function recordStatus(client, { failed, apply, detail }) {
  const success = !failed && apply;
  // null => keep whatever status is already there (the dry-run case)
  const nextStatus = failed ? 'failed' : (apply ? 'ok' : null);
  await client.query(
    `insert into ace_source_status (source, last_success_at, last_attempt_at, status, detail, updated_at)
     values ('marginedge', case when $1 then now() else null end, now(),
             coalesce($2, 'never'), $3, now())
     on conflict (source) do update set
       last_success_at = case when $1 then now() else ace_source_status.last_success_at end,
       last_attempt_at = now(),
       status = coalesce($2, ace_source_status.status),
       detail = $3,
       updated_at = now()`,
    [success, nextStatus, JSON.stringify(detail)]);
}

async function main() {
  loadDotEnv(ROOT);
  const args = parseArgs(process.argv.slice(2));
  const effectiveFrom = args.effectiveFrom ?? nyToday();

  if (!/^\d{8}$/.test(effectiveFrom)) {
    console.error(`Invalid --effective-from "${effectiveFrom}" (expected YYYYMMDD).`);
    process.exit(1);
  }
  if (isPilotDate(effectiveFrom) || effectiveFrom <= PILOT_WINDOW[1]) {
    console.error(
      `Refusing to write costs effective ${effectiveFrom}: `
      + `${PILOT_WINDOW[0]}–${PILOT_WINDOW[1]} pilot history is frozen and an earlier `
      + 'effective date would retroactively recalculate it.');
    process.exit(1);
  }
  if (!process.env.SUPABASE_DB_URL) {
    console.error('Missing SUPABASE_DB_URL. See docs/CREDENTIALS.md.');
    process.exit(1);
  }

  const runId = `marginedge-${effectiveFrom}-${Date.now()}`;
  console.log(`MarginEdge cost sync — mode=${args.apply ? 'APPLY' : 'DRY RUN'}, effectiveFrom=${effectiveFrom}`);

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let failed = null;
  let plan = { insert: [], unchanged: [], hold: [], skip: [] };
  let unitId = null;
  let productCount = 0;

  try {
    const me = clientFromEnv();
    unitId = me.restaurantUnitId;

    // Credential + scope check before anything else, so a bad key fails loudly
    // and cheaply instead of half-way through a catalogue read.
    const units = await me.restaurantUnits();
    const unit = units.find((u) => u.id === unitId);
    if (!unit) {
      throw new Error(
        `MARGINEDGE_RESTAURANT_UNIT_ID ${unitId} is not accessible to this API key `
        + `(key can reach: ${units.map((u) => u.id).join(', ')})`);
    }
    console.log(`Unit ${unit.id} — ${unit.name}`);

    const categories = await me.categories();
    const products = await me.products({ categories });
    productCount = products.length;
    console.log(`Fetched ${products.length} products (${products.filter((p) => p.isFood).length} in FOOD categories) in ${me.requestCount} requests.`);

    const { mappings, openCosts } = await readState(client);
    console.log(`Mappings: ${mappings.length} (${mappings.filter((m) => m.reviewStatus === 'confirmed').length} confirmed). Open cost records: ${openCosts.size}.`);

    plan = planSync({ mappings, products, openCosts, effectiveFrom });

    console.log(
      `Plan — insert ${plan.insert.length}, unchanged ${plan.unchanged.length}, `
      + `hold ${plan.hold.length}, skip ${plan.skip.length}`);

    if (args.verbose || plan.hold.length) {
      for (const h of plan.hold) {
        console.log(`  HOLD  ${h.canonicalName}: ${h.reason}`);
      }
    }
    if (args.verbose) {
      for (const i of plan.insert) {
        const from = i.previousCost == null ? 'none' : `$${Number(i.previousCost).toFixed(2)} (${i.previousSource})`;
        console.log(`  WRITE ${i.canonicalName}: ${from} → $${i.cost.toFixed(4)}  [${i.portionBasis || 'no portion note'}]`);
      }
      for (const s of plan.skip) console.log(`  SKIP  ${s.canonicalName}: ${s.reason}`);
    }

    if (args.apply) {
      if (plan.insert.length) {
        await applyPlan(client, plan, { effectiveFrom, unitId });
        console.log(`Applied ${plan.insert.length} new effective-dated cost record(s).`);
      } else {
        console.log('Nothing to apply — MarginEdge source data is unchanged.');
      }
    } else {
      console.log('DRY RUN — no database changes were made. Re-run with --apply to write.');
    }
  } catch (e) {
    failed = sanitizeError(e.message, process.env.MARGINEDGE_API_KEY);
    console.error(`MarginEdge sync FAILED: ${failed}`);
  }

  // Status and audit are recorded whether or not the sync succeeded, so the UI
  // can say "food costs are using the last successful MarginEdge snapshot"
  // instead of going blank.
  try {
    const detail = {
      runId, mode: args.apply ? 'apply' : 'dry-run', effectiveFrom,
      marginedgeRestaurantUnitId: unitId, productsFetched: productCount,
      inserted: args.apply ? plan.insert.length : 0,
      wouldInsert: plan.insert.length,
      unchanged: plan.unchanged.length,
      held: plan.hold.length, skipped: plan.skip.length,
      error: failed,
    };
    await client.query(
      `insert into ace_marginedge_sync_runs (run_id, payload) values ($1, $2)
       on conflict (run_id) do update set payload = excluded.payload`,
      [runId, JSON.stringify({
        ...detail,
        exceptions: { hold: plan.hold, skip: plan.skip },
        finishedAt: new Date().toISOString(),
      })]);
    // A dry run is not a successful cost sync — it proves the source is
    // reachable but publishes nothing, so it must neither refresh the freshness
    // stamp nor mark the feed failed.
    await recordStatus(client, { failed, apply: args.apply, detail });
  } catch (e) {
    console.error(`Could not record sync status: ${sanitizeError(e.message, process.env.MARGINEDGE_API_KEY)}`);
  } finally {
    await client.end();
  }

  if (failed) process.exit(1);
  console.log('MarginEdge cost sync complete.');
}

if (process.argv[1]?.endsWith('sync-marginedge-costs.mjs')) {
  main().catch((e) => {
    console.error('MARGINEDGE SYNC FAILED:', sanitizeError(e.message, process.env.MARGINEDGE_API_KEY));
    process.exit(1);
  });
}
