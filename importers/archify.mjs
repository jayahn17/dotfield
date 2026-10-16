// archify → dotfield scenes (references/IR.md §9). All five archify diagram
// types import: architecture | workflow | dataflow become kind workflow on the
// grid layout (this file), sequence goes through archify-seq.mjs (kind
// sequence) and lifecycle through archify-life.mjs (kind lifecycle); only a
// diagram_type string the importer does not know is refused
// (DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE). The importer never writes positions,
// routes or laid_out: lib/layout lays every imported scene out. The grid types
// keep archify's hand placement as cells — row/col, lane/col (workflow),
// stage/row (dataflow, one column per stage) or the pixel pos ranked into rows
// and columns (architecture) — and pin each node at its cell centre through
// nodes[].pos (normalised to the authored viewBox, which the grid layout
// keeps); archify's routing intent (fromSide/toSide as from_side/to_side,
// route hints) becomes lattice via points in that frame (archify-route.mjs)
// and a colliding label moves along its route (archify-labels.mjs), while
// archify's canvas via/labelAt round-trip under ext.archify
// (references/ARCHIFY_PARITY.md). Shared by all five: every edge keeps its
// source id or is minted e<index>; an order the source does not give is
// derived (breadth-first depth from the start nodes) and, where the scene
// uses it, listed by a non-blocking DF_IMPORT_ORDER_FILLED;
// boundaries|groups|phases|lanes|stages become zone or lane groups; mainPath
// becomes views.interactive.presentation + steps[]; meta.animation 'trace'
// becomes views.time {axis: order, motion: trace}; sources become evidence
// rows (SRC n); cards and every source attribute without a scene field
// round-trip under ext.archify.
import {
  clip, dateOf, evidenceMinter, fail, finishScene, hasBlocking, idMinter, importChecks, isObject, label,
  MAX_SUBLABEL, provenanceFor, sceneSkeleton, seriesFor, slug, sourceDescriptor, sourceDigest, tagList, unit,
} from './common.mjs';
import * as topology from '../lib/gates/topology.mjs';
import { runSequence } from './archify-seq.mjs';
import { runLifecycle } from './archify-life.mjs';
import { latticeCentres, routeGrid } from './archify-route.mjs';
import { placeLabels } from './archify-labels.mjs';
import { routePoints } from '../lib/layout/geometry.mjs';

export const id = 'archify';
export const SUPPORTED = Object.freeze(['architecture', 'workflow', 'dataflow', 'sequence', 'lifecycle']);
/** No archify type is refused by name since importers-parity; an unknown diagram_type string still is. */
export const REFUSED = Object.freeze([]);
export const GRID_TYPES = Object.freeze(['architecture', 'workflow', 'dataflow']);
/** One grid cell in viewBox px (the v1 pitch, so a 3-column import keeps the 300 / 800 / 1300 centres). */
export const CELL = Object.freeze({ w: 500, h: 400, pad: 50, min_w: 1600, min_h: 900 });
const FILE_TYPES = new Set(['datasource', 'datastore', 'artifact', 'file', 'document', 'dataset', 'table', 'bucket', 'queue', 'topic', 'log', 'report']);
const ROUTES = new Set(['auto', 'straight', 'orthogonal']);
const META_KEYS = Object.freeze(['quality_profile', 'visual_preset', 'theme', 'icon', 'description', 'grid']);
const NODE_KEYS = new Set(['id', 'label', 'name', 'title', 'boundary', 'container', 'group', 'parent', 'sources', 'tags', 'weight', 'description', 'sublabel']);
const EDGE_KEYS = new Set(['id', 'from', 'to', 'source', 'target', 'label', 'order', 'weight']);
const SIDES = new Set(['top', 'bottom', 'left', 'right']);
const GROUP_KEYS = new Set(['id', 'label', 'name', 'title']);
const ITEMS = Object.freeze({ sequence: ['participants', 'lifelines', 'actors'], lifecycle: ['states', 'nodes'], grid: ['components', 'nodes', 'elements'] });

export const pick = (o, keys) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== '');
export const rest = (o, keep) => Object.fromEntries(Object.entries(o).filter(([k]) => !keep.has(k)));
export const firstArray = (doc, keys) => keys.map((k) => doc[k]).find(Array.isArray) || [];
export const textOf = (v, max = 120) => (v === undefined || v === null || !String(v).trim() ? null : clip(v, max));
export const intOf = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const metaOf = (doc) => (isObject(doc.meta) ? doc.meta : {});
const itemsOf = (doc, type) => firstArray(doc, ITEMS[GRID_TYPES.includes(type) ? 'grid' : type]).filter((x) => isObject(x) || typeof x === 'string');

export function detect(input) {
  const d = input && input.doc;
  if (!isObject(d)) return false;
  if (typeof d.diagram_type === 'string') return true;
  if ((Array.isArray(d.participants) && Array.isArray(d.messages)) || (Array.isArray(d.states) && Array.isArray(d.transitions))) return true;
  return firstArray(d, ITEMS.grid).length > 0 && (Array.isArray(d.connections) || Array.isArray(d.boundaries));
}

/** The type a file without diagram_type most likely is, by its arrays. */
function assumedType(doc) {
  if (Array.isArray(doc.participants) && Array.isArray(doc.messages)) return 'sequence';
  if (Array.isArray(doc.states) && Array.isArray(doc.transitions)) return 'lifecycle';
  if (Array.isArray(doc.stages) || Array.isArray(doc.flows)) return 'dataflow';
  return Array.isArray(doc.lanes) ? 'workflow' : 'architecture';
}

function diagramType(doc, fails) {
  const raw = typeof doc.diagram_type === 'string' ? doc.diagram_type.trim().toLowerCase() : null;
  if (raw === null) return { type: assumedType(doc), assumed: true };
  if (SUPPORTED.includes(raw)) return { type: raw, assumed: false };
  fails.push(fail('DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE', { path: '$.diagram_type', detail: `'${raw}' is not a diagram type this importer knows; supported: ${SUPPORTED.join(', ')}` }));
  return null;
}

/** Does the topology gate accept two edges of `edgeKind` on one ordered pair at different orders in a `sceneKind` scene? Asked once, never re-implemented. */
const repeatMemo = new Map();
export function repeatsAllowed(sceneKind, edgeKind) {
  const key = `${sceneKind}/${edgeKind}`;
  if (!repeatMemo.has(key)) {
    const e = (eid, order) => ({ id: eid, from: 'a', to: 'b', kind: edgeKind, directed: true, variant: 'solid', route: 'straight', order });
    const probe = { kind: sceneKind, nodes: [{ id: 'a' }, { id: 'b' }], edges: [e('e0', 1), e('e1', 2)] };
    repeatMemo.set(key, !topology.check(probe, { shapes: {} }).some((c) => c.code === 'DF_IR_DUP_EDGE' && c.status === 'fail'));
  }
  return repeatMemo.get(key);
}

/** The scene skeleton, ext.archify (version, presentation fields, meta, cards) and the per-import context the three mappers share. */
export function beginScene(doc, input, opts, dt, kind, layout) {
  const meta = metaOf(doc);
  const capturedOn = dateOf(opts.now);
  const digest = sourceDigest(input);
  const title = pick(meta, ['title', 'name']) ?? pick(doc, ['title', 'name']) ?? input.name.replace(/\.(archify\.)?json$/i, '');
  const scene = sceneSkeleton({ kind, id: slug(opts.id ?? title, 'archify-import'), title, layout, importer: id, name: input.name, digest, opts });
  const ext = { source: input.name, diagram_type: dt.type, archify_version: String(doc.archify_version ?? doc.schema_version ?? doc.version ?? '1') };
  if (dt.assumed) ext.diagram_type_assumed = true;
  for (const k of META_KEYS) { const v = doc[k] ?? meta[k]; if (v !== undefined) ext[k] = v; }
  const metaRest = rest(meta, new Set(['title', 'name', ...META_KEYS]));
  if (Object.keys(metaRest).length) ext.meta = metaRest;
  if (Array.isArray(doc.cards) && doc.cards.length) ext.cards = doc.cards;
  scene.ext.archify = ext;
  return { doc, input, opts, scene, ext, capturedOn, digest, evidence: evidenceMinter(scene), trace: meta.animation === 'trace' || doc.animation === 'trace', fills: [] };
}

/** One node with the import provenance; raw.sources become evidence rows of kind file (SRC n). */
export function makeNode(base, raw, { nid, kind, text, tags, colorToken, group = null }) {
  const evidenceIds = ['ev-1'];
  for (const s of Array.isArray(raw.sources) ? raw.sources : []) {
    const ref = typeof s === 'string' ? s : (isObject(s) ? pick(s, ['path', 'file', 'ref', 'url']) : null);
    if (ref) evidenceIds.push(base.evidence('file', isObject(s) && s.lines ? `${ref}#${s.lines}` : ref, isObject(s) ? (s.digest ?? s.sha256 ?? null) : null));
  }
  const node = {
    id: nid, kind, label: label(text), weight: unit(raw.weight, 0.5), tags: tagList(tags), color_token: colorToken, status: 'accepted',
    provenance: provenanceFor({ importer: id, name: base.input.name, digest: base.digest, owner: base.opts.owner, capturedOn: base.capturedOn }),
    audience: { privacy_level: base.opts.privacy_level ?? 'private', share_rule_ids: [] }, evidence_ids: evidenceIds,
  };
  const sub = pick(raw, ['sublabel', 'description']);
  if (sub) node.sublabel = clip(sub, MAX_SUBLABEL);
  if (group) node.group = group;
  return node;
}

/** Hands out edge ids: the source id slugged, else e<index>; a clash gets -<index + 1>. */
export function edgeIds() {
  const used = new Set();
  return (raw, i) => {
    let eid = slug(raw === undefined || raw === null || raw === '' ? `e${i}` : raw, `e${i}`);
    if (used.has(eid)) eid = `${eid.slice(0, 70)}-${i + 1}`;
    used.add(eid);
    return eid;
  };
}

/**
 * Orders by breadth-first depth: the starts (then, for `sources`, every node no
 * edge enters) sit at depth 0, out-edges are walked in edge order, and nodes
 * still unreached seed a new walk one level below the deepest so far, in node
 * order. An edge's order is its source's depth + 1. Returns orders per edge.
 */
export function bfsOrders(n, edges, starts, { sources = true } = {}) {
  const out = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  edges.forEach(([a, b], k) => { out[a].push(k); if (a !== b) indeg[b] += 1; });
  const depth = new Int32Array(n).fill(-1);
  let deepest = -1;
  const walk = (seeds, d0) => {
    const queue = [];
    for (const s of seeds) if (depth[s] < 0) { depth[s] = d0; queue.push(s); }
    for (let q = 0; q < queue.length; q += 1) {
      const v = queue[q];
      if (depth[v] > deepest) deepest = depth[v];
      for (const k of out[v]) { const w = edges[k][1]; if (depth[w] < 0) { depth[w] = depth[v] + 1; queue.push(w); } }
    }
  };
  const seeds = [...starts];
  if (sources || !seeds.length) for (let i = 0; i < n; i += 1) if (!indeg[i]) seeds.push(i);
  walk(seeds.length ? seeds : (n ? [0] : []), 0);
  for (let i = 0; i < n; i += 1) if (depth[i] < 0) walk([i], deepest + 1);
  return edges.map(([a]) => depth[a] + 1);
}

/** views.time for an order axis: motion trace when archify animates, else the given default. */
export function orderTime(base, motion = 'still') {
  return { axis: 'order', step: 'beat', playhead: null, motion: base.trace && motion === 'still' ? 'trace' : motion };
}

/** One DF_IMPORT_ORDER_FILLED row (non-blocking) and its ext note. */
export function orderFilled(base, path, how, count, total) {
  base.ext.order_filled = { how, edges: count, of: total };
  base.fills.push(fail('DF_IMPORT_ORDER_FILLED', { path, detail: `${count} of ${total} had no order; ${how}` }));
}

/** Rank boxes along one axis: a box opens a new rank when it begins at or past the end of the first box of the current one. */
function rankAxis(boxes, lo, hi) {
  const idx = boxes.map((_, i) => i).sort((a, b) => (boxes[a][lo] - boxes[b][lo]) || (a - b));
  const rank = new Array(boxes.length); let k = -1; let end = -Infinity;
  for (const i of idx) { if (boxes[i][lo] >= end) { k += 1; end = boxes[i][hi]; } rank[i] = k; }
  return rank;
}

const authoredPos = (c) => isObject(c.pos) && Number.isFinite(Number(c.pos.x)) && Number.isFinite(Number(c.pos.y));

/**
 * Every component's grid cell: lane/col, stage/row (dataflow), row/col, or
 * the archify pixel pos (+ size) ranked into rows and columns; a component
 * with an authored normalised pos {x, y} takes no cell. A taken cell moves the
 * later component right; components with no placement fill the rows below.
 */
function cellsOf(doc, comps, type, lanes, stageCount) {
  const raw = comps.map(() => null);
  const pixel = [];
  comps.forEach((c, i) => {
    if (authoredPos(c)) return;
    const row = intOf(c.row); const col = intOf(pick(c, ['col', 'column']));
    if (lanes.has(String(c.lane)) && col !== null) raw[i] = [lanes.get(String(c.lane)), col];
    else if (type === 'dataflow' && intOf(c.stage) !== null) raw[i] = [row ?? 0, intOf(c.stage)];
    else if (row !== null && col !== null) raw[i] = [row, col];
    else if (Array.isArray(c.pos) && c.pos.length === 2 && c.pos.every((v) => Number.isFinite(Number(v)))) pixel.push(i);
  });
  if (pixel.length) {
    const boxes = pixel.map((i) => {
      const [x, y] = comps[i].pos.map(Number); const s = Array.isArray(comps[i].size) ? comps[i].size.map(Number) : [];
      return { x0: x, x1: x + (s[0] > 0 ? s[0] : 120), y0: y, y1: y + (s[1] > 0 ? s[1] : 60) };
    });
    const cols = rankAxis(boxes, 'x0', 'x1'); const rows = rankAxis(boxes, 'y0', 'y1');
    pixel.forEach((i, k) => { raw[i] = [rows[k], cols[k]]; });
  }
  const placed = raw.filter(Boolean);
  const columns = intOf(doc.grid && doc.grid.columns);
  let cols = placed.length ? Math.max(1, stageCount, ...placed.map((c) => c[1] + 1)) : Math.max(1, columns || Math.ceil(Math.sqrt(comps.length)));
  const taken = new Set(); const cells = comps.map(() => null); const moved = new Map();
  comps.forEach((c, i) => {
    if (!raw[i]) return;
    const [r, c0] = raw[i]; let k = c0;
    while (taken.has(`${r}|${k}`)) k += 1;
    if (k !== c0) moved.set(i, [r, c0]);
    taken.add(`${r}|${k}`); cells[i] = [r, k]; if (k + 1 > cols) cols = k + 1;
  });
  const below = placed.length ? Math.max(...cells.filter(Boolean).map((c) => c[0] + 1)) : 0;
  let next = 0;
  comps.forEach((c, i) => {
    if (cells[i] || authoredPos(c)) return;
    cells[i] = [below + Math.floor(next / cols), next % cols]; next += 1;
  });
  const rows = Math.max(1, ...cells.filter(Boolean).map((c) => c[0] + 1));
  return { cells, rows, cols, moved };
}

/** architecture | workflow | dataflow → kind workflow on the grid, every node pinned at its cell centre. */
function runGrid(base, type) {
  const { doc, scene, ext } = base;
  const comps = itemsOf(doc, type).map((c) => (typeof c === 'string' ? { id: c } : c));
  Object.assign(ext, { nodes: {}, boundaries: {}, connections: {} });
  const ids = idMinter(); const groupIds = idMinter(); const groups = new Map();
  const addGroup = (raw, kind, extra = {}) => {
    const key = String(pick(raw, ['id', 'label', 'name', 'title']) ?? `boundary-${groups.size + 1}`);
    if (groupIds.has(key)) return groupIds.get(key);
    const gid = groupIds.mint(key, kind);
    groups.set(gid, { id: gid, label: label(pick(raw, ['label', 'name', 'title']) ?? key), kind, wraps: [], color_token: seriesFor(gid) });
    const leftovers = { ...rest(raw, GROUP_KEYS), ...extra };
    if (Object.keys(leftovers).length) ext.boundaries[gid] = leftovers;
    return gid;
  };
  const lanes = new Map(); const laneGid = [];
  const addLane = (l, extra) => { const key = String(l.id ?? l.label ?? lanes.size); if (!lanes.has(key)) { lanes.set(key, lanes.size); laneGid.push(addGroup({ ...l, id: key }, 'lane', extra)); } };
  (Array.isArray(doc.lanes) ? doc.lanes : []).forEach((l) => { if (isObject(l)) addLane(l); else if (typeof l === 'string') addLane({ id: l }); });
  for (const c of comps) if (typeof c.lane === 'string' && c.lane && !lanes.has(c.lane)) addLane({ id: c.lane }, { undeclared: true });
  const stages = (Array.isArray(doc.stages) ? doc.stages : []).map((x, k) => (isObject(x) ? x : { label: String(x) })).map((x, k) => addGroup({ ...x, id: x.id ?? `stage-${k + 1}`, label: x.label ?? `Stage ${k + 1}` }, 'zone'));
  const listed = (key) => (Array.isArray(doc[key]) ? doc[key] : []).map((g) => (typeof g === 'string' ? { id: g } : g)).filter(isObject);
  const bounds = [...listed('boundaries'), ...listed('containers')].map((b) => [b, addGroup(b, 'zone')]);
  const ranged = listed('groups').map((g) => [g, addGroup(g, 'zone')]);
  const phases = listed('phases').map((g) => [g, addGroup(g, 'zone')]);
  const grid = cellsOf(doc, comps, type, lanes, type === 'dataflow' ? stages.length : 1);
  const width = Math.max(CELL.min_w, 2 * CELL.pad + grid.cols * CELL.w); const height = Math.max(CELL.min_h, 2 * CELL.pad + grid.rows * CELL.h);
  scene.views['2d'] = { layout: 'grid', seed: 0, viewBox: [0, 0, width, height], columns: grid.cols };
  const inRange = (g, col) => { const lo = intOf(g.fromCol ?? g.from_col); const hi = intOf(g.toCol ?? g.to_col); return col !== null && lo !== null && hi !== null && col >= lo && col <= hi; };
  comps.forEach((c, i) => {
    const sourceId = String(pick(c, ['id', 'label', 'name', 'title']) ?? `component-${i + 1}`);
    const nid = ids.mint(sourceId, 'component');
    const member = [];
    const named = pick(c, ['boundary', 'container', 'group', 'parent']);
    if (named !== undefined) member.push(addGroup({ id: String(named) }, 'zone', groupIds.has(String(named)) ? {} : { undeclared: true }));
    if (lanes.has(String(c.lane))) member.push(laneGid[lanes.get(String(c.lane))]);
    for (const [b, gid] of bounds) if (Array.isArray(b.wraps) && b.wraps.map(String).includes(sourceId)) member.push(gid);
    if (type === 'dataflow' && stages[intOf(c.stage)]) member.push(stages[intOf(c.stage)]);
    const col = grid.cells[i] ? grid.cells[i][1] : intOf(c.col);
    for (const [g, gid] of ranged) if ((g.lane === undefined || String(g.lane) === String(c.lane)) && inRange(g, col)) member.push(gid);
    for (const [g, gid] of phases) if (inRange(g, col)) member.push(gid);
    const gid = member[0] ?? null;
    const kindOf = String(c.type ?? c.kind ?? 'component').toLowerCase();
    const node = makeNode(base, c, { nid, kind: FILE_TYPES.has(kindOf) ? 'file' : 'asset', text: pick(c, ['label', 'name', 'title']) ?? sourceId, tags: [kindOf, ...(Array.isArray(c.tags) ? c.tags : [])], colorToken: gid ? groups.get(gid).color_token : 'muted', group: gid });
    // Archify's normalised pos spans the first to the last cell centre; the IR's spans the padded box.
    const span = (v, n) => Math.min(1, Math.max(-1, Number(v))) * (n - 1) / n;
    node.pos = grid.cells[i] ? { x: (2 * grid.cells[i][1] + 1) / grid.cols - 1, y: (2 * grid.cells[i][0] + 1) / grid.rows - 1 } : { x: span(c.pos.x, grid.cols), y: span(c.pos.y, grid.rows) };
    for (const g of new Set(member)) groups.get(g).wraps.push(nid);
    scene.nodes.push(node);
    const leftovers = rest(c, NODE_KEYS);
    ext.nodes[nid] = { ...leftovers, source_id: sourceId };
    if (grid.cells[i]) ext.nodes[nid].cell = grid.cells[i];
    if (grid.moved.has(i)) ext.nodes[nid].cell_taken = grid.moved.get(i);
    if (kindOf !== String(leftovers.type ?? leftovers.kind ?? '')) ext.nodes[nid].type = kindOf;
  });
  scene.groups = [...groups.values()];
  const { dropped } = gridEdges(base, ids);
  const at = new Map(scene.nodes.map((n, i) => [n.id, i]));
  const free = scene.nodes.map((n, i) => (grid.cells[i] ? null : [width / 2 + n.pos.x * (width / 2 - CELL.pad), height / 2 + n.pos.y * (height / 2 - CELL.pad)]));
  const frame = { cols: grid.cols, rows: grid.rows, width, height, pad: CELL.pad, cells: grid.cells, free };
  const routed = routeGrid({ ...frame, edges: scene.edges.filter((e) => !e.via).map((e) => ({ id: e.id, a: at.get(e.from), b: at.get(e.to), route: e.route, hint: ext.connections[e.id] ? ext.connections[e.id].route : undefined, from_side: e.from_side, to_side: e.to_side })) });
  for (const e of scene.edges) if (routed[e.id]) e.via = routed[e.id];
  const centres = latticeCentres(frame);
  const spots = placeLabels({ nodes: scene.nodes, centres, edges: scene.edges, width, height, polyOf: (e) => routePoints(e, centres[at.get(e.from)], centres[at.get(e.to)]) });
  for (const e of scene.edges) if (spots[e.id] !== undefined) e.label_at = spots[e.id];
  const main = (Array.isArray(doc.mainPath) ? doc.mainPath : []).map((x) => ids.get(String(x))).filter(Boolean);
  const index = new Map(scene.nodes.map((n, i) => [n.id, i]));
  const derived = bfsOrders(scene.nodes.length, scene.edges.map((e) => [index.get(e.from), index.get(e.to)]), main.length ? [index.get(main[0])] : []);
  const unordered = scene.edges.filter((e, k) => { if (Number.isInteger(e.order)) return false; e.order = derived[k]; return true; });
  if (base.trace) scene.views.time = orderTime(base, 'trace');
  if (base.trace && unordered.length) orderFilled(base, '$.connections', `derived by breadth-first depth from ${main.length ? `mainPath[0] '${main[0]}'` : 'the nodes no connection enters'}`, unordered.length, scene.edges.length);
  return { main, dropped };
}

/** Via points kept on a grid edge, for a file without archify's schema_version (the v1 importer's format, drawn in the import frame CELL); at most 16 finite [x, y] pairs, else none. */
function viaOf(v) {
  if (!Array.isArray(v) || !v.length || v.length > 16) return null;
  const pts = v.map((p) => (Array.isArray(p) && p.length === 2 ? p.map(Number) : null));
  return pts.every((p) => p && p.every(Number.isFinite)) ? pts : null;
}

/** connections | edges | links | flows → flow edges; one per ordered pair (labels merge), unknown ends and self loops listed. */
function gridEdges(base, ids) {
  const { doc, scene, ext } = base;
  const dropped = []; const seen = new Map(); const mint = edgeIds();
  firstArray(doc, ['connections', 'edges', 'links', 'flows']).forEach((cn, i) => {
    if (!isObject(cn)) return;
    const from = ids.get(pick(cn, ['from', 'source'])); const to = ids.get(pick(cn, ['to', 'target']));
    const eid = mint(cn.id, i);
    const text = textOf(cn.label);
    if (!from || !to || from === to) { dropped.push({ id: eid, from: pick(cn, ['from', 'source']), to: pick(cn, ['to', 'target']), label: text, why: !from || !to ? 'unknown component' : 'self connection' }); return; }
    const key = `${from}>${to}`;
    if (seen.has(key)) {
      const first = seen.get(key);
      if (text && first.label !== text) first.label = clip(first.label ? `${first.label}; ${text}` : text, 120);
      dropped.push({ id: eid, from, to, label: text, why: `duplicate flow, merged into ${first.id}` });
      return;
    }
    const edge = { id: eid, from, to, kind: 'flow', directed: true, variant: 'flow', route: ROUTES.has(cn.route) ? cn.route : 'orthogonal' };
    const order = intOf(cn.order);
    if (order !== null) edge.order = order;
    seen.set(key, edge);
    if (text) edge.label = text;
    const at = pick(cn, ['labelAt', 'label_at']);
    const atNum = typeof at === 'number' || (typeof at === 'string' && Number.isFinite(Number(at)));
    if (atNum) edge.label_at = unit(at, 0.5);
    // archify's own format (it requires schema_version) draws via in archify's canvas frame: it round-trips under ext and archify-route.mjs routes the edge.
    const via = doc.schema_version === undefined ? viaOf(cn.via) : null;
    if (via) edge.via = via;
    for (const [k, f] of [['fromSide', 'from_side'], ['toSide', 'to_side']]) if (SIDES.has(cn[k])) edge[f] = cn[k];
    if (cn.weight !== undefined) edge.weight = unit(cn.weight, 0.5);
    scene.edges.push(edge);
    const consumed = [...EDGE_KEYS, ...(atNum ? ['labelAt', 'label_at'] : []), ...(via ? ['via'] : []), ...(SIDES.has(cn.fromSide) ? ['fromSide'] : []), ...(SIDES.has(cn.toSide) ? ['toSide'] : [])];
    const leftovers = rest(cn, new Set(consumed));
    if (ROUTES.has(cn.route)) delete leftovers.route;
    if (Object.keys(leftovers).length) ext.connections[edge.id] = leftovers;
  });
  if (dropped.length) ext.dropped_connections = dropped;
  return { dropped };
}

/** mainPath (node ids) → presentation (one node per step) and steps[] (the node and the edge that reached it). */
function mainSteps(scene, main) {
  const byPair = new Map(scene.edges.map((e) => [`${e.from}>${e.to}`, e.id]));
  const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
  return main.slice(0, 64).map((nid, k) => {
    const step = { id: `main-${k + 1}`, label: nodes.get(nid).label, nodes: [nid] };
    const via = k > 0 ? byPair.get(`${main[k - 1]}>${nid}`) ?? byPair.get(`${nid}>${main[k - 1]}`) : null;
    if (via) step.edges = [via];
    return step;
  });
}

export function run(input, opts = {}) {
  const doc = input && input.doc;
  const fails = [];
  if (!isObject(doc)) fails.push(fail('DF_IMPORT_FILE_UNREADABLE', { path: '$', detail: `${input ? input.name : 'input'} is not a JSON object` }));
  const dt = isObject(doc) ? diagramType(doc, fails) : null;
  if (dt && !itemsOf(doc, dt.type).length) {
    const key = ITEMS[GRID_TYPES.includes(dt.type) ? 'grid' : dt.type][0];
    fails.push(fail('DF_IMPORT_EMPTY', { path: `$.${key}`, detail: `no ${key}` }));
  }
  if (hasBlocking(importChecks(fails))) return { kind: 'scene', importer: id, scene: null, checks: importChecks(fails), ok: false, source: sourceDescriptor(id, input) };
  const kind = GRID_TYPES.includes(dt.type) ? 'workflow' : dt.type;
  const base = beginScene(doc, input, opts, dt, kind, kind === 'workflow' ? 'grid' : kind);
  let res;
  if (dt.type === 'sequence') res = runSequence(base, itemsOf(doc, dt.type));
  else if (dt.type === 'lifecycle') res = runLifecycle(base, itemsOf(doc, dt.type));
  else res = runGrid(base, dt.type);
  const out = finishScene(base.scene);
  if (kind === 'workflow') {
    out.views.interactive.reach = 'out';
    if (res.main.length) { out.views.interactive.presentation = res.main.slice(0, 64); out.views.interactive.steps = mainSteps(out, res.main); }
  } else {
    if (res.steps) out.views.interactive.steps = res.steps;
    if (res.presentation) out.views.interactive.presentation = res.presentation.slice(0, 64);
  }
  return { kind: 'scene', importer: id, scene: out, checks: importChecks(base.fills), ok: true, dropped: res.dropped, source: sourceDescriptor(id, input) };
}
