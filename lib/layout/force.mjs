// Force layout (graph, and any graph-like scene that asks for it). Clusters
// (groups in groups[] order, then the ungrouped pool) own disjoint discs
// packed on a golden-angle spiral exactly as cluster-disc packs them; inside
// its disc every node runs velocity-Verlet over repulsion, edge springs
// (across clusters too, so a node drifts toward what it links) and a pull to
// the disc centre, and is confined to the disc after every tick, so a group
// region can never hold a foreign node. A scene with no groups is one
// cluster spanning the padded box: the classic force layout under centre
// gravity. From 0.4 * ticks a label term pushes apart near pairs whose
// boxes (glyph united with the measured label, labels.mjs nodeBoxes) still
// overlap: 0.02 * spacing * penetration along the axis of least
// penetration. The shared passes of pack.mjs finish (fit, separate, label
// sides, declutter, expansion, routes). ctx.incremental (lib/bench only)
// keeps every placed node and runs the finishing passes alone.
// Determinism is engineered: the hot loops use only + - * / and Math.sqrt,
// every sum runs in index order (the grid bins above 600 nodes visit cells
// in a fixed order), start positions come from the golden-angle table plus
// a mulberry32 jitter seeded by views.2d.seed, and ticks = min(300, 600000/n).
//
//   forceLayout(input)  -> {points, sides, routes, viewBox}   (input shape: see index.mjs prepare())
//   ticksFor(n)         -> the tick count the budget allows
//   clusterDiscs(input) -> per cluster {c: [x, y], m, inner, R} (inner and R Infinity for a lone cluster)
import { mulberry32, seedFrom } from './rng.mjs';
import { slot } from './trig.mjs';
import { forEachNearPair } from './geometry.mjs';
import { finishFreeForm, fitToFrame, warmDiscs, warmStart } from './pack.mjs';
import { discRadius, packDiscs } from './cluster-disc.mjs';
import { nodeBoxes } from './labels.mjs';

export const FORCE = Object.freeze({
  max_ticks: 300,
  tick_budget: 600000,
  label_from: 0.4,
  label_k: 0.02,
  grid_threshold: 600,
  cutoff_mult: 4,
  repulsion_mult: 0.5,
  edge_length_mult: 2.4,
  spring: 0.005,
  cross_group_spring: 0.4,
  home: 0.015,
  gravity: 0.002,
  damping: 0.85,
});

/** Ticks for n nodes under the budget: 300 up to 2000 nodes, 120 at 5000. */
export function ticksFor(n) {
  if (!(n > 0)) return 0;
  const byBudget = Math.floor(FORCE.tick_budget / n);
  return byBudget < FORCE.max_ticks ? byBudget : FORCE.max_ticks;
}

/** The cluster of node i: its group index, or G for the ungrouped pool. */
export function clusterOf(input, i) {
  return input.memberOf[i] < 0 ? input.groupCount : input.memberOf[i];
}

/**
 * One disc per non-empty cluster: radius from the member count at the
 * frame's spacing (cluster-disc's rule), centres packed largest first on
 * the golden spiral, the arrangement shrunk only when it does not fit and
 * centred in the padded box. `inner` is the confinement radius (one pitch
 * inside the disc). A single cluster is unconfined (inner Infinity).
 */
export function clusterDiscs(input) {
  const { nodes, groupCount, frame } = input;
  const p = frame.spacing;
  const counts = new Int32Array(groupCount + 1);
  for (let i = 0; i < nodes.length; i += 1) counts[clusterOf(input, i)] += 1;
  const discs = [];
  for (let ci = 0; ci <= groupCount; ci += 1) if (counts[ci] > 0) discs.push({ ci, m: counts[ci], R: discRadius(counts[ci], p) });
  const out = new Array(groupCount + 1).fill(null);
  if (discs.length <= 1) {
    for (const d of discs) out[d.ci] = { c: [frame.cx, frame.cy], m: d.m, inner: Infinity, R: Infinity };
    return out;
  }
  const centres = packDiscs(discs, p);
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  discs.forEach((d, k) => {
    const c = centres[k];
    if (c[0] - d.R < minx) minx = c[0] - d.R;
    if (c[0] + d.R > maxx) maxx = c[0] + d.R;
    if (c[1] - d.R < miny) miny = c[1] - d.R;
    if (c[1] + d.R > maxy) maxy = c[1] + d.R;
  });
  const innerW = frame.w - 2 * frame.padding;
  const innerH = frame.h - 2 * frame.padding;
  let s = 1;
  if (maxx - minx > innerW) s = innerW / (maxx - minx);
  if (maxy - miny > innerH && innerH / (maxy - miny) < s) s = innerH / (maxy - miny);
  const mx = (minx + maxx) / 2; const my = (miny + maxy) / 2;
  discs.forEach((d, k) => {
    out[d.ci] = { c: [frame.cx + (centres[k][0] - mx) * s, frame.cy + (centres[k][1] - my) * s], m: d.m, inner: (d.R - p) * s, R: (d.R - p / 2) * s };
  });
  return out;
}

/**
 * Start positions: a node with an earlier neighbour in its own cluster
 * starts one edge length from the mean of those neighbours, along its
 * golden-angle slot (so a tree unfolds from its root and locality survives
 * into the simulation); any other node takes its cluster's sunflower slot.
 * Both get the seeded jitter, two draws per node in index order.
 */
function placeStart(input, x, y, fixed, discs) {
  const { nodes, groupCount, frame, pinned, edges } = input;
  const n = nodes.length;
  const p = frame.spacing;
  const counters = new Int32Array(groupCount + 1);
  const rng = mulberry32(seedFrom(frame.seed, n, groupCount));
  const earlier = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    if (a === b || clusterOf(input, a) !== clusterOf(input, b)) continue;
    if (a < b) earlier[b].push(a); else earlier[a].push(b);
  }
  for (let i = 0; i < n; i += 1) {
    const ci = clusterOf(input, i);
    const disc = discs[ci];
    const kk = counters[ci];
    counters[ci] += 1;
    const jx = (rng() - 0.5) * p * 0.2; const jy = (rng() - 0.5) * p * 0.2;
    if (earlier[i].length) {
      let sx = 0; let sy = 0;
      for (const j of earlier[i]) { sx += x[j]; sy += y[j]; }
      const s = slot(i);
      x[i] = sx / earlier[i].length + s[0] * p * FORCE.edge_length_mult * 0.5 + jx;
      y[i] = sy / earlier[i].length + s[1] * p * FORCE.edge_length_mult * 0.5 + jy;
    } else {
      const r = disc.inner === Infinity ? p * 0.6 * Math.sqrt(kk + 0.5) : disc.inner * Math.sqrt((kk + 0.5) / disc.m);
      const s = slot(kk);
      x[i] = disc.c[0] + r * s[0] + jx;
      y[i] = disc.c[1] + r * s[1] + jy;
    }
    const q = pinned.get(i);
    if (q) { x[i] = q[0]; y[i] = q[1]; fixed[i] = 1; }
  }
}

function repel(i, j, x, y, fx, fy, kRep, cutoff2) {
  let dx = x[j] - x[i];
  let dy = y[j] - y[i];
  let d2 = dx * dx + dy * dy;
  if (d2 > cutoff2) return;
  if (d2 < 0.0001) {
    const s = slot(i + j);
    dx = s[0] * 0.01;
    dy = s[1] * 0.01;
    d2 = 0.0001;
  }
  const f = kRep / d2;
  const px = dx * f;
  const py = dy * f;
  fx[i] -= px; fy[i] -= py;
  fx[j] += px; fy[j] += py;
}

/** Near pairs whose boxes overlap push apart along the axis of least penetration (0.02 k per px of penetration). */
function labelTerm(x, y, fx, fy, boxes, kLabel) {
  const n = x.length;
  const cx = new Float64Array(n); const cy = new Float64Array(n); const hw = new Float64Array(n); const hh = new Float64Array(n);
  let reach = 1;
  for (let i = 0; i < n; i += 1) {
    const b = boxes[i];
    cx[i] = x[i] + (b.left + b.right) / 2; cy[i] = y[i] + (b.top + b.bottom) / 2;
    hw[i] = (b.right - b.left) / 2; hh[i] = (b.bottom - b.top) / 2;
    if (2 * hw[i] > reach) reach = 2 * hw[i];
    if (2 * hh[i] > reach) reach = 2 * hh[i];
  }
  forEachNearPair(cx, cy, reach, (i, j) => {
    const dx = cx[j] - cx[i]; const dy = cy[j] - cy[i];
    const ox = hw[i] + hw[j] - (dx < 0 ? -dx : dx); const oy = hh[i] + hh[j] - (dy < 0 ? -dy : dy);
    if (ox <= 0 || oy <= 0) return;
    if (ox < oy) { const f = kLabel * ox * (dx < 0 ? -1 : 1); fx[i] -= f; fx[j] += f; } else { const f = kLabel * oy * (dy < 0 ? -1 : 1); fy[i] -= f; fy[j] += f; }
  });
}

function forces(input, x, y, fx, fy, discs, consts) {
  const { nodes, edges, memberOf, groupCount } = input;
  const n = nodes.length;
  const { kRep, cutoff, cutoff2, length, pull } = consts;
  for (let i = 0; i < n; i += 1) { fx[i] = 0; fy[i] = 0; }
  if (consts.labels) labelTerm(x, y, fx, fy, consts.boxes, consts.kLabel);
  if (n > FORCE.grid_threshold) {
    forEachNearPair(x, y, cutoff, (i, j) => repel(i, j, x, y, fx, fy, kRep, cutoff2));
  } else {
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) repel(i, j, x, y, fx, fy, kRep, cutoff2);
  }
  for (let e = 0; e < edges.length; e += 1) {
    const a = edges[e][0];
    const b = edges[e][1];
    if (a === b) continue;
    const dx = x[b] - x[a];
    const dy = y[b] - y[a];
    const d2 = dx * dx + dy * dy;
    if (d2 < 0.000001) continue;
    const d = Math.sqrt(d2);
    const w = edges[e][2] && typeof edges[e][2].weight === 'number' ? 0.5 + 0.5 * edges[e][2].weight : 1;
    const same = memberOf[a] === memberOf[b] ? 1 : FORCE.cross_group_spring;
    const f = (FORCE.spring * same * w * (d - length)) / d;
    fx[a] += dx * f; fy[a] += dy * f;
    fx[b] -= dx * f; fy[b] -= dy * f;
  }
  for (let i = 0; i < n; i += 1) {
    const home = discs[clusterOf(input, i)].c;
    fx[i] += (home[0] - x[i]) * pull;
    fy[i] += (home[1] - y[i]) * pull;
  }
  return groupCount;
}

/** Keep node i inside its cluster's disc (its glyph fully within `inner`). */
function confine(i, x, y, disc, radius) {
  if (disc.inner === Infinity) return;
  const lim = disc.inner - radius;
  const dx = x[i] - disc.c[0];
  const dy = y[i] - disc.c[1];
  const d2 = dx * dx + dy * dy;
  if (lim <= 0) { x[i] = disc.c[0]; y[i] = disc.c[1]; return; }
  if (d2 <= lim * lim) return;
  const k = lim / Math.sqrt(d2);
  x[i] = disc.c[0] + dx * k;
  y[i] = disc.c[1] + dy * k;
}

function simulate(input, x, y, fixed, discs) {
  const n = input.nodes.length;
  const k = input.frame.spacing;
  const ticks = ticksFor(n);
  const lone = discs.filter((d) => d !== null).length <= 1;
  const vx = new Float64Array(n); const vy = new Float64Array(n);
  const ax = new Float64Array(n); const ay = new Float64Array(n);
  const fx = new Float64Array(n); const fy = new Float64Array(n);
  const consts = {
    kRep: FORCE.repulsion_mult * k * k,
    cutoff: FORCE.cutoff_mult * k,
    cutoff2: FORCE.cutoff_mult * k * FORCE.cutoff_mult * k,
    length: FORCE.edge_length_mult * k,
    pull: lone ? FORCE.gravity : FORCE.home,
    boxes: nodeBoxes(input, null, input.measured),
    kLabel: FORCE.label_k * k,
    labels: false,
  };
  for (let t = 0; t < ticks; t += 1) {
    consts.labels = t >= FORCE.label_from * ticks;
    const temp = 1 - t / ticks;
    const step = k * (0.4 * temp + 0.05);
    for (let i = 0; i < n; i += 1) {
      if (fixed[i]) continue;
      let dx = vx[i] + 0.5 * ax[i];
      let dy = vy[i] + 0.5 * ay[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > step * step) {
        const scale = step / Math.sqrt(d2);
        dx *= scale; dy *= scale;
      }
      x[i] += dx; y[i] += dy;
      confine(i, x, y, discs[clusterOf(input, i)], input.radii[i]);
    }
    forces(input, x, y, fx, fy, discs, consts);
    for (let i = 0; i < n; i += 1) {
      if (fixed[i]) { vx[i] = 0; vy[i] = 0; ax[i] = 0; ay[i] = 0; continue; }
      vx[i] = (vx[i] + 0.5 * (ax[i] + fx[i])) * FORCE.damping;
      vy[i] = (vy[i] + 0.5 * (ay[i] + fy[i])) * FORCE.damping;
      ax[i] = fx[i]; ay[i] = fy[i];
    }
  }
}

/** The force layout over a prepared input: unrounded points plus the label sides, sparse routes and viewBox of the finishing passes. */
export function forceLayout(input) {
  const n = input.nodes.length;
  const x = new Float64Array(n); const y = new Float64Array(n);
  const fixed = new Uint8Array(n);
  if (n === 0) return [];
  const discs = clusterDiscs(input);
  if (warmStart(input, x, y, fixed)) return finishFreeForm(input, x, y, fixed, { discs: warmDiscs(input, x, y) });
  placeStart(input, x, y, fixed, discs);
  simulate(input, x, y, fixed, discs);
  const fit = fitToFrame(x, y, input.radii, fixed, input.frame);
  const at = (c) => (fit ? [fit.cx + (c[0] - fit.mx) * fit.s, fit.cy + (c[1] - fit.my) * fit.s] : [c[0], c[1]]);
  const own = [];
  for (let i = 0; i < n; i += 1) {
    const d = discs[clusterOf(input, i)];
    own.push(d && Number.isFinite(d.R) ? { c: at(d.c), R: d.R * (fit ? fit.s : 1) } : null);
  }
  return finishFreeForm(input, x, y, fixed, { discs: own });
}
