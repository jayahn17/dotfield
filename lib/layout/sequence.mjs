// Sequence layout (V2_PLAN §3 C): participants on the top row at lane pitch
// in groups[] order (else node order), one beat per distinct edge order
// (equal order = one row; an order-less edge gets a row of its own after
// the beats), a message route [[xa, y], [xb, y]] along the beat row and a
// self message as a 40 px four-point loop. Lifelines are never written: the
// renderer derives them from the committed routes. The returned viewBox
// grows the width for the lanes and sets the height to the last beat plus
// one pitch plus padding when none is authored. Pure; + - * / only;
// index-ordered; input.style ?? labelStyle() for the label-aware pitch.
//
//   sequenceLayout(input) -> {points, routes, plan, viewBox}   (input shape: index.mjs prepare())
//   sequenceRows(input)   -> {beats, rowOf(order), rowOfEdge(ei), rowH, head, top, rows, yOf(k), lastY}
//   participantOrder(input) -> node indices left to right
import { LABEL_GAP_PX, labelBox, labelStyle, labelWidth } from './metrics.mjs';
import { roundTo } from './frame.mjs';
import { lanesOf } from './lanes.mjs';
import { EDGE_LABEL_SIZE, extentOf, skipName } from './layered-order.mjs';

export const SEQUENCE = Object.freeze({ lane_min_mult: 3, head_mult: 2, beat_mult: 2, self_loop_px: 40 });

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function hasOrder(e) { return Number.isInteger(e.order) && e.order >= 0; }

function authoredViewBox(scene) {
  const v2 = isObject(scene) && isObject(scene.views) && isObject(scene.views['2d']) ? scene.views['2d'] : {};
  const vb = v2.viewBox;
  return Array.isArray(vb) && vb.length === 4 && vb.every((x) => typeof x === 'number' && Number.isFinite(x)) && vb[2] > 0 && vb[3] > 0;
}

/** Participants left to right: groups[] order with members in node order, the ungrouped pool last. */
export function participantOrder(input) {
  const out = [];
  for (const lane of lanesOf(input)) for (const i of lane) out.push(i);
  return out;
}

/** The beat rows: distinct orders ascending, then one row per order-less edge in index order. */
export function sequenceRows(input) {
  const { frame } = input; const spacing = frame.spacing;
  const seen = new Set(); const beats = []; const extra = [];
  input.edges.forEach(([, , e], ei) => {
    if (!hasOrder(e)) { extra.push(ei); return; }
    if (!seen.has(e.order)) { seen.add(e.order); beats.push(e.order); }
  });
  beats.sort((a, b) => a - b);
  const index = new Map(); beats.forEach((o, k) => index.set(o, k));
  const rowH = spacing * SEQUENCE.beat_mult;
  const top = frame.y0 + frame.padding + spacing * SEQUENCE.head_mult;
  const head = rowH;
  const rows = beats.length + extra.length;
  const rowOf = (order) => (index.has(order) ? index.get(order) : -1);
  const rowOfEdge = (ei) => { const k = rowOf(input.edges[ei][2].order); return k >= 0 ? k : beats.length + extra.indexOf(ei); };
  const yOf = (k) => top + head + k * rowH;
  return { beats, rowOf, rowOfEdge, rowH, head, top, rows, yOf, lastY: rows ? yOf(rows - 1) : top + head };
}

/** The sequence layout over a prepared input. */
export function sequenceLayout(input) {
  const { nodes, frame, pinned, radii, shapes } = input; const n = nodes.length;
  const style = input.style ?? labelStyle();
  const rows = sequenceRows(input);
  const plan = { mode: 'sequence', reversed: [], skipped: [], layers: n ? 1 : 0, dummies: 0, crossings_before: 0, crossings_after: 0, beats: rows.rows };
  if (!n) return { points: [], routes: {}, plan };
  const order = participantOrder(input);
  const slot = new Int32Array(n); order.forEach((i, k) => { slot[i] = k; });
  let maxBoxW = 0;
  nodes.forEach((nd, i) => {
    const [hx] = extentOf(nd, radii[i], shapes);
    let half = hx;
    if (typeof nd.label === 'string' && nd.label.length) { const b = labelBox(nd, [0, 0], radii[i], style, shapes); half = Math.max(half, -b.x, b.x + b.w); }
    if (2 * half > maxBoxW) maxBoxW = 2 * half;
  });
  let msgNeed = 0;
  const es = { ...style, size: EDGE_LABEL_SIZE };
  for (const [a, b, e] of input.edges) {
    if (a === b || typeof e.label !== 'string' || !e.label) continue;
    const span = Math.abs(slot[a] - slot[b]);
    const need = (labelWidth(e.label, es) + 2 * LABEL_GAP_PX) / span;
    if (need > msgNeed) msgNeed = need;
  }
  const minPitch = Math.max(frame.spacing * SEQUENCE.lane_min_mult, maxBoxW + frame.spacing, msgNeed);
  const innerW = frame.w - 2 * frame.padding;
  const pitch = Math.max(minPitch, innerW / n);
  const left = frame.x0 + frame.padding;
  const P = new Array(n);
  order.forEach((i, k) => { const q = pinned.get(i); P[i] = q ? [q[0], q[1]] : [left + (k + 0.5) * pitch, rows.top]; });
  const routes = {}; let loopBottom = 0;
  input.edges.forEach(([a, b, e], ei) => {
    if (typeof e.id !== 'string' || !e.id) { plan.skipped.push(skipName(input, e)); return; }
    const y = rows.yOf(rows.rowOfEdge(ei)); const xa = P[a][0]; const xb = P[b][0];
    if (a === b) {
      const d = SEQUENCE.self_loop_px;
      routes[e.id] = [[xa, y], [xa + d, y], [xa + d, y + d], [xa, y + d]];
      if (y + d > loopBottom) loopBottom = y + d;
    } else routes[e.id] = [[xa, y], [xb, y]];
  });
  const lastY = rows.lastY > loopBottom ? rows.lastY : loopBottom;
  const neededH = lastY + rows.rowH + frame.padding - frame.y0;
  const neededW = n * pitch + 2 * frame.padding;
  const authored = authoredViewBox(input.scene);
  const viewBox = [frame.x0, frame.y0, Math.max(frame.w, neededW), authored ? Math.max(frame.h, neededH) : neededH];
  const round = (p) => [roundTo(p[0]), roundTo(p[1])];
  for (const id of Object.keys(routes)) routes[id] = routes[id].map(round);
  return { points: P.map(round), routes, plan, viewBox };
}
