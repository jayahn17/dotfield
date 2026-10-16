// archify lifecycle → kind lifecycle (references/IR.md §9). States become pill
// nodes of kind event (V2_PLAN decision 1: no state kind), coloured by their
// archify type and tagged initial (a start type; else the lowest `step`; else
// the first state no transition enters) and final (a terminal|final|end
// type, an archify tag terminal|final, or a state no transition leaves);
// lanes become lane groups; transitions become transition edges with
// fromSide/toSide as from_side/to_side. States numbered by `step` are the
// main rail archify draws in step order: two consecutive steps no transition
// joins get an implied transition (ext.archify.rail lists them). A
// transition without an integer order takes the breadth-first depth of its
// source from the initial state + 1 (DF_IMPORT_ORDER_FILLED, non-blocking).
// Archify's via points are pixels of archify's own canvas, so they round-trip
// under ext.archify.transitions and lib/layout routes every transition. A
// second transition on one ordered pair is kept only where the topology gate
// allows it (repeatsAllowed: DF_IR_DUP_EDGE), else its label merges into the
// first. views.2d {layout: lifecycle, direction: right} has no viewBox (the
// layout sizes it); views.time steps by beat with motion playback; steps[]
// are the default playback walk (lib/layout/lifecycle.mjs), each moving the
// playhead to the order of the transition that reached its state.
import { clip, idMinter, isObject, label, seriesFor, unit } from './common.mjs';
import { defaultLifecycleSteps } from '../lib/layout/lifecycle.mjs';
import { bfsOrders, edgeIds, firstArray, intOf, makeNode, orderFilled, orderTime, pick, repeatsAllowed, rest, textOf } from './archify.mjs';

export const START_TYPES = Object.freeze(['start', 'initial', 'entry', 'begin']);
export const FINAL_TYPES = Object.freeze(['terminal', 'final', 'end', 'exit']);
/** Archify state type → colour token; any other type takes its lane's series colour. */
export const TYPE_TOKENS = Object.freeze({ start: 'accent', initial: 'accent', entry: 'accent', decision: 'accent-2', waiting: 'warn', success: 'good', failure: 'bad', error: 'bad' });
/** Archify transition variants drawn dashed; every other variant is solid. */
export const DASHED_VARIANTS = Object.freeze(['dashed', 'return', 'async']);
const SIDES = new Set(['top', 'bottom', 'left', 'right']);
const STATE_KEYS = new Set(['id', 'label', 'name', 'title', 'sublabel', 'description', 'lane', 'tags', 'weight', 'sources']);
const TRANSITION_KEYS = new Set(['id', 'from', 'to', 'source', 'target', 'label', 'event', 'trigger', 'order', 'fromSide', 'toSide', 'from_side', 'to_side', 'weight']);
const stepOf = (s) => { const v = typeof s.step === 'string' ? Number.parseFloat(s.step) : s.step; return Number.isFinite(v) ? v : null; };

export function runLifecycle(base, items) {
  const { doc, scene, ext } = base;
  scene.views['2d'] = { layout: 'lifecycle', direction: 'right', seed: 0 };
  Object.assign(ext, { states: {}, transitions: {} });
  const ids = idMinter(); const laneIds = idMinter(); const lanes = new Map(); const dropped = [];
  const addLane = (l, extra = {}) => {
    const key = String(pick(l, ['id', 'label', 'name']) ?? `lane-${lanes.size + 1}`);
    if (laneIds.has(key)) return laneIds.get(key);
    const gid = laneIds.mint(key, 'lane');
    lanes.set(gid, { id: gid, label: label(pick(l, ['label', 'name', 'title']) ?? key), kind: 'lane', wraps: [], color_token: seriesFor(gid) });
    const leftovers = { ...rest(l, new Set(['id', 'label', 'name', 'title'])), ...extra };
    if (Object.keys(leftovers).length) (ext.lanes ??= {})[gid] = leftovers;
    return gid;
  };
  for (const l of Array.isArray(doc.lanes) ? doc.lanes : []) if (isObject(l)) addLane(l); else if (typeof l === 'string') addLane({ id: l });
  const states = [];
  items.forEach((raw, i) => {
    const s = typeof raw === 'string' ? { id: raw } : raw;
    const sourceId = String(pick(s, ['id', 'label', 'name', 'title']) ?? `state-${i + 1}`);
    if (ids.has(sourceId)) { dropped.push({ state: sourceId, why: 'duplicate state' }); return; }
    const nid = ids.mint(sourceId, 'state');
    const type = String(s.type ?? s.kind ?? 'state').toLowerCase();
    const gid = s.lane !== undefined && s.lane !== null && s.lane !== '' ? addLane({ id: String(s.lane) }, laneIds.has(String(s.lane)) ? {} : { undeclared: true }) : null;
    const node = makeNode(base, s, { nid, kind: 'event', text: pick(s, ['label', 'name', 'title']) ?? sourceId, tags: [type, ...(Array.isArray(s.tags) ? s.tags : [])], colorToken: TYPE_TOKENS[type] ?? (gid ? lanes.get(gid).color_token : 'muted'), group: gid });
    node.shape = 'pill';
    if (gid) lanes.get(gid).wraps.push(nid);
    scene.nodes.push(node); states.push({ s, nid, type });
    ext.states[nid] = { ...rest(s, STATE_KEYS), source_id: sourceId };
  });
  scene.groups = [...lanes.values()];

  const keep = repeatsAllowed('lifecycle', 'transition');
  const mint = edgeIds(); const pairs = new Map(); const explicit = new Set();
  const trs = firstArray(doc, ['transitions', 'edges']).filter(isObject);
  trs.forEach((t, k) => {
    const fromRaw = pick(t, ['from', 'source']); const toRaw = pick(t, ['to', 'target']);
    const from = ids.get(fromRaw); const to = ids.get(toRaw);
    const eid = mint(t.id, k); const text = textOf(pick(t, ['label', 'event', 'trigger']));
    if (!from || !to) { dropped.push({ id: eid, from: fromRaw, to: toRaw, label: text, why: 'unknown state' }); return; }
    const pair = `${from}>${to}`;
    if (!keep && pairs.has(pair)) {
      const first = pairs.get(pair);
      if (text && first.label !== text) first.label = clip(first.label ? `${first.label}; ${text}` : text, 120);
      dropped.push({ id: eid, from, to, label: text, why: `repeated transition, merged into ${first.id} (DF_IR_DUP_EDGE: one transition per from and to)` });
      return;
    }
    const edge = { id: eid, from, to, kind: 'transition', directed: true };
    if (text) edge.label = text;
    if (intOf(t.order) !== null) { edge.order = intOf(t.order); explicit.add(eid); }
    edge.variant = DASHED_VARIANTS.includes(String(t.variant ?? '').toLowerCase()) ? 'dashed' : 'solid';
    edge.route = 'orthogonal';
    const fs = t.fromSide ?? t.from_side; const ts = t.toSide ?? t.to_side;
    if (SIDES.has(fs)) edge.from_side = fs;
    if (SIDES.has(ts)) edge.to_side = ts;
    if (t.weight !== undefined) edge.weight = unit(t.weight, 0.5);
    pairs.set(pair, edge); scene.edges.push(edge);
    const leftovers = rest(t, TRANSITION_KEYS);
    if (Object.keys(leftovers).length) ext.transitions[eid] = leftovers;
  });
  if (dropped.length) ext.dropped_transitions = dropped;

  // The main rail: states numbered by step, joined in step order where the file has no transition.
  const rail = states.filter((x) => stepOf(x.s) !== null).sort((a, b) => (stepOf(a.s) - stepOf(b.s)) || (states.indexOf(a) - states.indexOf(b)));
  const implied = [];
  for (let k = 1; k < rail.length; k += 1) {
    const from = rail[k - 1].nid; const to = rail[k].nid;
    if (pairs.has(`${from}>${to}`)) continue;
    const edge = { id: mint(null, trs.length + implied.length), from, to, kind: 'transition', directed: true, variant: 'solid', route: 'orthogonal' };
    pairs.set(`${from}>${to}`, edge); scene.edges.push(edge); implied.push(edge.id);
  }
  if (rail.length) ext.rail = { states: rail.map((x) => x.nid), implied };

  const index = new Map(scene.nodes.map((n, i) => [n.id, i]));
  const outdeg = new Int32Array(scene.nodes.length); const indeg = new Int32Array(scene.nodes.length);
  for (const e of scene.edges) if (e.from !== e.to) { outdeg[index.get(e.from)] += 1; indeg[index.get(e.to)] += 1; }
  let initial = states.filter((x) => START_TYPES.includes(x.type));
  if (!initial.length && rail.length) { initial = [rail[0]]; ext.initial_assumed = 'the lowest step'; }
  if (!initial.length) { const src = states.find((x) => !indeg[index.get(x.nid)]); initial = [src ?? states[0]].filter(Boolean); ext.initial_assumed = src ? 'the first state no transition enters' : 'the first state'; }
  const isInitial = new Set(initial.map((x) => x.nid));
  for (const x of states) {
    const node = scene.nodes[index.get(x.nid)];
    const tag = String(x.s.tag ?? '').toLowerCase();
    if (isInitial.has(x.nid)) node.tags = [...node.tags.filter((t) => t !== 'final'), 'initial'];
    else if (FINAL_TYPES.includes(x.type) || tag === 'terminal' || tag === 'final' || !outdeg[index.get(x.nid)]) node.tags = [...node.tags.filter((t) => t !== 'initial' && t !== 'final'), 'final'];
    else node.tags = node.tags.filter((t) => t !== 'initial' && t !== 'final');
  }

  const derived = bfsOrders(scene.nodes.length, scene.edges.map((e) => [index.get(e.from), index.get(e.to)]), initial.map((x) => index.get(x.nid)), { sources: false });
  const filled = scene.edges.filter((e, k) => { if (explicit.has(e.id)) return false; e.order = derived[k]; return true; });
  if (filled.length) orderFilled(base, '$.transitions', `derived as the breadth-first depth of the source from ${initial.map((x) => `'${x.nid}'`).join(', ')} + 1`, filled.length, scene.edges.length);
  scene.views.time = orderTime(base, 'playback');
  const orderOf = new Map(scene.edges.map((e) => [e.id, e.order]));
  const steps = defaultLifecycleSteps(scene).slice(0, 64).map((st, k) => {
    const at = st.edges.length ? orderOf.get(st.edges[0]) : (k === 0 ? 0 : null);
    return Number.isInteger(at) ? { ...st, playhead: at } : st;
  });
  return { steps, presentation: steps.map((st) => st.nodes[0]), dropped };
}
