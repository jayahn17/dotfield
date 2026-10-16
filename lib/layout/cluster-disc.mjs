// Cluster-disc layout: one sunflower disc per group (heavier nodes nearer
// the centre) at a pitch that fits the members' label boxes, ungrouped
// nodes in a disc of their own, discs packed on a golden-angle spiral
// largest first, the whole arrangement centred in the viewBox and shrunk
// only when it does not fit, then the shared finishing
// passes of pack.mjs (separate, label sides, declutter, expansion, routes)
// repair what the packing leaves, each node confined to its own disc so a
// group region never gains a foreign node. ctx.incremental (lib/bench only)
// keeps every placed node and runs the finishing passes alone. Only the
// committed slot table and + - * / sqrt, so the layout is identical on
// every runtime.
//
//   clusterDiscLayout(input) -> {points, sides, routes, viewBox}   (input shape: index.mjs prepare())
//   discRadius(m, pitch, margin) -> the disc radius for m members at a pitch
//   discPitch(list, boxes, spacing) -> the label-aware fill pitch of a cluster
import { slot } from './trig.mjs';
import { finishFreeForm, warmDiscs, warmStart } from './pack.mjs';
import { nodeBoxes } from './labels.mjs';
import { LABEL_GAP_PX } from './metrics.mjs';

export const DISC = Object.freeze({ fill: 0.564, spiral_mult: 0.8, max_spiral: 20000 });

/** A sunflower of m points at pitch p covers a disc of radius 0.564 * p * sqrt(m); one margin (default: one pitch) is added. */
export function discRadius(m, pitch, margin = pitch) {
  return pitch * DISC.fill * Math.sqrt(m) + margin;
}

/**
 * The fill pitch a cluster needs so its members' boxes (glyph united with
 * the measured label, labels.mjs nodeBoxes) fit: the square root of their
 * mean box area (each box grown by LABEL_GAP_PX), never below the spacing.
 */
export function discPitch(list, boxes, spacing) {
  if (!list.length) return spacing;
  let area = 0;
  for (const i of list) { const b = boxes[i]; area += (b.right - b.left + LABEL_GAP_PX) * (b.bottom - b.top + LABEL_GAP_PX); }
  const pe = Math.sqrt(area / list.length);
  return pe > spacing ? pe : spacing;
}

/** Members per disc, index G holding the ungrouped nodes; each list in node order. */
function membersByDisc(input) {
  const { nodes, memberOf, groupCount } = input;
  const members = [];
  for (let gi = 0; gi <= groupCount; gi += 1) members.push([]);
  for (let i = 0; i < nodes.length; i += 1) members[memberOf[i] < 0 ? groupCount : memberOf[i]].push(i);
  return members;
}

function weightOf(node) {
  return node && typeof node.weight === 'number' && Number.isFinite(node.weight) ? node.weight : 0.5;
}

/** Pack disc centres: the largest at the origin, each next one at the first free slot of a golden-angle spiral. */
export function packDiscs(discs, pitch) {
  const order = discs.map((d, idx) => idx).sort((a, b) => (discs[b].R - discs[a].R) || (a - b));
  const centres = new Array(discs.length);
  const placed = [];
  for (const idx of order) {
    const d = discs[idx];
    let found = null;
    if (placed.length === 0) found = [0, 0];
    for (let s = 1; s < DISC.max_spiral && found === null; s += 1) {
      const r = pitch * DISC.spiral_mult * Math.sqrt(s);
      const u = slot(s);
      const c = [r * u[0], r * u[1]];
      let ok = true;
      for (let q = 0; q < placed.length && ok; q += 1) {
        const dx = c[0] - placed[q].c[0];
        const dy = c[1] - placed[q].c[1];
        const need = d.R + placed[q].R + pitch;
        if (dx * dx + dy * dy < need * need) ok = false;
      }
      if (ok) found = c;
    }
    centres[idx] = found === null ? [0, 0] : found;
    placed.push({ c: centres[idx], R: d.R });
  }
  return centres;
}

/** The cluster-disc layout over a prepared input: unrounded points plus the sides, sparse routes and viewBox of the finishing passes. */
export function clusterDiscLayout(input) {
  const { nodes, groupCount, frame, pinned } = input;
  const n = nodes.length;
  if (n === 0) return [];
  const p = frame.spacing;
  const members = membersByDisc(input);
  const boxes = nodeBoxes(input, null, input.measured);
  const discs = [];
  for (let gi = 0; gi <= groupCount; gi += 1) {
    if (members[gi].length) discs.push({ gi, m: members[gi].length, R: discRadius(members[gi].length, discPitch(members[gi], boxes, p), p) });
  }
  const centres = packDiscs(discs, p);
  const pos = new Array(n);
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  for (let d = 0; d < discs.length; d += 1) {
    const disc = discs[d];
    const c = centres[d];
    const list = members[disc.gi].slice().sort((a, b) => (weightOf(nodes[b]) - weightOf(nodes[a])) || (a - b));
    const inner = disc.R - p;
    for (let k = 0; k < list.length; k += 1) {
      const r = disc.m === 1 ? 0 : inner * Math.sqrt((k + 0.5) / disc.m);
      const u = slot(k);
      pos[list[k]] = [c[0] + r * u[0], c[1] + r * u[1]];
    }
    if (c[0] - disc.R < minx) minx = c[0] - disc.R;
    if (c[0] + disc.R > maxx) maxx = c[0] + disc.R;
    if (c[1] - disc.R < miny) miny = c[1] - disc.R;
    if (c[1] + disc.R > maxy) maxy = c[1] + disc.R;
  }
  const innerW = frame.w - 2 * frame.padding;
  const innerH = frame.h - 2 * frame.padding;
  let s = 1;
  if (maxx - minx > innerW) s = innerW / (maxx - minx);
  if (maxy - miny > innerH && innerH / (maxy - miny) < s) s = innerH / (maxy - miny);
  const mx = (minx + maxx) / 2;
  const my = (miny + maxy) / 2;
  const x = new Float64Array(n); const y = new Float64Array(n);
  const fixed = new Uint8Array(n);
  if (warmStart(input, x, y, fixed)) return finishFreeForm(input, x, y, fixed, { discs: warmDiscs(input, x, y) });
  for (let i = 0; i < n; i += 1) {
    const q = pinned.get(i);
    if (q) { x[i] = q[0]; y[i] = q[1]; fixed[i] = 1; } else { x[i] = frame.cx + (pos[i][0] - mx) * s; y[i] = frame.cy + (pos[i][1] - my) * s; }
  }
  const own = new Array(n).fill(null);
  if (discs.length > 1) {
    discs.forEach((disc, d) => {
      const c = [frame.cx + (centres[d][0] - mx) * s, frame.cy + (centres[d][1] - my) * s];
      for (const i of members[disc.gi]) own[i] = { c, R: (disc.R - p / 2) * s };
    });
  }
  return finishFreeForm(input, x, y, fixed, { discs: own });
}
