// The frame: the one place that knows how the 2D positions table maps to
// SVG, to three.js and to VR. svg.mjs and three.mjs both import it, so the
// y-flip (SVG y down, three y up) and the unit scale (metres per pixel) exist
// once. There is one positions table per scene; 3D and VR are transforms of
// it, never a second table.
//
//   2D / SVG : [x, y] in viewBox pixels, y down.
//   3D       : [X, Y, Z] metres; the 2D plane is the XY wall facing the
//              default camera (+Z), centred on the viewBox centre, the larger
//              viewBox side spanning views.3d.scale_m; Z is the lift.
//   VR       : the 3D scene scaled by views.vr.scale_m / views.3d.scale_m and
//              raised onto the floor: the lift wall is centred at eye height,
//              a tier wall or a metric room stands on the floor.
import { DEFAULT_SCALE_M, DEFAULT_VIEWBOX, DEFAULT_PADDING, DEFAULT_SPACING } from './metrics.mjs';

export const DEFAULT_EYE_HEIGHT_M = 1.6;
export const DEFAULT_FLOOR_Y = 0;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function pos(v, fallback) { const n = num(v, fallback); return n > 0 ? n : fallback; }

/** views.2d.viewBox as [x, y, w, h] with positive w and h, else the default. */
export function viewBoxOf(scene) {
  const v2 = isObject(scene) && isObject(scene.views) && isObject(scene.views['2d']) ? scene.views['2d'] : {};
  const vb = v2.viewBox;
  if (Array.isArray(vb) && vb.length === 4 && vb.every((n) => typeof n === 'number' && Number.isFinite(n)) && vb[2] > 0 && vb[3] > 0) return [vb[0], vb[1], vb[2], vb[3]];
  return [...DEFAULT_VIEWBOX];
}

/** Everything a layout or a renderer needs to place and scale a scene. */
export function frameOf(scene) {
  const s = isObject(scene) ? scene : {};
  const views = isObject(s.views) ? s.views : {};
  const v2 = isObject(views['2d']) ? views['2d'] : {};
  const v3 = isObject(views['3d']) ? views['3d'] : {};
  const viewBox = viewBoxOf(s);
  const [x0, y0, w, h] = viewBox;
  const padding = num(v2.padding, DEFAULT_PADDING);
  const scaleM = pos(v3.scale_m, DEFAULT_SCALE_M);
  const major = w > h ? w : h;
  return {
    viewBox, x0, y0, w, h,
    cx: x0 + w / 2,
    cy: y0 + h / 2,
    padding: padding * 2 < (w < h ? w : h) ? padding : 0,
    spacing: pos(v2.spacing, DEFAULT_SPACING),
    seed: Number.isInteger(v2.seed) && v2.seed >= 0 ? v2.seed : 0,
    scale_m: scaleM,
    metres_per_px: scaleM / major,
  };
}

/** The 2D truth: a position is already in SVG space. */
export function toSvg(p) {
  return [num(p && p[0], 0), num(p && p[1], 0)];
}

/** [x, y] (+ optional z in metres) -> three.js [X, Y, Z]: centred, scaled, y flipped. */
export function toThree(p, frame) {
  const f = frame && typeof frame === 'object' ? frame : frameOf(null);
  const mpp = num(f.metres_per_px, DEFAULT_SCALE_M / DEFAULT_VIEWBOX[2]);
  const x = num(p && p[0], 0);
  const y = num(p && p[1], 0);
  const z = num(p && p[2], 0);
  return [(x - num(f.cx, 0)) * mpp, (num(f.cy, 0) - y) * mpp, z];
}

/** A metric pose (metres, scene up_axis) -> three.js [X, Y, Z] (y up). */
export function metricToThree(xyz, upAxis = 'y') {
  const x = num(xyz && xyz[0], 0);
  const y = num(xyz && xyz[1], 0);
  const z = num(xyz && xyz[2], 0);
  return upAxis === 'z' ? [x, z, 0 - y] : [x, y, z];
}

/**
 * The VR transform of a scene: k scales 3D metres to VR metres, y0 is the
 * height the 3D origin lands at (floor + eye height for a lift wall, floor
 * for a tier wall or a metric room). `layout3d` is views.3d.layout.
 */
export function vrFrame(scene, layout3d) {
  const s = isObject(scene) ? scene : {};
  const views = isObject(s.views) ? s.views : {};
  const v3 = isObject(views['3d']) ? views['3d'] : {};
  const vr = isObject(views.vr) ? views.vr : {};
  const scale3 = pos(v3.scale_m, DEFAULT_SCALE_M);
  const scaleVr = pos(vr.scale_m, scale3);
  const mode = typeof layout3d === 'string' ? layout3d : (typeof v3.layout === 'string' ? v3.layout : 'lift');
  const floorY = num(vr.floor_y, DEFAULT_FLOOR_Y);
  const eye = num(vr.eye_height_m, DEFAULT_EYE_HEIGHT_M);
  return {
    enabled: vr.enabled === true,
    k: scaleVr / scale3,
    floor_y: floorY,
    eye_height_m: eye,
    y0: mode === 'lift' ? floorY + eye : floorY,
  };
}

/** three.js [X, Y, Z] -> VR [X, Y, Z] under a vrFrame. */
export function toVr(p, vr) {
  const f = vr && typeof vr === 'object' ? vr : { k: 1, y0: 0 };
  const k = num(f.k, 1);
  const y0 = num(f.y0, 0);
  return [num(p && p[0], 0) * k, num(p && p[1], 0) * k + y0, num(p && p[2], 0) * k];
}

/** Round to 1e-3 (positions) or another decimal place; exact for the sizes layout handles. */
export function roundTo(v, places = 3) {
  const f = places === 3 ? 1000 : 10 ** places;
  return Math.round(v * f) / f;
}
