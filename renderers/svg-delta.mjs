// renderers/svg-delta.mjs — the before/after layer of renderers/svg.mjs,
// drawn only when the scene carries a delta block (written by `dotfield
// compare`, lib/delta.mjs). The scene is the after scene; everything here is
// derived from delta rows and the committed tables, never re-simulated, and
// coloured by var(--df-*) only. A scene without a delta draws none of it, so
// every golden stays byte-identical.
//   classes  df-added | df-changed | df-moved on the node <g> (a changed node
//            whose geometry changed carries df-changed and df-moved)
//   rings    a ring around every added (solid), changed (dashed) and moved
//            (dotted) node, in neutral tokens (accent, accent-2, muted; a
//            removed ghost faint), never good/warn/bad: the dash pattern
//            repeats what the colour says, and neither grades the change
//   ghosts   every removed node at its before position (delta.nodes[].from):
//            its before glyph outlined and dashed, its label on the first
//            side clear of the after glyphs and labels; removed edges as
//            dashed chords between their ends (an after node, or a ghost)
//   moves    a dashed connector from -> to with a hollow mark at from
//   halos    a soft wide stroke under every added or changed edge
//   legend   bottom right: one row per change that occurs, then the claim
// Ghosts carry data-delta-node (never data-node-id, never tabindex), and
// halos data-delta-edge (never data-edge-id), so the viewer's selection,
// steps and time bar see only the after scene.
//
//   deltaLayers(scene, input, P, style) -> {style, classOf(id), under, over, legend} | null
//   deltaOf(scene) -> the delta block | null
import { edgeKeys } from '../lib/delta.mjs';
import { boxesOverlap, edgePolyline, routePoints, trim } from '../lib/layout/geometry.mjs';
import { LABEL_LINE_HEIGHT, glyphRadius, labelBox, labelSide, labelWidth, sideBox } from '../lib/layout/metrics.mjs';
import { glyphShapes } from '../lib/layout/labels.mjs';
import { SMALL, attrs, fmt, glyphOf, glyphPath, isObject, text, tok } from './svg.mjs';

/**
 * Change classes take neutral tokens, never the status tokens good / warn /
 * bad: the delta says what changed, not whether it is better or worse
 * (claims: "no risk assessment"). The dash pattern carries the class too.
 */
export const DELTA_TOKENS = Object.freeze({ added: 'accent', removed: 'faint', changed: 'accent-2', moved: 'muted' });
export const RING_DASH = Object.freeze({ added: null, changed: '5 3', moved: '1.5 3' });
export const RING_GAP_PX = 5;
export const GHOST_SIDES = Object.freeze(['below', 'above', 'right', 'left']);
const LEGEND_ROW = 16;
const LEGEND_PAD = 8;
const CHANGE_LABEL = Object.freeze({ added: 'added', removed: 'removed (ghosted at its before position)', changed: 'changed', moved: 'moved (dashed from its before position)' });

/** The scene's delta block when it has the shape lib/delta.mjs writes, else null. */
export function deltaOf(scene) {
  const d = isObject(scene) ? scene.delta : null;
  return isObject(d) && Array.isArray(d.nodes) && Array.isArray(d.edges) ? d : null;
}

function styleRules() {
  const t = (k) => tok(DELTA_TOKENS[k]);
  return `<style data-df="delta">.df-added .df-glyph{stroke:${t('added')};stroke-width:2.5px}.df-moved .df-glyph{stroke:${t('moved')};stroke-width:2.5px}.df-changed .df-glyph{stroke:${t('changed')};stroke-width:2.5px}`
    + `.df-delta-ring,.df-delta-move path,.df-delta-ghost-edge,.df-delta-halo{fill:none;stroke-linecap:round;stroke-linejoin:round}.df-ghost{opacity:0.7}.df-scene .df-ghost-label{fill:var(--df-muted)}`
    + `.df-delta-legend text{fill:var(--df-muted)}.df-scene .df-delta-legend .df-delta-claim{fill:var(--df-faint)}</style>`;
}

function nodeRows(delta) {
  return delta.nodes.filter((r) => isObject(r) && typeof r.id === 'string' && typeof r.change === 'string');
}

/** id -> the class list a node <g> gains: df-added, df-changed (+ df-moved when its geometry changed), df-moved. */
function classMap(delta) {
  const out = new Map();
  for (const r of nodeRows(delta)) {
    if (r.change === 'added') out.set(r.id, 'df-added');
    else if (r.change === 'moved') out.set(r.id, 'df-moved');
    else if (r.change === 'changed') out.set(r.id, Array.isArray(r.axes) && r.axes.includes('geometry') ? 'df-changed df-moved' : 'df-changed');
  }
  return out;
}

function ring(change, x, y, r) {
  return `<circle${attrs({ class: `df-delta-ring df-delta-ring--${change}`, cx: fmt(x), cy: fmt(y), r: fmt(r + RING_GAP_PX), stroke: tok(DELTA_TOKENS[change]), 'stroke-width': 1.5, 'stroke-dasharray': RING_DASH[change] })}/>`;
}

const d = (poly) => poly.map((p, i) => `${i ? 'L' : 'M'}${fmt(p[0])} ${fmt(p[1])}`).join('');

/** Under the edge layer: halos along every added or changed edge, dashed chords for every removed edge. */
function under(input, P, delta, ghostAt) {
  const s = input.scene;
  const keys = edgeKeys(s);
  const byKey = new Map();
  (Array.isArray(s.edges) ? s.edges : []).forEach((e, i) => { if (keys[i] !== null) byKey.set(keys[i], e); });
  const out = [];
  for (const r of delta.edges) {
    if (!isObject(r) || typeof r.id !== 'string') continue;
    if (r.change === 'removed') {
      const ends = Array.isArray(r.ends) ? r.ends : [];
      const a = ghostAt(ends[0]); const b = ghostAt(ends[1]);
      if (!a || !b) continue;
      out.push(`<path${attrs({ class: 'df-delta-ghost-edge', 'data-delta-edge': r.id, d: d(routePoints({}, a, b)), stroke: tok(DELTA_TOKENS.removed), 'stroke-width': 1.5, 'stroke-opacity': 0.6, 'stroke-dasharray': '4 4' })}/>`);
      continue;
    }
    if (r.change !== 'added' && r.change !== 'changed') continue;
    const e = byKey.get(r.id);
    const fi = e ? input.ids.get(e.from) : undefined; const ti = e ? input.ids.get(e.to) : undefined;
    if (fi === undefined || ti === undefined || !P[fi] || !P[ti]) continue;
    out.push(`<path${attrs({ class: `df-delta-halo df-delta-halo--${r.change}`, 'data-delta-edge': r.id, d: d(edgePolyline(s, e, P[fi], P[ti])), stroke: tok(DELTA_TOKENS[r.change]), 'stroke-width': 7, 'stroke-opacity': 0.28 })}/>`);
  }
  return out.join('');
}

/** The after glyph and label boxes ghost labels must stay clear of. */
function obstacles(input, P, style) {
  const out = [];
  input.nodes.forEach((n, i) => {
    if (!P[i]) return;
    const r = input.radii[i];
    out.push({ x: P[i][0] - r, y: P[i][1] - r, w: 2 * r, h: 2 * r });
    if (typeof n.label === 'string' && n.label) out.push(labelBox(n, P[i], r, style, input.shapes, labelSide(input.scene, n, input.shapes)));
  });
  return out;
}

/** Over the edges, under the nodes: rings, move connectors and ghosts. */
function over(input, P, style, delta) {
  const g = glyphShapes(input);
  const blocked = obstacles(input, P, style);
  const out = [];
  for (const r of nodeRows(delta)) {
    const i = input.ids.get(r.id);
    if (r.change === 'removed') {
      if (!Array.isArray(r.from) || !Number.isFinite(r.from[0]) || !Number.isFinite(r.from[1])) continue;
      const node = { id: r.id, kind: typeof r.kind === 'string' ? r.kind : 'record', label: typeof r.label === 'string' ? r.label : r.id, weight: 0.5 };
      const rad = glyphRadius(node, input.shapes);
      const glyph = glyphOf(node, input.shapes);
      const w = labelWidth(node.label, style); const h = style.size * LABEL_LINE_HEIGHT;
      const side = GHOST_SIDES.find((sd) => !blocked.some((b) => boxesOverlap(sideBox(r.from, rad, w, h, sd), b))) ?? 'below';
      const box = sideBox(r.from, rad, w, h, side);
      blocked.push(box, { x: r.from[0] - rad, y: r.from[1] - rad, w: 2 * rad, h: 2 * rad });
      out.push(`<g${attrs({ class: 'df-ghost df-removed', 'data-delta-node': r.id, 'data-kind': node.kind, transform: `translate(${fmt(r.from[0])} ${fmt(r.from[1])})` })}>`
        + `<path${attrs({ class: `df-glyph df-glyph--${glyph}`, d: glyphPath(glyph, rad), 'fill-rule': glyph === 'ring' ? 'evenodd' : null, fill: 'none', stroke: tok(DELTA_TOKENS.removed), 'stroke-width': 1.5, 'stroke-dasharray': '3 3' })}/>`
        + `${text('df-ghost-label', box.x - r.from[0], box.y - r.from[1] + style.size, node.label, style, style.size)}</g>`);
      continue;
    }
    if (i === undefined || !P[i] || !['added', 'changed', 'moved'].includes(r.change)) continue;
    const rad = Math.max(g.hx[i], g.hy[i]);
    if (Array.isArray(r.from) && Number.isFinite(r.from[0]) && Number.isFinite(r.from[1])) {
      const dx = P[i][0] - r.from[0]; const dy = P[i][1] - r.from[1]; const len = Math.sqrt(dx * dx + dy * dy);
      if (len > rad + RING_GAP_PX + 4) {
        const line = trim([[r.from[0], r.from[1]], [P[i][0], P[i][1]]], 4, rad + RING_GAP_PX + 1);
        out.push(`<g${attrs({ class: 'df-delta-move', 'data-delta-node': r.id })}><path${attrs({ d: d(line), stroke: tok(DELTA_TOKENS.moved), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' })}/>`
          + `<circle${attrs({ cx: fmt(r.from[0]), cy: fmt(r.from[1]), r: 4, fill: 'none', stroke: tok(DELTA_TOKENS.moved), 'stroke-width': 1.5 })}/></g>`);
      }
    }
    out.push(ring(r.change, P[i][0], P[i][1], rad));
  }
  return out.join('');
}

function swatch(change, cx, cy) {
  if (change === 'removed') return `<circle${attrs({ cx: fmt(cx), cy: fmt(cy), r: 5, fill: 'none', stroke: tok(DELTA_TOKENS.removed), 'stroke-width': 1.5, 'stroke-dasharray': '3 3' })}/>`;
  return `<circle${attrs({ cx: fmt(cx), cy: fmt(cy), r: 5, fill: 'none', stroke: tok(DELTA_TOKENS[change]), 'stroke-width': 1.5, 'stroke-dasharray': RING_DASH[change] })}/>`;
}

/** Bottom right of the frame: one row per change that occurs (nodes and edges), then the claim. */
function legend(input, style, delta) {
  const counts = isObject(delta.counts) ? delta.counts : {};
  const n = isObject(counts.nodes) ? counts.nodes : {}; const e = isObject(counts.edges) ? counts.edges : {};
  const rows = [];
  for (const change of ['added', 'removed', 'changed', 'moved']) {
    const cn = Number.isInteger(n[change]) ? n[change] : 0; const ce = Number.isInteger(e[change]) ? e[change] : 0;
    if (!cn && !ce) continue;
    rows.push({ change, label: `${CHANGE_LABEL[change]}: ${cn} node${cn === 1 ? '' : 's'}, ${ce} edge${ce === 1 ? '' : 's'}` });
  }
  if (!rows.length) rows.push({ change: null, label: 'no change between the two scenes' });
  const claim = typeof delta.claims === 'string' ? delta.claims : '';
  const all = claim ? [...rows, { change: null, label: claim, claim: true }] : rows;
  const width = 18 + Math.max(...all.map((r) => labelWidth(r.label, { ...style, size: SMALL }))) + 2 * LEGEND_PAD;
  const height = all.length * LEGEND_ROW + 2 * LEGEND_PAD - 4;
  const { frame } = input;
  const x0 = frame.x0 + frame.w - frame.padding - width; const y0 = frame.y0 + frame.h - frame.padding - height;
  let body = `<rect${attrs({ x: fmt(x0), y: fmt(y0), width: fmt(width), height: fmt(height), rx: 6, fill: tok('panel'), 'fill-opacity': 0.9, stroke: tok('line') })}/>`;
  all.forEach((r, k) => {
    const cx = x0 + LEGEND_PAD + 6; const cy = y0 + LEGEND_PAD + k * LEGEND_ROW + 6;
    body += (r.change ? swatch(r.change, cx, cy) : '') + text(r.claim ? 'df-delta-claim' : 'df-legend-item', cx + 12, cy + 4, r.label, style, SMALL, r.change ? { 'data-change': r.change } : {});
  });
  return `<g class="df-delta-legend" aria-hidden="true">${body}</g>`;
}

/**
 * Everything svg.mjs draws for a delta, or null when the scene has none.
 * classOf(id) -> the class list for that node <g> | null; under (halos and
 * removed edges) goes below the edge layer, over (rings, moves, ghosts)
 * between the edges and the nodes, legend inside the chrome.
 */
export function deltaLayers(scene, input, P, style) {
  const delta = deltaOf(scene);
  if (!delta) return null;
  const classes = classMap(delta);
  const ghosts = new Map(nodeRows(delta).filter((r) => r.change === 'removed' && Array.isArray(r.from)).map((r) => [r.id, r.from]));
  const ghostAt = (id) => { const i = input.ids.get(id); return i !== undefined && P[i] ? P[i] : (ghosts.get(id) ?? null); };
  return {
    style: styleRules(),
    classOf: (id) => classes.get(id) ?? null,
    under: under(input, P, delta, ghostAt),
    over: over(input, P, style, delta),
    legend: legend(input, style, delta),
  };
}
