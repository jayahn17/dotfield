# PROVENANCE — what Dotfield ports from son, by path

Son commit at the time of the port: `279a262e6d5bf08898d951b80e62f6117dada943` (2026-09-29). Paths on the son side are relative to the son repository root; Dotfield imports none of them — every port is a copy with the names changed, so `git subtree split -P dotfield` produces a working repo. A one-person maintainer diffs the two sides with the paths below.

Status column: **ported** = the Dotfield file exists and carries the code; **planned** = the son source is identified and the Dotfield side is owned by the named component (BUILD_CONTRACT §1) and lands with it. This table is updated by each component as it ships.

| Dotfield path | son path (commit above) | What is carried over | Changes | Status |
|---|---|---|---|---|
| `AGENTS.md` "Proof-closed work guardrail" | `AGENTS.md` § Proof-Closed Work Guardrail | the four general bullets, verbatim | the Son–Clawd bridge bullet is dropped (no second system in a fork) | ported (skeleton) |
| `test/helpers/cli.mjs` | `server/test/helpers/boot-index.js` | spawn-the-real-entry test pattern | spawnSync on `bin/dotfield.mjs`, no port boot | ported (skeleton) |
| `lib/agents/loop.mjs` cross-field mandate | `server/agents.js:14-35` `crossDomainInstruction()` | "one concrete structural analogy … name that boundary" injected into every desk prompt | boundary named from the meet scene, not a fixed lens | ported (agents-loop) |
| `mcp/server.mjs` annotations | `mcp/server.js:54-56` `READ_LOCAL`, `INVOKE` | the two annotation sets | `READ_HTTP` not carried (no outbound tool) | ported (mcp) |
| `server/wall.mjs` | `server/basic-wall.js` `isLocalRequest()` (loopback **and** no `X-Forwarded-For`), fail-closed stance | the local test and the refusal of private families for non-local requests | families become privacy levels from `lib/privacy-levels.mjs`; env flag `DOTFIELD_TRUSTED_PROXY_WALL` | ported (server) |
| `lib/scope.mjs` | `api/_lib/durable-store.cjs` `scopeFor()` and `api/_lib/user-scope.cjs` `resolveScope()` (durable-store.cjs only requires it) | the three-state rule: owner container, `person_<id>`, refuse-never-the-owner's-data | sessions replaced by `--as`; `multi_person` not carried | ported (rooms-store) |
| `lib/store.mjs` | `api/_lib/store.cjs` `atomicWriteRaw()` / `writeJson()`; `api/_lib/durable-store.cjs` typed `{status: 503, storage: true}` fault | tmp + fsync + rename, `.bak`, the typed storage fault | one backend (file) plus an optional object-store URL from config | ported (rooms-store) |
| `DF_ROOM_NAMESPACE_SHARED`, `DF_STORE_ENV_PIN_IGNORED` | `server/test/durable-store-coverage.test.js` | "two handlers over one file must declare one namespace"; "a fileEnv pin must move the store path" | rules instead of a coverage test | ported (rooms-store / core-validate) |
| `lib/receipt.mjs` | `src/son/clawd_bridge.py` `build_redacted_receipt_handshake()`; `api/packet.js:62-73` 202 envelope | logical refs + digests + one reversible next action; `status: proposal_only`, `next_required_step` | one envelope for CLI, HTTP and MCP; deterministic ids under `SOURCE_DATE_EPOCH` | ported (core-validate) |
| `lib/providers/relay.mjs` | `server/relay.js` `relayAsk()`, `relayStatus()` | the file-queue adapter (pending/done dirs, heartbeat, stale check) | `ask({system, prompt, maxTokens, signal})` signature; no streaming | ported (agents-loop) |
| `lib/overlay.mjs` | `server/test/graph-overlays.test.js` cases | namespaced ids, an overlay never overwrites a local node, undeclared groups rejected, dangling links dropped and listed | signature + receiver check + expiry added | ported (projector-share) |
| `renderers/tokens.css` | `docs/visuals/digital-twin-control-room.css` `--lt-*` layer | ink / bg / panel / line / muted / accent / series / type scale / space / radius / focus ring / tap-min | renamed `--df-*`; four data-room themes and the contrast ledger added | ported (tokens-theme) |
| `packs/*/disciplines.json` | `server/routes/graph.js` `DISCIPLINES` | the discipline keyword patterns | hard-coded regex becomes pack-owned data `[{label, patterns[], weight, source}]` | ported (packs) |
| `schemas/room.schema.json` `owner_gates`, `maturity` | `docs/cloud/lifetwin_agent_ontology_contract.json`; son `VISION.md` §7 | `owner_gates{writes, external_sends, share, aggregate, train}`; the maturity ladder | `write_after_approval` removed with a migration | ported (rooms-store) |
| `importers/son-graph.mjs`, `importers/spatial-asset-scene.mjs` | a saved `/api/graph` response; `docs/visuals/data/spatial-asset-scene.json` shape | the two JSON shapes, read from a file | never imports son; fixtures are synthetic copies under `test/fixtures/importers/` | ported (importers) |

## What is deliberately not ported

- No son surface, route, contract or dashboard. Two importers are the whole bridge.
- No `jay*` name, path, email or phone appears anywhere under the scanned folders; `test/structure.test.js` holds that.
- Son's Zod schemas (`schema/index.js`) are not carried: Dotfield's validator is hand-written and proven by the official JSON-Schema-Test-Suite.
