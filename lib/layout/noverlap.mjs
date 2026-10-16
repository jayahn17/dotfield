// Declutter (V2_PLAN §3 A): graphology's noverlap over the box every node
// occupies — its glyph united with its measured label on the chosen side —
// so two boxes apart means no glyph overlap, no label-glyph hit and no
// label-label hit, which is exactly what the layout gate counts. Each pass
// bins the box centres on a uniform grid (forEachNearPair), and for every
// pair whose boxes (each grown by gap/2) intersect pushes them apart along
// the axis of least penetration, half each (all of it to the free one when
// the other is pinned); the displacements of a pass are summed in index
// order and applied together, every free node is then clamped to the
// padded frame and to its own confinement, and the loop stops when nothing
// moved. Only + - * / and Math.sqrt.
//
//   declutter(X, Y, boxes, fixed, frame, {gap, passes, confine}) -> {moved, passes, overflow}
//     boxes    per node {left, right, top, bottom} offsets from the centre (labels.mjs nodeBoxes)
//     confine  optional (i, X, Y) -> void keeping node i inside its cluster disc
//     moved    pairs still overlapping after the last pass (0 = clean)
//     overflow the bounding box of every box when it leaves the frame's viewBox, else null
//   boxesBounds(X, Y, boxes) -> {x, y, w, h}
import { forEachNearPair } from './geometry.mjs';
import { LABEL_GAP_PX } from './metrics.mjs';

export const DECLUTTER = Object.freeze({ passes: 48, epsilon: 0.01 });

/** The bounding box of every node box at its centre. */
export function boxesBounds(X, Y, boxes) {
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  for (let i = 0; i < X.length; i += 1) {
    const b = boxes[i];
    if (X[i] + b.left < minx) minx = X[i] + b.left;
    if (X[i] + b.right > maxx) maxx = X[i] + b.right;
    if (Y[i] + b.top < miny) miny = Y[i] + b.top;
    if (Y[i] + b.bottom > maxy) maxy = Y[i] + b.bottom;
  }
  return Number.isFinite(minx) ? { x: minx, y: miny, w: maxx - minx, h: maxy - miny } : null;
}

function clampInto(X, Y, i, frame) {
  const left = frame.x0 + frame.padding; const right = frame.x0 + frame.w - frame.padding;
  const top = frame.y0 + frame.padding; const bottom = frame.y0 + frame.h - frame.padding;
  if (X[i] < left) X[i] = left; else if (X[i] > right) X[i] = right;
  if (Y[i] < top) Y[i] = top; else if (Y[i] > bottom) Y[i] = bottom;
}

/** One pass: the summed displacement of every overlapping pair, applied together. Returns the overlapping pair count. */
function pass(X, Y, boxes, fixed, half, DX, DY) {
  const n = X.length;
  const cx = new Float64Array(n); const cy = new Float64Array(n); const hw = new Float64Array(n); const hh = new Float64Array(n);
  let reach = 1;
  for (let i = 0; i < n; i += 1) {
    const b = boxes[i];
    cx[i] = X[i] + (b.left + b.right) / 2; cy[i] = Y[i] + (b.top + b.bottom) / 2;
    hw[i] = (b.right - b.left) / 2 + half; hh[i] = (b.bottom - b.top) / 2 + half;
    if (2 * hw[i] > reach) reach = 2 * hw[i];
    if (2 * hh[i] > reach) reach = 2 * hh[i];
    DX[i] = 0; DY[i] = 0;
  }
  let overlaps = 0;
  forEachNearPair(cx, cy, reach, (i, j) => {
    if (fixed[i] && fixed[j]) return;
    const dx = cx[j] - cx[i]; const dy = cy[j] - cy[i];
    const ox = hw[i] + hw[j] - (dx < 0 ? -dx : dx);
    const oy = hh[i] + hh[j] - (dy < 0 ? -dy : dy);
    if (ox <= 0 || oy <= 0) return;
    overlaps += 1;
    let px = 0; let py = 0;
    if (ox < oy) px = (dx < 0 || (dx === 0 && j < i) ? -1 : 1) * (ox + DECLUTTER.epsilon);
    else py = (dy < 0 || (dy === 0 && j < i) ? -1 : 1) * (oy + DECLUTTER.epsilon);
    if (fixed[i]) { DX[j] += px; DY[j] += py; } else if (fixed[j]) { DX[i] -= px; DY[i] -= py; } else { DX[i] -= px / 2; DY[i] -= py / 2; DX[j] += px / 2; DY[j] += py / 2; }
  });
  return overlaps;
}

/**
 * Push node boxes apart until none overlap or `passes` run out. Mutates X
 * and Y; pinned nodes (fixed[i]) never move.
 */
export function declutter(X, Y, boxes, fixed, frame, { gap = LABEL_GAP_PX, passes = DECLUTTER.passes, confine = null } = {}) {
  const n = X.length;
  const DX = new Float64Array(n); const DY = new Float64Array(n);
  let ran = 0; let moved = 0;
  if (n >= 2) {
    for (; ran < passes; ran += 1) {
      moved = pass(X, Y, boxes, fixed, gap / 2, DX, DY);
      if (moved === 0) break;
      for (let i = 0; i < n; i += 1) {
        if (fixed[i] || (DX[i] === 0 && DY[i] === 0)) continue;
        X[i] += DX[i]; Y[i] += DY[i];
        clampInto(X, Y, i, frame);
        if (confine) confine(i, X, Y);
      }
    }
    if (ran === passes) moved = pass(X, Y, boxes, fixed, gap / 2, DX, DY);
  }
  const bounds = boxesBounds(X, Y, boxes);
  const leaves = bounds !== null && (bounds.x < frame.x0 || bounds.y < frame.y0 || bounds.x + bounds.w > frame.x0 + frame.w || bounds.y + bounds.h > frame.y0 + frame.h);
  return { moved, passes: ran, overflow: leaves ? bounds : null };
}
