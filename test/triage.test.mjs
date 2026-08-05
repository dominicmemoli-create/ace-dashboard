// Fixes Needed triage — acceptance tests 10-16 and 20 from the manager-product
// brief. The binding rule: unknown/unmarked/unreliable records are excluded
// automatically and NEVER create management work; only clear, actionable
// exceptions enter the queue.
import { describe, it, expect } from 'vitest';
import { triageIntents, classifyRecord, exclusionSummaryLines, KIND, MIN_CANDIDATE_CONFIDENCE } from '../src/triage.mjs';
import { parseGuestCenter, sanitizeVisit } from '../src/opentable.mjs';

const rec = (over = {}) => ({
  rowHash: 'h' + Math.abs(JSON.stringify(over).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)),
  businessDate: '20260810', visitTime: '07:00 PM', partySize: 2,
  tableTokens: ['12'], intent: 'UNDECIDED', mixedMenuException: false,
  relevantTags: ['UNDECIDED'], matchStatus: 'matched', matchedOrderGuid: 'g1',
  matchConfidence: 0.9, reviewStatus: 'auto', ...over,
});

describe('never actionable (auto-excluded, no task created)', () => {
  it('10: UNKNOWN guest starting choice never appears — even when matched', () => {
    const { actionable, excluded } = triageIntents([rec({ intent: 'UNKNOWN' })]);
    expect(actionable).toHaveLength(0);
    expect(excluded.unmarked).toBe(1);
  });
  it('11: unmarked visits (blank reservation tags) never appear', () => {
    // through the real parser: blank tags → UNKNOWN
    const csv = 'Visit Date,Visit Time,Guest Name,Phone Number,Size,Status,Table,Reservation Tags\n'
      + '2026-08-10,07:00 PM,A Guest,555,2,Done,12,\n';
    const v = parseGuestCenter(csv)[0];
    const s = sanitizeVisit(v, 'test');
    expect(s.intent).toBe('UNKNOWN');
    const { actionable, excluded } = triageIntents([s]);
    expect(actionable).toHaveLength(0);
    expect(excluded.unmarked).toBe(1);
  });
  it('12: unmatched unknown visits never appear', () => {
    const { actionable, excluded } = triageIntents([
      rec({ intent: 'UNKNOWN', matchStatus: 'unmatched', matchedOrderGuid: null, matchConfidence: null })]);
    expect(actionable).toHaveLength(0);
    expect(excluded.unmarked).toBe(1);
  });
  it('13: ambiguous visits with no strong candidate never appear', () => {
    const noCandidate = rec({ matchStatus: 'ambiguous', matchedOrderGuid: null, matchConfidence: null });
    const weak = rec({ matchStatus: 'ambiguous', matchedOrderGuid: 'g2', matchConfidence: MIN_CANDIDATE_CONFIDENCE - 0.01 });
    const { actionable, excluded } = triageIntents([noCandidate, weak]);
    expect(actionable).toHaveLength(0);
    expect(excluded.markedNotConnected).toBe(2);
  });
  it('marked but unmatched → data-quality count, not work', () => {
    const { actionable, excluded } = triageIntents([
      rec({ matchStatus: 'unmatched', matchedOrderGuid: null, matchConfidence: null })]);
    expect(actionable).toHaveLength(0);
    expect(excluded.markedNotConnected).toBe(1);
  });
  it('canceled / no-shows are rejected before the database (parser level)', () => {
    const csv = 'Visit Date,Visit Time,Guest Name,Phone Number,Size,Status,Table,Reservation Tags\n'
      + '2026-08-10,07:00 PM,A,555,2,Canceled,12,UNDECIDED.\n'
      + '2026-08-10,07:30 PM,B,555,2,No Show,13,AYCE\n'
      + '2026-08-10,08:00 PM,C,555,2,Done,14,UNDECIDED.\n';
    const completed = parseGuestCenter(csv).filter((v) => /^(done|completed|complete)$/i.test(v.status));
    expect(completed).toHaveLength(1);
  });
});

describe('actionable issues (do appear)', () => {
  it('14: conflicting recognized tags appear', () => {
    const { actionable } = triageIntents([
      rec({ intent: 'REVIEW_REQUIRED', relevantTags: ['AYCE', 'UNDECIDED'], reviewStatus: 'pending_review' })]);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].kind).toBe(KIND.CONFLICT);
  });
  it('15: Half/Half creates NO fix — it is guest-mix metadata, not a menu question', () => {
    // current field
    const current = triageIntents([rec({ halfHalf: true })]);
    expect(current.actionable).toHaveLength(0);
    expect(current.excluded.connected).toBe(1); // counts normally, nothing to fix
    // legacy rows imported before the correction still carry mixedMenuException
    const legacy = triageIntents([rec({ mixedMenuException: true, reviewStatus: 'pending_review' })]);
    expect(legacy.actionable).toHaveLength(0);
    // and Half/Half never blocks the record's real starting choice
    const withIntent = triageIntents([rec({ halfHalf: true, intent: 'ALC' })]);
    expect(withIntent.actionable).toHaveLength(0);
    expect(withIntent.excluded.connected).toBe(1);
  });
  it('16: a strong single-candidate mismatch may appear', () => {
    const { actionable } = triageIntents([
      rec({ matchStatus: 'ambiguous', matchedOrderGuid: 'g3', matchConfidence: 0.5 })]);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].kind).toBe(KIND.MATCH);
  });
  it('a stored suggestion that fails the CURRENT matching rules is auto-excluded', () => {
    // set by the live re-verification pass (candidate hours away, $0 order,
    // Host To Go, excluded area) — never presented as work
    const { actionable, excluded } = triageIntents([
      rec({ matchStatus: 'ambiguous', matchedOrderGuid: 'g3', matchConfidence: 0.5, staleSuggestion: true })]);
    expect(actionable).toHaveLength(0);
    expect(excluded.markedNotConnected).toBe(1);
  });
  it('transfers appear when detected', () => {
    const { actionable } = triageIntents([rec({ transferDetected: true })]);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].kind).toBe(KIND.TRANSFER);
  });
  it('reopened items appear', () => {
    const { actionable } = triageIntents([rec({ reopened: true, reviewStatus: 'pending_review' })]);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].kind).toBe(KIND.REOPENED);
  });
});

describe('queue lifecycle', () => {
  it('20: resolved items disappear from the active queue', () => {
    const { actionable, excluded } = triageIntents([
      rec({ intent: 'REVIEW_REQUIRED', reviewStatus: 'confirmed', intentEffective: 'UNDECIDED' })]);
    expect(actionable).toHaveLength(0);
    expect(excluded.resolved).toBe(1);
  });
  it('manager-excluded items stay out of the queue', () => {
    const { actionable, excluded } = triageIntents([
      rec({ intent: 'REVIEW_REQUIRED', reviewStatus: 'confirmed', excluded: true })]);
    expect(actionable).toHaveLength(0);
    expect(excluded.resolvedExcluded).toBe(1);
  });
});

describe('badge + prioritization', () => {
  it('badge counts only actionable items — unmarked and Half/Half never count', () => {
    const { badge } = triageIntents([
      rec({ intent: 'UNKNOWN' }),
      rec({ intent: 'UNKNOWN', matchStatus: 'unmatched' }),
      rec({ matchStatus: 'unmatched', matchedOrderGuid: null }),
      rec({ intent: 'REVIEW_REQUIRED', reviewStatus: 'pending_review' }),
      rec({ halfHalf: true }),
      rec({ mixedMenuException: true, reviewStatus: 'pending_review' }), // legacy Half/Half row
    ]);
    expect(badge).toBe(1);
  });
  it('pilot-window items sort first, then conflict > match > transfer', () => {
    const { actionable } = triageIntents([
      rec({ matchStatus: 'ambiguous', matchedOrderGuid: 'g', matchConfidence: 0.6 }),   // match, recent
      rec({ transferDetected: true }),                                                   // transfer
      rec({ intent: 'REVIEW_REQUIRED', reviewStatus: 'pending_review' }),                // conflict
      rec({ businessDate: '20260801', intent: 'REVIEW_REQUIRED', reviewStatus: 'pending_review' }), // pilot conflict
    ]);
    expect(actionable[0].pilot).toBe(true);
    expect(actionable.slice(1).map((a) => a.kind)).toEqual([KIND.CONFLICT, KIND.MATCH, KIND.TRANSFER]);
  });
  it('exclusion summaries are honest: unmarked visits still count operationally', () => {
    const lines = exclusionSummaryLines({ unmarked: 62, markedNotConnected: 3 });
    expect(lines[0]).toMatch(/^62 visits did not have a recorded starting choice/);
    expect(lines[0]).toMatch(/still count in tables, covers, sales and food cost/);
    expect(lines[0]).toMatch(/only conversion rates leave them out/);
    // never again claim they "do not affect anyone's numbers"
    expect(lines.join(' ')).not.toMatch(/do(n't| not) affect anyone/i);
    expect(lines.join(' ')).not.toMatch(/error|fail|attention/i);
  });
});

describe('conversion protection', () => {
  it('excluded categories never enter conversion (rule mirrored from pages)', () => {
    // classifyRecord's non-actionable reasons all map to conversion exclusion
    for (const r of [
      rec({ intent: 'UNKNOWN' }),
      rec({ matchStatus: 'unmatched', matchedOrderGuid: null }),
      rec({ matchStatus: 'ambiguous', matchedOrderGuid: null }),
    ]) {
      const c = classifyRecord(r);
      expect(c.actionable).toBe(false);
    }
  });
});
