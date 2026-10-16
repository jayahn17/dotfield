// archify routing intent → via points in the import frame (references/
// ARCHIFY_PARITY.md). The grid types pin every component at a cell centre
// (importers/archify.mjs), so the frame is a lattice: cell centre lines and
// the corridors between cells. archify's own `via`, `channelX`/`channelY` and
// `labelAt` are pixels of archify's canvas (archify/schemas/README.md calls
// them canvas coordinates), which this frame does not share; what does carry
// over is the intent — fromSide/toSide (a side is a direction contract: the
// first and last segment leave and enter perpendicular to it) and the route
// hints (drop, bottom-channel, outside-right, return-left, vertical-channel,
// orthogonal-h|v, straight). Each edge is routed over the lattice by a
// shortest path (length + a bend penalty + a congestion term, sides as hard
// constraints, channel hints as soft ones) that never enters an occupied cell
// it does not connect; then every straight run is given a track offset so no
// two runs share a line (the layout gate's DF_LAYOUT_ROUTE_OVERLAP test is
// exact collinearity), and the first and last runs leave and enter through
// ports spread over the glyph. An edge's first and last runs are port runs
// (offsets 0, ±6, ±12, …, so the port stays near the glyph); every other run
// is a corridor track (0, ±8, ±16, …). The polyline starts and ends at the
// node centres (routePoints prepends and appends them), so a port is a point
// ROUTE_GRID.port_depth px along the side direction and the offset across it
// (5 px against offsets in 6 px steps: two first segments are never collinear).
// Pure; + - * / and integer rounding; edges in index order; ties broken by
// state index.
//
//   routeGrid({cols, rows, width, height, pad, cells, free, edges}) -> {edgeId: via[] | null}
//   latticeCentres({cols, rows, width, height, pad, cells, free}) -> [[x, y] | null] per node
//     cells: [[row, col] | null] per node (null: an authored pos, see `free`)
//     free:  [[x, y] | null] per node, the position of a node without a cell
//     edges: [{id, a, b, route, hint, from_side, to_side}] (a, b node indices)
//   intentOf(edge, cellA, cellB) -> {out: dir[] | null, in: dir[] | null, prefer}
export const ROUTE_GRID = Object.freeze({ port_pitch: 6, track_pitch: 8, port_depth: 5, bend: 80, congest: 30, off_channel: 3, clear_px: 40 });
/** 0 right (+x), 1 down (+y), 2 left, 3 up. */
const DIRS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]);
/** The first move for a departure side, and the last move for an arrival side (entering by the top is moving down). */
export const SIDE_OUT = Object.freeze({ right: 0, bottom: 1, left: 2, top: 3 });
export const SIDE_IN = Object.freeze({ left: 0, top: 1, right: 2, bottom: 3 });

const sideOk = (s) => typeof s === 'string' && Object.hasOwn(SIDE_OUT, s);

/** Sides (hard) and channel preference (soft) from the edge's fromSide/toSide and archify route hint. */
export function intentOf(edge, [ra, ca], [rb, cb]) {
  let out = sideOk(edge.from_side) ? [SIDE_OUT[edge.from_side]] : null;
  let inn = sideOk(edge.to_side) ? [SIDE_IN[edge.to_side]] : null;
  const vert = rb > ra ? 1 : (rb < ra ? 3 : null);
  let prefer = null;
  const set = (o, i) => { if (!out && o !== null) out = [o]; if (!inn && i !== null) inn = [i]; };
  switch (edge.hint) {
    case 'outside-right': case 'right-channel': set(0, 2); prefer = { axis: 'v', min: 2 * Math.max(ca, cb) + 2 }; break;
    case 'return-left': case 'left-channel': set(2, 0); prefer = { axis: 'v', max: 2 * Math.min(ca, cb) }; break;
    case 'bottom-channel': set(1, 3); prefer = { axis: 'h', min: 2 * Math.max(ra, rb) + 2 }; break;
    case 'top-channel': set(3, 1); prefer = { axis: 'h', max: 2 * Math.min(ra, rb) }; break;
    case 'up-channel': set(3, null); break;
    case 'drop': set(rb >= ra ? 1 : 3, rb >= ra ? 1 : 3); break;
    case 'vertical-channel': set(vert, vert); break;
    case 'orthogonal-h': set(cb >= ca ? 0 : 2, null); break;
    case 'orthogonal-v': set(rb >= ra ? 1 : 3, null); break;
    default: break;
  }
  return { out, in: inn, prefer };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const qx = ax + t * dx - px; const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** A tiny binary heap of [cost, state]; ties go to the lower state index, so the search is deterministic. */
function heap() {
  const a = [];
  const less = (i, j) => a[i][0] < a[j][0] || (a[i][0] === a[j][0] && a[i][1] < a[j][1]);
  const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  return {
    get size() { return a.length; },
    push(item) { a.push(item); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(i, p)) break; swap(i, p); i = p; } },
    pop() {
      const top = a[0]; const last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < a.length && less(l, m)) m = l; if (r < a.length && less(r, m)) m = r; if (m === i) break; swap(i, m); i = m; } }
      return top;
    },
  };
}

/** Every node's centre in the import frame: its cell centre, else its authored position. */
export function latticeCentres({ cols, rows, width, height, pad, cells, free = [] }) {
  const hw = (width - 2 * pad) / cols / 2; const hh = (height - 2 * pad) / rows / 2;
  return cells.map((c, k) => (c ? [pad + (2 * c[1] + 1) * hw, pad + (2 * c[0] + 1) * hh] : (free[k] ?? null)));
}

export function routeGrid({ cols, rows, width, height, pad, cells, free = [], edges }) {
  const NI = 2 * cols + 1; const NJ = 2 * rows + 1;
  const hw = (width - 2 * pad) / cols / 2; const hh = (height - 2 * pad) / rows / 2;
  const X = (i) => pad + i * hw; const Y = (j) => pad + j * hh;
  const pid = (i, j) => j * NI + i;
  const occupied = new Map();
  cells.forEach((c, k) => { if (c) occupied.set(pid(2 * c[1] + 1, 2 * c[0] + 1), k); });
  const centres = latticeCentres({ cols, rows, width, height, pad, cells, free });
  const centreOf = (k) => centres[k];
  const freePts = free.map((p, k) => (p && !cells[k] ? [k, p] : null)).filter(Boolean);
  const clear2 = ROUTE_GRID.clear_px * ROUTE_GRID.clear_px;
  const usage = new Map();
  const segKey = (p, q) => (p < q ? `${p}|${q}` : `${q}|${p}`);
  const out = {};
  const paths = [];

  function search(sP, tP, intent, a, b) {
    const dist = new Map(); const prev = new Map(); const h = heap();
    const passable = (q) => q === tP || !occupied.has(q);
    const nearFree = (p, q) => freePts.some(([k, f]) => k !== a && k !== b && segDist2(f[0], f[1], X(p % NI), Y(Math.floor(p / NI)), X(q % NI), Y(Math.floor(q / NI))) < clear2);
    const stepCost = (p, d) => {
      const i = p % NI; const j = Math.floor(p / NI);
      let c = d % 2 === 0 ? hw : hh;
      const pr = intent.prefer;
      if (pr && ((pr.axis === 'v' && d % 2 === 1 && ((pr.min !== undefined && i < pr.min) || (pr.max !== undefined && i > pr.max)))
        || (pr.axis === 'h' && d % 2 === 0 && ((pr.min !== undefined && j < pr.min) || (pr.max !== undefined && j > pr.max))))) c *= ROUTE_GRID.off_channel;
      return c;
    };
    const move = (p, d) => {
      const i = p % NI + DIRS[d][0]; const j = Math.floor(p / NI) + DIRS[d][1];
      if (i < 0 || j < 0 || i >= NI || j >= NJ) return -1;
      const q = pid(i, j);
      return passable(q) && !nearFree(p, q) ? q : -1;
    };
    const relax = (s, cost, from) => { if (!dist.has(s) || cost < dist.get(s)) { dist.set(s, cost); prev.set(s, from); h.push([cost, s]); } };
    for (const d of intent.out ?? [0, 1, 2, 3]) {
      const q = move(sP, d);
      if (q >= 0) relax(q * 4 + d, stepCost(sP, d) + ROUTE_GRID.congest * (usage.get(segKey(sP, q)) ?? 0), -1);
    }
    while (h.size) {
      const [cost, s] = h.pop();
      if (cost !== dist.get(s)) continue;
      const p = Math.floor(s / 4); const d = s % 4;
      if (p === tP) { if (!intent.in || intent.in.includes(d)) return walk(s, prev, sP); continue; }
      for (let nd = 0; nd < 4; nd += 1) {
        if (nd === (d + 2) % 4) continue;
        const q = move(p, nd);
        if (q < 0) continue;
        relax(q * 4 + nd, cost + stepCost(p, nd) + (nd === d ? 0 : ROUTE_GRID.bend) + ROUTE_GRID.congest * (usage.get(segKey(p, q)) ?? 0), s);
      }
    }
    return null;
  }

  function walk(s, prev, sP) {
    const pts = [];
    for (let k = s; k !== -1; k = prev.get(k)) pts.push(Math.floor(k / 4));
    pts.push(sP);
    return pts.reverse();
  }

  edges.forEach((e) => {
    const { a, b } = e;
    if (a === b || !cells[a] || !cells[b]) return;
    const sP = pid(2 * cells[a][1] + 1, 2 * cells[a][0] + 1); const tP = pid(2 * cells[b][1] + 1, 2 * cells[b][0] + 1);
    if (e.route === 'straight' && cells[a][0] !== cells[b][0] && cells[a][1] !== cells[b][1] && chordClear(a, b)) return;
    const intent = intentOf(e, cells[a], cells[b]);
    const pts = search(sP, tP, intent, a, b) ?? search(sP, tP, { out: null, in: null, prefer: null }, a, b);
    if (!pts) return;
    for (let k = 1; k < pts.length; k += 1) { const key = segKey(pts[k - 1], pts[k]); usage.set(key, (usage.get(key) ?? 0) + 1); }
    paths.push({ e, runs: runsOf(pts) });
  });

  /** A diagonal 'straight' chord archify allows when no node it does not connect lies within clear_px of it. */
  function chordClear(a, b) {
    const [ax, ay] = centreOf(a); const [bx, by] = centreOf(b);
    for (let k = 0; k < cells.length; k += 1) {
      if (k === a || k === b) continue;
      const p = centreOf(k);
      if (p && segDist2(p[0], p[1], ax, ay, bx, by) < clear2) return false;
    }
    return true;
  }

  function runsOf(pts) {
    const runs = [];
    for (let k = 1; k < pts.length; k += 1) {
      const p = pts[k - 1]; const q = pts[k];
      const di = q % NI - p % NI; const dj = Math.floor(q / NI) - Math.floor(p / NI);
      const d = di === 1 ? 0 : (dj === 1 ? 1 : (di === -1 ? 2 : 3));
      const last = runs[runs.length - 1];
      if (last && last.d === d) { last.to = q; continue; }
      runs.push({ d, from: p, to: q });
    }
    return runs.map((r, k) => {
      const h = r.d % 2 === 0;
      const u0 = h ? r.from % NI : Math.floor(r.from / NI); const u1 = h ? r.to % NI : Math.floor(r.to / NI);
      return { d: r.d, h, line: h ? Math.floor(r.from / NI) : r.from % NI, lo: Math.min(u0, u1), hi: Math.max(u0, u1), port: k === 0 || k === runs.length - 1, off: 0 };
    });
  }

  // Tracks: on every lattice line, runs that meet take distinct offsets (ports from the port list, the rest from the track list).
  const lines = new Map();
  paths.forEach((p, pi) => p.runs.forEach((r, ri) => { const key = `${r.h ? 'h' : 'v'}${r.line}`; if (!lines.has(key)) lines.set(key, []); lines.get(key).push({ r, pi, ri }); }));
  const offsets = (pitch, k) => (k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * pitch);
  // Two runs on one line meet when their spans overlap, or touch anywhere but a node centre (two runs ending at one node arrive from opposite sides; anywhere else the corners shift with the crossing runs' offsets).
  const meet = (p, r) => {
    if (p.lo < r.hi && r.lo < p.hi) return true;
    const u = p.lo === r.hi ? p.lo : (r.lo === p.hi ? r.lo : null);
    return u !== null && !occupied.has(r.h ? pid(u, r.line) : pid(r.line, u));
  };
  for (const key of [...lines.keys()].sort()) {
    const list = lines.get(key).sort((u, v) => (u.r.lo - v.r.lo) || (u.r.hi - v.r.hi) || (u.pi - v.pi) || (u.ri - v.ri));
    const done = [];
    for (const it of list) {
      const taken = new Set(done.filter((o) => meet(o.r, it.r)).map((o) => o.r.off));
      const pitch = it.r.port ? ROUTE_GRID.port_pitch : ROUTE_GRID.track_pitch;
      let k = 0; while (taken.has(offsets(pitch, k))) k += 1;
      it.r.off = offsets(pitch, k);
      done.push(it);
    }
  }

  for (const { e, runs } of paths) out[e.id] = viaOf(runs, centreOf(e.a), centreOf(e.b));

  /** The interior points: the departure port, the corners between shifted runs, the arrival port; collinear points dropped. */
  function viaOf(runs, s, t) {
    const q = ROUTE_GRID.port_depth;
    const unit = (d) => DIRS[d];
    const perp = (r) => (r.h ? [0, 1] : [1, 0]);
    const first = runs[0]; const last = runs[runs.length - 1];
    const pts = [[s[0], s[1]]];
    const p0 = perp(first); const u0 = unit(first.d);
    pts.push([s[0] + u0[0] * q + p0[0] * first.off, s[1] + u0[1] * q + p0[1] * first.off]);
    for (let k = 0; k + 1 < runs.length; k += 1) {
      const r = runs[k]; const n = runs[k + 1];
      const hz = r.h ? r : n; const vt = r.h ? n : r;
      pts.push([X(vt.line) + vt.off, Y(hz.line) + hz.off]);
    }
    const pl = perp(last); const ul = unit(last.d);
    pts.push([t[0] - ul[0] * q + pl[0] * last.off, t[1] - ul[1] * q + pl[1] * last.off]);
    pts.push([t[0], t[1]]);
    const kept = [pts[0]];
    for (let k = 1; k + 1 < pts.length; k += 1) {
      const a = kept[kept.length - 1]; const b = pts[k]; const c = pts[k + 1];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if ((a[0] === b[0] && a[1] === b[1]) || cross === 0) continue;
      kept.push(b);
    }
    const via = kept.slice(1).map((p) => [round3(p[0]), round3(p[1])]);
    return via.length ? via : null;
  }
  return out;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
