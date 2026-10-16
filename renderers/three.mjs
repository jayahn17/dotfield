// renderers/three.mjs — the 3D view of one scene on three r180: one InstancedMesh per
// primitive for accepted nodes and a wireframe twin per primitive for proposals,
// polyline edges (three-edges.mjs), translucent group regions, a foreign halo, labels
// from one shared canvas atlas (three-labels.mjs), and the time layer (motion.mjs:
// ghosts, beads, the now plane, fresh and active rings) driven by the 2D viewer's
// frame through built.setTime(). Embedded by html.mjs as a data: URL, so it imports
// only importmap specifiers (its siblings resolve as dotfield/<name>) and cannot
// reach lib/layout: the frame, lift, tier-wall and metric transforms are mirrored
// here and test/html-3d.test.js pins positions3d(scene) to lib/layout's table
// exactly — one positions table per scene, derived, never re-simulated.
//   buildScene(scene, THREE, tokens, opts) -> built   positions3d(scene)   vrPlacement(scene)
//   mount3d({scene, hosts, views, theme, tokenNames, shapes, xr}) -> api {setView, setTheme, focus, setVisible, setTime, hover, select, dispose}
import { ATLAS_SLOTS, createLabels, tokenValue } from './three-labels.mjs';
import { TIER, toThree, buildEdges } from './three-edges.mjs';
import { createMotion, normalizeFrame } from './motion.mjs';
import { createMount } from './three-mount.mjs';

export { ATLAS, ATLAS_SLOTS, LabelAtlas, tokenValue } from './three-labels.mjs';
export { toThree, edgePolyline, liftPolyline } from './three-edges.mjs';
export { normalizeFrame, timeBlockOf } from './motion.mjs';
export const DEFAULT_LABEL_BUDGET = 64;
export const NODE_SCALE_3D = 1.5;
const DEFAULT_VIEWBOX = [0, 0, 1600, 1000]; const DEFAULT_PADDING = 50; const DEFAULT_SPACING = 48; const DEFAULT_SCALE_M = 6;
const GLYPH_RADIUS_PX = 10; const REGION_PAD_PX = 18; const SNAP_TURN_DEG = Object.freeze([0, 30, 45, 90]);
const FNV_OFFSET = 2166136261; const FNV_PRIME = 16777619; const SERIES_COUNT = 6;
/** Mirror of renderers/shapes.json primitive3d (lockstep-tested); an x-kind row arrives through opts.shapes. */
export const DEFAULT_SHAPES = Object.freeze({
  record: 'sphere', note: 'box', person: 'torus', desk: 'cylinder', tag: 'capsule', file: 'box', asset: 'octahedron',
  event: 'cone', place: 'cylinder', boundary: 'icosahedron', annotation: 'tetrahedron', idea: 'dodecahedron',
});
/** Unit geometries, each roughly filling the unit sphere so one radius scales every kind alike. */
export const PRIMITIVES = Object.freeze({
  sphere: (T) => new T.SphereGeometry(1, 24, 16), box: (T) => new T.BoxGeometry(1.6, 1.6, 1.6), octahedron: (T) => new T.OctahedronGeometry(1.1, 0),
  cylinder: (T) => new T.CylinderGeometry(0.9, 0.9, 1.4, 24), cone: (T) => new T.ConeGeometry(1, 1.7, 24), capsule: (T) => new T.CapsuleGeometry(0.55, 1.1, 6, 12),
  torus: (T) => new T.TorusGeometry(0.75, 0.3, 12, 32), icosahedron: (T) => new T.IcosahedronGeometry(1.05, 0), tetrahedron: (T) => new T.TetrahedronGeometry(1.25, 0),
  dodecahedron: (T) => new T.DodecahedronGeometry(1.05, 0),
});
const BOX_UNIT = 1.6;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v); const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d); const pos = (v, d) => { const n = num(v, d); return n > 0 ? n : d; };
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v)); const round4 = (v) => Math.round(v * 10000) / 10000;
const vec3 = (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null);
const viewsOf = (scene, k) => { const v = isObject(scene) && isObject(scene.views) ? scene.views[k] : null; return isObject(v) ? v : {}; };
const weightOf = (n) => (n && typeof n.weight === 'number' && Number.isFinite(n.weight) ? n.weight : 0.5);

export function hashString(s) { let h = FNV_OFFSET; const str = String(s); for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, FNV_PRIME); } return h >>> 0; }
export const groupSeries = (id) => `series-${(hashString(id) % SERIES_COUNT) + 1}`;
export const groupToken = (g) => (isObject(g) && typeof g.color_token === 'string' && g.color_token ? g.color_token : groupSeries(String(isObject(g) && g.id !== undefined ? g.id : '')));

// ── colours: CSS token values -> THREE.Color, resolved once per theme ───────────
/** '#rgb[a]' | '#rrggbb[aa]' | 'rgb[a](r, g, b[, a])' (commas or spaces) | 'transparent' -> [r, g, b, a] in 0..1, else null. */
export function parseCssColor(str) {
  const s = String(str ?? '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1]; if (![3, 4, 6, 8].includes(h.length)) return null;
    const v = (h.length <= 4 ? h.split('').map((c) => c + c) : h.match(/../g)).map((x) => parseInt(x, 16) / 255);
    return [v[0], v[1], v[2], v.length === 4 ? v[3] : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) { const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])); return [+m[1] / 255, +m[2] / 255, +m[3] / 255, clamp(a, 0, 1)]; }
  return s === 'transparent' ? [0, 0, 0, 0] : null;
}
/** {color: THREE.Color (working space), alpha} for a token, falling back to `fallback`, then mid grey. */
export function colorOf(THREE, tokens, name, fallback = 'muted') {
  const rgba = parseCssColor(tokenValue(tokens, name)) || parseCssColor(tokenValue(tokens, fallback)) || [0.5, 0.5, 0.5, 1];
  return { color: new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace), alpha: rgba[3] };
}
/** The --df-* values the page currently resolves to (the shell sets data-theme on <html> before asking). */
export function tokensFromComputed(names, el = (globalThis.document ? globalThis.document.documentElement : null)) {
  const out = {};
  if (!el || typeof globalThis.getComputedStyle !== 'function') return out;
  const cs = globalThis.getComputedStyle(el);
  for (const n of Array.isArray(names) ? names : []) { const v = cs.getPropertyValue(n); if (v && v.trim()) out[n] = v.trim(); }
  return out;
}

// ── the frame mirrors (lib/layout/{frame,lift,tier-wall,metric,index}.mjs) ─────
/** Mirror of lib/layout/frame.mjs frameOf: the written viewBox (every laid-out scene carries one), else the 1600×1000 default. */
export function frameOf(scene) {
  const v2 = viewsOf(scene, '2d'); const v3 = viewsOf(scene, '3d'); const raw = v2.viewBox;
  const vb = Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === 'number' && Number.isFinite(n)) && raw[2] > 0 && raw[3] > 0 ? raw : DEFAULT_VIEWBOX;
  const [x0, y0, w, h] = vb; const padding = num(v2.padding, DEFAULT_PADDING); const scaleM = pos(v3.scale_m, DEFAULT_SCALE_M);
  return { viewBox: [x0, y0, w, h], x0, y0, w, h, cx: x0 + w / 2, cy: y0 + h / 2, padding: padding * 2 < (w < h ? w : h) ? padding : 0, spacing: pos(v2.spacing, DEFAULT_SPACING), scale_m: scaleM, metres_per_px: scaleM / (w > h ? w : h) };
}
export const metricToThree = (xyz, up = 'y') => { const x = num(xyz && xyz[0], 0); const y = num(xyz && xyz[1], 0); const z = num(xyz && xyz[2], 0); return up === 'z' ? [x, z, 0 - y] : [x, y, z]; };
export function mode3dOf(scene) {
  const s = isObject(scene) ? scene : {};
  if (s.kind === 'room') return 'metric';
  const l = viewsOf(s, '3d').layout;
  return l === 'lift' || l === 'tier-wall' ? l : (s.kind === 'timeline' ? 'tier-wall' : 'lift');
}
export function membership(scene) {
  const nodes = objects(isObject(scene) ? scene.nodes : null); const groups = objects(isObject(scene) ? scene.groups : null);
  const groupIndex = new Map(); const wrapped = new Map();
  groups.forEach((g, gi) => { if (typeof g.id === 'string' && !groupIndex.has(g.id)) groupIndex.set(g.id, gi); });
  groups.forEach((g, gi) => { for (const w of Array.isArray(g.wraps) ? g.wraps : []) if (typeof w === 'string' && !wrapped.has(w)) wrapped.set(w, gi); });
  const memberOf = new Int32Array(nodes.length); let hasUngrouped = false;
  nodes.forEach((n, i) => {
    let gi = -1;
    if (typeof n.group === 'string' && groupIndex.has(n.group)) gi = groupIndex.get(n.group); else if (typeof n.id === 'string' && wrapped.has(n.id)) gi = wrapped.get(n.id);
    memberOf[i] = gi; if (gi < 0) hasUngrouped = true;
  });
  return { nodes, groups, memberOf, groupCount: groups.length, hasUngrouped, groupIndex };
}
function liftZ(scene, m, i) {
  const v3 = viewsOf(scene, '3d'); const lift = isObject(v3.lift) ? v3.lift : {}; const scaleM = pos(v3.scale_m, DEFAULT_SCALE_M);
  const mode = ['group-weight', 'weight', 'flat'].includes(lift.mode) ? lift.mode : 'flat';
  const amp = typeof lift.amplitude_m === 'number' && lift.amplitude_m >= 0 ? lift.amplitude_m : 0; const bound = 0.5 * scaleM; const w = weightOf(m.nodes[i]);
  let v = 0;
  if (mode === 'group-weight') { const tiers = m.groupCount + (m.hasUngrouped ? 1 : 0); const ti = m.memberOf[i] < 0 ? m.groupCount : m.memberOf[i]; v = amp * ((tiers <= 1 ? 0 : ti / (tiers - 1) - 0.5) + 0.5 * (w - 0.5)); }
  else if (mode === 'weight') v = amp * (2 * w - 1);
  return v > bound ? bound : (v < 0 - bound ? 0 - bound : v);
}
export const poseOf = (n) => (n && isObject(n.pose_m) ? vec3(n.pose_m.xyz) : null); export const upAxisOf = (scene) => (isObject(scene) && isObject(scene.meta) && scene.meta.up_axis === 'z' ? 'z' : 'y');
/** The 3D table of a laid-out scene: exactly lib/layout positions3d(); an unplaced node sits at the frame centre. perNode2d is the 2D point each node was lifted from. */
export function positions3d(scene) {
  const s = isObject(scene) ? scene : {}; const m = membership(s); const frame = frameOf(s); const mode3d = mode3dOf(s); const upAxis = upAxisOf(s);
  const v3 = viewsOf(s, '3d'); const scaleM = pos(v3.scale_m, DEFAULT_SCALE_M); const tiers = Math.max(1, m.groupCount + (m.hasUngrouped ? 1 : 0));
  const positions = {}; const unplaced = new Set(); const perNode = []; const perNode2d = [];
  m.nodes.forEach((n, i) => {
    const raw = isObject(s.positions) && Array.isArray(s.positions[n.id]) && Number.isFinite(s.positions[n.id][0]) && Number.isFinite(s.positions[n.id][1]) ? s.positions[n.id] : null;
    const p2 = raw || [frame.cx, frame.cy]; let p3; perNode2d.push([p2[0], p2[1]]);
    if (mode3d === 'metric') { const xyz = poseOf(n); p3 = xyz ? metricToThree(xyz, upAxis) : [0, 0, 0]; if (!xyz) unplaced.add(n.id); }
    else if (mode3d === 'tier-wall') { const ti = m.memberOf[i] < 0 ? m.groupCount : m.memberOf[i]; p3 = [(p2[0] - frame.cx) * frame.metres_per_px, TIER.base_m + (scaleM * TIER.height_mult * (ti + 0.5)) / tiers, (p2[1] - frame.cy) * frame.metres_per_px * TIER.depth_mult]; }
    else p3 = toThree([p2[0], p2[1], liftZ(s, m, i)], frame);
    if (!raw && mode3d !== 'metric') unplaced.add(n.id);
    p3 = [round4(p3[0]), round4(p3[1]), round4(p3[2])]; perNode.push(p3);
    if (typeof n.id === 'string' && !Object.hasOwn(positions, n.id)) positions[n.id] = p3;
  });
  return { ...m, frame, mode3d, upAxis, positions, perNode, perNode2d, unplaced };
}
export const labelBudgetOf = (scene) => { const b = viewsOf(scene, 'vr').label_budget; const b3 = viewsOf(scene, '3d').label_budget; const v = Number.isInteger(b) && b >= 0 ? b : (Number.isInteger(b3) && b3 >= 0 ? b3 : DEFAULT_LABEL_BUDGET); return Math.min(v, ATLAS_SLOTS); };
/** Mirror of lib/layout/frame.mjs vrFrame(): VR = 3D scaled by k and raised to y0 (uniform scale + y shift, applied to the whole group); snap_turn_deg for xr.mjs (0 disables). */
export function vrPlacement(scene) {
  const v3 = viewsOf(scene, '3d'); const vr = viewsOf(scene, 'vr'); const s3 = pos(v3.scale_m, DEFAULT_SCALE_M); const sv = pos(vr.scale_m, s3);
  const floorY = num(vr.floor_y, 0); const eye = num(vr.eye_height_m, 1.6); const mode = mode3dOf(scene);
  return { enabled: vr.enabled === true, k: sv / s3, floor_y: floorY, eye_height_m: eye, y0: mode === 'lift' ? floorY + eye : floorY, scale_m: sv, mode3d: mode, entry_node: typeof vr.entry_node === 'string' ? vr.entry_node : null, label_budget: labelBudgetOf(scene), snap_turn_deg: SNAP_TURN_DEG.includes(vr.snap_turn_deg) ? vr.snap_turn_deg : 45 };
}
export const toVr = (p, pl) => [p[0] * pl.k, p[1] * pl.k + pl.y0, p[2] * pl.k];

// ── buildScene ────────────────────────────────────────────────────────────────
function normalizeShapes(shapes) {
  const out = { ...DEFAULT_SHAPES }; const rows = isObject(shapes) && isObject(shapes.kinds) ? shapes.kinds : (Array.isArray(shapes) ? Object.fromEntries(shapes.filter((r) => isObject(r) && typeof r.kind === 'string').map((r) => [r.kind, r])) : shapes);
  if (isObject(rows)) for (const [k, row] of Object.entries(rows)) if (isObject(row) && typeof row.primitive3d === 'string' && PRIMITIVES[row.primitive3d]) out[k] = row.primitive3d;
  return out;
}
export function isForeign(node, ownerId = 'self') {
  const owner = node && isObject(node.provenance) ? node.provenance.owner_person_id : undefined;
  return node.kind === 'boundary' || node.color_token === 'foreign' || (typeof owner === 'string' && owner !== ownerId && owner !== 'self');
}

/**
 * Build the three objects of a scene. Pure given (scene, THREE, tokens):
 * the only DOM use is the label atlas, created when opts.document (or a
 * global document) can make a canvas; headless, labels plan but do not draw.
 * setVisible(ids) is the lens, setTime(frame) the playhead; a node is drawn
 * solid when both admit it, as a ghost when only the lens does.
 */
export function buildScene(scene, THREE, tokens = {}, opts = {}) {
  const P = positions3d(scene); const shapes = normalizeShapes(opts.shapes); const ownerId = typeof opts.ownerId === 'string' ? opts.ownerId : 'self';
  const { frame, nodes, groups, memberOf, mode3d, upAxis } = P; const mpp = frame.metres_per_px; const scaleM = frame.scale_m;
  const group = new THREE.Group(); group.name = 'dotfield';
  const geoms = new Map(); const geomOf = (prim) => { if (!geoms.has(prim)) geoms.set(prim, PRIMITIVES[prim](THREE)); return geoms.get(prim); };
  const white = new THREE.Color(1, 1, 1); const M = new THREE.Matrix4(); const Q = new THREE.Quaternion(); const V = new THREE.Vector3(); const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const col = (name, fb) => colorOf(THREE, tokens, name, fb);
  const index = new Map(); nodes.forEach((n, i) => { if (typeof n.id === 'string' && !index.has(n.id)) index.set(n.id, i); });
  const slots = nodes.map((n, i) => { // nodes -> slots
    const prim = shapes[n.kind] || 'sphere'; const proposal = n.status === 'proposal'; const foreign = isForeign(n, ownerId); const w = clamp(weightOf(n), 0, 1);
    let radius; let scale;
    const size = mode3d === 'metric' ? vec3(n.size_m) : null;
    if (size) { const s = upAxis === 'z' ? [size[0], size[2], size[1]] : size; radius = Math.max(s[0], s[1], s[2]) / 2; scale = prim === 'box' ? s.map((v) => v / BOX_UNIT) : [radius, radius, radius]; }
    else { radius = mode3d === 'metric' ? 0.15 * (0.7 + 0.6 * w) : GLYPH_RADIUS_PX * (0.7 + 0.6 * w) * mpp * NODE_SCALE_3D; scale = [radius, radius, radius]; }
    return { i, id: n.id, node: n, prim, proposal, foreign, radius, scale, pos: P.perNode[i], token: typeof n.color_token === 'string' ? n.color_token : 'muted', mesh: null, index: -1, haloIndex: -1 };
  });
  const solidMat = new THREE.MeshStandardMaterial({ color: white, roughness: 0.55, metalness: 0.05 });
  const proposalMat = new THREE.MeshStandardMaterial({ color: white, wireframe: true, transparent: true, opacity: 0.85 });
  const solid = new Map(); const proposal = new Map();
  for (const s of slots) { const bucket = s.proposal ? proposal : solid; bucket.set(s.prim, (bucket.get(s.prim) || 0) + 1); }
  const makeInstanced = (bucket, mat, status) => { for (const [prim, count] of bucket) { const im = new THREE.InstancedMesh(geomOf(prim), mat, count); im.count = 0; im.name = `nodes-${status}-${prim}`; im.userData = { status, prim, ids: [] }; im.frustumCulled = false; bucket.set(prim, im); group.add(im); } };
  makeInstanced(solid, solidMat, 'accepted'); makeInstanced(proposal, proposalMat, 'proposal');
  const place = (s) => { V.set(s.pos[0], s.pos[1], s.pos[2]); M.compose(V, Q, new THREE.Vector3(s.scale[0], s.scale[1], s.scale[2])); return M; };
  for (const s of slots) {
    const im = (s.proposal ? proposal : solid).get(s.prim); s.mesh = im; s.index = im.count; im.count += 1; im.userData.ids.push(s.id);
    im.setMatrixAt(s.index, place(s)); im.setColorAt(s.index, col(s.token).color);
  }
  // foreign halo
  const foreignSlots = slots.filter((s) => s.foreign);
  const haloMat = new THREE.MeshBasicMaterial({ color: col('foreign').color, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.BackSide });
  const halo = foreignSlots.length ? new THREE.InstancedMesh(geomOf('sphere'), haloMat, foreignSlots.length) : null;
  const haloAt = (s) => { V.set(s.pos[0], s.pos[1], s.pos[2]); return M.compose(V, Q, new THREE.Vector3(s.radius * 1.6, s.radius * 1.6, s.radius * 1.6)); };
  if (halo) { halo.name = 'foreign-halo'; halo.frustumCulled = false; foreignSlots.forEach((s, k) => { s.haloIndex = k; halo.setMatrixAt(k, haloAt(s)); }); group.add(halo); }
  // edges: one segment per polyline vertex pair
  const edges = buildEdges(THREE, { scene, P, slots, index, col, scaleM }); group.add(edges.solid, edges.dashed);
  // regions: translucent boxes (a metric group box as declared; a graph group's padded member bounds)
  const unitBox = new THREE.BoxGeometry(1, 1, 1); const unitEdges = new THREE.EdgesGeometry(unitBox); const regions = [];
  groups.forEach((g, gi) => {
    let center; let size; const c3 = vec3(g.center_xyz_m); const s3 = vec3(g.size_xyz_m);
    if (mode3d === 'metric' && c3 && s3) { center = metricToThree(c3, upAxis); size = upAxis === 'z' ? [s3[0], s3[2], s3[1]] : s3; }
    else {
      const members = slots.filter((s) => memberOf[s.i] === gi); if (!members.length) return;
      const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity]; let pad = REGION_PAD_PX * mpp * NODE_SCALE_3D;
      for (const s of members) { pad = Math.max(pad, s.radius + REGION_PAD_PX * mpp * NODE_SCALE_3D); for (let k = 0; k < 3; k += 1) { lo[k] = Math.min(lo[k], s.pos[k]); hi[k] = Math.max(hi[k], s.pos[k]); } }
      center = lo.map((v, k) => (v + hi[k]) / 2); size = lo.map((v, k) => hi[k] - v + 2 * pad);
    }
    const token = groupToken(g); const c = col(token).color;
    const mesh = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
    const outline = new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.45 }));
    for (const o of [mesh, outline]) { o.position.set(center[0], center[1], center[2]); o.scale.set(size[0], size[1], size[2]); o.name = `region-${g.id}`; o.renderOrder = -1; group.add(o); }
    regions.push({ group: g, token, mesh, outline, center, size });
  });
  // labels: one atlas, one instanced plane mesh, a plan bounded by the budget
  const adjacency = { inbound: new Map(), outbound: new Map() };
  for (const s of slots) { adjacency.inbound.set(s.id, new Set()); adjacency.outbound.set(s.id, new Set()); }
  for (const x of edges.list) { adjacency.outbound.get(slots[x.a].id).add(slots[x.b].id); adjacency.inbound.get(slots[x.b].id).add(slots[x.a].id); }
  const reachOf = (id, reach = 'both') => { const set = new Set(); if (!id || !index.has(id)) return set; if (reach === 'in' || reach === 'both') for (const v of adjacency.inbound.get(id)) set.add(v); if (reach === 'out' || reach === 'both') for (const v of adjacency.outbound.get(id)) set.add(v); return set; };
  const budget = labelBudgetOf(scene); const doc = opts.document !== undefined ? opts.document : globalThis.document;
  const labels = createLabels(THREE, { slots, index, budget, scaleM, tokens, doc, reachOf, weightOf }); group.add(labels.mesh);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.07, 8, 48), new THREE.MeshBasicMaterial({ color: col('accent').color, transparent: true, opacity: 0.9, depthWrite: false }));
  ring.name = 'focus-ring'; ring.visible = false; group.add(ring);
  const bounds = new THREE.Box3().setFromObject(group);
  // time: ghosts, beads, now plane, rings (null without views.time)
  const glyphM = mode3d === 'metric' ? 0.15 : GLYPH_RADIUS_PX * mpp * NODE_SCALE_3D;
  const motion = createMotion(THREE, { scene, slots, edges: edges.list, index, frame, mode3d, glyphM, geomOf, col, place, ZERO, tokens }); if (motion) group.add(motion.group);
  const state = { focus: null, visible: null, time: null, shown: null, drawn: { lens: undefined, present: undefined } };
  const sameSet = (a, b) => a === b || (a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((v) => b.has(v)));
  /** Redraw lens x time; node instances are rewritten only when the lens or the present set changed (a tween between two stops moves edges and beads only). */
  const refresh = () => {
    const lens = state.visible; const present = state.time ? state.time.present : null;
    const nodes = state.drawn.lens !== lens || !sameSet(state.drawn.present, present); state.drawn = { lens, present };
    const on = (id) => (!lens || lens.has(id)) && (!present || present.has(id));
    if (nodes) {
      state.shown = lens || present ? new Set(slots.filter((s) => on(s.id)).map((s) => s.id)) : null;
      for (const s of slots) { const shown = on(s.id); s.mesh.setMatrixAt(s.index, shown ? place(s) : ZERO); if (halo && s.haloIndex >= 0) halo.setMatrixAt(s.haloIndex, shown ? haloAt(s) : ZERO); }
      for (const im of [...solid.values(), ...proposal.values(), ...(halo ? [halo] : [])]) im.instanceMatrix.needsUpdate = true;
    }
    edges.write({ visible: lens, phases: state.time ? state.time.phases : null });
    return motion ? motion.apply({ visible: lens, frame: state.time, nodes }) : null;
  };
  const built = {
    group, scene, frame, mode3d, upAxis, positions: P.positions, unplaced: P.unplaced, placement: vrPlacement(scene), ids: slots.map((s) => s.id), index, slots, solid, proposal, halo, edges, regions,
    labels, adjacency, reachOf, ring, state, budget, shapes, motion, bounds,
    counts: { nodes: slots.length, accepted: slots.filter((s) => !s.proposal).length, proposal: slots.filter((s) => s.proposal).length, foreign: foreignSlots.length, edges: edges.list.length, segments: edges.segments, dashed: edges.list.filter((x) => x.dashed).length, regions: regions.length, unplaced: P.unplaced.size, label_budget: budget },
    /** The lens: only these ids are drawn (null = all). */
    setVisible(ids) { state.visible = ids === null || ids === undefined ? null : new Set(ids); refresh(); return state.visible; },
    /** The playhead: a viewer frame detail or a lib/time visibleAt result (null = no time, everything drawn); returns what the time layer drew. */
    setTime(frame) { state.time = normalizeFrame(frame); return refresh(); },
    setFocus(id) {
      state.focus = id && index.has(id) ? id : null; const s = state.focus ? slots[index.get(state.focus)] : null;
      ring.visible = !!s; if (s) { ring.position.set(s.pos[0], s.pos[1], s.pos[2]); ring.scale.setScalar(s.radius * 1.9); }
      return state.focus;
    },
    recolor(next) {
      tokens = isObject(next) ? next : tokens;
      for (const s of slots) s.mesh.setColorAt(s.index, col(s.token).color);
      for (const im of [...solid.values(), ...proposal.values()]) if (im.instanceColor) im.instanceColor.needsUpdate = true;
      haloMat.color.copy(col('foreign').color); ring.material.color.copy(col('accent').color); edges.color();
      for (const r of regions) { const c = col(r.token).color; r.mesh.material.color.copy(c); r.outline.material.color.copy(c); }
      labels.setTokens(tokens); if (motion) motion.recolor(col, tokens);
      return tokens;
    },
    tokens: () => tokens,
    dispose() { for (const g of geoms.values()) g.dispose(); unitBox.dispose(); unitEdges.dispose(); ring.geometry.dispose(); for (const o of group.children) if (o.material && o.material.dispose) o.material.dispose(); labels.dispose(); if (motion) motion.dispose(); for (const ls of [edges.solid, edges.dashed]) ls.geometry.dispose(); },
  };
  return built;
}

// ── mount3d: the browser entry html.mjs's bootstrap calls (renderers/three-mount.mjs) ──
export const mount3d = createMount({ buildScene, colorOf, tokensFromComputed });
export { mount3d as mount }; export default mount3d;
