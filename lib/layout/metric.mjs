// Metric layout (room): a pass-through of pose_m. The 2D position is the
// top-down map of the pose (x right; depth down the page: z for up_axis y,
// -y for up_axis z), fitted into the padded viewBox at one px-per-metre
// scale that also fits every group box. A node without a pose lands on the
// centre and the gate reports DF_LAYOUT_METRIC_NO_POSE. In 3D the pose is
// used as is (metricToThree), never lifted.
//
//   metricLayout(input)      -> [[x, y], ...]   (input shape: index.mjs prepare())
//   metricFrame(input)       -> {scale, midx, midy}  px per metre and the map centre
//   metric3d(nodes, upAxis)  -> [[X, Y, Z], ...] three.js metres
//   poseOf(node)             -> [x, y, z] or null
import { metricToThree } from './frame.mjs';

export const METRIC = Object.freeze({ max_px_per_m: 1000, fallback_px_per_m: 100 });

function vec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null;
}

/** The pose xyz when the node carries a well-formed pose_m, else null. */
export function poseOf(node) {
  const p = node && node.pose_m && typeof node.pose_m === 'object' ? node.pose_m : null;
  return p ? vec3(p.xyz) : null;
}

/** [x, depth] on the ground plane for the scene's up axis. */
export function groundOf(xyz, upAxis = 'y') {
  return upAxis === 'z' ? [xyz[0], 0 - xyz[1]] : [xyz[0], xyz[2]];
}

function groundHalf(size, upAxis) {
  const s = vec3(size);
  if (!s) return [0, 0];
  return upAxis === 'z' ? [s[0] / 2, s[1] / 2] : [s[0] / 2, s[2] / 2];
}

/** The px-per-metre scale and map centre that fit every pose and group box into the padded box. */
export function metricFrame(input) {
  const { nodes, groups, frame, upAxis } = input;
  let minx = Infinity; let miny = Infinity; let maxx = -Infinity; let maxy = -Infinity;
  const extend = (g, half) => {
    if (g[0] - half[0] < minx) minx = g[0] - half[0];
    if (g[0] + half[0] > maxx) maxx = g[0] + half[0];
    if (g[1] - half[1] < miny) miny = g[1] - half[1];
    if (g[1] + half[1] > maxy) maxy = g[1] + half[1];
  };
  for (const node of nodes) {
    const xyz = poseOf(node);
    if (xyz) extend(groundOf(xyz, upAxis), groundHalf(node.size_m, upAxis));
  }
  for (const group of groups) {
    const c = vec3(group && group.center_xyz_m);
    if (c) extend(groundOf(c, upAxis), groundHalf(group.size_xyz_m, upAxis));
  }
  if (!Number.isFinite(minx)) return { scale: METRIC.fallback_px_per_m, midx: 0, midy: 0 };
  const innerW = frame.w - 2 * frame.padding;
  const innerH = frame.h - 2 * frame.padding;
  const ew = maxx - minx;
  const eh = maxy - miny;
  let scale = Infinity;
  if (ew > 0.000001 && innerW / ew < scale) scale = innerW / ew;
  if (eh > 0.000001 && innerH / eh < scale) scale = innerH / eh;
  if (!Number.isFinite(scale)) scale = METRIC.fallback_px_per_m;
  if (scale > METRIC.max_px_per_m) scale = METRIC.max_px_per_m;
  return { scale, midx: (minx + maxx) / 2, midy: (miny + maxy) / 2 };
}

/** The metric layout over a prepared input; returns one [x, y] per node, unrounded. */
export function metricLayout(input) {
  const { nodes, frame, upAxis } = input;
  const n = nodes.length;
  if (n === 0) return [];
  const mf = metricFrame(input);
  const pos = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const xyz = poseOf(nodes[i]);
    if (!xyz) { pos[i] = [frame.cx, frame.cy]; continue; }
    const g = groundOf(xyz, upAxis);
    pos[i] = [frame.cx + (g[0] - mf.midx) * mf.scale, frame.cy + (g[1] - mf.midy) * mf.scale];
  }
  return pos;
}

/** three.js coordinates of every pose; a node without a pose sits at the origin. */
export function metric3d(nodes, upAxis = 'y') {
  return nodes.map((node) => {
    const xyz = poseOf(node);
    return xyz ? metricToThree(xyz, upAxis) : [0, 0, 0];
  });
}
