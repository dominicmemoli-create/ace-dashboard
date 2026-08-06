/* =============================================================================
   ACE icon system — a local inline-SVG family.

   One coherent line set, authored on a 24×24 grid at 1.5 stroke with round caps
   and joins, rendered at 16px in navigation and 14–18px elsewhere. Replaces the
   Unicode geometric glyphs (◈ ◑ ◐ ⬆ ▣ ◆ ◇ ☰) that used to stand in for icons —
   those inherited whatever the system font felt like drawing, so they varied in
   weight, baseline and size between platforms and never looked like a set.

   Deliberately not a dependency. The app has no bundler and ships from GitHub
   Pages; a full icon package would be thousands of glyphs fetched to draw the
   eleven this dashboard uses.

   Every icon is decorative: it always sits beside a real text label, or on a
   control that carries its own accessible name. So the <svg> is aria-hidden and
   focusable="false", and nothing here contributes to the accessibility tree.
   ========================================================================== */

/* Path geometry only — the wrapper supplies the shared svg attributes. */
const P = {
  /* navigation */
  overview: '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  servers: '<path d="M16 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3"/><path d="M15.5 4.2a3.4 3.4 0 0 1 0 6.6"/>',
  foodcost: '<path d="M5 21V5.2A1.2 1.2 0 0 1 6.7 4.1l2.1 1 2.4-1.1 2.4 1.1 2.4-1.1 2.1 1A1.2 1.2 0 0 1 19 5.2V21l-2.3-1.3-2.35 1.3L12 19.7l-2.35 1.3L7.3 19.7Z"/><path d="M12 8.2v7.6"/><path d="M14 10.1a1.9 1.9 0 0 0-2-1.3c-1.1 0-2 .6-2 1.5s.9 1.3 2 1.5 2 .6 2 1.5-.9 1.5-2 1.5a1.9 1.9 0 0 1-2-1.3"/>',
  update: '<path d="M20.4 13.5A8.5 8.5 0 1 1 18 6.7"/><path d="M20.8 4.2v4.8h-4.8"/>',
  fixes: '<path d="M10.3 3.9 2.4 17.2a1.9 1.9 0 0 0 1.7 2.9h15.8a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/><path d="M12 9.4v4.1"/><path d="M12 17.1h.01"/>',
  pilot: '<path d="M3.6 8.4h16.8"/><rect x="2.6" y="4.4" width="18.8" height="4" rx="1.4"/><path d="M4.6 8.4v9.8a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8V8.4"/><path d="M9.8 12.3h4.4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.85.83c0 1.67-2.45 2.5-2.45 2.5"/><path d="M12 16.6h.01"/>',

  /* shell + controls */
  menu: '<path d="M3.5 6.5h17"/><path d="M3.5 12h17"/><path d="M3.5 17.5h17"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.4 4v16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2M12 19.4v2M4.5 4.5l1.4 1.4M18.1 18.1l1.4 1.4M2.6 12h2M19.4 12h2M4.5 19.5l1.4-1.4M18.1 5.9l1.4-1.4"/>',
  moon: '<path d="M20.4 14.3A8.6 8.6 0 0 1 9.7 3.6a8.6 8.6 0 1 0 10.7 10.7Z"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.6 20.2a7.6 7.6 0 0 1 14.8 0"/>',
  close: '<path d="M17.5 6.5l-11 11"/><path d="M6.5 6.5l11 11"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  chevronRight: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
  chevronDown: '<path d="M5.5 9l6.5 6.5L18.5 9"/>',
  arrowUp: '<path d="M12 19.5v-15"/><path d="M5.5 11L12 4.5 18.5 11"/>',
  arrowDown: '<path d="M12 4.5v15"/><path d="M18.5 13L12 19.5 5.5 13"/>',
  minus: '<path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5"/><path d="M12 7.9h.01"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.6v5"/><path d="M12 16.3h.01"/>',
  search: '<circle cx="11" cy="11" r="6.6"/><path d="M15.8 15.8l4.4 4.4"/>',
  calendar: '<rect x="3.2" y="5" width="17.6" height="16" rx="2"/><path d="M3.2 10h17.6"/><path d="M8 3v4M16 3v4"/>',
  download: '<path d="M12 3.6v11"/><path d="M7.5 10.2 12 14.7l4.5-4.5"/><path d="M4.4 17.2v1.6a2 2 0 0 0 2 2h11.2a2 2 0 0 0 2-2v-1.6"/>',
  external: '<path d="M14.2 4.2h5.6v5.6"/><path d="M19.8 4.2 11 13"/><path d="M18.4 14v4.4a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V7.6a2 2 0 0 1 2-2H10"/>',
};

/**
 * Inline SVG for one icon.
 * @param {string} name  key of P
 * @param {number} [size=16]
 * @param {string} [cls]  extra class on the svg
 */
export function icon(name, size = 16, cls = '') {
  const d = P[name];
  if (!d) return '';
  return `<svg class="ic${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24"`
    + ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"'
    + ` stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
}

/** True when an icon exists — lets callers fall back rather than render nothing. */
export const hasIcon = (name) => Object.prototype.hasOwnProperty.call(P, name);

export const iconNames = () => Object.keys(P);

/* The application shell in index.html is a classic script and cannot import a
   module, so the set is published for it here rather than being copied. Module
   scripts are deferred and the shell only draws chrome after the passcode is
   entered, so this is always assigned before the first call. */
if (typeof window !== 'undefined') window.ACE_ICON = icon;
