// Lanes layout (board): one vertical lane per group in groups[] order (an
// empty group keeps its lane so lane index equals group index), plus a
// trailing lane for ungrouped nodes when there are any; nodes stack from
// the top in node order. Authored pos overrides a slot.
//
//   lanesLayout(input) -> [[x, y], ...]   (input shape: index.mjs prepare())
//   lanesOf(input)     -> [[node index, ...], ...] per lane

export const LANES = Object.freeze({ row_mult: 2 });

/** Member indices per lane: groups in order, then the ungrouped lane when non-empty. */
export function lanesOf(input) {
  const { nodes, memberOf, groupCount } = input;
  const lanes = [];
  for (let gi = 0; gi < groupCount; gi += 1) lanes.push([]);
  const rest = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (memberOf[i] < 0) rest.push(i);
    else lanes[memberOf[i]].push(i);
  }
  if (rest.length) lanes.push(rest);
  if (lanes.length === 0) lanes.push([]);
  return lanes;
}

/** The lanes layout over a prepared input; returns one [x, y] per node, unrounded. */
export function lanesLayout(input) {
  const { nodes, frame, pinned } = input;
  const n = nodes.length;
  if (n === 0) return [];
  const lanes = lanesOf(input);
  const innerW = frame.w - 2 * frame.padding;
  const innerH = frame.h - 2 * frame.padding;
  const laneW = innerW / lanes.length;
  let maxCount = 1;
  for (const lane of lanes) if (lane.length > maxCount) maxCount = lane.length;
  const byHeight = innerH / maxCount;
  const rowH = frame.spacing * LANES.row_mult < byHeight ? frame.spacing * LANES.row_mult : byHeight;
  const pos = new Array(n);
  for (let j = 0; j < lanes.length; j += 1) {
    for (let k = 0; k < lanes[j].length; k += 1) {
      const i = lanes[j][k];
      const q = pinned.get(i);
      pos[i] = q ? [q[0], q[1]] : [frame.x0 + frame.padding + (j + 0.5) * laneW, frame.y0 + frame.padding + (k + 0.5) * rowH];
    }
  }
  return pos;
}
