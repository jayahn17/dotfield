// Gate "topology": the DF_IR_* family over nodes, edges, groups and evidence;
// the views that reference them and the views.time window are checked by
// lib/gates/topology-views.mjs under the same gate id. Pure over (scene, ctx);
// never throws; a document that is not a scene yields an empty topology (the
// schema gate is the one that reports its shape). One check per code: pass,
// or one fail per offending path.
//
//   check(scene, ctx) -> check[]
//   ctx.shapes   (optional) renderers/shapes.json content, kind -> row; when
//                absent the gate reads renderers/shapes.json once if it exists.
//                An x-<custom> kind is known only with a row.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '../digest.mjs';
import { codesForFamily, fail, pass } from '../rules.mjs';
import { checkViews } from './topology-views.mjs';

export const id = 'topology';

export const SCENE_KINDS = Object.freeze(['graph', 'room', 'timeline', 'board', 'workflow', 'meet', 'sequence', 'lifecycle']);
export const NODE_KINDS = Object.freeze(['record', 'note', 'person', 'desk', 'tag', 'file', 'asset', 'event', 'place', 'boundary', 'annotation', 'idea']);
export const EDGE_KINDS = Object.freeze(['relates', 'link', 'cites', 'influences', 'depends', 'member', 'contains', 'precedes', 'flow', 'share', 'annotates', 'candidate', 'message', 'transition']);
export const GROUP_KINDS = Object.freeze(['region', 'discipline', 'circle', 'zone', 'lane', 'person']);
/** Edge kinds that carry an order and an id wherever they appear. */
export const ORDERED_EDGE_KINDS = Object.freeze(['message', 'transition']);
/** Scene kinds whose layouts draw a self edge as a loop, so DF_IR_SELF_EDGE does not apply. */
export const SELF_LOOP_SCENE_KINDS = Object.freeze(['sequence', 'lifecycle']);
/** 2D modes that key routes by edge id, so every edge needs one (DF_IR_EDGE_ID_REQUIRED). */
export const ROUTED_MODES = Object.freeze(['layered', 'sequence', 'lifecycle']);
export const X_KIND_RE = /^x-[a-z0-9][a-z0-9-]{0,30}$/;
export const PROPOSAL_SOURCE_KINDS = Object.freeze(['run', 'import']);
export const LIMITS = Object.freeze({
  max_nodes: 2000,
  fields_budget_bytes: 1024 * 1024,
  field_bytes: 4096,
  field_string_bytes: 1024,
});

const SHAPES_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderers', 'shapes.json');
let shapesCache;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function list(v) { return Array.isArray(v) ? v : []; }
function objects(v) { return list(v).map((x, i) => [x, i]).filter(([x]) => isObject(x)); }
function bytes(v) { return Buffer.byteLength(canonical(v), 'utf8'); }

/** renderers/shapes.json as kind -> row, or {} while render-2d has not shipped it. */
function loadShapes() {
  if (shapesCache !== undefined) return shapesCache;
  shapesCache = {};
  try {
    if (existsSync(SHAPES_FILE)) shapesCache = normalizeShapes(JSON.parse(readFileSync(SHAPES_FILE, 'utf8')));
  } catch { shapesCache = {}; }
  return shapesCache;
}

function normalizeShapes(raw) {
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter((r) => isObject(r) && typeof r.kind === 'string').map((r) => [r.kind, r]));
  if (!isObject(raw)) return {};
  return isObject(raw.kinds) ? raw.kinds : raw;
}

/** Is `kind` renderable: in the vocabulary, or an x- kind with a shapes.json row? */
export function kindKnown(kind, ctx = {}) {
  if (typeof kind !== 'string') return false;
  if (NODE_KINDS.includes(kind)) return true;
  if (!X_KIND_RE.test(kind)) return false;
  const given = ctx && (isObject(ctx.shapes) || Array.isArray(ctx.shapes));
  const shapes = given ? normalizeShapes(ctx.shapes) : loadShapes();
  return Object.hasOwn(shapes, kind);
}

function checkNodes(scene, ctx, F, index) {
  const { groupIds, evidenceIds } = index;
  const firstAt = new Map();
  let fieldsTotal = 0;
  for (const [n, i] of objects(scene.nodes)) {
    const p = `$.nodes[${i}]`;
    if (typeof n.id === 'string') {
      if (firstAt.has(n.id)) F('DF_IR_DUP_ID', `${p}.id`, `'${n.id}' is also nodes[${firstAt.get(n.id)}].id`);
      else firstAt.set(n.id, i);
    }
    if (!kindKnown(n.kind, ctx)) F('DF_IR_KIND_UNKNOWN', `${p}.kind`, `'${String(n.kind)}' is not in the vocabulary${X_KIND_RE.test(String(n.kind)) ? ' and has no renderers/shapes.json row' : ''}`);
    if (n.group !== undefined && !groupIds.has(n.group)) F('DF_IR_GROUP_UNDECLARED', `${p}.group`, `'${String(n.group)}' is not in groups[]`);
    for (const [ev, j] of list(n.evidence_ids).map((x, j) => [x, j])) {
      if (!evidenceIds.has(ev)) F('DF_IR_EVIDENCE_UNKNOWN', `${p}.evidence_ids[${j}]`, `'${String(ev)}' is not in evidence[]`);
    }
    const sourceKind = isObject(n.provenance) && isObject(n.provenance.source) ? n.provenance.source.kind : undefined;
    if (n.status === 'proposal' && !PROPOSAL_SOURCE_KINDS.includes(sourceKind)) {
      F('DF_IR_PROPOSAL_NO_PROVENANCE', `${p}.provenance.source`, `status proposal with source.kind ${sourceKind === undefined ? 'absent' : `'${String(sourceKind)}'`}`);
    }
    const hasBlock = isObject(n.boundary);
    if (n.kind === 'boundary' && !hasBlock) F('DF_IR_BOUNDARY_BLOCK', `${p}.boundary`, `boundary node '${String(n.id)}' carries no boundary block`);
    if (n.kind !== 'boundary' && hasBlock) F('DF_IR_BOUNDARY_BLOCK', `${p}.boundary`, `a boundary block on a node of kind '${String(n.kind)}'`);
    if (isObject(n.fields)) fieldsTotal += checkFields(n.fields, `${p}.fields`, F);
  }
  if (fieldsTotal > LIMITS.fields_budget_bytes) F('DF_IR_FIELDS_BUDGET', '$.nodes', `${fieldsTotal} bytes of fields > ${LIMITS.fields_budget_bytes}`);
  if (list(scene.nodes).length > LIMITS.max_nodes) F('DF_IR_TOO_LARGE', '$.nodes', `${scene.nodes.length} nodes > ${LIMITS.max_nodes}`);
  if (scene.kind === 'lifecycle' && !objects(scene.nodes).some(([n]) => list(n.tags).includes('initial'))) {
    F('DF_IR_LIFECYCLE_NO_INITIAL', '$.nodes', `no node of the lifecycle scene is tagged initial (${objects(scene.nodes).length} nodes)`);
  }
}

/** views.2d.layout when authored, else undefined (the layout gate reports an unknown mode). */
function mode2dOf(scene) {
  const views = isObject(scene.views) ? scene.views : {};
  const v2 = isObject(views['2d']) ? views['2d'] : {};
  return typeof v2.layout === 'string' ? v2.layout : undefined;
}

/** Per-node fields size rules; returns the canonical byte size of the map. */
function checkFields(fields, p, F) {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') {
      const b = Buffer.byteLength(v, 'utf8');
      if (b > LIMITS.field_string_bytes) F('DF_IR_FIELD_TOO_LARGE', `${p}.${k}`, `string value is ${b} bytes > ${LIMITS.field_string_bytes}`);
    }
  }
  const size = bytes(fields);
  if (size > LIMITS.field_bytes) F('DF_IR_FIELD_TOO_LARGE', p, `fields map is ${size} bytes > ${LIMITS.field_bytes}`);
  return size;
}

function checkGroups(scene, F, index) {
  const { nodeIds } = index;
  const metric = scene.kind === 'room';
  const firstAt = new Map();
  for (const [g, i] of objects(scene.groups)) {
    const p = `$.groups[${i}]`;
    if (typeof g.id === 'string') {
      if (firstAt.has(g.id)) F('DF_IR_GROUP_DUP_ID', `${p}.id`, `'${g.id}' is also groups[${firstAt.get(g.id)}].id`);
      else firstAt.set(g.id, i);
    }
    const wraps = Array.isArray(g.wraps);
    const box = g.center_xyz_m !== undefined || g.size_xyz_m !== undefined;
    const fullBox = g.center_xyz_m !== undefined && g.size_xyz_m !== undefined;
    if (wraps && box) F('DF_IR_GROUP_SHAPE', p, `'${String(g.id)}' declares both wraps[] and a metric box`);
    else if (!wraps && !box) F('DF_IR_GROUP_SHAPE', p, `'${String(g.id)}' declares neither wraps[] nor a metric box`);
    else if (box && !fullBox) F('DF_IR_GROUP_SHAPE', p, `'${String(g.id)}' needs both center_xyz_m and size_xyz_m`);
    else if (metric && wraps) F('DF_IR_GROUP_SHAPE', p, `'${String(g.id)}' wraps[] in a metric room scene; use center_xyz_m and size_xyz_m`);
    else if (!metric && box) F('DF_IR_GROUP_SHAPE', p, `'${String(g.id)}' carries a metric box in a ${String(scene.kind)} scene; use wraps[]`);
    if (wraps) {
      g.wraps.forEach((w, j) => { if (!nodeIds.has(w)) F('DF_IR_GROUP_MEMBER_UNKNOWN', `${p}.wraps[${j}]`, `'${String(w)}' is not in nodes[]`); });
    }
  }
}

function checkEdges(scene, F, index) {
  const { nodeIds, evidenceIds } = index;
  const seenKey = new Map();
  const seenId = new Map();
  const selfLoops = SELF_LOOP_SCENE_KINDS.includes(scene.kind);
  const routed = ROUTED_MODES.includes(mode2dOf(scene));
  const sequence = scene.kind === 'sequence';
  for (const [e, i] of objects(scene.edges)) {
    const p = `$.edges[${i}]`;
    for (const end of ['from', 'to']) {
      if (!nodeIds.has(e[end])) F('DF_IR_DANGLING_EDGE', `${p}.${end}`, `'${String(e[end])}' is not in nodes[]`);
    }
    if (e.from !== undefined && e.from === e.to && !selfLoops) F('DF_IR_SELF_EDGE', p, `'${String(e.from)}' connects to itself`);
    const ordered = ORDERED_EDGE_KINDS.includes(e.kind);
    if ((ordered || sequence) && !Number.isInteger(e.order)) {
      F('DF_IR_ORDER_MISSING', `${p}.order`, `${ordered ? `${e.kind} edge` : `edge of a sequence scene`} ${String(e.from)} -> ${String(e.to)} has no integer order`);
    }
    if ((ordered || routed) && !(typeof e.id === 'string' && e.id.length > 0)) {
      F('DF_IR_EDGE_ID_REQUIRED', `${p}.id`, `${ordered ? `${e.kind} edge` : `edge of a ${mode2dOf(scene)} layout`} ${String(e.from)} -> ${String(e.to)} has no id`);
    }
    if (typeof e.id === 'string') {
      if (seenId.has(e.id)) F('DF_IR_DUP_EDGE', `${p}.id`, `edge id '${e.id}' is also edges[${seenId.get(e.id)}].id`);
      else seenId.set(e.id, i);
    }
    const ends = e.directed === false ? [String(e.from), String(e.to)].sort() : [String(e.from), String(e.to)];
    // In a sequence scene each beat is its own row, so a repeated message on one pair (a retry, a second request) is a second edge when its order differs.
    const beat = sequence && Number.isInteger(e.order) ? `\u0000${e.order}` : '';
    const key = `${ends[0]}\u0000${ends[1]}\u0000${String(e.kind)}${beat}`;
    if (seenKey.has(key)) F('DF_IR_DUP_EDGE', p, `same from, to and kind as edges[${seenKey.get(key)}]`);
    else seenKey.set(key, i);
    if (e.kind === 'share' && (typeof e.rule_ref !== 'string' || !e.rule_ref)) F('DF_IR_SHARE_EDGE_NO_RULE', `${p}.rule_ref`, `share edge ${String(e.from)} -> ${String(e.to)} has no rule_ref`);
    if (e.kind === 'candidate' && scene.kind !== 'meet') F('DF_IR_CANDIDATE_OUTSIDE_MEET', `${p}.kind`, `candidate edge in a ${String(scene.kind)} scene`);
    list(e.evidence_ids).forEach((ev, j) => { if (!evidenceIds.has(ev)) F('DF_IR_EVIDENCE_UNKNOWN', `${p}.evidence_ids[${j}]`, `'${String(ev)}' is not in evidence[]`); });
  }
}

/** Gate entry. */
export function check(scene, ctx = {}) {
  const fails = new Map();
  const F = (code, path, detail) => {
    if (!fails.has(code)) fails.set(code, []);
    fails.get(code).push(fail(code, { path, detail }));
  };
  try {
    const s = isObject(scene) ? scene : {};
    const index = {
      nodeIds: new Set(objects(s.nodes).map(([n]) => n.id).filter((x) => typeof x === 'string')),
      groupIds: new Set(objects(s.groups).map(([g]) => g.id).filter((x) => typeof x === 'string')),
      evidenceIds: new Set(objects(s.evidence).map(([e]) => e.id).filter((x) => typeof x === 'string')),
      edgeIds: new Set(objects(s.edges).map(([e]) => e.id).filter((x) => typeof x === 'string')),
    };
    checkNodes(s, ctx, F, index);
    checkGroups(s, F, index);
    checkEdges(s, F, index);
    checkViews(s, F, index);
  } catch (e) {
    // Unreachable by design (every input shape is guarded); reported, never thrown.
    F('DF_IR_KIND_UNKNOWN', '$', `topology gate stopped: ${e && e.message ? e.message : String(e)}`);
  }
  const out = [];
  for (const code of codesForFamily('ir')) {
    if (fails.has(code)) out.push(...fails.get(code));
    else out.push(pass(code));
  }
  return out;
}
