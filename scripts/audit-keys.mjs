#!/usr/bin/env node
/* Keyboard and interaction audit — a local QA tool, not part of the suite.
   Usage: node scripts/audit-keys.mjs [base-url] */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5188/';
const browser = await chromium.launch(process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : { channel: process.env.BROWSER_CHANNEL || 'chrome' });

const fails = [];
const ok = [];
const check = (name, pass, detail = '') => (pass ? ok : fails).push(`${name}${detail ? ` — ${detail}` : ''}`);

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#pw', 'ACE2026');
await page.click('#gform button[type=submit]');
await page.waitForTimeout(1400);

const active = () => page.evaluate(() => {
  const el = document.activeElement;
  return { tag: el.tagName, id: el.id, cls: (el.className || '').toString(), text: (el.textContent || '').trim().slice(0, 30) };
});

/* 1 — dismissing the gate hands focus to the top of the document, so a keyboard
   user lands on the skip link rather than resuming inside the shell */
let a = await active();
check('focus rests on the skip link after unlock', a.cls.includes('skiplink'), `${a.tag}.${a.cls}`);
await page.keyboard.press('Tab');
a = await active();
check('Tab from there enters the shell', a.id === 'railBtn' || a.cls.includes('themebtn') || a.tag === 'BUTTON', `${a.tag}#${a.id}`);
const ring = await page.evaluate(() => {
  const el = document.querySelector('.skiplink');
  el.focus();
  const cs = getComputedStyle(el);
  return { top: cs.top, shadow: cs.boxShadow };
});
check('skip link becomes visible on focus', ring.top === '0px', `top=${ring.top}`);

/* 2 — every nav item is reachable and Enter activates it */
const navReach = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#navlist button')];
  return btns.every((b) => b.tabIndex >= 0) && btns.length === 7;
});
check('all 7 nav items are tabbable', navReach);

await page.focus('#navlist button:nth-of-type(1)');
await page.evaluate(() => [...document.querySelectorAll('#navlist button')].find((b) => b.textContent.includes('Server Performance')).focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
check('Enter on a nav item changes route',
  await page.evaluate(() => window.__ACE_APP__.S.page === 'servers'),
  await page.evaluate(() => window.__ACE_APP__.S.page));

/* 3 — focus-visible produces a ring on interactive elements */
const rings = await page.evaluate(() => {
  const out = {};
  for (const sel of ['#navlist button', '.ctl', '.seg-o input', '#themeBtn', '#railBtn']) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = 'missing'; continue; }
    el.focus();
    const target = sel === '.seg-o input' ? el.closest('.seg-o') : el;
    out[sel] = getComputedStyle(target).boxShadow;
  }
  return out;
});
for (const [sel, shadow] of Object.entries(rings)) {
  check(`focus ring on ${sel}`, shadow !== 'missing' && shadow !== 'none', shadow);
}

/* 4 — the segmented control is one tab stop with arrow-key selection */
await page.evaluate(() => window.__ACE_APP__.setPage('ops'));
await page.waitForTimeout(900);
const segBefore = await page.evaluate(() => document.querySelector('input[name=opsPeriod]:checked')?.value);
await page.evaluate(() => document.querySelector('input[name=opsPeriod]:checked').focus());
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(900);
const segAfter = await page.evaluate(() => document.querySelector('input[name=opsPeriod]:checked')?.value);
check('arrow key moves the segmented control', segBefore !== segAfter, `${segBefore} -> ${segAfter}`);
const tabStops = await page.evaluate(() => [...document.querySelectorAll('input[name=opsPeriod]')].filter((i) => i.tabIndex !== -1 && (i.checked || i.tabIndex > 0)).length);
check('segmented control is a single tab stop', tabStops === 1, `${tabStops} stop(s)`);
/* restore */
await page.evaluate(() => { const i = document.querySelector('input[name=opsPeriod][value=all]'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForTimeout(900);

/* 5 — rail collapse keeps names accessible and redraws the charts */
const preW = await page.evaluate(() => document.querySelector('.plot svg')?.getBoundingClientRect().width || 0);
await page.click('#railBtn');
await page.waitForTimeout(700);
const railed = await page.evaluate(() => ({
  rail: document.getElementById('shell').classList.contains('rail'),
  named: [...document.querySelectorAll('#navlist button')].every((b) => (b.getAttribute('aria-label') || '').length > 2),
  expanded: document.getElementById('railBtn').getAttribute('aria-expanded'),
}));
check('rail collapse applies', railed.rail);
check('nav keeps accessible names when collapsed', railed.named);
check('rail button reports its state', railed.expanded === 'false', railed.expanded);
const postW = await page.evaluate(() => document.querySelector('.plot svg')?.getBoundingClientRect().width || 0);
check('charts redraw wider when the rail collapses', postW > preW + 20, `${Math.round(preW)} -> ${Math.round(postW)}`);
await page.click('#railBtn');
await page.waitForTimeout(500);

/* 6 — mobile drawer: opens, traps nothing, closes on Escape, restores focus */
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.click('#menuBtn');
await page.waitForTimeout(400);
check('drawer opens', await page.evaluate(() => document.getElementById('side').classList.contains('open')));
check('drawer trigger reports expanded', await page.evaluate(() => document.getElementById('menuBtn').getAttribute('aria-expanded') === 'true'));
check('focus moves into the drawer', (await active()).cls.includes('') && await page.evaluate(() => document.getElementById('side').contains(document.activeElement)));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Escape closes the drawer', await page.evaluate(() => !document.getElementById('side').classList.contains('open')));
check('focus returns to the trigger', await page.evaluate(() => document.activeElement.id === 'menuBtn'), (await active()).id);

/* 7 — reduced motion is honoured */
const motion = await page.evaluate(() => getComputedStyle(document.querySelector('.pg') || document.body).animationDuration);
check('reduced motion shortens animation', parseFloat(motion) < 0.01, motion);

await ctx.close();
await browser.close();

console.log(`PASS (${ok.length}):`);
ok.forEach((s) => console.log('  + ' + s));
console.log(`\nFAIL (${fails.length}):`);
fails.forEach((s) => console.log('  - ' + s));
process.exitCode = fails.length ? 1 : 0;
