// Layout runs once, in 2D, and writes the one positions table and the
// geometry tables beside it (V2_PLAN §3):
//   positions  {nodeId: [x, y]} (1e-3 px), dense
//   routes     {edgeId: polyline}: dense in the routed modes (layered,
//              sequence, lifecycle: every id'd edge, the chord included),
//              sparse elsewhere (only what route.mjs bent: fans, detours,
//              grid channels)
//   labels     {nodeId: side}, sparse (only labels off their default side)
//   views.2d.plan  {mode, reversed?, skipped?, layers?, dummies?, crossings?, beats?, viewbox_grown_from?}
//   views.2d.viewBox  authored ?? default, united with what the mode returned:
//              an authored box only grows (plan.viewbox_grown_from records it);
//              an unauthored one is the mode's own box
// A mode returns [[x, y], ...] or {points, routes?, sides?, plan?, viewBox?};
// run2d normalises both. A scene that is laid_out is returned as is, its
// tables complete or not (goldens never re-simulate; an incomplete table is
// the layout gate's DF_LAYOUT_POSITION_MISSING / DF_LAYOUT_ROUTE_MISSING,
// never a silent re-run that throws committed positions away); ctx.force
// re-runs it cold; ctx.incremental (lib/bench only) warm-starts the
// free-form modes from the positions it carries. Outside a room an authored
// pos (normalised -1..1, SVG y down, over the padded box) pins a node and
// pose_m is ignored; a room's 2D map is the metric top-down map of pose_m
// (the gate reports DF_LAYOUT_POSE_IGNORED). A room is metric in 2D and 3D
// whatever it declares and no other kind is ever metric; a mode that does
// not apply falls back to the kind's default (DF_LAYOUT_UNKNOWN_MODE).
//
//   layoutScene(scene, ctx)        -> scene with the tables and laid_out: true
//   layoutTables(scene, ctx)       -> {positions, routes, labels, plan}
//   layoutDetailed(scene, ctx)     -> {scene, plan, metrics} (metrics: lib/bench/metrics.mjs layoutMetrics)
//   positionsComplete / routesComplete(scene, mode)
//   positions3d / positionsVr      -> {id: [X, Y, Z]} derived from the 2D table (lift, tier-wall, metric) / its VR transform
//   verifyDeterminism(scene, ctx, runner) -> {deterministic, diffs: ['routes.m3', ...], mode, seed}
import { canonical } from '../digest.mjs';
import { hashString } from './rng.mjs';
import { frameOf, roundTo, toVr, vrFrame } from './frame.mjs';
import { LABEL_ANCHORS, defaultViewBox, evidenceLabels, glyphRadius, labelAnchor, labelBudgetOf, labelStyle, labelWidth, measuredLabels, shapesTable } from './metrics.mjs';
import { edgeAt, timeIndex, timeOf } from '../time/playhead.mjs';
import { validPolyline } from './geometry.mjs';
import { forceLayout } from './force.mjs';
import { clusterDiscLayout } from './cluster-disc.mjs';
import { gridLayout } from './grid.mjs';
import { timelineLayout } from './timeline.mjs';
import { lanesLayout } from './lanes.mjs';
import { metricLayout, metric3d } from './metric.mjs';
import { layeredLayout } from './layered.mjs';
import { sequenceLayout } from './sequence.mjs';
import { lifecycleLayout } from './lifecycle.mjs';
import { liftPositions } from './lift.mjs';
import { tierWallPositions } from './tier-wall.mjs';
import { chooseSides } from './labels.mjs';
import { routableEdgeIds, routePass, separateEdgeLabels } from './route.mjs';

export { routableEdgeIds };
import { layoutMetrics } from '../bench/metrics.mjs';

export { defaultViewBox };
export const MODES_2D = Object.freeze(['force', 'cluster-disc', 'grid', 'timeline', 'lanes', 'metric', 'layered', 'sequence', 'lifecycle']);
export const MODES_3D = Object.freeze(['lift', 'tier-wall', 'metric']);
/** The modes that route every id'd edge themselves (dense routes). */
export const ROUTED_MODES = Object.freeze(['layered', 'sequence', 'lifecycle']);
export const GRAPH_LIKE = Object.freeze(['graph', 'timeline', 'board', 'workflow', 'meet', 'sequence', 'lifecycle']);
export const SERIES_COUNT = 6;
const DEFAULT_2D = Object.freeze({ graph: 'force', room: 'metric', timeline: 'timeline', board: 'lanes', workflow: 'grid', meet: 'cluster-disc', sequence: 'sequence', lifecycle: 'lifecycle' });
const DEFAULT_3D = Object.freeze({ room: 'metric', timeline: 'tier-wall' });
const TABLES = Object.freeze(['positions', 'routes', 'labels', 'plan']);
const MAX_ROUTE_POINTS = 64;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function objects(v) { return Array.isArray(v) ? v.filter(isObject) : []; }
function view2d(s) { return isObject(s) && isObject(s.views) && isObject(s.views['2d']) ? s.views['2d'] : {}; }
function validBox(vb) { return Array.isArray(vb) && vb.length === 4 && vb.every((x) => typeof x === 'number' && Number.isFinite(x)) && vb[2] > 0 && vb[3] > 0; }

export function defaultMode2d(kind) { return DEFAULT_2D[kind] || 'force'; }
export function defaultMode3d(kind) { return DEFAULT_3D[kind] || 'lift'; }

/** The 2D mode a scene runs under: a room is always metric; elsewhere a valid non-metric declaration, else the kind's default. */
export function mode2dOf(scene) {
  const s = isObject(scene) ? scene : {};
  if (s.kind === 'room') return 'metric';
  const v2 = view2d(s);
  return MODES_2D.includes(v2.layout) && v2.layout !== 'metric' ? v2.layout : defaultMode2d(s.kind);
}

/** The 3D mode: a room is always metric; elsewhere a valid non-metric declaration, else the kind's default (timeline tier-wall, else lift). */
export function mode3dOf(scene) {
  const s = isObject(scene) ? scene : {};
  if (s.kind === 'room') return 'metric';
  const v3 = isObject(s.views) && isObject(s.views['3d']) ? s.views['3d'] : {};
  return MODES_3D.includes(v3.layout) && v3.layout !== 'metric' ? v3.layout : defaultMode3d(s.kind);
}

/** The series token a group without color_token gets: a deterministic hash of its id over series-1..6. */
export function groupSeries(id) {
  return `series-${(hashString(id) % SERIES_COUNT) + 1}`;
}

/** The effective colour token of a group: its own color_token, else groupSeries(id). */
export function groupToken(group) {
  const g = isObject(group) ? group : {};
  return typeof g.color_token === 'string' && g.color_token ? g.color_token : groupSeries(String(g.id ?? ''));
}

/** Node -> group membership from node.group, else the first group whose wraps[] names the node. */
export function membership(scene) {
  const s = isObject(scene) ? scene : {};
  const nodes = objects(s.nodes);
  const groups = objects(s.groups);
  const groupIndex = new Map();
  groups.forEach((g, gi) => { if (typeof g.id === 'string' && !groupIndex.has(g.id)) groupIndex.set(g.id, gi); });
  const wrapped = new Map();
  groups.forEach((g, gi) => {
    for (const w of Array.isArray(g.wraps) ? g.wraps : []) if (typeof w === 'string' && !wrapped.has(w)) wrapped.set(w, gi);
  });
  const memberOf = new Int32Array(nodes.length);
  let hasUngrouped = false;
  nodes.forEach((n, i) => {
    let gi = -1;
    if (typeof n.group === 'string' && groupIndex.has(n.group)) gi = groupIndex.get(n.group);
    else if (typeof n.id === 'string' && wrapped.has(n.id)) gi = wrapped.get(n.id);
    memberOf[i] = gi;
    if (gi < 0) hasUngrouped = true;
  });
  return { nodes, groups, memberOf, groupCount: groups.length, hasUngrouped, groupIndex };
}

function authoredPos(node, frame) {
  const p = isObject(node.pos) ? node.pos : null;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const halfW = frame.w / 2 - frame.padding;
  const halfH = frame.h / 2 - frame.padding;
  return [frame.cx + p.x * halfW, frame.cy + p.y * halfH];
}

/** Edge index (into input.edges) -> the number its order badge shows: only on an order axis, as svg-edges.mjs draws them. */
function badgeOrders(s, edges) {
  const out = new Map();
  const time = timeOf(s);
  if (!time || time.axis !== 'order') return out;
  const byId = timeIndex(s).nodesById;
  edges.forEach(([, , e], k) => { const at = edgeAt(e, byId, time); if (Number.isInteger(at)) out.set(k, at); });
  return out;
}

/** Everything a mode needs, resolved once: + style (theme-aware), labelBudget, measured, sides, warm, pinLabel and badges (what svg draws beside labels). */
export function prepare(scene, ctx = {}) {
  const s = isObject(scene) ? scene : {};
  const c = isObject(ctx) ? ctx : {};
  const m = membership(s);
  const v2 = view2d(s);
  const meta = isObject(s.meta) ? s.meta : {};
  const style = labelStyle({ tokensCss: c.tokensCss, theme: c.theme ?? meta.theme });
  const labelBudget = labelBudgetOf(s, m.nodes.length);
  const measured = measuredLabels(m.nodes, labelBudget);
  let frame = frameOf(s);
  if (!validBox(v2.viewBox)) {
    let sum = 0;
    for (const i of measured) sum += labelWidth(m.nodes[i].label, style);
    const box = defaultViewBox(m.nodes.length, frame.spacing, m.nodes.length ? sum / m.nodes.length : 0);
    frame = frameOf({ ...s, views: { ...(isObject(s.views) ? s.views : {}), '2d': { ...v2, viewBox: box } } });
  }
  const shapes = shapesTable(c);
  const kind = s.kind === 'room' ? 'room' : 'graph-like';
  const ids = new Map();
  m.nodes.forEach((n, i) => { if (typeof n.id === 'string' && !ids.has(n.id)) ids.set(n.id, i); });
  const edges = [];
  for (const e of objects(s.edges)) {
    if (ids.has(e.from) && ids.has(e.to)) edges.push([ids.get(e.from), ids.get(e.to), e]);
  }
  const pinned = new Map();
  if (kind !== 'room') m.nodes.forEach((n, i) => { const p = authoredPos(n, frame); if (p) pinned.set(i, p); });
  const radii = new Float64Array(m.nodes.length);
  m.nodes.forEach((n, i) => { radii[i] = glyphRadius(n, shapes); });
  const sides = new Map();
  if (isObject(s.labels)) for (const [id, side] of Object.entries(s.labels)) if (ids.has(id) && LABEL_ANCHORS.includes(side)) sides.set(ids.get(id), side);
  const warm = new Map();
  if (c.incremental === true && isObject(s.positions)) {
    m.nodes.forEach((n, i) => { const p = s.positions[n.id]; if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) warm.set(i, [p[0], p[1]]); });
  }
  const upAxis = isObject(s.meta) && s.meta.up_axis === 'z' ? 'z' : 'y';
  return {
    scene: s, ...m, ids, edges, frame, shapes, pinned, radii, upAxis, style, labelBudget, measured, sides, warm,
    pinLabel: evidenceLabels(s), badges: badgeOrders(s, edges),
    columns: Number.isInteger(v2.columns) && v2.columns >= 1 ? v2.columns : null,
    mode2d: mode2dOf(s), mode3d: mode3dOf(s),
  };
}

/** Run the mode and normalise both contracts to {points, routes, sides, plan, viewBox} (sides: Map index -> side). */
function run2d(input) {
  let raw;
  switch (input.mode2d) {
    case 'metric': raw = metricLayout(input); break;
    case 'cluster-disc': raw = clusterDiscLayout(input); break;
    case 'grid': raw = gridLayout(input); break;
    case 'timeline': raw = timelineLayout(input); break;
    case 'lanes': raw = lanesLayout(input); break;
    case 'layered': raw = layeredLayout(input); break;
    case 'sequence': raw = sequenceLayout(input); break;
    case 'lifecycle': raw = lifecycleLayout(input); break;
    default: raw = forceLayout(input);
  }
  const out = { points: [], routes: null, sides: null, plan: null, viewBox: null };
  if (Array.isArray(raw)) { out.points = raw; return out; }
  if (!isObject(raw)) return out;
  out.points = Array.isArray(raw.points) ? raw.points : [];
  if (isObject(raw.routes)) out.routes = raw.routes;
  if (raw.sides instanceof Map) out.sides = raw.sides;
  else if (isObject(raw.sides)) { out.sides = new Map(); for (const [id, side] of Object.entries(raw.sides)) if (input.ids.has(id)) out.sides.set(input.ids.get(id), side); }
  if (isObject(raw.plan)) out.plan = raw.plan;
  if (validBox(raw.viewBox)) out.viewBox = raw.viewBox;
  return out;
}

/**
 * The schema's closed plan, only what the mode measured: layered and
 * lifecycle carry layers, dummies, crossings (after ordering) and the
 * reversed edges; sequence its beats; every mode the edges it skipped. Empty
 * lists are left out, so a free-form plan is {mode}.
 */
function planOf(mode, raw) {
  const plan = { mode };
  if (!isObject(raw)) return plan;
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  if (ids(raw.reversed).length) plan.reversed = ids(raw.reversed);
  if (ids(raw.skipped).length) plan.skipped = ids(raw.skipped);
  if (mode === 'sequence') {
    if (int(raw.beats) !== null) plan.beats = raw.beats;
    return plan;
  }
  if (int(raw.layers) !== null) plan.layers = raw.layers;
  if (int(raw.dummies) !== null) plan.dummies = raw.dummies;
  const crossings = int(raw.crossings) ?? int(raw.crossings_after);
  if (crossings !== null) plan.crossings = crossings;
  if (int(raw.beats) !== null) plan.beats = raw.beats;
  return plan;
}

/** Does scene.positions hold a finite [x, y] for every node id? */
export function positionsComplete(scene) {
  const s = isObject(scene) ? scene : {};
  if (!isObject(s.positions)) return false;
  for (const n of objects(s.nodes)) {
    const p = typeof n.id === 'string' ? s.positions[n.id] : undefined;
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  }
  return true;
}

/** Routed mode: every id'd edge has a polyline and every key names an edge; any other mode: every key names an edge. */
export function routesComplete(scene, mode = mode2dOf(scene)) {
  const s = isObject(scene) ? scene : {};
  if (s.routes !== undefined && !isObject(s.routes)) return false;
  const routes = isObject(s.routes) ? s.routes : {};
  const { all, routable } = routableEdgeIds(s);
  for (const [id, poly] of Object.entries(routes)) if (!all.has(id) || !validPolyline(poly)) return false;
  if (ROUTED_MODES.includes(mode)) for (const id of routable) if (!Object.hasOwn(routes, id)) return false;
  return true;
}

function roundPoly(poly) {
  const p = poly.length > MAX_ROUTE_POINTS ? [...poly.slice(0, MAX_ROUTE_POINTS - 1), poly[poly.length - 1]] : poly;
  return p.map((q) => [roundTo(q[0], 3), roundTo(q[1], 3)]);
}

/** Lay out a scene in 2D; returns a new scene (the input is never mutated). Never throws on a non-scene. */
export function layoutScene(scene, ctx = {}) {
  if (!isObject(scene)) return scene;
  const c = isObject(ctx) ? ctx : {};
  if (c.force !== true && scene.laid_out === true) return scene;
  const input = prepare(scene, c);
  const res = run2d(input);
  const n = input.nodes.length;
  const X = new Float64Array(n); const Y = new Float64Array(n);
  const positions = {};
  input.nodes.forEach((node, i) => {
    const p = Array.isArray(res.points[i]) ? res.points[i] : [input.frame.cx, input.frame.cy];
    X[i] = p[0]; Y[i] = p[1];
    if (typeof node.id !== 'string' || Object.hasOwn(positions, node.id)) return;
    positions[node.id] = [roundTo(p[0], 3), roundTo(p[1], 3)];
  });
  const routed = ROUTED_MODES.includes(input.mode2d);
  let rawRoutes = res.routes ?? (routed ? {} : routePass(input, X, Y));
  const sides = routed ? new Map() : (res.sides ?? chooseSides(input, X, Y, { routes: rawRoutes }).sides);
  if (!routed) rawRoutes = separateEdgeLabels(input, X, Y, rawRoutes, sides);
  const { all } = routableEdgeIds(scene);
  const routes = {};
  for (const [, , e] of input.edges) if (all.has(e.id) && !Object.hasOwn(routes, e.id) && validPolyline(rawRoutes[e.id])) routes[e.id] = roundPoly(rawRoutes[e.id]);
  const labels = {};
  input.nodes.forEach((node, i) => {
    const side = sides.get(i);
    if (side && side !== labelAnchor(node, input.shapes) && typeof node.id === 'string' && !Object.hasOwn(labels, node.id)) labels[node.id] = side;
  });
  const views = isObject(scene.views) ? { ...scene.views } : {};
  const v2 = isObject(views['2d']) ? { ...views['2d'] } : { layout: input.mode2d };
  const authored = validBox(v2.viewBox) ? v2.viewBox : null;
  let vb = authored ?? input.frame.viewBox;
  if (res.viewBox && !authored) vb = res.viewBox;
  else if (res.viewBox) {
    const x0 = Math.min(vb[0], res.viewBox[0]); const y0 = Math.min(vb[1], res.viewBox[1]);
    vb = [x0, y0, Math.max(vb[0] + vb[2], res.viewBox[0] + res.viewBox[2]) - x0, Math.max(vb[1] + vb[3], res.viewBox[1] + res.viewBox[3]) - y0];
  }
  v2.viewBox = vb.map((v) => roundTo(v, 3));
  const plan = planOf(input.mode2d, res.plan);
  if (authored && v2.viewBox.some((v, k) => v !== authored[k])) plan.viewbox_grown_from = [authored[2], authored[3]];
  v2.plan = plan;
  views['2d'] = v2;
  const out = { ...scene };
  delete out.routes; delete out.labels;
  out.views = views;
  out.positions = positions;
  if (routed || Object.keys(routes).length) out.routes = routes;
  if (Object.keys(labels).length) out.labels = labels;
  out.laid_out = true;
  return out;
}

/** The 2D table only. */
export function positions2d(scene, ctx = {}) {
  const laid = layoutScene(scene, ctx);
  return isObject(laid) && isObject(laid.positions) ? laid.positions : {};
}

/** The four geometry tables of a laid-out scene ({} for a table it does not carry). */
export function layoutTables(scene, ctx = {}) {
  const laid = layoutScene(scene, ctx);
  const s = isObject(laid) ? laid : {};
  const plan = view2d(s).plan;
  return { positions: isObject(s.positions) ? s.positions : {}, routes: isObject(s.routes) ? s.routes : {}, labels: isObject(s.labels) ? s.labels : {}, plan: isObject(plan) ? plan : {} };
}

/** The laid-out scene, its plan and the benchmark's layout metrics (never written into checks or receipts). */
export function layoutDetailed(scene, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  const laid = layoutScene(scene, c);
  const plan = view2d(laid).plan;
  return { scene: laid, plan: isObject(plan) ? plan : null, metrics: isObject(laid) ? layoutMetrics(laid, { tokensCss: c.tokensCss, shapes: c.shapes, theme: c.theme }) : null };
}

function asTables(r) {
  if (isObject(r) && isObject(r.positions)) return { positions: r.positions, routes: isObject(r.routes) ? r.routes : {}, labels: isObject(r.labels) ? r.labels : {}, plan: isObject(r.plan) ? r.plan : {} };
  return { positions: isObject(r) ? r : {} };
}

/**
 * Determinism is engineered, then proven: run the layout twice from scratch
 * (ctx.force) and compare every rounded entry of every table the runner
 * returns. `runner` is layoutTables by default; a runner that returns only a
 * positions map is compared on positions. A diff names its table and key
 * ('positions.n7', 'routes.m3', 'plan.crossings'). Never throws.
 */
export function verifyDeterminism(scene, ctx = {}, runner = layoutTables) {
  const base = isObject(ctx) ? ctx : {};
  const out = { deterministic: true, diffs: [], mode: mode2dOf(scene), seed: frameOf(scene).seed };
  let a; let b;
  try { a = asTables(runner(scene, { ...base, force: true })); b = asTables(runner(scene, { ...base, force: true })); } catch (e) {
    out.deterministic = false;
    out.diffs.push(`layout threw: ${e && e.message ? e.message : String(e)}`);
    return out;
  }
  for (const table of TABLES) {
    if (!a[table] && !b[table]) continue;
    const A = a[table] ?? {}; const B = b[table] ?? {};
    for (const key of Object.keys(A)) if (!Object.hasOwn(B, key) || canonical(A[key]) !== canonical(B[key])) out.diffs.push(`${table}.${key}`);
    for (const key of Object.keys(B)) if (!Object.hasOwn(A, key)) out.diffs.push(`${table}.${key}`);
  }
  out.deterministic = out.diffs.length === 0;
  return out;
}

/** The 3D table derived from the 2D one: lift (wall + bounded z), tier-wall (shelves) or metric (pose_m as is). */
export function positions3d(scene, ctx = {}) {
  const laid = layoutScene(scene, ctx);
  if (!isObject(laid)) return {};
  const input = prepare(laid, isObject(ctx) ? ctx : {});
  const p2 = input.nodes.map((n) => (isObject(laid.positions) && Array.isArray(laid.positions[n.id]) ? laid.positions[n.id] : [input.frame.cx, input.frame.cy]));
  let p3;
  if (input.mode3d === 'metric') p3 = metric3d(input.nodes, input.upAxis);
  else if (input.mode3d === 'tier-wall') p3 = tierWallPositions(input, p2);
  else p3 = liftPositions(input, p2);
  const out = {};
  input.nodes.forEach((n, i) => {
    if (typeof n.id !== 'string' || Object.hasOwn(out, n.id)) return;
    out[n.id] = [roundTo(p3[i][0], 4), roundTo(p3[i][1], 4), roundTo(p3[i][2], 4)];
  });
  return out;
}

/** The VR table: exactly toVr(positions3d[id], vrFrame(scene)) for every node. */
export function positionsVr(scene, ctx = {}) {
  const p3 = positions3d(scene, ctx);
  const vr = vrFrame(scene, mode3dOf(scene));
  const out = {};
  for (const [id, p] of Object.entries(p3)) out[id] = toVr(p, vr);
  return out;
}
