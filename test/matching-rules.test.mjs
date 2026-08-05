// OpenTable → Toast matching rules from the management brief:
// ±25-minute automatic window, multi-table overlap, patio leniency, and the
// hard candidate exclusions (online ordering, bar, takeout, no-table,
// Host To Go, $0 checks).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePair, matchVisits, toastVisits, DEFAULT_TIME_TOLERANCE_MIN } from '../src/ot-matcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operations.json'), 'utf8'));

const cfg = { timeToleranceMinutes: 25, partySizeTolerance: 2, timezone: 'America/New_York' };
const ot = (over = {}) => ({
  rowHash: 'h' + Math.random().toString(36).slice(2), businessDate: '20260801',
  visitMinutes: 18 * 60, partySize: 2, tableTokens: ['22'], serverSoftLabel: '',
  reviewStatus: 'auto', intent: 'UNDECIDED', ...over,
});
const visit = (over = {}) => ({
  orderGuid: 'v-' + Math.random().toString(36).slice(2), businessDate: '20260801',
  tableName: '22', serverGuid: 'g1', serverName: 'Kendall Throne', area: 'dining',
  openedDate: '2026-08-01T22:00:00.000+0000', // 6:00 PM EDT
  numberOfGuests: 2, net: 150, checks: 1, ...over,
});

describe('the ±25-minute automatic window is enforced', () => {
  it('the operational config uses the 25-minute window', () => {
    expect(OPS.opentableMatch.timeToleranceMinutes).toBe(25);
    expect(DEFAULT_TIME_TOLERANCE_MIN).toBe(25);
  });
  it('a candidate 26 minutes away is rejected; 25 minutes is allowed', () => {
    expect(scorePair(ot({ visitMinutes: 18 * 60 + 26 }), visit(), cfg)).toBeNull();
    expect(scorePair(ot({ visitMinutes: 18 * 60 + 25 }), visit(), cfg)).not.toBeNull();
  });
  it('a candidate several hours away is never suggested (the observed bad pattern)', () => {
    expect(scorePair(ot({ visitMinutes: 13 * 60 }), visit(), cfg)).toBeNull();
    const res = matchVisits([ot({ visitMinutes: 13 * 60 })], [visit()], cfg);
    expect(res[0].matchStatus).toBe('unmatched');
    expect(res[0].matchedOrderGuid).toBeNull();
  });
});

describe('multi-table reservations (large parties)', () => {
  it('OT tables 51,52,53 match Toast table 53 when time and party agree', () => {
    const s = scorePair(
      ot({ tableTokens: ['51', '52', '53'], partySize: 12 }),
      visit({ tableName: '53', numberOfGuests: 12 }), cfg);
    expect(s).not.toBeNull();
    expect(s.evidence.tableOverlap).toBe(true);
    expect(s.evidence.overlappingTable).toBe('53');
    const res = matchVisits([ot({ tableTokens: ['51', '52', '53'], partySize: 12 })],
      [visit({ tableName: '53', numberOfGuests: 12 })], cfg);
    expect(res[0].matchStatus).toBe('matched');
  });
  it('does not require ALL OpenTable tables to match Toast', () => {
    // only one Toast order exists for the party — the other OT tables have no counterpart
    const s = scorePair(ot({ tableTokens: ['51', '52', '53'], partySize: 12 }),
      visit({ tableName: '51', numberOfGuests: 8 }), cfg); // split across orders
    expect(s).not.toBeNull(); // party split tolerated for multi-table reservations
  });
});

describe('dining room requires compatible evidence from time+size+table+area', () => {
  it('a dining-room table-number mismatch disqualifies', () => {
    expect(scorePair(ot({ tableTokens: ['31'] }), visit({ tableName: '22', area: 'dining' }), cfg)).toBeNull();
  });
  it('an incompatible party size disqualifies', () => {
    expect(scorePair(ot({ partySize: 2 }), visit({ numberOfGuests: 8 }), cfg)).toBeNull();
  });
});

describe('patio: table numbers are unreliable and never an inherent error', () => {
  it('a patio table-number mismatch still scores on time+size evidence', () => {
    const s = scorePair(ot({ tableTokens: ['P4'] }), visit({ tableName: 'P9', area: 'patio' }), cfg);
    expect(s).not.toBeNull();
    expect(s.evidence.tableOverlap).toBe(false);
    expect(s.evidence.area).toBe('patio');
  });
  it('ambiguous patio matches go to human review, not auto-connect', () => {
    const o = ot({ tableTokens: ['P4'] });
    const res = matchVisits([o], [
      visit({ tableName: 'P9', area: 'patio' }),
      visit({ tableName: 'P2', area: 'patio', openedDate: '2026-08-01T22:10:00.000+0000' }),
    ], cfg);
    expect(res[0].matchStatus).toBe('ambiguous');       // rival candidates → human review
    expect(res[0].matchedOrderGuid).not.toBeNull();     // with the best candidate attached
  });
});

describe('hard candidate exclusions', () => {
  const ref = {
    tables: [{ guid: 't1', name: '22' }, { guid: 't2', name: '23' }],
    employees: [{ guid: 'g1', name: 'Kendall Throne' }, { guid: 'g2', name: 'Host To Go' }],
  };
  const baseCheck = (over = {}) => ({
    orderGuid: 'o' + Math.random().toString(36).slice(2), checkGuid: 'k' + Math.random(),
    tableGuid: 't1', businessDate: '20260801', amount: 80, voided: false,
    serverGuid: 'g1', openedDate: '2026-08-01T22:00:00.000+0000', numberOfGuests: 2,
    serviceAreaGuid: 'dining-area', ...over,
  });
  const opsFilter = (c) => c.serviceAreaGuid === 'dining-area' || c.serviceAreaGuid === 'patio-area';

  it('no-table checks are never candidates (online ordering / takeout / delivery)', () => {
    expect(toastVisits([baseCheck({ tableGuid: null })], ref, opsFilter)).toHaveLength(0);
  });
  it('checks outside included areas (bar, online ordering) are never candidates', () => {
    expect(toastVisits([baseCheck({ serviceAreaGuid: 'bar-area' })], ref, opsFilter)).toHaveLength(0);
  });
  it('$0 checks are never candidates', () => {
    expect(toastVisits([baseCheck({ amount: 0 })], ref, opsFilter)).toHaveLength(0);
  });
  it('Host To Go rows are never suggested as floor-table candidates', () => {
    expect(toastVisits([baseCheck({ serverGuid: 'g2' })], ref, opsFilter)).toHaveLength(0);
  });
  it('a mixed-server order (Host To Go + real server) attributes to the real server, in any check order', () => {
    const htg = baseCheck({ orderGuid: 'oMix', serverGuid: 'g2', amount: 0 });
    const real = baseCheck({ orderGuid: 'oMix', serverGuid: 'g1', amount: 90 });
    for (const order of [[htg, real], [real, htg]]) {
      const vs = toastVisits(order, ref, opsFilter);
      expect(vs).toHaveLength(1);
      expect(vs[0].serverName).toBe('Kendall Throne');
      expect(vs[0].net).toBe(90);
    }
  });
  it('voided checks are never candidates', () => {
    expect(toastVisits([baseCheck({ voided: true })], ref, opsFilter)).toHaveLength(0);
  });
  it('a normal floor check IS a candidate, with its area attached', () => {
    const vs = toastVisits([baseCheck()], ref, opsFilter, { areaOf: () => 'dining' });
    expect(vs).toHaveLength(1);
    expect(vs[0].area).toBe('dining');
    expect(vs[0].serverName).toBe('Kendall Throne');
  });
});

describe('match evidence for Fixes Needed cards', () => {
  it('exposes time difference, table overlap and party-size difference', () => {
    const res = matchVisits(
      [ot({ visitMinutes: 18 * 60 + 10, partySize: 3, serverSoftLabel: 'kendall' })],
      [visit({ numberOfGuests: 2 })], cfg);
    const e = res[0].matchEvidence;
    expect(e.timeDiffMin).toBe(10);
    expect(e.tableOverlap).toBe(true);
    expect(e.partyDiff).toBe(1);
  });
});
