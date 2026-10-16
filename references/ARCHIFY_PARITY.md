# Archify parity: what an archify file becomes, and what is measured

Dotfield imports archify diagrams through `importers/archify.mjs`. This page
says, field by field, what each archify diagram type becomes in a
`dotfield.scene/1` scene, what is kept for a round trip, what is dropped and
why, and how many of archify's own examples come through clean. It is the
written half of the `archify-corpus` ticket (V2_PLAN §11). The other half is
`test/archify-corpus.test.js`.

**Claim scope.** An imported scene reproduces archify's topology, order,
grouping and routing intent. It does not reproduce archify's rendering. The
geometry is Dotfield's own (`lib/layout`), and every gate measures it the same
way it measures an authored scene. Visual quality is not claimed: a render
stays `provisional` until a screenshot is attached.

## 1. The corpus and the number

| | |
|---|---|
| Source | [`tt-a1i/archify`](https://github.com/tt-a1i/archify) at commit `73aaa0696e8f72c232ea710e6fa94fd953f3e773` |
| Licence | MIT (SPDX `MIT`). Redistribution is allowed with the notice, so archify's `LICENSE` is vendored verbatim beside the files. |
| Files | all 15 `*.json` diagrams under `archify/examples/` at that commit: 5 architecture, 4 workflow, 2 dataflow, 2 sequence, 2 lifecycle. The 5 `*.html` renders (archify output) and `locales/*.json` (viewer string tables) are not diagrams and are not vendored. |
| Where | `test/fixtures/archify/`, each file pinned by sha256 in `manifest.json` |
| Fetch / verify | `node scripts/fetch-archify-corpus.mjs` downloads from `raw.githubusercontent.com` at the pinned commit and refuses any byte whose sha256 differs. `--verify` re-hashes the folder offline. `--from <dir>` copies a local copy under the same digests. `--repin <commit>` moves the pin and rewrites the digests for review. |
| Diagram types at the pin | 5: architecture, workflow, dataflow, sequence, lifecycle (`archify/schemas/README.md` and one `diagram_type` const per schema) |
| **Types supported** | **5 of 5** (`archify.SUPPORTED`; `REFUSED` is empty) |
| **Showcase-clean** | **15 of 15.** Each file imports, then `validate --quality showcase` and `render --quality showcase` exit 0 with no blocking failure, with both `--view 2d` and `--view all --no-embed-three`. |

Measured by `test/archify-corpus.test.js` through the real verbs in process,
and again by `lib/bench/corpus.mjs` (`archify.corpus_showcase_clean`) for the
benchmark. The test requires the two numbers to agree.

Two non-blocking codes are allowed, and only these two. Each marks a fact, not a defect:

- `DF_IMPORT_ORDER_FILLED`, in 8 files: archify left an edge's order implicit, and the importer derived it.
- `DF_LAYOUT_LAYER_CYCLE_BROKEN`, in `agent-run.lifecycle`: a retry transition is drawn against the layers.

Before this ticket the same files gave 8 of 15. The 7 failures were all layout
codes, with no gate relaxed to clear them:

- `DF_LAYOUT_ROUTE_THROUGH_NODE` and `DF_LAYOUT_ROUTE_OVERLAP` on the grid types.
- `DF_LAYOUT_ROUTE_OVERLAP` on `deployment-release.lifecycle`.

§4 lists the four engine changes that closed them.

## 2. Shared by all five types

| archify | Dotfield | Notes |
|---|---|---|
| `diagram_type` | `kind` (`workflow` for the grid types, else `sequence` / `lifecycle`) and `ext.archify.diagram_type` | An unknown string is refused with `DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE`. |
| `schema_version` | `ext.archify.archify_version` | It also marks a file as archify's own format, whose geometry is in archify's canvas frame (§3). |
| `meta.title` | `meta.title`, `meta.id` (slugged) | |
| `meta.quality_profile`, `meta.visual_preset` (and `theme`, `icon`, `description`, `grid`) | `ext.archify.*` | Presentation only. The scene theme stays Dotfield's default. |
| other `meta` keys (`animation`, `output`, `viewBox`, `legend`, `locale`, `engineering_profile`, `column_fit`) | `ext.archify.meta` | `animation: "trace"` also sets `views.time {axis: order, step: beat, motion: trace}`. |
| ids | node and edge ids, slugged | An edge without an id is minted `e<index>`. A clash gets `-<n>`. |
| `label`, `sublabel` | `label`, `sublabel` (clipped to the IR limits) | |
| `sources` | `evidence` rows of kind `file`, labelled `SRC n` | Absolute paths never enter. |
| `cards` | `ext.archify.cards` | Archify page chrome with no scene field. Kept for a round trip. |
| any attribute without a scene field (`tag`, `icon`, `width`, `brand`, `yOffset`, `variant`, `role`, `classification`, `labelDy`, `labelSegment`, …) | `ext.archify.{nodes,connections,participants,messages,states,transitions}[id]` | Kept, not drawn. |
| provenance | `provenance.source {kind: import, ref: import:archify/<file>, digest}`, `captured_on` from the import clock | Every node is `audience: private`. |

## 3. Per type

### architecture, workflow, dataflow: `kind: workflow` on the grid

| archify | Dotfield |
|---|---|
| `components` / `nodes` | `asset` nodes (`file` for datastore-like types), each pinned at its grid cell centre through `nodes[].pos` |
| placement | workflow: `lane` + `col`. dataflow: `stage` (one column per stage) + `row`. architecture: the pixel `pos` (+ `size`) ranked into rows and columns. A taken cell moves right (`ext.archify.nodes[id].cell_taken`). |
| `lanes` | `lane` groups |
| `boundaries` / `containers`, `groups`, `phases` (`fromCol`..`toCol`), `stages` | `zone` groups. Membership comes from `wraps`, from the column range or from the stage. |
| `connections` / `edges` / `flows` | `flow` edges with `route: orthogonal` (or `straight` when archify says so), and `order` when given |
| `fromSide`, `toSide` | `from_side`, `to_side` |
| `route` hints (`drop`, `bottom-channel`, `top-channel`, `outside-right`, `return-left`, `vertical-channel`, `orthogonal-h`/`-v`, `up-channel`) | Kept under `ext.archify.connections[id].route`. They also shape the route (below). |
| `via`, `labelAt`, `channelX`, `channelY` | Kept under `ext.archify.connections[id]`. Not used as coordinates. |
| `mainPath` | `views.interactive.presentation` + `steps[]`. Each step is the node and the edge that reached it. |
| a missing `order` | Breadth-first depth from `mainPath[0]` (else from the nodes no edge enters). Listed by `DF_IMPORT_ORDER_FILLED` when the scene animates. |

**Routing.** archify's `via`, `channelX`, `channelY` and `labelAt` are pixels
of archify's own canvas. archify's schema README lists them as canvas
coordinates. The import frame is a lattice of cells of at least 500 × 400 px
(`CELL`), so copying them drew routes through unrelated nodes
(`production-deployment`, `product-analytics`). The other grid failures were
plain orthogonal Z routes that no repair pass touched:
`lib/layout/route.mjs routePlanGrid` skips edges whose ends are pinned, and
every imported grid node is pinned.

What does carry over is the intent. archify's authoring contract defines a side
as a direction contract: the first and last segment leave and enter
perpendicular to it.

`importers/archify-route.mjs` routes each grid edge over the lattice, meaning
the cell centre lines and the corridors between cells:

- **Search.** A shortest path over length, a bend penalty and a congestion term. It never enters a cell whose node it does not connect.
- **Sides.** `from_side` / `to_side` are hard constraints.
- **Hints.** archify's hints first set the sides they imply, then act as soft channel preferences. `outside-right` prefers the corridor right of both nodes. `bottom-channel` prefers the corridor below both rows.
- **Track offsets.** Every straight run gets an offset (8 px for corridor tracks, 6 px for ports). So no two runs share a line, and two edges leaving one side of a node leave through distinct ports.
- **Output.** The result is written as `edges[].via` in the import frame. A clear neighbour keeps its plain chord with no `via`. An archify `route: straight` between cells in different rows and columns stays a diagonal chord when it clears every node, as archify allows.

A file without archify's `schema_version` is the v1 importer's own format, whose
`via` was written in the import frame. Its `via` stays on the edge.

**Labels.** archify keeps a label at its default spot when clear and otherwise
tries nearby positions along the route. `importers/archify-labels.mjs` does the
same with `label_at`. Each labelled edge keeps `label_at ?? 0.5` when that box
is clear. Otherwise it takes the first clear spot among its segments, longest
first, at 0.5, 0.3, 0.7, 0.15 or 0.85 along each one.

The boxes are measured with `edgeLabelBox` from `lib/layout/metrics.mjs`, the
box the layout gate measures. They are tested against glyphs, every node label
at any of its four sides, the labels already placed, and the frame. In the
corpus two labels move: `production-deployment` and `event-stream`.

### sequence: `kind: sequence`

| archify | Dotfield |
|---|---|
| `participants` | Nodes in archify order. Kind by type: actors become `person`, services become `desk`, stores become `record`, transports and guards become `asset` (`PARTICIPANT_KINDS`). |
| `messages` | `message` edges, `route: straight`. `order` is the dense rank of archify's `y`, so an equal `y` is one beat. Variants `return`/`dashed`/`async`/`reply` draw dashed. A self message stays. |
| `activations` | `ext.archify.activations`, each with the beats its `y` range spans |
| `segments` | `views.interactive.steps`. Each step holds the messages the range covers and the participants they touch, with the playhead at its last beat. |
| layout | `views.2d {layout: sequence}` with no viewBox (the layout sizes it). `views.3d` lifts flat. |

### lifecycle: `kind: lifecycle`

| archify | Dotfield |
|---|---|
| `states` | `event` nodes with `shape: pill`, coloured by type |
| `initial` / `final` tags | `initial`: a start type, else the lowest `step`, else the first state nothing enters. `final`: a terminal type or tag, or a state nothing leaves. |
| `lanes` | `lane` groups |
| `step` | The main rail. Consecutive steps with no transition between them get an implied transition (`ext.archify.rail`). |
| `transitions` | `transition` edges with `from_side` / `to_side`. A missing order is the breadth-first depth from the initial state (`DF_IMPORT_ORDER_FILLED`). |
| `via`, `route`, `col`, `yOffset` | `ext.archify.transitions[id]` / `ext.archify.states[id]`. The lifecycle layout routes every transition. |
| layout | `views.2d {layout: lifecycle, direction: right}`, `views.time {motion: playback}`, and `steps[]` as the default playback walk |

## 4. What changed to reach 15 of 15 (no gate relaxed)

1. **Canvas `via` is data, not geometry.** On a file carrying archify's
   `schema_version`, the importer no longer copies archify's canvas `via` onto
   `edges[].via`. It keeps it under `ext.archify.connections`. The legacy
   v1-format fixture keeps its import-frame `via`.
2. **Lattice routing** (`importers/archify-route.mjs`), as described in §3.
   This cleared every `ROUTE_THROUGH_NODE` and grid `ROUTE_OVERLAP`. A test
   shows that removing the router's `via` from `agent-tool-call` blocks it again
   at showcase.
3. **Label fallback** (`importers/archify-labels.mjs`). This cleared the two
   `DF_LAYOUT_EDGE_LABEL_CLEARANCE` rows the new routes exposed.
4. **Channel track order** (`lib/layout/channels.mjs trackOrder`). This fixes
   the `deployment-release` overlap. In one gap between layers, a piece whose
   first leg leaves at the in-layer coordinate where another piece's last leg
   arrives now turns nearer the source layer, so the two legs no longer share a
   line. With no such pair the order is the old mid order, so every committed
   routed example is still its cold run.

## 5. Dropped, and why

- **Repeated transitions on one ordered pair** (lifecycle only). A second
  transition between the same two states merges its label into the first and is
  listed under `ext.archify.dropped_transitions`: the topology gate
  (`lib/gates/topology.mjs`, `DF_IR_DUP_EDGE`) keeps one edge per
  `(from, to, kind)` in a lifecycle, because two transitions on one pair would
  share one channel. No corpus file has one. Repeated **messages** are no
  longer dropped: since 2026-10-08 the gate keys a `sequence` edge by its
  `order` too, so the three corpus messages that used to merge
  (`async-job-roundtrip`: a second `client → api` and a second `api → client`;
  `cache-miss-request`: a second `api → redis`) are kept on their own beats, and
  all 26 corpus messages import. The importer asks the gate (`repeatsAllowed`)
  instead of copying its rule, so it followed without a code change.
- **archify's canvas geometry**: `meta.viewBox`, `via`, `labelAt`, `labelDx`/`labelDy`, `channelX`/`channelY`, `labelSegment`, node `width`, `size` and `yOffset`. They are kept under `ext.archify`, not drawn, because they live in another frame.
- **archify presentation**: `visual_preset`, `variant` and `role` colours, `brand` logos, `icon`, `cards`. They are kept under `ext.archify`. Dotfield's tokens and glyphs draw instead.
- **Compact canvas.** The grid types keep archify's cells, not its pixels. An
  architecture ranked into many columns lays out wide: `production-deployment`
  becomes a 3600 × 2100 canvas.
- **Theme dependence of the label spots.** The spots are measured with the
  default theme's metrics. A render under a theme with wider text could collide
  again; the layout gate would then report it.

## 6. Re-measuring

```sh
node scripts/fetch-archify-corpus.mjs --verify      # offline: 16 of 16 files verify
node --test test/archify-corpus.test.js             # per-file table, 15/15 asserted
node scripts/benchmark.mjs --quick --json out.json  # corpus.archify.corpus_showcase_clean
```

To follow archify forward, run `node scripts/fetch-archify-corpus.mjs --repin
<commit>` (network, once). Review the diff in `test/fixtures/archify/`, add any
new example to `manifest.json`, and rerun the test. A file that does not come
through clean is fixed in `importers/archify*.mjs` or `lib/layout`. The gates
stay as they are.
