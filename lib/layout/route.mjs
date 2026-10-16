// Route repair for the modes that do not route channels themselves (V2_PLAN
// §3 A): the sparse half of scene.routes. Every table entry is keyed by edge
// id, so an id-less edge is never routed; an authored via[] and a route the
// author fixed (straight) are never touched.
//   fanParallel   k edges on one unordered node pair (orthogonal ones aside)
//                 each take one via point at the chord midpoint, offset
//                 (i - (k-1)/2) * (GLYPH_GAP_PX + 4) along the perpendicular of
//                 the lower-index -> higher-index chord, in edge order, so
//                 parallel edges never share a line.
//   routeAround   an auto edge whose polyline passes within r_k + GLYPH_GAP_PX/2
//                 of a node it does not connect (the gate's exact test; a pill
//                 by its capsule) gets a via point beside that node,
//                 r_k + GLYPH_GAP_PX + 6 off its centre (the half width for a
//                 pill) on the side of the segment with fewer nodes in its band
//                 (ties: the shorter detour; the other side when it leaves
//                 fewer blockers), both new segments are re-tested, at most
//                 maxVia insertions, else the edge keeps its chord for the gate
//                 to report. A later detour past the same node side sits one
//                 fan step further out, and a detour whose end segment runs
//                 along another edge's is nudged off it, so routes never share
//                 a line.
//   routePlanGrid an orthogonal grid edge whose Z route crosses a node runs in
//                 the channels between rows and columns instead, the k-th such
//                 edge (k + 1) * 6 px off the boundary line (a plain Z route
//                 runs on the boundary itself, so they never share a line).
//   separateEdgeLabels  an auto edge whose label (edgeLabelBox at the route's
//                 midpoint) hits a glyph, a measured node label, its sublabel
//                 or pins, or an earlier
//                 edge label bends its chord through one via point beside the
//                 midpoint, +-1..4 label heights along the perpendicular, the
//                 first offset that clears everything and crosses no node.
// Pure; + - * / and Math.sqrt; edges in index order.
//
//   fanParallel(input, X, Y)                     -> {edgeId: polyline}
//   routeAround(input, X, Y, {maxVia, start})    -> {edgeId: polyline} (start: routes to begin from)
//   routePlanGrid(input, X, Y)                   -> {edgeId: polyline}
//   separateEdgeLabels(input, X, Y, routes, sides) -> {edgeId: polyline} (routes with the bent chords)
//   routePass(input, X, Y)                       -> fans, then grid channels (grid mode), then detours
//   routableEdgeIds(scene)                       -> {all: Set of edge ids, routable: ids whose ends are nodes}
//   blockers(input, X, Y, poly, a, b, g, grid)   -> [{seg, k, t}] nodes the polyline passes through
//   nodeGrid(input, X, Y, g)                     -> the bucket index blockers() queries
import { boxGrid, boxesOverlap, pointSegmentDistance2, routePoints, segmentDistance, segmentsOverlap } from './geometry.mjs';
import { EDGE_LABEL_SIZE, GLYPH_GAP_PX, LABEL_GAP_PX, LABEL_LINE_HEIGHT, edgeLabelBox, labelAnchor, labelBox, labelStyle, pinBoxes, sublabelBox } from './metrics.mjs';
import { glyphHitsBox, glyphShapes } from './labels.mjs';
import { gridCells } from './grid.mjs';

export const ROUTE = Object.freeze({ fan_step_px: GLYPH_GAP_PX + 4, around_px: GLYPH_GAP_PX + 6, max_via: 3, grid_track_px: 6 });

function hasId(e) { return typeof e.id === 'string' && e.id.length > 0; }
function authoredVia(e) { return Array.isArray(e.via) && e.via.length > 0; }
const isAuto = (e) => e.route === undefined || e.route === 'auto';

/** The distance from glyph k (a circle, or a pill's capsule) to a segment, minus nothing: compare with the glyph's own radius. */
function glyphDistance(g, k, X, Y, p, q) {
  const c = g.hx[k] - g.hy[k];
  if (c <= 0) return Math.sqrt(pointSegmentDistance2(X[k], Y[k], p[0], p[1], q[0], q[1]));
  return segmentDistance([X[k] - c, Y[k]], [X[k] + c, Y[k]], p, q);
}

/** A node index: every glyph filed under the cells its extent (plus the gap) touches. */
export function nodeGrid(input, X, Y, g = glyphShapes(input)) {
  let reach = 1;
  for (let i = 0; i < g.hx.length; i += 1) if (g.hx[i] + GLYPH_GAP_PX > reach) reach = g.hx[i] + GLYPH_GAP_PX;
  const grid = boxGrid(4 * reach > 64 ? 4 * reach : 64);
  for (let i = 0; i < X.length; i += 1) grid.insert(i, X[i] - g.hx[i] - GLYPH_GAP_PX, Y[i] - g.hy[i] - GLYPH_GAP_PX, X[i] + g.hx[i] + GLYPH_GAP_PX, Y[i] + g.hy[i] + GLYPH_GAP_PX);
  grid.reach = reach;
  return grid;
}

/** The nodes (other than a and b) the polyline passes through, in segment order then along-segment order then index. */
export function blockers(input, X, Y, poly, a, b, g = glyphShapes(input), grid = null) {
  const out = [];
  const n = input.nodes.length;
  for (let s = 1; s < poly.length; s += 1) {
    const p = poly[s - 1]; const q = poly[s];
    const minx = p[0] < q[0] ? p[0] : q[0]; const maxx = p[0] < q[0] ? q[0] : p[0];
    const miny = p[1] < q[1] ? p[1] : q[1]; const maxy = p[1] < q[1] ? q[1] : p[1];
    const dx = q[0] - p[0]; const dy = q[1] - p[1]; const len2 = dx * dx + dy * dy;
    const found = [];
    const near = grid ? grid.querySegment(p, q, 0) : null;
    const count = near ? near.length : n;
    for (let c = 0; c < count; c += 1) {
      const k = near ? near[c] : c;
      if (k === a || k === b) continue;
      const reach = g.hx[k] + GLYPH_GAP_PX;
      if (X[k] < minx - reach || X[k] > maxx + reach || Y[k] < miny - reach || Y[k] > maxy + reach) continue;
      if (glyphDistance(g, k, X, Y, p, q) >= g.hy[k] + GLYPH_GAP_PX / 2) continue;
      const t = len2 > 0 ? ((X[k] - p[0]) * dx + (Y[k] - p[1]) * dy) / len2 : 0;
      found.push({ seg: s, k, t });
    }
    found.sort((u, v) => (u.t - v.t) || (u.k - v.k));
    for (const f of found) out.push(f);
  }
  return out;
}

/** Parallel edges on one unordered pair fan out, one via point each, in edge order. */
export function fanParallel(input, X, Y) {
  const bundles = new Map();
  input.edges.forEach(([a, b, e], ei) => {
    if (a === b || !hasId(e) || authoredVia(e) || e.route === 'orthogonal') return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!bundles.has(key)) bundles.set(key, []);
    bundles.get(key).push(ei);
  });
  const out = {};
  for (const list of bundles.values()) {
    if (list.length < 2) continue;
    const [a0, b0] = input.edges[list[0]];
    const lo = a0 < b0 ? a0 : b0; const hi = a0 < b0 ? b0 : a0;
    const dx = X[hi] - X[lo]; const dy = Y[hi] - Y[lo]; const len = Math.sqrt(dx * dx + dy * dy);
    const nx = len > 0 ? -dy / len : 0; const ny = len > 0 ? dx / len : 1;
    const mx = (X[lo] + X[hi]) / 2; const my = (Y[lo] + Y[hi]) / 2;
    list.forEach((ei, i) => {
      const [a, b, e] = input.edges[ei];
      const off = (i - (list.length - 1) / 2) * ROUTE.fan_step_px;
      out[e.id] = [[X[a], Y[a]], [mx + nx * off, my + ny * off], [X[b], Y[b]]];
    });
  }
  return out;
}

function sideCounts(input, X, Y, p, q, a, b, k, band) {
  const dx = q[0] - p[0]; const dy = q[1] - p[1]; const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  let plus = 0; let minus = 0;
  if (len === 0) return { plus, minus };
  for (let j = 0; j < input.nodes.length; j += 1) {
    if (j === a || j === b || j === k) continue;
    const t = ((X[j] - p[0]) * dx + (Y[j] - p[1]) * dy) / len2;
    if (t < 0 || t > 1) continue;
    const off = ((X[j] - p[0]) * -dy + (Y[j] - p[1]) * dx) / len;
    if (off > 0 && off < band) plus += 1; else if (off < 0 && off > -band) minus += 1;
  }
  return { plus, minus };
}

function inside(frame, v) {
  return v[0] >= frame.x0 && v[0] <= frame.x0 + frame.w && v[1] >= frame.y0 && v[1] <= frame.y0 + frame.h;
}

/** Bend auto edges around the nodes they pass through: one via point per blocking node, at most maxVia, else the chord stays. */
export function routeAround(input, X, Y, { maxVia = ROUTE.max_via, start = null } = {}) {
  const g = glyphShapes(input);
  const grid = nodeGrid(input, X, Y, g);
  const out = {};
  const used = new Map();
  // Every edge's end segments by node: a detour whose first or last segment runs along another edge's is nudged off it below.
  const ends = new Map();
  const touch = (ei, poly, a, b) => {
    for (const [k, p, q] of [[a, poly[0], poly[1]], [b, poly[poly.length - 2], poly[poly.length - 1]]]) { if (!ends.has(k)) ends.set(k, []); ends.get(k).push([ei, p, q]); }
  };
  const clash = (ei, poly, a, b) => (ends.get(a) ?? []).some(([o, p, q]) => o !== ei && segmentsOverlap(poly[0], poly[1], p, q))
    || (ends.get(b) ?? []).some(([o, p, q]) => o !== ei && segmentsOverlap(poly[poly.length - 2], poly[poly.length - 1], p, q));
  const detours = [];
  input.edges.forEach(([a, b, e], ei) => {
    if (a === b) return;
    const begin = start && Array.isArray(start[e.id]) ? start[e.id] : routePoints(e, [X[a], Y[a]], [X[b], Y[b]]);
    if (!hasId(e) || authoredVia(e) || !isAuto(e)) { touch(ei, begin, a, b); return; }
    const poly = begin.map((p) => [p[0], p[1]]);
    let hit = blockers(input, X, Y, poly, a, b, g, grid);
    if (!hit.length) { touch(ei, poly, a, b); return; }
    for (let k = 0; k < maxVia && hit.length; k += 1) {
      const { seg, k: node } = hit[0];
      const p = poly[seg - 1]; const q = poly[seg];
      const dx = q[0] - p[0]; const dy = q[1] - p[1]; const len = Math.sqrt(dx * dx + dy * dy);
      const nx = len > 0 ? -dy / len : 0; const ny = len > 0 ? dx / len : 1;
      const clear = g.hx[node] + ROUTE.around_px;
      const canon = ny > 0 || (ny === 0 && nx > 0) ? 1 : -1;
      const lane = (side) => used.get(`${node}|${side * canon}`) ?? 0;
      const offK = (X[node] - p[0]) * nx + (Y[node] - p[1]) * ny;
      const counts = sideCounts(input, X, Y, p, q, a, b, node, 2 * clear + input.frame.spacing);
      const s = counts.plus < counts.minus ? 1 : (counts.minus < counts.plus ? -1 : (offK > 0 ? -1 : 1));
      // One-step lookahead: the preferred side unless the other leaves fewer blockers or the preferred via leaves the frame.
      let best = null;
      for (const side of [s, -s]) {
        const off = clear + lane(side) * ROUTE.fan_step_px;
        const via = [X[node] + side * nx * off, Y[node] + side * ny * off];
        const next = [...poly.slice(0, seg), via, ...poly.slice(seg)];
        const left = blockers(input, X, Y, next, a, b, g, grid);
        const score = left.length * 2 + (inside(input.frame, via) ? 0 : 1);
        if (best === null || score < best.score) best = { next, left, score, side };
        if (score === 0) break;
      }
      used.set(`${node}|${best.side * canon}`, lane(best.side) + 1);
      poly.splice(0, poly.length, ...best.next);
      hit = best.left;
    }
    if (hit.length) { touch(ei, begin, a, b); return; }
    out[e.id] = poly;
    touch(ei, poly, a, b);
    detours.push([ei, a, b, e]);
  });
  for (const [ei, a, b, e] of detours) {
    const poly = out[e.id];
    if (!clash(ei, poly, a, b)) continue;
    for (const k of [1, -1, 2, -2, 3, -3]) {
      const nudged = nudge(poly, k * ROUTE.fan_step_px / 2);
      if (clash(ei, nudged, a, b) || blockers(input, X, Y, nudged, a, b, g, grid).length) continue;
      for (const k2 of [a, b]) for (const seg of ends.get(k2)) if (seg[0] === ei) { seg[1] = k2 === a ? nudged[0] : nudged[nudged.length - 2]; seg[2] = k2 === a ? nudged[1] : nudged[nudged.length - 1]; }
      out[e.id] = nudged;
      break;
    }
  }
  return out;
}

/** Every via point moved `by` px along the normal of the chord: the shape kept, off the line it shared. */
function nudge(poly, by) {
  const a = poly[0]; const b = poly[poly.length - 1];
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const len = Math.sqrt(dx * dx + dy * dy);
  const nx = len > 0 ? -dy / len : 0; const ny = len > 0 ? dx / len : 1;
  return poly.map((p, i) => (i === 0 || i === poly.length - 1 ? [p[0], p[1]] : [p[0] + nx * by, p[1] + ny * by]));
}

/** Orthogonal grid edges whose Z route crosses a node: out of the source row to a row channel, along to a column channel, then in. */
export function routePlanGrid(input, X, Y) {
  const { frame, nodes, pinned } = input;
  if (!nodes.length) return {};
  const { cells, rows, cols } = gridCells(input);
  const cellW = (frame.w - 2 * frame.padding) / cols; const cellH = (frame.h - 2 * frame.padding) / rows;
  const left = frame.x0 + frame.padding; const top = frame.y0 + frame.padding;
  const g = glyphShapes(input);
  const grid = nodeGrid(input, X, Y, g);
  const todo = [];
  input.edges.forEach(([a, b, e]) => {
    if (a === b || !hasId(e) || authoredVia(e) || e.route !== 'orthogonal' || pinned.has(a) || pinned.has(b)) return;
    if (blockers(input, X, Y, routePoints(e, [X[a], Y[a]], [X[b], Y[b]]), a, b, g, grid).length) todo.push([a, b, e]);
  });
  const out = {};
  todo.forEach(([a, b, e], k) => {
    const shift = (k + 1) * ROUTE.grid_track_px;
    const [ra, ca] = cells[a]; const [rb, cb] = cells[b];
    const down = rb > ra || (rb === ra);
    const ya = top + (down ? ra + 1 : ra) * cellH + shift;
    const yb = rb === ra ? ya : top + (down ? rb : rb + 1) * cellH + shift;
    const xc = (cb > ca ? left + cb * cellW : left + (cb + 1) * cellW) + shift;
    const poly = rb === ra ? [[X[a], Y[a]], [X[a], ya], [X[b], ya], [X[b], Y[b]]]
      : [[X[a], Y[a]], [X[a], ya], [xc, ya], [xc, yb], [X[b], yb], [X[b], Y[b]]];
    const clean = poly.filter((p, i) => i === 0 || p[0] !== poly[i - 1][0] || p[1] !== poly[i - 1][1]);
    if (blockers(input, X, Y, clean, a, b, g, grid).length < blockers(input, X, Y, routePoints(e, [X[a], Y[a]], [X[b], Y[b]]), a, b, g, grid).length) out[e.id] = clean;
  });
  return out;
}

/** Bend auto chords whose labels collide so every edge label sits clear of glyphs, measured node labels and earlier edge labels. */
export function separateEdgeLabels(input, X, Y, routes = {}, sides = null) {
  const { nodes, radii, shapes, measured } = input;
  const style = input.style ?? labelStyle();
  const g = glyphShapes(input);
  const grid = nodeGrid(input, X, Y, g);
  const out = { ...routes };
  const nodeLabels = [];
  nodes.forEach((nd, i) => {
    const labelled = typeof nd.label === 'string' && nd.label.length > 0;
    if (labelled && !(measured && measured.has(i))) return;
    const p = [X[i], Y[i]]; const side = sides && sides.has(i) ? sides.get(i) : labelAnchor(nd, shapes);
    if (labelled) nodeLabels.push(labelBox(nd, p, radii[i], style, shapes, side));
    const sub = sublabelBox(nd, p, radii[i], style, shapes, side);
    if (sub) nodeLabels.push(sub);
    nodeLabels.push(...pinBoxes(nd, p, radii[i], style, input.pinLabel));
  });
  const placed = [];
  const clear = (box) => {
    for (let k = 0; k < nodes.length; k += 1) if (glyphHitsBox(g, k, X, Y, radii, box)) return false;
    for (const b of nodeLabels) if (boxesOverlap(box, b)) return false;
    for (const b of placed) if (boxesOverlap(box, b)) return false;
    return true;
  };
  const step = EDGE_LABEL_SIZE * LABEL_LINE_HEIGHT + LABEL_GAP_PX;
  input.edges.forEach(([a, b, e]) => {
    if (typeof e.label !== 'string' || !e.label.length) return;
    const base = Array.isArray(out[e.id]) ? out[e.id] : routePoints(e, [X[a], Y[a]], [X[b], Y[b]]);
    const box = edgeLabelBox(e, base, style);
    if (clear(box) || a === b || !hasId(e) || authoredVia(e) || !isAuto(e) || base.length !== 2) { placed.push(box); return; }
    const p = base[0]; const q = base[1];
    const dx = q[0] - p[0]; const dy = q[1] - p[1]; const len = Math.sqrt(dx * dx + dy * dy);
    const nx = len > 0 ? -dy / len : 0; const ny = len > 0 ? dx / len : 1;
    const mx = (p[0] + q[0]) / 2; const my = (p[1] + q[1]) / 2;
    for (const k of [1, -1, 2, -2, 3, -3, 4, -4]) {
      const poly = [[p[0], p[1]], [mx + nx * k * step, my + ny * k * step], [q[0], q[1]]];
      const cand = edgeLabelBox(e, poly, style);
      if (!clear(cand) || blockers(input, X, Y, poly, a, b, g, grid).length) continue;
      out[e.id] = poly; placed.push(cand); return;
    }
    placed.push(box);
  });
  return out;
}

/** The sparse routes pass for the modes that do not route themselves: fans, grid channels (grid only), detours around nodes. */
export function routePass(input, X, Y) {
  const fan = fanParallel(input, X, Y);
  const grid = input.mode2d === 'grid' ? routePlanGrid(input, X, Y) : {};
  return { ...fan, ...grid, ...routeAround(input, X, Y, { start: fan }) };
}

/** The ids of every id'd edge, and of those whose ends resolve to nodes (the ones a routed mode must key). */
export function routableEdgeIds(scene) {
  const s = scene !== null && typeof scene === 'object' ? scene : {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)) : []);
  const nodeIds = new Set(list(s.nodes).map((n) => n.id).filter((id) => typeof id === 'string'));
  const all = new Set(); const routable = [];
  for (const e of list(s.edges)) {
    if (typeof e.id !== 'string' || !e.id) continue;
    all.add(e.id);
    if (nodeIds.has(e.from) && nodeIds.has(e.to)) routable.push(e.id);
  }
  return { all, routable };
}
