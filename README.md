# Dotfield

One private data center per professional, shipped as a template any profession can fork: typed JSON in, one gated, standalone 2D/3D/VR page out. The 2D view is fully inside the HTML; the 3D/VR tabs load three.js from jsdelivr (pinned, with SRI) unless you pass `--embed-three` (after `npm run vendor` once) or render with `--quality showcase` or `--for <person>`, which embed by default. Vendoring alone changes nothing: embedding needs those vendored files, so without `npm run vendor` an embedding render is refused with `DF_RENDER_VENDOR_MISSING` and its repair line.

## Render a sketch in two steps

```
git clone https://github.com/jayahn17/dotfield.git && cd dotfield
node bin/dotfield.mjs render templates/architecture.sketch.json --view all
```

No `npm install`, no `init`, no keys: Node alone runs it (the engine has no runtime dependencies). The receipt names the folder it wrote inside `.dotfield/renders/<kind>-<title>-<time>/` — `out.html`, `out.svg`, the expanded `scene.json` and `receipt.json` — after every gate passed; copy the HTML wherever you like. A render for yourself stays inside `.dotfield/` (outside it the receipt warns `DF_RENDER_SELF_VIEW_EXPORTED`, whatever the scene claims); render `--for <person>` for anything that leaves the machine. `npm run demo` renders every template into `.dotfield/demo/` with an `index.html`.

## What a sketch is

A sketch (`dotfield.sketch/1`, [`schemas/sketch.schema.json`](schemas/sketch.schema.json)) is the shortest input: a diagram type, a title, node names, edge lines and optional groups — the architecture template is the whole file below.

```json
{
  "schema_version": "dotfield.sketch/1", "type": "architecture", "title": "Telemetry",
  "groups": { "edge": ["bag", "ingest"], "core": ["sync", "store"] },
  "nodes": ["bag", "ingest", "sync", "store", "report"],
  "edges": ["bag -> ingest: frames", "ingest -> sync", "sync -> store: rows", "store -> report"]
}
```

`importers/sketch.mjs` expands it deterministically into a full scene: ids and labels from the names, every edge id'd and ordered, `synthetic_data` and `prototype`, one import evidence row carrying the sketch digest, and the 2D, 3D and VR views. Edges are `a -> b: label`, `a --> b: label` (dashed) or `a -- b` (undirected), or objects with `from_side`/`to_side`; nodes may be objects with `kind`, `group`, `tags`, `date` (timelines) or `pose`/`size` (rooms). A field it cannot use is `DF_IMPORT_SKETCH_INVALID` with its path, and the gates then judge the expanded scene like any other. Write your own under `.dotfield/sketches/<name>.sketch.json`, starting from a template; the files under `templates/` are yours to edit in a fork. An `x-` node kind is one row in a sketch's `kinds` block, a pack's `kinds.json` or `center/kinds.json` ([`schemas/kinds.schema.json`](schemas/kinds.schema.json); `templates/custom-kind.sketch.json` shows one).

## Eleven architecture types

| Type | Start from | Scene kind | 2D layout | 3D |
|---|---|---|---|---|
| architecture / C4 containers | `templates/architecture.sketch.json` | workflow | layered, top down; groups drawn as zone bands | lift |
| workflow | `templates/workflow.sketch.json` | workflow | layered (`direction` turns it left to right) | lift |
| dataflow | `templates/dataflow.sketch.json` | workflow | layered, left to right, flow edges | lift |
| sequence | `templates/sequence.sketch.json` | sequence | participants on lifelines, numbered messages | lift |
| lifecycle / state machine | `templates/lifecycle.sketch.json` | lifecycle | pill states tagged initial/final, numbered transitions | lift |
| graph / knowledge web | `templates/graph.sketch.json` | graph | force, label-aware | lift |
| timeline | `templates/timeline.sketch.json` | timeline | dated nodes in order, with a date ruler | tier wall |
| board | `templates/board.sketch.json` | board | one lane per group | lift |
| room | `templates/room.sketch.json` | room | metric map from poses in metres | metric |
| meet | `dotfield connect --between <a>,<b>` (a center) | meet | cluster discs | lift |
| org tree / mind map | the architecture template with one root | workflow | layered over a tree | lift |

Every type renders 2D, 3D and VR from one positions table (`--view all`); sequence and lifecycle scenes draw their messages and transitions along routed channels in 3D too. An archify file of any of its five diagram types (architecture, workflow, dataflow, sequence, lifecycle) becomes a scene with `node bin/dotfield.mjs import archify <file> -o scene.json`; [`references/ARCHIFY_PARITY.md`](references/ARCHIFY_PARITY.md) records the field mapping and what is dropped. Two named presets join the themes: `--theme editorial` (serif, roomy) and `--theme blueprint` (mono labels on a drafting grid); the layout gate measures labels in the chosen theme's font.

## Time, steps and compare

A scene with a `views.time` block gets a time bar under the header: `.` and `,` step between stops, `[` and `]` jump to either end, `P` plays one finite pass (never a loop), and the URL keeps the frame as `#t=…&step=…&live=…`. Every frame is a still: the SVG at any `t` carries the whole meaning, motion is opt-in (`motion: still | trace | playback`) and `prefers-reduced-motion` gets instant frames. `views.interactive.steps` (or `presentation[]`, or a lifecycle's own transitions) becomes a guide: `G` opens it, `N` and `B` move through it. The 3D view follows the same playhead: unborn nodes are ghosts, edges draw up to their phase, beads run along the edges in flight.

`node bin/dotfield.mjs compare <before> <after>` pairs two scenes of one kind by stable ids and writes one before/after page inside `.dotfield/compares/`: added nodes accented, removed ones ghosted where they were, moves drawn as connectors, a delta legend and `delta.json` beside it. It claims no risk assessment.

## Benchmark

[`references/BENCHMARK.md`](references/BENCHMARK.md) holds what `node scripts/benchmark.mjs` measures on Dotfield (digests, counts and booleans the script regenerates; nothing typed by hand) and a competitor feature checklist. Self-assessed by the maintainer from each project's repository at the pinned commit; no competitor was executed; Phase 2 adapters not present.

## Your own center: fork, init, commit

Fork the repository on GitHub (keep it **private**: it will hold your center), clone your fork, then:

```
node bin/dotfield.mjs init --pack starter --name "My Center"
node bin/dotfield.mjs doctor
node bin/dotfield.mjs serve
git add center && git commit -m "My center"
```

The template ships packs (`starter`, `robotics-lab`, `research-lab`), not a center: `init` writes `center/` from the pack you name, creates your keys under `data/keys/`, and ends with a passing `prove all` and `validate all`. `center/` is yours to edit and commit; `data/` (your records and keys) and `.dotfield/` (renders, receipts) stay out of git. Open the inbox URL `serve` prints to approve what agents propose. The customer guide is copied to `center/docs/README.md`; the design is [`VISION.md`](VISION.md); operator rules are in [`AGENTS.md`](AGENTS.md). The under-an-hour walkthrough is **not yet timed**: no one who did not write it has run it against the clock, so no duration is claimed here.

## Keeping up with upstream

```
git remote add upstream https://github.com/jayahn17/dotfield.git   # once
git pull upstream main
node bin/dotfield.mjs migrate --dry-run
node bin/dotfield.mjs migrate
```

Upstream never ships a `center/`, so the pull cannot conflict with yours. `migrate` updates each pack file in your center that you never edited (checked against `center/pack-lock.json`, which `init` wrote), keeps every file you changed, and backs up whatever it replaces under `.dotfield/migrate-<ts>/`. For a file you changed, the shipped version waits under `shipped/` in that folder: merge what you want, run `migrate --resolved`, and commit `center/`.

## Backups

Git carries `center/`; nothing carries `data/` until you do. [`recipes/backup-and-restore.md`](recipes/backup-and-restore.md) gives both halves: an encrypted archive of `data/` (it holds your keys), and `dotfield export`, a key-free copy that restores into a fresh center through `import records` and `approve` (`test/backup.test.js` runs that round trip).

## Claude, with or without a fork

Open `claude` in your fork and the skill (`.claude/skills/dotfield/SKILL.md`) and the MCP tools are found on their own. Without a fork, install only the skill (`npx skills add jayahn17/dotfield`): it runs the same verbs as `npx -y github:jayahn17/dotfield#v0.1.2 <verb>`, pinned to the release it shipped with, and writes only to the working folder's `.dotfield/`. Either way the skill never runs `init`, `approve`, `export` or `migrate`: those are yours.

This file is `fork_editable` (see `skill-release.json`): a fork rewrites it freely without tripping `DF_ENGINE_MODIFIED`.
