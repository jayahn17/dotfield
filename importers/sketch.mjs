// dotfield.sketch/1 -> dotfield.scene/1 (V2_PLAN §6, §7.1). A sketch is ten
// lines of JSON: a diagram type, a title, node names, edge lines and groups.
// The expansion is deterministic and pure (no clock: callers pass `now`):
// ids are slugs of the names and labels come from the names; every edge is
// id'd e<index> with order = index (1-based, so a badge reads 1, 2, 3); the
// scene is synthetic_data, prototype, quality checked, owned by the owner,
// audience private, with one evidence row of kind import whose digest is the
// sha256 of the canonical sketch; views 2d, 3d and vr are always written so
// `--view all` renders every tab with no DF_RENDER_VIEW_DISABLED row. Groups
// become zone | discipline | lane | region groups (room: metric boxes around
// the members); sequence edges are messages, lifecycle edges transitions
// (first/last state tagged initial/final unless the sketch tags them). Inline
// x- kinds ride along under ext.kinds, where lib/pipeline.mjs merges them over
// lib/rooms.mjs kindsFor(). Detection keys on schema_version only, never on a
// bare {type, nodes} shape. A field the expansion cannot use is one
// DF_IMPORT_SKETCH_INVALID per path; the gates judge the expanded scene.
import { dayIndex } from '../lib/time/ticks.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { canonical, clip, dateOf, fail, importChecks, isObject, label, scrub, sha256, slug, sourceDescriptor, tagList } from './common.mjs';

export const id = 'sketch';
export const SKETCH_VERSION = 'dotfield.sketch/1';
export const SCENE_VERSION = 'dotfield.scene/1';
/** Per type: scene kind, 2D layout, default direction, group kind, node kind, '->' edge kind, route, variant. */
export const TYPES = Object.freeze({
  architecture: { kind: 'workflow', layout: 'layered', direction: 'down', group: 'zone', node: 'desk', edge: 'flow', route: 'orthogonal', variant: 'solid' },
  workflow: { kind: 'workflow', layout: 'layered', direction: null, group: 'zone', node: 'desk', edge: 'flow', route: 'orthogonal', variant: 'solid' },
  dataflow: { kind: 'workflow', layout: 'layered', direction: 'right', group: 'zone', node: 'record', edge: 'flow', route: 'orthogonal', variant: 'flow' },
  sequence: { kind: 'sequence', layout: 'sequence', direction: null, group: 'lane', node: 'desk', edge: 'message', route: 'straight', variant: 'solid' },
  lifecycle: { kind: 'lifecycle', layout: 'lifecycle', direction: 'right', group: 'lane', node: 'event', edge: 'transition', route: 'orthogonal', variant: 'solid' },
  graph: { kind: 'graph', layout: 'force', direction: null, group: 'discipline', node: 'record', edge: 'relates', route: 'auto', variant: 'solid' },
  timeline: { kind: 'timeline', layout: 'timeline', direction: null, group: 'region', node: 'event', edge: 'precedes', route: 'auto', variant: 'solid' },
  board: { kind: 'board', layout: 'lanes', direction: null, group: 'lane', node: 'note', edge: 'depends', route: 'auto', variant: 'solid' },
  room: { kind: 'room', layout: 'metric', direction: null, group: 'zone', node: 'asset', edge: 'depends', route: 'auto', variant: 'solid' },
});
/** 'a -> b: label' (directed), 'a --> b: label' (directed, dashed), 'a -- b' (undirected); whitespace around the arrow. */
export const EDGE_RE = /^\s*(.+?)\s+(-->|->|--)\s+([^:]+?)\s*(?::\s*(.*?))?\s*$/;
export const ORDER_AXIS_TYPES = Object.freeze(['sequence', 'lifecycle']);
/** Metres of padding around a room group's members (the box always contains every member's pose). */
export const ROOM_PAD_M = 0.4;
const SERIES = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'];
const r3 = (v) => Math.round(v * 1000) / 1000;

let schemaCache = null;
function sketchSchema() { if (!schemaCache) schemaCache = loadSchema('sketch'); return schemaCache; }

export function detect(input) {
  return Boolean(input) && isObject(input.doc) && input.doc.schema_version === SKETCH_VERSION;
}

/** A name with a capital letter is kept as written ('ORB-SLAM3'); a lower-case one is humanised ('pilot-study' -> 'Pilot study'). */
export function labelFrom(name) {
  const s = clip(name, 120);
  if (s !== s.toLowerCase()) return s;
  const words = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : s;
}

const nameOf = (n) => (typeof n === 'string' ? n : n.id);

/** The sketch name a ref carries: the file name without .sketch.json, else the title slug. */
export function sketchName(input, sketch) {
  const raw = input && typeof input.name === 'string' ? input.name.replace(/\.sketch\.json$/i, '').replace(/\.json$/i, '') : '';
  return slug(raw || (isObject(sketch) ? sketch.title : ''), 'sketch');
}

/** Every reason the sketch cannot be expanded: schema errors, then names that do not resolve. [] when it expands. */
export function sketchProblems(sketch) {
  const bad = (path, detail) => fail('DF_IMPORT_SKETCH_INVALID', { path, detail });
  const schemaErrors = validate(sketchSchema(), sketch).errors;
  if (schemaErrors.length) return schemaErrors.map((e) => bad(e.path, `${e.code}: ${e.message}`));
  const out = [];
  const nodes = new Map();
  sketch.nodes.forEach((n, i) => {
    const nid = slug(nameOf(n), '');
    if (nodes.has(nid)) out.push(bad(`$.nodes[${i}]`, `'${nameOf(n)}' is the id '${nid}' of nodes[${nodes.get(nid)}] again`));
    else nodes.set(nid, i);
    const posed = isObject(n) && (n.pose !== undefined || n.size !== undefined);
    if (sketch.type === 'room' && !(isObject(n) && n.pose !== undefined)) out.push(bad(`$.nodes[${i}]`, `a room node needs a pose ([x, y, z] metres); '${nameOf(n)}' has none`));
    else if (sketch.type !== 'room' && posed) out.push(bad(`$.nodes[${i}]`, `pose and size place room nodes; a ${sketch.type} sketch lays '${nameOf(n)}' out`));
  });
  const groups = new Map();
  const memberOf = new Map();
  for (const [gname, members] of Object.entries(isObject(sketch.groups) ? sketch.groups : {})) {
    const gid = slug(gname, '');
    const at = `$.groups[${JSON.stringify(gname)}]`;
    if (groups.has(gid)) out.push(bad(at, `group '${gname}' is the id '${gid}' of group '${groups.get(gid)}' again`));
    groups.set(gid, gname);
    members.forEach((m, j) => {
      const mid = slug(m, '');
      if (!nodes.has(mid)) out.push(bad(`${at}[${j}]`, `'${m}' is not a node`));
      else if (memberOf.has(mid) && memberOf.get(mid) !== gid) out.push(bad(`${at}[${j}]`, `'${m}' is already in group '${memberOf.get(mid)}'; a node has one group`));
      else memberOf.set(mid, gid);
    });
  }
  sketch.nodes.forEach((n, i) => {
    if (!isObject(n) || n.group === undefined) return;
    const gid = slug(n.group, '');
    const nid = slug(n.id, '');
    if (memberOf.has(nid) && memberOf.get(nid) !== gid) out.push(bad(`$.nodes[${i}].group`, `'${n.group}' disagrees with groups, which put '${n.id}' in '${memberOf.get(nid)}'`));
  });
  (Array.isArray(sketch.edges) ? sketch.edges : []).forEach((e, i) => {
    const ends = typeof e === 'string' ? EDGE_RE.exec(e) : null;
    if (typeof e === 'string' && !ends) { out.push(bad(`$.edges[${i}]`, `'${clip(e, 60)}' is not 'a -> b: label', 'a --> b' or 'a -- b'`)); return; }
    const [from, to] = ends ? [ends[1], ends[3]] : [e.from, e.to];
    for (const [k, v] of [['from', from], ['to', to]]) {
      if (!nodes.has(slug(v, ''))) out.push(bad(typeof e === 'string' ? `$.edges[${i}]` : `$.edges[${i}].${k}`, `'${clip(v, 60)}' is not a node${typeof e === 'string' && /\s(?:-->|->|--)\s/.test(v) ? ' (one edge per line: a -> b, then b -> c)' : ''}`));
    }
  });
  return out;
}

/** {from, to, label, directed, dashed, raw} of one edge line or object. */
function parseEdge(e) {
  if (typeof e !== 'string') return { from: e.from, to: e.to, label: e.label ?? null, directed: true, dashed: false, raw: e };
  const m = EDGE_RE.exec(e);
  return { from: m[1], to: m[3], label: m[4] ? m[4] : null, directed: m[2] !== '--', dashed: m[2] === '-->', raw: {} };
}

function autoStep(dates) {
  if (dates.length < 2) return 'month';
  const idx = dates.map(dayIndex);
  const span = Math.max(...idx) - Math.min(...idx);
  if (span <= 21) return 'day';
  if (span <= 180) return 'week';
  return span <= 1500 ? 'month' : 'year';
}

/** views.time: the type's default (order axis for sequence|lifecycle, a date axis for a dated timeline) under the sketch's own block. */
function timeBlock(sketch, nodes) {
  const dates = nodes.map((n) => n.provenance.happened_on).filter((d) => typeof d === 'string');
  const own = isObject(sketch.time) ? sketch.time : null;
  let base = null;
  if (ORDER_AXIS_TYPES.includes(sketch.type)) base = { axis: 'order', step: 'beat', playhead: null, motion: 'still' };
  else if (sketch.type === 'timeline' && dates.length) base = { axis: 'date', field: 'happened_on', step: autoStep(dates), playhead: null, cumulative: true, motion: 'still' };
  if (!own) return base;
  const time = { ...(base ?? {}), ...own };
  if (!time.axis) time.axis = sketch.type === 'timeline' ? 'date' : 'order';
  if (!time.step) time.step = time.axis === 'order' ? 'beat' : autoStep(dates);
  return time;
}

/** A metric box around the members' poses and sizes (room groups). */
function roomBox(members) {
  const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
  for (const n of members) {
    const size = Array.isArray(n.size_m) ? n.size_m : [0, 0, 0];
    for (let k = 0; k < 3; k += 1) { lo[k] = Math.min(lo[k], n.pose_m.xyz[k] - size[k] / 2); hi[k] = Math.max(hi[k], n.pose_m.xyz[k] + size[k] / 2); }
  }
  return { center_xyz_m: lo.map((v, k) => r3((v + hi[k]) / 2)), size_xyz_m: lo.map((v, k) => r3(hi[k] - v + 2 * ROOM_PAD_M)) };
}

/**
 * expandSketch(sketch, {now, name, owner}) -> scene. Pure and deterministic;
 * refuses (TypeError) a sketch sketchProblems() rejects, so call that first.
 */
export function expandSketch(sketch, { now, name = null, owner = 'self' } = {}) {
  const problems = sketchProblems(sketch);
  if (problems.length) throw new TypeError(`expandSketch: ${problems.length} problem(s), first ${problems[0].path}: ${problems[0].message}`);
  const T = TYPES[sketch.type];
  const capturedOn = dateOf(now);
  const digest = sha256(canonical(sketch));
  const sname = slug(name ?? sketch.title, 'sketch');
  const ref = `sketch:${sname}`;
  const sceneId = slug(sketch.title, sname);
  // Groups: the groups map in order, then groups a node object names that the map does not.
  const groupIds = []; const groupLabel = new Map(); const memberOf = new Map();
  const addGroup = (gname) => { const gid = slug(gname); if (!groupLabel.has(gid)) { groupIds.push(gid); groupLabel.set(gid, labelFrom(gname)); } return gid; };
  for (const [gname, members] of Object.entries(isObject(sketch.groups) ? sketch.groups : {})) { const gid = addGroup(gname); for (const m of members) memberOf.set(slug(m), gid); }
  for (const n of sketch.nodes) if (isObject(n) && n.group !== undefined && !memberOf.has(slug(n.id))) memberOf.set(slug(n.id), addGroup(n.group));
  const tokenOf = (gid) => SERIES[groupIds.indexOf(gid) % SERIES.length];
  const tagged = (t) => sketch.nodes.some((n) => isObject(n) && Array.isArray(n.tags) && n.tags.map((x) => String(x).toLowerCase()).includes(t));
  const lifecycle = sketch.type === 'lifecycle';
  const last = sketch.nodes.length - 1;
  const nodes = sketch.nodes.map((raw, i) => {
    const o = isObject(raw) ? raw : {};
    const nid = slug(nameOf(raw));
    const gid = memberOf.get(nid) ?? null;
    const tags = tagList(o.tags ?? []);
    if (lifecycle && i === 0 && !tagged('initial')) tags.unshift('initial');
    if (lifecycle && i === last && !tagged('final')) tags.push('final');
    let color = gid ? tokenOf(gid) : (groupIds.length ? 'muted' : 'series-1');
    if (lifecycle && tags.includes('final')) color = 'good';
    else if (lifecycle && tags.includes('initial')) color = 'accent';
    const provenance = { owner_person_id: owner, source: { kind: 'import', ref, digest }, captured_on: capturedOn };
    if (typeof o.date === 'string') provenance.happened_on = o.date;
    const node = { id: nid, kind: o.kind ?? T.node, label: label(o.label ?? labelFrom(nameOf(raw))), weight: typeof o.weight === 'number' ? o.weight : 0.5, tags, color_token: color, status: 'accepted' };
    if (gid) node.group = gid;
    if (lifecycle) node.shape = 'pill';
    if (o.pose !== undefined) node.pose_m = { xyz: (Array.isArray(o.pose) ? o.pose : o.pose.xyz).map(Number), rpy: Array.isArray(o.pose) || !o.pose.rpy ? [0, 0, 0] : o.pose.rpy.map(Number) };
    if (o.size !== undefined) node.size_m = o.size.map(Number);
    return { ...node, provenance, audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: ['ev-1'] };
  });
  const groups = groupIds.map((gid) => {
    const members = nodes.filter((n) => n.group === gid);
    const g = { id: gid, label: label(groupLabel.get(gid)), kind: T.group };
    Object.assign(g, sketch.type === 'room' ? roomBox(members) : { wraps: members.map((n) => n.id) });
    g.color_token = tokenOf(gid);
    return g;
  });
  const edges = (Array.isArray(sketch.edges) ? sketch.edges : []).map((e, i) => {
    const p = parseEdge(e);
    const edge = { id: `e${i + 1}`, from: slug(p.from), to: slug(p.to), kind: p.raw.kind ?? (p.directed ? T.edge : 'relates'), directed: p.directed };
    if (p.label) edge.label = clip(p.label, 120);
    edge.order = Number.isInteger(p.raw.order) ? p.raw.order : i + 1;
    if (p.raw.from_side) edge.from_side = p.raw.from_side;
    if (p.raw.to_side) edge.to_side = p.raw.to_side;
    edge.variant = p.dashed ? 'dashed' : (edge.kind === T.edge ? T.variant : 'solid');
    edge.route = T.route;
    return edge;
  });
  const view2d = { layout: T.layout, seed: 7 };
  const direction = sketch.direction ?? T.direction;
  if (direction && (T.layout === 'layered' || T.layout === 'lifecycle')) view2d.direction = direction;
  const room = sketch.type === 'room';
  const views = {
    '2d': view2d,
    '3d': { layout: room ? 'metric' : (sketch.type === 'timeline' ? 'tier-wall' : 'lift'), scale_m: room ? 1 : 6 },
    vr: { enabled: true, scale_m: room ? 1 : 4, entry_node: nodes[0].id },
    interactive: { focus: null, reach: 'both', lenses: groups.slice(0, 32).map((g) => ({ id: `lens-${g.id}`.slice(0, 80), label: g.label, match: { groups: [g.id] } })), presentation: [], deep_link: true },
  };
  const time = timeBlock(sketch, nodes);
  if (time) views.time = time;
  const meta = { id: sceneId, title: label(sketch.title), output: `${sceneId}.html`, theme: sketch.theme ?? 'studio', quality: 'checked', units: 'm', up_axis: 'y', privacy_mode: 'synthetic_data', maturity: 'prototype', legend: true };
  if (typeof sketch.description === 'string' && sketch.description) meta.description = clip(sketch.description, 500);
  const ext = { sketch: { name: sname, type: sketch.type, digest } };
  if (isObject(sketch.kinds) && Object.keys(sketch.kinds).length) ext.kinds = structuredClone(sketch.kinds);
  const scene = {
    schema_version: SCENE_VERSION, kind: T.kind, meta, viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups, nodes, edges, views, evidence: [{ id: 'ev-1', kind: 'import', ref, digest, label: 'SRC 1' }], ext,
  };
  const cleaned = scrub(scene);
  if (cleaned.strings || cleaned.keys) cleaned.value.ext.scrubbed = { strings: cleaned.strings, keys: cleaned.keys };
  return cleaned.value;
}

/** Importer entry: {kind: 'scene', importer: 'sketch', scene, checks, ok, source}; never throws on a bad sketch. */
export function run(input, opts = {}) {
  const sketch = input ? input.doc : undefined;
  const source = sourceDescriptor(id, input ?? {});
  const fails = isObject(sketch) ? sketchProblems(sketch) : [fail('DF_IMPORT_SKETCH_INVALID', { path: '$', detail: 'not a JSON object' })];
  if (fails.length) return { kind: 'scene', importer: id, scene: null, checks: importChecks(fails), ok: false, source };
  const scene = expandSketch(sketch, { now: opts.now, name: sketchName(input, sketch), owner: typeof opts.owner === 'string' && opts.owner ? opts.owner : 'self' });
  return { kind: 'scene', importer: id, scene, checks: importChecks([]), ok: true, source };
}
