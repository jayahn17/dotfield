// Lifecycle layout (V2_PLAN §3 D; archify lifecycle / state machine): the
// layered layout with direction right by default, longest path from the
// states tagged `initial`, states tagged `final` on the last layer, back
// transitions detoured through channels.mjs with plan.reversed persisted,
// and a self transition as a four-point loop. States are any kind with
// shape pill (open decision 1): extentOf() gives them their wide glyph.
// Default playback steps are the BFS of transitions from the initial state
// with index tie-breaks. Pure; nothing here draws from a clock or a seed.
//
//   lifecycleLayout(input)        -> {points, routes, plan, viewBox}   (input shape: index.mjs prepare())
//   defaultLifecycleSteps(scene)  -> [{id, label, nodes, edges}] one step per state in BFS order
//   tagged(nodes, tag)            -> node indices carrying the tag
import { directionOf, layeredLayout } from './layered.mjs';

export const LIFECYCLE = Object.freeze({ initial_tag: 'initial', final_tag: 'final', direction: 'right', step_prefix: 'step', label_max: 120 });

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function objects(v) { return Array.isArray(v) ? v.filter(isObject) : []; }

/** Indices of the nodes whose tags[] carry `tag`, in node order. */
export function tagged(nodes, tag) {
  const out = [];
  objects(nodes).forEach((n, i) => { if (Array.isArray(n.tags) && n.tags.includes(tag)) out.push(i); });
  return out;
}

/** The lifecycle layout: layered, direction views.2d.direction ?? right, rooted at the initial states. */
export function lifecycleLayout(input) {
  const initial = tagged(input.nodes, LIFECYCLE.initial_tag);
  const finals = tagged(input.nodes, LIFECYCLE.final_tag);
  return layeredLayout(input, { direction: directionOf(input, LIFECYCLE.direction), initial, finals, mode: 'lifecycle' });
}

/**
 * Default steps for views.interactive.steps: a breadth-first walk over the
 * transition edges (every edge when none is a transition) from the first
 * initial state (else node 0), out-edges in edge order, each newly reached
 * state one step carrying the edge that reached it; unreachable states
 * follow in node order with no edge. Labels are the node label (else id)
 * cut to short_text length.
 */
export function defaultLifecycleSteps(scene) {
  const s = isObject(scene) ? scene : {};
  const nodes = objects(s.nodes).filter((n) => typeof n.id === 'string');
  if (!nodes.length) return [];
  const index = new Map(); nodes.forEach((n, i) => { if (!index.has(n.id)) index.set(n.id, i); });
  const edges = objects(s.edges).filter((e) => index.has(e.from) && index.has(e.to));
  const transitions = edges.filter((e) => e.kind === 'transition');
  const walk = transitions.length ? transitions : edges;
  const out = Array.from({ length: nodes.length }, () => []);
  walk.forEach((e) => { if (e.from !== e.to) out[index.get(e.from)].push(e); });
  const initial = tagged(nodes, LIFECYCLE.initial_tag);
  const start = initial.length ? initial[0] : 0;
  const seen = new Uint8Array(nodes.length); const steps = [];
  const labelOf = (n) => (typeof n.label === 'string' && n.label.length ? n.label : n.id).slice(0, LIFECYCLE.label_max);
  const step = (i, edge) => {
    seen[i] = 1;
    const st = { id: `${LIFECYCLE.step_prefix}-${steps.length + 1}`, label: labelOf(nodes[i]), nodes: [nodes[i].id], edges: [] };
    if (edge && typeof edge.id === 'string' && edge.id) st.edges.push(edge.id);
    steps.push(st);
  };
  const queue = [start]; step(start, null);
  while (queue.length) {
    const v = queue.shift();
    for (const e of out[v]) { const w = index.get(e.to); if (!seen[w]) { step(w, e); queue.push(w); } }
  }
  for (let i = 0; i < nodes.length; i += 1) if (!seen[i]) step(i, null);
  return steps;
}
