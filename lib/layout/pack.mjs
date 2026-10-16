// The finishing passes every free-form 2D mode shares (force, cluster-disc):
// fit the free nodes into the padded viewBox (shrink, never grow), push
// overlapping glyphs apart, then repair for the gate instead of leaving it
// to report: chooseSides (labels.mjs) -> declutter (noverlap.mjs) ->
// chooseSides, repeated while a round still lowers the collision count (at
// most EXPAND.retries times in one frame); when labels still collide,
// expand the arrangement about the frame centre by EXPAND.factor (the frame
// grows with it, never shrinks) and repeat, at most EXPAND.rounds times;
// last, the routes pass (route.mjs fanParallel + routeAround) and one
// route-aware chooseSides. The viewBox the mode returns is the
// grown frame united with the bounding box of every glyph and measured
// label. The lattice modes (grid, timeline, lanes) never run the node
// passes, because perturbing a lattice hides the real repair (a wider
// viewBox or spacing), which lib/gates/layout.mjs reports instead.
// Only + - * / and Math.sqrt, visited in index order.
//
//   fitToFrame(x, y, radii, fixed, frame)     -> {s, mx, my, cx, cy} | null (the transform it applied)
//   clampToFrame(x, y, fixed, frame)          -> void (in place)
//   separate(x, y, radii, fixed, frame, passes) -> passes used
//   warmStart(input, x, y, fixed)             -> true when input.warm (ctx.incremental) placed the nodes
//   warmDiscs(input, x, y)                    -> per-node confinement discs around the warm clusters (null for one cluster)
//   finishFreeForm(input, x, y, fixed, {discs}) -> {points, sides, routes, viewBox}
import { slot } from './trig.mjs';
import { forEachNearPair } from './geometry.mjs';
import { GLYPH_GAP_PX } from './metrics.mjs';
import { chooseSides, nodeBoxes } from './labels.mjs';
import { boxesBounds, declutter } from './noverlap.mjs';
import { fanParallel, routeAround } from './route.mjs';

export const SEPARATION_PASSES = 32;
export const EXPAND = Object.freeze({ factor: 1.15, rounds: 6, retries: 2, margin_px: 16 });

function bounds(frame) {
  return {
    left: frame.x0 + frame.padding,
    top: frame.y0 + frame.padding,
    right: frame.x0 + frame.w - frame.padding,
    bottom: frame.y0 + frame.h - frame.padding,
  };
}

/** Pull every free node back inside the padded box; pinned nodes stay where the author put them. */
export function clampToFrame(x, y, fixed, frame) {
  const b = bounds(frame);
  for (let i = 0; i < x.length; i += 1) {
    if (fixed[i]) continue;
    if (x[i] < b.left) x[i] = b.left; else if (x[i] > b.right) x[i] = b.right;
    if (y[i] < b.top) y[i] = b.top; else if (y[i] > b.bottom) y[i] = b.bottom;
  }
}

/**
 * Shrink (never grow) and centre the free positions so every glyph sits
 * inside the padded box. When any node is pinned the pins anchor the frame
 * and only the clamp runs, so an authored pos keeps its meaning. Returns
 * the similarity it applied (p -> c + (p - m) * s), or null for clamp-only.
 */
export function fitToFrame(x, y, radii, fixed, frame) {
  const n = x.length;
  if (n === 0) return null;
  let anyFixed = false;
  for (let i = 0; i < n; i += 1) if (fixed[i]) anyFixed = true;
  let fit = null;
  if (!anyFixed) {
    const b = bounds(frame);
    let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (x[i] - radii[i] < minx) minx = x[i] - radii[i];
      if (x[i] + radii[i] > maxx) maxx = x[i] + radii[i];
      if (y[i] - radii[i] < miny) miny = y[i] - radii[i];
      if (y[i] + radii[i] > maxy) maxy = y[i] + radii[i];
    }
    const bw = maxx - minx; const bh = maxy - miny;
    let s = 1;
    if (bw > b.right - b.left) s = (b.right - b.left) / bw;
    if (bh > b.bottom - b.top && (b.bottom - b.top) / bh < s) s = (b.bottom - b.top) / bh;
    const mx = (minx + maxx) / 2; const my = (miny + maxy) / 2;
    for (let i = 0; i < n; i += 1) {
      x[i] = frame.cx + (x[i] - mx) * s;
      y[i] = frame.cy + (y[i] - my) * s;
    }
    fit = { s, mx, my, cx: frame.cx, cy: frame.cy };
  }
  clampToFrame(x, y, fixed, frame);
  return fit;
}

/**
 * Push overlapping glyph pairs apart (gap GLYPH_GAP_PX) for up to `passes`
 * passes, clamping after each; pinned nodes never move and a pair of pins
 * is left for the gate. Returns the number of passes that ran.
 */
export function separate(x, y, radii, fixed, frame, passes = SEPARATION_PASSES) {
  const n = x.length;
  if (n < 2) return 0;
  let rMax = 0;
  for (let i = 0; i < n; i += 1) if (radii[i] > rMax) rMax = radii[i];
  const cell = 2 * rMax + GLYPH_GAP_PX + 1;
  let pass = 0;
  for (; pass < passes; pass += 1) {
    let moved = 0;
    forEachNearPair(x, y, cell, (i, j) => {
      if (fixed[i] && fixed[j]) return;
      const need = radii[i] + radii[j] + GLYPH_GAP_PX;
      let dx = x[j] - x[i];
      let dy = y[j] - y[i];
      let d2 = dx * dx + dy * dy;
      if (d2 >= need * need) return;
      if (d2 < 0.0001) { const s = slot(i + j); dx = s[0]; dy = s[1]; d2 = 1; }
      const d = Math.sqrt(d2);
      const push = (need - d) / d + 0.001;
      const px = dx * push; const py = dy * push;
      if (fixed[i]) { x[j] += px; y[j] += py; } else if (fixed[j]) { x[i] -= px; y[i] -= py; } else { x[i] -= px / 2; y[i] -= py / 2; x[j] += px / 2; y[j] += py / 2; }
      moved += 1;
    });
    clampToFrame(x, y, fixed, frame);
    if (moved === 0) break;
  }
  return pass;
}

/** Glyph pairs closer than their radii (the gate's DF_LAYOUT_OVERLAP test). */
function glyphOverlaps(x, y, radii) {
  let rMax = 0;
  for (let i = 0; i < radii.length; i += 1) if (radii[i] > rMax) rMax = radii[i];
  let count = 0;
  forEachNearPair(x, y, 2 * rMax + 1, (i, j) => {
    const dx = x[j] - x[i]; const dy = y[j] - y[i]; const need = radii[i] + radii[j];
    if (dx * dx + dy * dy < need * need) count += 1;
  });
  return count;
}

/**
 * ctx.incremental (lib/bench only): every node the scene already places
 * keeps its position; a new node starts beside the mean of its placed
 * neighbours (else the frame centre), one spacing out along a golden-angle
 * slot. Returns false when nothing was placed, so the cold path runs.
 */
export function warmStart(input, x, y, fixed) {
  const warm = input.warm;
  if (!(warm instanceof Map) || warm.size === 0) return false;
  const n = input.nodes.length; const p = input.frame.spacing;
  const nb = Array.from({ length: n }, () => []);
  for (const [a, b] of input.edges) if (a !== b) { nb[a].push(b); nb[b].push(a); }
  for (let i = 0; i < n; i += 1) {
    const q = input.pinned.get(i) ?? warm.get(i);
    if (q) { x[i] = q[0]; y[i] = q[1]; if (input.pinned.has(i)) fixed[i] = 1; continue; }
    let sx = 0; let sy = 0; let k = 0;
    for (const j of nb[i]) { const w = warm.get(j) ?? input.pinned.get(j); if (w) { sx += w[0]; sy += w[1]; k += 1; } }
    const s = slot(i);
    x[i] = (k ? sx / k : input.frame.cx) + s[0] * p;
    y[i] = (k ? sy / k : input.frame.cy) + s[1] * p;
  }
  clampToFrame(x, y, fixed, input.frame);
  return true;
}

/**
 * The confinement discs of a warm start: per cluster (group index, the
 * ungrouped pool last) the centroid of its placed members and their
 * farthest reach plus one spacing, so the repair passes keep every cluster
 * where the previous layout put it. No discs for a scene with one cluster.
 */
export function warmDiscs(input, x, y) {
  const n = input.nodes.length; const G = input.groupCount;
  const clusterOf = (i) => (input.memberOf[i] < 0 ? G : input.memberOf[i]);
  const used = new Set(); for (let i = 0; i < n; i += 1) used.add(clusterOf(i));
  if (used.size <= 1) return null;
  const sx = new Float64Array(G + 1); const sy = new Float64Array(G + 1); const k = new Int32Array(G + 1);
  for (const [i] of input.warm) { const c = clusterOf(i); sx[c] += x[i]; sy[c] += y[i]; k[c] += 1; }
  const reach = new Float64Array(G + 1);
  for (const [i] of input.warm) {
    const c = clusterOf(i); const dx = x[i] - sx[c] / k[c]; const dy = y[i] - sy[c] / k[c];
    const d = Math.sqrt(dx * dx + dy * dy) + input.radii[i];
    if (d > reach[c]) reach[c] = d;
  }
  const out = [];
  for (let i = 0; i < n; i += 1) { const c = clusterOf(i); out.push(k[c] ? { c: [sx[c] / k[c], sy[c] / k[c]], R: reach[c] + input.frame.spacing } : null); }
  return out;
}

function grow(frame, k) {
  const w = frame.w * k; const h = frame.h * k;
  const x0 = frame.cx - w / 2; const y0 = frame.cy - h / 2;
  return { ...frame, x0, y0, w, h, viewBox: [x0, y0, w, h] };
}

function confineTo(discs, radii) {
  const list = Array.isArray(discs) ? discs.filter((d) => d && Number.isFinite(d.R)) : [];
  if (!list.length) return null;
  return (i, X, Y) => {
    const d = discs[i];
    if (!d || !Number.isFinite(d.R)) return;
    const lim = d.R - radii[i];
    const dx = X[i] - d.c[0]; const dy = Y[i] - d.c[1]; const d2 = dx * dx + dy * dy;
    if (lim <= 0) { X[i] = d.c[0]; Y[i] = d.c[1]; return; }
    if (d2 <= lim * lim) return;
    const s = lim / Math.sqrt(d2);
    X[i] = d.c[0] + dx * s; Y[i] = d.c[1] + dy * s;
  };
}

/**
 * The repair passes after a free-form placement. `discs` is one confinement
 * disc per node ({c, R} in frame px, or null) so a group region can never
 * gain a foreign node; it scales with every expansion.
 */
export function finishFreeForm(input, x, y, fixed, { discs = null } = {}) {
  const n = x.length;
  let frame = { ...input.frame };
  let own = Array.isArray(discs) ? discs.map((d) => (d ? { c: [d.c[0], d.c[1]], R: d.R } : null)) : null;
  separate(x, y, input.radii, fixed, frame);
  const measured = input.measured;
  let sides = n ? chooseSides(input, x, y, { measured, routeCost: false }).sides : new Map();
  let expansions = 0; let prev = Infinity; let retries = 0;
  while (n > 1) {
    declutter(x, y, nodeBoxes(input, sides, measured), fixed, frame, { confine: own ? confineTo(own, input.radii) : null });
    const res = chooseSides({ ...input, frame }, x, y, { measured, sides, routeCost: false });
    sides = res.sides;
    const left = res.collisions + glyphOverlaps(x, y, input.radii);
    if (left === 0 || expansions >= EXPAND.rounds) break;
    // A round that still made progress gets another declutter in the same frame before the frame grows.
    if (left < prev && retries < EXPAND.retries) { prev = left; retries += 1; continue; }
    prev = Infinity; retries = 0; expansions += 1;
    const k = EXPAND.factor;
    for (let i = 0; i < n; i += 1) if (!fixed[i]) { x[i] = frame.cx + (x[i] - frame.cx) * k; y[i] = frame.cy + (y[i] - frame.cy) * k; }
    if (own) own = own.map((d) => (d ? { c: [frame.cx + (d.c[0] - frame.cx) * k, frame.cy + (d.c[1] - frame.cy) * k], R: d.R * k } : null));
    frame = grow(frame, k);
  }
  const fan = fanParallel(input, x, y);
  const around = routeAround({ ...input, frame }, x, y, { start: fan });
  const routes = { ...fan, ...around };
  if (n) sides = chooseSides({ ...input, frame }, x, y, { measured, sides, routes }).sides;
  const box = n ? boxesBounds(x, y, nodeBoxes(input, sides, measured)) : null;
  let [vx, vy, vw, vh] = frame.viewBox;
  if (box) {
    const m = EXPAND.margin_px;
    const x1 = box.x + box.w > vx + vw ? box.x + box.w + m : vx + vw;
    const y1 = box.y + box.h > vy + vh ? box.y + box.h + m : vy + vh;
    if (box.x < vx) vx = box.x - m;
    if (box.y < vy) vy = box.y - m;
    vw = x1 - vx; vh = y1 - vy;
  }
  const points = new Array(n);
  for (let i = 0; i < n; i += 1) points[i] = [x[i], y[i]];
  return { points, sides, routes, viewBox: [vx, vy, vw, vh] };
}
