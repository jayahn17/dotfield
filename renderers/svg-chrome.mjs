// renderers/svg-chrome.mjs — what renderers/svg.mjs draws around the nodes
// and edges. Nothing here is measured by the layout gate and nothing here
// re-simulates: every mark is derived from the committed tables.
//   title block  eyebrow "kind · theme · maturity" over the title, measured
//                in the theme's display font (fontStackFor(.., 'display', theme))
//   time ruler   with views.time: a band of RULER_H px below the frame (the
//                SVG viewBox grows by it, the scene's never does): ticks at
//                the lib/time ticks(scene) stops, from/to labels, a playhead
//                mark and label at the still's t
//   lifelines    sequence mode: each participant from (x, y + r) down to the
//                largest y of any message route + LIFELINE_TAIL_PX (every
//                route when there is no message edge); nothing from
//                lib/layout/sequence.mjs is called
//   span bars    timeline mode: happened_on..released_on, the end date placed
//                by interpolating the committed x of the dated nodes
//   legend rail  at most LEGEND_MAX_ROWS rows: groups and kinds (the glyph
//                the kind's first node draws, so shape: pill shows), then the
//                states present (proposal, foreign, ghost, fresh, labels
//                beyond the budget); when they do not fit, "+n more" stands
//                for the groups and kinds left out, never for a state
//
//   renderUnderlay(input, P, style, {scene, g})      -> lifelines + span bars (drawn under the edges)
//   renderChrome(input, style, {scene, time, ruler, legendRows, theme, parsed}) -> title + ruler + legend
//   rulerOf(scene, time, t)                          -> {axis, step, stops, from, to, playhead, at, num} | null
//   legendRows(input, {visible, ownerId})            -> [{kind, label, ...}] (input.measured is the label budget)
import { groupToken } from '../lib/layout/index.mjs';
import { edgePolyline } from '../lib/layout/geometry.mjs';
import { fontStackFor, labelWidth, parsedTokens } from '../lib/layout/metrics.mjs';
import { dateOf } from '../lib/layout/timeline.mjs';
import { dayIndex, fromDayIndex } from '../lib/time/ticks.mjs';
import { ticks } from '../lib/time/playhead.mjs';
import { SMALL, attrs, fmt, glyphOf, glyphPath, isForeign, isObject, text, tok } from './svg.mjs';

export const RULER_H = 48;
export const LEGEND_MAX_ROWS = 8;
export const LIFELINE_TAIL_PX = 40;
export const TITLE_SIZE = 16;
export const EYEBROW_SIZE = 9;
const LEGEND_ROW = 16;
const LEGEND_PAD = 8;
const SPAN_H = 6;
const TRACK_Y = 24;
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const line = (cls, a, b, extra) => `<path${attrs({ class: cls, d: `M${fmt(a[0])} ${fmt(a[1])}L${fmt(b[0])} ${fmt(b[1])}`, fill: 'none', ...extra })}/>`;

/** Sequence lifelines: participant (x, y + r) down to the deepest message route + LIFELINE_TAIL_PX. */
export function lifelines(input, P, { scene, g }) {
  if (input.mode2d !== 'sequence') return '';
  const placed = input.edges.filter(([a, b]) => P[a] && P[b]);
  const messages = placed.filter(([, , e]) => e.kind === 'message');
  let deepest = -Infinity;
  for (const [a, b, e] of messages.length ? messages : placed) for (const q of edgePolyline(scene, e, P[a], P[b])) if (q[1] > deepest) deepest = q[1];
  if (!Number.isFinite(deepest)) return '';
  const end = deepest + LIFELINE_TAIL_PX;
  return input.nodes.map((n, i) => {
    if (!P[i] || end <= P[i][1] + g.hy[i]) return '';
    return line('df-lifeline', [P[i][0], P[i][1] + g.hy[i]], [P[i][0], end], { 'data-lifeline-of': n.id, stroke: tok('line-strong'), 'stroke-width': 1, 'stroke-dasharray': '4 4' });
  }).join('');
}

/** Timeline span bars: a node's happened_on..released_on, the end placed on the committed x of the dated nodes. */
export function spanBars(input, P) {
  if (input.mode2d !== 'timeline') return '';
  const byDay = new Map();
  input.nodes.forEach((n, i) => {
    const d = dayIndex(dateOf(n));
    if (d === null || !P[i]) return;
    const x = P[i][0]; const span = byDay.get(d);
    if (!span) byDay.set(d, [x, x]); else { if (x < span[0]) span[0] = x; if (x > span[1]) span[1] = x; }
  });
  const anchors = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  if (anchors.length < 2) return '';
  const { frame } = input;
  const xOf = (d) => {
    for (let k = 0; k < anchors.length; k += 1) {
      const [day, [lo, hi]] = anchors[k];
      if (d === day) return hi;
      if (d < day) {
        if (k === 0) return lo;
        const [pd, [, ph]] = anchors[k - 1];
        return ph + ((lo - ph) * (d - pd)) / (day - pd);
      }
    }
    const [pd, [, ph]] = anchors[anchors.length - 2]; const [ld, [llo, lhi]] = anchors[anchors.length - 1];
    return lhi + ((llo - ph) / (ld - pd)) * (d - ld);
  };
  return input.nodes.map((n, i) => {
    const prov = isObject(n.provenance) ? n.provenance : {};
    const a = dayIndex(prov.happened_on); const b = dayIndex(prov.released_on);
    if (!P[i] || a === null || b === null || b <= a) return '';
    const x2 = clamp(xOf(b), frame.x0 + frame.padding / 2, frame.x0 + frame.w - frame.padding / 2);
    const x = Math.min(P[i][0], x2); const w = Math.abs(x2 - P[i][0]);
    if (w < 1) return '';
    return `<rect${attrs({ class: 'df-span', 'data-span-of': n.id, 'data-from': prov.happened_on, 'data-to': prov.released_on, x: fmt(x), y: fmt(P[i][1] - SPAN_H / 2), width: fmt(w), height: SPAN_H, rx: SPAN_H / 2, fill: tok(n.color_token || 'muted'), 'fill-opacity': 0.3 })}/>`;
  }).join('');
}

/** What is drawn under the edges: sequence lifelines and timeline span bars. */
export function renderUnderlay(input, P, style, { scene, g }) {
  return lifelines(input, P, { scene, g }) + spanBars(input, P);
}

/** The ruler's model: the scrub stops of the time block and the t the still shows; null without views.time or without stops. */
export function rulerOf(scene, time, t = null) {
  if (!isObject(time)) return null;
  const stops = ticks(scene);
  if (!stops.length) return null;
  const num = (v) => (time.axis === 'date' ? (typeof v === 'string' ? dayIndex(v) : (Number.isInteger(v) ? v : null)) : (Number.isInteger(v) && v >= 0 ? v : null));
  const playhead = t === null || t === undefined ? time.playhead : t;
  return { axis: time.axis, step: time.step, stops, from: stops[0], to: stops[stops.length - 1], playhead, at: num(playhead), num };
}

function rulerSvg(input, style, r) {
  const { frame } = input;
  const xL = frame.x0 + frame.padding; const xR = frame.x0 + frame.w - frame.padding; const y = frame.y0 + frame.h + TRACK_Y;
  const a = r.num(r.from); const b = r.num(r.to);
  const xOf = (v) => (b > a ? xL + ((v - a) / (b - a)) * (xR - xL) : (xL + xR) / 2);
  const show = (v) => (r.axis === 'date' ? (typeof v === 'string' ? v : fromDayIndex(v)) : `beat ${v}`);
  const ink = { stroke: tok('line-strong'), 'stroke-width': 1 };
  let body = line('df-track', [xL, y], [xR, y], ink);
  for (const st of r.stops) { const x = xOf(r.num(st)); body += line('df-tick', [x, y - 4], [x, y + 4], { 'data-t': st, ...ink }); }
  body += text('df-ruler-from', xL, y + 18, show(r.from), style, SMALL) + text('df-ruler-to', xR, y + 18, show(r.to), style, SMALL, { 'text-anchor': 'end' });
  if (r.at !== null) {
    const x = clamp(xOf(r.at), xL, xR); const label = show(r.at); const w = labelWidth(label, { ...style, size: SMALL });
    body += line('df-playhead', [x, y - 7], [x, y + 7], { stroke: tok('active'), 'stroke-width': 2, 'stroke-linecap': 'round' })
      + `<circle${attrs({ cx: fmt(x), cy: fmt(y), r: 3.5, fill: tok('active') })}/>`
      + text('df-ruler-playhead', clamp(x, xL + w / 2, xR - w / 2), y - 11, label, style, SMALL, { 'text-anchor': 'middle' }, w);
  }
  return `<g${attrs({ class: 'df-ruler', 'data-axis': r.axis, 'data-step': r.step, 'data-from': r.from, 'data-to': r.to, 'data-playhead': r.playhead, 'aria-hidden': 'true' })}>${body}</g>`;
}

/** The legend rows, capped at LEGEND_MAX_ROWS: groups and kinds, then the states that occur (never cut). */
export function legendRows(input, { visible = null, ownerId = 'self' } = {}) {
  const structural = [];
  for (const g of input.groups) structural.push({ kind: 'group', token: groupToken(g), label: String(g.label ?? g.id) });
  const firstOfKind = new Map();
  for (const n of input.nodes) if (!firstOfKind.has(n.kind)) firstOfKind.set(n.kind, n);
  for (const [k, n] of firstOfKind) structural.push({ kind: 'kind', glyph: glyphOf(n, input.shapes), label: String(k) });
  const states = [];
  if (input.nodes.some((n) => n.status === 'proposal')) states.push({ kind: 'proposal', label: 'proposal (awaiting approval)' });
  if (input.nodes.some((n) => isForeign(n, ownerId))) states.push({ kind: 'foreign', label: 'shared in from another center' });
  if (visible && (input.nodes.some((n) => !visible.present.has(n.id)) || [...visible.edgePhase.values()].some((p) => p === 0))) states.push({ kind: 'ghost', label: 'not yet at the playhead' });
  if (visible && visible.fresh.size) states.push({ kind: 'fresh', label: 'new at this step' });
  const measured = input.measured instanceof Set ? input.measured : null;
  if (measured && input.nodes.some((n, i) => typeof n.label === 'string' && n.label && !measured.has(i))) states.push({ kind: 'budget', label: 'labels beyond budget shown on hover' });
  if (structural.length + states.length <= LEGEND_MAX_ROWS) return [...structural, ...states];
  const keep = Math.max(0, LEGEND_MAX_ROWS - 1 - states.length);
  return [...structural.slice(0, keep), { kind: 'more', label: `+${structural.length - keep} more` }, ...states];
}

function swatch(row, cx, cy) {
  const at = { cx: fmt(cx), cy: fmt(cy), r: 5 };
  switch (row.kind) {
    case 'group': return `<rect${attrs({ x: fmt(cx - 5), y: fmt(cy - 5), width: 10, height: 10, rx: 2, fill: tok(row.token), 'fill-opacity': 0.35, stroke: tok(row.token) })}/>`;
    case 'kind': return `<path${attrs({ d: glyphPath(row.glyph, 5.5), 'fill-rule': row.glyph === 'ring' ? 'evenodd' : null, fill: tok('muted'), transform: `translate(${fmt(cx)} ${fmt(cy)})` })}/>`;
    case 'proposal': return `<circle${attrs({ ...at, fill: tok('accent'), 'fill-opacity': 0.3, stroke: tok('accent'), 'stroke-dasharray': tok('proposal-dash') })}/>`;
    case 'foreign': return `<circle${attrs({ ...at, fill: 'none', stroke: tok('foreign'), 'stroke-width': 2 })}/>`;
    case 'ghost': return `<circle${attrs({ ...at, class: 'df-unborn', fill: tok('muted') })}/>`;
    case 'fresh': return `<circle${attrs({ ...at, fill: tok('muted'), stroke: tok('fresh'), 'stroke-width': 2.5 })}/>`;
    case 'budget': return `<rect${attrs({ x: fmt(cx - 6), y: fmt(cy - 3.5), width: 12, height: 7, rx: 1, fill: 'none', stroke: tok('faint'), 'stroke-dasharray': '2 2' })}/>`;
    default: return '';
  }
}

function legend(input, style, rows) {
  if (!rows.length) return '';
  const width = 18 + Math.max(...rows.map((r) => labelWidth(r.label, { ...style, size: SMALL }))) + 2 * LEGEND_PAD;
  const height = rows.length * LEGEND_ROW + 2 * LEGEND_PAD - 4;
  const { frame } = input; const x0 = frame.x0 + frame.padding; const y0 = frame.y0 + frame.h - frame.padding - height;
  let body = `<rect${attrs({ x: fmt(x0), y: fmt(y0), width: fmt(width), height: fmt(height), rx: 6, fill: tok('panel'), 'fill-opacity': 0.9, stroke: tok('line') })}/>`;
  rows.forEach((r, i) => {
    const cx = x0 + LEGEND_PAD + 6; const cy = y0 + LEGEND_PAD + i * LEGEND_ROW + 6;
    body += swatch(r, cx, cy) + text(r.kind === 'more' ? 'df-legend-item df-legend-more' : 'df-legend-item', cx + 12, cy + 4, r.label, style, SMALL);
  });
  return `<g class="df-legend" aria-hidden="true">${body}</g>`;
}

function titleBlock(input, style, { scene, theme, parsed }) {
  const { frame } = input; const s = isObject(scene) ? scene : {};
  const meta = isObject(s.meta) ? s.meta : {};
  const x = frame.x0 + frame.padding; const y = frame.y0 + frame.padding;
  const eyebrow = [s.kind, theme, meta.maturity].filter((v) => typeof v === 'string' && v).join(' · ').toUpperCase();
  const display = { ...style, stack: fontStackFor(parsed ?? parsedTokens(undefined), 'display', theme) };
  return (eyebrow ? text('df-eyebrow', x, y - 20, eyebrow, style, EYEBROW_SIZE) : '') + text('df-title', x, y, String(meta.title ?? meta.id ?? 'scene'), display, TITLE_SIZE);
}

/** The chrome layer: title block, time ruler (below the frame) and legend rail. */
export function renderChrome(input, style, { scene, time = null, ruler, legendRows: rows = [], theme = 'default', parsed = null } = {}) {
  const r = ruler === undefined ? rulerOf(scene, time) : ruler;
  return titleBlock(input, style, { scene, theme, parsed }) + (r ? rulerSvg(input, style, r) : '') + legend(input, style, rows);
}
