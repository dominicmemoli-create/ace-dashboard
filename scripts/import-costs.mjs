#!/usr/bin/env node
// Item-cost master import.
//
// Sources:
//   node scripts/import-costs.mjs --workbook "imports/AYCE Food Cost Guide.xlsx"
//       Seeds PROVISIONAL costs from the rough management workbook
//       (source=rough_workbook, verification=unverified).
//   node scripts/import-costs.mjs --csv imports/chef_costs_YYYYMMDD.csv --effective 20260810 --source chef_confirmed
//       Replaces costs with chef-confirmed values WITHOUT rewriting history:
//       the prior cost record is closed (effective_to = day before) and a new
//       effective-dated record is appended. No code change required.
//
// Output: data/live/item_costs.json — the normalized cost master consumed by the app.
// Historical food-cost results never change when a new cost is imported, because
// every calculation resolves the cost record effective on the business date.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COSTS_PATH = path.join(ROOT, 'data', 'live', 'item_costs.json');
const ALIAS_PATH = path.join(ROOT, 'imports', 'alias_map.json');

const args = process.argv.slice(2);
function argVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
const workbookPath = argVal('--workbook');
const csvPath = argVal('--csv');
const effectiveFrom = argVal('--effective') ?? '20260601'; // rough costs predate the pilot window
const source = argVal('--source') ?? (csvPath ? 'manual' : 'rough_workbook');
const updatedBy = argVal('--by') ?? 'import-script';

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadAliases() {
  const raw = JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8'));
  delete raw._comment;
  return raw;
}

/** Extract {name, cost} rows from the rough workbook's known layout: item names in
 * column B with numeric cost in column C, in the food-cost block. */
function readWorkbook(p) {
  const wb = XLSX.read(fs.readFileSync(p));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const out = [];
  const SKIP = new Set(['reg price->', 'weekend price->', 'total ayce guests', 'jumbotron?', 'other stuff', 'alc cm/guest', 'food cost', 'cocktails pp', 'beers']);
  for (const row of rows) {
    const name = row[1];
    const cost = row[2];
    if (typeof name === 'string' && typeof cost === 'number' && cost > 0 && cost < 500) {
      if (SKIP.has(name.trim().toLowerCase())) continue;
      out.push({ name: name.trim(), cost });
    }
  }
  return out;
}

function readCsv(p) {
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const nameIdx = header.findIndex((h) => ['canonical_name', 'item', 'item_name', 'name'].includes(h));
  const costIdx = header.findIndex((h) => ['cost', 'cost_per_portion', 'unit_cost'].includes(h));
  const portionIdx = header.findIndex((h) => ['portion', 'serving'].includes(h));
  const notesIdx = header.findIndex((h) => h === 'notes');
  if (nameIdx < 0 || costIdx < 0) throw new Error('CSV must have canonical_name and cost columns (see imports/item_costs_template.csv)');
  return lines.slice(1).map((l) => {
    // simple CSV split; quoted commas not supported in the template on purpose
    const cells = l.split(',');
    return {
      name: cells[nameIdx]?.trim(),
      cost: Number(cells[costIdx]),
      portion: portionIdx >= 0 ? cells[portionIdx]?.trim() : undefined,
      notes: notesIdx >= 0 ? cells[notesIdx]?.trim() : undefined,
    };
  }).filter((r) => r.name && Number.isFinite(r.cost) && r.cost > 0);
}

// AYCE entitlement items: the guest's AYCE price is recorded on these selections,
// while every dish they actually order arrives as a separate (near-$0) AYCE round
// selection that carries the real food cost. Their direct cost is therefore an
// EXPLICIT $0 by design — documented here, never a silent zero on an unmatched item.
const AYCE_PROGRAM_ITEMS = [
  'CLASSIC PER PERSON', 'PREMIUM PER PERSON', 'ROYALTY PER PERSON',
  'CLASSIC (kids)', 'PREMIUM (kids)', 'ROYALTY (kids)',
];

// Preparation modifiers rung at $0 on AYCE checks: spice level, sauce choice,
// steak temperature, omissions, plating counts. Their cost is carried inside the
// item costs (a boil's sauce is part of the boil) — explicit $0, documented,
// so they never pollute the unmatched review queue.
const PREP_MODIFIER_ITEMS = [
  'Classic Oh Dang!', 'Classic Garlic Butter', 'Classic Cajun',
  'Maryland Style (Old Bay & Butter)', 'Lemon Garlic', 'Thai Coconut (Dairy-Free)',
  'Bayou Mambo', 'Extra Side Sauce', 'Extra Side Sauce Hosp',
  'Medium', 'Mild', 'Hot', 'Extra Hot', 'Non Spicy',
  'No Sauce', 'No Sauce No Heat',
  'Medium Well', 'Med Rare', 'Medium Rare', 'Well done', 'Well Done', 'Rare',
  'No Corn, No Potato', 'No Corn No Potato', 'No Corn', 'No Potato', 'No Potatoes',
  'No Sides', 'No Fries', 'No Bread',
  '2 Pieces', '3 Pieces', 'Same Plate',
  // Tray markers: kitchen instruction to boil multiple items in the same pot.
  // Pure routing/plating terms — zero effect on item cost (per management).
  'Tray A', 'Tray B', 'Tray C', 'Tray D', 'Tray E', 'Tray F',
];

function ensureAyceProgramRecords(existing, nameToGuid, now) {
  let added = 0;
  for (const name of PREP_MODIFIER_ITEMS) {
    if (existing.some((r) => r.canonicalName === name && r.effectiveTo === null)) continue;
    existing.push({
      id: `cost-${normalizeName(name).replace(/ /g, '-')}-prepmod`,
      toastItemGuid: nameToGuid.get(normalizeName(name)) ?? null,
      toastSelectionGuid: null,
      canonicalName: name,
      aliases: [],
      portion: 'preparation modifier',
      costPerUnit: 0,
      effectiveFrom: '20260601',
      effectiveTo: null,
      source: 'manual',
      verification: 'verified',
      notes: 'Preparation/heat/omission modifier — cost is carried in the item costs. $0 by design.',
      createdAt: now,
      updatedAt: now,
      updatedBy: 'import-script',
    });
    added++;
  }
  for (const name of AYCE_PROGRAM_ITEMS) {
    if (existing.some((r) => r.canonicalName === name && r.effectiveTo === null)) continue;
    existing.push({
      id: `cost-${normalizeName(name).replace(/ /g, '-')}-program`,
      toastItemGuid: nameToGuid.get(normalizeName(name)) ?? null,
      toastSelectionGuid: null,
      canonicalName: name,
      aliases: [],
      portion: 'AYCE entitlement (per person)',
      costPerUnit: 0,
      effectiveFrom: '20260601',
      effectiveTo: null,
      source: 'manual',
      verification: 'verified',
      notes: 'AYCE entitlement item — food cost flows through the individual AYCE round selections ordered by the table. Direct cost is $0 by design.',
      createdAt: now,
      updatedAt: now,
      updatedBy: 'import-script',
    });
    added++;
  }
  return added;
}

function main() {
  const aliases = loadAliases();
  const existing = fs.existsSync(COSTS_PATH) ? JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')) : [];

  // Resolve canonical name -> most frequent Toast item GUID from live selections.
  const nameToGuid = new Map();
  const liveDir = path.join(ROOT, 'data', 'live');
  if (fs.existsSync(liveDir)) {
    const guidCounts = new Map(); // normName -> Map(guid -> qty)
    for (const f of fs.readdirSync(liveDir)) {
      if (!/^selections_\d{8}\.json$/.test(f)) continue;
      for (const s of JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf8'))) {
        if (!s.itemGuid || !s.itemName) continue;
        const key = normalizeName(s.itemName);
        if (!guidCounts.has(key)) guidCounts.set(key, new Map());
        const m = guidCounts.get(key);
        m.set(s.itemGuid, (m.get(s.itemGuid) ?? 0) + (s.quantity || 1));
      }
    }
    for (const [key, m] of guidCounts) {
      nameToGuid.set(key, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
  }

  let incoming;
  if (workbookPath) incoming = readWorkbook(path.resolve(ROOT, workbookPath));
  else if (csvPath) incoming = readCsv(path.resolve(ROOT, csvPath));
  else { console.error('Pass --workbook <xlsx> or --csv <csv>'); process.exit(1); }

  const now = new Date().toISOString();
  const dayBefore = (yyyymmdd) => {
    const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };

  let added = 0, closed = 0;
  for (const row of incoming) {
    const aliasList = aliases[row.name] ?? [];
    // GUID resolution: canonical name and every alias, first hit wins.
    let toastItemGuid = null;
    for (const candidate of [row.name, ...aliasList]) {
      const g = nameToGuid.get(normalizeName(candidate));
      if (g) { toastItemGuid = g; break; }
    }
    // Close any open record for the same canonical item.
    for (const rec of existing) {
      if (rec.canonicalName === row.name && rec.effectiveTo === null) {
        if (rec.effectiveFrom >= effectiveFrom) {
          console.warn(`SKIP ${row.name}: existing open record effective ${rec.effectiveFrom} is not older than ${effectiveFrom}`);
        } else {
          rec.effectiveTo = dayBefore(effectiveFrom);
          rec.updatedAt = now;
          closed++;
        }
      }
    }
    existing.push({
      id: `cost-${normalizeName(row.name).replace(/ /g, '-')}-${effectiveFrom}`,
      toastItemGuid,
      toastSelectionGuid: null,
      canonicalName: row.name,
      aliases: aliasList,
      portion: row.portion ?? 'per recorded Toast selection quantity',
      costPerUnit: row.cost,
      effectiveFrom,
      effectiveTo: null,
      source,
      verification: source === 'chef_confirmed' ? 'verified' : 'unverified',
      notes: row.notes ?? (source === 'rough_workbook' ? 'ROUGH estimate from management workbook — not chef-verified' : ''),
      createdAt: now,
      updatedAt: now,
      updatedBy,
    });
    added++;
  }

  const programAdded = ensureAyceProgramRecords(existing, nameToGuid, now);
  if (programAdded) console.log(`Added ${programAdded} explicit AYCE entitlement records ($0 by design).`);

  fs.mkdirSync(path.dirname(COSTS_PATH), { recursive: true });
  fs.writeFileSync(COSTS_PATH, JSON.stringify(existing, null, 2));
  const withGuid = existing.filter((r) => r.toastItemGuid).length;
  console.log(`Imported ${added} cost records (${closed} prior records closed).`);
  console.log(`Cost master now has ${existing.length} records; ${withGuid} resolved to a Toast item GUID.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
