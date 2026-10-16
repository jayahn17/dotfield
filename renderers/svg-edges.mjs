// renderers/svg-edges.mjs — the edge layer of renderers/svg.mjs. What is drawn
// is what lib/gates/layout.mjs measured:
//   path    edgePolyline() (the layout's routes[id], else routePoints()), cut
//           only where it leaves its end glyphs (a circle of radius r, or a
//           pill's capsule), so a route that starts on a port or a lifeline
//           keeps its full length; pathLength="100", and a variant's dash
//           pattern is written in those units so it keeps its px rhythm
//   label   exactly edgeLabelBox() on the untrimmed polyline (size 11,
//           centred at label_at, textLength = the box width); a transition's
//           label sits on a pill of that same box
//   marker  one per kind family: filled arrow (depends, flow, cites,
//           precedes and every other directed kind, coloured foreign for
//           share and accent-2 for candidate), open arrow (message,
//           transition), none (undirected)
//   time    with views.time: data-at (edgeAt), data-phase (visibleAt at the
//           playhead) and, for an edge in flight (0 < phase < 1), a finite
//           dash window — dasharray "100 100" (a variant: its pattern over
//           the 100 units, then a 100-unit gap) with dashoffset
//           100·(1 − phase), so a still shows it partly drawn; phase 0 is a
//           ghost (df-unborn), phase 1 carries no window (a solid edge no
//           dasharray at all), and @media print forces offset 0. data-order whenever order is an
//           integer; on an order axis a numbered badge at label_at − 0.1
//           (label_at when there is no label), clamped to [0.05, 0.95], and
//           stepped along the route while it would touch its label box or
//           anything else drawn (lib/layout/drawn.mjs places it; the gate
//           measures that disc).
//
//   renderEdges(input, P, style, {scene, time, visible, g, items}) -> string   (items: drawnItems, computed when absent)
//   edgeMarkers(input, P)              -> the <marker> defs the drawn edges use
//   markerOf(edge)                     -> marker id | null
//   badgeT(edge)                       -> the badge's arc-length fraction (label_at − 0.1, clamped)
//   badgePoint(edge, raw, r, box)      -> the badge centre: badgeT, or the first point clear of the label box
//   dashWindow(pattern, length, phase) -> {dasharray, dashoffset} in pathLength units
//   drawnPolyline(raw, g, fi, ti, P, directed) -> the polyline cut at its end glyphs
import { edgePolyline, trim } from '../lib/layout/geometry.mjs';
import { BADGE_SIZE, EDGE_LABEL_SIZE, edgeLabelBox } from '../lib/layout/metrics.mjs';
import { drawnItems } from '../lib/layout/drawn.mjs';
import { glyphShapes } from '../lib/layout/labels.mjs';
import { edgeAt, timeIndex } from '../lib/time/playhead.mjs';
import { attrs, fmt, fmt3, isObject, text, tok } from './svg.mjs';

export const PATH_LENGTH = 100;
// The badge geometry lives in lib/layout/metrics.mjs so the layout gate measures the disc drawn here.
export { BADGE_R, BADGE_SIZE, BADGE_STEP, badgePoint, badgeT } from '../lib/layout/metrics.mjs';
/** A route end within this many px of its glyph counts as attached to it (and is cut at the glyph's edge). */
export const ATTACH_PX = 0.5;
const MAX_DASH_ENTRIES = 400;
const PATTERNS = Object.freeze({ dashed: [6, 4], flow: [10, 6] });
const MARKERS = Object.freeze([
  ['df-arrow', 'filled', 'line-strong'], ['df-arrow-foreign', 'filled', 'foreign'],
  ['df-arrow-accent', 'filled', 'accent-2'], ['df-arrow-open', 'open', 'line-strong'],
]);

/** The marker an edge ends in: none when undirected, open for message and transition, else filled (foreign for share, accent for candidate). */
export function markerOf(edge) {
  if (!isObject(edge) || !edge.directed) return null;
  if (edge.kind === 'message' || edge.kind === 'transition') return 'df-arrow-open';
  if (edge.kind === 'share') return 'df-arrow-foreign';
  return edge.kind === 'candidate' ? 'df-arrow-accent' : 'df-arrow';
}

/** <marker> defs for the markers the drawable edges use, in a fixed order. */
export function edgeMarkers(input, P) {
  const used = new Set();
  for (const [fi, ti, e] of input.edges) if (P[fi] && P[ti]) used.add(markerOf(e));
  return MARKERS.filter(([id]) => used.has(id)).map(([id, family, colour]) => {
    const body = family === 'open'
      ? `<path d="M1 1L8 4L1 7" fill="none" stroke="${tok(colour)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M0 0L8 4L0 8Z" fill="${tok(colour)}"/>`;
    return `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">${body}</marker>`;
  }).join('');
}

/**
 * How far from p along the unit direction u the ray stays inside glyph i
 * centred at c (a circle of radius hy, or a pill: the capsule of half
 * length hx − hy and radius hy); null when p is not on or inside it.
 */
function insideRun(g, i, c, p, u) {
  const rad = g.hy[i]; const core = g.pill[i] ? g.hx[i] - g.hy[i] : 0;
  const dx0 = p[0] - c[0]; const dy0 = p[1] - c[1];
  const ex = dx0 - (dx0 < -core ? -core : (dx0 > core ? core : dx0));
  const lim = rad + ATTACH_PX;
  if (ex * ex + dy0 * dy0 > lim * lim) return null;
  let run = 0;
  for (const cx of core > 0 ? [-core, core] : [0]) {
    const dx = dx0 - cx; const b = dx * u[0] + dy0 * u[1];
    const disc = b * b - (dx * dx + dy0 * dy0 - rad * rad);
    if (disc >= 0) { const end = -b + Math.sqrt(disc); if (end > run) run = end; }
  }
  if (core > 0) {
    let lo = -Infinity; let hi = Infinity;
    for (const [o, d, m] of [[dx0, u[0], core], [dy0, u[1], rad]]) {
      if (d === 0) { if (o < -m || o > m) hi = -Infinity; continue; }
      const a = (-m - o) / d; const b = (m - o) / d;
      if ((a < b ? a : b) > lo) lo = a < b ? a : b;
      if ((a < b ? b : a) < hi) hi = a < b ? b : a;
    }
    if (hi >= lo && hi > run) run = hi;
  }
  return run;
}

function unit(a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const len = Math.sqrt(dx * dx + dy * dy);
  return len > 0 ? [dx / len, dy / len] : null;
}

/**
 * The drawn polyline: cut 1 px past where it leaves the start glyph, and
 * 4 px (directed: room for the arrow) or 1 px before it enters the end glyph.
 * An end that is not on its glyph (a port elsewhere, a lifeline) is kept,
 * less 1 px for an arrow tip. A chord between centres is cut at r + 1 and
 * r + 4, as before routes existed.
 */
export function drawnPolyline(raw, g, fi, ti, P, directed) {
  const n = raw.length;
  const u0 = n >= 2 ? unit(raw[0], raw[1]) : null; const u1 = n >= 2 ? unit(raw[n - 1], raw[n - 2]) : null;
  const a = u0 ? insideRun(g, fi, P[fi], raw[0], u0) : null;
  const b = u1 ? insideRun(g, ti, P[ti], raw[n - 1], u1) : null;
  return trim(raw, a === null ? 0 : a + 1, b === null ? (directed ? 1 : 0) : b + (directed ? 4 : 1));
}

function lengthOf(poly) {
  let total = 0;
  for (let i = 1; i < poly.length; i += 1) { const dx = poly[i][0] - poly[i - 1][0]; const dy = poly[i][1] - poly[i - 1][1]; total += Math.sqrt(dx * dx + dy * dy); }
  return total;
}

/**
 * The dash attributes in pathLength units for a path `length` px long.
 * phase null, 0 or 1 (no time block, a ghost, a drawn edge): the variant
 * pattern only, and nothing at all for a solid edge, so a renderer that
 * ignores pathLength still draws it whole. In flight (0 < phase < 1) the
 * finite window: solid "100 100" with dashoffset 100·(1 − phase); a variant
 * writes its pattern over the 100 units then a 100-unit gap, so the same
 * offset reveals it.
 */
export function dashWindow(pattern, length, phase) {
  if (!(length > 0)) return { dasharray: pattern ? pattern.join(' ') : null, dashoffset: null };
  const units = pattern ? pattern.map((v) => (v * PATH_LENGTH) / length) : null;
  if (phase === null || phase === undefined) return { dasharray: units ? units.map(fmt3).join(' ') : null, dashoffset: null };
  const p = phase < 0 ? 0 : (phase > 1 ? 1 : phase);
  const flight = p > 0 && p < 1;
  if (!flight) return { dasharray: units ? units.map(fmt3).join(' ') : null, dashoffset: null };
  const dashoffset = fmt3(PATH_LENGTH * (1 - p));
  if (!units) return { dasharray: `${PATH_LENGTH} ${PATH_LENGTH}`, dashoffset };
  const out = []; let pos = 0;
  while (pos < PATH_LENGTH && out.length < MAX_DASH_ENTRIES) {
    const d = Math.min(units[0], PATH_LENGTH - pos); out.push(d); pos += d;
    if (pos >= PATH_LENGTH) break;
    const gap = Math.min(units[1], PATH_LENGTH - pos); out.push(gap); pos += gap;
  }
  if (pos < PATH_LENGTH) return { dasharray: `${PATH_LENGTH} ${PATH_LENGTH}`, dashoffset };
  if (out.length % 2) out.push(PATH_LENGTH); else out[out.length - 1] += PATH_LENGTH;
  return { dasharray: out.map(fmt3).join(' '), dashoffset };
}

/** A numbered order badge on the disc lib/layout/drawn.mjs placed (what the layout gate measures). */
function badge(c, order, style) {
  return `<g${attrs({ class: 'df-badge', 'data-order': order, transform: `translate(${fmt(c.cx)} ${fmt(c.cy)})` })}><circle${attrs({ r: fmt(c.r), fill: tok('badge-bg'), stroke: tok('line-strong'), 'stroke-width': 1 })}/>`
    + `${text('df-badge-num', 0, BADGE_SIZE * 0.35, String(order), style, BADGE_SIZE, { 'text-anchor': 'middle' }, c.w0)}</g>`;
}

/** The edge layer: one <g class="df-edge-group"> per drawable edge, in scene order. */
export function renderEdges(input, P, style, { scene, time = null, visible = null, g = null, items = null } = {}) {
  const s = isObject(scene) ? scene : input.scene;
  const shapes = g || glyphShapes(input);
  const X = Float64Array.from(input.nodes, (n, i) => (P[i] ? P[i][0] : input.frame.cx)); const Y = Float64Array.from(input.nodes, (n, i) => (P[i] ? P[i][1] : input.frame.cy));
  const discs = new Map((items ?? drawnItems(s, input, X, Y, shapes)).filter((it) => it.kind === 'badge').map((it) => [it.ek, it]));
  const index = new Map((Array.isArray(s.edges) ? s.edges : []).filter(isObject).map((e, i) => [e, i]));
  const byId = time ? timeIndex(s).nodesById : null;
  const out = [];
  for (const [k, [fi, ti, e]] of input.edges.entries()) {
    if (!P[fi] || !P[ti]) continue;
    const foreign = e.kind === 'share'; const cand = e.kind === 'candidate';
    const color = foreign ? tok('foreign') : (cand ? tok('accent-2') : tok('line-strong'));
    const w = 1 + 1.5 * (typeof e.weight === 'number' ? e.weight : 0.5);
    const raw = edgePolyline(s, e, P[fi], P[ti]);
    const poly = drawnPolyline(raw, shapes, fi, ti, P, !!e.directed);
    const length = lengthOf(poly);
    const key = typeof e.id === 'string' && e.id ? e.id : `#${index.get(e)}`;
    const phase = time ? (visible && visible.edgePhase.has(key) ? visible.edgePhase.get(key) : 1) : null;
    const at = time ? edgeAt(e, byId, time) : null;
    const dash = dashWindow(e.variant === 'dashed' || cand ? PATTERNS.dashed : (e.variant === 'flow' ? PATTERNS.flow : null), length, phase);
    const marker = markerOf(e);
    const d = poly.map((p, i) => `${i ? 'L' : 'M'}${fmt(p[0])} ${fmt(p[1])}`).join('');
    const box = typeof e.label === 'string' && e.label ? edgeLabelBox(e, raw, style) : null;
    let extra = '';
    if (time && time.axis === 'order' && Number.isInteger(at) && discs.has(k)) extra += badge(discs.get(k), at, style);
    if (box) {
      const pill = e.kind === 'transition';
      if (pill) extra += `<rect${attrs({ class: 'df-edge-pill', x: fmt(box.x), y: fmt(box.y), width: fmt(box.w), height: fmt(box.h), rx: fmt(box.h / 2), fill: tok('badge-bg'), stroke: tok('line') })}/>`;
      extra += text(pill ? 'df-edge-label df-edge-label--pill' : 'df-edge-label', box.x + box.w / 2, box.y + EDGE_LABEL_SIZE, e.label, style, EDGE_LABEL_SIZE, { 'text-anchor': 'middle' }, box.w);
    }
    out.push(`<g${attrs({ class: phase === 0 ? 'df-edge-group df-unborn' : 'df-edge-group', 'data-edge-id': e.id, 'data-from': e.from, 'data-to': e.to, 'data-kind': e.kind })}>`
      + `<path${attrs({ class: `df-edge df-edge--${e.variant} df-edge--${e.kind}`, d, pathLength: length > 0 ? PATH_LENGTH : null, stroke: color, 'stroke-width': fmt(w),
        'stroke-dasharray': dash.dasharray, 'stroke-dashoffset': dash.dashoffset, 'marker-end': marker ? `url(#${marker})` : null,
        'data-at': at, 'data-order': Number.isInteger(e.order) ? e.order : null, 'data-phase': phase === null ? null : fmt(phase) })}/>${extra}</g>`);
  }
  return out.join('');
}
