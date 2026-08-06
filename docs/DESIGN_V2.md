# ACE Dashboard — Version 2 design system

Record of the visual rebuild: what was taken from two 21st.dev components, what was
rejected, and the token contract every route now shares.

## 21st.dev retrievals

Quota before: 2 of 2 free retrievals available. Quota after: 0. Exactly the two
authorised components were retrieved; no substitutes, no themes, no experiments.

### 1 — Dashboard Sidebar (id 14941, arunjdass)

React + Tailwind + lucide-react. Retrieved for its shell architecture.

**Adapted**

| Idea | How it landed in ACE |
| --- | --- |
| Sidebar as a *quiet surface* — `bg-card/50` + hairline right border, not a heavy slab | `--sidebar` sits in the same neutral family as the canvas with a single `--border` hairline. The old navy slab is gone; this alone re-reads the whole product. |
| 260px width, 12px internal padding | `--side-w:264px`, nav padding `12px 10px` |
| Identity block: monogram tile + name + sub-label | `.brand` renders a brand-filled rounded tile with an "A" monogram, the product name, and **real** location context (Chasin' Tails · Founders Row) |
| Nav item anatomy: `px-2.5 py-[7px]`, 16px icon at 1.5 stroke, 13px label, right-hand slot for badge | `.nav-item` — 16px inline SVG, `--fs-sm` label, right slot carries the Fixes count |
| Active = subtle background + contrast shift (not a loud fill) | `[aria-current=page]` gets `--sidebar-active` fill, `--text` label, brand-tinted icon, and a 3px brand rail |
| Group headings — 11px, semibold, wide tracking, muted | `.nav-group` at `--fs-micro` |
| Spacing discipline: tight inside a group (2px), generous between groups (24px) | `--sp-1` within, `--sp-5` between — the direct fix for uniform vertical rhythm |
| Tinted count badge (`bg-primary/10 text-primary`) rather than a solid accent chip | `.nav-badge` uses `--brand-soft` / `--brand-text` |
| Separated footer zone (`mt-auto pt-4 border-t`) | `.side-foot` holds appearance, account and the extract stamp |
| 56px header with `context / current page` breadcrumb | `#topbar` breadcrumb renders `group / page` |
| Collapse toggle driving a width transition | Desktop collapse to a 76px rail with `title`+`aria-label` tooltips; state persisted |

**Rejected**

React (`useState`, JSX, props, component tree) · lucide-react · every Tailwind class and
the `dark:` variant strategy · shadcn token names (`bg-card`, `text-muted-foreground`) ·
`animate-in fade-in zoom-in-95` · the **workspace switcher dropdown** (ACE has one
location — alternates would be fabricated) · the **⌘K command palette** (no search backend
exists; it would be a dead control) · nested accordion nav (7 flat routes need no tree) ·
`[&::-webkit-scrollbar]:hidden` (hiding scrollbars costs usability) · "Log out" as a nav row
(ACE already has a wired account affordance) · all mock data ("Acme Corp", "Pro Plan").

### 2 — Chart (id 19604, cnippet.dev)

React + Recharts + Tailwind. Retrieved for its chart-presentation architecture.

**Adapted**

| Idea | How it landed in ACE |
| --- | --- |
| **`ChartConfig`** — one object keyed by series that drives colour, legend label and tooltip label together | `chartPanel({ config })` in `src/ui.mjs`. A series is declared once; legend, tooltip and SVG fill all read the same entry. This is the fix for inconsistent series colouring. |
| `--color-${key}` CSS variables scoped to the chart container, resolved from theme-level `--chart-N` | The container carries `style="--c-<key>:var(--chart-N)"`; plot marks use `fill:var(--c-<key>)`. Series assignment without hardcoding colour in the plot function. |
| Tooltip anatomy: label row, then `[swatch] [name ......... value]` | `#tip` rebuilt to that structure — name in `--text-3`, value in `--text` at 600 weight with tabular numerals |
| Indicator variants `dot` / `line` / `dashed` | `.tip-i`, `.tip-i.line`, `.tip-i.dash` — a dashed swatch marks the reference series |
| Legend from config: 8px rounded swatch + label, `gap-4` | `chartLegend(config)` — callers stop hand-writing legend markup |
| Axis ticks in muted foreground, gridlines at half border strength | `.plot .ax{fill:var(--text-3)}`, `.plot .gl{stroke:var(--grid)}` |
| **ResizeObserver on the container**, render only once width > 0 | Replaces the debounced `window.resize` listener. A genuine fix: window resize never fires when the *sidebar collapses*, so charts would have kept stale geometry. Same `build(width)` contract, so no rendering logic changed. |

**Rejected**

Recharts entirely (ACE keeps its hand-authored SVG engine) · React context (`createContext`,
`useChart`, `useMemo`, `useId`) — config is passed as a plain argument instead ·
`dangerouslySetInnerHTML` style injection · `cn()` / clsx / tailwind-merge · every
`[&_.recharts-*]` arbitrary variant · the `THEMES = {dark:'.dark'}` selector-prefix strategy
(ACE redefines `--chart-N` inside `[data-theme=dark]`, so no per-chart `<style>` is needed) ·
TypeScript types · `getPayloadConfigFromPayload` (exists only to unwrap Recharts' payload
shape) · the radial/pie demo — bars stay, per the comparison-legibility rule.

**No dependency was added.** `package.json` is untouched.

## Token contract

Canvas is cool slate, not warm beige. Brand is azure — deliberately far in hue from both
the positive green and the negative red, which was the single worst defect of v1 (a coral
brand accent that read as an error).

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#eef1f5` | `#0a0d12` |
| Surface / 2 / 3 | `#ffffff` / `#f7f9fb` / `#eef1f5` | `#121720` / `#171d27` / `#1e2530` |
| Sidebar | `#ffffff` | `#0d1117` |
| Border / strong / stronger | `#e3e8ef` / `#cfd7e2` / `#aab6c6` | `#232b36` / `#313b48` / `#45525f` |
| Text / 2 / 3 / 4 | `#101828` / `#475467` / `#667085` / `#98a2b3` | `#e9edf3` / `#b0bac7` / `#8b96a5` / `#6a7484` |
| Brand | `#1d5fd0` | `#5b9bf5` |
| Positive | `#0b7a4b` | `#3ecf8e` |
| Warning | `#9a6206` | `#e0aa4f` |
| Negative | `#c02718` | `#f2836f` |
| Informational | `#0a6f8f` | `#5fb6d4` |

Chart series, in assignment order: azure `--chart-1`, teal `--chart-2`, amber `--chart-3`,
slate `--chart-4`, violet `--chart-5`. None is red or green, so those two hues stay purely
semantic in charts as well as in text.

**Type scale** — nine levels with real gaps, replacing seven near-identical ones:
11 · 12 · 13 · 14 · 16 · 19 · 30 (page title) · 32 (KPI) · 46 (lead KPI).

**Spacing** — `4 · 8 · 12 · 16 · 24 · 32 · 40 · 56`. Panel padding moved 16 → 24px;
section separation 20 → 32px.

**Radii** — `3 · 5 · 6 · 8`, down from `4 · 6 · 9 · 12`.

**Elevation** — panels carry a hairline and *no* shadow. Shadow is reserved for things that
genuinely float: drawer, modal, popover, tooltip, toast.

## Icon system

`src/icons.mjs` — a local inline-SVG set on a 24×24 grid, 1.5 stroke, round caps and joins,
rendered at 16px. No icon dependency was added. Every Unicode geometric glyph
(◈ ◑ ◐ ⬆ ▣ ◆ ◇ ☰ ✓ ▲ ▼) is gone from navigation and controls.

## Verification

Automated, over 7 routes × 5 viewports (1440 / 1280 / 1024 / 768 / 390) × 2 themes:

| Check | Tool | Result |
| --- | --- | --- |
| Business logic | `npm test` | 254 pass, unchanged from baseline |
| Horizontal overflow | `scripts/audit-ui.mjs` | none |
| Contrast (WCAG AA) | `scripts/audit-ui.mjs` | no failures |
| Accessible names on controls | `scripts/audit-ui.mjs` | none missing |
| 44px touch targets at 390px | `scripts/audit-ui.mjs` | no failures |
| Console errors | `scripts/audit-ui.mjs` | none beyond the known pre-existing set |
| Keyboard + focus + drawer | `scripts/audit-keys.mjs` | 22 of 22 pass |

Known pre-existing issues, unchanged by this work and reported separately from it:
the `node:crypto` CORS console noise, the six anonymous Supabase 401s on
`ace_checks` / `ace_selections` (RLS working as designed, static per-date JSON is
the fallback), and the missing untracked per-date backup files for some
drill-downs.

## Self-audit

| Dimension | Score |
| --- | --- |
| First impression | 9 |
| Executive quality | 9 |
| Information hierarchy | 9 |
| Typography | 9 |
| Navigation | 9 |
| KPI presentation | 9 |
| Charts | 8.5 |
| Tables | 9 |
| Filters | 8.5 |
| Colour system | 9 |
| Spacing | 9 |
| Consistency | 8.5 |
| Responsiveness | 9 |
| Accessibility | 9 |
| Overall polish | 8.8 |

**Weakest points, stated plainly:**

1. **Pilot Review still runs the legacy inline chart engine.** Its funnel, compare
   bars and cover-mix line were restyled onto the v2 tokens and series scale, but
   they were not re-architected onto `chartPanel`, so they have no headline value
   or delta badge in their headers and their tooltips use the older markup. This
   is the one place the app is visibly two generations of chart code.
2. **Server Performance has no KPI band.** A manager lands on the filter bar and
   then straight into a 17-row table. Every other operational route leads with a
   figure. Adding one was left out deliberately rather than inventing an
   aggregate — the right fix is to surface the totals the page already computes.
3. **The type stack is the system stack.** Correct for a bundler-free GitHub Pages
   deployment with no font fetch, but it caps how refined the display sizes get.
