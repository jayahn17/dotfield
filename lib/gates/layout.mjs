// Gate "layout": the DF_LAYOUT_* family over the geometry tables. Pure over
// (scene, ctx); never throws; never mutates. A scene that is not yet laid
// out is laid out in memory (lib/layout/index.mjs) so the geometry the
// renderer will draw is what gets measured; a laid_out scene is measured as
// committed and never re-simulated, except by the determinism probe, which
// re-runs the mode twice from scratch over all four tables (positions,
// routes, labels, plan) and is the tripwire for an extension mode. What is
// measured is what is drawn: node labels on labelSide() (scene.labels, else
// the kind's anchor) in the theme's font (ctx.theme ?? meta.theme), their
// sublabels and evidence pins, edge labels in edgeLabelBox() and order
// badges on edgePolyline(), region labels where regionLabels() puts them
// (all from lib/layout/drawn.mjs, which svg.mjs draws from), routes along
// edgePolyline(), and only the labels inside views.2d.label_budget (a node
// beyond it draws label, sublabel and pins hidden). The plan is read, never
// recomputed (LAYER_CYCLE_BROKEN, VIEWBOX_GROWN). One check per code in
// catalog order: pass, or one fail per offending path, at most 200 per code
// plus one sentinel row 'further <n> <CODE> findings not listed (200 shown
// of <total>)'. Pass rows carry no detail and no metrics.
//
//   check(scene, ctx, deps?) -> check[]
//   ctx.quality   draft | checked | showcase (else meta.quality, else checked).
//                 OVERLAP blocks at checked and showcase; LABEL_CLEARANCE,
//                 ROUTE_THROUGH_NODE, EDGE_LABEL_CLEARANCE and ROUTE_OVERLAP
//                 block only at showcase.
//   ctx.tokensCss / ctx.theme / ctx.shapes  the label font + glyph table
//   deps.runner   the layout function the determinism probe runs (tests, lib/bench)
import { codesForFamily, fail, pass } from '../rules.mjs';
import { layoutScene, layoutTables, mode2dOf, prepare, routableEdgeIds, verifyDeterminism, MODES_2D, MODES_3D, ROUTED_MODES, groupToken } from '../layout/index.mjs';
import { GLYPH_GAP_PX, REGION_PAD_PX } from '../layout/metrics.mjs';
import { edgePolyline, forEachNearPair, polylineBounds, segmentDistance, segmentsOverlap, validPolyline } from '../layout/geometry.mjs';
import { glyphShapes } from '../layout/labels.mjs';
import { drawnItems, itemsHit, regionLabels, regionShapes } from '../layout/drawn.mjs';
import { bandRegionOf, groupBands, insideRegion, regionOf } from '../layout/regions.mjs';
import { directionOf } from '../layout/layered.mjs';
import { groundOf, poseOf } from '../layout/metric.mjs';

export { regionOf, insideRegion, bandRegionOf } from '../layout/regions.mjs';
export const id = 'layout';
export const QUALITIES = Object.freeze(['draft', 'checked', 'showcase']);
export const MAX_FAILS_PER_CODE = 200;
const SHOWCASE_ONLY = Object.freeze(['DF_LAYOUT_LABEL_CLEARANCE', 'DF_LAYOUT_ROUTE_THROUGH_NODE', 'DF_LAYOUT_EDGE_LABEL_CLEARANCE', 'DF_LAYOUT_ROUTE_OVERLAP']);
const SERIES_RE = /^series-[1-6]$/;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function r1(v) { return Math.round(v * 10) / 10; }
function vec3(v) { return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)); }
const nid = (input, i) => String(input.nodes[i].id);

/** The quality a gate run measures at: ctx.quality, else meta.quality, else checked. */
export function qualityOf(scene, ctx = {}) {
  if (isObject(ctx) && QUALITIES.includes(ctx.quality)) return ctx.quality;
  const meta = isObject(scene) && isObject(scene.meta) ? scene.meta : {};
  return QUALITIES.includes(meta.quality) ? meta.quality : 'checked';
}

/** Whether a code blocks at a quality (the catalog flag, lowered for draft and raised for showcase). */
export function blocksAt(code, quality) {
  if (code === 'DF_LAYOUT_OVERLAP') return quality !== 'draft';
  if (SHOWCASE_ONLY.includes(code)) return quality === 'showcase';
  return null;
}

function checkModes(s, F) {
  const views = isObject(s.views) ? s.views : {};
  const v2 = isObject(views['2d']) ? views['2d'] : {};
  const v3 = isObject(views['3d']) ? views['3d'] : {};
  const room = s.kind === 'room';
  if (v2.layout !== undefined) {
    if (!MODES_2D.includes(v2.layout)) F('DF_LAYOUT_UNKNOWN_MODE', '$.views.2d.layout', `'${String(v2.layout)}' is not a 2D mode (${MODES_2D.join(', ')})`);
    else if (room && v2.layout !== 'metric') F('DF_LAYOUT_UNKNOWN_MODE', '$.views.2d.layout', `a room scene is always metric; '${v2.layout}' does not apply`);
    else if (!room && v2.layout === 'metric') F('DF_LAYOUT_UNKNOWN_MODE', '$.views.2d.layout', `metric applies to room scenes only; a ${String(s.kind)} scene ran its default mode`);
  }
  if (v3.layout !== undefined) {
    if (!MODES_3D.includes(v3.layout)) F('DF_LAYOUT_UNKNOWN_MODE', '$.views.3d.layout', `'${String(v3.layout)}' is not a 3D mode (${MODES_3D.join(', ')})`);
    else if (room && v3.layout !== 'metric') F('DF_LAYOUT_UNKNOWN_MODE', '$.views.3d.layout', `a room scene is always metric in 3D; '${v3.layout}' does not apply`);
    else if (!room && v3.layout === 'metric') F('DF_LAYOUT_UNKNOWN_MODE', '$.views.3d.layout', `metric 3D needs pose_m, which only room scenes carry; a ${String(s.kind)} scene lifts`);
  }
}

function checkPoses(s, input, F) {
  const room = s.kind === 'room';
  input.nodes.forEach((n, i) => {
    const p = `$.nodes[${i}]`;
    if (room) {
      if (!poseOf(n)) F('DF_LAYOUT_METRIC_NO_POSE', `${p}.pose_m`, `'${String(n.id)}' has no pose_m {xyz, rpy}`);
      if (n.pos !== undefined) F('DF_LAYOUT_POSE_IGNORED', `${p}.pos`, `'${String(n.id)}' carries pos in a room scene; pose_m places it`);
    } else if (n.pose_m !== undefined) {
      F('DF_LAYOUT_POSE_IGNORED', `${p}.pose_m`, `'${String(n.id)}' carries pose_m in a ${String(s.kind)} scene; pos places it`);
    }
  });
}

/** A laid_out scene must carry what it claims: a position per node, routes complete for its mode, and table keys that name something. */
function checkPositionsTable(s, input, F) {
  if (s.laid_out !== true) return;
  const table = isObject(s.positions) ? s.positions : {};
  input.nodes.forEach((n) => {
    if (typeof n.id !== 'string') return;
    const p = table[n.id];
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) F('DF_LAYOUT_POSITION_MISSING', `$.positions.${n.id}`, `laid_out is true but '${n.id}' has no [x, y]`);
  });
  const mode = mode2dOf(s);
  if (s.routes !== undefined && !isObject(s.routes)) F('DF_LAYOUT_ROUTE_MISSING', '$.routes', 'routes is not an edge id -> polyline map');
  const routes = isObject(s.routes) ? s.routes : {};
  const { all, routable } = routableEdgeIds(s);
  for (const [key, poly] of Object.entries(routes)) {
    if (!all.has(key)) F('DF_LAYOUT_ROUTE_MISSING', `$.routes.${key}`, `routes key '${key}' names no edge`);
    else if (!validPolyline(poly)) F('DF_LAYOUT_ROUTE_MISSING', `$.routes.${key}`, `the route of '${key}' is not a polyline of two or more [x, y] points`);
  }
  if (ROUTED_MODES.includes(mode)) for (const eid of routable) if (!Object.hasOwn(routes, eid)) F('DF_LAYOUT_ROUTE_MISSING', `$.routes.${eid}`, `laid_out in ${mode} but edge '${eid}' has no route`);
  if (isObject(s.labels)) for (const key of Object.keys(s.labels)) if (!input.ids.has(key)) F('DF_LAYOUT_ROUTE_MISSING', `$.labels.${key}`, `labels key '${key}' names no node`);
}

/** Glyph to glyph: circles by centre distance, pills by their capsule cores. */
function glyphDistance(g, i, j, X, Y) {
  const ci = g.hx[i] - g.hy[i]; const cj = g.hx[j] - g.hy[j];
  if (ci <= 0 && cj <= 0) { const dx = X[j] - X[i]; const dy = Y[j] - Y[i]; return Math.sqrt(dx * dx + dy * dy); }
  return segmentDistance([X[i] - ci, Y[i]], [X[i] + ci, Y[i]], [X[j] - cj, Y[j]], [X[j] + cj, Y[j]]);
}

function checkOverlap(input, X, Y, g, F) {
  let reach = 0;
  for (let i = 0; i < g.hx.length; i += 1) if (g.hx[i] > reach) reach = g.hx[i];
  forEachNearPair(X, Y, 2 * reach + 1, (i, j) => {
    const need = g.hy[i] + g.hy[j];
    const d = glyphDistance(g, i, j, X, Y);
    if (d >= need) return;
    F('DF_LAYOUT_OVERLAP', `$.positions.${nid(input, i)}`, `'${nid(input, i)}' and '${nid(input, j)}' are ${r1(d)} px apart, glyphs need ${r1(need)}`);
  });
}

/**
 * Everything drawn as text or marks beside the glyphs, measured where the
 * renderer draws it (lib/layout/drawn.mjs): node labels within the budget,
 * their sublabels and evidence pins, edge labels, order badges, and the
 * region labels at the place regionLabels() picked. A node's own items never
 * collide with each other, nor an edge's.
 */
function checkLabels(s, input, X, Y, g, F) {
  const { nodes, radii, measured } = input;
  const items = drawnItems(s, input, X, Y, g);
  const regionText = regionLabels(input, X, Y, g, items);
  regionText.forEach((lab, gi) => { if (lab) items.push({ kind: 'region', i: nodes.length + gi, gi, text: lab.text, ...lab.box }); });
  items.sort((p, q) => (p.x - q.x) || (p.y - q.y) || (p.i - q.i) || (p.kind < q.kind ? -1 : (p.kind > q.kind ? 1 : 0)) || ((p.k ?? 0) - (q.k ?? 0)));
  const edgeName = (o) => String(o.e.id ?? -1 - o.i);
  const groupName = (o) => String(input.groups[o.gi].id);
  const what = (o) => ({
    glyph: () => `the glyph of '${nid(input, o.i)}'`, label: () => `the label of '${nid(input, o.i)}'`, sublabel: () => `the sublabel of '${nid(input, o.i)}'`,
    pin: () => `the evidence pin '${o.label}' of '${nid(input, o.i)}'`, edge: () => `the label of edge '${edgeName(o)}'`, badge: () => `the order badge of edge '${edgeName(o)}'`,
    region: () => `the region label of '${groupName(o)}'`,
  })[o.kind]();
  const rank = (o) => (o.kind === 'edge' || o.kind === 'badge' ? 2 : (o.kind === 'region' ? 1 : 0));
  for (let a = 0; a < items.length; a += 1) {
    const A = items[a];
    for (let b = a + 1; b < items.length && items[b].x < A.x + A.w; b += 1) {
      const B = items[b];
      if ((A.kind === 'glyph' && B.kind === 'glyph') || A.i === B.i) continue;
      const subject = rank(B) > rank(A) || A.kind === 'glyph' ? B : A;
      const other = subject === A ? B : A;
      if (!itemsHit(subject, other, g, X, Y, radii)) continue;
      const ei = -1 - subject.i;
      const tail = `collides with ${what(other)}`;
      if (subject.kind === 'edge') F('DF_LAYOUT_EDGE_LABEL_CLEARANCE', `$.edges[${ei}].label`, `label of edge '${edgeName(subject)}' (${r1(subject.w)} px wide) ${tail}`);
      else if (subject.kind === 'badge') F('DF_LAYOUT_EDGE_LABEL_CLEARANCE', `$.edges[${ei}].order`, `order badge of edge '${edgeName(subject)}' ${tail}`);
      else if (subject.kind === 'region') F('DF_LAYOUT_LABEL_CLEARANCE', `$.groups[${subject.gi}].label`, `region label of '${groupName(subject)}' (${r1(subject.w)} px wide) has no clear place and ${tail}`);
      else if (subject.kind === 'label') F('DF_LAYOUT_LABEL_CLEARANCE', `$.nodes[${subject.i}].label`, `label of '${nid(input, subject.i)}' (${r1(subject.w)} px wide) ${tail}`);
      else if (subject.kind === 'sublabel') F('DF_LAYOUT_LABEL_CLEARANCE', `$.nodes[${subject.i}].sublabel`, `sublabel of '${nid(input, subject.i)}' (${r1(subject.w)} px wide) ${tail}`);
      else F('DF_LAYOUT_LABEL_CLEARANCE', `$.nodes[${subject.i}].evidence_ids[${subject.k}]`, `evidence pin '${subject.label}' of '${nid(input, subject.i)}' ${tail}`);
    }
  }
  const labelled = nodes.filter((n) => typeof n.label === 'string' && n.label.length).length;
  if (labelled > measured.size) F('DF_LAYOUT_LABEL_BUDGET', '$.views.2d.label_budget', `${labelled - measured.size} of ${labelled} labels lie beyond the budget of ${input.labelBudget} and are not measured`);
}

/** Glyph k against a segment: circle by centre distance, pill by its capsule core. */
function segmentGap(g, k, X, Y, p, q) {
  const c = g.hx[k] - g.hy[k];
  return segmentDistance([X[k] - (c > 0 ? c : 0), Y[k]], [X[k] + (c > 0 ? c : 0), Y[k]], p, q);
}

function checkRoutes(s, input, X, Y, g, F) {
  const { nodes, edges } = input;
  const sceneEdges = Array.isArray(s.edges) ? s.edges : [];
  let reach = 0;
  for (let i = 0; i < g.hx.length; i += 1) if (g.hx[i] > reach) reach = g.hx[i];
  const segs = [];
  edges.forEach(([a, b, e]) => {
    const poly = edgePolyline(s, e, [X[a], Y[a]], [X[b], Y[b]]);
    const ei = sceneEdges.indexOf(e);
    if (a === b && poly.length <= 2) return;
    const bb = polylineBounds(poly);
    for (let k = 0; k < nodes.length; k += 1) {
      if (k === a || k === b) continue;
      if (X[k] < bb.minx - reach || X[k] > bb.maxx + reach || Y[k] < bb.miny - reach || Y[k] > bb.maxy + reach) continue;
      let d = Infinity;
      for (let t = 1; t < poly.length && d >= g.hy[k] + GLYPH_GAP_PX / 2; t += 1) { const v = segmentGap(g, k, X, Y, poly[t - 1], poly[t]); if (v < d) d = v; }
      if (d >= g.hy[k] + GLYPH_GAP_PX / 2) continue;
      F('DF_LAYOUT_ROUTE_THROUGH_NODE', `$.edges[${ei}]`, `'${String(e.from)}' -> '${String(e.to)}' (${e.route || 'auto'}) passes ${r1(d)} px from ${g.hx[k] > g.hy[k] ? 'the body' : 'the centre'} of '${nid(input, k)}'`);
    }
    const via = poly.length > 2 ? JSON.stringify(poly.slice(1, -1)) : null;
    for (let t = 1; t < poly.length; t += 1) {
      const p = poly[t - 1]; const q = poly[t];
      segs.push({ ei, e, pair: a < b ? `${a}|${b}` : `${b}|${a}`, via, p, q, minx: p[0] < q[0] ? p[0] : q[0], maxx: p[0] < q[0] ? q[0] : p[0], miny: p[1] < q[1] ? p[1] : q[1], maxy: p[1] < q[1] ? q[1] : p[1] });
    }
  });
  segs.sort((u, v) => (u.minx - v.minx) || (u.ei - v.ei));
  const seen = new Set();
  for (let u = 0; u < segs.length; u += 1) {
    const A = segs[u];
    for (let v = u + 1; v < segs.length && segs[v].minx <= A.maxx; v += 1) {
      const B = segs[v];
      if (A.ei === B.ei || B.miny > A.maxy || A.miny > B.maxy) continue;
      if (A.pair === B.pair && A.via !== null && B.via !== null && A.via !== B.via) continue;
      const key = A.ei < B.ei ? `${A.ei}|${B.ei}` : `${B.ei}|${A.ei}`;
      if (seen.has(key) || !segmentsOverlap(A.p, A.q, B.p, B.q)) continue;
      seen.add(key);
      const [lo, hi] = A.ei < B.ei ? [A, B] : [B, A];
      F('DF_LAYOUT_ROUTE_OVERLAP', `$.edges[${hi.ei}]`, `'${String(hi.e.from)}' -> '${String(hi.e.to)}' runs along '${String(lo.e.from)}' -> '${String(lo.e.to)}' for more than 1 px`);
    }
  }
}

function checkRegions(s, input, X, Y, g, F) {
  const { nodes, groups, memberOf, radii, upAxis } = input;
  if (s.kind === 'room') {
    groups.forEach((gr, gi) => {
      if (!vec3(gr.center_xyz_m) || !vec3(gr.size_xyz_m)) return;
      const c = groundOf(gr.center_xyz_m, upAxis);
      const half = upAxis === 'z' ? [gr.size_xyz_m[0] / 2, gr.size_xyz_m[1] / 2] : [gr.size_xyz_m[0] / 2, gr.size_xyz_m[2] / 2];
      nodes.forEach((n, i) => {
        if (memberOf[i] !== gi) return;
        const xyz = poseOf(n);
        if (!xyz) return;
        const q = groundOf(xyz, upAxis);
        if (Math.abs(q[0] - c[0]) <= half[0] && Math.abs(q[1] - c[1]) <= half[1]) return;
        F('DF_LAYOUT_REGION_CONTAINMENT', `$.nodes[${i}].pose_m`, `'${String(n.id)}' sits at ground [${q.map(r1).join(', ')}] outside the box of '${String(gr.id)}'`);
      });
    });
    return;
  }
  const mode = input.mode2d;
  // Grid scenes draw a group as the box around its members when that box holds no other node (archify's boundary rectangles) and as the hull otherwise (lib/layout/drawn.mjs regionShapes); the gate measures whichever is drawn.
  const gridShapes = mode === 'grid' ? regionShapes(input, X, Y, g) : null;
  const banded = mode === 'layered' || mode === 'lifecycle';
  const dir = banded ? directionOf(input, mode === 'lifecycle' ? 'right' : 'down') : null;
  const axis = dir === 'right' || dir === 'left' ? 'y' : 'x';
  const bands = banded ? groupBands(input, X, Y, axis, axis === 'x' ? g.hx : g.hy) : null;
  groups.forEach((gr, gi) => {
    let region;
    if (banded) {
      if (!bands[gi]) return;
      region = bandRegionOf(bands[gi], axis, REGION_PAD_PX);
    } else if (gridShapes && gridShapes[gi] && gridShapes[gi].kind === 'box') {
      const b = gridShapes[gi].box;
      region = { box: b };
    } else {
      const pts = []; const rs = [];
      nodes.forEach((n, i) => { if (memberOf[i] === gi) { pts.push([X[i], Y[i]]); rs.push(radii[i]); } });
      if (!pts.length) return;
      region = regionOf(pts, rs);
    }
    const inside = region.box ? (p) => p[0] >= region.box.x && p[0] <= region.box.x + region.box.w && p[1] >= region.box.y && p[1] <= region.box.y + region.box.h : (p) => insideRegion(p, region);
    nodes.forEach((n, i) => {
      if (memberOf[i] === gi || !inside([X[i], Y[i]])) return;
      F('DF_LAYOUT_REGION_CONTAINMENT', `$.groups[${gi}].wraps`, `'${String(n.id)}' is not a member of '${String(gr.id)}' but lies inside its ${banded ? 'band' : region.box ? 'box' : 'region'}`);
    });
  });
}

/** The committed plan, read and never recomputed: reversed edges and a grown viewBox are reported. */
function checkPlan(laid, F) {
  const v2 = isObject(laid.views) && isObject(laid.views['2d']) ? laid.views['2d'] : {};
  const plan = isObject(v2.plan) ? v2.plan : {};
  const edges = Array.isArray(laid.edges) ? laid.edges : [];
  for (const rid of Array.isArray(plan.reversed) ? plan.reversed : []) {
    const ei = edges.findIndex((e) => isObject(e) && e.id === rid);
    const e = ei >= 0 ? edges[ei] : null;
    F('DF_LAYOUT_LAYER_CYCLE_BROKEN', ei >= 0 ? `$.edges[${ei}]` : '$.views.2d.plan.reversed', e ? `'${String(e.from)}' -> '${String(e.to)}' (${String(rid)}) runs against the layers to break a cycle` : `'${String(rid)}' was reversed`);
  }
  const from = plan.viewbox_grown_from;
  if (Array.isArray(from) && from.length === 2 && from.every(Number.isFinite)) {
    const vb = Array.isArray(v2.viewBox) ? v2.viewBox : [];
    F('DF_LAYOUT_VIEWBOX_GROWN', '$.views.2d.viewBox', `the authored ${from[0]} x ${from[1]} box grew to ${num(vb[2], from[0])} x ${num(vb[3], from[1])} so every glyph and measured label fits`);
  }
}

function checkSeries(input, F) {
  const seen = new Map();
  input.groups.forEach((g, gi) => {
    const token = groupToken(g);
    if (!SERIES_RE.test(token)) return;
    const hashed = typeof g.color_token !== 'string' || !g.color_token;
    const prev = seen.get(token);
    if (prev && (prev.hashed || hashed)) F('DF_LAYOUT_SERIES_COLLISION', `$.groups[${gi}].color_token`, `'${String(g.id)}' and '${String(prev.id)}' both resolve to ${token}`);
    if (!prev) seen.set(token, { id: g.id, hashed });
  });
}

export function check(scene, ctx = {}, deps = {}) {
  const fails = new Map(); const totals = new Map();
  const F = (code, path, detail) => {
    totals.set(code, (totals.get(code) || 0) + 1);
    if (!fails.has(code)) fails.set(code, []);
    const list = fails.get(code);
    if (list.length < MAX_FAILS_PER_CODE) list.push(fail(code, { path, detail }));
  };
  const c = isObject(ctx) ? ctx : {};
  const quality = qualityOf(scene, c);
  try {
    const s = isObject(scene) ? scene : {};
    const gctx = { ...c, theme: c.theme ?? (isObject(s.meta) ? s.meta.theme : undefined) };
    const laid = layoutScene(s, gctx);
    const input = prepare(laid, gctx);
    const table = isObject(laid.positions) ? laid.positions : {};
    const n = input.nodes.length;
    const X = new Float64Array(n); const Y = new Float64Array(n);
    input.nodes.forEach((node, i) => {
      const p = Array.isArray(table[node.id]) ? table[node.id] : [input.frame.cx, input.frame.cy];
      X[i] = num(p[0], input.frame.cx); Y[i] = num(p[1], input.frame.cy);
    });
    const g = glyphShapes(input);
    checkModes(s, F);
    checkPoses(s, input, F);
    checkPositionsTable(s, input, F);
    if (n) {
      checkOverlap(input, X, Y, g, F);
      checkLabels(laid, input, X, Y, g, F);
      checkRoutes(laid, input, X, Y, g, F);
      checkRegions(s, input, X, Y, g, F);
      checkPlan(laid, F);
      const probe = verifyDeterminism(s, gctx, typeof deps.runner === 'function' ? deps.runner : layoutTables);
      if (!probe.deterministic) F('DF_LAYOUT_NONDETERMINISTIC', '$.positions', `mode ${probe.mode}, seed ${probe.seed}: ${probe.diffs.slice(0, 5).join(', ')}${probe.diffs.length > 5 ? ` and ${probe.diffs.length - 5} more` : ''}`);
    }
    checkSeries(input, F);
  } catch (e) {
    // Unreachable by design (every input shape is guarded); reported, never thrown.
    F('DF_LAYOUT_NONDETERMINISTIC', '$', `layout gate stopped: ${e && e.message ? e.message : String(e)}`);
  }
  const out = [];
  for (const code of codesForFamily('layout')) {
    const level = blocksAt(code, quality);
    const entries = fails.has(code) ? [...fails.get(code)] : [pass(code)];
    const total = totals.get(code) || 0;
    if (total > MAX_FAILS_PER_CODE) entries.push(fail(code, { path: '$', detail: `further ${total - MAX_FAILS_PER_CODE} ${code} findings not listed (${MAX_FAILS_PER_CODE} shown of ${total})` }));
    for (const entry of entries) out.push(level === null ? entry : { ...entry, blocking: level });
  }
  return out;
}
