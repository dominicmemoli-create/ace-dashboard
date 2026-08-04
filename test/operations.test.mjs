import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIncludedCheck, servicePeriodOf, comparableBaselineDates, weekdayOf, localHour,
} from '../src/food-cost-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operations.json'), 'utf8'));

const DINING = Object.keys(OPS.includedAreas.serviceAreaGuids)[0];
const BAR = 'b2643fbc-0317-4c62-9ec5-82ebf811dbfa';

describe('area allowlist (dining room + patio only)', () => {
  const chk = (over = {}) => ({ tableGuid: 't1', voided: false, serviceAreaGuid: DINING, ...over });
  it('dining room and patio tables are included', () => {
    for (const g of Object.keys(OPS.includedAreas.serviceAreaGuids)) {
      expect(isIncludedCheck(chk({ serviceAreaGuid: g }), OPS)).toBe(true);
    }
  });
  it('bar checks are excluded', () => {
    expect(isIncludedCheck(chk({ serviceAreaGuid: BAR }), OPS)).toBe(false);
  });
  it('checks without a table are excluded (takeout/delivery)', () => {
    expect(isIncludedCheck(chk({ tableGuid: null }), OPS)).toBe(false);
  });
  it('unknown revenue centers are excluded (catering/online ordering)', () => {
    expect(isIncludedCheck(chk({ serviceAreaGuid: null, revenueCenterGuid: '3103ce68-4d07-40a6-bba8-29c9cbbe9fe9' }), OPS)).toBe(false);
  });
  it('voided checks are excluded', () => {
    expect(isIncludedCheck(chk({ voided: true }), OPS)).toBe(false);
  });
});

describe('service periods (configurable; default lunch < 4 PM ET)', () => {
  it('3:59 PM ET opens as lunch, 4:00 PM as dinner', () => {
    // 2026-08-01: EDT = UTC-4 → 19:59Z = 15:59 ET; 20:00Z = 16:00 ET
    expect(servicePeriodOf({ openedDate: '2026-08-01T19:59:00.000+0000' }, OPS)).toBe('lunch');
    expect(servicePeriodOf({ openedDate: '2026-08-01T20:00:00.000+0000' }, OPS)).toBe('dinner');
  });
  it('handles winter time (EST = UTC-5)', () => {
    expect(localHour('2026-01-15T20:30:00.000+0000', 'America/New_York')).toBe(15);
  });
});

describe('four-week comparable baseline', () => {
  const avail = [];
  for (let d = new Date(Date.UTC(2026, 6, 1)); d <= new Date(Date.UTC(2026, 7, 3)); d.setUTCDate(d.getUTCDate() + 1)) {
    avail.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  it('a Friday compares with the prior four Fridays', () => {
    const { dates } = comparableBaselineDates(['20260731'], avail, 4);
    expect(dates).toEqual(['20260703', '20260710', '20260717', '20260724']);
    for (const d of dates) expect(weekdayOf(d)).toBe(weekdayOf('20260731'));
  });
  it('a weekend combines each day\'s comparables', () => {
    const { dates } = comparableBaselineDates(['20260801', '20260802'], avail, 4);
    expect(dates).toContain('20260704'); // Saturday chain
    expect(dates).toContain('20260705'); // Sunday chain
    expect(dates.length).toBe(8);
  });
  it('the selected period is NEVER its own baseline', () => {
    const { dates } = comparableBaselineDates(['20260731', '20260724'], avail, 4);
    expect(dates).not.toContain('20260731');
    expect(dates).not.toContain('20260724'); // selected, so excluded from 0731's chain
  });
  it('reports partial availability instead of substituting', () => {
    const { perDate } = comparableBaselineDates(['20260710'], avail, 4);
    expect(perDate['20260710'].requested.length).toBe(4);
    expect(perDate['20260710'].found.length).toBe(1); // only 20260703 is in range
  });
});

describe('commission configuration', () => {
  const C = OPS.commission;
  it('rates are per converted COVER: $5 / $7.50 / $10', () => {
    expect(C.ratesPerCover).toEqual({ classic: 5, premium: 7.5, royalty: 10 });
  });
  it('active window is the pilot only and the program is inactive', () => {
    expect(C.activeFrom).toBe('20260731');
    expect(C.activeTo).toBe('20260802');
    expect(C.programActive).toBe(false);
  });
  it('no commission accrues outside the window', () => {
    const accrues = (date) => C.programActive || (date >= C.activeFrom && date <= C.activeTo);
    expect(accrues('20260803')).toBe(false);
    expect(accrues('20260810')).toBe(false);
    expect(accrues('20260801')).toBe(true); // historical pilot ledger preserved
  });
});

describe('metrics pipeline output (stale-data & dynamic dates)', () => {
  const metrics = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live', 'metrics.json'), 'utf8'));
  it('covers every ingested date with dinner rows', () => {
    const dates = new Set(metrics.rows.filter((r) => !r.serverGuid).map((r) => r.businessDate));
    expect(dates.size).toBeGreaterThanOrEqual(34);
  });
  it('period totals carry the AYCE-only fields the dashboard needs', () => {
    const r = metrics.rows.find((x) => x.businessDate === '20260731' && x.period === 'dinner' && !x.serverGuid);
    expect(r.entitlementNet).toBeGreaterThan(0);
    expect(r.roundCost).toBeGreaterThan(0);
    expect(r.checks).toBeGreaterThan(0);
  });
  it('embeds the config used (methodology disclosure)', () => {
    expect(metrics.config.servicePeriods.lunchBeforeHour).toBe(16);
  });
});
