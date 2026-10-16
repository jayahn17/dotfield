// Gate "topology", the views half: every views.* reference resolves to
// authored topology (the viewer never invents a node or an edge) and
// views.time is a coherent window on its axis. Called by lib/gates/topology.mjs
// with the same F(code, path, detail) collector and the same id index, so the
// two files report as one gate. Pure; never throws on bad input (every shape
// is guarded; what is not a scene is simply nothing to check).
//
//   checkViews(scene, F, index) -> void
//     index = { nodeIds: Set, groupIds: Set, edgeIds: Set }
//   DF_IR_DANGLING_VIEW_REF   focus, presentation[], steps[].nodes/edges, vr.entry_node
//   DF_IR_GROUP_UNDECLARED    lenses[].match.groups
//   DF_IR_TIME_WINDOW_INVALID from > to, playhead outside [from, to] (an unauthored end is
//                             the first or last point on the axis, as lib/time timeOf fills it), a value or a step off its axis
//   DF_IR_TIME_RANGE_EMPTY    axis date and no node carries the named provenance date (non-blocking)

import { timeOf } from '../time/playhead.mjs';

/** Steps that walk a date axis; `beat` is the one step of an order axis. */
export const DATE_STEPS = Object.freeze(['day', 'week', 'month', 'year', 'event']);
export const ORDER_STEPS = Object.freeze(['beat']);
/** The provenance date a node is born at when views.time.field is absent (captured_on is the per-node fallback in lib/time). */
export const DEFAULT_TIME_FIELD = 'happened_on';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const objects = (v) => list(v).map((x, i) => [x, i]).filter(([x]) => isObject(x));

/** 'date' for a string, 'order' for a non-negative integer, null for anything else (the schema reports those). */
export function axisOfValue(v) {
  if (typeof v === 'string') return 'date';
  if (Number.isInteger(v) && v >= 0) return 'order';
  return null;
}

/** Compare two values of one axis: ISO dates compare as strings, orders as numbers. */
function compare(a, b) {
  if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return a - b;
}

function checkReferences(views, F, index) {
  const { nodeIds, groupIds, edgeIds } = index;
  const inter = isObject(views.interactive) ? views.interactive : {};
  const vr = isObject(views.vr) ? views.vr : {};
  const ref = (path, id, what, ids, where) => {
    if (!ids.has(id)) F('DF_IR_DANGLING_VIEW_REF', path, `${what} '${String(id)}' is not in ${where}`);
  };
  if (typeof inter.focus === 'string') ref('$.views.interactive.focus', inter.focus, 'focus', nodeIds, 'nodes[]');
  list(inter.presentation).forEach((n, j) => ref(`$.views.interactive.presentation[${j}]`, n, 'presentation entry', nodeIds, 'nodes[]'));
  if (typeof vr.entry_node === 'string') ref('$.views.vr.entry_node', vr.entry_node, 'entry_node', nodeIds, 'nodes[]');
  for (const [step, i] of objects(inter.steps)) {
    const p = `$.views.interactive.steps[${i}]`;
    list(step.nodes).forEach((n, j) => ref(`${p}.nodes[${j}]`, n, `step '${String(step.id)}' node`, nodeIds, 'nodes[]'));
    list(step.edges).forEach((e, j) => ref(`${p}.edges[${j}]`, e, `step '${String(step.id)}' edge`, edgeIds, 'edges[] (by id)'));
  }
  for (const [lens, i] of objects(inter.lenses)) {
    const match = isObject(lens.match) ? lens.match : {};
    list(match.groups).forEach((g, j) => { if (!groupIds.has(g)) F('DF_IR_GROUP_UNDECLARED', `$.views.interactive.lenses[${i}].match.groups[${j}]`, `'${String(g)}' is not in groups[]`); });
  }
}

/** The window: every value on its axis, from <= to, the playhead inside, the step fitting the axis. */
function checkTime(time, scene, F) {
  if (!isObject(time)) return;
  const P = '$.views.time';
  const axis = time.axis === 'date' || time.axis === 'order' ? time.axis : null;
  const W = (path, detail) => F('DF_IR_TIME_WINDOW_INVALID', path, detail);
  const onAxis = (v) => axis !== null && axisOfValue(v) === axis;
  if (axis) {
    for (const k of ['from', 'to', 'playhead']) {
      const got = axisOfValue(time[k]);
      if (got && got !== axis) W(`${P}.${k}`, `${k} is ${got === 'date' ? 'a date' : 'an integer'} on ${axis === 'date' ? 'a date' : 'an order'} axis`);
    }
    if (axis === 'date' && ORDER_STEPS.includes(time.step)) W(`${P}.step`, `step '${time.step}' is for axis order`);
    if (axis === 'order' && DATE_STEPS.includes(time.step)) W(`${P}.step`, `step '${time.step}' is for axis date`);
  }
  const { from, to, playhead } = time;
  if (onAxis(from) && onAxis(to) && compare(from, to) > 0) W(`${P}.from`, `from ${JSON.stringify(from)} is after to ${JSON.stringify(to)}`);
  // The window the still, the time bar and the viewer all clamp to: authored ends, else the first and last points on the axis.
  const filled = onAxis(playhead) && (!onAxis(from) || !onAxis(to)) ? timeOf(scene) : null;
  const lo = onAxis(from) ? from : (filled && onAxis(filled.from) ? filled.from : null);
  const hi = onAxis(to) ? to : (filled && onAxis(filled.to) ? filled.to : null);
  const end = (authored, word) => (authored ? word : `the ${word === 'from' ? 'first' : 'last'} point on the axis`);
  if (onAxis(playhead) && lo !== null && compare(playhead, lo) < 0) W(`${P}.playhead`, `playhead ${JSON.stringify(playhead)} is before ${end(onAxis(from), 'from')} ${JSON.stringify(lo)}`);
  if (onAxis(playhead) && hi !== null && compare(playhead, hi) > 0) W(`${P}.playhead`, `playhead ${JSON.stringify(playhead)} is after ${end(onAxis(to), 'to')} ${JSON.stringify(hi)}`);
  if (axis === 'date') {
    const field = typeof time.field === 'string' ? time.field : DEFAULT_TIME_FIELD;
    const dated = objects(scene.nodes).some(([n]) => isObject(n.provenance) && typeof n.provenance[field] === 'string');
    if (!dated) F('DF_IR_TIME_RANGE_EMPTY', `${P}.field`, `no node carries provenance.${field}; every node would fall back to captured_on`);
  }
}

/** Gate half: view references, lens groups and the time window. */
export function checkViews(scene, F, index) {
  const s = isObject(scene) ? scene : {};
  const views = isObject(s.views) ? s.views : {};
  const idx = {
    nodeIds: index && index.nodeIds instanceof Set ? index.nodeIds : new Set(),
    groupIds: index && index.groupIds instanceof Set ? index.groupIds : new Set(),
    edgeIds: index && index.edgeIds instanceof Set ? index.edgeIds : new Set(),
  };
  checkReferences(views, F, idx);
  checkTime(views.time, s, F);
}
