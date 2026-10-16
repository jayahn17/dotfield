# HISTORY — where the design comes from, the v1 release shape and the v1 build order

> Moved verbatim from `VISION.md` on 2026-10-07 (V2_PLAN §8 cleanup): the lineage paragraphs and the graft table of §0, the release-shape paragraph of the preamble, and §11. VISION §0 keeps the first lineage paragraph and carries the v2 cut line; `references/V2_PLAN.md` is the v2 plan.

## A. Lineage — the judges' trunk and the four grafts (VISION §0)

Dotfield is one design synthesized from five studies (Plexus, Orrery, Trellis, Tessera, Dotfield) judged against two references: **archify** (github.com/tt-a1i/archify: typed JSON IR → atomic validation gates with stable rule codes → one self-contained HTML with a truthful interactive viewer, driven by a SKILL.md) and the **son** repo (LifeTwin: one product, six-layer module shape, one agent roster with an owner-approval loop, proof guardrail, three-state scope rule, durable-store rule, token layer). A second review round of 60 objections (6 fatal, 32 constraint, 22 nit) was absorbed into this revision; the fatal six were: the skill could reach `approve` through the Bash wildcard, the validator could not validate its own example, `decide` was CSRF-able, `re_share: false` laundered through one synthesis step, the projection envelope leaked labels and tags outside `public_fields`, and plain-sha256 handles were reversible by dictionary. Each fix is now a test, a rule code or a schema constraint, named where it lives.

The judges' trunk is the module-first design (Trellis): a room is one folder discovered at boot, a declarative `record` block makes most rooms zero-code, `public_fields` is the ceiling on what can ever be shared, and **the approve verb does not exist in the MCP tool list and does not match any pattern in the skill's allow-list**, so the agent cannot close its own loop. Onto that trunk the judges asked for four grafts, all taken:

| Graft | From | What it is |
|---|---|---|
| Scene IR discipline | Orrery | layout runs once in Node and writes one `positions` table + `laid_out: true` into the scene; `shapes.json` is one data table both 2D and 3D read; `svg.mjs` is the golden-tested 2D truth and also the interactive 2D view; `xr.mjs` reuses the exact three scene; `--embed-three` by data-URL importmap; proposal nodes render dashed/wireframe in every mode; `DF_IR_TOO_LARGE` at 2000 nodes and `DF_IR_FIELDS_BUDGET` at 1 MB; archify `architecture|workflow|dataflow` files import as `kind: workflow`; every source file under 400 lines |
| One exit door | Tessera | `lib/project.mjs` is the only module that reads records and serializes nodes; a static test fails any other importer of `lib/store.mjs`; the owner's own view is `--for self`, so there is no privileged render path; the `projected` stamp is an HMAC keyed by `data/keys/session.key`, not a plain field; ed25519 via `node:crypto`; imported projection content is fenced data, never instructions |
| Customer surface | Dotfield | the customer edits only `center/`; `brand.json` (six fields) → generated tokens → contrast ledger re-run; declarative `views.json`; honest no-WebXR overlay; one HTML with a 2D/3D/VR toggle; the walkthrough timed by someone who did not write it, or marked "not yet timed". **Not taken:** `center/overrides/`, `center/packs/`, tarball upgrade, a web app shell |
| Receipts as proof | Plexus | exit codes 0/2/3/4/5; `dotfield prove` lifts a zero-code room to at most `local_beta`; `skill-release.json` carries digests of `lib/` and `schemas/` so an **unintended local edit** is visible in every receipt (it is not tamper evidence); `dotfield_scene` MCP tool so Claude can reason over a room's graph; `examples/evaluation.json` for token-free verification |

Ported son code, by path, is listed in `references/PROVENANCE.md` with the son commit, so a one-person maintainer can diff later. The template imports nothing from the parent repository's `server/`, `api/` or `mcp/` (VISION §0 keeps that sentence in its original spelling; here the three names are written without the parent-directory prefix because the subtree scan reads that prefix as a path leaving the folder); `git subtree split -P dotfield` produces a working repo on day one.

## B. Release shape (VISION preamble, v1)

**Release shape (decided, see §11 and §13):** every slice 0–8 is built in this repository. Slices 0–5 (validator, scene IR, 2D + interactive, rooms/store/approval hop, agent loop, server + inbox + MCP, packs `starter` and `robotics-lab`, the solo meeting layer) are the **v1.0 gate**: `npm test` must be green for them. Slices 6–8 (3D/VR on the same scene, two-center sharing, research-lab, migrations) ship in the same tree but every receipt they produce carries `release_tag: "v1.1-provisional"` until the proof named in §13 exists. Every schema field for 3D, VR and sharing is in v1.0 so nothing is redesigned.

## 11. MVP build order (what ships first, and the proof that closes each slice)

| Slice | Tag | Delivers | Done when |
|---|---|---|---|
| 0 Skeleton + validator | v1.0 | root docs, skill, `package.json`, `lib/{validate,rules,digest,receipt,privacy-levels,exit-codes}.mjs`, `schemas/receipt`, JSTS fixtures, structure/skill/governance tests | `npm test` green on an otherwise empty tree; nothing in son changed |
| 1 Scene IR + tokens | v1.0 | `schemas/scene`, gates schema/topology/privacy, examples, `tokens.css`, `theme.mjs` | `validate examples/*.json` exits 0 (open maps validate); a dangling-edge fixture exits 2 with a repair line |
| 2 2D proven in Node + `cli-core` | v1.0 | layout (2D-first), `shapes.json`, `svg.mjs`, `viewer/`, `html.mjs`, `bin` with validate/render/verify/theme/doctor | every example renders to one HTML under budget; goldens; `#focus=` works; one screenshot path or `provisional` |
| 3 Rooms, store, sandbox, the hop | v1.0 | room schemas, `rooms/scope/store/sandbox/proposals/project`, `packs/starter` + `center/`, `cli-full` verbs add/import/approve/prove/export/delete | a record proposed is absent until approve and present after; piped `approve` exits 3; the delete sweep is clean |
| 4 Agents + approval hop | v1.0 | `lib/agents/*`, providers, `plan`, `run`, `run.md`, foreign fences, solo `connect --between` | `plan == run`; a dry run ends `awaiting_owner`; the injection fixture stays fenced |
| 5 Server + inbox + MCP + robotics-lab | v1.0 | `server/*`, `inbox.html`, `mcp/*`, `evaluation.json`, `packs/robotics-lab`, importers csv/json/son-graph/spatial-scene | `claude` in a fresh clone lists 12 tools; `decide` refuses the three CSRF shapes; `init --pack robotics-lab` ends with a passing prove-all |
| 6 3D + VR on the same scene | v1.1 | `vendor/manifest.json`, `fetch-vendor.mjs` (specifier rewrite), `three.mjs`, `xr.mjs`, `--view all`, data-URL embed | the real three builds headlessly; the 3D HTML opens with WebGL (screenshot path); VR provisional until an adb capture |
| 7 Sharing | v1.1 | person/circle/rule/projection schemas, `share/overlay/sign`, `share …`, `import projection`, `connect --with`, research-lab demo | the eight privacy tests pass; `demo-two-centers.sh` runs end to end with explicit tokens |
| 8 Packs + release | v1.1 | archify/markdown importers, `packs/draft/*`, migrations, CI, `references/`, `recipes/`, README timing | `git subtree split -P dotfield` passes `npm test` in isolation; fork-sim passes |

## C. v2 (built 2026-10-07 to 2026-10-08)

The owner asked for "the highest accomplishable on all 2D/3D/VR/4D", "applied to any type of architecture", at "archify benchmark level". `references/V2_PLAN.md` (revision 2) cut that into eight v2.0 components and opened six v2.x tickets in the same build under its §0.1 rule; the component specs, owned paths and proofs lived in the build session's machine-readable plan and are summarised in V2_PLAN §0.1, §9-§11 and `references/MATURITY.md`.

| Order | Component | What it added | Proof |
|---|---|---|---|
| 1 | benchmark | `scripts/benchmark.mjs`, `lib/bench/`, the two blocks of `references/BENCHMARK.md`, `references/benchmark-checklist.json`; VISION cut to its spine | `test/benchmark.test.js`; `bench:check --quick` in `npm run check` |
| 2 | ir-v2 | `sequence` and `lifecycle` kinds, `message`/`transition` edges, the `routes` and `labels` tables, `views.time`, `views.interactive.steps`, `views.vr.snap_turn_deg`, the v2 codes | `test/ir-gates.test.js`; `openPaths` pin |
| 3 | layout-types | `layered`, `sequence` and `lifecycle` modes with `views.2d.plan` | `test/layout-types.test.js` |
| 4 | layout-core | label-aware force and cluster-disc, route repair, the channel router, the theme-aware label font | `test/layout.test.js` (500/2000 fixtures, anti-gaming hashes) |
| 5 | playhead-core | `lib/time/` and its browser mirror `renderers/viewer/time.js` | `test/time.test.js` deep equality |
| 6 | svg-4d | the still at `t`: date and order rulers, numbered badges, ghosts, `data-phase`; the infinite keyframe deleted | `test/svg-golden.test.js` |
| 7 | quick-path | `dotfield.sketch/1`, `importers/sketch.mjs`, the ten `templates/`, `x-` kinds (`schemas/kinds.schema.json`), `npm run demo` | `test/sketch.test.js`; benchmark `first_output` |
| 8 | examples-recipes | `scene-sequence`, `scene-lifecycle`, `scene-architecture`; plans and time blocks on the four v1 examples | `test/examples.test.js`; `build-fixtures.mjs --check` |
| ticket | importers-parity | archify `sequence` and `lifecycle` import | `test/importers.test.js` |
| ticket | archify-corpus | archify's 15 examples vendored at a pinned commit with its MIT licence; the lattice router and label placement for imported grids | `test/archify-corpus.test.js`; 15/15 showcase-clean |
| ticket | viewer-4d | the time bar, steps guide, finite `DF.animate`, keys `. , [ ] p g n b`, hash `#t=&step=&live=` | `test/viewer-4d.test.js` |
| ticket | three-4d | `three.mjs` split into labels, edges, mount and motion; routed polylines in 3D, ghosts, beads, now plane, adaptive DPR, VR snap turn | `test/html-3d.test.js`; `three.mjs` 270 lines |
| ticket | compare | `dotfield compare`, `lib/delta.mjs`, the `delta` family, before/after SVG layers | `test/compare.test.js`; `PINNED` 19/27/12/24 |
| ticket | themes-presets | `editorial` and `blueprint`, `render --theme` | `test/themes-presets.test.js`; contrast ledger 328 pairs |
| close | release-v2 | the integration patches the components left for files outside their paths, the full benchmark run, MATURITY and V2_PLAN rows, CI steps (archify corpus verify and test, every template and example rendered at showcase), the manifests | `npm test && npm run check && node scripts/benchmark.mjs --quick --check` |

What it did not claim: no row moved up on a browser or headset capture (none was attached; the build's own browser checks stay in the component reports), no competitor was executed, and the five still-closed tickets (`receipts-chain`, `interchange`, `packs-v2`, `agent-surface`, `vendor-min`) keep their §11 blocks as the spec for whoever opens them.

## D. The template ships packs, not a center (2026-10-15)

A walkthrough of the fork lifecycle on 2026-10-09 found the shipped `center/` made forks hard to keep current: pulling upstream conflicted on `center/` (three conflicts without the `merge=ours` driver, two modify/delete conflicts even with it), a fork that ran `init --pack robotics-lab` failed eight engine tests and `npm run check` (the tests and the frozen-center check read the template's own `center/`), `migrate` only printed pack diffs, `data/` had no backup path, and the skill worked only inside a fork. The fix, in one change:

| Was | Now | Proof |
|---|---|---|
| `center/` tracked upstream, frozen at 0.1.0, `center/** merge=ours` | no `center/` upstream; `init` writes it from a pack; the fork commits it; `customer docs` live in `templates/center-docs/` | `test/fork-sim.test.js` (merge with no driver), `scripts/pack-init-check.mjs` |
| `scripts/center-frozen-check.mjs` | `scripts/pack-init-check.mjs` (every shipped pack instantiates in a temp dir; `DOTFIELD_TEMPLATE_REPO=1` refuses a tracked `center/`) | `npm run check` |
| engine tests read the template's `center/` | every test boots its own center (`scaffoldCenter`, `initCenter`); a structural test refuses `ROOT, 'center'` | `test/structure.test.js` |
| `migrate` printed pack diffs | `center/pack-lock.json` + a three-way apply: untouched files updated with a backup, owner edits kept, deletions respected, `--resolved` | `test/migrate.test.js` |
| no backup path | `recipes/backup-and-restore.md`: encrypted `data/` archive, and export → import + approve | `test/backup.test.js` |
| skill per fork only | the same verbs through `npx -y github:jayahn17/dotfield#v<version>` | `test/skill.test.js` |

`findRoot()` also changed: from any ancestor of the engine folder the root is the engine folder whether or not it holds a center, so `init` from a parent repository never writes a `center/` beside the engine. The public repository holds one commit per release, the tree of this folder under the GitHub no-reply address (the son history and personal emails stay private); `AGENTS.md` "Publishing the template" has the commands.

