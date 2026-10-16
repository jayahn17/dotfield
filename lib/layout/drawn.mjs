// What the 2D renderer draws beside the glyphs, as boxes and discs: the one
// place svg.mjs, svg-edges.mjs and lib/gates/layout.mjs get them from, so
// what is measured is what is drawn. Node labels (within the budget) on
// labelSide(), their sublabels and evidence pins (a node beyond the budget
// draws all three hidden), edge labels on edgePolyline(), order badges on
// an order axis, and the group regions with their labels. A region label
// takes the first of its candidate places that is clear of every other
// drawn item, earlier region labels and the viewBox edge: inside the
// top-left corner of a room box or zone band (then the other corners, then
// just above it); for a hull region, just above its topmost vertex (then
// below the bottommost, left of the leftmost, right of the rightmost). With
// no clear place it keeps the first, and the gate reports the collision.
// Pure; index-ordered.
//
//   drawnItems(scene, input, X, Y, g)       -> [{kind: glyph|label|sublabel|pin|edge|badge, i, x, y, w, h, ...}]
//     i: node index for node items, -1 - edge index (scene order) for edge items;
//     a badge also carries ek (its index in input.edges), its disc (cx, cy, r) and w0
//     (the number's advance): placed in edge order, each on the first spot of its
//     route clear of every glyph, label, pin, edge label and earlier badge
//   itemsHit(u, v, g, X, Y, radii)           -> do two drawn items overlap (boxes strictly, a badge as its disc)?
//   regionShapes(input, X, Y, g, has)        -> per group {kind: room|band|hull, box?, region?, axis?} | null (nothing drawn)
//   regionLabels(input, X, Y, g, items, has) -> per group {x, baseline, w, box, clear} | null
import { boxesOverlap, circleBoxOverlap, edgePolyline } from './geometry.mjs';
import { LABEL_LINE_HEIGHT, REGION_PAD_PX, badgeCircle, edgeLabelBox, labelBox, labelSide, labelWidth, pinBoxes, sublabelBox } from './metrics.mjs';
import { glyphHitsBox } from './labels.mjs';
import { bandRegionOf, groupBands, regionOf } from './regions.mjs';
import { directionOf } from './layered.mjs';
import { groundOf, metricFrame } from './metric.mjs';

/** Region labels: 11 px, 6 px inside a box corner (baseline 14 px down), or 4 px off a hull's padded outline. */
export const REGION_LABEL_SIZE = 11;
const BANDED = Object.freeze(['layered', 'lifecycle']);

/** Does glyph k overlap the disc (cx, cy, r)? A circle by centre distance, a pill by its box. */
function glyphHitsDisc(g, k, X, Y, radii, d) {
  if (g.pill[k]) return circleBoxOverlap(d.cx, d.cy, d.r, { x: X[k] - g.hx[k], y: Y[k] - g.hy[k], w: 2 * g.hx[k], h: 2 * g.hy[k] });
  const dx = d.cx - X[k]; const dy = d.cy - Y[k]; const need = d.r + radii[k];
  return dx * dx + dy * dy < need * need;
}

export function itemsHit(u, v, g, X, Y, radii) {
  if (u.kind === 'glyph' && v.kind === 'glyph') return false;
  if (u.kind === 'glyph') return itemsHit(v, u, g, X, Y, radii);
  if (v.kind === 'glyph') return u.kind === 'badge' ? glyphHitsDisc(g, v.i, X, Y, radii, u) : glyphHitsBox(g, v.i, X, Y, radii, u);
  if (u.kind === 'badge' && v.kind === 'badge') { const dx = u.cx - v.cx; const dy = u.cy - v.cy; return dx * dx + dy * dy < (u.r + v.r) * (u.r + v.r); }
  if (u.kind === 'badge') return circleBoxOverlap(u.cx, u.cy, u.r, v);
  if (v.kind === 'badge') return circleBoxOverlap(v.cx, v.cy, v.r, u);
  return boxesOverlap(u, v);
}

export function drawnItems(scene, input, X, Y, g) {
  const { nodes, radii, shapes, measured, style, edges } = input;
  const items = [];
  nodes.forEach((n, i) => {
    items.push({ kind: 'glyph', i, x: X[i] - g.hx[i], y: Y[i] - g.hy[i], w: 2 * g.hx[i], h: 2 * g.hy[i] });
    const labelled = typeof n.label === 'string' && n.label.length > 0;
    if (labelled && !measured.has(i)) return;
    const p = [X[i], Y[i]]; const side = labelSide(scene, n, shapes);
    if (labelled) items.push({ kind: 'label', i, ...labelBox(n, p, radii[i], style, shapes, side) });
    const sub = sublabelBox(n, p, radii[i], style, shapes, side);
    if (sub) items.push({ kind: 'sublabel', i, x: sub.x, y: sub.y, w: sub.w, h: sub.h });
    pinBoxes(n, p, radii[i], style, input.pinLabel).forEach((b, k) => items.push({ kind: 'pin', i, k, label: b.label, x: b.x, y: b.y, w: b.w, h: b.h }));
  });
  const sceneEdges = Array.isArray(scene.edges) ? scene.edges : [];
  const polys = edges.map(([a, b, e]) => edgePolyline(scene, e, [X[a], Y[a]], [X[b], Y[b]]));
  edges.forEach(([, , e], k) => { if (typeof e.label === 'string' && e.label.length) items.push({ kind: 'edge', i: -1 - sceneEdges.indexOf(e), e, ...edgeLabelBox(e, polys[k], style) }); });
  // Badges last, in edge order: each takes the first place on its route clear of everything above and of the badges before it.
  const fixed = items.length;
  edges.forEach(([, , e], k) => {
    if (!input.badges.has(k)) return;
    const i = -1 - sceneEdges.indexOf(e);
    const blocked = (q, r) => { const disc = { kind: 'badge', cx: q[0], cy: q[1], r, x: q[0] - r, y: q[1] - r, w: 2 * r, h: 2 * r }; return items.some((it, n) => (n >= fixed || it.i !== i) && itemsHit(disc, it, g, X, Y, radii)); };
    const d = badgeCircle(e, polys[k], input.badges.get(k), style, blocked);
    items.push({ kind: 'badge', i, e, ek: k, cx: d.cx, cy: d.cy, r: d.r, w0: d.w, x: d.cx - d.r, y: d.cy - d.r, w: 2 * d.r, h: 2 * d.r });
  });
  return items;
}

/** The drawn box of a layered zone: the gate's band on the in-layer axis, the members' glyphs and labels on the other, both padded. */
function zoneBox(input, gi, X, Y, g, band, axis) {
  const { nodes, memberOf, radii, shapes, scene, style } = input;
  const region = bandRegionOf(band, axis, REGION_PAD_PX);
  let lo = Infinity; let hi = -Infinity;
  nodes.forEach((n, i) => {
    if (memberOf[i] !== gi) return;
    const ext = [[X[i] - g.hx[i], Y[i] - g.hy[i], 2 * g.hx[i], 2 * g.hy[i]]];
    if (typeof n.label === 'string' && n.label) { const b = labelBox(n, [X[i], Y[i]], radii[i], style, shapes, labelSide(scene, n, shapes)); ext.push([b.x, b.y, b.w, b.h]); }
    for (const [x, y, w, h] of ext) { const a = axis === 'x' ? y : x; const b = a + (axis === 'x' ? h : w); if (a < lo) lo = a; if (b > hi) hi = b; }
  });
  const a0 = region.band[0] - region.pad; const a1 = region.band[1] + region.pad; const c0 = lo - region.pad; const c1 = hi + region.pad;
  return axis === 'x' ? { x: a0, y: c0, w: a1 - a0, h: c1 - c0 } : { x: c0, y: a0, w: c1 - c0, h: a1 - a0 };
}

/** The drawn box of a grid group (archify draws boundaries as rectangles): the members' glyphs and labels, padded; null when no member is drawn. */
function memberBox(input, gi, X, Y, g, has) {
  const { nodes, memberOf, radii, shapes, scene, style } = input;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  nodes.forEach((n, i) => {
    if (memberOf[i] !== gi || (has && !has[i])) return;
    const ext = [[X[i] - g.hx[i], Y[i] - g.hy[i], 2 * g.hx[i], 2 * g.hy[i]]];
    if (typeof n.label === 'string' && n.label) { const b = labelBox(n, [X[i], Y[i]], radii[i], style, shapes, labelSide(scene, n, shapes)); ext.push([b.x, b.y, b.w, b.h]); }
    for (const [x, y, w, h] of ext) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + w > x1) x1 = x + w; if (y + h > y1) y1 = y + h; }
  });
  if (!(x1 > x0)) return null;
  const pad = REGION_PAD_PX;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Per group, what svg.mjs draws: a room box (metric), a zone band (layered, lifecycle), a member box (grid, as archify draws boundaries) or a padded hull; `has[i]` false leaves node i out of hulls and boxes. */
export function regionShapes(input, X, Y, g, has = null) {
  const { nodes, groups, memberOf, radii, frame, upAxis } = input;
  const room = input.scene.kind === 'room';
  const mf = room ? metricFrame(input) : null;
  const banded = !room && BANDED.includes(input.mode2d);
  const axis = banded && ['right', 'left'].includes(directionOf(input, input.mode2d === 'lifecycle' ? 'right' : 'down')) ? 'y' : 'x';
  const bands = banded ? groupBands(input, X, Y, axis, axis === 'x' ? g.hx : g.hy) : null;
  return groups.map((gr, gi) => {
    if (room) {
      const c = Array.isArray(gr.center_xyz_m) ? gr.center_xyz_m : null; const sz = Array.isArray(gr.size_xyz_m) ? gr.size_xyz_m : null;
      if (!c || !sz) return null;
      const gc = groundOf(c, upAxis); const half = upAxis === 'z' ? [sz[0] / 2, sz[1] / 2] : [sz[0] / 2, sz[2] / 2];
      return { kind: 'room', box: { x: frame.cx + (gc[0] - mf.midx - half[0]) * mf.scale, y: frame.cy + (gc[1] - mf.midy - half[1]) * mf.scale, w: 2 * half[0] * mf.scale, h: 2 * half[1] * mf.scale } };
    }
    if (banded) return bands[gi] ? { kind: 'band', axis, box: zoneBox(input, gi, X, Y, g, bands[gi], axis) } : null;
    if (input.mode2d === 'grid') {
      // archify draws a boundary as a rectangle; use one whenever it holds no other node's centre, else keep the hull (a non-contiguous group stays truthful and never newly blocks).
      const box = memberBox(input, gi, X, Y, g, has);
      const clear = box && nodes.every((n, i) => memberOf[i] === gi || X[i] < box.x || X[i] > box.x + box.w || Y[i] < box.y || Y[i] > box.y + box.h);
      if (clear) return { kind: 'box', box };
    }
    const pts = []; const rs = [];
    nodes.forEach((n, i) => { if (memberOf[i] === gi && (!has || has[i])) { pts.push([X[i], Y[i]]); rs.push(radii[i]); } });
    return pts.length ? { kind: 'hull', region: regionOf(pts, rs) } : null;
  });
}

/** Candidate places for a region label of width w: [text x, baseline], best first. */
function candidates(shape, w) {
  const S = REGION_LABEL_SIZE;
  if (shape.kind !== 'hull') {
    const b = shape.box;
    return [[b.x + 6, b.y + 14], [b.x + b.w - 6 - w, b.y + 14], [b.x + 6, b.y + b.h - 6], [b.x + b.w - 6 - w, b.y + b.h - 6], [b.x + 6, b.y - 4]];
  }
  const { hull, pad } = shape.region;
  let top = hull[0]; let bottom = hull[0]; let left = hull[0]; let right = hull[0];
  for (const p of hull) {
    if (p[1] < top[1] || (p[1] === top[1] && p[0] < top[0])) top = p;
    if (p[1] > bottom[1] || (p[1] === bottom[1] && p[0] < bottom[0])) bottom = p;
    if (p[0] < left[0] || (p[0] === left[0] && p[1] < left[1])) left = p;
    if (p[0] > right[0] || (p[0] === right[0] && p[1] < right[1])) right = p;
  }
  return [[top[0] - w / 2, top[1] - pad - 4], [bottom[0] - w / 2, bottom[1] + pad + 2 + S], [left[0] - pad - 4 - w, left[1] + S / 3], [right[0] + pad + 4, right[1] + S / 3]];
}

export function regionLabels(input, X, Y, g, items, has = null) {
  const shapes = regionShapes(input, X, Y, g, has);
  const vb = input.frame.viewBox;
  const placed = [];
  return input.groups.map((gr, gi) => {
    const shape = shapes[gi];
    if (!shape) return null;
    const text = String(gr.label ?? gr.id);
    const w = labelWidth(text, { ...input.style, size: REGION_LABEL_SIZE });
    const at = ([x, baseline]) => ({ x, baseline, w, text, box: { x, y: baseline - REGION_LABEL_SIZE, w, h: REGION_LABEL_SIZE * LABEL_LINE_HEIGHT } });
    const inFrame = (b) => b.x >= vb[0] && b.y >= vb[1] && b.x + b.w <= vb[0] + vb[2] && b.y + b.h <= vb[1] + vb[3];
    const clear = (c) => inFrame(c.box) && !placed.some((b) => boxesOverlap(b, c.box)) && !items.some((it) => itemsHit({ kind: 'region', ...c.box }, it, g, X, Y, input.radii));
    const list = candidates(shape, w).map(at);
    const pick = list.find(clear);
    const out = pick ? { ...pick, clear: true } : { ...list[0], clear: false };
    placed.push(out.box);
    return { ...out, shape };
  });
}
