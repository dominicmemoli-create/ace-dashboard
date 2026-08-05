// Fixes Needed triage — decides which OpenTable records deserve a management
// decision and which are excluded automatically without creating work.
//
// BINDING RULES (mirrors the management brief):
//   Never actionable (auto-excluded from the QUEUE, summarized only):
//     - UNKNOWN guest starting choice (blank tags / unrecognized tags / host
//       simply didn't record it) — regardless of match status. These visits
//       still count in every operational figure (tables, covers, sales, food
//       cost); only conversion rates leave them out.
//     - marked visits with no reliable Toast candidate (unmatched, or
//       ambiguous without a strong single candidate)
//     - canceled / no-shows / non-completed visits (rejected upstream at
//       parse time — they never reach the database)
//     - Half/Half notes: a returning/first-time guest mix marker, kept as
//       visit metadata. NEVER a policy exception, NEVER a fix.
//   Actionable (may enter Fixes Needed):
//     1. conflicting recognized tags (REVIEW_REQUIRED)
//     2. one strong Toast candidate that failed the automatic threshold
//     3. detected table transfers needing attribution confirmation
//     4. items a manager reopened
//   Records without a recorded choice never enter conversion (numerator or
//   denominator) — their conversion is displayed as unavailable, not zero.
//
// Pure module: used by the browser (Fixes Needed page + nav badge) and the
// acceptance tests.

export const PILOT_WINDOW = { from: '20260731', to: '20260802' };

/** Minimum stored confidence for an ambiguous match to count as a "strong
 * single candidate" worth a human decision. Below this the record is
 * auto-excluded as having no reliable candidate. */
export const MIN_CANDIDATE_CONFIDENCE = 0.35;

export const KIND = {
  CONFLICT: 'CONFLICTING_CHOICE',   // conflicting recognized tags
  MATCH: 'LIKELY_MATCH',            // strong single candidate, small discrepancy
  TRANSFER: 'TRANSFER',             // table transfer attribution
  REOPENED: 'REOPENED',             // manager asked to look again
};

const KIND_PRIORITY = { [KIND.CONFLICT]: 1, [KIND.REOPENED]: 2, [KIND.MATCH]: 3, [KIND.TRANSFER]: 4 };

function inPilotWindow(businessDate) {
  return businessDate >= PILOT_WINDOW.from && businessDate <= PILOT_WINDOW.to;
}

/**
 * Classify one sanitized intent record.
 * Returns { actionable: true, kind } or { actionable: false, reason }.
 * Half/Half (current `halfHalf` field or the legacy `mixedMenuException`
 * field on rows imported before the correction) never makes a record
 * actionable — it is guest-mix metadata, not a menu question.
 */
export function classifyRecord(r) {
  if (r.excluded) return { actionable: false, reason: 'resolved_excluded' };
  if (r.reviewStatus === 'confirmed') return { actionable: false, reason: 'resolved' };
  if (r.reopened) return { actionable: true, kind: KIND.REOPENED };
  if (r.intent === 'REVIEW_REQUIRED') return { actionable: true, kind: KIND.CONFLICT };
  if (r.intent === 'UNKNOWN' || r.intent == null) {
    // no recorded starting choice — never management work; the visit still
    // counts everywhere except conversion
    return { actionable: false, reason: 'unmarked' };
  }
  if (r.transferDetected) return { actionable: true, kind: KIND.TRANSFER };
  // recognized single starting choice from here on
  if (r.matchStatus === 'matched') return { actionable: false, reason: 'connected' };
  // staleSuggestion: a stored candidate that fails the CURRENT matching rules
  // (outside the ±25-minute window, $0 / Host To Go / excluded-area order).
  // Set by the live re-verification pass — never a human task.
  if (r.matchStatus === 'ambiguous' && r.matchedOrderGuid && !r.staleSuggestion
      && (r.matchConfidence ?? 0) >= MIN_CANDIDATE_CONFIDENCE) {
    return { actionable: true, kind: KIND.MATCH };
  }
  // marked but no reliable candidate → data-quality note, not a task
  return { actionable: false, reason: 'marked_not_connected' };
}

/**
 * Triage a set of intent records into the actionable queue + exclusion summary.
 * Sort order: pilot-window items first (could affect historical pilot
 * commission), then conflicting tags, reopened, likely matches, transfers;
 * newest date first inside a group.
 */
export function triageIntents(rows) {
  const actionable = [];
  const excluded = {
    unmarked: 0,             // no recorded starting choice (out of conversion only)
    markedNotConnected: 0,   // recorded choice but no reliable Toast candidate
    connected: 0,            // recorded and connected — counts normally
    resolved: 0,             // decided by a manager already
    resolvedExcluded: 0,     // manager chose to exclude
  };
  for (const r of rows ?? []) {
    const c = classifyRecord(r);
    if (c.actionable) {
      actionable.push({ kind: c.kind, pilot: inPilotWindow(r.businessDate), r });
    } else if (c.reason === 'unmarked') excluded.unmarked++;
    else if (c.reason === 'marked_not_connected') excluded.markedNotConnected++;
    else if (c.reason === 'connected') excluded.connected++;
    else if (c.reason === 'resolved_excluded') excluded.resolvedExcluded++;
    else excluded.resolved++;
  }
  actionable.sort((a, b) =>
    (b.pilot - a.pilot)
    || (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])
    || (b.r.businessDate < a.r.businessDate ? -1 : b.r.businessDate > a.r.businessDate ? 1 : 0));
  return { actionable, excluded, badge: actionable.length };
}

/** Plain-language exclusion summary lines (shown as notes, never as errors).
 * Honest about scope: unmarked visits still count in the operational figures —
 * they are only left out of conversion rates. */
export function exclusionSummaryLines(excluded) {
  const lines = [];
  if (excluded.unmarked) {
    lines.push(`${excluded.unmarked} visit${excluded.unmarked === 1 ? '' : 's'} did not have a recorded starting choice. `
      + `${excluded.unmarked === 1 ? 'It still counts' : 'They still count'} in tables, covers, sales and food cost — `
      + `only conversion rates leave ${excluded.unmarked === 1 ? 'it' : 'them'} out, and no action is needed.`);
  }
  if (excluded.markedNotConnected) {
    lines.push(`${excluded.markedNotConnected} visit${excluded.markedNotConnected === 1 ? '' : 's'} had a recorded choice but no reliable Toast table connection, `
      + `so ${excluded.markedNotConnected === 1 ? 'it' : 'they'} cannot be scored for conversion. Sales figures are unaffected.`);
  }
  return lines;
}
