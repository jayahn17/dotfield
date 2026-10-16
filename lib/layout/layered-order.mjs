// Layered ordering and coordinates (V2_PLAN §3 B): zone bands, barycenter
// sweeps with the exact O(E log V) crossing count, and priority-method
// coordinates under the axis-aware box model. Pure functions over the
// prepare() input shape plus a layeredPlan(); + - * / sqrt only, every sum
// and sort in index order, so two runs are identical on every runtime.
//
//   axesOf(direction)                 -> {A, B, sign}: A = in-layer axis (0 x, 1 y), B = layer axis, sign +1 down|right, -1 up|left
//   extentOf(node, r, shapes)         -> [halfW, halfH]; pill [1.3 r, 0.6 r], else [r, r] (layout-core's glyphExtent() pins the same)
//   assignBands(input, layers, opts)  -> {bandOf, bands, gap, blocks}: one in-layer interval per zone block, gap >= REGION_PAD_PX + rMax + GLYPH_GAP_PX
//   orderLayers(input, layers, bands, opts) -> {order, crossings_before, crossings_after}
//   countCrossings(layerA, layerB, edges)   -> exact crossings between two ordered layers (accumulator tree)
//   assignCoordinates(input, order, boxes, opts) -> {X, Y, P, U, V, gaps}: priority method in-layer, label-aware pitch along the layer axis
import { GLYPH_GAP_PX, LABEL_GAP_PX, REGION_PAD_PX } from './metrics.mjs';

export const DIRECTIONS = Object.freeze(['down', 'right', 'up', 'left']);
export const SIDES = Object.freeze(['top', 'bottom', 'left', 'right']);
/** Distance between two channel tracks in a layer gap; a gap widens when its tracks need more room than it has. */
export const TRACK_PITCH_PX = 18;
/** svg-edges draws edge labels at this size (SMALL in renderers/svg.mjs); the box model reserves it. */
export const EDGE_LABEL_SIZE = 11;
export const LAYER_PITCH_MULT = 3;
export const PILL_EXTENT = Object.freeze([1.3, 0.6]);
/** A self edge loops LOOP_PX past the glyph along the in-layer axis, LOOP_HALF_PX either side of the centre line. */
export const LOOP_PX = 40;
export const LOOP_HALF_PX = 6;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** In-layer separation between two neighbouring vertices: `spacing` when either is a node, one track pitch between two dummies. */
export function separationOf(a, b, n, spacing) {
  return a >= n && b >= n ? TRACK_PITCH_PX : spacing;
}

/** The axis frame of a direction: in-layer axis A, layer axis B, and the sign layers advance along B. */
export function axesOf(direction) {
  const A = direction === 'right' || direction === 'left' ? 1 : 0;
  return { A, B: 1 - A, sign: direction === 'up' || direction === 'left' ? -1 : 1 };
}

/** The name a mode gives an id-less edge in plan.skipped: the id the sketch expander would have minted (e<index>). */
export function skipName(input, e) {
  const list = isObject(input.scene) && Array.isArray(input.scene.edges) ? input.scene.edges : [];
  const i = list.indexOf(e);
  return `e${i < 0 ? 0 : i}`;
}

export function isPill(node, shapes) {
  if (node && node.shape === 'pill') return true;
  const row = node && shapes && isObject(shapes[node.kind]) ? shapes[node.kind] : null;
  return !!row && row.glyph2d === 'pill';
}

/** Half extents of a glyph: a pill is wider than tall, every other glyph fits its radius. */
export function extentOf(node, r, shapes) {
  return isPill(node, shapes) ? [PILL_EXTENT[0] * r, PILL_EXTENT[1] * r] : [r, r];
}

/**
 * Zone bands: every group block (and the ungrouped block, index groupCount)
 * gets one interval across the in-layer axis, ordered by its mean barycenter
 * over all layers, wide enough for its widest layer run, and separated from
 * the next by >= REGION_PAD_PX + rMax + GLYPH_GAP_PX, so a zone's padded hull
 * can hold no foreign node. Dummies take the band of their edge's source.
 * The run of a layer depends on its order (two dummies sit one track
 * apart), so the caller passes the final order and pins `blocks` from the
 * first call to keep the block order.
 */
export function assignBands(input, layers, { geom = null, sourceOf = null, spacing = input.frame.spacing, blocks: fixedBlocks = null } = {}) {
  const n = input.nodes.length; const G = input.groupCount;
  const m = geom ? geom.uLo.length : n;
  const bandOf = new Int32Array(m);
  for (let v = 0; v < m; v += 1) {
    const src = v < n ? v : (sourceOf ? sourceOf[v] : -1);
    bandOf[v] = src < 0 || input.memberOf[src] < 0 ? G : input.memberOf[src];
  }
  const sum = new Float64Array(G + 1); const cnt = new Float64Array(G + 1); const width = new Float64Array(G + 1);
  for (const layer of layers) {
    const run = new Float64Array(G + 1); const c = new Int32Array(G + 1); const prev = new Int32Array(G + 1);
    layer.forEach((v, k) => {
      const b = bandOf[v];
      sum[b] += (k + 0.5) / layer.length; cnt[b] += 1;
      run[b] += (geom ? geom.uHi[v] - geom.uLo[v] : 0) + (c[b] ? separationOf(prev[b], v, n, spacing) : 0); c[b] += 1; prev[b] = v;
    });
    for (let b = 0; b <= G; b += 1) if (run[b] > width[b]) width[b] = run[b];
  }
  const blocks = [];
  for (let b = 0; b <= G; b += 1) if (cnt[b] > 0) blocks.push(b);
  if (fixedBlocks) blocks.sort((p, q) => fixedBlocks.indexOf(p) - fixedBlocks.indexOf(q));
  else blocks.sort((p, q) => (sum[p] / cnt[p] - sum[q] / cnt[q]) || (p - q));
  let rMax = 0;
  for (let i = 0; i < n; i += 1) if (input.radii[i] > rMax) rMax = input.radii[i];
  const need = REGION_PAD_PX + rMax + GLYPH_GAP_PX;
  const gap = need > spacing ? need : spacing;
  const bands = [];
  for (let b = 0; b <= G; b += 1) bands.push([0, 0]);
  let lo = 0;
  blocks.forEach((b, k) => { if (k) lo += gap; bands[b] = [lo, lo + width[b]]; lo += width[b]; });
  return { bandOf, bands, gap, blocks };
}

/** Exact crossings between layer A (above) and layer B (below) for edges [u in A, v in B]: Barth-Jünger-Mutzel accumulator tree. */
export function countCrossings(layerA, layerB, edges) {
  const posA = new Map(); layerA.forEach((v, i) => posA.set(v, i));
  const posB = new Map(); layerB.forEach((v, i) => posB.set(v, i));
  const pairs = [];
  for (const [u, v] of edges) if (posA.has(u) && posB.has(v)) pairs.push([posA.get(u), posB.get(v)]);
  pairs.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  let first = 1;
  while (first < layerB.length) first *= 2;
  const tree = new Int32Array(2 * first - 1);
  first -= 1;
  let cross = 0;
  for (const [, b] of pairs) {
    let idx = b + first;
    tree[idx] += 1;
    while (idx > 0) {
      if (idx % 2) cross += tree[idx + 1];
      idx = (idx - 1) >> 1;
      tree[idx] += 1;
    }
  }
  return cross;
}

/**
 * Order every layer: blocks in band order, and inside a band `sweeps`
 * barycenter passes (down with upper neighbours, up with lower ones) each
 * followed by a transpose pass; the exact crossing count before and after
 * is reported and the best order seen is returned.
 */
export function orderLayers(input, layers, bands, { sweeps = 4, segments = [] } = {}) {
  const { bandOf, bands: B } = bands;
  const V = bandOf.length; const L = layers.length;
  const blockRank = new Int32Array(B.length);
  B.map((_, i) => i).sort((p, q) => (B[p][0] - B[q][0]) || (p - q)).forEach((b, k) => { blockRank[b] = k; });
  const up = Array.from({ length: V }, () => []); const down = Array.from({ length: V }, () => []);
  const gapSegs = Array.from({ length: L }, () => []);
  const layerOf = new Int32Array(V);
  layers.forEach((l, k) => l.forEach((v) => { layerOf[v] = k; }));
  for (const [s, t] of segments) { down[s].push(t); up[t].push(s); gapSegs[layerOf[t]].push([s, t]); }
  const cur = layers.map((l) => [...l].sort((p, q) => (blockRank[bandOf[p]] - blockRank[bandOf[q]]) || (p - q)));
  const rank = new Float64Array(V);
  const setRank = (k) => cur[k].forEach((v, i) => { rank[v] = i; });
  for (let k = 0; k < L; k += 1) setRank(k);
  const total = () => { let c = 0; for (let k = 1; k < L; k += 1) c += countCrossings(cur[k - 1], cur[k], gapSegs[k]); return c; };
  const sweep = (k, nbrs) => {
    const bc = new Float64Array(V);
    for (const v of cur[k]) {
      const ns = nbrs[v];
      if (!ns.length) { bc[v] = rank[v]; continue; }
      let s = 0; for (const u of ns) s += rank[u];
      bc[v] = s / ns.length;
    }
    cur[k].sort((p, q) => (blockRank[bandOf[p]] - blockRank[bandOf[q]]) || (bc[p] - bc[q]) || (rank[p] - rank[q]));
    setRank(k);
  };
  const delta = (v, w, nbrs) => {
    let before = 0; let after = 0;
    for (const a of nbrs[v]) for (const b of nbrs[w]) { if (rank[a] > rank[b]) before += 1; else if (rank[a] < rank[b]) after += 1; }
    return after - before;
  };
  const transpose = () => {
    for (let round = 0; round < 8; round += 1) {
      let improved = false;
      for (let k = 0; k < L; k += 1) {
        const layer = cur[k];
        for (let i = 0; i + 1 < layer.length; i += 1) {
          const v = layer[i]; const w = layer[i + 1];
          if (bandOf[v] !== bandOf[w] || delta(v, w, up) + delta(v, w, down) >= 0) continue;
          layer[i] = w; layer[i + 1] = v; rank[v] = i + 1; rank[w] = i; improved = true;
        }
      }
      if (!improved) return;
    }
  };
  const before = total();
  let best = before; let order = cur.map((l) => [...l]);
  for (let p = 0; p < sweeps; p += 1) {
    if (p % 2 === 0) for (let k = 1; k < L; k += 1) sweep(k, up);
    else for (let k = L - 2; k >= 0; k -= 1) sweep(k, down);
    transpose();
    const c = total();
    if (c < best) { best = c; order = cur.map((l) => [...l]); }
  }
  return { order, crossings_before: before, crossings_after: best };
}

/** Edge-label clearance each gap reserves on its two sides: above the run for down, below for up, half the width each side for right|left. */
function labelPads(A, sign, extent) {
  if (A === 1) return [extent / 2, extent / 2];
  return sign > 0 ? [extent, 0] : [0, extent];
}

/**
 * Coordinates. In-layer: the priority method (dummies first, then by degree)
 * places every vertex at the median of its neighbours in the adjacent layer,
 * clamped so boxes keep `spacing` apart and stay inside their band, in three
 * passes (down, up, down). Layer axis: the pitch between layers k-1 and k is
 * the larger of the nominal pitch (down|up: spacing*3 + labelH + edge-label
 * height; right|left: spacing*3) and what the boxes, the edge labels and the
 * channel tracks of the gap need. gaps[g] (g = 0 head, 1..L-1 between layers,
 * L tail) carries the channel zone in screen coordinates of the layer axis.
 */
export function assignCoordinates(input, order, boxes, { direction = 'down', spacing = input.frame.spacing, bands = null, edgeLabelExtents = [], tracksPerGap = [], segments = [], passes = 3 } = {}) {
  const { A, B, sign } = axesOf(direction);
  const { uLo, uHi, vLo, vHi } = boxes;
  const V = uLo.length; const L = order.length; const n = input.nodes.length;
  const bandOf = bands ? bands.bandOf : new Int32Array(V);
  const bandAt = (b) => (bands ? bands.bands[b] : [0, Infinity]);
  const up = Array.from({ length: V }, () => []); const down = Array.from({ length: V }, () => []);
  for (const [s, t] of segments) { down[s].push(t); up[t].push(s); }
  const U = new Float64Array(V);
  const place = (k, nbrs) => {
    const layer = order[k]; const m = layer.length;
    const P = new Float64Array(m); const segLo = new Float64Array(m); const segHi = new Float64Array(m);
    let start = 0;
    for (let i = 0; i < m; i += 1) {
      const v = layer[i];
      if (i === 0 || bandOf[layer[i - 1]] !== bandOf[v]) start = i;
      P[i] = i === start ? -uLo[v] : P[i - 1] + uHi[layer[i - 1]] + separationOf(layer[i - 1], v, n, spacing) - uLo[v];
      if (i === m - 1 || bandOf[layer[i + 1]] !== bandOf[v]) {
        const [lo, hi] = bandAt(bandOf[v]);
        const slack = hi - lo - (P[i] + uHi[v]);
        for (let j = start; j <= i; j += 1) { segLo[j] = lo + P[j]; segHi[j] = lo + P[j] + (slack > 0 ? slack : 0); }
      }
    }
    const prio = (v) => (v >= n ? 1e9 : (nbrs ? nbrs[v].length : 0));
    const idx = layer.map((_, i) => i).sort((a, b) => (prio(layer[b]) - prio(layer[a])) || (a - b));
    const placed = new Uint8Array(m);
    for (const i of idx) {
      const v = layer[i]; const ns = nbrs ? nbrs[v] : [];
      let target;
      if (ns.length) {
        const xs = ns.map((u) => U[u]).sort((a, b) => a - b);
        target = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
      } else target = nbrs ? U[v] : (segLo[i] + segHi[i]) / 2;
      let lo = segLo[i]; let hi = segHi[i];
      for (let j = i - 1; j >= 0 && bandOf[layer[j]] === bandOf[v]; j -= 1) if (placed[j]) { const b = U[layer[j]] + P[i] - P[j]; if (b > lo) lo = b; break; }
      for (let j = i + 1; j < m && bandOf[layer[j]] === bandOf[v]; j += 1) if (placed[j]) { const b = U[layer[j]] - (P[j] - P[i]); if (b < hi) hi = b; break; }
      U[v] = target < lo ? lo : (target > hi ? hi : target);
      placed[i] = 1;
    }
  };
  for (let k = 0; k < L; k += 1) place(k, null);
  for (let p = 0; p < passes; p += 1) {
    if (p % 2 === 0) for (let k = 1; k < L; k += 1) place(k, up);
    else for (let k = L - 2; k >= 0; k -= 1) place(k, down);
  }
  const top = new Float64Array(L); const bot = new Float64Array(L);
  order.forEach((layer, k) => { for (const v of layer) { if (-vLo[v] > top[k]) top[k] = -vLo[v]; if (vHi[v] > bot[k]) bot[k] = vHi[v]; } });
  const tracks = (g) => (tracksPerGap[g] || 0) * TRACK_PITCH_PX;
  const Vk = new Float64Array(L); const raw = [];
  const headPads = labelPads(A, sign, edgeLabelExtents[0] || 0);
  const headHi = -top[0] - LABEL_GAP_PX - headPads[1];
  raw.push({ lo: headHi - tracks(0) - headPads[0], hi: headHi, zoneLo: headHi - tracks(0), zoneHi: headHi, room: tracks(0) });
  for (let k = 1; k < L; k += 1) {
    const e = edgeLabelExtents[k] || 0; const [pl, ph] = labelPads(A, sign, e);
    const room = pl + ph + tracks(k) + 2 * LABEL_GAP_PX;
    const base = A === 0 ? spacing * LAYER_PITCH_MULT + boxes.labelH + e : spacing * LAYER_PITCH_MULT;
    const need = bot[k - 1] + room + top[k];
    Vk[k] = Vk[k - 1] + (base > need ? base : need);
    const lo = Vk[k - 1] + bot[k - 1]; const hi = Vk[k] - top[k];
    raw.push({ lo, hi, zoneLo: lo + LABEL_GAP_PX + pl, zoneHi: hi - LABEL_GAP_PX - ph, room: hi - lo - 2 * LABEL_GAP_PX - pl - ph });
  }
  const tailPads = labelPads(A, sign, edgeLabelExtents[L] || 0);
  const tailLo = Vk[L - 1] + bot[L - 1] + LABEL_GAP_PX + tailPads[0];
  raw.push({ lo: tailLo, hi: tailLo + tracks(L) + tailPads[1], zoneLo: tailLo, zoneHi: tailLo + tracks(L), room: tracks(L) });
  const gaps = raw.map((g) => (sign > 0 ? g : { lo: -g.hi, hi: -g.lo, zoneLo: -g.zoneHi, zoneHi: -g.zoneLo, room: g.room }));
  const X = new Float64Array(V); const Y = new Float64Array(V); const Vs = new Float64Array(V); const P = new Array(V);
  order.forEach((layer, k) => { for (const v of layer) { Vs[v] = sign * Vk[k]; const p = [0, 0]; p[A] = U[v]; p[B] = Vs[v]; P[v] = p; X[v] = p[0]; Y[v] = p[1]; } });
  return { X, Y, P, U, V: Vs, gaps };
}
