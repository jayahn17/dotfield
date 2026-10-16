# The Scene IR — `schemas/scene.schema.json` (`dotfield.scene/1`)

One typed JSON document that 2D, 3D, VR and the interactive page all render.
This file is the field reference; `VISION.md §4` is the design and the complete
worked example (`examples/scene-graph.json`); `references/IR_CHANGES_V2.md` is
the binding list of what v2.0 added. The three IR gates live in
`lib/gates/{schema,topology,privacy}.mjs` (the topology gate's views half is
`lib/gates/topology-views.mjs`, same gate id); their codes are listed with
repair sentences in `references/RULES.md` (families `schema`, `ir`, `privacy`,
plus `DF_RENDER_UNPROJECTED`).

## 1. The document

| Field | Required | Shape |
|---|---|---|
| `schema_version` | yes | the constant `dotfield.scene/1` |
| `kind` | yes | `graph` · `room` · `timeline` · `board` · `workflow` · `meet` · `sequence` · `lifecycle` — only changes the default layout |
| `meta` | yes | `{id, title ≤120, description? ≤500, output?, theme, quality, units?, up_axis?, privacy_mode, maturity, legend?, room?, view?}` |
| `viewer` | yes | `{person_id, mode: self\|person\|public, rule_refs[]}` — who the scene was projected for |
| `groups` | no | `group[]` (§3) |
| `nodes` | yes | `node[]` (§2) |
| `edges` | yes | `edge[]` (§4) |
| `positions` | no | **open map** `{<node id>: [x, y]}` — the one positions table, written once by layout |
| `routes` | no | **open map** `{<edge id>: [[x, y], …]}` (2–64 points, viewBox px) — dense in the routed modes (`layered`, `sequence`, `lifecycle`: every id'd edge, the chord included), sparse elsewhere (only the edges `lib/layout/route.mjs` changed); `svg`, the layout gate and `three.mjs` read `scene.routes[id] ?? routePoints()` |
| `labels` | no | **open map** `{<node id>: below\|above\|right\|left\|center}` — written by `lib/layout/labels.mjs` only where the side differs from the `shapes.json` default |
| `laid_out` | no | `true` once `positions` holds every node **and** `routes` is complete for the mode; goldens render from such scenes and never re-simulate (`DF_LAYOUT_ROUTE_MISSING` when a routed mode lacks an entry or a key names no edge) |
| `views` | yes | `{2d (required), 3d?, vr?, interactive?, time?}` (§5) |
| `evidence` | no | `[{id, kind: record\|file\|url\|import\|run\|share\|projection, ref ≤512, digest, label ≤40}]` — the `SRC n` pins |
| `projected` | no | written only by `lib/project.mjs` (§7) |
| `receipt` | no | `{receipt_id, source_digest, tokens_digest, validator_version, checks_passed}` — the render receipt summary |
| `delta` | no | **closed**, written only by `dotfield compare` (`lib/delta.mjs`) on the after scene it renders, never authored: `{before, after, pairs{nodes, edges, edges_by_endpoints}, unpaired_ratio, nodes[], edges[], counts, viewbox_grown_from?, claims: "no risk assessment"}`; the same object is `schemas/delta.schema.json` (`dotfield.delta/1`, `delta.json` beside `out.html`) |
| `ext` | no | **open map**, customer round-tripping only (`structure.test.js` fails any `.ext` read under `renderers/` or `lib/layout/`); the one key the pipeline reads is `ext.kinds` (§6) |

`meta.theme` ∈ `default|light|paper|studio|field|story|editorial|blueprint` (the
`brand.json` presets; `dotfield render --theme <name>` overrides it for one render); `meta.quality` ∈ `draft|checked|showcase` (clearance
and route checks block only at `showcase`); `meta.privacy_mode` ∈
`synthetic_data|private_live`; `meta.maturity` ∈ `contract_only|prototype|local_beta|tested`;
`meta.units` is `m`; `meta.up_axis` ∈ `y|z`.

Every id matches `^[a-z0-9][a-z0-9_.:-]{0,79}$`. Every digest is `sha256:<64 hex>`.
A `rule_ref` is always `<grantor_person_id>/<rule_id>` (pattern-enforced), so two
grantors' `rule-01` never collide. Dates are `YYYY-MM-DD`; `projected.at` is RFC 3339.

**Sequence and lifecycle** (v2.0) are kinds, not renderers: a `sequence` scene is
participants (any node kind) on lanes with ordered `message` edges; a `lifecycle`
scene is states (any node kind, `shape: pill`, tagged `initial` / `final`) with
ordered `transition` edges. Both are drawn by the routed layouts of the same name
and commit dense `routes`; a self message or self transition is a loop the layout
draws (§4). Authored through `templates/*.sketch.json` and, since the
`importers-parity` ticket landed (2026-10-08), imported from archify
`sequence|lifecycle` files (§9).

## 2. Nodes

| Field | Required | Shape |
|---|---|---|
| `id` | yes | id; foreign nodes are namespaced `person-<grantor>-…` by the importer |
| `kind` | yes | `record` `note` `person` `desk` `tag` `file` `asset` `event` `place` `boundary` `annotation` `idea`, or `x-<custom>` (needs a kinds row — the pack's `kinds.json`, `center/kinds.json` or the `renderers/shapes.json` fallback: `DF_IR_KIND_UNKNOWN`) |
| `label` | yes | 1–120 characters |
| `sublabel` | no | ≤200 |
| `room`, `record_id` | no | the record the node projects |
| `group` | no | must exist in `groups[]` (`DF_IR_GROUP_UNDECLARED`) |
| `weight` | yes | 0..1 |
| `tags` | yes | `string[]` (≤32, each ≤40); `initial` / `final` mark lifecycle states (`DF_IR_LIFECYCLE_NO_INITIAL`, non-blocking, when a lifecycle scene has no `initial`) |
| `shape` | no | overrides the `shapes.json` glyph (`pill` for lifecycle states) |
| `color_token` | yes | `series-1..6` · `accent` · `accent-2` · `muted` · `good` · `warn` · `bad` · `foreign` — never a hex |
| `status` | yes | `accepted` · `proposal` (proposal nodes render dashed/wireframe in every mode) |
| `pos` | no | `{x, y}` normalised −1..1 — read in `graph\|timeline\|board\|workflow\|sequence\|lifecycle` |
| `pose_m`, `size_m` | no | `{xyz:[3], rpy:[3]}`, `[3]` metres — read in `room` |
| `fields` | no | **open map**, ≤32 keys; values are string (≤1 KB) · number · boolean · null · flat array; only the record's `public_fields`; never rendered as body text |
| `provenance` | yes | `{owner_person_id, source{kind: record\|file\|url\|import\|run\|share, ref, digest}, captured_on, happened_on?, remembered_on?, released_on?, imported_via_rule_ref?, derived_from?[]{person_id, rule_ref, key_id}}` — the four dates are what `views.time` reads on a date axis |
| `audience` | yes | `{privacy_level: public\|private\|sensitive\|blocked, share_rule_ids[]}` |
| `evidence_ids` | yes | ids into `evidence[]` (`DF_IR_EVIDENCE_UNKNOWN`) |
| `boundary` | only on kind `boundary` | `{rule_ref, digest, shared_by, released_on, expires_on?, key_id}` (`DF_IR_BOUNDARY_BLOCK` both ways) |

No new node field and no new node kind in v2.0 (V2_PLAN §12 decision 1).

**Position precedence** (`DF_LAYOUT_POSE_IGNORED`, non-blocking, layout gate): in
`graph|timeline|board|workflow|sequence|lifecycle` a node may carry `pos` and
`pose_m` is ignored; in `room` a node carries `pose_m` (+ `size_m`) and `pos` is
ignored. Layout runs once, in 2D, and writes the scene-level `positions` (and, in
v2.0, `routes` and `labels` beside it); 3D lifts `z` from `views.3d.lift`, VR
transforms 3D. There is never a second positions table.

**Size rules** (topology gate, all blocking): `DF_IR_TOO_LARGE` above 2000 nodes;
`DF_IR_FIELD_TOO_LARGE` when one `fields` map exceeds 4 KB (canonical JSON bytes)
or one string value exceeds 1 KB (UTF-8 bytes; the schema's `maxLength: 1024`
counts code points, so a 600-character two-byte string passes the schema and
fails the gate); `DF_IR_FIELDS_BUDGET` when all `fields` together exceed 1 MB.

## 3. Groups

`{id, label, kind: region|discipline|circle|zone|lane|person, wraps?[], center_xyz_m?[3], size_xyz_m?[3], color_token?, collapsed?}`.
A group declares **either** `wraps[]` (every id must be a node: `DF_IR_GROUP_MEMBER_UNKNOWN`)
**or** a metric box, never both and never neither; a `room` scene needs the box
and every other kind needs `wraps` (`DF_IR_GROUP_SHAPE`). Group ids are unique
(`DF_IR_GROUP_DUP_ID`). `board` scenes lay nodes out by their `lane` groups;
`layered` architecture scenes draw `zone` groups as axis-aligned bands.

## 4. Edges

`{id?, from, to, kind, directed, label?, weight?, order?, at?, from_side?, to_side?, variant: solid|dashed|flow, route: auto|straight|orthogonal, via?[[x,y]…], label_at?, rule_ref?, evidence_ids?}`,
`kind` ∈ `relates link cites influences depends member contains precedes flow share annotates candidate message transition`.

- Both ends must be nodes (`DF_IR_DANGLING_EDGE`, edges-only since v2.0 — view
  references have their own code, §5 and §10).
- No self edges (`DF_IR_SELF_EDGE`) **except** in `sequence` and `lifecycle`
  scenes, where a self message or self transition is drawn as a loop by the
  layout; the exemption is by scene kind, not edge kind.
- One edge per `(from, to, kind)` — an undirected pair counts both ways — and one
  edge per id (`DF_IR_DUP_EDGE`). In a `sequence` scene the key also carries
  `order`: a repeated message on one pair (a retry, a second request) is a second
  edge on its own beat; two at the same order are still one too many. A
  `lifecycle` keeps the plain rule (two transitions on one pair would share one
  channel).
- `order` (integer ≥ 0) is **required** on every `message` and `transition` edge
  and on every edge of a `sequence` scene (`DF_IR_ORDER_MISSING`); equal orders
  share one beat.
- `id` stays optional in the schema, but `DF_IR_EDGE_ID_REQUIRED` (blocking)
  fires for every edge of a scene whose `views.2d.layout` is `layered`,
  `sequence` or `lifecycle`, and for every `message` or `transition` edge
  anywhere: `routes` are keyed by id and a routed mode refuses an edge it cannot
  name (`views.2d.plan.skipped`). An empty string is no id.
- `at` is the edge's own date on a date axis (else derived from the later
  endpoint); `from_side` / `to_side` ∈ `top|bottom|left|right` are port hints the
  channel router honours.
- A `share` edge carries `rule_ref` (`DF_IR_SHARE_EDGE_NO_RULE`). `candidate`
  edges exist only in `meet` scenes and are never persisted
  (`DF_IR_CANDIDATE_OUTSIDE_MEET`).

## 5. Views

- `2d` (required): `{layout: force|cluster-disc|grid|timeline|lanes|metric|layered|sequence|lifecycle, seed?, viewBox?[4], spacing?, padding?, columns?, direction?: down|right|up|left, label_budget?: 0..2000, plan?}`.
  `direction` applies to `layered` and `lifecycle` only (default `down` for
  workflow, `right` for lifecycle; `grid` ignores it). `label_budget`: labels
  beyond the top-N by weight are hover-only and unmeasured (default: all up to
  300 nodes, then 300). `plan` is a **closed** block written by `lib/layout` for
  every mode and read, never recomputed, by the layout gate and `svg-chrome.mjs`:
  `{mode (required), reversed?[], skipped?[], layers?, dummies?, crossings?, beats?, viewbox_grown_from?[2]}`
  (`DF_LAYOUT_LAYER_CYCLE_BROKEN` from `reversed`, `DF_LAYOUT_VIEWBOX_GROWN` from
  `viewbox_grown_from`). Arrays, so no new open path.
- `3d`: `{layout: lift|tier-wall|metric, scale_m, camera?{position, target}, lift?{mode: group-weight|weight|flat, amplitude_m}}` — stores only the lift; `lib/layout/lift.mjs` derives `z`, bounded ±0.5·`scale_m`.
- `vr`: `{enabled, scale_m?, floor_y?, eye_height_m?, entry_node?, label_budget? (≤512, default 64), snap_turn_deg?: 0|30|45|90}` — the transform from 3D only; `snap_turn_deg` (default 45, 0 disables) is honoured since `three-4d` landed: one turn per thumbstick push, about the head, with a comfort fade.
- `interactive`: `{focus?, reach?: in|out|both|none, lenses?[{id, label, match{owner?, groups?, rooms?, tags?, kinds?, status?}}], default_lens?, presentation?[], steps?[], deep_link?}`. `focus` is the scene's entry node: the F key focuses it when nothing is hovered. The viewer opens unfocused, so the whole scene reads first and no card covers it; a `#focus=<id>` link still opens focused.
  Lens groups must be declared (`DF_IR_GROUP_UNDECLARED`). `presentation[]` is the
  one-node-per-step shorthand; `steps[]` supersedes it when present:
  `[{id, label?, caption? ≤200, nodes[], edges?[], playhead?}]` (≤64, closed).
- `time` (v2.0, closed): `{axis: date|order (required), field?: happened_on|captured_on|remembered_on|released_on, from?, to?, step?: day|week|month|year|event|beat, playhead?, cumulative?, motion?: still|trace|playback, trace?{trail 0.05..1, beads 1..8, duration_ms 400..20000}}`.
  `from`, `to`, `playhead` (and `steps[].playhead`) are one `time_point` schema
  over three types — a date string, an integer ≥ 0 or `null` — so a malformed
  date is `DF_SCHEMA_FORMAT` and a negative integer `DF_SCHEMA_MINIMUM`
  (`test/validate.test.js` pins `from: 12` passes, `'2026-13-40'` fails FORMAT,
  `-1` fails MINIMUM). `field` defaults to `happened_on`; `lib/time` falls back
  to `captured_on` per node. Semantics (V2_PLAN §5, `lib/time/playhead.mjs`):
  node birth on a date axis is `provenance[field] ?? captured_on`, on an order
  axis `0` for a node no ordered edge enters, else the smallest entering
  `order` — with two refinements: a node tagged `initial` is born at `0` even
  when a back edge enters it, and in a `sequence` scene every participant is
  born at `0` (a message enters a lifeline, it does not create it). Edge time
  is `at` when authored, else the later endpoint's date or `edge.order`.
  `from` / `to` default to the earliest and latest dated point of the scene,
  node births **and** edge times (so the last beat of an order axis can be
  reached); `step` defaults to `event` on a date axis and `beat` on an order
  axis. An authored `playhead` must lie inside that filled window, defaulted
  ends included (`DF_IR_TIME_WINDOW_INVALID`), because the still, the time bar
  and the viewer all clamp to it. Undated nodes stay visible; undated edges are static. The viewer keeps
  the playhead in the URL hash as `#t=<date|beat>&step=<id>&live=true`.

**View references** (`lib/gates/topology-views.mjs`): `focus`, every
`presentation[]` entry, every `steps[].nodes` id and `views.vr.entry_node` must be
a node; every `steps[].edges` id must be an edge **id** (an id-less edge cannot be
stepped to). Anything that resolves to nothing is `DF_IR_DANGLING_VIEW_REF`
(blocking) at its own path: the viewer never invents topology.

**The time window** (same file): `DF_IR_TIME_WINDOW_INVALID` (blocking) when
`from > to`, when `playhead` lies outside `[from, to]`, when a date appears on an
`order` axis or an integer on a `date` axis, or when the step does not fit the
axis (`beat` is for `order`; `day|week|month|year|event` for `date`) — one fail
per offending path. `DF_IR_TIME_RANGE_EMPTY` (non-blocking) when the axis is
`date` and no node carries the named `field`: every node would fall back to
`captured_on`, so the authored dimension is empty.

## 6. The open maps

`test/validate.test.js` and `test/ir-gates.test.js` pin `openPaths(loadSchema('scene'))`
to exactly `["$.ext", "$.labels", "$.nodes[*].fields", "$.positions", "$.routes"]`:
the three geometry tables beside each other, the node field map and the customer
block. VISION §2.3's `views.json` value `map` belongs to the room schema
(`rooms-store`), not to the scene. Everything else is closed — `views.2d.plan`,
`views.time`, `views.interactive.steps[]` and `delta` included: an unknown key
anywhere is `DF_SCHEMA_UNKNOWN_FIELD` with its path.

`ext` is never read by `renderers/` or `lib/layout/`. The one key the pipeline
reads is `ext.kinds`: the sketch importer writes a sketch's inline `kinds` block
there, and `lib/pipeline.mjs withSceneKinds()` validates it against
`schemas/kinds.schema.json` (an invalid block is `DF_SCHEMA_*` at `$.ext.kinds`)
and merges it over the render's kinds table, so an `x-` kind the sketch declares
is known to the gates and keeps its glyph and 3D primitive.

## 7. The projected stamp

`lib/project.mjs` is the one exit door; it writes
`projected: {by, engine_version, viewer, at, dropped, limit{focus, reach, lens, max_nodes}, mac}`.
The stamp is `mac = hmac-sha256(session.key, canonical(scene minus projected and receipt))`,
exported once from `lib/gates/privacy.mjs` as `stamp(scene, key)` /
`stampInput(scene)` / `verifyStamp(scene, key)` so the projector and the gate
can never disagree. With `ctx.requireProjected` the privacy gate evaluates
`DF_RENDER_UNPROJECTED`: missing block, missing key, or a mac that does not
verify. A pasted or hand-typed block is HMAC-shaped and still fails
(`test/fixtures/ir/DF_RENDER_UNPROJECTED.fail.json`).

The shipped examples are stamped under the fixture key
`dotfield-example-session-key` (`test/fixtures/ir/examples.mjs`) so the test can
prove the genuine stamp verifies and any edit breaks it. A real center's key
lives in `data/keys/session.key` and never enters a scene
(`DF_PRIVACY_KEY_MATERIAL`).

## 8. The privacy gate, field by field

`check(scene, ctx)` with `ctx = {viewer, rooms, config, sessionKey, requireProjected, …}`:

- **Viewer** — `ctx.viewer` (`'self'`, `'<person_id>'` or `{person_id, mode?, rule_refs?}`) wins over `scene.viewer`; a mismatch is `DF_PRIVACY_VIEWER_EXCLUDED` at `$.viewer`. The owner (`'self'` or `config.center.owner_person_id`) sees everything. Another person sees a node when it is `public`, when they own it, or when a `rule_refs` entry `<grantor>/<rule_id>` has `rule_id` in the node's `share_rule_ids` and `grantor` is the node owner. A `public` viewer sees only `public` nodes. `blocked` never leaves.
- **Foreign bodies** — a node owned by someone else that carries `fields` must name `provenance.imported_via_rule_ref` (`DF_PRIVACY_FOREIGN_BODY_WITHOUT_RULE`).
- **Public-field ceiling** — with `ctx.rooms` (array, map or `Map` of room manifests), a local node's `fields` keys must be in its room's `record.public_fields` (`DF_PRIVACY_FIELD_NOT_PUBLIC`). A room the context does not know is skipped: its ceiling is enforced where the node was projected.
- **Absolute paths** — every key and string value is tested against `ABSOLUTE_PATH_RE` from `lib/rules.mjs` (`DF_PRIVACY_ABSOLUTE_PATH`).
- **Taint** — a boundary stub is a `kind: boundary` node owned by someone else. A local node *reaches* a stub when it cites evidence the stub cites, when its `source.kind` is `run` and an edge joins it to the stub, or when it `annotates` the stub. Such a node must list every origin `rule_ref` in `provenance.derived_from` (`DF_PRIVACY_DERIVED_UNTAINTED`); `lib/project.mjs` computes this transitively, the gate verifies it.
- **Handles and keys** — a key named `handle`/`handles`, or an `hmac-sha256:` value anywhere but `projected.mac`, is `DF_PRIVACY_HANDLE_PRESENT`; a key named `private_key`, `secret_key`, `session_key`, `owner_token`, `salt`, `handle_salt`, `seed_phrase`, `passphrase` or `api_key`, a PEM private-key block, or a reference into `data/keys/` is `DF_PRIVACY_KEY_MATERIAL`.

Every gate returns one check per code it evaluated (`status: "pass"`) plus one
check per failure with `path`, `message` and `repair`; none of the three ever throws.
No privacy code gained an author-declared exemption in v2.0.

## 9. Archify claim scope

`importers/archify.mjs` imports all five archify diagram types; nothing is
refused by name (`REFUSED = []`), and only a `diagram_type` string the importer
does not know is refused with `DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE` (its repair
names the five types and offers the plain-graph route through the `json`
importer). **The importer never writes `positions`, `routes`, `labels` or
`laid_out`**: `lib/layout` lays every imported scene out (grid, sequence or
lifecycle), so an import is gated exactly like an authored scene.

- **architecture | workflow | dataflow** → `kind: workflow` on the `grid`
  layout (unchanged mapping): components become `asset`/`file` nodes pinned at
  their cell centre through `nodes[].pos` (archify `row`/`col`, workflow
  `lane`/`col`, dataflow `stage`/`row` with one column per stage, or the pixel
  `pos` ranked into rows and columns); connections become `flow` edges with
  `route: orthogonal`, `from_side`/`to_side` and `order`. A file in archify's
  own format (it carries `schema_version`) draws `via`, `labelAt` and
  `channelX/Y` in archify's canvas frame, so those round-trip under
  `ext.archify.connections[id]`; `importers/archify-route.mjs` writes lattice
  `via` points in the import frame instead (no run shares a line, none passes a
  node it does not connect), and `importers/archify-labels.mjs` sets `label_at`
  where the default spot collides. A file without `schema_version` (the v1
  importer's format) keeps its `via`. The full mapping is
  `references/ARCHIFY_PARITY.md`; `boundaries`/`containers`/`groups`/`phases`/`stages` become
  `zone` groups and `lanes` `lane` groups; `mainPath` becomes
  `views.interactive.presentation` + `steps[]` (each step the node and the edge
  that reached it); `meta.animation: trace` becomes `views.time {axis: order,
  step: beat, motion: trace}`.
- **sequence** → `kind: sequence` (`importers/archify-seq.mjs`): participants
  become nodes in archify order (`external` → `person`, `frontend`/`backend`
  → `desk`, `database` → `record`, `messagebus`/`security` → `asset`; the full
  table is `PARTICIPANT_KINDS`); messages become `message` edges whose `order`
  is the dense rank of archify's `y` (equal `y` = one beat), else the file's
  integer `order`, else document order; `return`/`dashed`/`async`/`reply`
  variants draw dashed; self messages stay; `activations` round-trip under
  `ext.archify.activations` with the beats their `y` range spans; `segments`
  become `views.interactive.steps` (playhead at the segment's last beat);
  `views.2d {layout: sequence}`, `views.3d` lifts flat, `views.time {axis:
  order, step: beat}` with `motion: trace` when archify animates.
- **lifecycle** → `kind: lifecycle` (`importers/archify-life.mjs`): states
  become `event` nodes with `shape: pill`, tagged `initial` (a `start` type,
  else the lowest `step`, else the first state no transition enters) and
  `final` (a `terminal`/`final`/`end` type, an archify tag `terminal`/`final`,
  or a state no transition leaves); `lanes` become `lane` groups; transitions
  become `transition` edges with `fromSide`/`toSide` as `from_side`/`to_side`;
  consecutive `step` states no transition joins get an implied transition
  (`ext.archify.rail`); archify's `via` points are pixels of archify's own
  canvas, so they round-trip under `ext.archify.transitions` and `lib/layout`
  routes every transition; `views.2d {layout: lifecycle, direction: right}`,
  `views.time {axis: order, step: beat, motion: playback}` and `steps[]` the
  default playback walk.

Shared by all five: every edge keeps its source id or is minted `e<index>`; an
order the source does not give is derived (breadth-first depth of the source
from the start, `+ 1`) and, where the scene uses it, listed by the
non-blocking `DF_IMPORT_ORDER_FILLED` with `ext.archify.order_filled` saying
how; `sources` become `evidence` rows of kind `file` labelled `SRC n`; `cards`
and every source attribute without a scene field round-trip under
`ext.archify`. A second message on one ordered pair is kept on its own beat
(the topology gate allows it in a `sequence`, §4); a second transition on one
pair merges its label into the first and is listed under
`ext.archify.dropped_transitions`. The importer asks the gate
(`repeatsAllowed`) instead of copying its rule.
The claim is narrow: an imported scene reproduces archify's topology, order
and grouping, not archify's rendering; how many archify files render clean at
`showcase` is a reported fraction (the `archify-corpus` ticket), not a claim.

## 10. Behaviour changes

Changes a scene that validated before v2.0 can observe. Each is deliberate and
pinned by a test; none loosens a privacy gate.

- **View references are no longer edge findings.** A `views.interactive.focus`,
  `presentation[]` entry or `views.vr.entry_node` that resolves to nothing now
  reports `DF_IR_DANGLING_VIEW_REF` (blocking) at the same path; the new
  `steps[].nodes` / `steps[].edges` ids are covered by the same code. The code
  `DF_IR_DANGLING_EDGE` is again edges-only (`$.edges[*].from|to`). Before
  landing, `test/`, `references/` and `examples/` were grepped for the old code
  on view paths: the one hit was the `DF_IR_DANGLING_EDGE.pass.json` fixture's
  `presentation[]` case, which moved to `DF_IR_DANGLING_VIEW_REF.pass.json` in
  the same commit; `test/ir-gates.test.js` ("topology details") pins the new code.
- **Self edges are allowed in `sequence` and `lifecycle` scenes.** `DF_IR_SELF_EDGE`
  is skipped by scene kind (the layouts draw the loop); every other kind still
  refuses one, a self `message` in a `graph` included.
- **New blocking requirements on ordered and routed edges.** `DF_IR_ORDER_MISSING`
  and `DF_IR_EDGE_ID_REQUIRED` apply only to the new kinds (`message`,
  `transition`), to `sequence` scenes and to scenes whose `views.2d.layout` is
  `layered|sequence|lifecycle`; an existing `graph|workflow|…` scene in a
  pre-v2 mode is unaffected (today 0 of 56 shipped edges lack an id).
- **Repair sentences rewritten** (text only, codes unchanged): `DF_IR_KIND_UNKNOWN`
  (kinds.json first, `shapes.json` as the engine fallback), `DF_LAYOUT_UNKNOWN_MODE`
  (lists the three new modes), `DF_RENDER_SRI_MISSING` and `DF_RENDER_VENDOR_MISSING`
  (`npm run vendor` once, `--no-embed-three` for a CDN render),
  `DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE` (names what dotfield models and the
  plain-graph route). `DF_RENDER_SELF_VIEW_EXPORTED` is unchanged: no exemption.
- **Inert until their gate emits them** (declared by `ir-v2` so the catalog is
  complete before anyone consumes it): the six `DF_LAYOUT_*` codes land in
  `layout-core`, the two `DF_RENDER_MOTION_*` codes and `DF_IMPORT_SKETCH_INVALID`
  in `quick-path`; all nine are emitted now. The catalog is 245 codes in 24
  families: 239 from `ir-v2`, `DF_IMPORT_ORDER_FILLED` (importers-parity) and
  the five `DF_DELTA_*` codes of the `delta` family (compare); `PINNED` is
  19 verbs, 27 leaf subverbs, 12 MCP tools, 24 rule families.
- **A repeated message in a sequence is a second edge** (2026-10-08). The
  `DF_IR_DUP_EDGE` key carries `order` in a `sequence` scene, so two messages on
  one pair at different beats both validate; every other scene kind, a
  `lifecycle` included, keeps one edge per `(from, to, kind)`. The archify
  corpus keeps the three messages it used to merge (`ARCHIFY_PARITY.md` §5).
- **The scene gained a closed `delta` block** (compare). Only `dotfield compare`
  writes it; an authored scene never carries one, and the five open maps are
  unchanged.

- **The viewer opens unfocused (2026-10-08).** Before, an authored `views.interactive.focus` was applied on load: its card opened over the drawing and every node outside its reach was dimmed, which washed out sequence diagrams. It is now the F key's entry node; a `#focus=` deep link is unchanged. The 2D view also fits the drawn scene (nodes, edges, regions) to the screen on load, on resize and on `0`, until the reader zooms or pans.

- **Grid groups draw as boxes (2026-10-08).** In a `grid` scene (every archify import) a group is drawn the way archify draws a boundary, as a rounded rectangle around its members' glyphs and labels, whenever that rectangle holds no other node's centre; otherwise it keeps the padded hull, so a non-contiguous group stays truthful and never newly blocks. `lib/layout/drawn.mjs regionShapes` makes the choice and `lib/gates/layout.mjs` measures `DF_LAYOUT_REGION_CONTAINMENT` against whichever shape is drawn.

## 11. Fixtures and examples

`test/fixtures/ir/<CODE>.{fail,pass}.json` — one pair for every `DF_IR_*` and
`DF_PRIVACY_*` code and for `DF_RENDER_UNPROJECTED`. Shape:
`{code, expect, why, ctx?, expand?, scene}`; `ctx` merges over the test's default
context; `expand` clones a node at load time so the 2001-node and 1 MB cases stay
small. Every fixture is schema-valid, so each isolates one rule. The generator
also exports `sequence()` and `lifecycle()` — a three-participant handoff with a
self message and dense routes, and a three-state machine with a back edge — which
the v2 fixtures and `test/ir-gates.test.js` build on. Both the fixtures and
`examples/scene-{graph,room,timeline,workflow,sequence,lifecycle,architecture}.json`
are written by
`node test/fixtures/ir/build-fixtures.mjs` (`--check` reports drift; the example
scenes themselves come from `examples.mjs`, owned by `examples-recipes`) and
`test/ir-gates.test.js` fails when a committed file differs from the generator.
