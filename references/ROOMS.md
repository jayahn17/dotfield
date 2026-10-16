# Rooms, stores, scope and the approval hop

The reference for `lib/rooms.mjs`, `lib/scope.mjs`, `lib/store.mjs`, `lib/proposals.mjs` and the four schemas `room`, `record-meta`, `proposal`, `center-config` (VISION §2.2, §2.7, §2.8, §5, §8.5, §9). Every rule code named here is defined once in `lib/rules/<family>.mjs` and documented in `RULES.md`.

## 1. One folder is one room

`center/rooms/<id>/` is discovered at boot by `discoverRooms(centerDir, {dotDir})`. The folder name is the room id (`^[a-z0-9][a-z0-9_-]{0,39}$`); `room.json` must carry the same `id` (`DF_ROOM_ID_MISMATCH`), so two rooms can never share an id. Four files are required (`DF_ROOM_FILE_MISSING`, also raised when one is not valid JSON):

| File | Checked by | Code on failure |
|---|---|---|
| `room.json` | `schemas/room.schema.json` (closed except `ext`) | `DF_SCHEMA_*`, `DF_ROOM_*` |
| `record.schema.json` | `schemas/record-meta.schema.json` — one closed object schema inside the validator subset; nesting is field → item → scalar | `DF_SCHEMA_*` with paths `record.schema.json#$…` |
| `views.json` | `room.schema.json#/$defs/views_file` plus the semantic rules of §4 | `DF_ROOM_VIEW_INVALID` |
| `examples.json` | 3–20 records, each valid for `record.schema.json` | `DF_ROOM_EXAMPLES_INVALID` |

Optional: `test.mjs` (required for `maturity: tested`, else `DF_ROOM_MATURITY_OVERCLAIM`), run by `prove` through `lib/sandbox.mjs` with reads limited to the room folder and the engine's `lib/`, `schemas/`, `renderers/` (never the fork root, so `data/keys/` is unreadable: `DF_SANDBOX_READ_DENIED`); `actions.mjs` is discovered (`files.actions`) but reserved — no verb executes it in 0.1.0 (`references/MATURITY.md`).

**Manifest rules beyond the schema.** Every field the manifest names must exist in `record.schema.json` `properties`: `id_field`, `label_field`, `sublabel_field`, `tag_field`, `weight_field`, every `dates.*`, every `link_fields[].field` and every `public_fields[]` entry (`DF_ROOM_FIELD_MISSING`, one finding per field, path `room.json#$.record.…`). `link_fields[].to_room` must be a room of the center (`DF_ROOM_LINK_ROOM_UNKNOWN`, non-blocking: the link is kept and dropped at render). Two rooms may not declare the same `store.namespace` (`DF_ROOM_NAMESPACE_SHARED`, both rooms flagged). A `proof.command` key is `DF_ROOM_PROOF_COMMAND_FORBIDDEN` (proof is `{test, expected[]}`). `mode: write_after_approval` is removed: discovery reports `DF_ROOM_MODE_DEPRECATED` (non-blocking) and reads it as `proposal_only`; `dotfield migrate` rewrites it.

**Modes and gates.** `mode` ∈ `read_only` (propose refused, 403 / `DF_PROPOSAL_MODE_REFUSED`) · `proposal_only` (proposals allowed, approve writes) · `blocked` (everything refused). `owner_gates.writes` and `owner_gates.share` admit only `"required"`: there is no mode without the owner gate, by schema rather than by a check. `external_sends`, `aggregate` and `train` are `required | blocked`; the projector refuses a share rule that sets `aggregate` or `train` in v1 whatever the gate says.

**Defaults filled by `normalizeManifest`.** `store.max_records` 2000, `store.max_record_bytes` 16384, `record.dates` `{}`, `record.link_fields` `[]`, `icon` `"room"`, `pack` `null`, desk arrays `[]`, desk `prompt` `null`.

**Maturity and the prove record.** `maturity` is required (`contract_only | prototype | local_beta | tested`). `dotfield prove <room>` writes `.dotfield/prove/<room>.json`:

```json
{ "schema_version": "dotfield.prove/1", "room": "notes", "ok": true, "maturity_reached": "local_beta",
  "manifest_digest": "sha256:…", "proved_at": "2026-10-01T10:15:00Z", "receipt_ref": ".dotfield/receipts/rcpt_….json" }
```

`manifest_digest` is `sha256` of the bytes of `room.json` at prove time. Discovery compares it, not mtimes: no record → `DF_ROOM_MATURITY_UNPROVEN` (non-blocking); a record for a different digest → the same code, non-blocking ("predates this room.json"); a record for this exact digest with `ok: false` → the same code **blocking** (the check's `blocking` flag is flipped, the catalog entry stays non-blocking); `ok: true` → pass.

## 2. The registry

`buildRegistry(rooms, config)` is pure: `{schema_version: "dotfield.registry/1", center: {name, owner_person_id}, rooms: [...], invalid: [{id, codes[]}], digest}` with one entry per **valid** room (id, label, icon, pack, purpose, mode, privacy_mode, maturity, store, record, owner_gates, blocked_actions, proof, `views: [{id, label, kind}]`, `desks: [{id, display, tier}]`, `files: {test, actions}`, `prove`, `manifest_digest`), sorted by id, no timestamp. `validate all` writes it with `writeRegistry(registry, dotDir)`; the server, the CLI and the MCP server serve exactly that set.

## 3. Records in a room

A record is one object valid for `record.schema.json`. `checkRecords(room, records)` (in `lib/proposals.mjs`, shared by `import records` and `propose`) raises per row: `DF_RECORD_SCHEMA_INVALID` (with the `DF_SCHEMA_*` findings beside it, paths `$[i].field`), `DF_RECORD_ID_MISSING` (no value for `id_field`), `DF_RECORD_DUP_ID` (within one batch), `DF_RECORD_TOO_LARGE` (`canonical` bytes > `store.max_record_bytes`), `DF_RECORD_DATE_INVALID` (a `dates.*` field that is not `YYYY-MM-DD`). Column mapping codes (`UNKNOWN_COLUMN`, `MAP_FIELD_UNKNOWN`, `EXT_MOVED`) belong to the importers; `LINK_UNRESOLVED` to the projector, which can see the other rooms.

## 4. views.json — the declarative bridge

An array of 1–12 views, each `{id, label, kind: graph|room|timeline|board|workflow, theme?, node, date?, lane?, pose?, include_rooms?, group_by?, limit?, views?, lenses?}`. `node` is `{kind, label, sublabel?, tags?, weight?, color_token?, color_token_by?: {field, map}}`; `map` is the one open map in a views file (value → colour token). Field references use the **JSONPath subset** `parsePath` / `evalPath` implement — and nothing else:

| Form | Meaning |
|---|---|
| `$.a` · `$.a.b` (≤ 6 segments) | property path |
| `$.a[0]` | one array element |
| `$.a[*]` | every element (yields an array; later segments map over it) |
| `…/n` | divide a numeric result by `n` (positive integer) |

Semantic rules (`DF_ROOM_VIEW_INVALID`): view ids unique; `timeline` needs `date`; `board` needs `lane`; the root field of every expression must be declared in `record.schema.json`; `limit.default_lens` must name one of `lenses[]`. `include_rooms` naming a room outside the center is `DF_ROOM_LINK_ROOM_UNKNOWN` (non-blocking).

**The size rule.** A view over a room larger than `limit.max_nodes` must declare a `default_lens`, or the projector renders the focus/reach subgraph with `projected.dropped` set. A view never refuses to render for size.

## 5. The scope rule (`lib/scope.mjs`)

Son's three-state rule as internal code; there is no `multi_person` flag and no person sessions in v1.

| Request | Result |
|---|---|
| local, no `--as` / `--as self` / `--as <owner id>` | `scope: owner`, `viewer: self`, container `data/` |
| local, `--as <id>` | `person_<id>` after sanitising (lower-case, `[a-z0-9_.:-]` only, no leading punctuation, ≤ 80), container `data/person_<id>/` |
| local, `--as public` | the public viewer; no store |
| `--as` empty after sanitising | `DF_STORE_SCOPE_EMPTY_UID` (400) |
| non-local, no session | `DF_STORE_SCOPE_REFUSED` (401) — never the owner container |
| non-local with `session.person_id` | `person_<id>`; `--as` is ignored; a session claiming the owner is refused |

`resolveScope({config, as, session, origin}) → {ok, scope, viewer, container, owner, status, code, checks}`.

## 6. The store (`lib/store.mjs`)

`createStore({room, dataDir, scope, config, env, backend?, root?, fetch?})` opens one room store. Only `lib/project.mjs`, `lib/proposals.mjs`, `lib/commands/{export,delete}.mjs` and tests import it (`test/structure.test.js`).

- **Path.** Owner-scoped rooms: `data/rooms/<namespace>.json` whoever views them (viewer scoping is the projector's job; a non-owner scope cannot write them: `DF_STORE_SCOPE_REFUSED` 403). Person-scoped rooms (`store.scope: person`): `data/<container>/rooms/<namespace>.json`. A `public` or refused scope opens nothing (throws `DF_STORE_SCOPE_REFUSED`).
- **Envelope.** `{schema_version: "dotfield.store/1", room, namespace, scope, written_at, written_by, count, digest, records[]}`; a bare array is accepted on read.
- **Atomic writes.** `tmp` + `fsync` + `rename`; the previous file is copied to `<file>.bak` first; a failed write leaves no tmp file. `write(records, {approved: true, now, by})` — anything but `approved: true` throws `DF_STORE_WRITE_WITHOUT_APPROVAL` (403); only `proposals.decide()` and `dotfield delete` pass it.
- **Limits.** `DF_STORE_MAX_RECORDS` and `DF_STORE_MAX_BYTES` (422) are checked before any byte is written; `checkLimits(records)` returns them as findings.
- **Faults.** Disk or bucket errors throw `StoreError` with `status: 503`, `storage: true`, `code: DF_STORE_FAULT` (`DF_STORE_CORRUPT` for a file that is not a records envelope; restore the `.bak`). `error.check` is the finding to put in the receipt; `fromReceipt` maps it to exit 4.
- **Env pin.** `DOTFIELD_STORE_<ROOM>_FILE` moves the store **path** (not only the backend) but is honoured only under `NODE_TEST_CONTEXT` or `config.store.allow_env_pins: true`; otherwise `store.checks` carries `DF_STORE_ENV_PIN_IGNORED` (non-blocking) and the path stays.
- **Backends.** `file` (default) · `object` when `config.store.object_store_url` is set — `GET`/`PUT <url>/<container>/rooms/<namespace>.json` through the injected `fetch` (404 reads empty, any other failure is a 503 fault) · `memory` (tests, dry runs). `store.target()` is the receipt's `store` field: `{target, backend}` with `target` relative to the root when inside it.

## 7. Proposals (`lib/proposals.mjs`)

**Lifecycle.** `draft → awaiting_owner → approved | edited | rejected`. `propose()` writes `data/proposals/<id>.json` in `awaiting_owner` and nothing else — `test/proposals.test.js` asserts the store file does not exist between propose and approve. Only `decide()` leaves `awaiting_owner`; it is reached by `dotfield approve` (TTY or owner token), the inbox decide route, and `dotfield serve` itself on start, which seeds every empty file store of a synthetic (`privacy_mode` not `private_live`), `proposal_only` room from its `examples.json` as a proposal `by: serve:seed` that the same serve approves on the spot (`decision: approve`, note `seeded from examples.json by dotfield serve on an empty store`; receipted like any decision; `--no-seed` skips it). There is no environment flag that turns proposals into writes and no MCP tool reaches `decide`.

**Id.** `prop_<YYYYMMDDTHHMMSSZ>_<6 hex of sha256(canonical({room, by, scope, kind, index, records}))>` — same clock and content, same id. Because of that, `propose()` checks the file before writing: an id already on disk and still `awaiting_owner` is reused untouched (the receipt says so, no output `action`); one already decided is final and the call is refused with `DF_PROPOSAL_ALREADY_DECIDED` (exit 3) — a repeat of a proposal never erases its decision (`test/proposals.test.js`).

**Summary.** `summarize({room, records, existing, foreignSpans, blockedActions})` → `{adds, changes, unchanged, fields_touched[], sample_rows[≤5], foreign_spans[], blocked_actions[]}`, compared by `id_field` against the records already in the store (long values clipped at 200 chars in the sample). `summary_digest = sha256(canonical(summary))` is what the inbox shows before the buttons enable; `decide` requires `reviewedDigest` to equal it for `approve` and `edit` (`DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH`, exit 3) and stores it as `owner_decision.reviewed_summary_digest`.

**Split.** Above `config.approval.max_records_per_proposal` (default 200) the batch becomes several proposals sharing `split.batch_id`, with `DF_PROPOSAL_SPLIT` (non-blocking) in the receipt.

**decide(id, {decision, note, edited, reviewedDigest, now, dataDir, dotDir, rooms, config, env, argv, root, by})**
- `approve` / `edit`: read the store, merge by `id_field` (existing rows replaced, new ones appended, order kept), `store.write(..., {approved: true})`, then write the decided proposal and the receipt (`.dotfield/receipts/<receipt_id>.json`, named in `proposal.receipt_ref`). `edit` replaces the records with `edited` after `checkRecords` (`DF_PROPOSAL_EDIT_FILE_INVALID`).
- `reject`: writes only the proposal.
- A repeated identical decision is **idempotent** (`idempotent: true`, nothing written, receipt `approved`/`rejected`); a different second decision is `DF_PROPOSAL_ALREADY_DECIDED` (exit 3) and changes nothing.
- A storage fault leaves the proposal in `awaiting_owner` and exits 4; a limit breach exits 2.
- Kinds `rule` and `pair` record the decision only (`applied: false`); `lib/share.mjs` and `lib/meet.mjs` apply the effect when the proposal reads `approved`.

Receipts: `propose` → status `proposal` (exit 3, `owner_decision.state: awaiting_owner`: the proposal waits for the owner; over HTTP the propose route still answers 202); `decide` → `approved` / `rejected` / `refused` / `blocked` with `fromReceipt` deciding the exit from the failing blocking check.

## 8. center.config.json

`schemas/center-config.schema.json` (closed except `ext`): `center{name, tagline?, owner_person_id, locale?}`, `installed_packs[{id, version, digest}]`, `provider{adapter, model?, max_tokens_per_run, allow_nested}`, `server{port, host}`, `privacy{default_privacy_level}`, `connect{threshold}`, `approval{max_records_per_proposal}`, `store{allow_env_pins, object_store_url}`, `conductor{display, lens}`. `multi_person` is an unknown field. `loadConfig(centerDir)` returns `{ok, config, checks}`; an absent file is a `DF_SCHEMA_REQUIRED` finding, never a throw.

## 9. Booting a center in a test

`test/helpers/center.mjs`: `scaffoldCenter(dir)` copies `test/fixtures/rooms/center-min/` (config, brand, one `kind: self` person, the `notes` room) into `<dir>/center/` and creates `data/` and `.dotfield/`; `cloneRoom`, `patchJson`, `readJson`, `writeJson`, `NOW` (2026-10-01T10:15:00Z) and `EPOCH_ENV` are there for every later component.

## 10. The room manifest — `schemas/room.schema.json` (VISION §5)

> Moved verbatim from VISION §5 on 2026-10-07, with one token changed: the example's `"$schema"` value is written as `"schemas/room.schema.json"`; in the file itself it climbs three directories (`center/rooms/<id>/` → the fork root), a form the subtree scan would read as a path leaving the folder when it appears here.

A room is one folder `center/rooms/<id>/` discovered at boot. Four files are required and a customer writes none of them from scratch: `dotfield add room <id> --from <pack>/<room>` copies and renames; `--blank` writes a valid minimal set and names the three fields to fill.

| File | Role |
|---|---|
| `room.json` | the manifest below |
| `record.schema.json` | plain JSON Schema for ONE record (closed; `schemas/record-meta.schema.json` checks it names every field the manifest uses: `DF_ROOM_FIELD_MISSING`) |
| `views.json` | declarative record → scene mappings (no code) |
| `examples.json` | 3–20 synthetic records that must validate (`DF_ROOM_EXAMPLES_INVALID`); `serve` seeds them when the store is empty |
| `test.mjs` (optional) | `node:test`, run by `lib/sandbox.mjs` in a child process; required for `maturity: tested` |
| `actions.mjs` (optional, **planned**) | reserved for `export const <name> = (records, input) => records[]` run in the sandbox (records over stdin, proposal records over stdout, no store handle); discovery records its presence (`files.actions`) and no verb executes it in 0.1.0 (§13) |

**Worked example** — `center/rooms/experiments/room.json` (robotics-lab pack):

```json
{
  "$schema": "schemas/room.schema.json",
  "schema_version": "dotfield.room/1",
  "id": "experiments",
  "label": "Experiments",
  "icon": "flask",
  "pack": "robotics-lab",
  "purpose": "Every run of a robot against a dataset, the metric it produced, and the paper it tests.",
  "mode": "proposal_only",
  "privacy_mode": "private_live",
  "maturity": "local_beta",
  "store": { "scope": "owner", "namespace": "experiments", "max_records": 2000, "max_record_bytes": 16384 },
  "record": {
    "schema": "record.schema.json",
    "id_field": "exp_id",
    "label_field": "title",
    "sublabel_field": "metric",
    "tag_field": "tags",
    "weight_field": "score",
    "dates": { "happened_on": "run_on", "remembered_on": "logged_on" },
    "link_fields": [
      { "field": "robot_id",   "to_room": "robots",   "kind": "depends" },
      { "field": "dataset_id", "to_room": "datasets", "kind": "depends" },
      { "field": "paper_ids",  "to_room": "papers",   "kind": "cites" }
    ],
    "default_privacy_level": "private",
    "public_fields": ["title", "metric", "value", "run_on", "tags"]
  },
  "views": "views.json",
  "desks": [
    { "id": "method-review", "display": "Method review", "tier": "core", "domain": "experimental robotics",
      "primary_field": "robot evaluation", "adjacent_fields": ["statistics", "metrology"],
      "lens": "an experiment is a measurement with an error budget, not a demo",
      "keywords": ["experiment", "metric", "ATE", "benchmark", "ablation"],
      "challenger_for": ["sim-ops"], "influences": ["data-ops"],
      "constraint": "never reports a number without a record id as evidence", "prompt": null }
  ],
  "owner_gates": { "writes": "required", "external_sends": "blocked", "share": "required", "aggregate": "blocked", "train": "blocked" },
  "blocked_actions": ["launch_hardware", "start_simulator", "upload_dataset"],
  "proof": { "test": true,
             "expected": ["examples.json validates", "graph view emits one node per record and one edge per link field", "a proposal never changes data/rooms/experiments.json"] },
  "done_definition": "Done as local_beta when `dotfield prove experiments` exits 0 and every view in views.json renders with no DF_IR_* or DF_LAYOUT_* failure."
}
```

`views.json` for the same room — the declarative bridge, a tiny JSONPath subset (`$.a.b`, `$.a[*]`, `$.a[0]`, value maps, `/n` arithmetic), extended only with a test per operator:

```json
[
  { "id": "graph", "label": "Method web", "kind": "graph", "theme": "studio",
    "node": { "kind": "record", "label": "$.title", "sublabel": "$.metric", "tags": "$.tags", "weight": "$.score/10",
              "color_token_by": { "field": "$.status", "map": { "done": "series-2", "running": "accent", "failed": "warn" } } },
    "include_rooms": ["papers", "robots"],
    "group_by": { "field": "$.tags[0]", "kind": "discipline" },
    "limit": { "max_nodes": 600, "default_lens": null },
    "views": { "2d": { "layout": "cluster-disc", "seed": 7 }, "3d": { "scale_m": 6, "lift": { "mode": "group-weight", "amplitude_m": 1.5 } }, "vr": { "enabled": true, "scale_m": 4 } },
    "lenses": [ { "id": "failed", "label": "Failed runs", "match": { "tags": ["failed"] } } ] },
  { "id": "timeline", "label": "Run history", "kind": "timeline", "date": "$.run_on",
    "node": { "kind": "event", "label": "$.title", "sublabel": "$.value" },
    "views": { "2d": { "layout": "timeline" }, "3d": { "layout": "tier-wall", "scale_m": 5 }, "vr": { "enabled": false } } }
]
```

Semantics carried from son and now defined: `mode` ∈ `read_only` (propose refused, 403) | `proposal_only` (proposals allowed, approve writes) | `blocked` (everything refused); `write_after_approval` is removed with a deprecation migration. `owner_gates` from `lifetwin_agent_ontology_contract.json`; `maturity` from son `VISION.md §7`; `proof.test` + `expected[]` + `done_definition` from the secretary contract (no shell strings: `structure.test.js` fails any `proof.command` key); store rules from `durable-store-coverage.test.js` (two rooms may not share a namespace: `DF_ROOM_NAMESPACE_SHARED`). `ROOMS.md` states the size rule: a view over a room larger than `limit.max_nodes` must declare a `default_lens` or it renders the focus/reach subgraph with `projected.dropped` set, never refuses.

What the customer gets with zero code: a store at `data/rooms/<id>.json` (atomic writes, `.bak`, typed 503 faults); `GET /api/rooms/<id>/records` (viewer-scoped, `public_fields` only unless self); `POST /api/rooms/<id>/propose` (202, writes a proposal file only); `GET /api/rooms/<id>/scene?view=graph&for=self`; `render room:<id>/<view>`; the room's desks in the roster and router; `prove <id>` (to `local_beta`); `export`/`delete` over its records; and inclusion in `.dotfield/registry.json`.

## 11. Profession packs — `schemas/pack.schema.json` (VISION §6)

> Moved verbatim from `VISION.md` §6 on 2026-10-07 (V2_PLAN §8 cleanup); VISION keeps a pointer under the same section number.

A pack is `packs/<id>/` with no code — JSON plus one `README.md` per pack and robotics-lab's `examples/runs.csv` (`packs.test.js` fails on any `.mjs`/`.js` inside a pack): `pack.json` `{schema_version, id, label, profession, summary, version, maturity, rooms[], roster: "roster.json", disciplines: "disciplines.json", theme: "theme.json", boundary_vocab[], share_defaults{privacy_level, redaction_operators[]}, views_off[], regulatory_notes[], recipes[]}`, one folder per room template, `roster.json` (the conductor is never in a pack), `disciplines.json` (`[{label, patterns[], weight, source}]`, replacing son's hard-coded `DISCIPLINES` regex with data the pack owns), `theme.json` (a `brand.json` preset), `examples/` scenes and, for robotics-lab, `examples/runs.csv` that maps cleanly. `dotfield init --pack <id>` instantiates rooms into `center/rooms/`, writes `center/people/disciplines.json`, merges the theme into `brand.json`, records `installed_packs[{id, version, digest}]` in `center.config.json` (there is no `center/packs/` copy), and runs `prove all` then `validate all` so the first thing a customer sees is a passing receipt. `migrate --dry-run` diffs `packs/<id>/rooms/<r>/` against `center/rooms/<r>/` and prints a patch; it never applies it. Packs never patch `lib/`; a pack from a URL is refused; a pack under `packs/draft/` is validated by tests but refused by `init` with `DF_PACK_DRAFT`.

| # | Pack | Rooms | Views | Desks (challenger in bold) | Share and safety | v1 status |
|---|---|---|---|---|---|---|
| 1 | **starter** (default in a fresh fork) | `notes` (title, body, tags, links[], happened_on), `contacts` (display_name, org, disciplines[], handles (HMAC with `data/keys/handle.salt`, never exported), met_on, introduced_by) | notes graph (2d force, 3d lift, vr on), contacts constellation, notes timeline | scribe, planner, connector, **skeptic** | notes private, contacts sensitive; `public_fields` = title/tags and display_name/disciplines; `boundary_vocab: []` | shipped, local_beta |
| 2 | **robotics-lab** (the owner validates this one from their own data) | `robots` (platform, sensors[], urdf_ref, pose_m, size_m), `experiments` (above), `datasets` (modality, size_gb, license, path digest), `papers` (citation, doi, method, tags, influences[]) | rig room (metric 3d/vr from pose_m; regions = benches), experiments method web, papers influence graph, run timeline | sim-ops, method-review, data-ops, **safety** | `blocked_actions: launch_hardware, start_simulator, upload_dataset`; importers son-graph, spatial-asset-scene, csv; `boundary_vocab: sensor-fusion, estop, vibration, inspection, calibration`; `connect --between experiments,papers` is the shipped solo meeting demo | shipped, local_beta |
| 3 | **research-lab** | `papers`, `experiments`, `datasets`, `collaborators` (person) | citation web, influence graph, experiment timeline, collaborator constellation | lit-review, data-desk, grants, **methods** | ships the two-center demo: two sample projections + two scratch-center configs under `examples/` so `connect --with` and `scripts/demo-two-centers.sh` run without a second human; `boundary_vocab: longitudinal-study, sensor, vibration, fatigue` | shipped, contract_only |
| 4 | **law-practice** (`packs/draft/`) | `matters` (title, client_ref, practice_area, status, opened_on, closed_on, deadlines[], authority_ids[], related[]), `clients` (person/org, conflict_tags[]), `deadlines`, `authorities` (citation, court, year, holding, tags) | matter board, matter graph, deadline wall, authority citation web | intake, docket, researcher, **conflicts** | clients sensitive (mask operator required before any projection); `public_fields` = practice_area/status only — the matter title is the client and stays out; `blocked_actions: send_email, file_with_court`; every desk `constraint: "research only, not licensed legal advice"`; `views_off: ["vr"]`; README states what moves it out of draft: one practitioner's review, an at-rest encryption story, a documented retention/delete sweep | draft, refused by `init` |
| 5 | **clinic** (`packs/draft/`) | `protocols` (shareable library), `cases` (synthetic ids only), `literature`, `followups` | protocol→outcome graph, case timeline, literature web, followup board | evidence, audit, triage-support (never a diagnosis), **safety-review** | cases sensitive with `redact`; `aggregate`/`train` blocked regardless of mode; `public_fields` on `cases` is `[]`; `regulatory_notes`: "not a medical record system"; `views_off: ["vr"]`; same three draft-exit conditions as law-practice | draft, refused by `init` |

Every pack's `examples/` scenes are `synthetic_data` and must finalize in CI; a pack with a `jay`, an email, a phone pattern or an absolute home path fails `test/structure.test.js`.
