# Build contract — who owns which path, and the conventions every part shares

Read `VISION.md` first (it is the spec; §14 lists the function signatures). This
file exists so that separate builders — human or agent — never edit one file at
the same time and still produce one coherent engine. It stays in the repo
because a one-person maintainer needs the same map later.

## 1. Ownership (one component owns each path; nobody else writes there)

| Component | Owns |
|---|---|
| skeleton | root docs (`README.md`, `AGENTS.md`, `CLAUDE.md`, `GOVERNANCE.md`, `LICENSE`), `skill-release.json`, `engine.manifest.json`, `.mcp.json`, `.claude/`, `scripts/manifest.mjs`, `references/{PROVENANCE,MATURITY}.md`, `center/docs/`, `recipes/`, `test/{structure,skill,no-son-imports,governance,skill-release}.test.js`, `test/helpers/{tmp,cli,scan}.mjs` |
| core-validate | `lib/{validate,rules,digest,receipt,privacy-levels,exit-codes}.mjs`, `lib/rules/*.mjs` (all family files, pre-populated), `schemas/receipt.schema.json`, `scripts/gen-rules-md.mjs`, `references/RULES.md`, `examples/receipt.example.json`, `test/{validate,rules,receipt}.test.js`, `test/fixtures/{jsts,validate}/` |
| tokens-theme | `renderers/tokens.css`, `renderers/font-metrics.json`, `lib/theme.mjs`, `schemas/brand.schema.json`, `scripts/contrast.mjs`, `test/{tokens,theme}.test.js` |
| scene-ir | `schemas/scene.schema.json`, `lib/gates/{schema,topology,privacy}.mjs`, `examples/scene-{graph,room,timeline,workflow}.json`, `references/IR.md`, `test/ir-gates.test.js`, `test/fixtures/ir/` |
| layout | `lib/layout/*.mjs`, `lib/gates/layout.mjs`, `test/layout.test.js`, `test/fixtures/layout-{500,2000}.json` |
| render-2d | `renderers/{shapes.json,svg.mjs,html.mjs}`, `renderers/viewer/*.js`, `lib/gates/render.mjs`, `test/{svg-golden,html-standalone}.test.js`, `test/fixtures/golden/` |
| render-3d-vr | `renderers/{three,xr}.mjs`, `vendor/manifest.json`, `scripts/fetch-vendor.mjs`, `test/{vendor,html-3d}.test.js` |
| rooms-store | `schemas/{room,record-meta,proposal,center-config}.schema.json`, `lib/{rooms,scope,store,proposals}.mjs`, `references/ROOMS.md`, `test/{rooms,scope,store,proposals}.test.js`, `test/fixtures/rooms/` (incl. `center-min/`), `test/helpers/center.mjs` |
| sandbox | `lib/sandbox.mjs`, `test/sandbox.test.js`, `test/fixtures/sandbox/` |
| projector-share | `schemas/{person,circle,share-rule,projection}.schema.json`, `lib/{project,share,overlay,sign,meet}.mjs`, `lib/gates/share.mjs`, `references/SHARING.md`, `examples/{people,share-rule,projection,scene-meet}.example.json`, `test/{project,share,overlay,meet}.test.js` |
| agents-loop | `schemas/{roster,run}.schema.json`, `lib/agents/*.mjs`, `lib/providers/*.mjs`, `examples/{roster,run}.example.json`, `test/{router,loop,roster-sync}.test.js` |
| cli-core | `bin/dotfield.mjs`, `lib/pipeline.mjs`, `lib/context.mjs`, `lib/commands/{validate,render,verify,theme,doctor}.mjs`, `test/cli-core.test.js` |
| cli-full | `lib/commands/{init,prove,add,import,approve,plan,run,share,connect,serve,export,delete,migrate}.mjs`, `lib/migrate.mjs`, `test/{cli,delete,migrate}.test.js` |
| server | `server/{serve,wall}.mjs`, `server/inbox.html`, `test/{server,wall-share-agreement}.test.js` |
| mcp | `mcp/{server,stdio,http}.mjs`, `examples/evaluation.json`, `test/mcp.test.js` |
| packs | `packs/**`, `lib/packs.mjs`, `schemas/pack.schema.json`, `scripts/pack-init-check.mjs`, `test/packs.test.js` (no `center/`: `init` writes it) |
| importers | `importers/*.mjs`, `test/importers.test.js`, `test/fixtures/importers/` |
| release | `.github/workflows/dotfield.yml`, `migrations/`, `scripts/{subtree-check,evidence,demo-two-centers}.*`, `recipes/vr-on-quest.md`, `test/{fork-sim,subtree}.test.js` |

`package.json`, `.gitignore`, `.gitattributes`, `VISION.md` and this file are
owned by the integrator. A component that needs a change outside its paths
writes the request into its report (`notes_for_integration`) instead of editing.

## 2. Shared conventions (the glue)

**Rule catalog.** `lib/rules.mjs` aggregates `lib/rules/<family>.mjs` files
(`schema, struct, receipt, room, record, store, proposal, approve, ir, privacy,
layout, render, share, overlay, run, provider, server, mcp, pack, engine, theme,
import, sandbox`). core-validate creates every family file with every `DF_*`
code named in `VISION.md`. A later component adds a code **only to its own
family file**, shape `{ gate, blocking, message, repair }`. `rules.mjs` exports
`RULES`, `finding(code, {path, detail, status})`, `ABSOLUTE_PATH_RE`.

**Gate modules.** `lib/gates/<g>.mjs` exports `id` and
`check(scene, ctx) → check[]`; one entry per code the gate evaluated
(`status: "pass"`) plus one entry per failure (`status: "fail"`, with `path`,
`message`, `repair`). `ctx = {viewer, rooms, tokensCss, config, sessionKey,
quality, dataDir}`. Gates never throw on bad input; they return findings.

**Checks and receipts.** A check is `{code, gate, blocking, status, path?,
message?, repair?}`. Every command, route and tool returns the receipt envelope
of VISION §8.4 built by `lib/receipt.mjs` `buildReceipt(...)`; exit codes come
from `lib/exit-codes.mjs` `fromReceipt(receipt)`.

**Commands.** `bin/dotfield.mjs` dispatches by file: verb `X` loads
`lib/commands/X.mjs`, which exports `verb`, `leaves` (e.g.
`["share rule","share project","share revoke"]`), `usage`, and
`async run(args, ctx) → receipt`. Adding a verb never edits `bin/`. `args` is
`{_: positionals[], flags: {...}, json, as}`. `ctx` comes from
`lib/context.mjs` `createContext({cwd, env, stdin, stdout})` →
`{root, centerDir, dataDir, dotDir, config, env, isTTY, viewer, now}` where
`now` honours `SOURCE_DATE_EPOCH`.

**Stores.** Only `lib/project.mjs`, `lib/proposals.mjs`,
`lib/commands/{export,delete}.mjs` and tests import `lib/store.mjs`. Reads for
any viewer go through `project.readRecords()`.

**Tests.** `node:test`, zero network, no provider, every test under its own
temp dir from `test/helpers/tmp.mjs` (`withTmp(async dir => …)`), CLI runs via
`test/helpers/cli.mjs` (`runCli(args, {cwd, env, stdin})` → `{code, stdout,
stderr, json}`), a minimal valid center via `test/helpers/center.mjs`
(`scaffoldCenter(dir)` copies `test/fixtures/rooms/center-min/`). A test that
needs `vendor/three/` skips with a named reason when it is absent.

**Scans.** `structure.test.js` scans `bin lib renderers server mcp importers
packs center schemas examples` for: files ≥ 400 lines, raw hex outside
`renderers/tokens.css` (exempt `center/brand.json`, `packs/*/theme.json`,
`*.generated.css`), `fetch(`/`localStorage` under `renderers/`, `.ext` under
`renderers/` and `lib/layout/`, any `proof.command` key, the strings `jay`,
an email, a phone number, and `ABSOLUTE_PATH_RE` (imported from `rules.mjs`;
`lib/rules/privacy.mjs` and `VISION.md` and `references/PROVENANCE.md` are
exempt from that one scan).

**Determinism.** No `Date.now()` in anything that lands in a receipt or an
output; use `ctx.now`. No `Math.random()`; use `lib/layout/rng.mjs`. Canonical
JSON (`lib/digest.mjs canonical`) everywhere a digest is computed.

**Fonts.** The per-font character-width table lives in
`renderers/font-metrics.json` (tokens-theme owns it); `svg.mjs` reads it for
`textLength`. `tokens.css` points at it in a comment.

**Three.js.** Pinned `three@0.180.0`. `vendor/manifest.json` lists the four
files, their jsdelivr URLs and pre-/post-rewrite sha256; `vendor/three/` is
gitignored and filled by `scripts/fetch-vendor.mjs`. CDN mode uses an
importmap with `integrity`; `--embed-three` inlines data-URL modules.

**Never.** No import from `../server`, `../api`, `../mcp` or any path outside
`dotfield/`. No Zod, no A-Frame, no second three. No `approve` tool in MCP, no
`approve` pattern in the skill.

## 3. v2 ownership (2026-10-07)

For the v2 build the ownership table is the `paths` field of each component in
the v2 build plan (recorded in `references/V2_PLAN.md` §0.1 and §11; the
machine-readable plan lived in the build session). Two additions to §1's rule:

- **Sequential ownership.** A file marked "OWNED (sequential after owners
  landed)" may be edited by a later component once every component it depends
  on has finished; the dependency edge is what makes the edit safe.
- **Generated artefacts** (`references/RULES.md`, `engine.manifest.json`,
  `skill-release.json`, `test/fixtures/golden/*.svg`, `test/fixtures/layout-*.json`,
  `examples/scene-*.json` from `test/fixtures/ir/examples.mjs`,
  `packs/*/examples/scene-*.json` from `scripts/relayout-scenes.mjs`, the
  `bench:auto` block) are regenerated by their named command in the commit
  that changes their inputs, never edited by hand. During a parallel build only
  the integrator regenerates `engine.manifest.json` and `skill-release.json`.
