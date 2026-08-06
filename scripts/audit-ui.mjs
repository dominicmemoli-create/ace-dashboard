#!/usr/bin/env node
/* Responsive + accessibility audit for the dashboard.
   Not part of the app or the test suite — a local QA tool alongside shots.mjs.

   Checks, per route × viewport × theme:
     - horizontal page overflow and any element wider than the viewport
     - contrast of every rendered text node against its painted background
     - icon-only controls without an accessible name
     - touch-target size below 44px on mobile
     - console and page errors

   Usage: node scripts/audit-ui.mjs [base-url]
*/
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5188/';
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1024', width: 1024, height: 768 },
  { name: '768', width: 768, height: 1024 },
  { name: '390', width: 390, height: 844 },
];
const ROUTES = ['ops', 'servers', 'foodcost', 'update', 'fixes', 'pilot', 'help'];
const THEMES = ['light', 'dark'];

/* WCAG relative luminance + contrast ratio. */
const lum = ([r, g, b]) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const AUDIT = () => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  /* the painted background is the nearest ancestor that is not transparent */
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c.rgb;
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const vw = document.documentElement.clientWidth;
  const out = { overflow: [], text: [], names: [], targets: [], scrollW: document.documentElement.scrollWidth, vw };

  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;

    /* elements sticking out past the viewport (ignore intentional x-scrollers) */
    if (r.right > vw + 1 && !el.closest('.tw,.seg,.seg-w,#tip,.drawer,.pop')) {
      out.overflow.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} right=${Math.round(r.right)}`);
    }

    /* accessible name on icon-only controls */
    if (/^(BUTTON|A)$/.test(el.tagName)) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!label) out.names.push(`${el.tagName} #${el.id || ''}.${(el.className || '').toString().split(' ')[0]}`);
      if (vw <= 500 && (r.height < 43.5 || r.width < 43.5) && !el.closest('.chip,.linkbtn,.inf')) {
        out.targets.push(`${el.id || el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }

    /* contrast of direct text */
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (own) {
      const fg = parse(cs.color);
      if (fg && fg.a > 0.5) {
        out.text.push({
          fg: fg.rgb,
          bg: bgOf(el),
          size: parseFloat(cs.fontSize),
          weight: +cs.fontWeight || 400,
          sample: el.textContent.trim().slice(0, 42),
          sel: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}`,
        });
      }
    }
  });
  return out;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : { channel: process.env.BROWSER_CHANNEL || 'chrome' });

const problems = [];
const errors = [];

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${theme}/${vp.name}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${theme}/${vp.name}] pageerror: ${e.message}`));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate((t) => localStorage.setItem('ace.theme', JSON.stringify(t)), theme);
    await page.reload({ waitUntil: 'networkidle' });
    await page.fill('#pw', 'ACE2026');
    await page.click('#gform button[type=submit]');
    await page.waitForTimeout(1300);

    for (const route of ROUTES) {
      const ok = await page.evaluate((k) => {
        const app = window.__ACE_APP__;
        if (!app || !app.PAGES[k]) return false;
        app.setPage(k); return true;
      }, route);
      if (!ok) continue;
      await page.waitForTimeout(800);
      await page.evaluate(() => window.scrollTo(0, 0));

      const r = await page.evaluate(AUDIT);
      const at = `${theme}/${vp.name}/${route}`;

      if (r.scrollW > r.vw + 1) problems.push(`OVERFLOW ${at}: scrollWidth ${r.scrollW} > ${r.vw}`);
      [...new Set(r.overflow)].slice(0, 4).forEach((o) => problems.push(`WIDE ${at}: ${o}`));
      [...new Set(r.names)].forEach((n) => problems.push(`NO-NAME ${at}: ${n}`));
      [...new Set(r.targets)].forEach((t) => problems.push(`TOUCH ${at}: ${t}`));

      const seen = new Set();
      for (const t of r.text) {
        const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700);
        const need = large ? 3 : 4.5;
        const cr = ratio(t.fg, t.bg);
        if (cr < need) {
          const key = `${t.sel}|${t.fg}|${t.bg}`;
          if (seen.has(key)) continue;
          seen.add(key);
          problems.push(`CONTRAST ${at}: ${cr.toFixed(2)}:1 (need ${need}) ${t.sel} "${t.sample}"`);
        }
      }
    }
    await ctx.close();
  }
}
await browser.close();

const uniq = [...new Set(problems)];
console.log(uniq.length ? uniq.join('\n') : 'no problems found');
console.log(`\n--- ${uniq.length} problem(s) ---`);
const realErrors = [...new Set(errors)].filter((e) => !/node:crypto|status of 401|ERR_FAILED|status of 404/.test(e));
console.log('console errors (excluding known pre-existing):', realErrors.length ? `\n${realErrors.join('\n')}` : 'none');
