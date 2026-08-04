import { describe, it, expect } from 'vitest';
import {
  parseGuestCenter, classifyIntentTags, tableTokens, serverSoftLabel,
  sanitizeVisit, visitMinutes,
} from '../src/opentable.mjs';
import { scorePair, matchVisits, toastVisits } from '../src/ot-matcher.mjs';

describe('intent normalization (Reservation Tags only)', () => {
  it('UNDECIDED. → UNDECIDED', () => {
    expect(classifyIntentTags('UNDECIDED.').intent).toBe('UNDECIDED');
  });
  it('A LA CARTE → ALC (with stray spacing/case)', () => {
    expect(classifyIntentTags(' a la carte ').intent).toBe('ALC');
  });
  it('AYCE → PREDECIDED_AYCE', () => {
    expect(classifyIntentTags('AYCE').intent).toBe('PREDECIDED_AYCE');
  });
  it('no recognized tag → UNKNOWN (non-intent tags ignored)', () => {
    expect(classifyIntentTags('First Timers,Birthday').intent).toBe('UNKNOWN');
    expect(classifyIntentTags('').intent).toBe('UNKNOWN');
    expect(classifyIntentTags(null).intent).toBe('UNKNOWN');
  });
  it('conflicting intent tags → REVIEW_REQUIRED', () => {
    expect(classifyIntentTags('AYCE,UNDECIDED.').intent).toBe('REVIEW_REQUIRED');
  });
  it('Half/Half → MIXED_MENU_EXCEPTION flag', () => {
    const c = classifyIntentTags('Half/Half');
    expect(c.mixedMenuException).toBe(true);
    expect(c.intent).toBe('UNKNOWN'); // no directional intent recorded
  });
  it('intent never comes from free text (only the tags argument exists)', () => {
    // structural: classifyIntentTags takes reservation tags only; guest
    // requests/notes have no path into it (see sanitizeVisit).
    const v = sanitizeVisit({
      visitDate: '2026-08-01', visitTime: '05:00 PM', size: 2, status: 'Done',
      table: '22', serverText: '', posSubtotal: 0, reservationTags: '',
      guestRequests: 'we want AYCE please', visitNotes: 'AYCE',
      raw: ['x'],
    }, 'run1');
    expect(v.intent).toBe('UNKNOWN');
  });
});

describe('sample-export fixture (reproduces supplied GuestCenter conditions)', () => {
  const mk = (tags, i) => `2026-08-01,06:0${i % 10} PM,Test Guest,555-000${i},2,Done,${20 + (i % 30)},,Walk-in,9. Kendall 4:00,,,,[],0,,100,10,0,0,110,0,,Not Paid,,0,10,110,110,110,110,req,note,"${tags}",,`;
  const HEADER = 'Visit Date,Visit Time,Guest Name,Phone Number,Size,Status,Table,Dining Area Assigned,Source,Server,Experience Title,Experience Price Type,Experience Price,Additional Payments,Additional Payments Subtotal,Prepaid Experience Gratuity,POS Subtotal,POS Tax,POS Service Charges,POS Gratuity,POS Paid,POS Due,Prepayment Method,Prepayment Status,Prepaid Experience Total Paid,Total Gratuity,Total Tax,Experience Total Sales,Experience Total Sales with Gratuity,Total Income,Total Income with Gratuity,Guest Requests,Visit Notes,Reservation Tags,Guest Tags,Completed Visits';
  const lines = [HEADER];
  let n = 0;
  for (let i = 0; i < 124; i++) lines.push(mk('UNDECIDED.,First Timers', n++));
  for (let i = 0; i < 37; i++) lines.push(mk('A LA CARTE', n++));
  for (let i = 0; i < 38; i++) lines.push(mk('AYCE', n++));
  for (let i = 0; i < 62; i++) lines.push(mk('Birthday', n++));
  for (let i = 0; i < 11; i++) lines.push(mk('Half/Half', n++));
  lines.push(mk('AYCE,UNDECIDED.', n++)); // the one conflicting visit
  const visits = parseGuestCenter(lines.join('\n'));
  const sanitized = visits.map((v) => sanitizeVisit(v, 'fixture'));

  it('parses 262+11 = 273 fixture rows (sample had 262 with tag multiplicity)', () => {
    expect(visits.length).toBe(273);
  });
  it('reproduces the intent census shape', () => {
    const c = {};
    for (const s of sanitized) c[s.intent] = (c[s.intent] ?? 0) + 1;
    expect(c.UNDECIDED).toBe(124);
    expect(c.ALC).toBe(37);
    expect(c.PREDECIDED_AYCE).toBe(38);
    expect(c.REVIEW_REQUIRED).toBe(1);
    expect(c.UNKNOWN).toBe(62 + 11); // Half/Half rows carry no directional intent
    expect(sanitized.filter((s) => s.mixedMenuException).length).toBe(11);
  });
  it('sanitized rows contain no PII', () => {
    for (const s of sanitized) {
      const json = JSON.stringify(s);
      expect(json).not.toContain('Test Guest');
      expect(json).not.toContain('555-000');
      expect(json).not.toContain('req');
      expect('guestName' in s).toBe(false);
      expect('phone' in s).toBe(false);
    }
  });
  it('conflict/mixed rows are queued for review', () => {
    expect(sanitized.filter((s) => s.reviewStatus === 'pending_review').length).toBe(12); // 11 half/half + 1 conflict
  });
});

describe('table + server normalization', () => {
  it('combined tables split into ordered tokens', () => {
    expect(tableTokens('51,52,53')).toEqual(['51', '52', '53']);
  });
  it('patio alphanumeric names preserved', () => {
    expect(tableTokens('H1')).toEqual(['H1']);
    expect(tableTokens('h2')).toEqual(['H2']);
  });
  it('server text is a soft label, never identity', () => {
    expect(serverSoftLabel('9. Kendall 4:00')).toBe('kendall');
    expect(serverSoftLabel('4. Jon DBL 4:15')).toBe('jon');
    expect(serverSoftLabel('2. Dom DBL')).toBe('dom');
  });
  it('visit time parses to minutes', () => {
    expect(visitMinutes('08:57 PM')).toBe(20 * 60 + 57);
    expect(visitMinutes('11:15 AM')).toBe(11 * 60 + 15);
  });
});

describe('matcher', () => {
  const cfg = { timeToleranceMinutes: 90, partySizeTolerance: 2, timezone: 'America/New_York' };
  const ot = (over = {}) => ({
    rowHash: Math.random().toString(36).slice(2), businessDate: '20260801',
    visitMinutes: 18 * 60, partySize: 2, tableTokens: ['22'], serverSoftLabel: 'kendall',
    reviewStatus: 'auto', intent: 'UNDECIDED', ...over,
  });
  const visit = (over = {}) => ({
    orderGuid: 'v-' + Math.random().toString(36).slice(2), businessDate: '20260801',
    tableName: '22', serverGuid: 'g1', serverName: 'Kendall Throne',
    openedDate: '2026-08-01T22:00:00.000+0000', // 6 PM EDT
    numberOfGuests: 2, ...over,
  });

  it('date mismatch disqualifies', () => {
    expect(scorePair(ot({ businessDate: '20260802' }), visit(), cfg)).toBeNull();
  });
  it('time outside tolerance disqualifies', () => {
    expect(scorePair(ot({ visitMinutes: 12 * 60 }), visit(), cfg)).toBeNull();
  });
  it('table+time+size+server yields a confident match', () => {
    const s = scorePair(ot(), visit(), cfg);
    expect(s.score).toBeGreaterThan(0.9);
  });
  it('combined tables match any token', () => {
    const s = scorePair(ot({ tableTokens: ['51', '52', '53'] }), visit({ tableName: '52' }), cfg);
    expect(s.score).toBeGreaterThan(0.5);
  });
  it('one OT row never matches two visits; near-ties are ambiguous', () => {
    const o = ot();
    const res = matchVisits([o], [visit({ orderGuid: 'a' }), visit({ orderGuid: 'b' })], cfg);
    expect(res[0].matchStatus).toBe('ambiguous'); // two identical candidates
  });
  it('two OT rows never share one visit', () => {
    const v = visit({ orderGuid: 'only' });
    const res = matchVisits([ot(), ot()], [v], cfg);
    const claimed = res.filter((r) => r.matchedOrderGuid === 'only');
    expect(claimed.length).toBe(1);
  });
  it('toastVisits consolidates split checks into one visit', () => {
    const ref = { tables: [{ guid: 't1', name: '22' }] };
    const checks = [
      { orderGuid: 'o1', checkGuid: 'k1', tableGuid: 't1', businessDate: '20260801', amount: 50, voided: false, serverGuid: 'g1', openedDate: '2026-08-01T22:00:00.000+0000', numberOfGuests: 4 },
      { orderGuid: 'o1', checkGuid: 'k2', tableGuid: 't1', businessDate: '20260801', amount: 60, voided: false, serverGuid: 'g1', openedDate: '2026-08-01T22:00:00.000+0000', numberOfGuests: 4 },
    ];
    const vs = toastVisits(checks, ref);
    expect(vs.length).toBe(1);
    expect(vs[0].net).toBe(110);
    expect(vs[0].checks).toBe(2);
  });
});
