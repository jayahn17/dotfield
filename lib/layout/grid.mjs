// Grid layout (workflow, archify row/col): nodes fill the padded box row by
// row, zone by zone (groups[] order, members in node order, the ungrouped
// pool last), views.2d.columns wide (default ceil(sqrt(n))). Every zone
// starts on a new row, so a zone region is a band of whole rows plus one
// partial row and never shares a row with another zone — archify's
// rectangles, and a padded hull that can hold no foreign node. Cell centres
// are pad + (i + 0.5) * cell: the column centres of examples/scene-workflow.json
// (300 / 800 / 1300 at 1600 wide, 3 columns). Authored pos overrides a cell.
//
//   gridLayout(input) -> [[x, y], ...]   (input shape: index.mjs prepare())
//   gridCells(input)  -> {cells: [[row, col], ...] per node, rows, cols}
//   gridOrder(input)  -> node indices in fill order

/** Node indices grouped by zone, stable within a zone; the ungrouped pool sorts last. */
export function gridOrder(input) {
  const { nodes, memberOf, groupCount } = input;
  const idx = [];
  for (let i = 0; i < nodes.length; i += 1) idx.push(i);
  const key = (i) => (memberOf[i] < 0 ? groupCount : memberOf[i]);
  return idx.sort((a, b) => (key(a) - key(b)) || (a - b));
}

/** The column count: views.2d.columns, else ceil(sqrt(n)), at least 1. */
export function columnsFor(n, columns) {
  if (Number.isInteger(columns) && columns >= 1) return columns;
  const c = Math.ceil(Math.sqrt(n > 0 ? n : 1));
  return c >= 1 ? c : 1;
}

/** Row and column of every node: zones in order, each starting a new row. */
export function gridCells(input) {
  const { nodes, memberOf, groupCount, columns } = input;
  const n = nodes.length;
  const cols = columnsFor(n, columns);
  const cells = new Array(n);
  let row = 0; let col = 0; let prev = null;
  for (const i of gridOrder(input)) {
    const zone = memberOf[i] < 0 ? groupCount : memberOf[i];
    if (prev !== null && zone !== prev && col !== 0) { row += 1; col = 0; }
    cells[i] = [row, col];
    col += 1;
    if (col === cols) { col = 0; row += 1; }
    prev = zone;
  }
  return { cells, rows: col === 0 ? Math.max(row, 1) : row + 1, cols };
}

/** The grid layout over a prepared input; returns one [x, y] per node, unrounded. */
export function gridLayout(input) {
  const { nodes, frame, pinned } = input;
  const n = nodes.length;
  if (n === 0) return [];
  const { cells, rows, cols } = gridCells(input);
  const cellW = (frame.w - 2 * frame.padding) / cols;
  const cellH = (frame.h - 2 * frame.padding) / rows;
  const pos = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const q = pinned.get(i);
    const [row, col] = cells[i];
    pos[i] = q ? [q[0], q[1]] : [frame.x0 + frame.padding + (col + 0.5) * cellW, frame.y0 + frame.padding + (row + 0.5) * cellH];
  }
  return pos;
}
