// Lift: the 3D view of a graph-like scene is the 2D wall (frame.toThree)
// plus a bounded Z derived from views.3d.lift — never a second layout.
//   group-weight: z = amplitude * (tier(group) + 0.5 * (weight - 0.5)), tiers
//                 spread evenly over [-0.5, 0.5] in groups[] order, ungrouped last
//   weight:       z = amplitude * (2 * weight - 1)
//   flat:         z = 0
// Every z is clamped to +-0.5 * views.3d.scale_m. An edge route lifts with
// its ends: a via vertex takes z = za + (zb - za) * (arc length to it / total
// arc length), the rule the three-4d ticket mirrors in the browser.
//
//   liftParams(scene)                    -> {mode, amplitude_m, scale_m, bound}
//   liftZ(input)                         -> Float64Array of z per node
//   liftPositions(input, positions2d)    -> [[X, Y, Z], ...] three.js metres
//   liftPolyline(input, poly, za, zb)    -> [[X, Y, Z], ...] a 2D route in three.js metres
import { toThree } from './frame.mjs';
import { DEFAULT_SCALE_M } from './metrics.mjs';

export const LIFT_MODES = Object.freeze(['group-weight', 'weight', 'flat']);
export const DEFAULT_LIFT = Object.freeze({ mode: 'flat', amplitude_m: 0 });

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** The lift parameters a scene declares, with defaults and the Z bound. */
export function liftParams(scene) {
  const views = isObject(scene) && isObject(scene.views) ? scene.views : {};
  const v3 = isObject(views['3d']) ? views['3d'] : {};
  const lift = isObject(v3.lift) ? v3.lift : {};
  const scaleM = typeof v3.scale_m === 'number' && v3.scale_m > 0 ? v3.scale_m : DEFAULT_SCALE_M;
  const mode = LIFT_MODES.includes(lift.mode) ? lift.mode : DEFAULT_LIFT.mode;
  const amp = typeof lift.amplitude_m === 'number' && lift.amplitude_m >= 0 ? lift.amplitude_m : DEFAULT_LIFT.amplitude_m;
  return { mode, amplitude_m: amp, scale_m: scaleM, bound: 0.5 * scaleM };
}

function weightOf(node) {
  return node && typeof node.weight === 'number' && Number.isFinite(node.weight) ? node.weight : 0.5;
}

/** Tier of node i in [-0.5, 0.5]: groups[] order, the ungrouped tier last; 0 when there is one tier. */
export function tierValue(input, i) {
  const { memberOf, groupCount, hasUngrouped } = input;
  const tiers = groupCount + (hasUngrouped ? 1 : 0);
  if (tiers <= 1) return 0;
  const ti = memberOf[i] < 0 ? groupCount : memberOf[i];
  return ti / (tiers - 1) - 0.5;
}

/** The bounded z of every node under the scene's lift mode. */
export function liftZ(input) {
  const { nodes, scene } = input;
  const { mode, amplitude_m: amp, bound } = liftParams(scene);
  const z = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i += 1) {
    const w = weightOf(nodes[i]);
    let v = 0;
    if (mode === 'group-weight') v = amp * (tierValue(input, i) + 0.5 * (w - 0.5));
    else if (mode === 'weight') v = amp * (2 * w - 1);
    if (v > bound) v = bound;
    else if (v < 0 - bound) v = 0 - bound;
    z[i] = v;
  }
  return z;
}

/** The lifted 3D position of every node: toThree of the 2D position plus the lift z. */
export function liftPositions(input, positions2d) {
  const z = liftZ(input);
  return positions2d.map((p, i) => toThree([p[0], p[1], z[i]], input.frame));
}

/** A 2D polyline (viewBox px) in three.js metres, z interpolated by arc-length fraction between the end heights za and zb. */
export function liftPolyline(input, poly, za, zb) {
  const pts = Array.isArray(poly) ? poly.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
  if (!pts.length) return [];
  const a = Number.isFinite(za) ? za : 0;
  const b = Number.isFinite(zb) ? zb : a;
  const run = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const dx = pts[i][0] - pts[i - 1][0]; const dy = pts[i][1] - pts[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    run.push(total);
  }
  const last = pts.length - 1;
  return pts.map((p, i) => {
    const f = total > 0 ? run[i] / total : (i === last && last > 0 ? 1 : 0);
    return toThree([p[0], p[1], a + (b - a) * f], input.frame);
  });
}
