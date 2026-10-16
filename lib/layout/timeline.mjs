// Timeline layout: nodes in date order left to right at an ordinal pitch
// (equal spacing, not proportional time, so a year gap does not crush a
// busy week). With groups, every group owns a row in groups[] order and the
// ungrouped pool the last one — a swimlane timeline whose regions are
// horizontal bands that can hold no foreign node. Without groups, nodes sit
// on one row while the pitch leaves room for labels and on up to 8
// alternating rows when it does not. The date is provenance.happened_on,
// else captured_on; ties keep node order. Authored pos overrides a slot.
//
//   timelineLayout(input) -> [[x, y], ...]   (input shape: index.mjs prepare())
//   timelineRows(input)   -> {rows, rowOf(i, k)} the row scheme in use
//   dateOf(node)          -> the ISO date string the layout sorts by ('' when absent)

export const TIMELINE = Object.freeze({ min_pitch_mult: 3, row_gap_mult: 2.5, max_rows: 8 });

/** happened_on, else captured_on, else '' (sorts first). */
export function dateOf(node) {
  const p = node && node.provenance && typeof node.provenance === 'object' ? node.provenance : {};
  if (typeof p.happened_on === 'string') return p.happened_on;
  if (typeof p.captured_on === 'string') return p.captured_on;
  return '';
}

/** Node indices by (date, index). */
export function timelineOrder(nodes) {
  const idx = [];
  for (let i = 0; i < nodes.length; i += 1) idx.push(i);
  const dates = nodes.map(dateOf);
  return idx.sort((a, b) => {
    if (dates[a] < dates[b]) return -1;
    if (dates[a] > dates[b]) return 1;
    return a - b;
  });
}

/** How many alternating rows a pitch needs to clear labels: 1 while pitch >= 3 * spacing. */
export function rowsFor(pitch, spacing) {
  const minPitch = spacing * TIMELINE.min_pitch_mult;
  const rows = pitch > 0 ? Math.ceil(minPitch / pitch) : TIMELINE.max_rows;
  if (rows < 1) return 1;
  return rows > TIMELINE.max_rows ? TIMELINE.max_rows : rows;
}

/** The row scheme: one row per group (+ the ungrouped pool) when groups exist, else alternating rows for clearance. */
export function timelineRows(input, pitch) {
  const { memberOf, groupCount, hasUngrouped, frame } = input;
  if (groupCount > 0) {
    const rows = groupCount + (hasUngrouped ? 1 : 0);
    return { rows, rowOf: (i) => (memberOf[i] < 0 ? groupCount : memberOf[i]) };
  }
  const rows = rowsFor(pitch, frame.spacing);
  return { rows, rowOf: (i, k) => k % rows };
}

/** The timeline layout over a prepared input; returns one [x, y] per node, unrounded. */
export function timelineLayout(input) {
  const { nodes, frame, pinned } = input;
  const n = nodes.length;
  if (n === 0) return [];
  const order = timelineOrder(nodes);
  const innerW = frame.w - 2 * frame.padding;
  const innerH = frame.h - 2 * frame.padding;
  const pitch = innerW / n;
  const { rows, rowOf } = timelineRows(input, pitch);
  const gapByHeight = innerH / rows;
  const rowGap = frame.spacing * TIMELINE.row_gap_mult < gapByHeight ? frame.spacing * TIMELINE.row_gap_mult : gapByHeight;
  const pos = new Array(n);
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k];
    const row = rowOf(i, k);
    const q = pinned.get(i);
    pos[i] = q ? [q[0], q[1]] : [frame.x0 + frame.padding + (k + 0.5) * pitch, frame.cy + (row - (rows - 1) / 2) * rowGap];
  }
  return pos;
}
