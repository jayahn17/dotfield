// Layout quality metrics over the one positions table (V2_PLAN §9). Pure:
// no clock, no child process, nothing written. Definitions, stated once:
//   stress                   Σ_{i<j, connected} (α·e_ij − d_ij)² / d_ij² over the pair count, d = hop
//                            distance (BFS, undirected), e = layout distance in px, α the
//                            least-squares scale (so px and hops compare); 0 is perfect.
//   neighborhood_preservation  per node with degree ≥ 1, the share of its k = min(3, degree)
//                            nearest layout neighbours that are graph neighbours; averaged.
//   edge_uniformity          standard deviation of edge lengths over their mean (graphology's
//                            edgeUniformity); 0 when every edge is the same length.
//   crossings                edge pairs sharing no endpoint whose polylines (edgePolyline(),
//                            falling back to routePoints()) properly intersect.
//   overlap_pairs, label_collisions, route_through_node, containment_violations
//                            the same tests lib/gates/layout.mjs runs, as counts (label
//                            collisions: every drawn label, sublabel, pin, edge label, badge
//                            and region label, in the scene's theme, from lib/layout/drawn.mjs).
//   viewbox_area_ratio       current viewBox area over the 2026-10-07 box (v1 default when none).
//
//   layoutMetrics(scene, { positions, shapes, tokensCss, theme, v1ViewBox }) -> {...}  (theme: else meta.theme)
//   oneEditStability(scene, ctx) -> { mean, max, applicable }   (the only caller of ctx.incremental)
//   labelLegibility(svg, { tokensCss, theme }) -> { labels, shrunk, shrunk_share }  (theme: else the SVG's data-theme)
import { layoutScene, prepare } from '../layout/index.mjs';
import * as geometry from '../layout/geometry.mjs';
import * as M from '../layout/metrics.mjs';
import { regionOf, insideRegion } from '../gates/layout.mjs';
import { groundOf, poseOf } from '../layout/metric.mjs';
import { glyphShapes } from '../layout/labels.mjs';
import { drawnItems, itemsHit, regionLabels } from '../layout/drawn.mjs';

const { boxesOverlap, forEachNearPair, routePoints, segmentDistance } = geometry;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** scene.routes[edge.id] ?? routePoints(): the accessor every reader shares once layout-core lands it. */
export function polylineOf(scene, edge, from, to) {
  if (typeof geometry.edgePolyline === 'function') return geometry.edgePolyline(scene, edge, from, to);
  const r = isObject(scene) && isObject(scene.routes) && typeof edge.id === 'string' ? scene.routes[edge.id] : null;
  return Array.isArray(r) && r.length >= 2 ? r : routePoints(edge, from, to);
}

/** views.2d.label_budget ?? (n <= 300 ? n : 300), through metrics.mjs when it exports the rule. */
export function labelBudget(scene, n) {
  if (typeof M.labelBudgetOf === 'function') return M.labelBudgetOf(scene, n);
  const v2 = isObject(scene) && isObject(scene.views) && isObject(scene.views['2d']) ? scene.views['2d'] : {};
  return Number.isInteger(v2.label_budget) && v2.label_budget >= 0 ? v2.label_budget : (n <= 300 ? n : 300);
}

/** The 2026-10-07 defaultViewBox(n, spacing): frozen here so growth in lib/layout shows as a ratio above 1. */
export function viewBoxV1(n, spacing) {
  const area = Math.max(1600 * 1000, n * spacing * spacing * 2.2);
  const w = Math.ceil(Math.sqrt(area * 1.6) / 10) * 10;
  return [0, 0, w, Math.ceil(w / 1.6 / 10) * 10];
}

function adjacency(input) {
  const n = input.nodes.length;
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of input.edges) if (a !== b) { adj[a].push(b); adj[b].push(a); }
  return adj;
}

function stressOf(adj, X, Y) {
  const n = adj.length;
  if (n < 2) return 0;
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  let num = 0; let den = 0; let pairs = 0;
  const e = [];
  for (let s = 0; s < n; s += 1) {
    dist.fill(-1); dist[s] = 0; queue[0] = s;
    let head = 0; let tail = 1;
    while (head < tail) {
      const u = queue[head]; head += 1;
      for (const v of adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; queue[tail] = v; tail += 1; }
    }
    for (let t = s + 1; t < n; t += 1) {
      const d = dist[t];
      if (d <= 0) continue;
      const dx = X[t] - X[s]; const dy = Y[t] - Y[s];
      const len = Math.sqrt(dx * dx + dy * dy);
      e.push([len, d]);
      num += len / d; den += (len * len) / (d * d); pairs += 1;
    }
  }
  if (!pairs || den === 0) return 0;
  const alpha = num / den;
  let sum = 0;
  for (const [len, d] of e) { const r = (alpha * len - d) / d; sum += r * r; }
  return sum / pairs;
}

function neighborhoodPreservation(adj, X, Y, k = 3) {
  const n = adj.length;
  let sum = 0; let counted = 0;
  for (let i = 0; i < n; i += 1) {
    const deg = adj[i].length;
    if (!deg) continue;
    const kk = Math.min(k, deg);
    const bestD = new Array(kk).fill(Infinity); const bestJ = new Array(kk).fill(-1);
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const dx = X[j] - X[i]; const dy = Y[j] - Y[i];
      const d2 = dx * dx + dy * dy;
      let slot = kk;
      while (slot > 0 && (d2 < bestD[slot - 1] || (d2 === bestD[slot - 1] && j < bestJ[slot - 1]))) slot -= 1;
      if (slot === kk) continue;
      for (let s = kk - 1; s > slot; s -= 1) { bestD[s] = bestD[s - 1]; bestJ[s] = bestJ[s - 1]; }
      bestD[slot] = d2; bestJ[slot] = j;
    }
    const nb = new Set(adj[i]);
    let hit = 0;
    for (const j of bestJ) if (nb.has(j)) hit += 1;
    sum += hit / kk; counted += 1;
  }
  return counted ? sum / counted : 0;
}

function edgeUniformity(input, X, Y) {
  const lens = [];
  for (const [a, b] of input.edges) if (a !== b) lens.push(Math.sqrt((X[b] - X[a]) ** 2 + (Y[b] - Y[a]) ** 2));
  if (lens.length < 2) return 0;
  const mean = lens.reduce((s, v) => s + v, 0) / lens.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(lens.reduce((s, v) => s + (v - mean) ** 2, 0) / lens.length);
  return sd / mean;
}

const orient = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
function properCross(p, q, r, s) {
  const o1 = orient(p[0], p[1], q[0], q[1], r[0], r[1]); const o2 = orient(p[0], p[1], q[0], q[1], s[0], s[1]);
  const o3 = orient(r[0], r[1], s[0], s[1], p[0], p[1]); const o4 = orient(r[0], r[1], s[0], s[1], q[0], q[1]);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function crossingsOf(scene, input, X, Y) {
  const segs = [];
  input.edges.forEach(([a, b, e], ei) => {
    if (a === b) return;
    const poly = polylineOf(scene, e, [X[a], Y[a]], [X[b], Y[b]]);
    for (let i = 1; i < poly.length; i += 1) segs.push({ ei, a, b, p: poly[i - 1], q: poly[i] });
  });
  const crossed = new Set();
  for (let i = 0; i < segs.length; i += 1) {
    const s1 = segs[i];
    for (let j = i + 1; j < segs.length; j += 1) {
      const s2 = segs[j];
      if (s1.ei === s2.ei || s1.a === s2.a || s1.a === s2.b || s1.b === s2.a || s1.b === s2.b) continue;
      if (properCross(s1.p, s1.q, s2.p, s2.q)) crossed.add(`${s1.ei}:${s2.ei}`);
    }
  }
  return crossed.size;
}

// Overlap, label and route-through counts use the gate's glyph model (lib/gates/layout.mjs):
// pills are capsules ([1.3 r, 0.6 r] half extents), labels sit on their written side.
function glyphGap(g, i, j, X, Y) {
  const ci = g.hx[i] - g.hy[i]; const cj = g.hx[j] - g.hy[j];
  if (ci <= 0 && cj <= 0) { const dx = X[j] - X[i]; const dy = Y[j] - Y[i]; return Math.sqrt(dx * dx + dy * dy); }
  return segmentDistance([X[i] - ci, Y[i]], [X[i] + ci, Y[i]], [X[j] - cj, Y[j]], [X[j] + cj, Y[j]]);
}

function reachOf(g) {
  let reach = 0;
  for (let i = 0; i < g.hx.length; i += 1) if (g.hx[i] > reach) reach = g.hx[i];
  return reach;
}

function overlapsOf(input, X, Y) {
  const g = glyphShapes(input);
  let count = 0;
  forEachNearPair(X, Y, 2 * reachOf(g) + 1, (i, j) => {
    if (glyphGap(g, i, j, X, Y) < g.hy[i] + g.hy[j]) count += 1;
  });
  return count;
}

/** Collisions among everything drawn beside the glyphs, exactly as the layout gate pairs them (lib/layout/drawn.mjs), in the scene's theme (input.style). */
function labelsOf(scene, input, X, Y) {
  const { nodes, radii } = input;
  const g = glyphShapes(input);
  const labelled = nodes.filter((n) => typeof n.label === 'string' && n.label.length).length;
  const items = drawnItems(scene, input, X, Y, g);
  regionLabels(input, X, Y, g, items).forEach((lab, gi) => { if (lab) items.push({ kind: 'region', i: nodes.length + gi, ...lab.box }); });
  items.sort((a, b) => (a.x - b.x) || (a.y - b.y) || (a.i - b.i) || (a.kind < b.kind ? -1 : (a.kind > b.kind ? 1 : 0)) || ((a.k ?? 0) - (b.k ?? 0)));
  let collisions = 0;
  for (let a = 0; a < items.length; a += 1) {
    const A = items[a];
    for (let b = a + 1; b < items.length && items[b].x < A.x + A.w; b += 1) {
      const B = items[b];
      if (A.i === B.i || (A.kind === 'glyph' && B.kind === 'glyph')) continue;
      if (itemsHit(A, B, g, X, Y, radii)) collisions += 1;
    }
  }
  return { collisions, measured: input.measured.size, total: labelled };
}

function routeThroughOf(scene, input, X, Y) {
  const { nodes, edges } = input;
  const g = glyphShapes(input);
  const reach = reachOf(g);
  let count = 0;
  for (const [a, b, e] of edges) {
    const poly = polylineOf(scene, e, [X[a], Y[a]], [X[b], Y[b]]);
    if (a === b && poly.length <= 2) continue;
    let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
    for (const q of poly) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    for (let k = 0; k < nodes.length; k += 1) {
      if (k === a || k === b || X[k] < minx - reach || X[k] > maxx + reach || Y[k] < miny - reach || Y[k] > maxy + reach) continue;
      const c = g.hx[k] - g.hy[k] > 0 ? g.hx[k] - g.hy[k] : 0;
      const need = g.hy[k] + M.GLYPH_GAP_PX / 2;
      let d = Infinity;
      for (let t = 1; t < poly.length && d >= need; t += 1) { const v = segmentDistance([X[k] - c, Y[k]], [X[k] + c, Y[k]], poly[t - 1], poly[t]); if (v < d) d = v; }
      if (d < need) count += 1;
    }
  }
  return count;
}

function containmentOf(scene, input, X, Y) {
  const { nodes, groups, memberOf, radii, upAxis } = input;
  let count = 0;
  if (scene.kind === 'room') {
    groups.forEach((g, gi) => {
      if (!vec3(g.center_xyz_m) || !vec3(g.size_xyz_m)) return;
      const c = groundOf(g.center_xyz_m, upAxis);
      const half = upAxis === 'z' ? [g.size_xyz_m[0] / 2, g.size_xyz_m[1] / 2] : [g.size_xyz_m[0] / 2, g.size_xyz_m[2] / 2];
      nodes.forEach((n, i) => {
        const xyz = memberOf[i] === gi ? poseOf(n) : null;
        if (!xyz) return;
        const q = groundOf(xyz, upAxis);
        if (Math.abs(q[0] - c[0]) > half[0] || Math.abs(q[1] - c[1]) > half[1]) count += 1;
      });
    });
    return count;
  }
  groups.forEach((g, gi) => {
    const pts = []; const rs = [];
    nodes.forEach((n, i) => { if (memberOf[i] === gi) { pts.push([X[i], Y[i]]); rs.push(radii[i]); } });
    if (!pts.length) return;
    const region = regionOf(pts, rs);
    nodes.forEach((n, i) => { if (memberOf[i] !== gi && insideRegion([X[i], Y[i]], region)) count += 1; });
  });
  return count;
}

/** Every metric over a scene's positions (scene.positions by default, else the frame centre per node). */
export function layoutMetrics(scene, { positions = scene && scene.positions, shapes, tokensCss, theme, v1ViewBox = null } = {}) {
  const s = isObject(scene) ? scene : {};
  const input = prepare(s, { shapes, tokensCss, theme });
  const n = input.nodes.length;
  const X = new Float64Array(n); const Y = new Float64Array(n);
  const table = isObject(positions) ? positions : {};
  input.nodes.forEach((node, i) => {
    const p = table[node.id];
    const ok = Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    X[i] = ok ? p[0] : input.frame.cx; Y[i] = ok ? p[1] : input.frame.cy;
  });
  const adj = adjacency(input);
  const labels = labelsOf(s, input, X, Y);
  const v1 = Array.isArray(v1ViewBox) && v1ViewBox.length === 4 ? v1ViewBox : viewBoxV1(n, input.frame.spacing);
  return {
    nodes: n, edges: input.edges.length,
    stress: r3(stressOf(adj, X, Y)),
    neighborhood_preservation: r3(neighborhoodPreservation(adj, X, Y, 3)),
    edge_uniformity: r3(edgeUniformity(input, X, Y)),
    crossings: crossingsOf(s, input, X, Y),
    label_collisions: labels.collisions, labels_measured: labels.measured, labels_total: labels.total,
    route_through_node: routeThroughOf(s, input, X, Y),
    overlap_pairs: overlapsOf(input, X, Y),
    containment_violations: containmentOf(s, input, X, Y),
    viewbox_area_ratio: r3((input.frame.w * input.frame.h) / (v1[2] * v1[3])),
  };
}

/** Add one leaf to the max-degree node, re-lay out warm (ctx.incremental) and measure how far the existing nodes moved. */
export function oneEditStability(scene, ctx = {}) {
  const laid = layoutScene(scene, ctx);
  const nodes = isObject(laid) && Array.isArray(laid.nodes) ? laid.nodes.filter(isObject) : [];
  if (!nodes.length || laid.kind === 'room') return { mean: 0, max: 0, moved: 0, applicable: false, spacing: null };
  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of Array.isArray(laid.edges) ? laid.edges : []) { if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1); if (degree.has(e.to)) degree.set(e.to, degree.get(e.to) + 1); }
  let hub = nodes[0];
  for (const n of nodes) if (degree.get(n.id) > degree.get(hub.id)) hub = n;
  const leaf = { ...nodes[0], id: 'bench-one-edit-leaf', label: 'added leaf', weight: 0.3, tags: [], evidence_ids: [], status: 'accepted' };
  delete leaf.pos; delete leaf.pose_m; delete leaf.fields; delete leaf.boundary;
  if (typeof hub.group === 'string') leaf.group = hub.group; else delete leaf.group;
  const edited = { ...laid, nodes: [...laid.nodes, leaf], edges: [...(laid.edges ?? []), { id: 'bench-one-edit-edge', from: hub.id, to: leaf.id, kind: 'relates', directed: true, variant: 'solid', route: 'auto' }], laid_out: false };
  const relaid = layoutScene(edited, { ...ctx, incremental: true });
  const before = isObject(laid.positions) ? laid.positions : {};
  const after = isObject(relaid) && isObject(relaid.positions) ? relaid.positions : {};
  let sum = 0; let max = 0; let moved = 0;
  for (const n of nodes) {
    const a = before[n.id]; const b = after[n.id];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const d = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    sum += d; moved += 1; if (d > max) max = d;
  }
  const spacing = prepare(laid).frame.spacing;
  return { mean: r3(moved ? sum / moved : 0), max: r3(max), moved, applicable: true, spacing };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);

/** Share of <text> elements whose written textLength is narrower than the width the font table measures for them (the theme's text and display stacks tried; theme defaults to the SVG's data-theme). */
export function labelLegibility(svg, { tokensCss, theme } = {}) {
  const t = typeof theme === 'string' && theme ? theme : ((/<svg\b[^>]*\bdata-theme="([a-z][a-z0-9-]*)"/.exec(String(svg ?? '')) || [])[1] ?? 'default');
  const style = M.labelStyle({ tokensCss, theme: t });
  const stacks = [style.stack, M.fontStackFor(M.parsedTokens(tokensCss), 'display', t)];
  let labels = 0; let shrunk = 0;
  for (const m of String(svg ?? '').matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1];
    const size = Number((/font-size="([0-9.]+)"/.exec(attrs) || [])[1]);
    const written = Number((/textLength="([0-9.]+)"/.exec(attrs) || [])[1]);
    if (!Number.isFinite(size) || !Number.isFinite(written)) continue;
    labels += 1;
    const text = unescapeXml(m[2]);
    if (stacks.every((stack) => M.labelWidth(text, { ...style, stack, size }) > written + 0.01)) shrunk += 1;
  }
  return { labels, shrunk, shrunk_share: r3(labels ? shrunk / labels : 0) };
}
