// renderers/three-edges.mjs — the 3D edges: every edge is the polyline the 2D
// view draws (scene.routes[id] ?? routePoints(), the lib/layout/geometry.mjs
// edgePolyline accessor), lifted into three.js metres, and written into one
// LineSegments buffer as one segment per polyline vertex pair (not two
// vertices per edge). Lift wall: a via vertex takes z = za + (zb - za) · (arc
// length to it / total arc length) — lib/layout/lift.mjs liftPolyline,
// mirrored here and pinned by test/html-3d.test.js. Tier wall: the same
// fraction interpolates the two tier heights. Metric room: the chord between
// the two poses. A time frame truncates each edge at its phase (the 3D twin
// of the 2D dash window over pathLength="100"); a lens collapses an edge to a
// hidden end. Embedded by html.mjs under the specifier dotfield/three-edges.
//   toThree(p, frame)  routePoints(edge, a, b)  edgePolyline(scene, edge, a, b)  arcFractions(poly)
//   liftPolyline(input, poly, za, zb)  edgePath3d(mode3d, frame, poly, A, B)  pointAlong(points, fracs, f)
//   buildEdges(THREE, {scene, P, slots, index, col, scaleM}) -> {solid, dashed, list, segments, write({visible, phases}), color()}

export const TIER = Object.freeze({ base_m: 0.5, height_mult: 0.5, depth_mult: 0.25 });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const finitePoint = (v) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/** [x, y] (+ z in metres) in viewBox px -> three.js [X, Y, Z]: centred on the frame, scaled, y flipped (lib/layout/frame.mjs toThree). */
export const toThree = (p, f) => [(num(p && p[0], 0) - f.cx) * f.metres_per_px, (f.cy - num(p && p[1], 0)) * f.metres_per_px, num(p && p[2], 0)];
/** Edge key shared with lib/time and the viewer: the id, else '#<index in the object-filtered edges list>'. */
export const edgeKey = (e, i) => (typeof e.id === 'string' && e.id ? e.id : `#${i}`);
export const edgeDashed = (e) => e.variant === 'dashed' || e.variant === 'flow' || e.kind === 'share' || e.kind === 'candidate';
export const edgeToken = (e) => (e.kind === 'share' ? 'foreign' : (e.kind === 'candidate' ? 'accent-2' : 'line-strong'));

/** Mirror of lib/layout/geometry.mjs routePoints: the chord; orthogonal off-axis ends a Z through the mid height; authored via[] replaces the middle. */
export function routePoints(edge, from, to) {
  const a = [from[0], from[1]]; const b = [to[0], to[1]];
  const via = edge && Array.isArray(edge.via) ? edge.via.filter(finitePoint).map((v) => [v[0], v[1]]) : [];
  if (via.length) return [a, ...via, b];
  if (edge && edge.route === 'orthogonal' && a[0] !== b[0] && a[1] !== b[1]) { const my = (a[1] + b[1]) / 2; return [a, [a[0], my], [b[0], my], b]; }
  return [a, b];
}
/** Mirror of lib/layout/geometry.mjs edgePolyline: the layout's routes[edge.id] when it is a valid polyline, else routePoints(). */
export function edgePolyline(scene, edge, from, to) {
  const routes = isObject(scene) && isObject(scene.routes) ? scene.routes : null;
  const r = routes && edge && typeof edge.id === 'string' && Object.hasOwn(routes, edge.id) ? routes[edge.id] : null;
  return Array.isArray(r) && r.length >= 2 && r.every(finitePoint) ? r.map((p) => [p[0], p[1]]) : routePoints(edge, from, to);
}
/** Arc-length fraction of every vertex of a 2D polyline (first 0, last 1; a zero-length polyline gives 0 … 0, 1). */
export function arcFractions(pts) {
  const run = [0]; let total = 0;
  for (let i = 1; i < pts.length; i += 1) { const dx = pts[i][0] - pts[i - 1][0]; const dy = pts[i][1] - pts[i - 1][1]; total += Math.sqrt(dx * dx + dy * dy); run.push(total); }
  const last = pts.length - 1;
  return pts.map((p, i) => (total > 0 ? run[i] / total : (i === last && last > 0 ? 1 : 0)));
}
/** Mirror of lib/layout/lift.mjs liftPolyline: a 2D route in three.js metres, z interpolated by arc-length fraction between za and zb. */
export function liftPolyline(input, poly, za, zb) {
  const pts = Array.isArray(poly) ? poly.filter(finitePoint) : [];
  if (!pts.length) return [];
  const a = Number.isFinite(za) ? za : 0; const b = Number.isFinite(zb) ? zb : a; const f = arcFractions(pts);
  return pts.map((p, i) => toThree([p[0], p[1], a + (b - a) * f[i]], input.frame));
}
/** The 3D polyline of one edge and the arc fraction of each vertex: lift wall, tier wall or metric chord. A and B are the end slots ({pos}). */
export function edgePath3d(mode3d, frame, poly, A, B) {
  if (mode3d === 'metric') return { points: [A.pos.slice(), B.pos.slice()], fracs: [0, 1] };
  const pts = Array.isArray(poly) ? poly.filter(finitePoint) : [];
  if (pts.length < 2) return { points: [A.pos.slice(), B.pos.slice()], fracs: [0, 1] };
  const fracs = arcFractions(pts);
  if (mode3d === 'tier-wall') {
    const ha = A.pos[1]; const hb = B.pos[1]; const m = frame.metres_per_px;
    return { points: pts.map((p, i) => [(p[0] - frame.cx) * m, ha + (hb - ha) * fracs[i], (p[1] - frame.cy) * m * TIER.depth_mult]), fracs };
  }
  return { points: liftPolyline({ frame }, pts, A.pos[2], B.pos[2]), fracs };
}
const lerp3 = (p, q, u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
/** The point at arc fraction f (clamped to 0..1) of a lifted polyline: exactly the lift of the 2D point at that fraction. */
export function pointAlong(points, fracs, f) {
  if (!points.length) return [0, 0, 0];
  const t = f < 0 ? 0 : (f > 1 ? 1 : f);
  for (let k = 0; k < points.length - 1; k += 1) {
    const f0 = fracs[k]; const f1 = fracs[k + 1];
    if (t <= f1 || k === points.length - 2) return f1 > f0 ? lerp3(points[k], points[k + 1], Math.min(1, Math.max(0, (t - f0) / (f1 - f0)))) : points[t >= f1 ? k + 1 : k].slice();
  }
  return points[0].slice();
}

/**
 * The edge layer: two LineSegments (solid, dashed) over every edge whose
 * ends exist, each edge owning `segs` consecutive vertex pairs from `start`.
 * write({visible, phases}) draws each edge up to its phase (default 1) and
 * collapses an edge with a lens-hidden end; color() paints the token colours.
 */
export function buildEdges(THREE, { scene, P, slots, index, col, scaleM }) {
  const list = [];
  objects(isObject(scene) ? scene.edges : null).forEach((e, i) => {
    const a = index.get(e.from); const b = index.get(e.to); if (a === undefined || b === undefined) return;
    const path = edgePath3d(P.mode3d, P.frame, edgePolyline(scene, e, P.perNode2d[a], P.perNode2d[b]), slots[a], slots[b]);
    list.push({ edge: e, key: edgeKey(e, i), a, b, dashed: edgeDashed(e), token: edgeToken(e), points: path.points, fracs: path.fracs, segs: path.points.length - 1, start: 0 });
  });
  const lineAlpha = col('line-strong').alpha;
  const make = (items, dashed) => {
    let n = 0; for (const x of items) { x.start = n; n += 2 * x.segs; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const mat = dashed ? new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: Math.max(0.6, lineAlpha), dashSize: 0.025 * scaleM, gapSize: 0.015 * scaleM }) : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: Math.max(0.6, lineAlpha) });
    const ls = new THREE.LineSegments(g, mat); ls.name = dashed ? 'edges-dashed' : 'edges-solid'; ls.frustumCulled = false; ls.userData = { list: items, dashed }; return ls;
  };
  const solid = make(list.filter((x) => !x.dashed), false); const dashed = make(list.filter((x) => x.dashed), true);
  const write = ({ visible = null, phases = null } = {}) => {
    for (const ls of [solid, dashed]) {
      const arr = ls.geometry.attributes.position.array;
      for (const x of ls.userData.list) {
        const shown = !visible || (visible.has(slots[x.a].id) && visible.has(slots[x.b].id));
        const p = !shown ? 0 : (phases && phases.has(x.key) ? phases.get(x.key) : 1); const head = pointAlong(x.points, x.fracs, p);
        for (let k = 0; k < x.segs; k += 1) {
          const f0 = x.fracs[k]; const f1 = x.fracs[k + 1]; const o = (x.start + 2 * k) * 3;
          if (p >= f1) { arr.set(x.points[k], o); arr.set(x.points[k + 1], o + 3); } else if (p <= f0) { arr.set(head, o); arr.set(head, o + 3); } else { arr.set(x.points[k], o); arr.set(head, o + 3); }
        }
      }
      ls.geometry.attributes.position.needsUpdate = true; ls.geometry.computeBoundingSphere(); if (ls.userData.dashed) ls.computeLineDistances();
    }
  };
  const color = () => {
    for (const ls of [solid, dashed]) {
      const arr = ls.geometry.attributes.color.array;
      for (const x of ls.userData.list) { const c = col(x.token, 'line-strong').color; for (let v = 0; v < 2 * x.segs; v += 1) arr.set([c.r, c.g, c.b], (x.start + v) * 3); }
      ls.geometry.attributes.color.needsUpdate = true;
    }
  };
  write(); color();
  return { solid, dashed, list, segments: list.reduce((s, x) => s + x.segs, 0), write, color };
}
