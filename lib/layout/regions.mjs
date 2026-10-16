// Group regions, as svg draws them and lib/gates/layout.mjs measures them.
// A free-form or lattice group is the convex hull of its members padded by
// the largest member glyph plus REGION_PAD_PX; a zone of a layered or
// lifecycle scene is an axis-aligned band across the in-layer axis (the
// layered layout gives every block one interval in every layer), so its
// region is the band widened by the pad. lib/gates/layout.mjs re-exports
// regionOf and insideRegion so renderers keep their import path. Pure.
//
//   regionOf(points, radii)            -> {hull, pad}
//   bandRegionOf(band, axis, pad)      -> {band: [lo, hi], axis: 'x'|'y', pad, hull: []}
//   insideRegion(p, region)            -> boolean (hull interior or within pad; band: lo - pad < p[axis] < hi + pad)
//   groupBands(input, X, Y, axis, ext) -> [[lo, hi] | null per group] member extents along the axis
import { convexHull, distanceToPolyline, pointInPolygon } from './geometry.mjs';
import { REGION_PAD_PX } from './metrics.mjs';

/** The padded region a graph-like group occupies: its members' convex hull grown by the largest member glyph plus REGION_PAD_PX. */
export function regionOf(points, radii) {
  let rMax = 0;
  for (const r of radii) if (r > rMax) rMax = r;
  return { hull: convexHull(points), pad: rMax + REGION_PAD_PX };
}

/** The region of a layered zone: the band [lo, hi] on the in-layer axis ('x' for down|up, 'y' for right|left), widened by pad. */
export function bandRegionOf(band, axis, pad = REGION_PAD_PX) {
  const lo = Array.isArray(band) && Number.isFinite(band[0]) ? band[0] : 0;
  const hi = Array.isArray(band) && Number.isFinite(band[1]) ? band[1] : lo;
  return { band: [lo < hi ? lo : hi, lo < hi ? hi : lo], axis: axis === 'y' ? 'y' : 'x', pad: Number.isFinite(pad) ? pad : REGION_PAD_PX, hull: [] };
}

/** Is a point inside a region (hull interior or within pad of its boundary; for a band, within pad of the interval)? */
export function insideRegion(p, region) {
  if (region && Array.isArray(region.band)) {
    const v = region.axis === 'y' ? p[1] : p[0];
    return v > region.band[0] - region.pad && v < region.band[1] + region.pad;
  }
  if (!region || !region.hull.length) return false;
  if (region.hull.length >= 3 && pointInPolygon(p, region.hull)) return true;
  return distanceToPolyline(p, region.hull, region.hull.length >= 3) < region.pad;
}

/** Per group, the interval its members' glyphs span on the axis (ext[i] = the half extent of node i on that axis); null for an empty group. */
export function groupBands(input, X, Y, axis, ext) {
  const bands = input.groups.map(() => null);
  const C = axis === 'y' ? Y : X;
  for (let i = 0; i < input.nodes.length; i += 1) {
    const gi = input.memberOf[i];
    if (gi < 0) continue;
    const lo = C[i] - ext[i]; const hi = C[i] + ext[i];
    const b = bands[gi];
    if (!b) bands[gi] = [lo, hi];
    else { if (lo < b[0]) b[0] = lo; if (hi > b[1]) b[1] = hi; }
  }
  return bands;
}
