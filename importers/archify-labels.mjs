// archify's label fallback, reproduced as label_at (references/
// ARCHIFY_PARITY.md). archify keeps a connection label at its default spot
// when clear and otherwise "tries a bounded set of nearby positions along the
// existing route, avoiding nodes … other labels" (archify authoring contract,
// Spacing and labels); its own labelAt/labelSegment are canvas coordinates
// and do not carry into the import frame. This file does the same over the
// polylines the import will draw: every labelled edge in index order keeps
// label_at ?? 0.5 when that box is clear, else takes the first clear spot
// among its segments (longest first) at 0.5, 0.3, 0.7, 0.15, 0.85 of each
// segment, measured with lib/layout/metrics.mjs edgeLabelBox — the box the
// layout gate measures — against every glyph, every node label at any of its
// four sides (the layout may move a node label), the labels already placed
// and the frame. An edge with no clear spot keeps its default for the gate to
// report. Pure; edges in index order.
//
//   placeLabels({nodes, centres, edges, polyOf, width, height}) -> {edgeId: label_at}
import { circleBoxOverlap } from '../lib/layout/geometry.mjs';
import { EDGE_LABEL_SIZE, GLYPH_GAP_PX, LABEL_LINE_HEIGHT, edgeLabelBox, glyphRadius, labelStyle, labelWidth, sideBox } from '../lib/layout/metrics.mjs';

export const LABEL_SPOTS = Object.freeze([0.5, 0.3, 0.7, 0.15, 0.85]);
const SIDES = Object.freeze(['below', 'above', 'right', 'left']);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const round4 = (v) => Math.round(v * 10000) / 10000;

function segLen(p, q) { const dx = q[0] - p[0]; const dy = q[1] - p[1]; return Math.sqrt(dx * dx + dy * dy); }

export function placeLabels({ nodes, centres, edges, polyOf, width, height }) {
  const style = labelStyle();
  const radii = nodes.map((n) => glyphRadius(n));
  const blocked = [];
  nodes.forEach((n, i) => {
    if (!centres[i] || typeof n.label !== 'string' || !n.label) return;
    const w = labelWidth(n.label, style); const h = style.size * LABEL_LINE_HEIGHT;
    for (const side of SIDES) blocked.push(sideBox(centres[i], radii[i], w, h, side));
  });
  const clear = (box, placed) => box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height
    && centres.every((c, i) => !c || !circleBoxOverlap(c[0], c[1], radii[i] + GLYPH_GAP_PX / 2, box))
    && !blocked.some((b) => overlap(box, b)) && !placed.some((b) => overlap(box, b));
  const out = {}; const placed = [];
  for (const e of edges) {
    if (typeof e.label !== 'string' || !e.label) continue;
    const poly = polyOf(e);
    if (!poly) continue;
    const base = edgeLabelBox(e, poly, style);
    if (clear(base, placed) || typeof e.label_at === 'number') { placed.push(base); continue; }
    const lens = []; let total = 0;
    for (let k = 1; k < poly.length; k += 1) { lens.push(segLen(poly[k - 1], poly[k])); total += lens[k - 1]; }
    const starts = []; let acc = 0; for (const l of lens) { starts.push(acc); acc += l; }
    const order = lens.map((l, k) => k).filter((k) => lens[k] >= labelWidth(e.label, { ...style, size: EDGE_LABEL_SIZE }) / 2).sort((a, b) => (lens[b] - lens[a]) || (a - b));
    let chosen = null;
    for (const k of order) {
      for (const f of LABEL_SPOTS) {
        const at = round4((starts[k] + f * lens[k]) / total);
        const box = edgeLabelBox({ ...e, label_at: at }, poly, style);
        if (clear(box, placed)) { chosen = { at, box }; break; }
      }
      if (chosen) break;
    }
    if (chosen) { out[e.id] = chosen.at; placed.push(chosen.box); } else placed.push(base);
  }
  return out;
}
