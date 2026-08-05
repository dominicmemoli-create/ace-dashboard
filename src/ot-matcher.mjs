// OpenTable → Toast table-visit matcher.
// A Toast "visit" here is one order (split checks share it).
//
// Matching rules (management brief):
//   - Reservation/seating time vs Toast check-open time within ±25 minutes
//     (configurable) — candidates outside the window are never suggested.
//   - Ordinary dining-room tables require compatible evidence from time, party
//     size, table number AND operating area.
//   - Large parties spread across several OpenTable table numbers match when
//     ANY ONE of those tables overlaps the Toast table (51,52,53 ↔ 53).
//   - Patio tables: guests seat themselves and the host cannot see the patio,
//     so a table-number mismatch is NOT an error there. Time, party size and
//     area carry the evidence; genuinely ambiguous patio matches go to human
//     review instead of auto-connecting.
//   - Never suggested: online ordering / takeout / delivery / bar (excluded
//     areas), checks without a floor table, $0 checks, and Host To Go /
//     unattributed rows without reliable floor-table evidence.
// One OT row matches at most one visit and vice versa (greedy best-first);
// collisions and weak scores become 'ambiguous' and never touch conversion.

/** Default automatic matching window (minutes) around the reservation time. */
export const DEFAULT_TIME_TOLERANCE_MIN = 25;

const HOST_TO_GO_RE = /host\s*to\s*go/i;

/**
 * Build matchable Toast visits for one business date from normalized checks.
 * Applies the hard candidate exclusions: voided, no floor table, outside the
 * included areas (opsFilter), $0 visits, Host To Go attribution.
 * opts.areaOf(check) may return 'patio' | 'dining' | null for area evidence.
 */
export function toastVisits(checks, reference, opsFilter = () => true, opts = {}) {
  const tbl = new Map((reference.tables ?? []).map((t) => [t.guid, String(t.name).toUpperCase()]));
  const emp = new Map((reference.employees ?? []).map((e) => [e.guid, e.name]));
  const areaOf = opts.areaOf ?? (() => null);
  const byOrder = new Map();
  for (const c of checks) {
    if (c.voided || !c.tableGuid || !opsFilter(c)) continue;
    if (!byOrder.has(c.orderGuid)) {
      byOrder.set(c.orderGuid, {
        orderGuid: c.orderGuid, businessDate: String(c.businessDate),
        tableName: tbl.get(c.tableGuid) ?? null, serverGuid: c.serverGuid,
        serverName: emp.get(c.serverGuid) ?? '',
        area: areaOf(c),
        openedDate: c.openedDate, numberOfGuests: c.numberOfGuests ?? 0, net: 0, checks: 0,
      });
    }
    const v = byOrder.get(c.orderGuid);
    v.net += c.amount ?? 0;
    v.checks += 1;
    if (!v.openedDate || (c.openedDate && c.openedDate < v.openedDate)) v.openedDate = c.openedDate;
  }
  return [...byOrder.values()].filter((v) =>
    v.net > 0                                    // $0 visits are never candidates
    && !HOST_TO_GO_RE.test(v.serverName ?? '')); // Host To Go is unattributed, not a floor match
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
 * else { score (0..1), reasons, evidence }.
 * evidence = { timeDiffMin, tableOverlap, overlappingTable, partyDiff, area }
 * — surfaced verbatim on Fixes Needed match cards.
 */
export function scorePair(ot, visit, cfg) {
  if (ot.businessDate !== visit.businessDate) return null;
  const tolMin = cfg.timeToleranceMinutes ?? DEFAULT_TIME_TOLERANCE_MIN;
  const partyTol = cfg.partySizeTolerance ?? 2;
  const reasons = [];
  let score = 0;

  const tableHit = visit.tableName != null && ot.tableTokens.includes(visit.tableName);
  const patio = visit.area === 'patio';

  // time — hard window
  const vm = ot.visitMinutes;
  const om = openedMinutesLocal(visit.openedDate, cfg.timezone);
  let timeDiff = null;
  if (vm != null && om != null) {
    timeDiff = Math.abs(vm - om);
    if (timeDiff > tolMin) return null;                  // outside window — never a candidate
    score += 0.45 * (1 - timeDiff / tolMin);
    reasons.push(`time±${timeDiff}m`);
  } else if (!tableHit) {
    return null;                                          // no time evidence and no table — too thin
  }

  // party size — compatibility requirement
  let partyDiff = null;
  if (ot.partySize != null && visit.numberOfGuests) {
    partyDiff = Math.abs(ot.partySize - visit.numberOfGuests);
    if (partyDiff === 0) { score += 0.25; reasons.push('size'); }
    else if (partyDiff <= partyTol) { score += 0.12; reasons.push('size±'); }
    else if (ot.tableTokens.length > 1 && visit.numberOfGuests <= ot.partySize + partyTol) {
      // large party split across tables: the single Toast table holds part of it
      reasons.push('size~split');
    } else {
      return null;                                        // incompatible party evidence
    }
  }

  // table number — required for dining room, informative for patio
  if (tableHit) {
    score += 0.25;
    reasons.push(ot.tableTokens.length > 1 ? `table∈{${ot.tableTokens.join(',')}}` : 'table');
  } else if (!patio) {
    return null;                                          // dining room requires the table
  } else {
    reasons.push('patio·no-table-req');
  }

  if (ot.serverSoftLabel && visit.serverName &&
      visit.serverName.toLowerCase().startsWith(ot.serverSoftLabel)) {
    score += 0.05; reasons.push('server~');
  }

  if (!tableHit && score < 0.35) return null;             // patio without table needs real evidence
  return {
    score, reasons,
    evidence: {
      timeDiffMin: timeDiff, tableOverlap: tableHit,
      overlappingTable: tableHit ? visit.tableName : null,
      partyDiff, area: visit.area ?? null,
    },
  };
}

/**
 * Greedy best-first assignment. Completed OT visits only (status Done/Completed);
 * canceled/no-show rejected upstream. Returns rows updated with matchStatus:
 * 'matched' | 'ambiguous' | 'unmatched', matchedOrderGuid, matchConfidence,
 * matchEvidence.
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
  const results = new Map(otRows.map((r) => [r.rowHash, { ...r, matchStatus: 'unmatched', matchedOrderGuid: null, matchConfidence: null, matchReasons: [], matchEvidence: null }]));
  for (const c of candidates) {
    if (takenOt.has(c.ot.rowHash) || takenVisit.has(c.v.orderGuid)) continue;
    const r = results.get(c.ot.rowHash);
    // second-best competing score for the same OT row → ambiguity check
    const rival = candidates.find((x) => x !== c && x.ot.rowHash === c.ot.rowHash && !takenVisit.has(x.v.orderGuid));
    // patio matches without a table overlap stay in human review unless the
    // remaining evidence is overwhelming and unrivaled
    const patioSoft = !c.evidence.tableOverlap && c.evidence.area === 'patio';
    const ambiguous = c.score < 0.55 || (rival && (c.score - rival.score) < 0.08)
      || (patioSoft && (c.score < 0.7 || !!rival));
    takenOt.add(c.ot.rowHash);
    takenVisit.add(c.v.orderGuid);
    r.matchedOrderGuid = c.v.orderGuid;
    r.matchConfidence = Math.round(c.score * 100) / 100;
    r.matchReasons = c.reasons;
    r.matchEvidence = c.evidence;
    r.matchStatus = ambiguous ? 'ambiguous' : 'matched';
    if (ambiguous && r.reviewStatus === 'auto') r.reviewStatus = 'pending_review';
  }
  return [...results.values()];
}
