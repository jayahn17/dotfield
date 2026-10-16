// Label sides (V2_PLAN §3 A): the layout measures node labels the way the
// gate does and moves a colliding label to another side of its glyph
// before it moves any node. A label carries its sublabel with it (the
// sublabel sits on the label's side); evidence pins stay at the glyph's
// top right and order badges on their routes, so both are obstacles here
// and part of the node box declutter separates. chooseSides() visits the
// colliding labels heaviest first (then index) and tries [kind default,
// above, right, left, below]; sides compare first by their hits on glyphs,
// node labels, sublabels, pins, edge labels and badges (what the clearance
// gate counts), then by a soft cost: 0.25 per route polyline passing
// within 2 px of the box (readability only, so no number of route hits
// ever outweighs one gate hit), 0.5 for leaving the default and 0.3 for
// leaving the viewBox. The result is sparse: only labels off their default
// side are returned, and lib/layout/index.mjs writes them to scene.labels.
// Pure; index-ordered.
//
//   chooseSides(input, X, Y, {routes, measured, sides, routeCost}) -> {sides: Map<index, side>, collisions}
//     routeCost false skips the route term (the repair rounds; the final pass prices routes)
//     collisions counts the label hits plus every pin hit no side can move
//   glyphShapes(input)                     -> {hx, hy, pill} half extents per node
//   glyphHitsBox(g, i, X, Y, radii, box)   -> does glyph i overlap the box?
//   textBoxes(input, i, p, side)           -> node i's label box and its sublabel box (when it has one) on `side`
//   nodeBoxes(input, sides, measured)      -> per node {left, right, top, bottom}: glyph box united with its label, sublabel and pins
//   segmentBoxDistance(p, q, box)          -> px from a segment to a box (0 when it enters)
import { boxGrid, boxesOverlap, circleBoxOverlap, edgePolyline, segmentDistance } from './geometry.mjs';
import { PILL_EXTENT, badgeCircle, edgeLabelBox, isPillGlyph, labelAnchor, labelBox, labelBudgetOf, labelStyle, measuredLabels, pinBoxes, sublabelBox } from './metrics.mjs';

export const SIDE_ORDER = Object.freeze(['above', 'right', 'left', 'below']);
export const SIDE_COST = Object.freeze({ route: 0.25, off_default: 0.5, outside: 0.3, route_px: 2 });

/** Half extents of every glyph ([1.3 r, 0.6 r] for a pill) and the pill flag. */
export function glyphShapes(input) {
  const n = input.nodes.length;
  const hx = new Float64Array(n); const hy = new Float64Array(n); const pill = new Uint8Array(n);
  input.nodes.forEach((node, i) => {
    const r = input.radii[i];
    if (isPillGlyph(node, input.shapes)) { hx[i] = PILL_EXTENT[0] * r; hy[i] = PILL_EXTENT[1] * r; pill[i] = 1; } else { hx[i] = r; hy[i] = r; }
  });
  return { hx, hy, pill };
}

/** Does glyph i (a circle of radius r, or a pill's box) overlap the box? */
export function glyphHitsBox(g, i, X, Y, radii, box) {
  if (g.pill[i]) return boxesOverlap({ x: X[i] - g.hx[i], y: Y[i] - g.hy[i], w: 2 * g.hx[i], h: 2 * g.hy[i] }, box);
  return circleBoxOverlap(X[i], Y[i], radii[i], box);
}

/** Distance from segment p-q to an axis-aligned box: 0 when either end lies inside or the segment crosses an edge. */
export function segmentBoxDistance(p, q, box) {
  const inside = (a) => a[0] >= box.x && a[0] <= box.x + box.w && a[1] >= box.y && a[1] <= box.y + box.h;
  if (inside(p) || inside(q)) return 0;
  const c = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
  let best = Infinity;
  for (let k = 0; k < 4; k += 1) { const d = segmentDistance(p, q, c[k], c[(k + 1) % 4]); if (d < best) best = d; }
  return best;
}

/** Node i's label box and, when it has one, its sublabel box, on `side` of the glyph centred at p. */
export function textBoxes(input, i, p, side) {
  const style = input.style ?? labelStyle();
  const node = input.nodes[i];
  const out = [labelBox(node, p, input.radii[i], style, input.shapes, side)];
  const sub = sublabelBox(node, p, input.radii[i], style, input.shapes, side);
  if (sub) out.push(sub);
  return out;
}

/** Is node i's text drawn (and measured)? Labelled within the budget, or carrying no label at all (its sublabel and pins then always show). */
function shown(input, i, meas) {
  const n = input.nodes[i];
  return meas.has(i) || !(typeof n.label === 'string' && n.label.length);
}

/** Glyph box united with the label and sublabel boxes on its side and the evidence pins (drawn text only), as offsets from the node centre. */
export function nodeBoxes(input, sides = null, measured = null) {
  const style = input.style ?? labelStyle();
  const meas = measured ?? input.measured ?? measuredLabels(input.nodes, labelBudgetOf(input.scene, input.nodes.length));
  const g = glyphShapes(input);
  return input.nodes.map((node, i) => {
    const b = { left: -g.hx[i], right: g.hx[i], top: -g.hy[i], bottom: g.hy[i] };
    if (!shown(input, i, meas)) return b;
    const side = sides && sides.has(i) ? sides.get(i) : labelAnchor(node, input.shapes);
    const boxes = [...pinBoxes(node, [0, 0], input.radii[i], style, input.pinLabel)];
    if (meas.has(i)) boxes.push(...textBoxes(input, i, [0, 0], side));
    else { const sub = sublabelBox(node, [0, 0], input.radii[i], style, input.shapes, side); if (sub) boxes.push(sub); }
    for (const lb of boxes) {
      if (lb.x < b.left) b.left = lb.x;
      if (lb.x + lb.w > b.right) b.right = lb.x + lb.w;
      if (lb.y < b.top) b.top = lb.y;
      if (lb.y + lb.h > b.bottom) b.bottom = lb.y + lb.h;
    }
    return b;
  });
}

function weightOf(node) { return node && typeof node.weight === 'number' && Number.isFinite(node.weight) ? node.weight : 0.5; }

/** The polylines, edge-label boxes and order-badge discs chooseSides measures against (routes table first, else routePoints). */
function edgeGeometry(input, X, Y, routes, style) {
  const scene = { routes: routes ?? (input.scene && input.scene.routes) };
  const polys = []; const eboxes = []; const discs = [];
  input.edges.forEach(([a, b, e], k) => {
    const poly = edgePolyline(scene, e, [X[a], Y[a]], [X[b], Y[b]]);
    let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
    for (const q of poly) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    if (a !== b) polys.push({ a, b, poly, minx, miny, maxx, maxy });
    const eb = typeof e.label === 'string' && e.label.length ? edgeLabelBox(e, poly, style) : null;
    if (eb) eboxes.push({ ...eb, k });
    if (input.badges && input.badges.has(k)) discs.push({ ...badgeCircle(e, poly, input.badges.get(k), style), k });
  });
  return { polys, eboxes, discs };
}

/**
 * Move colliding labels to a free side. `sides` (Map index -> side) is the
 * starting assignment (default sides when null); `measured` the label budget
 * set; `routes` the edge-id -> polyline table the routes pass wrote.
 */
export function chooseSides(input, X, Y, { routes = null, measured = null, sides = null, routeCost = true } = {}) {
  const { nodes, radii, shapes, frame } = input;
  const n = nodes.length;
  const style = input.style ?? labelStyle();
  const meas = measured ?? input.measured ?? measuredLabels(nodes, labelBudgetOf(input.scene, n));
  const g = glyphShapes(input);
  const def = nodes.map((nd) => labelAnchor(nd, shapes));
  const cur = def.slice();
  if (sides) for (const [i, s] of sides) if (i >= 0 && i < n) cur[i] = s;
  const list = [...meas].sort((a, b) => a - b);
  const box = new Array(n).fill(null);
  const at = (i, side) => textBoxes(input, i, [X[i], Y[i]], side);
  for (const i of list) box[i] = at(i, cur[i]);
  const { polys, eboxes, discs } = edgeGeometry(input, X, Y, routes, style);
  // What no side choice moves: the pins of every drawn node, and the sublabel of a node with no label.
  const fixed = [];
  for (let i = 0; i < n; i += 1) {
    if (!shown(input, i, meas)) continue;
    for (const b of pinBoxes(nodes[i], [X[i], Y[i]], radii[i], style, input.pinLabel)) fixed.push({ ...b, owner: i });
    if (!meas.has(i)) { const sub = sublabelBox(nodes[i], [X[i], Y[i]], radii[i], style, shapes, cur[i]); if (sub) fixed.push({ ...sub, owner: i }); }
  }
  const vb = frame ? { x: frame.x0, y: frame.y0, w: frame.w, h: frame.h } : null;
  const glyphs = boxGrid(64);
  for (let k = 0; k < n; k += 1) glyphs.insert(k, X[k] - g.hx[k], Y[k] - g.hy[k], X[k] + g.hx[k], Y[k] + g.hy[k]);
  const lines = boxGrid(128);
  if (routeCost) polys.forEach((p, pi) => { for (let s = 1; s < p.poly.length; s += 1) lines.insertSegment(pi, p.poly[s - 1], p.poly[s], SIDE_COST.route_px); });
  // One box (a label, a sublabel or a pin of node i) against everything another owner drew.
  const boxHits = (i, b, withLabels) => {
    let h = 0;
    for (const k of glyphs.query(b.x, b.y, b.x + b.w, b.y + b.h)) if (k !== i && glyphHitsBox(g, k, X, Y, radii, b)) h += 1;
    if (withLabels) for (const j of list) if (j !== i) for (const o of box[j]) if (boxesOverlap(b, o)) h += 1;
    for (const f of fixed) if (f.owner !== i && boxesOverlap(b, f)) h += 1;
    for (const eb of eboxes) if (boxesOverlap(b, eb)) h += 1;
    for (const d of discs) if (circleBoxOverlap(d.cx, d.cy, d.r, b)) h += 1;
    return h;
  };
  const gateHits = (i, boxes) => { let h = 0; for (const b of boxes) h += boxHits(i, b, true); return h; };
  const routeHits = (i, boxes) => {
    let h = 0;
    for (const b of boxes) {
      for (const pi of lines.query(b.x - 2, b.y - 2, b.x + b.w + 2, b.y + b.h + 2)) {
        const p = polys[pi];
        if (p.a === i || p.b === i) continue;
        for (let s = 1; s < p.poly.length; s += 1) if (segmentBoxDistance(p.poly[s - 1], p.poly[s], b) < SIDE_COST.route_px) { h += 1; break; }
      }
    }
    return h;
  };
  const outside = (boxes) => vb !== null && boxes.some((b) => b.x < vb.x || b.y < vb.y || b.x + b.w > vb.x + vb.w || b.y + b.h > vb.y + vb.h);
  const soft = (i, side, b) => (routeCost ? SIDE_COST.route * routeHits(i, b) : 0) + (side !== def[i] ? SIDE_COST.off_default : 0) + (outside(b) ? SIDE_COST.outside : 0);
  const order = list.filter((i) => cur[i] !== def[i] || gateHits(i, box[i]) > 0)
    .sort((a, b) => (weightOf(nodes[b]) - weightOf(nodes[a])) || (a - b));
  for (let sweep = 0; sweep < 2; sweep += 1) {
    let changed = false;
    for (const i of order) {
      const candidates = [def[i], ...SIDE_ORDER.filter((s) => s !== def[i])];
      let bestSide = cur[i]; let bestBox = box[i]; let bestHits = gateHits(i, box[i]); let best = soft(i, cur[i], box[i]);
      for (const side of candidates) {
        if (side === cur[i]) continue;
        const b = at(i, side);
        const h = gateHits(i, b);
        if (h > bestHits) continue;
        const c = soft(i, side, b);
        if (h < bestHits || c < best - 1e-9) { bestHits = h; best = c; bestSide = side; bestBox = b; }
      }
      if (bestSide !== cur[i]) { cur[i] = bestSide; box[i] = bestBox; changed = true; }
    }
    if (!changed) break;
  }
  let collisions = 0;
  for (const i of list) collisions += gateHits(i, box[i]);
  // Pins no side moves: against glyphs, other pins, edge labels and badges (pins against labels were counted above).
  for (const f of fixed) collisions += boxHits(f.owner, f, false);
  const out = new Map();
  for (let i = 0; i < n; i += 1) if (cur[i] !== def[i] && meas.has(i)) out.set(i, cur[i]);
  return { sides: out, collisions };
}
