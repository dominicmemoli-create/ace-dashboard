// OpenTable GuestCenter export handling — parsing, intent normalization,
// table-token normalization, PII-stripping sanitization.
// Environment-agnostic: Node (scripts/import-opentable.mjs, tests) uses the
// sync sanitizeVisit(); the browser upload flow uses sanitizeVisitAsync().
// Both produce byte-identical rowHash values, so browser uploads stay
// idempotent against rows imported earlier from the CLI.
let nodeCrypto = null;
try { nodeCrypto = (await import('node:crypto')).default; } catch { /* browser */ }

/** CSV parser with quoted-field support (GuestCenter quotes multi-tag cells). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (cell !== '' || row.length) { row.push(cell); rows.push(row); row = []; cell = ''; }
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseGuestCenter(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows.slice(1).filter((r) => r.length > 3).map((r) => {
    const get = (name) => (idx[name] != null ? (r[idx[name]] ?? '').trim() : '');
    return {
      visitDate: get('Visit Date'),
      visitTime: get('Visit Time'),
      guestName: get('Guest Name'),          // PII — stripped by sanitize()
      phone: get('Phone Number'),            // PII — stripped by sanitize()
      size: Number(get('Size')) || null,
      status: get('Status'),
      table: get('Table'),
      diningArea: get('Dining Area Assigned'), // blank in supplied export — do not rely on it
      source: get('Source'),
      serverText: get('Server'),             // display/scheduling text, NOT identity
      posSubtotal: Number(get('POS Subtotal')) || 0,
      guestRequests: get('Guest Requests'),  // PII/free text — never parsed for intent
      visitNotes: get('Visit Notes'),        // PII/free text — never parsed for intent
      reservationTags: get('Reservation Tags'),
      guestTags: get('Guest Tags'),
      raw: r,
    };
  });
}

/**
 * Intent from Reservation Tags ONLY. Recognized: UNDECIDED. / A LA CARTE /
 * AYCE (punctuation, spacing, case normalized). Everything else
 * (First Timers, Birthday, …) is a non-intent tag and ignored.
 *   0 intent tags → UNKNOWN
 *   1 intent tag  → UNDECIDED | ALC | PREDECIDED_AYCE
 *   2+ distinct   → REVIEW_REQUIRED
 * Half/Half is NOT an intent and NOT a mixed-menu exception: it records that
 * roughly half the party are returning guests and half are first-time
 * visitors. It is preserved as optional visit metadata (halfHalf) and has no
 * effect on starting preference, review status, or Fixes Needed.
 */
export function classifyIntentTags(reservationTags) {
  const tokens = String(reservationTags ?? '')
    .split(',')
    .map((t) => t.trim().replace(/\.+$/, '').replace(/\s+/g, ' ').toUpperCase())
    .filter(Boolean);
  const intents = new Set();
  let halfHalf = false;
  const relevant = [];
  for (const t of tokens) {
    if (t === 'UNDECIDED') { intents.add('UNDECIDED'); relevant.push(t); }
    else if (t === 'A LA CARTE' || t === 'ALC' || t === 'ALACARTE') { intents.add('ALC'); relevant.push(t); }
    else if (t === 'AYCE') { intents.add('PREDECIDED_AYCE'); relevant.push(t); }
    else if (t === 'HALF/HALF' || t === 'HALF HALF') { halfHalf = true; relevant.push(t); }
  }
  let intent;
  if (intents.size > 1) intent = 'REVIEW_REQUIRED';
  else if (intents.size === 1) intent = [...intents][0];
  else intent = 'UNKNOWN';
  return { intent, halfHalf, relevantTags: relevant };
}

/** '51,52,53' → ['51','52','53'];  'H1' → ['H1']. Letters preserved. */
export function tableTokens(tableValue) {
  return String(tableValue ?? '')
    .split(/[,;/]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .sort();
}

/** OpenTable server display text → soft label: '9. Kendall 4:00' → 'kendall';
 * '4. Jon DBL 4:15' → 'jon'. Supporting signal only — never identity. */
export function serverSoftLabel(serverText) {
  const cleaned = String(serverText ?? '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\bDBL\b/gi, '')
    .trim();
  return cleaned.split(/\s+/)[0]?.toLowerCase() ?? '';
}

/** '08:57 PM' + '2026-08-02' → ISO-ish minutes since midnight + businessDate.
 * OpenTable visit dates are calendar dates; late-night rows (rare) stay on the
 * calendar date — Toast matching uses time proximity, not date arithmetic. */
export function visitMinutes(visitTime) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(visitTime ?? '').trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

/** Stable dedup key: sha256 of the raw source row, first 24 hex chars. */
export function rowHashOf(raw) {
  if (!nodeCrypto) throw new Error('rowHashOf is Node-only; use rowHashOfAsync in the browser');
  return nodeCrypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 24);
}
export async function rowHashOfAsync(raw) {
  const data = new TextEncoder().encode(JSON.stringify(raw));
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

/**
 * Sanitized operational record — everything the shared dashboard may see.
 * NO guest name, NO phone, NO free-text requests/notes.
 */
export function sanitizeVisitCore(v, runId, rowHash) {
  const { intent, halfHalf, relevantTags } = classifyIntentTags(v.reservationTags);
  return {
    rowHash,
    runId,
    businessDate: v.visitDate.replace(/-/g, ''),
    visitTime: v.visitTime,
    visitMinutes: visitMinutes(v.visitTime),
    partySize: v.size,
    status: v.status,
    tableTokens: tableTokens(v.table),
    diningArea: v.diningArea || null,   // host-assigned area (often blank; display only)
    serverSoftLabel: serverSoftLabel(v.serverText),
    intent,
    halfHalf,           // returning/first-time mix note — metadata only
    relevantTags,
    posSubtotal: v.posSubtotal,
    matchStatus: 'unmatched',
    matchedOrderGuid: null,
    matchConfidence: null,
    reviewStatus: intent === 'REVIEW_REQUIRED' ? 'pending_review' : 'auto',
  };
}

export function sanitizeVisit(v, runId) {
  return sanitizeVisitCore(v, runId, rowHashOf(v.raw));
}
export async function sanitizeVisitAsync(v, runId) {
  return sanitizeVisitCore(v, runId, await rowHashOfAsync(v.raw));
}
