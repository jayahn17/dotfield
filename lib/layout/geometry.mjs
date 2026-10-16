// Plane geometry the layouts and the layout gate share: a uniform grid for
// near-pair iteration (the repulsion binning above 600 nodes and every
// pairwise check), convex hulls (group regions), point-in-polygon, point to
// segment distance, and the edge route polyline that svg draws and the gate
// measures. Every function is pure, uses + - * / and Math.sqrt only, and
// iterates in index order, so the floating-point sums it feeds are
// reproducible.
//
//   forEachNearPair(xs, ys, radius, fn)  -> fn(i, j) once per pair, i < j, within radius
//   convexHull(points)                   -> [[x, y], ...] counter-clockwise (SVG y down)
//   pointInPolygon(p, poly)              -> boolean
//   distanceToPolyline(p, poly, closed)  -> px
//   pointSegmentDistance2(px, py, ax, ay, bx, by) -> squared px
//   segmentDistance(a0, a1, b0, b1)      -> px between two segments (0 when they cross)
//   routePoints(edge, from, to)          -> [[x, y], ...] polyline of an edge from its own fields
//   edgePolyline(scene, edge, from, to)  -> scene.routes[edge.id] ?? routePoints(): the one accessor
//   pointAt(poly, t) / trim(poly, start, end) -> arc-length point / the polyline cut at both ends
//   segmentsOverlap(a0, a1, b0, b1, {minLen}) -> collinear overlap longer than minLen px
//   boxGrid(cell)                        -> a uniform bucket index: insert boxes or padded segments, query a box or a segment -> sorted ids

export const ROUTE_KINDS = Object.freeze(['auto', 'straight', 'orthogonal']);

/**
 * Bin points into cells of `radius` and call fn(i, j) for every pair of
 * indices closer than `radius` in the Chebyshev sense (the caller applies
 * the exact test). Pairs are visited once, i < j, in index order of i and a
 * fixed order of the nine neighbouring cells, so sums are reproducible.
 */
export function forEachNearPair(xs, ys, radius, fn) {
  const n = xs.length;
  if (n < 2) return;
  const cell = radius > 0 ? radius : 1;
  let minx = xs[0]; let miny = ys[0]; let maxx = xs[0]; let maxy = ys[0];
  for (let i = 1; i < n; i += 1) {
    if (xs[i] < minx) minx = xs[i];
    if (xs[i] > maxx) maxx = xs[i];
    if (ys[i] < miny) miny = ys[i];
    if (ys[i] > maxy) maxy = ys[i];
  }
  const cols = Math.floor((maxx - minx) / cell) + 1;
  const rows = Math.floor((maxy - miny) / cell) + 1;
  const buckets = new Array(cols * rows);
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = Math.floor((xs[i] - minx) / cell) + Math.floor((ys[i] - miny) / cell) * cols;
    cellOf[i] = c;
    if (buckets[c] === undefined) buckets[c] = [];
    buckets[c].push(i);
  }
  for (let i = 0; i < n; i += 1) {
    const c = cellOf[i];
    const cx = c % cols;
    const cy = (c - cx) / cols;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = cy + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cx + dx;
        if (nx < 0 || nx >= cols) continue;
        const list = buckets[nx + ny * cols];
        if (list === undefined) continue;
        for (let k = 0; k < list.length; k += 1) {
          const j = list[k];
          if (j > i) fn(i, j);
        }
      }
    }
  }
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain. Collinear points are dropped; 1 or 2 points come back as given. */
export function convexHull(points) {
  const pts = points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [p[0], p[1]])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const n = pts.length;
  if (n <= 2) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Ray casting; a point on the boundary counts as inside. */
export function pointInPolygon(p, poly) {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  const x = p[0];
  const y = p[1];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i][0]; const yi = poly[i][1];
    const xj = poly[j][0]; const yj = poly[j][1];
    if (pointSegmentDistance2(x, y, xi, yi, xj, yj) === 0) return true;
    const crosses = (yi > y) !== (yj > y);
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Squared distance from (px, py) to segment a-b; a degenerate segment is its point. */
export function pointSegmentDistance2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/** Distance from p to the nearest edge (or point) of a polyline; `closed` joins last to first. */
export function distanceToPolyline(p, poly, closed = true) {
  if (!Array.isArray(poly) || poly.length === 0) return Infinity;
  if (poly.length === 1) return Math.sqrt(pointSegmentDistance2(p[0], p[1], poly[0][0], poly[0][1], poly[0][0], poly[0][1]));
  let best = Infinity;
  const last = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < last; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d2 = pointSegmentDistance2(p[0], p[1], a[0], a[1], b[0], b[1]);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * The polyline an edge follows between two node centres (viewBox px).
 * auto and straight: the chord. orthogonal: the chord when the ends share a
 * row or a column, else a Z through the mid height (a - [ax, my] - [bx, my]
 * - b) so a grid back-edge runs between rows instead of through them.
 * Authored via[] points (absolute px) replace the middle of any route.
 */
export function routePoints(edge, from, to) {
  const a = [from[0], from[1]];
  const b = [to[0], to[1]];
  const via = edge && Array.isArray(edge.via) ? edge.via.filter((v) => Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1])).map((v) => [v[0], v[1]]) : [];
  if (via.length) return [a, ...via, b];
  if (edge && edge.route === 'orthogonal' && a[0] !== b[0] && a[1] !== b[1]) {
    const my = (a[1] + b[1]) / 2;
    return [a, [a[0], my], [b[0], my], b];
  }
  return [a, b];
}

/** Axis-aligned box overlap with a strict test (touching boxes do not overlap). */
export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Does a circle (cx, cy, r) overlap an axis-aligned box? */
export function circleBoxOverlap(cx, cy, r, box) {
  const nx = cx < box.x ? box.x : (cx > box.x + box.w ? box.x + box.w : cx);
  const ny = cy < box.y ? box.y : (cy > box.y + box.h ? box.y + box.h : cy);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function finitePoint(v) { return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]); }

/** A polyline of at least two finite points, else null. */
export function validPolyline(poly) {
  return Array.isArray(poly) && poly.length >= 2 && poly.every(finitePoint) ? poly : null;
}

/** The polyline an edge is drawn and measured along: the layout's routes[edge.id] when present, else routePoints(). */
export function edgePolyline(scene, edge, from, to) {
  const routes = scene && typeof scene === 'object' && scene.routes && typeof scene.routes === 'object' && !Array.isArray(scene.routes) ? scene.routes : null;
  const r = routes && edge && typeof edge.id === 'string' && Object.hasOwn(routes, edge.id) ? validPolyline(routes[edge.id]) : null;
  return r ? r.map((p) => [p[0], p[1]]) : routePoints(edge, from, to);
}

function segLength(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** The point at arc-length fraction t (clamped to 0..1) along a polyline. */
export function pointAt(poly, t) {
  if (!Array.isArray(poly) || poly.length === 0) return [0, 0];
  if (poly.length === 1) return [poly[0][0], poly[0][1]];
  const lens = []; let total = 0;
  for (let i = 1; i < poly.length; i += 1) { const d = segLength(poly[i - 1], poly[i]); lens.push(d); total += d; }
  let want = total * (t < 0 ? 0 : (t > 1 ? 1 : t));
  for (let i = 0; i < lens.length; i += 1) {
    if (want <= lens[i] || i === lens.length - 1) {
      const f = lens[i] > 0 ? want / lens[i] : 0;
      return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * f, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * f];
    }
    want -= lens[i];
  }
  return [poly[0][0], poly[0][1]];
}

/** A copy of the polyline with its first point moved `start` px along the first segment and its last `end` px back (only when the segment is longer than the cut + 2). */
export function trim(poly, start, end) {
  const out = poly.map((p) => [p[0], p[1]]);
  if (out.length < 2) return out;
  const cut = (a, b, by) => { const d = segLength(a, b); if (d > by + 2) { a[0] += ((b[0] - a[0]) / d) * by; a[1] += ((b[1] - a[1]) / d) * by; } };
  cut(out[0], out[1], start);
  cut(out[out.length - 1], out[out.length - 2], end);
  return out;
}

function orient(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : (v < 0 ? -1 : 0);
}

/** The distance between two segments: 0 when they cross, else the least endpoint-to-segment distance. */
export function segmentDistance(a0, a1, b0, b1) {
  const o1 = orient(a0, a1, b0); const o2 = orient(a0, a1, b1);
  const o3 = orient(b0, b1, a0); const o4 = orient(b0, b1, a1);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return 0;
  let best = pointSegmentDistance2(a0[0], a0[1], b0[0], b0[1], b1[0], b1[1]);
  const d1 = pointSegmentDistance2(a1[0], a1[1], b0[0], b0[1], b1[0], b1[1]); if (d1 < best) best = d1;
  const d2 = pointSegmentDistance2(b0[0], b0[1], a0[0], a0[1], a1[0], a1[1]); if (d2 < best) best = d2;
  const d3 = pointSegmentDistance2(b1[0], b1[1], a0[0], a0[1], a1[0], a1[1]); if (d3 < best) best = d3;
  return Math.sqrt(best);
}

/** Collinear overlap: both segments longer than minLen, the shorter on the longer one's line (within 0.01 px) and the shared run longer than minLen. Symmetric. */
export function segmentsOverlap(a0, a1, b0, b1, { minLen = 1 } = {}) {
  if (segLength(b0, b1) > segLength(a0, a1)) return segmentsOverlap(b0, b1, a0, a1, { minLen });
  const la = segLength(a0, a1); const lb = segLength(b0, b1);
  if (!(la > minLen) || !(lb > minLen)) return false;
  const ux = (a1[0] - a0[0]) / la; const uy = (a1[1] - a0[1]) / la;
  const off = (p) => (p[0] - a0[0]) * uy - (p[1] - a0[1]) * ux;
  const o0 = off(b0); const o1 = off(b1);
  if (o0 > 0.01 || o0 < -0.01 || o1 > 0.01 || o1 < -0.01) return false;
  const t0 = (b0[0] - a0[0]) * ux + (b0[1] - a0[1]) * uy;
  const t1 = (b1[0] - a0[0]) * ux + (b1[1] - a0[1]) * uy;
  const lo = t0 < t1 ? t0 : t1; const hi = t0 < t1 ? t1 : t0;
  const run = (hi < la ? hi : la) - (lo > 0 ? lo : 0);
  return run > minLen;
}

/** The axis-aligned bounds of a polyline: {minx, miny, maxx, maxy}. */
export function polylineBounds(poly) {
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  for (const q of poly) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
  return { minx, miny, maxx, maxy };
}

/**
 * A uniform bucket index for the repair passes: insert(id, box) files an
 * id under every cell its box touches, insertSegment(id, p, q, pad) under
 * the cells within pad of the segment; query(x0, y0, x1, y1) and
 * querySegment(p, q, pad) return the ids filed in the cells they touch,
 * unique and ascending (so callers iterate in index order and their sums
 * stay reproducible). A candidate list, never a test: callers still apply
 * the exact geometry.
 */
export function boxGrid(cell = 64) {
  const size = cell > 0 ? cell : 64;
  const buckets = new Map();
  const key = (cx, cy) => (cx + 1048576) * 2097152 + (cy + 1048576);
  const file = (id, k) => { const list = buckets.get(k); if (list === undefined) buckets.set(k, [id]); else if (list[list.length - 1] !== id) list.push(id); };
  const insert = (id, x0, y0, x1, y1) => {
    const c0 = Math.floor(x0 / size); const c1 = Math.floor(x1 / size); const r0 = Math.floor(y0 / size); const r1 = Math.floor(y1 / size);
    for (let cy = r0; cy <= r1; cy += 1) for (let cx = c0; cx <= c1; cx += 1) file(id, key(cx, cy));
  };
  // The cells within pad of a segment, each once: sampled every cell, each sample's cell and its ring of neighbours.
  const segmentCells = (p, q, pad) => {
    const dx = q[0] - p[0]; const dy = q[1] - p[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(len / size) + 1;
    const r = 1 + Math.ceil(pad / size);
    const cells = new Set();
    let lx = null; let ly = null;
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const cx = Math.floor((p[0] + dx * t) / size); const cy = Math.floor((p[1] + dy * t) / size);
      if (cx === lx && cy === ly) continue;
      lx = cx; ly = cy;
      for (let oy = -r; oy <= r; oy += 1) for (let ox = -r; ox <= r; ox += 1) cells.add(key(cx + ox, cy + oy));
    }
    return cells;
  };
  const insertSegment = (id, p, q, pad = 0) => { for (const k of segmentCells(p, q, pad)) file(id, k); };
  const gather = (keys) => {
    const out = new Set();
    for (const k of keys) { const list = buckets.get(k); if (list) for (const id of list) out.add(id); }
    return [...out].sort((a, b) => a - b);
  };
  const query = (x0, y0, x1, y1) => {
    const keys = [];
    const c0 = Math.floor(x0 / size); const c1 = Math.floor(x1 / size); const r0 = Math.floor(y0 / size); const r1 = Math.floor(y1 / size);
    for (let cy = r0; cy <= r1; cy += 1) for (let cx = c0; cx <= c1; cx += 1) keys.push(key(cx, cy));
    return gather(keys);
  };
  const querySegment = (p, q, pad = 0) => gather(segmentCells(p, q, pad));
  return { cell: size, insert, insertSegment, query, querySegment };
}
