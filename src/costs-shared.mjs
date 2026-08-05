// Chef cost-file handling shared by the browser Food Costs upload.
// Parsing + preview diff only — the authoritative write (effective dating,
// close-and-append, audit fields) happens server-side in ace_upload_costs().
import { parseCsv } from './opentable.mjs';

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chef CSV (canonical_name,cost[,portion,notes] — header names tolerant). */
export function parseCostCsv(text) {
  const rows = parseCsv(String(text ?? '').replace(/^﻿/, ''));
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
  const nameIdx = header.findIndex((h) => ['canonical_name', 'item', 'item_name', 'name'].includes(h));
  const costIdx = header.findIndex((h) => ['cost', 'cost_per_portion', 'unit_cost'].includes(h));
  const portionIdx = header.findIndex((h) => ['portion', 'serving'].includes(h));
  const notesIdx = header.findIndex((h) => h === 'notes');
  if (nameIdx < 0 || costIdx < 0) return null; // not a cost file
  return rows.slice(1).map((cells) => ({
    name: String(cells[nameIdx] ?? '').trim(),
    cost: Number(cells[costIdx]),
    portion: portionIdx >= 0 ? String(cells[portionIdx] ?? '').trim() : undefined,
    notes: notesIdx >= 0 ? String(cells[notesIdx] ?? '').trim() : undefined,
  })).filter((r) => r.name && Number.isFinite(r.cost) && r.cost > 0);
}

/** XLSX sheet as array-of-arrays → cost rows. Tries a header row first, then
 * falls back to the known management-workbook layout (names in column B,
 * numeric cost in column C). */
export function rowsFromWorkbookAoa(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return [];
  const header = (aoa[0] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
  const nameIdx = header.findIndex((h) => ['canonical_name', 'item', 'item_name', 'name'].includes(h));
  const costIdx = header.findIndex((h) => ['cost', 'cost_per_portion', 'unit_cost'].includes(h));
  if (nameIdx >= 0 && costIdx >= 0) {
    const portionIdx = header.findIndex((h) => ['portion', 'serving'].includes(h));
    const notesIdx = header.findIndex((h) => h === 'notes');
    return aoa.slice(1).map((row) => ({
      name: String(row[nameIdx] ?? '').trim(),
      cost: Number(row[costIdx]),
      portion: portionIdx >= 0 ? String(row[portionIdx] ?? '').trim() : undefined,
      notes: notesIdx >= 0 ? String(row[notesIdx] ?? '').trim() : undefined,
    })).filter((r) => r.name && Number.isFinite(r.cost) && r.cost > 0);
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
  return out;
}

/** Attach configured aliases so the server can resolve Toast GUIDs. */
export function attachAliases(rows, aliasMap) {
  const map = aliasMap ?? {};
  return rows.map((r) => ({ ...r, aliases: map[r.name] ?? [] }));
}

/**
 * Preview diff against the current cost master (what the manager confirms).
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
