/* =============================================================================
   ACE design system — shared presentation primitives.

   Presentation only. Nothing here reads DATA, computes a metric or decides a
   business rule: callers pass finished numbers in and get markup back. That
   separation is deliberate — the styling pass must never become a place where
   a calculation quietly changes.

   Contents
     formatting   numbers, currency, percentages, signed changes, missing values
     primitives   panel · KPI band · delta · badge
     states       skeleton · panel empty state
     plots        line (with reference band) · stacked bars
     tooltips     reuses the shell's #tip surface

   Every value formatter renders null/undefined as an em dash. A missing number
   is shown as missing, never as zero.
   ========================================================================== */

/* ---------------------------------------------------------------- escaping -- */
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ENT[c]);

/* -------------------------------------------------------------- formatting -- */
export const nUm = (n) => (n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US'));
export const pctOf = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : `${n.toFixed(d)}%`);
export const money = (n) => (n == null || Number.isNaN(n)
  ? '—'
  : `$${Math.round(n).toLocaleString('en-US')}`);

/** Compact currency for axis ticks only — never for a figure a manager reads
 *  as an exact amount. */
export const moneyK = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return `$${(n / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};

/** Signed percentage-point difference, e.g. +2.4 pts / −1.1 pts. */
export const pts = (n, d = 1) => (n == null || Number.isNaN(n)
  ? '—'
  : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)} pts`);

/**
 * Change indicator. Direction and sentiment are separate arguments on purpose:
 * food cost rising points UP and reads BAD, revenue rising points up and reads
 * good. Colour never carries the direction on its own — the arrow does.
 *
 * @param {number|null} diff   signed difference
 * @param {object}      o
 * @param {'up'|'down'} [o.goodWhen='up']  which direction is a good outcome
 * @param {string}      [o.unit='pts']     'pts' | '%' | '' (raw)
 * @param {string}      [o.suffix]         trailing context, e.g. 'vs usual'
 */
export function delta(diff, o = {}) {
  const { goodWhen = 'up', unit = 'pts', suffix = '' } = o;
  const tail = suffix ? ` <span class="du">${esc(suffix)}</span>` : '';
  if (diff == null || Number.isNaN(diff)) {
    return `<span class="delta flat">—${tail}</span>`;
  }
  const flat = Math.abs(diff) < 0.05;
  const dir = flat ? 'flat' : (diff > 0 ? 'up' : 'down');
  const sentiment = flat ? '' : ((diff > 0) === (goodWhen === 'up') ? ' good' : ' bad');
  const body = unit === 'pts'
    ? pts(diff)
    : `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`;
  return `<span class="delta ${dir}${sentiment}">${flat ? 'No change' : body}${tail}</span>`;
}

/* -------------------------------------------------------------- primitives -- */
/**
 * Analytical panel: header (title · description · action slot), body, footer.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.desc]    supporting sentence under the title
 * @param {string} [o.action]  markup for the header's right slot (legend etc.)
 * @param {string} o.body      markup
 * @param {string} [o.foot]    methodology note
 * @param {string} [o.cls]     extra classes on the panel
 * @param {string} [o.bodyCls] extra classes on the body ('flush' to unpad)
 */
export function panel(o) {
  const head = o.title
    ? `<div class="panel-h"><div><div class="pt">${o.title}</div>${
      o.desc ? `<div class="pd">${o.desc}</div>` : ''}</div>${
      o.action ? `<div class="pa">${o.action}</div>` : ''}</div>`
    : '';
  return `<section class="panel${o.cls ? ` ${o.cls}` : ''}">${head}
    <div class="panel-b${o.bodyCls ? ` ${o.bodyCls}` : ''}">${o.body}</div>
    ${o.foot ? `<div class="panel-f">${o.foot}</div>` : ''}</section>`;
}

/**
 * KPI band. The first cell is the lead metric and spans the band's full height;
 * the rest are supporting figures at a quieter weight.
 * Cell: { k, v, m, delta, tone, spark, lead }
 *   k     label            v  formatted value
 *   m     comparison line  delta  markup from delta()
 *   tone  '' | 'pos' | 'neg' | 'gold' | 'quiet'
 *   spark markup rendered at the bottom of the lead cell
 */
export function kpiBand(cells, label = 'Key figures') {
  const cell = (c) => `<div class="kpi${c.lead ? ' lead' : ''}">
    <div class="kpi-h"><div class="kpi-k">${c.k}</div>${c.delta ?? ''}</div>
    <div class="kpi-v${c.tone ? ` ${c.tone}` : ''}">${c.v}</div>
    ${c.m ? `<div class="kpi-m">${c.m}</div>` : ''}
    ${c.spark ? `<div class="kpi-spark">${c.spark}</div>` : ''}
  </div>`;
  return `<div class="kpis" role="group" aria-label="${esc(label)}">${cells.map(cell).join('')}</div>`;
}

/** Status badge in the shell's existing badge language. */
export function badge(text, tone = 'mute') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

/* ------------------------------------------------------------------ states -- */
/** Loading skeleton shaped like the Overview layout it becomes. */
export function skeletonOverview() {
  const kpi = `<div><div class="sk" style="width:64%"></div>
    <div class="sk v"></div><div class="sk" style="width:82%"></div></div>`;
  return `<div class="stack" role="status" aria-label="Loading the operations overview">
    <div class="sk sk-fbar"></div>
    <div class="sk-kpis">${kpi.repeat(5)}</div>
    <div class="sk sk-panel"></div>
  </div>`;
}

/** Empty state that occupies a plot's height so a row never collapses. */
export function plotEmpty(title, sub) {
  return `<div class="pempty"><div class="pe-t">${esc(title)}</div>
    <div class="pe-s">${esc(sub)}</div></div>`;
}

/* ------------------------------------------------------------------- plots -- */
/*
   Plots are drawn against the width they actually land in.

   A fixed viewBox would scale its own text with the container, so the same
   chart that reads well on a 1440px desktop renders ~5px axis labels on a
   390px phone. Instead every dimension below is authored in CSS pixels and
   multiplied by k = VW / measuredWidth, which keeps type and padding at a
   constant on-screen size at any width. Callers hand the plot a width via
   drawPlots(), after the panel is in the DOM and can be measured.
*/
const VW = 1000;

/** Geometry for a given rendered width, in user units that land on real px. */
function geom(width, heightPx) {
  const k = VW / Math.max(260, width);
  return {
    k,
    VH: Math.round(heightPx * k),
    font: 11 * k,
    pad: { t: 14 * k, r: 14 * k, b: 30 * k, l: 46 * k },
  };
}

/** Plot height in CSS pixels, chosen by how much width there is to spend. */
function heightFor(width, tall) {
  if (width < 420) return tall ? 190 : 170;
  if (width < 760) return tall ? 230 : 200;
  return tall ? 280 : 250;
}

/** "Nice" axis maximum so ticks land on readable numbers. */
function niceMax(max) {
  if (!(max > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  const norm = max / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Thin x labels so they never collide: how many fit is a function of width. */
function labelStride(n, width) {
  const fits = Math.max(3, Math.floor(width / 62));
  return n <= fits ? 1 : Math.ceil(n / fits);
}

function gridlines(g, max, fmtTick) {
  const { pad, font, VH } = g;
  const w = VW - pad.l - pad.r;
  const h = VH - pad.t - pad.b;
  const ticks = 4;
  let s = '';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + h - (h * i) / ticks;
    const v = (max * i) / ticks;
    s += `<line class="gl${i === 0 ? ' zero' : ''}" x1="${pad.l.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(pad.l + w).toFixed(1)}" y2="${y.toFixed(1)}"/>`
      + `<text class="ax" x="${(pad.l - 7 * g.k).toFixed(1)}" y="${(y + font * 0.35).toFixed(1)}" text-anchor="end" font-size="${font.toFixed(1)}">${esc(fmtTick(v))}</text>`;
  }
  return s;
}

function xLabels(g, labels, width) {
  const { pad, font, VH } = g;
  const w = VW - pad.l - pad.r;
  const stride = labelStride(labels.length, width);
  const step = w / labels.length;
  return labels.map((l, i) => {
    if (i % stride !== 0 && i !== labels.length - 1) return '';
    const x = pad.l + step * i + step / 2;
    return `<text class="ax" x="${x.toFixed(1)}" y="${(VH - pad.b + font * 1.6).toFixed(1)}" text-anchor="middle" font-size="${font.toFixed(1)}">${esc(l)}</text>`;
  }).join('');
}

/**
 * Line plot with an optional dashed reference line (the "usual" baseline).
 * Null values break the line rather than being drawn as zero — a day with no
 * AYCE sales has no food-cost percentage, and pretending otherwise would be a
 * fabricated data point.
 *
 * @param {object} o
 * @param {Array<{label,value,tip}>} o.points
 * @param {number|null} [o.reference]      value for the dashed reference line
 * @param {string}      [o.referenceLabel]
 * @param {function}    [o.fmtTick]        axis tick formatter
 * @param {string}      o.aria
 */
export function linePlot(o, width = 900) {
  const { points, reference = null, referenceLabel = '', fmtTick = (v) => `${v.toFixed(0)}%`, aria } = o;
  const vals = points.map((p) => p.value).filter((v) => v != null && !Number.isNaN(v));
  if (!vals.length) return plotEmpty('No data in this range', 'Nothing was recorded for the selected dates.');

  const g = geom(width, heightFor(width, true));
  const { pad, font, VH, k } = g;
  const w = VW - pad.l - pad.r;
  const h = VH - pad.t - pad.b;

  const max = niceMax(Math.max(...vals, reference ?? 0) * 1.12);
  const step = w / points.length;
  const cx = (i) => pad.l + step * i + step / 2;
  const cy = (v) => pad.t + h - (v / max) * h;

  /* split into runs of consecutive present values so gaps stay gaps */
  const runs = [];
  let run = [];
  points.forEach((p, i) => {
    if (p.value == null || Number.isNaN(p.value)) { if (run.length) { runs.push(run); run = []; } return; }
    run.push({ x: cx(i), y: cy(p.value), i });
  });
  if (run.length) runs.push(run);

  const lines = runs.map((r) => {
    const d = r.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
    const area = r.length > 1
      ? `<path class="ar" d="${d} L${r[r.length - 1].x.toFixed(1)} ${(pad.t + h).toFixed(1)} L${r[0].x.toFixed(1)} ${(pad.t + h).toFixed(1)} Z"/>`
      : '';
    return `${area}<path class="ln" d="${d}" stroke-width="${(2 * k).toFixed(2)}"/>`;
  }).join('');

  const dots = runs.flat().map((pt) => `<circle class="pt" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${(3.2 * k).toFixed(2)}" stroke-width="${(2 * k).toFixed(2)}"/>`).join('');

  const ref = reference != null && !Number.isNaN(reference)
    ? `<line class="gl base" x1="${pad.l.toFixed(1)}" y1="${cy(reference).toFixed(1)}" x2="${(pad.l + w).toFixed(1)}" y2="${cy(reference).toFixed(1)}" stroke-width="${k.toFixed(2)}"/>
       <text class="ax mid" x="${(pad.l + w).toFixed(1)}" y="${(cy(reference) - 6 * k).toFixed(1)}" text-anchor="end" font-size="${font.toFixed(1)}">${esc(referenceLabel)}</text>`
    : '';

  /* Pointer affordance only. The svg is role="img", so anything inside it is
     already hidden from assistive tech; the accessible equivalent of every
     plot on this page is the by-day table, which carries the same figures. */
  const hits = points.map((p, i) => (p.tip
    ? `<rect class="hot" x="${(pad.l + step * i).toFixed(1)}" y="${pad.t.toFixed(1)}" width="${step.toFixed(1)}" height="${h.toFixed(1)}"
        aria-hidden="true" data-tip="${esc(JSON.stringify(p.tip))}"/>`
    : '')).join('');

  return `<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">
    ${gridlines(g, max, fmtTick)}${ref}${lines}${dots}${xLabels(g, points.map((p) => p.label), width)}${hits}
  </svg>`;
}

/**
 * Stacked bar plot — two series only. More than two categories in a stack stops
 * being comparable, which is why this takes exactly a base and a top.
 *
 * @param {object} o
 * @param {Array<{label,base,top,tip}>} o.bars
 * @param {function} [o.fmtTick]
 * @param {string}   o.aria
 */
export function stackedBars(o, width = 900) {
  const { bars, fmtTick = moneyK, aria } = o;
  const totals = bars.map((b) => (b.base ?? 0) + (b.top ?? 0));
  if (!totals.some((t) => t > 0)) return plotEmpty('No sales in this range', 'Nothing was recorded for the selected dates.');

  const g = geom(width, heightFor(width, false));
  const { pad, VH, k } = g;
  const w = VW - pad.l - pad.r;
  const ph = VH - pad.t - pad.b;

  const max = niceMax(Math.max(...totals) * 1.1);
  const step = w / bars.length;
  const bw = Math.min(44 * k, step * 0.62);
  const h = (v) => ((v ?? 0) / max) * ph;

  const rects = bars.map((b, i) => {
    const x = pad.l + step * i + (step - bw) / 2;
    const hb = h(b.base);
    const ht = h(b.top);
    const yb = pad.t + ph - hb;
    const yt = yb - ht;
    return `${hb > 0 ? `<rect class="br" x="${x.toFixed(1)}" y="${yb.toFixed(1)}" width="${bw.toFixed(1)}" height="${hb.toFixed(1)}"/>` : ''}
      ${ht > 0 ? `<rect class="br q" x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${bw.toFixed(1)}" height="${ht.toFixed(1)}"/>` : ''}`;
  }).join('');

  const hits = bars.map((b, i) => (b.tip
    ? `<rect class="hot" x="${(pad.l + step * i).toFixed(1)}" y="${pad.t.toFixed(1)}" width="${step.toFixed(1)}" height="${ph.toFixed(1)}"
        aria-hidden="true" data-tip="${esc(JSON.stringify(b.tip))}"/>`
    : '')).join('');

  return `<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">
    ${gridlines(g, max, fmtTick)}${rects}${xLabels(g, bars.map((b) => b.label), width)}${hits}
  </svg>`;
}

/**
 * Draws deferred plots at the width they actually occupy, and keeps them right
 * when the window changes size.
 *
 * `specs` is [{ id, build(width) -> svg markup }]. Only one page renders at a
 * time, so the module keeps a single live spec set and one resize listener
 * rather than accumulating one per render.
 */
let LIVE = null;
export function drawPlots(root, specs) {
  LIVE = { root, specs };
  paintPlots(LIVE);
}
function paintPlots(live) {
  if (!live || !live.root || !live.root.isConnected) return;
  for (const { id, build } of live.specs) {
    const el = live.root.querySelector(`#${id}`);
    if (el && el.clientWidth) el.innerHTML = build(el.clientWidth);
  }
  bindTips(live.root);
}
/* Debounced on a timer rather than requestAnimationFrame: rAF is suspended
   while the tab is hidden, so a window resized in the background would leave
   the plots at their old geometry until the next full re-render. */
if (typeof window !== 'undefined') {
  let t = 0;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => paintPlots(LIVE), 120);
  });
}

/** Compact sparkline for the lead KPI — history, not decoration. */
export function sparkline(values, aria) {
  const present = values.filter((v) => v != null && !Number.isNaN(v));
  if (present.length < 2) return '';
  const W = 260; const H = 34;
  const min = Math.min(...present); const max = Math.max(...present);
  const span = max - min || 1;
  const step = W / (values.length - 1);
  let d = ''; let started = false;
  values.forEach((v, i) => {
    if (v == null || Number.isNaN(v)) { started = false; return; }
    const x = step * i;
    const y = H - 3 - ((v - min) / span) * (H - 6);
    d += `${started ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    started = true;
  });
  return `<div class="plot spark"><svg viewBox="0 0 ${W} ${H}" role="img"
    aria-label="${esc(aria)}" preserveAspectRatio="none"><path class="ln" d="${d.trim()}" stroke-width="1.6"/></svg></div>`;
}

/* ---------------------------------------------------------------- tooltips -- */
/**
 * Binds hover tooltips to every [data-tip] inside root, reusing the shell's
 * #tip surface so charts speak the same visual language as the rest of the app.
 * Pointer-only by design: the targets sit inside a role="img" svg and are
 * hidden from assistive tech, which reads the plot's summary label and the
 * by-day table instead.
 */
export function bindTips(root) {
  const tip = document.getElementById('tip');
  if (!tip) return;
  const show = (el, x, y) => {
    let o;
    try { o = JSON.parse(el.dataset.tip); } catch { return; }
    tip.innerHTML = `${o.title ? `<div class="tt">${esc(o.title)}</div>` : ''}${
      (o.rows || []).map(([k, v]) => `<div class="tr"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}${
      o.note ? `<div class="td">${esc(o.note)}</div>` : ''}`;
    tip.style.display = 'block';
    requestAnimationFrame(() => tip.classList.add('show'));
    const w = tip.offsetWidth || 220; const h = tip.offsetHeight || 60;
    let nx = x + 15; let ny = y + 16;
    if (nx + w > innerWidth - 10) nx = x - w - 12;
    if (ny + h > innerHeight - 10) ny = y - h - 12;
    tip.style.left = `${Math.max(8, nx)}px`;
    tip.style.top = `${Math.max(8, ny)}px`;
  };
  const hide = () => { tip.classList.remove('show'); tip.style.display = 'none'; };

  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mouseenter', (e) => show(el, e.clientX, e.clientY));
    el.addEventListener('mousemove', (e) => show(el, e.clientX, e.clientY));
    el.addEventListener('mouseleave', hide);
  });
}
