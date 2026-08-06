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

/* ------------------------------------------------------------- chart system --
   One configuration object per chart drives the series colour, the legend and
   the tooltip together, so those three can never disagree about what a colour
   means. A series is declared once:

     { ayce: { label: 'AYCE covers', series: 1 },
       alc:  { label: 'À la carte',  series: 4, kind: 'dash' } }

   `series` picks a slot in the theme's --chart-1..5 scale. The container binds
   those slots to --c-1..5, and the plot marks paint with var(--c-N), so no
   colour is ever written into plot geometry.
*/

/** Style attribute binding a config's series slots to the container. */
function seriesVars(config) {
  const seen = new Set();
  const out = [];
  Object.values(config || {}).forEach((c, i) => {
    const slot = c.series ?? (i + 1);
    if (seen.has(slot)) return;
    seen.add(slot);
    out.push(`--c-${out.length + 1}:var(--chart-${slot})`);
  });
  return out.length ? ` style="${out.join(';')}"` : '';
}

/**
 * Legend rendered from a chart config. `kind` selects the swatch:
 * 'dot' (default), 'line', 'dash' — the dashed swatch marks a reference series.
 */
export function chartLegend(config) {
  const items = Object.values(config || {}).filter((c) => c.label && c.legend !== false);
  if (!items.length) return '';
  return `<div class="plegend">${items.map((c, i) => {
    const slot = c.series ?? (i + 1);
    const kind = c.kind === 'line' ? ' ln' : c.kind === 'dash' ? ' dash' : '';
    const colour = c.kind === 'dash' ? '' : ` style="${c.kind === 'line' ? 'border-top-color' : 'background'}:var(--chart-${slot})"`;
    return `<span><i class="${kind.trim()}"${colour}></i>${esc(c.label)}</span>`;
  }).join('')}</div>`;
}

/**
 * Chart panel — the shared container for every plot in the app.
 *
 * The header answers "what is this, what does it currently read, and did it
 * move" before the reader looks at the geometry: title, headline value, delta
 * badge, one supporting sentence, then the legend.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.desc]
 * @param {string} [o.value]   formatted headline figure
 * @param {string} [o.delta]   markup from delta()
 * @param {object} [o.config]  chart config — drives series colours and legend
 * @param {string} [o.legend]  explicit legend markup, overriding the config's
 * @param {string} o.body      plot markup or a plot host element
 * @param {string} [o.foot]
 * @param {string} [o.cls]
 */
export function chartPanel(o) {
  const legend = o.legend ?? (o.config ? chartLegend(o.config) : '');
  const head = `<div class="chead">
    <div class="ch-l"><div class="ch-t">${o.title}</div>${
  o.desc ? `<div class="ch-d">${o.desc}</div>` : ''}</div>${
  (o.value || o.delta) ? `<div class="ch-r">${
    o.value ? `<div class="ch-v">${o.value}</div>` : ''}${o.delta ?? ''}</div>` : ''}
  </div>`;
  return `<section class="panel${o.cls ? ` ${o.cls}` : ''}"${seriesVars(o.config)}>${head}
    <div class="panel-b">${legend ? `<div class="ch-lg">${legend}</div>` : ''}${o.body}</div>
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

/**
 * Segmented control for a short, mutually exclusive choice — faster to read and
 * to hit than a select when there are two to four options and they are all
 * worth showing.
 *
 * Built on real radio inputs rather than buttons with aria-pressed: a native
 * radio group already gives arrow-key navigation, roving focus, a single tab
 * stop and the correct role, and it submits and restores like any other field.
 * The input is clipped rather than display:none so it stays focusable.
 *
 * @param {object} o
 * @param {string} o.name     radio group name (also the element id prefix)
 * @param {string} o.value    currently selected value
 * @param {Array<[string,string,string?]>} o.options  [value, label, hint?]
 * @param {string} o.label    accessible group name
 */
export function segmented(o) {
  const opts = o.options.map(([v, l, hint], i) => `<label class="seg-o${v === o.value ? ' on' : ''}"${
    hint ? ` title="${esc(hint)}"` : ''}>
    <input type="radio" name="${esc(o.name)}" id="${esc(o.name)}-${i}" value="${esc(v)}"${
  v === o.value ? ' checked' : ''}${hint ? ` aria-label="${esc(`${l} — ${hint}`)}"` : ''}><span>${esc(l)}</span></label>`).join('');
  return `<div class="seg-w" role="radiogroup" aria-label="${esc(o.label)}">${opts}</div>`;
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
/* unique gradient ids: two plots on a page must not share one defs entry */
let AREA_ID = 0;

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

/**
 * Axis scale whose ticks land on numbers a person would actually write.
 *
 * Rounding the maximum alone is not enough: a max of 50 divided into four
 * intervals gives 12.5, 25, 37.5 — printed as 13%, 25%, 38%, which reads as
 * noise. This rounds the *step* instead, and tries both four and five intervals,
 * keeping whichever covers the data with the least dead space above it.
 *
 * @returns {{max:number, ticks:number}}
 */
function niceScale(max) {
  if (!(max > 0)) return { max: 1, ticks: 4 };
  const round = (raw) => {
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  };
  let best = null;
  for (const ticks of [4, 5]) {
    const top = round(max / ticks) * ticks;
    if (!best || top - max < best.max - max) best = { max: top, ticks };
  }
  return best;
}

/** Thin x labels so they never collide: how many fit is a function of width. */
function labelStride(n, width) {
  const fits = Math.max(3, Math.floor(width / 62));
  return n <= fits ? 1 : Math.ceil(n / fits);
}

function gridlines(g, max, fmtTick, ticks = 4) {
  const { pad, font, VH } = g;
  const w = VW - pad.l - pad.r;
  const h = VH - pad.t - pad.b;
  let s = '';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + h - (h * i) / ticks;
    const v = (max * i) / ticks;
    s += `<line class="gl${i === 0 ? ' zero' : ''}" x1="${pad.l.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(pad.l + w).toFixed(1)}" y2="${y.toFixed(1)}"/>`
      + `<text class="ax" x="${(pad.l - 7 * g.k).toFixed(1)}" y="${(y + font * 0.35).toFixed(1)}" text-anchor="end" font-size="${font.toFixed(1)}">${esc(fmtTick(v))}</text>`;
  }
  return s;
}

/**
 * X axis labels.
 *
 * `banded` places each label at the centre of its own slice — right for bars,
 * which occupy a band. A line plot puts its first and last point on the plot
 * edges, so its labels have to sit on the points instead; anchoring is nudged
 * at the ends so the outermost label cannot overhang the axis.
 */
function xLabels(g, labels, width, banded = true) {
  const { pad, font, VH } = g;
  const w = VW - pad.l - pad.r;
  const n = labels.length;
  const stride = labelStride(n, width);
  const at = banded
    ? (i) => pad.l + (w / n) * i + w / n / 2
    : (i) => (n === 1 ? pad.l + w / 2 : pad.l + (w * i) / (n - 1));
  return labels.map((l, i) => {
    if (i % stride !== 0 && i !== n - 1) return '';
    const anchor = banded || n === 1 ? 'middle' : (i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'));
    return `<text class="ax" x="${at(i).toFixed(1)}" y="${(VH - pad.b + font * 1.6).toFixed(1)}" text-anchor="${anchor}" font-size="${font.toFixed(1)}">${esc(l)}</text>`;
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

  const { max, ticks } = niceScale(Math.max(...vals, reference ?? 0) * 1.12);
  /* A trend spans the plot: first and last point sit on the edges rather than
     in the middle of a band. Band-centring belongs to bars — on a line it left
     the series floating inside the panel with dead margins either side, and the
     area beneath it read as a free-standing block. */
  const n = points.length;
  const cx = (i) => (n === 1 ? pad.l + w / 2 : pad.l + (w * i) / (n - 1));
  const cy = (v) => pad.t + h - (v / max) * h;
  const band = n === 1 ? w : w / (n - 1);

  /* split into runs of consecutive present values so gaps stay gaps */
  const runs = [];
  let run = [];
  points.forEach((p, i) => {
    if (p.value == null || Number.isNaN(p.value)) { if (run.length) { runs.push(run); run = []; } return; }
    run.push({ x: cx(i), y: cy(p.value), i });
  });
  if (run.length) runs.push(run);

  /* The area under the line fades out rather than filling flat. A flat tint on a
     zero-based axis paints most of the panel as one solid block — it reads as a
     shape in its own right and competes with the line it is supposed to
     support. The gradient keeps the magnitude cue at the line and lets it go. */
  const gid = `ag${(AREA_ID += 1)}`;
  const lines = runs.map((r) => {
    const d = r.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
    const area = r.length > 1
      ? `<path class="ar" fill="url(#${gid})" d="${d} L${r[r.length - 1].x.toFixed(1)} ${(pad.t + h).toFixed(1)} L${r[0].x.toFixed(1)} ${(pad.t + h).toFixed(1)} Z"/>`
      : '';
    return `${area}<path class="ln" d="${d}" stroke-width="${(2 * k).toFixed(2)}"/>`;
  }).join('');
  const defs = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--c-1,var(--chart-1))" stop-opacity=".16"/>
    <stop offset="1" stop-color="var(--c-1,var(--chart-1))" stop-opacity="0"/></linearGradient></defs>`;

  const dots = runs.flat().map((pt) => `<circle class="pt" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${(3.2 * k).toFixed(2)}" stroke-width="${(2 * k).toFixed(2)}"/>`).join('');

  const ref = reference != null && !Number.isNaN(reference)
    ? `<line class="gl base" x1="${pad.l.toFixed(1)}" y1="${cy(reference).toFixed(1)}" x2="${(pad.l + w).toFixed(1)}" y2="${cy(reference).toFixed(1)}" stroke-width="${k.toFixed(2)}"/>
       <text class="ax mid" x="${(pad.l + w).toFixed(1)}" y="${(cy(reference) - 6 * k).toFixed(1)}" text-anchor="end" font-size="${font.toFixed(1)}">${esc(referenceLabel)}</text>`
    : '';

  /* Pointer affordance only. The svg is role="img", so anything inside it is
     already hidden from assistive tech; the accessible equivalent of every
     plot on this page is the by-day table, which carries the same figures. */
  /* one hit zone per point, centred on it and clipped to the plot at the ends */
  const hits = points.map((p, i) => {
    if (!p.tip) return '';
    const x0 = Math.max(pad.l, cx(i) - band / 2);
    const x1 = Math.min(pad.l + w, cx(i) + band / 2);
    return `<rect class="hot" x="${x0.toFixed(1)}" y="${pad.t.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${h.toFixed(1)}"
        aria-hidden="true" data-tip="${esc(JSON.stringify(p.tip))}"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">${defs}
    ${gridlines(g, max, fmtTick, ticks)}${ref}${lines}${dots}${xLabels(g, points.map((p) => p.label), width, false)}${hits}
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

  const { max, ticks } = niceScale(Math.max(...totals) * 1.1);
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
    ${gridlines(g, max, fmtTick, ticks)}${rects}${xLabels(g, bars.map((b) => b.label), width)}${hits}
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
let RO = null;
export function drawPlots(root, specs) {
  LIVE = { root, specs, widths: new Map() };
  paintPlots(LIVE);
  observePlots(LIVE);
}
function paintPlots(live) {
  if (!live || !live.root || !live.root.isConnected) return;
  for (const { id, build } of live.specs) {
    const el = live.root.querySelector(`#${id}`);
    if (el && el.clientWidth) el.innerHTML = build(el.clientWidth);
  }
  bindTips(live.root);
}

/*
   Plots are measured against the element they land in, not the window.

   A window-resize listener misses every container-only change — collapsing the
   sidebar is the obvious one: the viewport never changes, so the charts would
   keep drawing at the old width and their axis labels would sit wrong until the
   next full re-render. A ResizeObserver watches the hosts themselves, which
   covers window resizes too.

   Redraw is skipped when the integer width is unchanged, so the observer's
   initial callback and any sub-pixel churn cost nothing.
*/
function observePlots(live) {
  if (typeof ResizeObserver === 'undefined' || !live || !live.root) return;
  if (RO) RO.disconnect();
  let t = 0;
  RO = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const w = Math.round(e.contentRect.width);
      if (w > 0 && live.widths.get(e.target.id) !== w) { live.widths.set(e.target.id, w); changed = true; }
    }
    if (!changed) return;
    clearTimeout(t);
    t = setTimeout(() => paintPlots(live), 100);
  });
  for (const { id } of live.specs) {
    const el = live.root.querySelector(`#${id}`);
    if (el) { live.widths.set(id, Math.round(el.clientWidth)); RO.observe(el); }
  }
}

/* Explicit repaint hook for layout changes the observer cannot see as a resize
   of a plot host — currently only the shell's rail toggle, which animates. */
if (typeof window !== 'undefined') {
  window.__ACE_RESIZE__ = () => setTimeout(() => paintPlots(LIVE), 260);
  /* ResizeObserver is universal in every browser this ships to, but a window
     listener costs nothing and keeps the old behaviour if it is ever absent. */
  if (typeof ResizeObserver === 'undefined') {
    let t = 0;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => paintPlots(LIVE), 120);
    });
  }
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
    /* A row is [name, value] or [name, value, mark], where mark is a series
       slot (1–5) or 'dash' for the reference line. The swatch ties the number
       to the mark it came from, which is what makes a two-series tooltip
       readable at a glance. */
    const row = ([k, v, mark]) => {
      const sw = mark == null ? ''
        : `<i class="tip-i${mark === 'dash' ? ' dash' : ` s${mark}`}"${
          typeof mark === 'number' ? ` style="background:var(--chart-${mark})"` : ''}></i>`;
      return `<div class="tr">${sw}<span>${esc(k)}</span><b>${esc(v)}</b></div>`;
    };
    tip.innerHTML = `${o.title ? `<div class="tt">${esc(o.title)}</div>` : ''}${
      (o.rows || []).map(row).join('')}${
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
