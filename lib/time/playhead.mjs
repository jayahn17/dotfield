// The one playhead (V2_PLAN §5): views.time read with its defaults filled, and
// the pure function from (scene, t) to what is visible at t. Nothing here
// animates; motion is a viewer tween between two stills this module computes.
//
//   timeOf(scene)              -> the time block with defaults, or null without views.time
//   bornAt(node, time, adj)    -> when a node appears (ISO date on a date axis, integer beat on an order axis, null = undated)
//   edgeAt(edge, byId, time)   -> when an edge appears (edge.at, else the later endpoint; edge.order on an order axis)
//   ticks(scene)               -> sorted scrub stops inside [from, to]
//   visibleAt(scene, t)        -> { present: Set, fresh: Set, edgePhase: Map, active: id|null }
//   phaseOf(edge, t, stepLen)  -> clamp((t - at + stepLen) / stepLen, 0, 1)
//   stepIndexOf(scene, t)      -> index of the last tick <= t (-1 before the first)
//
// Undated nodes on a date axis are present at every t; undated edges have phase 1
// (never hide what has no time). A time point is an ISO date on a date axis and
// an integer >= 0 on an order axis; `t` may also be a day index on a date axis.
// renderers/viewer/time.js mirrors every export under DF.*; test/time.test.js
// deep-equals the two over every example scene.
import { addStep, dayIndex, floorToStep, isIsoDate, CALENDAR_STEPS } from './ticks.mjs';

/** Agreed with lib/gates/topology-views.mjs (the test pins the three). */
export const DEFAULT_TIME_FIELD = 'happened_on';
export const DATE_STEPS = Object.freeze(['day', 'week', 'month', 'year', 'event']);
export const ORDER_STEPS = Object.freeze(['beat']);
/** Length of one step in axis units (days on a date axis, beats on an order axis): the tween window of phaseOf. */
export const STEP_LEN = Object.freeze({ day: 1, week: 7, month: 30, year: 365, event: 1, beat: 1 });
const TRACE_DEFAULTS = Object.freeze({ trail: 0.25, beads: 3, duration_ms: 4000 });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const lookup = (index, key) => (index instanceof Map ? index.get(key) : isObject(index) ? index[key] : undefined);
const edgeKey = (e, i) => (typeof e.id === 'string' && e.id ? e.id : `#${i}`);

/** A value as a point on the axis: an ISO date (or a day index) -> day index; a non-negative integer -> itself; else null. */
function toNum(v, axis) {
  if (axis === 'date') return typeof v === 'string' ? dayIndex(v) : Number.isInteger(v) ? v : null;
  return Number.isInteger(v) && v >= 0 ? v : null;
}
/** Is `v` an authored point of this axis (a real date on date, an integer >= 0 on order)? */
const onAxis = (v, axis) => (axis === 'date' ? isIsoDate(v) : Number.isInteger(v) && v >= 0);
/** The step bucket of a point: the start of its calendar step (day index) on day|week|month|year, the point itself on event|beat. */
function bucketOf(v, time) {
  const n = toNum(v, time.axis);
  if (n === null) return null;
  if (time.axis === 'date' && CALENDAR_STEPS.includes(time.step)) return dayIndex(floorToStep(toIso(n), time.step));
  return n;
}
const toIso = (n) => addStep('1970-01-01', 'day', n);
const asPoint = (n, axis) => (axis === 'date' ? toIso(n) : n);

/**
 * Smallest `order` of an ordered edge entering each node (both ends when directed is
 * false): the adjacency bornAt reads. Empty for a sequence scene, whose participants
 * are lifelines present from beat 0 (a message enters a lane, it does not create it).
 */
export function enteringOrders(scene) {
  const adj = new Map();
  if (isObject(scene) && scene.kind === 'sequence') return adj;
  list(scene && scene.edges).forEach((e) => {
    if (!Number.isInteger(e.order)) return;
    const ends = e.directed === false ? [e.from, e.to] : [e.to];
    for (const id of ends) if (typeof id === 'string' && (!adj.has(id) || e.order < adj.get(id))) adj.set(id, e.order);
  });
  return adj;
}

/** { nodesById: Map, adjacency: Map } for one scene. */
export function timeIndex(scene) {
  return { nodesById: new Map(list(scene && scene.nodes).map((n) => [n.id, n])), adjacency: enteringOrders(scene) };
}

/** Order axis: 0 for a node no ordered edge enters and for a node tagged initial (a back edge never delays the start), else the smallest entering order. Date axis: provenance[field] ?? captured_on, null when neither is a date. */
export function bornAt(node, time, adjacency) {
  if (!isObject(node) || !isObject(time)) return null;
  if (time.axis === 'order') {
    if (Array.isArray(node.tags) && node.tags.includes('initial')) return 0;
    const o = lookup(adjacency, node.id); return Number.isInteger(o) && o >= 0 ? o : 0;
  }
  const prov = isObject(node.provenance) ? node.provenance : {};
  const field = typeof time.field === 'string' ? time.field : DEFAULT_TIME_FIELD;
  if (isIsoDate(prov[field])) return prov[field];
  return isIsoDate(prov.captured_on) ? prov.captured_on : null;
}

export function edgeAt(edge, nodesById, time) {
  if (!isObject(edge) || !isObject(time)) return null;
  if (time.axis === 'order') return Number.isInteger(edge.order) && edge.order >= 0 ? edge.order : null;
  if (isIsoDate(edge.at)) return edge.at;
  const a = bornAt(lookup(nodesById, edge.from), time, null); const b = bornAt(lookup(nodesById, edge.to), time, null);
  if (a === null) return b; if (b === null) return a;
  return a > b ? a : b;
}

/** Every dated point of the scene (node births and edge times) as axis numbers, sorted and unique. */
function pointsOf(scene, time, idx) {
  const out = new Set();
  for (const n of idx.nodesById.values()) { const v = toNum(bornAt(n, time, idx.adjacency), time.axis); if (v !== null) out.add(v); }
  for (const e of list(scene.edges)) { const v = toNum(edgeAt(e, idx.nodesById, time), time.axis); if (v !== null) out.add(v); }
  return [...out].sort((x, y) => x - y);
}

/** The time block with every default filled; null when the scene has no views.time (or an axis that is neither date nor order). */
export function timeOf(scene) {
  const raw = isObject(scene) && isObject(scene.views) && isObject(scene.views.time) ? scene.views.time : null;
  if (!raw || (raw.axis !== 'date' && raw.axis !== 'order')) return null;
  const axis = raw.axis;
  const steps = axis === 'date' ? DATE_STEPS : ORDER_STEPS;
  const time = { axis, field: typeof raw.field === 'string' ? raw.field : DEFAULT_TIME_FIELD, step: steps.includes(raw.step) ? raw.step : steps[steps.length - 1] };
  const points = pointsOf(scene, time, timeIndex(scene));
  const lo = points.length ? asPoint(points[0], axis) : null; const hi = points.length ? asPoint(points[points.length - 1], axis) : null;
  time.from = onAxis(raw.from, axis) ? raw.from : lo;
  time.to = onAxis(raw.to, axis) ? raw.to : hi;
  time.playhead = onAxis(raw.playhead, axis) ? raw.playhead : time.to;
  time.cumulative = typeof raw.cumulative === 'boolean' ? raw.cumulative : true;
  time.motion = raw.motion === 'trace' || raw.motion === 'playback' ? raw.motion : 'still';
  const tr = isObject(raw.trace) ? raw.trace : {};
  time.trace = { trail: typeof tr.trail === 'number' ? tr.trail : TRACE_DEFAULTS.trail, beads: Number.isInteger(tr.beads) ? tr.beads : TRACE_DEFAULTS.beads, duration_ms: Number.isInteger(tr.duration_ms) ? tr.duration_ms : TRACE_DEFAULTS.duration_ms };
  return time;
}

/** Sorted scrub stops: from, every aligned calendar step inside (from, to) on day|week|month|year, every dated point on event|beat, and to. */
export function ticks(scene) {
  const time = timeOf(scene);
  if (!time) return [];
  const from = toNum(time.from, time.axis); const to = toNum(time.to, time.axis);
  if (from === null || to === null || from > to) return [];
  const stops = new Set([from, to]);
  if (time.axis === 'date' && CALENDAR_STEPS.includes(time.step)) {
    let cur = floorToStep(toIso(from), time.step);
    for (let n = dayIndex(cur); n < to; n = dayIndex(cur)) { if (n > from) stops.add(n); cur = addStep(cur, time.step, 1); }
  } else {
    for (const p of pointsOf(scene, time, timeIndex(scene))) if (p > from && p < to) stops.add(p);
  }
  return [...stops].sort((x, y) => x - y).map((n) => asPoint(n, time.axis));
}

/** clamp((t - at + stepLen) / stepLen, 0, 1): 0 one step before the edge's time, 1 at it. `edge` is an edge whose `at` is resolved, or the resolved time itself; undated -> 1. */
export function phaseOf(edge, t, stepLen) {
  const at = isObject(edge) ? edge.at : edge;
  const a = typeof at === 'string' ? dayIndex(at) : Number.isInteger(at) ? at : null;
  const tn = typeof t === 'string' ? dayIndex(t) : Number.isInteger(t) ? t : null;
  if (a === null || tn === null) return 1;
  const len = typeof stepLen === 'number' && stepLen > 0 ? stepLen : 1;
  return Math.min(1, Math.max(0, (tn - a + len) / len));
}

/** Index of the last tick <= t; -1 when t is before the first tick, when there are no ticks, or when t is not a point of the axis. */
export function stepIndexOf(scene, t) {
  const time = timeOf(scene);
  if (!time) return -1;
  const tn = toNum(t === null || t === undefined ? time.playhead : t, time.axis);
  if (tn === null) return -1;
  let i = -1;
  for (const s of ticks(scene)) { if (toNum(s, time.axis) <= tn) i += 1; else break; }
  return i;
}

/** The node the playhead sits on: the target of the latest edge at or before t (earliest in edges[] on a tie); else the present node tagged initial; else the latest-born present node. */
function activeAt(scene, time, idx, tn, present) {
  let best = null; let bestAt = null;
  for (const e of list(scene.edges)) {
    const n = toNum(edgeAt(e, idx.nodesById, time), time.axis);
    if (n === null || n > tn || (bestAt !== null && n <= bestAt)) continue;
    bestAt = n; best = typeof e.to === 'string' && idx.nodesById.has(e.to) ? e.to : null;
  }
  if (best !== null) return best;
  for (const n of idx.nodesById.values()) if (Array.isArray(n.tags) && n.tags.includes('initial') && present.has(n.id)) return n.id;
  let born = null;
  for (const n of idx.nodesById.values()) {
    const b = toNum(bornAt(n, time, idx.adjacency), time.axis);
    if (b !== null && b <= tn && (born === null || b > born)) { born = b; best = n.id; }
  }
  return best;
}

/** What is visible at t (default: the playhead). Without a time block, or with a null playhead, everything is present with phase 1. */
export function visibleAt(scene, t) {
  const s = isObject(scene) ? scene : {};
  const time = timeOf(s);
  const idx = timeIndex(s);
  const tn = time ? toNum(t === null || t === undefined ? time.playhead : t, time.axis) : null;
  const present = new Set(); const fresh = new Set(); const edgePhase = new Map();
  if (tn === null) {
    for (const id of idx.nodesById.keys()) present.add(id);
    list(s.edges).forEach((e, i) => edgePhase.set(edgeKey(e, i), 1));
    return { present, fresh, edgePhase, active: null };
  }
  const tb = bucketOf(tn, time); const len = STEP_LEN[time.step] || 1;
  for (const n of idx.nodesById.values()) {
    const born = toNum(bornAt(n, time, idx.adjacency), time.axis);
    if (born === null) { present.add(n.id); continue; }
    const same = bucketOf(born, time) === tb;
    if (time.cumulative ? born <= tn : same) { present.add(n.id); if (same) fresh.add(n.id); }
  }
  list(s.edges).forEach((e, i) => {
    const at = toNum(edgeAt(e, idx.nodesById, time), time.axis);
    if (at === null) edgePhase.set(edgeKey(e, i), 1);
    else if (!time.cumulative && bucketOf(at, time) !== tb) edgePhase.set(edgeKey(e, i), 0);
    else edgePhase.set(edgeKey(e, i), phaseOf(at, tn, len));
  });
  return { present, fresh, edgePhase, active: activeAt(s, time, idx, tn, present) };
}
