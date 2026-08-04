// OpenTable → Toast table-visit matcher.
// A Toast "visit" here is one order (split checks share it). Match signals, in
// order: business date (hard), table-token overlap, visit-time vs opened-time
// proximity, party size. OpenTable server text is a weak tiebreak only.
// One OT row matches at most one visit and vice versa (greedy best-first);
// collisions and weak scores become 'ambiguous' and never touch conversion.
import { visitMinutes } from './opentable.mjs';

/** Build matchable Toast visits for one business date from normalized checks. */
export function toastVisits(checks, reference, opsFilter = () => true) {
  const tbl = new Map((reference.tables ?? []).map((t) => [t.guid, String(t.name).toUpperCase()]));
  const byOrder = new Map();
  for (const c of checks) {
    if (c.voided || !c.tableGuid || !opsFilter(c)) continue;
    if (!byOrder.has(c.orderGuid)) {
      byOrder.set(c.orderGuid, {
        orderGuid: c.orderGuid, businessDate: String(c.businessDate),
        tableName: tbl.get(c.tableGuid) ?? null, serverGuid: c.serverGuid,
        openedDate: c.openedDate, numberOfGuests: c.numberOfGuests ?? 0, net: 0, checks: 0,
      });
    }
    const v = byOrder.get(c.orderGuid);
    v.net += c.amount ?? 0;
    v.checks += 1;
    if (!v.openedDate || (c.openedDate && c.openedDate < v.openedDate)) v.openedDate = c.openedDate;
  }
  return [...byOrder.values()];
}

export function openedMinutesLocal(iso, timezone) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * Score one OT visit against one Toast visit. Returns null when disqualified,
 * else { score (0..1), reasons }.
 */
export function scorePair(ot, visit, cfg) {
  if (ot.businessDate !== visit.businessDate) return null;
  const tolMin = cfg.timeToleranceMinutes ?? 90;
  const reasons = [];
  let score = 0;

  const tableHit = visit.tableName != null && ot.tableTokens.includes(visit.tableName);
  if (tableHit) { score += 0.5; reasons.push('table'); }

  const vm = ot.visitMinutes;
  const om = openedMinutesLocal(visit.openedDate, cfg.timezone);
  if (vm != null && om != null) {
    const diff = Math.abs(vm - om);
    if (diff > tolMin) return null;                      // outside tolerance — disqualified
    score += 0.3 * (1 - diff / tolMin); reasons.push(`time±${diff}m`);
  }

  if (ot.partySize != null && visit.numberOfGuests) {
    const dp = Math.abs(ot.partySize - visit.numberOfGuests);
    if (dp === 0) { score += 0.15; reasons.push('size'); }
    else if (dp <= (cfg.partySizeTolerance ?? 2)) { score += 0.07; reasons.push('size±'); }
  }

  if (ot.serverSoftLabel && visit.serverName &&
      visit.serverName.toLowerCase().startsWith(ot.serverSoftLabel)) {
    score += 0.05; reasons.push('server~');
  }

  if (!tableHit && score < 0.3) return null;             // no table and weak — not a candidate
  return { score, reasons };
}

/**
 * Greedy best-first assignment. Completed OT visits only (status Done/Completed);
 * canceled/no-show rejected upstream. Returns rows updated with matchStatus:
 * 'matched' | 'ambiguous' | 'unmatched', matchedOrderGuid, matchConfidence.
 */
export function matchVisits(otRows, visits, cfg) {
  const candidates = [];
  for (const ot of otRows) {
    for (const v of visits) {
      const s = scorePair(ot, v, cfg);
      if (s) candidates.push({ ot, v, ...s });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const takenOt = new Set(), takenVisit = new Set();
  const results = new Map(otRows.map((r) => [r.rowHash, { ...r, matchStatus: 'unmatched', matchedOrderGuid: null, matchConfidence: null, matchReasons: [] }]));
  for (const c of candidates) {
    if (takenOt.has(c.ot.rowHash) || takenVisit.has(c.v.orderGuid)) continue;
    const r = results.get(c.ot.rowHash);
    // second-best competing score for the same OT row → ambiguity check
    const rival = candidates.find((x) => x !== c && x.ot.rowHash === c.ot.rowHash && !takenVisit.has(x.v.orderGuid));
    const ambiguous = c.score < 0.55 || (rival && (c.score - rival.score) < 0.08);
    takenOt.add(c.ot.rowHash);
    takenVisit.add(c.v.orderGuid);
    r.matchedOrderGuid = c.v.orderGuid;
    r.matchConfidence = Math.round(c.score * 100) / 100;
    r.matchReasons = c.reasons;
    r.matchStatus = ambiguous ? 'ambiguous' : 'matched';
    if (ambiguous && r.reviewStatus === 'auto') r.reviewStatus = 'pending_review';
  }
  return [...results.values()];
}
