// lib/delta.mjs — the before/after diff behind `dotfield compare` (V2_PLAN
// §11 compare). Pure and deterministic: two gate-clean, laid-out scenes of
// one kind in, one delta block out (schemas/scene.schema.json $defs.delta,
// the same object as schemas/delta.schema.json, dotfield.delta/1).
//   pairing  nodes by id; edges by id, then an id-less edge (on either side)
//            by (from, to, kind) in scene order, each such pair one
//            non-blocking DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS row
//   change   added | removed | changed (a non-geometry axis differs) |
//            moved (only geometry differs) | same
//   axes     semantic, topology, geometry, provenance, presentation,
//            evidence, scope: NODE_AXES / EDGE_AXES name the fields; a node's
//            topology also changes when an edge it touches was added,
//            removed or re-pointed, or its group changed
//   from     the before position of every removed node and of every node
//            whose geometry changed (positions beyond MOVE_EPS_PX)
//   viewBox  growViewBox() unites the after views.2d.viewBox with a box of
//            the layout spacing (and the label) around every from, so the
//            after scene only ever grows; viewbox_grown_from records it
// It never judges a change: claims is the constant "no risk assessment".
//
//   diffScenes(before, after, {spacing, before: {ref, digest}, after: {ref, digest}, tokensCss, theme}) -> {delta, checks}
//   growViewBox(scene, delta, {spacing, tokensCss, theme})  -> {scene, grown_from: [x, y, w, h] | null}
//   withDelta(after, delta, opts)  -> the after scene carrying delta (viewBox grown, viewbox_grown_from recorded)
//   deltaDocument(delta)           -> {schema_version: 'dotfield.delta/1', ...delta}
//   edgeKeys(scene)                -> one key per scene.edges entry: its id, else from~to~kind~n
//   countsLine(delta)              -> 'nodes 1 added, 1 removed, ...; edges ...'
import { canonical, sha256 } from './digest.mjs';
import { fail, pass } from './rules.mjs';
import { membership } from './layout/index.mjs';
import { frameOf, roundTo } from './layout/frame.mjs';
import { DEFAULT_LABEL_SIZE, LABEL_LINE_HEIGHT, labelStyle, labelWidth } from './layout/metrics.mjs';

export const DELTA_VERSION = 'dotfield.delta/1';
export const CHANGES = Object.freeze(['added', 'removed', 'changed', 'moved', 'same']);
export const AXES = Object.freeze(['semantic', 'topology', 'geometry', 'provenance', 'presentation', 'evidence', 'scope']);
export const CLAIMS = 'no risk assessment';
/** A paired node whose position moved by more than this many px changed geometry. */
export const MOVE_EPS_PX = 1;
/** Above this unpaired fraction of the smaller scene's nodes the compare is refused (DF_DELTA_NO_STABLE_IDS). */
export const NO_STABLE_IDS_RATIO = 0.8;
/** The fields each axis reads (set-valued fields compare order-free). */
export const NODE_AXES = Object.freeze({
  semantic: ['label', 'sublabel', 'kind', 'tags', 'status', 'fields', 'record_id', 'room'],
  geometry: ['pos', 'pose_m', 'size_m'],
  presentation: ['color_token', 'shape', 'weight'],
  evidence: ['evidence_ids'],
  scope: ['audience', 'boundary'],
});
export const EDGE_AXES = Object.freeze({
  semantic: ['label', 'kind', 'order', 'at'],
  topology: ['from', 'to', 'directed'],
  geometry: ['via', 'from_side', 'to_side'],
  presentation: ['variant', 'route', 'weight', 'label_at'],
  evidence: ['evidence_ids'],
  scope: ['rule_ref'],
});
const SET_FIELDS = new Set(['tags', 'evidence_ids']);
/** The import envelope: on two imports these name the file and the day of the import, never the node. */
const IMPORT_ENVELOPE = Object.freeze(['captured_on']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const finite2 = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const sameValue = (a, b) => canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b);
const asSet = (v) => (Array.isArray(v) ? [...new Set(v.map(String))].sort() : []);

/** One key per scene.edges entry, aligned by index: the edge id, else from~to~kind~n (n counts the id-less edges of that key so far). */
export function edgeKeys(scene) {
  const seen = new Map();
  return (isObject(scene) && Array.isArray(scene.edges) ? scene.edges : []).map((e) => {
    if (!isObject(e)) return null;
    if (typeof e.id === 'string' && e.id) return e.id;
    const base = `${e.from}~${e.to}~${e.kind}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}~${n}`;
  });
}

/**
 * Pair the edges of two scenes: by id first, then every edge still unpaired
 * that lacks an id on at least one side by (from, to, kind), in scene order.
 * -> {pairs: [[bi, ai, byEndpoints]], removed: [bi], added: [ai]}
 */
export function pairEdges(before, after) {
  const B = isObject(before) && Array.isArray(before.edges) ? before.edges : [];
  const A = isObject(after) && Array.isArray(after.edges) ? after.edges : [];
  const hasId = (e) => isObject(e) && typeof e.id === 'string' && e.id !== '';
  const byId = new Map();
  B.forEach((e, i) => { if (hasId(e) && !byId.has(e.id)) byId.set(e.id, i); });
  const usedB = new Set(); const usedA = new Set(); const pairs = [];
  A.forEach((e, ai) => {
    if (!hasId(e) || !byId.has(e.id) || usedB.has(byId.get(e.id))) return;
    pairs.push([byId.get(e.id), ai, false]); usedB.add(byId.get(e.id)); usedA.add(ai);
  });
  const key = (e) => `${e.from}~${e.to}~${e.kind}`;
  A.forEach((e, ai) => {
    if (usedA.has(ai) || !isObject(e)) return;
    const bi = B.findIndex((b, i) => !usedB.has(i) && isObject(b) && key(b) === key(e) && (!hasId(b) || !hasId(e)));
    if (bi < 0) return;
    pairs.push([bi, ai, true]); usedB.add(bi); usedA.add(ai);
  });
  pairs.sort((x, y) => x[1] - y[1]);
  return { pairs, removed: B.map((e, i) => i).filter((i) => isObject(B[i]) && !usedB.has(i)), added: A.map((e, i) => i).filter((i) => isObject(A[i]) && !usedA.has(i)) };
}

function fieldsDiffer(a, b, fields) {
  return fields.some((f) => (SET_FIELDS.has(f) ? canonical(asSet(a[f])) !== canonical(asSet(b[f])) : !sameValue(a[f], b[f])));
}

/** Provenance without the import envelope when both sides came from an import (source.ref, source.digest, captured_on name the file and the day). */
function provenanceKey(p, envelope) {
  if (!isObject(p)) return canonical(null);
  if (!envelope) return canonical(p);
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (IMPORT_ENVELOPE.includes(k)) continue;
    out[k] = k === 'source' && isObject(v) ? { kind: v.kind } : v;
  }
  return canonical(out);
}

const isImport = (n) => isObject(n.provenance) && isObject(n.provenance.source) && n.provenance.source.kind === 'import';

function polylinesDiffer(a, b, eps) {
  const pa = Array.isArray(a) ? a : null; const pb = Array.isArray(b) ? b : null;
  if (!pa || !pb) return !!pa !== !!pb;
  if (pa.length !== pb.length) return true;
  return pa.some((p, i) => !finite2(p) || !finite2(pb[i]) || Math.abs(p[0] - pb[i][0]) > eps || Math.abs(p[1] - pb[i][1]) > eps);
}

function moved(p, q, eps) {
  if (!finite2(p) || !finite2(q)) return finite2(p) !== finite2(q);
  const dx = p[0] - q[0]; const dy = p[1] - q[1];
  return dx * dx + dy * dy > eps * eps;
}

function changeOf(axes) {
  if (axes.some((a) => a !== 'geometry')) return 'changed';
  return axes.length ? 'moved' : 'same';
}

const ordered = (set) => AXES.filter((a) => set.has(a));
const emptyCount = () => ({ added: 0, removed: 0, changed: 0, moved: 0, same: 0 });

function groupsById(scene) {
  const m = membership(scene);
  const out = new Map();
  m.nodes.forEach((n, i) => { if (typeof n.id === 'string') out.set(n.id, m.memberOf[i] >= 0 ? (m.groups[m.memberOf[i]].id ?? null) : null); });
  return out;
}

/** The delta of every edge pair, the added and the removed edges, in after order then before order. */
function diffEdges(before, after, eps) {
  const B = before.edges; const A = after.edges;
  const kb = edgeKeys(before); const ka = edgeKeys(after);
  const { pairs, removed, added } = pairEdges(before, after);
  const rb = isObject(before.routes) ? before.routes : {}; const ra = isObject(after.routes) ? after.routes : {};
  const rows = new Map(); const touched = new Set(); const checks = [];
  for (const [bi, ai, byEnds] of pairs) {
    const b = B[bi]; const a = A[ai]; const axes = new Set();
    for (const [axis, fields] of Object.entries(EDGE_AXES)) if (fieldsDiffer(b, a, fields)) axes.add(axis);
    const routeB = typeof b.id === 'string' ? rb[b.id] : undefined; const routeA = typeof a.id === 'string' ? ra[a.id] : undefined;
    if (polylinesDiffer(routeB, routeA, eps)) axes.add('geometry');
    rows.set(ai, { id: ka[ai], change: changeOf([...axes]), axes: ordered(axes) });
    if (axes.has('topology')) for (const id of [b.from, b.to, a.from, a.to]) touched.add(id);
    if (byEnds) checks.push(fail('DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS', { path: `$.edges[${ai}]`, detail: `${a.from} -> ${a.to} (${a.kind}) paired with before edges[${bi}]` }));
  }
  for (const ai of added) { rows.set(ai, { id: ka[ai], change: 'added', axes: [] }); touched.add(A[ai].from); touched.add(A[ai].to); }
  const out = A.map((e, ai) => rows.get(ai)).filter(Boolean);
  for (const bi of removed) { out.push({ id: kb[bi], change: 'removed', axes: [], ends: [B[bi].from, B[bi].to] }); touched.add(B[bi].from); touched.add(B[bi].to); }
  if (!checks.length) checks.push(pass('DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS'));
  return { rows: out, touched, pairs: pairs.length, byEndpoints: pairs.filter((p) => p[2]).length, checks };
}

function diffNodes(before, after, touched, eps) {
  const pb = isObject(before.positions) ? before.positions : {}; const pa = isObject(after.positions) ? after.positions : {};
  const B = new Map(objects(before.nodes).filter((n) => typeof n.id === 'string').map((n) => [n.id, n]));
  const gb = groupsById(before); const ga = groupsById(after);
  const rows = []; let pairs = 0; const seen = new Set();
  for (const a of objects(after.nodes)) {
    if (typeof a.id !== 'string' || seen.has(a.id)) continue;
    seen.add(a.id);
    const b = B.get(a.id);
    if (!b) { rows.push({ id: a.id, change: 'added', axes: [], label: a.label }); continue; }
    pairs += 1;
    const axes = new Set();
    for (const [axis, fields] of Object.entries(NODE_AXES)) if (fieldsDiffer(b, a, fields)) axes.add(axis);
    if (moved(pb[a.id], pa[a.id], eps)) axes.add('geometry');
    if (touched.has(a.id) || gb.get(a.id) !== ga.get(a.id)) axes.add('topology');
    const envelope = isImport(a) && isImport(b);
    if (provenanceKey(b.provenance, envelope) !== provenanceKey(a.provenance, envelope)) axes.add('provenance');
    const row = { id: a.id, change: changeOf([...axes]), axes: ordered(axes) };
    if (axes.has('geometry') && finite2(pb[a.id])) row.from = [pb[a.id][0], pb[a.id][1]];
    row.label = a.label;
    rows.push(row);
  }
  for (const b of B.values()) {
    if (seen.has(b.id)) continue;
    const row = { id: b.id, change: 'removed', axes: [] };
    if (finite2(pb[b.id])) row.from = [pb[b.id][0], pb[b.id][1]];
    row.label = b.label;
    if (typeof b.kind === 'string') row.kind = b.kind;
    rows.push(row);
  }
  return { rows, pairs };
}

/** 1 - paired / nodes of the smaller scene, 0 when either scene has no node; rounded to 1e-3. */
export function unpairedRatio(pairs, nb, na) {
  const m = nb < na ? nb : na;
  return m > 0 ? roundTo(1 - pairs / m, 3) : 0;
}

function countOf(rows) {
  const c = emptyCount();
  for (const r of rows) c[r.change] += 1;
  return c;
}

/**
 * diffScenes(before, after, opts) -> {delta, checks}
 * Both scenes laid out (compare runs the gates first). A kind mismatch is
 * one blocking DF_DELTA_KIND_MISMATCH and no delta; otherwise the delta and
 * the DF_DELTA_* rows it evaluated (NO_STABLE_IDS blocks above 0.8).
 * opts.before / opts.after: {ref, digest} of the inputs (default: the
 * strings 'before' / 'after' and the canonical scene digest).
 */
export function diffScenes(before, after, opts = {}) {
  const b = isObject(before) ? before : {}; const a = isObject(after) ? after : {};
  const checks = [];
  if (b.kind !== a.kind) {
    checks.push(fail('DF_DELTA_KIND_MISMATCH', { path: '$.kind', detail: `before is ${String(b.kind)}, after is ${String(a.kind)}` }));
    return { delta: null, checks };
  }
  checks.push(pass('DF_DELTA_KIND_MISMATCH'));
  const eps = typeof opts.eps === 'number' && opts.eps >= 0 ? opts.eps : MOVE_EPS_PX;
  const edges = diffEdges({ ...b, edges: objects(b.edges) }, { ...a, edges: objects(a.edges) }, eps);
  const nodes = diffNodes(b, a, edges.touched, eps);
  const nb = new Set(objects(b.nodes).map((n) => n.id)).size; const na = new Set(objects(a.nodes).map((n) => n.id)).size;
  const ratio = unpairedRatio(nodes.pairs, nb, na);
  if (ratio > NO_STABLE_IDS_RATIO) checks.push(fail('DF_DELTA_NO_STABLE_IDS', { path: '$.nodes', detail: `${nodes.pairs} of ${Math.min(nb, na)} nodes of the smaller scene pair by id (unpaired ratio ${ratio})` }));
  else checks.push(pass('DF_DELTA_NO_STABLE_IDS'));
  checks.push(...edges.checks);
  const ref = (side, scene) => (isObject(opts[side]) && typeof opts[side].ref === 'string' && opts[side].ref ? { ref: opts[side].ref, digest: opts[side].digest ?? sha256(canonical(scene)) } : { ref: side, digest: sha256(canonical(scene)) });
  const delta = {
    before: ref('before', b), after: ref('after', a),
    pairs: { nodes: nodes.pairs, edges: edges.pairs, edges_by_endpoints: edges.byEndpoints },
    unpaired_ratio: ratio,
    nodes: nodes.rows, edges: edges.rows,
    counts: { nodes: countOf(nodes.rows), edges: countOf(edges.rows) },
    claims: CLAIMS,
  };
  return { delta, checks };
}

/** The box a ghost or a from mark needs around p: the layout spacing on every side, wider when the label is. */
function coverBox(p, label, spacing, style) {
  const w = typeof label === 'string' && label ? labelWidth(label, style) : 0;
  const h = (style && style.size > 0 ? style.size : DEFAULT_LABEL_SIZE) * LABEL_LINE_HEIGHT;
  const half = Math.max(spacing, w / 2 + 12);
  return [p[0] - half, p[1] - Math.max(spacing, h + 16), p[0] + half, p[1] + Math.max(spacing, h + 24)];
}

/**
 * Unite the scene's views.2d.viewBox with a padded box around every
 * delta.nodes[].from. Grow-only by construction; -> {scene, grown_from}
 * (grown_from: the box before it grew, null when nothing grew).
 */
export function growViewBox(scene, delta, opts = {}) {
  const s = isObject(scene) ? scene : {};
  const frame = frameOf(s);
  const vb = frame.viewBox;
  const spacing = typeof opts.spacing === 'number' && opts.spacing > 0 ? opts.spacing : frame.spacing;
  const style = labelStyle({ tokensCss: opts.tokensCss, theme: opts.theme ?? (isObject(s.meta) ? s.meta.theme : undefined) });
  let [x0, y0, x1, y1] = [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]];
  for (const row of isObject(delta) && Array.isArray(delta.nodes) ? delta.nodes : []) {
    if (!isObject(row) || !finite2(row.from)) continue;
    const box = coverBox(row.from, row.label, spacing, style);
    if (box[0] < x0) x0 = box[0];
    if (box[1] < y0) y0 = box[1];
    if (box[2] > x1) x1 = box[2];
    if (box[3] > y1) y1 = box[3];
  }
  const next = [x0, y0, x1 - x0, y1 - y0].map((v) => roundTo(v, 3));
  if (next.every((v, k) => v === vb[k])) return { scene: s, grown_from: null };
  const views = isObject(s.views) ? { ...s.views } : {};
  views['2d'] = { ...(isObject(views['2d']) ? views['2d'] : {}), viewBox: next };
  return { scene: { ...s, views }, grown_from: [...vb] };
}

/** The after scene that compare renders: the delta attached and the viewBox grown over every from (recorded as delta.viewbox_grown_from). */
export function withDelta(after, delta, opts = {}) {
  const grown = growViewBox(after, delta, opts);
  const d = { ...delta };
  delete d.viewbox_grown_from;
  if (grown.grown_from) d.viewbox_grown_from = grown.grown_from;
  const { claims, ...rest } = d;
  return { ...grown.scene, delta: { ...rest, claims } };
}

/** The standalone dotfield.delta/1 document (delta.json beside out.html). */
export function deltaDocument(delta) {
  return { schema_version: DELTA_VERSION, ...delta };
}

/** One line of counts for the receipt: 'nodes 1 added, 1 removed, 2 changed, 1 moved, 3 same; edges ...'. */
export function countsLine(delta) {
  const part = (c) => CHANGES.map((k) => `${c && Number.isInteger(c[k]) ? c[k] : 0} ${k}`).join(', ');
  const counts = isObject(delta) && isObject(delta.counts) ? delta.counts : {};
  return `nodes ${part(counts.nodes)}; edges ${part(counts.edges)}`;
}
