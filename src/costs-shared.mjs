// Chef cost-file handling shared by the browser Food Costs upload.
// Parsing + preview diff only — the authoritative write (effective dating,
// close-and-append, audit fields) happens server-side in ace_upload_costs().
import { parseCsv } from './opentable.mjs?v=20260806-v2';

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chef CSV (canonical_name,cost[,portion,notes] — header names tolerant).
 * Detailed variant: returns { rows, rejected } so uploads can show a
 * rejected-row report instead of silently dropping malformed lines.
 * Returns null when the header is not a cost file at all. */
export function parseCostCsvDetailed(text) {
  const raw = parseCsv(String(text ?? '').replace(/^﻿/, ''));
  if (!raw.length) return { rows: [], rejected: [] };
  const header = raw[0].map((h) => String(h ?? '').trim().toLowerCase());
  const nameIdx = header.findIndex((h) => ['canonical_name', 'item', 'item_name', 'name'].includes(h));
  const costIdx = header.findIndex((h) => ['cost', 'cost_per_portion', 'unit_cost'].includes(h));
  const portionIdx = header.findIndex((h) => ['portion', 'serving'].includes(h));
  const notesIdx = header.findIndex((h) => h === 'notes');
  if (nameIdx < 0 || costIdx < 0) return null; // not a cost file
  const rows = [], rejected = [];
  raw.slice(1).forEach((cells, i) => {
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return; // blank line
    const r = {
      name: String(cells[nameIdx] ?? '').trim(),
      cost: Number(cells[costIdx]),
      portion: portionIdx >= 0 ? String(cells[portionIdx] ?? '').trim() : undefined,
      notes: notesIdx >= 0 ? String(cells[notesIdx] ?? '').trim() : undefined,
    };
    if (!r.name) rejected.push({ line: i + 2, name: r.name, why: 'missing item name' });
    else if (!Number.isFinite(r.cost)) rejected.push({ line: i + 2, name: r.name, why: `cost is not a number ("${String(cells[costIdx] ?? '').trim()}")` });
    else if (r.cost <= 0) rejected.push({ line: i + 2, name: r.name, why: 'cost must be above $0' });
    else if (r.cost >= 500) rejected.push({ line: i + 2, name: r.name, why: 'cost of $500+ per portion looks wrong — check the units' });
    else rows.push(r);
  });
  return { rows, rejected };
}

/** Legacy contract: valid rows only (null when not a cost file). */
export function parseCostCsv(text) {
  const d = parseCostCsvDetailed(text);
  return d === null ? null : d.rows;
}

/** XLSX sheet as array-of-arrays → cost rows. Tries a header row first, then
 * falls back to the known management-workbook layout (names in column B,
 * numeric cost in column C). Detailed variant reports rejected header-layout
 * rows; the heuristic workbook layout cannot attribute rejects line-by-line,
 * so it reports layout: 'workbook' and the caller discloses that only
 * recognized rows are read. */
export function rowsFromWorkbookAoaDetailed(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return { rows: [], rejected: [], layout: 'empty' };
  const header = (aoa[0] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
  const nameIdx = header.findIndex((h) => ['canonical_name', 'item', 'item_name', 'name'].includes(h));
  const costIdx = header.findIndex((h) => ['cost', 'cost_per_portion', 'unit_cost'].includes(h));
  if (nameIdx >= 0 && costIdx >= 0) {
    const portionIdx = header.findIndex((h) => ['portion', 'serving'].includes(h));
    const notesIdx = header.findIndex((h) => h === 'notes');
    const rows = [], rejected = [];
    aoa.slice(1).forEach((row, i) => {
      if (!row || !row.some((c) => String(c ?? '').trim() !== '')) return; // blank
      const r = {
        name: String(row[nameIdx] ?? '').trim(),
        cost: Number(row[costIdx]),
        portion: portionIdx >= 0 ? String(row[portionIdx] ?? '').trim() : undefined,
        notes: notesIdx >= 0 ? String(row[notesIdx] ?? '').trim() : undefined,
      };
      if (!r.name) rejected.push({ line: i + 2, name: r.name, why: 'missing item name' });
      else if (!Number.isFinite(r.cost)) rejected.push({ line: i + 2, name: r.name, why: `cost is not a number ("${String(row[costIdx] ?? '').trim()}")` });
      else if (r.cost <= 0) rejected.push({ line: i + 2, name: r.name, why: 'cost must be above $0' });
      else if (r.cost >= 500) rejected.push({ line: i + 2, name: r.name, why: 'cost of $500+ per portion looks wrong — check the units' });
      else rows.push(r);
    });
    return { rows, rejected, layout: 'header' };
  }
  // rough-workbook layout fallback (mirrors scripts/import-costs.mjs)
  const SKIP = new Set(['reg price->', 'weekend price->', 'total ayce guests', 'jumbotron?', 'other stuff', 'alc cm/guest', 'food cost', 'cocktails pp', 'beers']);
  const out = [];
  for (const row of aoa) {
    const name = row?.[1];
    const cost = row?.[2];
    if (typeof name === 'string' && typeof cost === 'number' && cost > 0 && cost < 500) {
      if (SKIP.has(name.trim().toLowerCase())) continue;
      out.push({ name: name.trim(), cost });
    }
  }
  return { rows: out, rejected: [], layout: 'workbook' };
}

/** Legacy contract: rows only. */
export function rowsFromWorkbookAoa(aoa) {
  return rowsFromWorkbookAoaDetailed(aoa).rows;
}

/** Attach configured aliases so the server can resolve Toast GUIDs. */
export function attachAliases(rows, aliasMap) {
  const map = aliasMap ?? {};
  return rows.map((r) => ({ ...r, aliases: map[r.name] ?? [] }));
}

/**
 * Preview diff against the current cost master (what the visitor confirms).
 * `costRecords` are the normalized records from ace_item_costs payloads.
 */
export function diffCosts(incoming, costRecords, effectiveFrom) {
  const openByName = new Map();
  for (const rec of costRecords ?? []) {
    if (rec.effectiveTo == null) openByName.set(rec.canonicalName, rec);
  }
  const changed = [], unchanged = [], added = [], skipped = [];
  for (const row of incoming) {
    const open = openByName.get(row.name);
    if (!open) { added.push({ name: row.name, newCost: row.cost }); continue; }
    if (open.effectiveFrom > effectiveFrom) {
      skipped.push({ name: row.name, why: `a newer cost is already effective ${open.effectiveFrom}` });
      continue;
    }
    if (Math.abs((open.costPerUnit ?? 0) - row.cost) > 0.005) {
      changed.push({ name: row.name, oldCost: open.costPerUnit, newCost: row.cost });
    } else {
      unchanged.push({ name: row.name, cost: row.cost });
    }
  }
  return { recognized: incoming.length, changed, unchanged, added, skipped };
}

/** Toast items that would STILL have no cost after this upload. */
export function stillUncosted(unmatchedNames, incoming, aliasMap) {
  const covered = new Set();
  for (const r of incoming) {
    covered.add(normalizeName(r.name));
    for (const a of (aliasMap?.[r.name] ?? [])) covered.add(normalizeName(a));
  }
  return [...new Set(unmatchedNames)].filter((n) => !covered.has(normalizeName(n)));
}
