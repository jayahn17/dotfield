// Layered layout (V2_PLAN §3 B; archify architecture / dataflow / org tree):
// cycle removal by DFS back-edge reversal in node order, longest-path
// layering plus one promotion pass, dummy vertices for edges spanning more
// than one layer, zone bands and barycenter ordering (layered-order.mjs),
// priority-method coordinates under the axis-aware box model, ports spread
// over the glyph, and orthogonal channel routes (channels.mjs). Returns the
// v2 mode contract: dense routes for every id'd edge (chord included),
// id-less edges refused into plan.skipped, never chorded. Pure; + - * /
// sqrt only; index-ordered sums; input.style ?? labelStyle() so the
// theme-aware style layout-core adds flows in without a change here.
//
//   layeredLayout(input, {direction}) -> {points, routes, plan, viewBox}   (input shape: index.mjs prepare())
//   layeredPlan(input, {initial, finals}) -> {reversed, skipped, layers, dummies, ...} the DAG, its layers and dummy chains
//   portsOf(input, positions, plan, {direction}) -> {[edgeIndex]: {exit, entry, exitSide, entrySide}}
//   boxModel(input, plan, direction, style) -> {uLo, uHi, vLo, vHi, labelH} the axis-aware box of every vertex
//   directionOf(input, fallback)      -> views.2d.direction when valid, else the fallback
import { LABEL_GAP_PX, LABEL_LINE_HEIGHT, labelBox, labelStyle, labelWidth, pinBoxes, sublabelBox } from './metrics.mjs';
import { roundTo } from './frame.mjs';
import { routePoints } from './geometry.mjs';
import { DIRECTIONS, EDGE_LABEL_SIZE, LOOP_HALF_PX, LOOP_PX, SIDES, TRACK_PITCH_PX, assignBands, assignCoordinates, axesOf, extentOf, orderLayers, skipName } from './layered-order.mjs';
import { routeChannels } from './channels.mjs';

export const PORT_PITCH_PX = 8;
const OPPOSITE = Object.freeze({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' });
const EDGE_LABEL_H = EDGE_LABEL_SIZE * LABEL_LINE_HEIGHT + LABEL_GAP_PX;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function labelled(e) { return typeof e.label === 'string' && e.label.length > 0; }

/** Screen-space offsets of the box a node occupies: glyph extent, label box, sublabel and evidence pins, and the self loop (plus its label) when it has one. */
export function nodeBox(node, r, style, shapes, { loopA = -1, loopLabelW = 0, pinLabel = null } = {}) {
  const [hx, hy] = extentOf(node, r, shapes);
  const box = { left: -hx, right: hx, top: -hy, bottom: hy };
  const grow = (lb) => { if (lb.x < box.left) box.left = lb.x; if (lb.x + lb.w > box.right) box.right = lb.x + lb.w; if (lb.y < box.top) box.top = lb.y; if (lb.y + lb.h > box.bottom) box.bottom = lb.y + lb.h; };
  if (labelled(node)) grow(labelBox(node, [0, 0], r, style, shapes));
  const sub = sublabelBox(node, [0, 0], r, style, shapes);
  if (sub) grow(sub);
  for (const pin of pinBoxes(node, [0, 0], r, style, pinLabel)) grow(pin);
  const lh = loopLabelW ? EDGE_LABEL_H : 0;
  if (loopA === 0) grow({ x: 0, y: -LOOP_HALF_PX - lh, w: hx + LOOP_PX + loopLabelW / 2, h: 2 * LOOP_HALF_PX + lh });
  else if (loopA === 1) grow({ x: -Math.max(LOOP_HALF_PX, loopLabelW / 2), y: -hy - LOOP_PX - lh, w: 2 * Math.max(LOOP_HALF_PX, loopLabelW / 2), h: LOOP_PX });
  return box;
}

/** Per-vertex box extents along the in-layer axis (u) and the layer axis (v, canonical: layers advance toward +v); dummies are points. */
export function boxModel(input, plan, direction, style = input.style ?? labelStyle()) {
  const { A, sign } = axesOf(direction);
  const m = plan.vertexCount; const n = input.nodes.length;
  const uLo = new Float64Array(m); const uHi = new Float64Array(m); const vLo = new Float64Array(m); const vHi = new Float64Array(m);
  const loops = new Map();
  for (const ei of plan.loops) { const [i, , e] = input.edges[ei]; const w = labelled(e) ? labelWidth(e.label, { ...style, size: EDGE_LABEL_SIZE }) : 0; if (!loops.has(i) || w > loops.get(i)) loops.set(i, w); }
  for (let i = 0; i < n; i += 1) {
    const b = nodeBox(input.nodes[i], input.radii[i], style, input.shapes, loops.has(i) ? { loopA: A, loopLabelW: loops.get(i), pinLabel: input.pinLabel } : { pinLabel: input.pinLabel });
    const u = A === 0 ? [b.left, b.right] : [b.top, b.bottom];
    const v = A === 0 ? [b.top, b.bottom] : [b.left, b.right];
    uLo[i] = u[0]; uHi[i] = u[1];
    vLo[i] = sign > 0 ? v[0] : -v[1]; vHi[i] = sign > 0 ? v[1] : -v[0];
  }
  return { uLo, uHi, vLo, vHi, labelH: (style && style.size > 0 ? style.size : 12) * LABEL_LINE_HEIGHT };
}

/** The layer direction a scene authors (views.2d.direction), else the mode's default. */
export function directionOf(input, fallback = 'down') {
  const s = isObject(input) && isObject(input.scene) ? input.scene : {};
  const v2 = isObject(s.views) && isObject(s.views['2d']) ? s.views['2d'] : {};
  return DIRECTIONS.includes(v2.direction) ? v2.direction : fallback;
}

/**
 * The plan: id-less edges skipped, self edges set aside as loops, back
 * edges reversed by a DFS in node order (lifecycle: rooted at the initial
 * states, and every edge into an initial state is a back edge), longest-path
 * layers from the sources (non-initial sources start at 1 when an initial
 * state exists), one promotion pass that pulls a node to min(successor) - 1
 * when that shortens total edge length, final sinks on the last layer, and
 * one dummy per intermediate layer of every forward edge.
 */
export function layeredPlan(input, { initial = [], finals = [] } = {}) {
  const n = input.nodes.length; const E = input.edges;
  const reversed = []; const skipped = []; const loops = []; const active = [];
  const isInit = new Uint8Array(n); for (const i of initial) if (i >= 0 && i < n) isInit[i] = 1;
  E.forEach(([a, b, e], ei) => {
    if (typeof e.id !== 'string' || !e.id) { skipped.push(skipName(input, e)); return; }
    if (a === b) loops.push(ei); else active.push(ei);
  });
  const out = Array.from({ length: n }, () => []);
  for (const ei of active) out[E[ei][0]].push(ei);
  out.forEach((l) => l.sort((p, q) => (E[p][1] - E[q][1]) || (p - q)));
  const colour = new Uint8Array(n); const rev = new Uint8Array(E.length);
  const roots = [...initial.filter((i) => i >= 0 && i < n), ...Array.from({ length: n }, (_, i) => i)];
  for (const root of roots) {
    if (colour[root]) continue;
    colour[root] = 1;
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1]; const v = top[0]; const k = top[1];
      if (k >= out[v].length) { colour[v] = 2; stack.pop(); continue; }
      top[1] = k + 1;
      const ei = out[v][k]; const w = E[ei][1];
      if (colour[w] === 1 || (isInit[w] && !isInit[v])) { rev[ei] = 1; continue; }
      if (colour[w] === 0) { colour[w] = 1; stack.push([w, 0]); }
    }
  }
  const src = (ei) => (rev[ei] ? E[ei][1] : E[ei][0]); const dst = (ei) => (rev[ei] ? E[ei][0] : E[ei][1]);
  const indeg = new Int32Array(n); const succ = Array.from({ length: n }, () => []); const pred = Array.from({ length: n }, () => []);
  for (const ei of active) { if (rev[ei]) reversed.push(E[ei][2].id); indeg[dst(ei)] += 1; succ[src(ei)].push(dst(ei)); pred[dst(ei)].push(src(ei)); }
  const layer = new Int32Array(n); const done = new Uint8Array(n); const topo = [];
  for (let i = 0; i < n; i += 1) layer[i] = initial.length && !isInit[i] ? 1 : 0;
  for (let c = 0; c < n; c += 1) {
    let v = -1;
    for (let i = 0; i < n; i += 1) if (!done[i] && indeg[i] === 0) { v = i; break; }
    if (v < 0) break;
    done[v] = 1; topo.push(v);
    for (const w of succ[v]) { indeg[w] -= 1; if (layer[v] + 1 > layer[w]) layer[w] = layer[v] + 1; }
  }
  for (let k = topo.length - 1; k >= 0; k -= 1) {
    const v = topo[k];
    if (!succ[v].length || succ[v].length <= pred[v].length) continue;
    let m = Infinity; for (const w of succ[v]) if (layer[w] < m) m = layer[w];
    if (m - 1 > layer[v]) layer[v] = m - 1;
  }
  let last = 0; for (let i = 0; i < n; i += 1) if (layer[i] > last) last = layer[i];
  for (const f of finals) if (f >= 0 && f < n && !succ[f].length) layer[f] = last;
  const layerOf = []; const sourceOf = []; const chains = {}; const segments = []; const forward = []; const back = [];
  for (let i = 0; i < n; i += 1) { layerOf.push(layer[i]); sourceOf.push(i); }
  let vertexCount = n;
  for (const ei of active) {
    const [a, b] = E[ei];
    if (rev[ei]) { back.push([ei, a, b]); continue; }
    const chain = [a];
    for (let l = layer[a] + 1; l < layer[b]; l += 1) { chain.push(vertexCount); layerOf.push(l); sourceOf.push(a); vertexCount += 1; }
    chain.push(b); chains[ei] = chain; forward.push(ei);
    for (let k = 0; k + 1 < chain.length; k += 1) segments.push([chain[k], chain[k + 1], ei]);
  }
  const layers = []; for (let l = 0; l <= last; l += 1) layers.push([]);
  for (let v = 0; v < vertexCount; v += 1) layers[layerOf[v]].push(v);
  return { reversed, skipped, layers, dummies: vertexCount - n, layerOf: Int32Array.from(layerOf), sourceOf, segments, chains, forward, back, loops, vertexCount };
}

/**
 * Ports: an edge leaves its source by the forward side of the direction and
 * enters its target by the back side (authored from_side / to_side
 * override). A node spreads its m same-side ports over the glyph diameter
 * at pitch min(8 px, 2r/(m+1)), centred, ordered by the next vertex of the
 * chain (its far endpoint when the dummy has no position), extras merged
 * into the outer two when m*pitch > 2r; every port lies on the glyph
 * within r of the centre.
 */
export function portsOf(input, positions, plan, { direction = 'down' } = {}) {
  const { A, sign } = axesOf(direction);
  const fwd = A === 0 ? (sign > 0 ? 'bottom' : 'top') : (sign > 0 ? 'right' : 'left');
  const groups = new Map(); const out = {};
  const add = (v, side, item) => { const key = `${v}|${side}`; if (!groups.has(key)) groups.set(key, { v, side, list: [] }); groups.get(key).list.push(item); };
  const edgesOf = [...plan.forward, ...plan.back.map((b) => b[0])];
  for (const ei of edgesOf) {
    const [a, b, e] = input.edges[ei];
    const chain = plan.chains[ei] || [a, b];
    const es = SIDES.includes(e.from_side) ? e.from_side : fwd; const ts = SIDES.includes(e.to_side) ? e.to_side : OPPOSITE[fwd];
    out[ei] = { exitSide: es, entrySide: ts };
    add(a, es, { ei, other: chain[1], end: b, exit: true }); add(b, ts, { ei, other: chain[chain.length - 2], end: a, exit: false });
  }
  const at = (it) => positions[it.other] ?? positions[it.end];
  for (const { v, side, list } of groups.values()) {
    const r = input.radii[v]; const [hx, hy] = extentOf(input.nodes[v], r, input.shapes);
    const tangent = side === 'left' || side === 'right' ? 1 : 0; const normal = 1 - tangent;
    const nsign = side === 'right' || side === 'bottom' ? 1 : -1;
    list.sort((p, q) => (at(p)[tangent] - at(q)[tangent]) || (p.ei - q.ei));
    const m = list.length; const pitch = Math.min(PORT_PITCH_PX, (2 * r) / (m + 1)); const maxOff = r - pitch / 2;
    list.forEach((it, k) => {
      let off = (k - (m - 1) / 2) * pitch;
      if (m * pitch > 2 * r) off = off < -maxOff ? -maxOff : (off > maxOff ? maxOff : off);
      const depth = Math.min(normal === 0 ? hx : hy, Math.sqrt(r * r - off * off));
      const p = [positions[v][0], positions[v][1]]; p[tangent] += off; p[normal] += nsign * depth;
      out[it.ei][it.exit ? 'exit' : 'entry'] = p;
    });
  }
  return out;
}

/** The edge-label extent each gap must reserve along the layer axis: label height (+ gap) for down|up, label width for right|left. */
function edgeLabelExtents(input, plan, direction, style) {
  const { A } = axesOf(direction); const ext = new Float64Array(plan.layers.length + 1);
  const es = { ...style, size: EDGE_LABEL_SIZE };
  const mark = (g, e) => { const v = A === 0 ? EDGE_LABEL_H : labelWidth(e.label, es); if (v > ext[g]) ext[g] = v; };
  for (const ei of plan.forward) { const e = input.edges[ei][2]; if (!labelled(e)) continue; const ch = plan.chains[ei]; for (let k = 1; k < ch.length; k += 1) mark(plan.layerOf[ch[k]], e); }
  for (const [ei, a, b] of plan.back) { const e = input.edges[ei][2]; if (labelled(e)) { mark(plan.layerOf[a] + 1, e); mark(plan.layerOf[b], e); } }
  return ext;
}

/** The layered layout over a prepared input; opts.initial / opts.finals / opts.mode come from lifecycle.mjs. */
export function layeredLayout(input, opts = {}) {
  const direction = DIRECTIONS.includes(opts.direction) ? opts.direction : directionOf(input, 'down');
  const mode = opts.mode === 'lifecycle' ? 'lifecycle' : 'layered';
  const style = input.style ?? labelStyle();
  const plan = layeredPlan(input, opts);
  const n = input.nodes.length; const { frame } = input; const spacing = frame.spacing;
  const planOut = (o) => ({ mode, reversed: plan.reversed, skipped: plan.skipped, layers: n ? plan.layers.length : 0, dummies: plan.dummies, crossings_before: o.crossings_before, crossings_after: o.crossings_after });
  if (!n) return { points: [], routes: {}, plan: planOut({ crossings_before: 0, crossings_after: 0 }) };
  const geom = boxModel(input, plan, direction, style);
  const bands0 = assignBands(input, plan.layers, { geom, sourceOf: plan.sourceOf, spacing });
  const ord = orderLayers(input, plan.layers, bands0, { segments: plan.segments });
  const bands = assignBands(input, ord.order, { geom, sourceOf: plan.sourceOf, spacing, blocks: bands0.blocks });
  const labelExt = edgeLabelExtents(input, plan, direction, style);
  const lay = (tracksPerGap) => {
    const c = assignCoordinates(input, ord.order, geom, { direction, spacing, bands, edgeLabelExtents: labelExt, tracksPerGap, segments: plan.segments });
    const ports = portsOf(input, c.P, plan, { direction });
    return { c, ch: routeChannels(input, c.X, c.Y, ord.order, ports, c.gaps, { direction, plan, geom, style }) };
  };
  let r = lay([]);
  if (r.ch.tracksPerGap.some((t, g) => t * TRACK_PITCH_PX > r.c.gaps[g].room + 1e-9)) r = lay(r.ch.tracksPerGap);
  const P = input.nodes.map((_, i) => [r.c.X[i], r.c.Y[i]]);
  const routes = r.ch.routes;
  const { A, B, sign } = axesOf(direction);
  const lo = [Infinity, Infinity]; const hi = [-Infinity, -Infinity];
  const extend = (p) => { for (let k = 0; k < 2; k += 1) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; } };
  P.forEach((p, i) => {
    const a = [0, 0]; const b = [0, 0];
    a[A] = p[A] + geom.uLo[i]; b[A] = p[A] + geom.uHi[i];
    a[B] = p[B] + (sign > 0 ? geom.vLo[i] : -geom.vHi[i]); b[B] = p[B] + (sign > 0 ? geom.vHi[i] : -geom.vLo[i]);
    extend(a); extend(b);
  });
  for (const poly of Object.values(routes)) for (const q of poly) extend(q);
  const origin = [frame.x0, frame.y0]; const size = [frame.w, frame.h]; const shift = [0, 0]; const box = [frame.x0, frame.y0, frame.w, frame.h];
  for (let k = 0; k < 2; k += 1) {
    const content = hi[k] - lo[k]; const inner = size[k] - 2 * frame.padding;
    shift[k] = content <= inner ? origin[k] + size[k] / 2 - (lo[k] + hi[k]) / 2 : origin[k] + frame.padding - lo[k];
    if (content > inner) box[2 + k] = content + 2 * frame.padding;
  }
  const move = (p) => [roundTo(p[0] + shift[0]), roundTo(p[1] + shift[1])];
  const points = P.map(move);
  for (const id of Object.keys(routes)) routes[id] = routes[id].map(move);
  // An authored pos pins a node where the author put it; its edges fall back to the chord (the channels assume the layer grid).
  for (const [i, q] of input.pinned) points[i] = [roundTo(q[0]), roundTo(q[1])];
  if (input.pinned.size) input.edges.forEach(([a, b, e]) => { if (typeof e.id === 'string' && e.id && a !== b && (input.pinned.has(a) || input.pinned.has(b))) routes[e.id] = routePoints(e, points[a], points[b]); });
  return { points, routes, plan: planOut(ord), viewBox: box };
}
