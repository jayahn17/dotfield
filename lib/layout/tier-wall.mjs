// Tier wall: the 3D (and VR) view that stands groups on shelves. X keeps
// the 2D x (a timeline stays in order), Y is the shelf of the node's tier
// (groups[] order from the bottom, ungrouped nodes on the top shelf), Z is
// a quarter-depth from the 2D y so a lanes board reads as shelves rather
// than a flat wall. The wall is 0.5 * scale_m tall and starts 0.5 m above
// the origin, so a VR floor at y = 0 shows every shelf at hand height.
//
//   tierCount(input)                      -> number of shelves
//   tierIndex(input, i)                   -> shelf of node i (0 = bottom)
//   tierWallPositions(input, positions2d) -> [[X, Y, Z], ...] three.js metres
import { DEFAULT_SCALE_M } from './metrics.mjs';

export const TIER_WALL = Object.freeze({ base_m: 0.5, height_mult: 0.5, depth_mult: 0.25 });

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function tierCount(input) {
  const tiers = input.groupCount + (input.hasUngrouped ? 1 : 0);
  return tiers > 0 ? tiers : 1;
}

export function tierIndex(input, i) {
  return input.memberOf[i] < 0 ? input.groupCount : input.memberOf[i];
}

/** The tier-wall 3D position of every node. */
export function tierWallPositions(input, positions2d) {
  const { frame, scene } = input;
  const views = isObject(scene) && isObject(scene.views) ? scene.views : {};
  const v3 = isObject(views['3d']) ? views['3d'] : {};
  const scaleM = typeof v3.scale_m === 'number' && v3.scale_m > 0 ? v3.scale_m : DEFAULT_SCALE_M;
  const tiers = tierCount(input);
  const height = scaleM * TIER_WALL.height_mult;
  const mpp = frame.metres_per_px;
  return positions2d.map((p, i) => {
    const ti = tierIndex(input, i);
    const X = (p[0] - frame.cx) * mpp;
    const Y = TIER_WALL.base_m + (height * (ti + 0.5)) / tiers;
    const Z = (p[1] - frame.cy) * mpp * TIER_WALL.depth_mult;
    return [X, Y, Z];
  });
}
