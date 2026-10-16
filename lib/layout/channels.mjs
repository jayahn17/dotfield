// Channel routing for the layered modes (V2_PLAN §3 B). In the gap between
// two layers every edge piece that changes its in-layer coordinate takes a
// track: pieces sort by mid-coordinate (ties by edge index) and track c of C
// sits at zoneLo + (c + 1) * zone / (C + 1). A route is [exit port, (stub),
// [p, c], [q, c], (stub), entry port]; a long edge passes through its dummy
// coordinates; a reversed edge leaves by the forward side, detours around
// the layer span in an outer column of its own and enters by the back side;
// a self edge is a four-point loop. Only id'd edges are routed (the mode's
// plan.skipped names the rest). Pure; + - * / sqrt only; index-ordered.
// Two legs of different pieces on one coordinate never share a line: the
// track order turns the piece that leaves a coordinate before the piece
// that arrives there, and when two pieces swap coordinates (an X the order
// cannot satisfy either way: a long edge's pass-through above a port, or two
// crossed pairs of aligned ports) the later one takes a second, earlier
// track and changes column at its own mid-coordinate between the two.
//
//   routeChannels(input, X, Y, order, ports, gaps, {direction, plan, geom})
//     -> {routes: {edgeId: polyline}, tracksPerGap: number[], labelAnchors: {edgeId: 'run'|'stub'}}
//   loopRoute(centre, r, extent, A)           -> the four-point self loop
//   trackOrder(items, sign)                   -> one gap's pieces in track order (mid order, legs that meet kept apart)
//   trackSlots(items)                         -> the track order with a pre-track inserted for every swap left unmet
//   simplify(poly)                            -> the polyline without repeated or collinear middle points
import { GLYPH_GAP_PX, labelStyle, labelWidth } from './metrics.mjs';
import { EDGE_LABEL_SIZE, LOOP_HALF_PX, LOOP_PX, TRACK_PITCH_PX, axesOf, extentOf } from './layered-order.mjs';

export const OUTER_PAD_PX = GLYPH_GAP_PX + TRACK_PITCH_PX;
export const STRAIGHT_EPS_PX = 0.5;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Drop repeated points and collinear middle points (same u or same v as both neighbours); keeps at least two. */
export function simplify(poly) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  for (let i = 1; i + 1 < out.length;) {
    const a = out[i - 1]; const b = out[i]; const c = out[i + 1];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
    else i += 1;
  }
  return out;
}

/** The self loop of a node: out along the in-layer axis (toward +x for down|up, toward -y for right|left), LOOP_PX past the glyph. */
export function loopRoute(centre, r, extent, A) {
  const B = 1 - A; const dir = A === 0 ? 1 : -1;
  const half = r > LOOP_HALF_PX + 1 ? LOOP_HALF_PX : r / 2;
  const s = Math.sqrt(r * r - half * half);
  const u0 = centre[A] + dir * s; const u1 = centre[A] + dir * (extent[A] + LOOP_PX);
  const pt = (u, v) => { const p = [0, 0]; p[A] = u; p[B] = v; return p; };
  return [pt(u0, centre[B] - half), pt(u1, centre[B] - half), pt(u1, centre[B] + half), pt(u0, centre[B] + half)];
}

/** A port on a side along the in-layer axis (left|right for down|up, top|bottom for right|left) needs a stub before it can turn. */
function sideStub(side, A) {
  const alongA = A === 0 ? (side === 'left' || side === 'right') : (side === 'top' || side === 'bottom');
  if (!alongA) return 0;
  return side === 'left' || side === 'top' ? -GLYPH_GAP_PX : GLYPH_GAP_PX;
}

/**
 * The track order of one gap: by mid-coordinate, except that a piece whose
 * first leg leaves at the in-layer coordinate where another piece's last leg
 * arrives turns nearer the source layer, so the two legs (both along the
 * layer axis at that coordinate) never share a line. A stable topological
 * pass: the earliest piece in mid order whose constraints are met goes next;
 * with no constraint the order is the mid order unchanged; a cycle (two
 * pieces swapping coordinates) falls back to the mid order.
 */
export function trackOrder(items, sign = 1) {
  const n = items.length;
  const before = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
    if (i === j || Math.abs(items[i].pc.ua - items[j].pc.ub) >= STRAIGHT_EPS_PX) continue;
    if (sign > 0) before[j].push(i); else before[i].push(j);
  }
  const done = new Uint8Array(n); const out = [];
  while (out.length < n) {
    let pick = -1;
    for (let i = 0; i < n && pick < 0; i += 1) if (!done[i] && before[i].every((k) => done[k])) pick = i;
    if (pick < 0) for (let i = 0; i < n && pick < 0; i += 1) if (!done[i]) pick = i;
    done[pick] = 1; out.push(items[pick]);
  }
  return out;
}

/**
 * Tracks for one gap's ordered pieces: every piece keeps its place, and a
 * piece whose first leg leaves the coordinate where an earlier piece's last
 * leg arrives (the order could not put it first: a swap) also gets a
 * pre-track just before that earlier piece, so its first leg ends above the
 * other's last leg; it then runs to its own mid-coordinate, along it to its
 * main track, and on. Returns [{it, pre}] in track order.
 */
export function trackSlots(items) {
  const slots = [];
  items.forEach((it, c) => {
    let clash = -1;
    for (let k = 0; k < c && clash < 0; k += 1) if (Math.abs(it.pc.ua - items[k].pc.ub) < STRAIGHT_EPS_PX) clash = k;
    if (clash >= 0) { const at = slots.findIndex((sl) => !sl.pre && sl.it === items[clash]); slots.splice(at, 0, { it, pre: true }); }
    slots.push({ it, pre: false });
  });
  return slots;
}

export function routeChannels(input, X, Y, order, ports, gaps, { direction = 'down', plan, geom = null, style = input.style ?? labelStyle() } = {}) {
  const { A, B, sign } = axesOf(direction);
  const L = order.length;
  const pt = (u, v) => { const p = [0, 0]; p[A] = u; p[B] = v; return p; };
  const uOf = (p) => p[A]; const vOf = (p) => p[B];
  const { layerOf } = plan;
  const routes = {}; const labelAnchors = {};
  const tracksPerGap = new Array(L + 1).fill(0);
  const gapPieces = Array.from({ length: L + 1 }, () => []);
  const idOf = (ei) => input.edges[ei][2].id;
  const piece = (g, ei, k, a, b, stubA, stubB) => {
    const pc = { a, b, ua: uOf(a) + stubA, ub: uOf(b) + stubB, stubA, stubB, track: null, pre: null };
    if (Math.abs(pc.ua - pc.ub) >= STRAIGHT_EPS_PX) gapPieces[g].push({ mid: (pc.ua + pc.ub) / 2, ei, k, pc });
    return pc;
  };
  const chainsOut = new Map();
  for (const ei of plan.forward) {
    const chain = plan.chains[ei]; const port = ports[ei]; const list = [];
    for (let s = 0; s + 1 < chain.length; s += 1) {
      const p = chain[s]; const q = chain[s + 1];
      const first = s === 0; const last = s + 2 === chain.length;
      const a = first ? port.exit : [X[p], Y[p]]; const b = last ? port.entry : [X[q], Y[q]];
      list.push(piece(layerOf[q], ei, s, a, b, first ? sideStub(port.exitSide, A) : 0, last ? sideStub(port.entrySide, A) : 0));
    }
    chainsOut.set(ei, list);
  }
  let minA = Infinity; let maxA = -Infinity;
  for (let v = 0; v < plan.vertexCount; v += 1) {
    const u = A === 0 ? X[v] : Y[v];
    const lo = u + (geom ? geom.uLo[v] : 0); const hi = u + (geom ? geom.uHi[v] : 0);
    if (lo < minA) minA = lo; if (hi > maxA) maxA = hi;
  }
  // Reversed edges detour outside every box, each in a column of its own; a side's columns start half its widest label further out so a label centred on a column stays clear of the diagram.
  const centre = (minA + maxA) / 2; const count = [0, 0]; const labelHalf = [0, 0]; const sideOf = new Map();
  for (const [ei, a, b] of plan.back) {
    const mid = ((A === 0 ? X[a] : Y[a]) + (A === 0 ? X[b] : Y[b])) / 2; const e = input.edges[ei][2];
    const side = mid < centre || (mid === centre && count[0] <= count[1]) ? 0 : 1;
    sideOf.set(ei, [side, count[side]]); count[side] += 1;
    const w = typeof e.label === 'string' && e.label ? labelWidth(e.label, { ...style, size: EDGE_LABEL_SIZE }) / 2 : 0;
    if (w > labelHalf[side]) labelHalf[side] = w;
  }
  const backs = [];
  for (const [ei, a, b] of plan.back) {
    const port = ports[ei]; const [side, k] = sideOf.get(ei);
    const uOut = side === 0 ? minA - OUTER_PAD_PX - labelHalf[0] - k * TRACK_PITCH_PX : maxA + OUTER_PAD_PX + labelHalf[1] + k * TRACK_PITCH_PX;
    const out = pt(uOut, 0);
    const p1 = piece(layerOf[a] + 1, ei, 0, port.exit, out, sideStub(port.exitSide, A), 0);
    const p0 = piece(layerOf[b], ei, 1, out, port.entry, 0, sideStub(port.entrySide, A));
    backs.push({ ei, port, p1, p0, uOut });
  }
  for (let g = 0; g <= L; g += 1) {
    const slots = trackSlots(trackOrder(gapPieces[g].sort((p, q) => (p.mid - q.mid) || (p.ei - q.ei) || (p.k - q.k)), sign));
    const C = slots.length; tracksPerGap[g] = C;
    const z = gaps[g];
    slots.forEach((sl, c) => { sl.it.pc[sl.pre ? 'pre' : 'track'] = z.zoneLo + ((c + 1) * (z.zoneHi - z.zoneLo)) / (C + 1); });
  }
  const stubPoint = (p, stub) => (stub ? pt(uOf(p) + stub, vOf(p)) : null);
  // A piece's channel points: its track run, or (after a swap) the pre-track run to its mid-coordinate, down that column, then the track run.
  const runOf = (pc) => (pc.pre === null ? [pt(pc.ua, pc.track), pt(pc.ub, pc.track)]
    : [pt(pc.ua, pc.pre), pt((pc.ua + pc.ub) / 2, pc.pre), pt((pc.ua + pc.ub) / 2, pc.track), pt(pc.ub, pc.track)]);
  for (const ei of plan.forward) {
    const list = chainsOut.get(ei); const poly = [list[0].a];
    const s0 = stubPoint(list[0].a, list[0].stubA); if (s0) poly.push(s0);
    for (const pc of list) {
      if (pc.track !== null) poly.push(...runOf(pc));
      else if (pc.stubA || pc.stubB) poly.push(pt(pc.ua, (vOf(pc.a) + vOf(pc.b)) / 2), pt(pc.ub, (vOf(pc.a) + vOf(pc.b)) / 2));
      const sb = stubPoint(pc.b, pc.stubB); if (sb) poly.push(sb);
      poly.push(pc.b);
    }
    routes[idOf(ei)] = simplify(poly);
  }
  for (const bk of backs) {
    const { port, p1, p0, uOut } = bk;
    const poly = [port.exit];
    const s0 = stubPoint(port.exit, p1.stubA); if (s0) poly.push(s0);
    poly.push(...runOf(p1), ...runOf(p0));
    const s1 = stubPoint(port.entry, p0.stubB); if (s1) poly.push(s1);
    poly.push(port.entry);
    routes[idOf(bk.ei)] = simplify(poly);
  }
  for (const ei of plan.loops) {
    const [i] = input.edges[ei];
    routes[idOf(ei)] = loopRoute([X[i], Y[i]], input.radii[i], extentOf(input.nodes[i], input.radii[i], input.shapes), A);
  }
  for (const ei of [...plan.forward, ...plan.back.map((b) => b[0]), ...plan.loops]) {
    const e = input.edges[ei][2];
    if (isObject(e) && typeof e.label === 'string' && e.label) labelAnchors[e.id] = A === 1 ? 'stub' : 'run';
  }
  return { routes, tracksPerGap, labelAnchors };
}
