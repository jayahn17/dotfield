# The honest maturity ladder (VISION §13)

`maturity` is a field, not prose: `contract_only | prototype | local_beta | tested`. It is required on every room and pack, printed in every receipt and every viewer footer. Move an item **up only with the named proof**, in the same commit that adds the proof, and keep this table and VISION §13 identical (`test/rules.test.js` compares them row for row).

| Component | Tag | v1 target | Proof that moves it up | Known gap |
|---|---|---|---|---|
| Validator, rule catalog, receipts | v1.0 | tested | official JSON-Schema-Test-Suite for the subset, catalog completeness, reproducible digests and ids | keyword subset only |
| Scene IR + gates | v1.0 | tested | fixture per code, golden examples, HMAC stamp test | — |
| Layout (2D-first, lift, metric, tier-wall) | v1.0 | tested | committed 500-node positions on Node 22/24 | quality on 2000 nodes measured for time only |
| 2D SVG + standalone HTML + viewer | v1.0 | local_beta | golden SVG, standalone test, one recorded screenshot | provisional per render until a screenshot path is attached |
| Rooms, store, sandbox, proposals, approve | v1.0 | tested | hop tests, 11 scope cases, atomic store, piped-approve refusal, sandbox write denial | an agent with the owner's shell can read `owner.token` (GOVERNANCE) |
| Scope rule | v1.0 | tested (internal) | 11 cases via `--as` | no person sessions exist; `person_<id>` is unreachable from the wall |
| Projector (one exit door) | v1.0 | tested | eight privacy cases + static import scan + taint | gates catch shape, not meaning |
| Agent loop + router + fences | v1.0 | local_beta | plan == run, dry provider, injection fixture, one recorded `claude-cli` run | routing is keyword-shallow |
| Server + inbox + wall | v1.0 | local_beta | CSRF triple test, decide refusal, wall tests | no session UI beyond the token file |
| MCP server | v1.0 | local_beta | 12 tools pinned, in-process client | depends on the optional SDK major |
| Packs: starter, robotics-lab | v1.0 | local_beta | `init --pack` ends with a passing prove-all; the owner's own data imported | robotics-lab validated by one person |
| Meeting layer (`connect --between`) | v1.0 | local_beta | candidates never persisted; threshold test; robotics-lab demo | candidate quality is token overlap |
| 3D (three r180) | v1.1 | prototype | real-three headless build + one browser screenshot | provisional until captured |
| VR (WebXR) | v1.1 | prototype | XRButton state machine + overlay text | provisional until an adb capture |
| Sharing (rules, projections, overlays, signing) | v1.1 | local_beta | eight cases, two-center demo | fingerprint entry is manual; no recovery |
| Idea synthesis (`run --with`) | v1.1 | prototype | dry run with evidence from both sides | no real cross-person run recorded |
| Pack: research-lab | v1.1 | contract_only | manifests validate, demo runs | no second human has run it |
| Packs: law-practice, clinic (draft) | — | draft | one practitioner's review, at-rest encryption story, retention sweep | refused by `init` |
| Importers | v1.0/v1.1 | local_beta | fixture tests; archify scope stated | v1.0 refused sequence/lifecycle; v2 `importers-parity` imports all five archify types (a repeated lifecycle transition on one pair still merges) |
| Customer code: `actions.mjs`, `center/importers/*.mjs` | — | planned | a verb runs each through `lib/sandbox.mjs runModule()` with a test and a `DF_SANDBOX_*` fixture | not wired: only a room's `test.mjs` runs today (`prove`); the docs name both as reserved |
| Theme | v1.0 | tested | deterministic output, contrast refusal, font inlining | — |
| Migrations | v1.1 | prototype | one round-trip fixture | first real bump not yet needed |
| Pack updates (`center/pack-lock.json` + `migrate`) | v1.1 | prototype | `node --test test/migrate.test.js test/fork-sim.test.js`: untouched files updated with a backup, owner edits kept, deletions respected, a fork merges an upstream pack change with no conflict | a conflict is merged by hand (the shipped copy is set beside the backup); no real upstream pack release has happened yet |
| Backup and restore | v1.1 | local_beta | `node --test test/backup.test.js`: export → fresh center → `import records` + `approve` restores every record | the encrypted `data/` archive in `recipes/backup-and-restore.md` is documented, not tested; a restore from an export starts with new keys |
| Skill outside a fork (npx) | v1.1 | local_beta | `test/skill.test.js` pins both prefixes and the release tag; `npx -y github:jayahn17/dotfield#v0.1.0` rendered a sketch into an empty folder from the public repository (2026-10-15), and `npx skills add jayahn17/dotfield --list` finds the skill | the first run fetches the optional MCP SDK too (about 11 s); each release moves the pinned tag |

## How the field is enforced

- `validate` emits non-blocking `DF_ROOM_MATURITY_UNPROVEN` when `.dotfield/prove/<room>.json` is absent.
- `prove` emits blocking `DF_ROOM_MATURITY_OVERCLAIM` when a `tested` room has no `test.mjs` or its test fails; the generic proof lifts a room to at most `local_beta`.
- Every receipt prints `maturity`, `release_tag` and `evidence.browser`, so a label is never implicit. Slices 6–8 carry `release_tag: "v1.1-provisional"` until the proof in this table exists.
- As of integration round 1 (2026-10-02) no row has been moved up: the named test proofs now exist in the tree for every v1.0 row (`npm test` green), but the proofs that need a human or a device — a recorded screenshot, a recorded `claude-cli` run, an adb capture, a second person running a pack — have not been produced, so the tags stay where they started. The two-center demo (`scripts/demo-two-centers.sh`) and the `/0 → /1` migration round trip (`test/fork-sim.test.js`) run locally; VR capture is proven against a stub `adb` only.

## v2 (2026-10-07, closed 2026-10-08) — the §10 rows of `references/V2_PLAN.md`

The v2.0 build is exactly eight components (VISION §0.1). Each row states the maturity a component **starts at now that its named proof is in the tree**; the proof column names the command that shows it. As of the release-v2 close (2026-10-08) every v2.0 row's proof is in the tree and `npm test`, `npm run check` (ending in `bench:check --quick`) and `node scripts/benchmark.mjs --quick --check` are green; the full `node scripts/benchmark.mjs --write` ran once for the close and its JSON lives under `.dotfield/benchmark/` (gitignored; the auto block in `references/BENCHMARK.md` is what it committed). No row below was moved up on a browser or headset capture: none was attached.

| Component | Starts at | Proof that moves it up | Known gap |
|---|---|---|---|
| Benchmark (`scripts/benchmark.mjs`, `lib/bench/`) | tested | `node --test test/benchmark.test.js` (12/12); `bench:check --quick` in `npm run check` and in the shipped workflow `.github/workflows/dotfield.yml` (not executed until dotfield is a repository root: GitHub reads workflows only at a repo root, and son's root workflows never call it); the quick JSON byte-identical under one `SOURCE_DATE_EPOCH`; the corpus is the 8 examples and the 9 pack scenes plus the archify fixtures and corpus | competitor cells are hand-entered booleans with sources; no competitor executed; the full bench (timings, fresh clone, runner summary) runs by hand before a release |
| IR v2 (kinds, tables, time block, codes) | tested | fixture per code (`node --test test/ir-gates.test.js`, 13/13); `openPaths` pin; every shipped scene validates unchanged | — (`delta` landed with `compare`) |
| Layered / sequence / lifecycle layout | local_beta | `node --test test/layout-types.test.js` (14/14); 17 of 17 shipped scenes written at showcase in the benchmark block | zone bands, not a compound layout; a review loop draws one non-blocking `DF_LAYOUT_LAYER_CYCLE_BROKEN` |
| Label and route repair (force, cluster-disc) | local_beta | `node --test test/layout.test.js` (24/24): regenerated 500 and 2000 fixtures; tree-100 at 0 clearance and 0 route-through; the anti-gaming hashes; `node --test test/layout-truth.test.js` (10/10): sublabels, evidence pins, order badges and region labels measured where they are drawn and avoided by the layout, every pack and draft pack scene a showcase-clean cold-run output | 2000 nodes clean only among budgeted labels (the benchmark prints measured and total) |
| 4D core (`lib/time` + the viewer mirror) | tested (Node) | `node --test test/time.test.js` (14/14) deep-equality incl. month-end cases; the browser mount is the `viewer-4d` ticket below | — |
| Still-at-t SVG (ruler, badges, ghosts) | local_beta | `node --test test/svg-golden.test.js` (26/26): goldens for the 7 stamped examples (all but `scene-graph` laid out cold since 2026-10-08), region labels on their own region and clear of each other; `DF_RENDER_MOTION_*` fixtures | the motion itself is the `viewer-4d` ticket |
| Sketch importer + templates (`quick-path`) | local_beta | `node --test test/sketch.test.js` (11/11); the benchmark JSON `first_output`: 10 of 10 templates exit 0 at showcase with 0 fail rows, steps 2 (`--view 2d`) and 2 (`--view all`) | sketches are authoring, not storage; a first output still needs a clone and Node |
| Examples (7) | tested | `node test/fixtures/ir/build-fixtures.mjs --check`; `node --test test/examples.test.js` (6/6): 7 of 7 showcase-clean with a written viewBox | — |

## v2.x tickets

A ticket opens only when **both** hold: its benchmark row is red (`not_implemented` or a failing number) **and** an external user or a receipt names the need. Six tickets were opened in the same build by the owner's explicit ask of 2026-10-07 (`V2_PLAN.md` §0.1) and **landed on 2026-10-08** with the proof named in their row; the other five stay closed. Every 3D, VR and 4D row reads `provisional` until a person attaches a browser (or, for VR, a headset) capture with `scripts/evidence.mjs`: the browser checks made during the build are recorded in the component reports, not as evidence.

| Ticket | Status | Benchmark row | Proof |
|---|---|---|---|
| `viewer-4d` | landed 2026-10-08 · local_beta (provisional until a browser capture) | 4D `playhead in hash: yes`; checklist `scrub control: present` | `node --test test/viewer-4d.test.js` (8/8): the browser frame equals `lib/time visibleAt` at every stop, the dash window mirrors `svg-edges`, the hash round trip `#t=&step=&live=`, `DF.animate` is finite; keys `. , [ ] p g n b` in one `DF.HELP`; `node --test test/html-3d.test.js` still green |
| `three-4d` | landed 2026-10-08 · prototype (provisional until a browser capture; VR until a headset capture) | 3D and VR rows stay `provisional` | `node --test test/html-3d.test.js` (13/13) against the vendored three r180: segment-for-vertex polylines, ghosts, beads, the now plane, adaptive DPR, snap turn; `wc -l renderers/three.mjs` = 270 (≤ 300) |
| `compare` | landed 2026-10-08 · local_beta (HTML view provisional; the 3D and VR tabs draw the after scene without ghosts or move connectors) | 4D `compare verb: yes`; checklist `before/after delta: present` | `node --test test/compare.test.js` (15/15); `PINNED` 19 / 27 / 12 / 24 with `test/cli.test.js` and `test/rules.test.js`; 245 codes in 24 families; the delete sweep covers `.dotfield/compares/` |
| `importers-parity` | landed 2026-10-08 · local_beta | `archify.types_supported: 5 of 5`, `refused_by_name: none` | `node --test test/importers.test.js` (19/19): sequence and lifecycle imported with minted `e<index>` ids; `DF_IMPORT_ORDER_FILLED` non-blocking |
| `archify-corpus` | landed 2026-10-08 · tested | `archify_total_types: 5`; `corpus_showcase_clean: 15/15` | `node --test test/archify-corpus.test.js` (8/8): the 15 archify examples at commit `73aaa0696e8f` (MIT, licence vendored) verified by sha256 (`node scripts/fetch-archify-corpus.mjs --verify`), imported, validated and rendered at showcase; all 26 corpus sequence messages kept (repeated messages on their own beats since 2026-10-08; repeated lifecycle transitions still merge, `references/ARCHIFY_PARITY.md` §5) |
| `themes-presets` | landed 2026-10-08 · tested (the HTML grid texture provisional; `out.svg` paints no background and the page's SVG/PNG export fills `--df-bg` without the texture, so `blueprint`'s grid shows only in the live page) | checklist `named visual presets` (eight) | `node --test test/themes-presets.test.js` (12/12): `editorial` and `blueprint`, `render --theme <name>`, a golden per preset, `blueprint` label `textLength == labelWidth(label, {stack: 'mono'})`; `node scripts/contrast.mjs --check` at 328 pairs |
| `receipts-chain` | v2.x ticket · not started | Verification `prev_digest in schema: no` | `.dotfield/receipts/index.jsonl`; `verify --chain`; the collision case asserted |
| `interchange` | v2.x ticket · not started | checklist `interchange export: absent` | `render … --format d2|mermaid|dot|jsoncanvas`; no round trip claimed |
| `packs-v2` | v2.x ticket · not started | — (opens when a room wants a sequence or lifecycle view) | summaries count only records the viewer's projection keeps; `project.test.js` asserts it for self, a granted person and the public viewer |
| `agent-surface` | v2.x ticket · not started | Agent `Claude Code hook reminder: no` | a hook shipped labelled a reminder, not a guard; `test/hooks.test.js` with the three documented bypasses |
| `vendor-min` | v2.x ticket · not started | embedded size in the JSON | `vendor/manifest.json` the single source of file names; one network fetch confirms the minified core specifier |

The v1 table above keeps the row text VISION §13 holds (the two move together). Its `Importers` gap was rewritten in both on 2026-10-08, when `importers-parity` closed "sequence/lifecycle refused".
