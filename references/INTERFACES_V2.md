# Interfaces new or changed in v2 (so parallel builders agree)

// Mode contract (lib/layout/index.mjs run2d normalises both forms)
//   legacy:  mode(input) -> [[x, y], ...]
//   v2:      mode(input) -> { points: [[x, y], ...],
//                             routes?: { [edgeId]: [[x, y], ...] },      // DENSE in layered|sequence|lifecycle (every id'd edge, chord included); sparse elsewhere
//                             sides?: { [nodeId]: 'below'|'above'|'right'|'left'|'center' },
//                             plan?: { mode, reversed?: string[], skipped?: string[], layers?: number, dummies?: number, crossings_before?: number, crossings_after?: number, beats?: number },
//                             viewBox?: [x0, y0, w, h] }                 // layoutScene writes union(authored ?? default, returned); grow, never shrink

// lib/layout/index.mjs (layout-core)
export const MODES_2D = ['force','cluster-disc','grid','timeline','lanes','metric','layered','sequence','lifecycle'];
export function prepare(scene, ctx) -> input                     // + input.style (labelStyle({tokensCss: ctx.tokensCss, theme: ctx.theme ?? meta.theme})), input.labelBudget, input.sides
export function layoutScene(scene, ctx = {}) -> scene            // + positions, routes, labels, views.2d.plan {mode, reversed, skipped, layers, dummies, crossings, beats, viewbox_grown_from}, views.2d.viewBox, laid_out: true; a laid_out scene returns as committed, complete or not (missing rows are the gate's DF_LAYOUT_POSITION_MISSING / ROUTE_MISSING); ctx.force re-runs cold; ctx.incremental warm-starts (lib/bench only)
export function layoutDetailed(scene, ctx = {}) -> { scene, plan, metrics }   // metrics from lib/bench/metrics.mjs layoutMetrics(); never written into checks or receipts in v2.0
export function layoutTables(scene, ctx = {}) -> { positions, routes, labels, plan }
export function positionsComplete(scene) -> boolean
export function routesComplete(scene, mode = mode2dOf(scene)) -> boolean   // routed mode: every id'd edge keyed and every key names an edge; else: every key names an edge
export function verifyDeterminism(scene, ctx = {}, runner = layoutTables) -> { deterministic, diffs: ['routes.m3', 'positions.n7', ...], mode, seed }
// lib/layout/geometry.mjs
export function edgePolyline(scene, edge, from, to) -> [[x, y], ...]   // scene.routes?.[edge.id] ?? routePoints(edge, from, to)
export function pointAt(poly, t) -> [x, y]                              // moved from svg.mjs; sqrt only
export function trim(poly, start, end) -> [[x, y], ...]                 // moved from svg.mjs; sqrt only
export function segmentsOverlap(a0, a1, b0, b1, { minLen = 1 } = {}) -> boolean   // collinear overlap > minLen px
// lib/layout/metrics.mjs
export function labelStyle({ tokensCss, theme = 'default' } = {}) -> { stack, size, source, theme }   // resolves --df-font-metrics-text / --df-label-size through parseThemes + resolveToken for the theme
export function fontStackFor(parsed, role /* display|text|mono */, theme) -> stackId
export function labelSide(scene, node, shapes = shapesTable()) -> side
export function labelBox(node, p, radius, style, shapes, side = labelSide(scene?, node, shapes)) -> { x, y, w, h }
export function glyphExtent(node, shapes = shapesTable()) -> [halfW, halfH]   // pill: [1.3 r, 0.6 r]; else [r, r]
export function edgeLabelBox(edge, poly, style) -> { x, y, w, h }           // size 11, centred at pointAt(poly, label_at ?? 0.5), top q[1] - 4 - 11, h = 11 * LABEL_LINE_HEIGHT; the gate and svg-edges.mjs both call it
export function sublabelBox(node, p, r, style, shapes, side) -> { x, y, w, h, baseline } | null   // 11 px at the label box's x, 3 px above it (label above) or 0.9 em below it
export function pinBoxes(node, p, r, style, labelOf) -> [{ id, label, dx, dy, x, y, w, h }]        // 9 px evidence pins from 0.7 r right of the centre, 6 px apart
export function badgeCircle(edge, raw, order, style, blocked?) -> { cx, cy, r, w }                 // badgeT / badgePoint: the first route spot clear of the label box and of blocked(q, r)
// lib/layout/drawn.mjs — the one source svg.mjs, svg-edges.mjs, the layout gate and lib/bench/metrics.mjs read
export function drawnItems(scene, input, X, Y, g) -> [{ kind: glyph|label|sublabel|pin|edge|badge, i, x, y, w, h, ... }]   // badges placed in edge order clear of everything drawn
export function regionShapes(input, X, Y, g, has?) -> [{ kind: room|band|hull, box?, region? } | null]
export function regionLabels(input, X, Y, g, items, has?) -> [{ x, baseline, w, box, clear, shape } | null]   // the first clear candidate place per group
export function labelBudgetOf(scene, nodeCount) -> number                   // views.2d.label_budget ?? (nodeCount <= 300 ? nodeCount : 300)
export function defaultViewBox(n, spacing, meanLabelW = 0) -> [0, 0, w, h]
// lib/layout/labels.mjs
export function chooseSides(input, X, Y, { routes = null, measured = null } = {}) -> { sides: Map<index, side>, collisions: number }
// lib/layout/noverlap.mjs
export function declutter(X, Y, boxes, fixed, frame, { gap = LABEL_GAP_PX, passes = 48 } = {}) -> { moved: number, passes: number, overflow: { x, y, w, h } | null }
// lib/layout/route.mjs
export function routeAround(input, X, Y, { maxVia = 3 } = {}) -> { [edgeId]: [[x, y], ...] }
export function fanParallel(input, X, Y) -> { [edgeId]: [[x, y], ...] }   // one via per edge of a parallel bundle, index-ordered
export function routePlanGrid(input, X, Y) -> { [edgeId]: [[x, y], ...] }
// lib/layout/lift.mjs
export function liftPolyline(input, poly, za, zb) -> [[X, Y, Z], ...]        // via-vertex z = za + (zb - za) * arcLengthFraction
// lib/layout/regions.mjs (regionOf/insideRegion re-exported from lib/gates/layout.mjs)
export function regionOf(points, radii) -> { hull, pad }
export function bandRegionOf(band /* [lo, hi] */, axis /* 'x'|'y' */, pad) -> region
export function insideRegion(p, region) -> boolean

// layout-types (pure; use only today's metrics exports + input.style ?? labelStyle())
// lib/layout/layered.mjs
export function layeredLayout(input, { direction = 'down' } = {}) -> v2 mode result   // dense routes for every id'd edge; id-less edges in plan.skipped
export function layeredPlan(input) -> { reversed: string[], skipped: string[], layers: number[][], dummies: number }
export function portsOf(input, positions, plan) -> { [edgeIndex]: { exit: [x, y], entry: [x, y], exitSide, entrySide } }   // pitch min(8, 2r/(m+1)), centred on the glyph
// lib/layout/layered-order.mjs
export function assignBands(input, layers) -> { bandOf: Int32Array /* block per node */, bands: [[lo, hi], ...], gap: number }   // gap >= REGION_PAD_PX + rMax + GLYPH_GAP_PX
export function orderLayers(input, layers, bands, { sweeps = 4 } = {}) -> { order: number[][], crossings_before: number, crossings_after: number }
export function countCrossings(layerA, layerB, edges) -> number           // exact, O(E log V)
export function assignCoordinates(input, order, boxes, { direction, spacing, edgeLabelExtents }) -> { X, Y, gaps: number[] }   // axis-aware: boxW for down|up, boxH for right|left
// lib/layout/channels.mjs
export function routeChannels(input, X, Y, order, ports, gaps, { direction }) -> { routes: { [edgeId]: polyline }, tracksPerGap: number[], labelAnchors: { [edgeId]: 'run'|'stub' } }
// lib/layout/sequence.mjs
export function sequenceLayout(input) -> v2 mode result                  // plan.beats; viewBox height when none authored
export function sequenceRows(input) -> { beats: number[], rowOf(order) -> index, rowH, head, lastY }
// lib/layout/lifecycle.mjs
export function lifecycleLayout(input) -> v2 mode result
export function defaultLifecycleSteps(scene) -> [{ id, label, nodes, edges }]

// lib/gates/layout.mjs (layout-core)
export const MAX_FAILS_PER_CODE = 200;   // sentinel message: `further <n> <CODE> findings not listed (200 shown of <total>)`
export function check(scene, ctx = {}, deps = {}) -> check[]   // ctx.theme read; pass rows carry no detail
// lib/gates/topology.mjs / topology-views.mjs (ir-v2)
export const SCENE_KINDS = [...existing, 'sequence', 'lifecycle']; export const EDGE_KINDS = [...existing, 'message', 'transition'];
export function checkViews(scene, F, index) -> void   // DF_IR_DANGLING_VIEW_REF, DF_IR_GROUP_UNDECLARED, DF_IR_TIME_WINDOW_INVALID, DF_IR_TIME_RANGE_EMPTY
// lib/gates/render.mjs (quick-path)
export function decodeDataUrls(html) -> string                            // every data:text/javascript;base64 payload decoded in place
export function motionLoops(html, svg) -> [{ match, where }]              // DF_RENDER_MOTION_INFINITE: style blocks (minus tokens), style= attrs, SMIL repeatCount=indefinite, decoded payloads
export function motionWithoutStill(scene, svg) -> boolean                 // DF_RENDER_MOTION_WITHOUT_STILL

// lib/time (playhead-core)
export function dayIndex(isoDate) -> integer; export function fromDayIndex(n) -> isoDate
export function addStep(isoDate, step, k = 1) -> isoDate                    // month|year by calendar fields, day clamped to the target month
export function floorToStep(isoDate, step) -> isoDate
export function timeOf(scene) -> { axis, field, from, to, step, playhead, cumulative, motion, trace } | null
export function bornAt(node, time, adjacency) -> isoDate | integer | null
export function edgeAt(edge, nodesById, time) -> isoDate | integer | null
export function ticks(scene) -> (isoDate | integer)[]
export function visibleAt(scene, t) -> { present: Set<id>, fresh: Set<id>, edgePhase: Map<edgeId, number>, active: id | null }
export function phaseOf(edge, t, stepLen) -> number                       // clamp((t - at + stepLen) / stepLen, 0, 1)
export function stepIndexOf(scene, t) -> integer
// renderers/viewer/time.js mirrors: DF.timeOf, DF.bornAt, DF.edgeAt, DF.ticks, DF.visibleAt, DF.phaseOf, DF.stepIndexOf (present and tested in v2.0; mounted by the viewer-4d ticket)

// renderers (svg-4d)
export function renderSvg(scene, tokens, opts) -> string                  // opts += { playhead?: t } (default timeOf(scene).playhead); labelStyle({tokensCss, theme})
export function renderEdges(input, P, style, { scene, time, visible, g, items }) -> string   // svg-edges.mjs; edge labels via edgeLabelBox(); badges on the discs drawnItems() placed (clamp(label_at - 0.1), stepped clear)
export function renderChrome(input, style, { scene, time, legendRows, theme }) -> string   // svg-chrome.mjs; lifelines from committed routes (max y + 40)
export function legendRows(input, { scene, visible, budget }) -> [{ kind, label, ... }]    // capped at 8 + '+n more'

// lib/pipeline.mjs (quick-path)
export async function loadScene(target, ctx, { viewer }) -> { ok, scene, inputs, checks, source: 'file'|'room'|'sketch', importer: 'sketch'|null, ... }
export function gateContext(ctx, over) -> { ..., theme, shapes: kindsFor(ctx) }
export function renderScene(scene, ctx, opts) -> { ... }                 // passes theme to renderSvg and the render gate
// lib/rooms.mjs (quick-path)
export function kindsFor(ctx, { sketchKinds = null } = {}) -> { [kind]: { glyph2d, primitive3d, size_mult, label_anchor, legend?, layout_hint? } }
// importers (quick-path)
export const id = 'sketch'; export function detect(input) -> boolean      // input.doc.schema_version === 'dotfield.sketch/1' only
export function run(input, opts = { now, owner }) -> { kind: 'scene', importer: 'sketch', scene, checks, ok, source }
export function expandSketch(sketch, { now, name }) -> scene                // pure; every edge id'd (e<index>); views.3d and views.vr always written

// lib/bench (benchmark)
export function corpus({ quick, root, now }) -> { scenes: [{ id, path, sha256, scene }], archify: [{ name, status: 'accepted'|'refused', codes }], synthetic: [{ id, n, shape, scene }] }
export function layoutMetrics(scene, { positions = scene.positions } = {}) -> { stress, neighborhood_preservation, edge_uniformity, crossings, label_collisions, labels_measured, labels_total, route_through_node, overlap_pairs, containment_violations, viewbox_area_ratio }
export function oneEditStability(scene, ctx) -> { mean, max }                // the only caller of ctx.incremental
export function probes({ root, html, htmlEmbedded, scene }) -> { standalone: { external_refs_default, external_refs_embed, importmap_mode, sri_complete }, parity, determinism, fourd: { time_block, playhead_in_hash, playhead_core_present, compare_verb, steps_in_schema, no_infinite_motion }, agent: { ..., cc_hook_reminder_present }, maintainability }
export function parseCapSentinel(message) -> { shown: number, total: number } | null
export function renderMarkdownBlock(result) -> string                     // digests, counts, booleans, input-derived ratios only
export function toJson(result, { timings, bytes, node, digests }) -> object

// lib/rules.mjs — unchanged in v2.0
export const PINNED = Object.freeze({ cli_verbs: 18, cli_leaf_subverbs: 26, mcp_tools: 12, rule_families: 23, three_revision: '180', min_node: '22.13' });

// Tickets (not built in v2.0; signatures recorded so the foundation needs no change when they open)
//   compare:        dotfield compare <before> <after> [out.html] [--view …] [--json]; diffScenes(before, after, {spacing}); after viewBox grown over delta.nodes[].from; id-less edges paired by (from, to, kind)
//   interchange:    render <scene> out.<ext> --format d2|mermaid|dot|jsoncanvas|svg|html   (--as is the global viewer flag)
//   receipts-chain: .dotfield/receipts/index.jsonl {id, body_digest, prev}; verify --chain; prev_digest never inside the receipt body
//   three-4d:       renderers/{three-labels,three-edges,three-mount,motion}.mjs; three.mjs <= 300 by wc -l; liftPolyline mirror
//   vendor-min:     readVendorManifest() returns file per specifier; vendorStatus() and html-3d's resolver read it; THREE_SPECIFIERS = [{specifier, cdn}]
//   themes-presets: render --theme <name> passed to renderScene/renderSvg/render gate; labelStyle theme-aware (v2.0) is the precondition
