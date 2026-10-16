# Migrations — how a center survives an engine upgrade

The customer owns `center/`; upstream owns everything else and ships no `center/` at all (`init` writes it from a pack and the fork commits it), so a pull never touches it. Pack files reach a center through `dotfield migrate` and `center/pack-lock.json` instead (files the owner never touched are updated, owner edits are kept). When a release changes the shape of a center document, it ships a migration here, and the owner runs it after `git pull`:

```
git pull upstream main
node bin/dotfield.mjs migrate --dry-run     # prints the patch, writes nothing
node bin/dotfield.mjs migrate               # backs every file up, then rewrites it
node bin/dotfield.mjs validate all
npm test
```

`test/fork-sim.test.js` rehearses exactly this: a synthetic fork commit, an upstream commit touching `lib/` and `schemas/`, a conflict-free merge, `doctor` without `DF_ENGINE_MODIFIED`, `migrate --dry-run` with nothing pending.

## One file per step

`migrations/NNNN-<name>.mjs` — four digits, then a lower-case kebab name (`lib/migrate.mjs MIGRATION_RE`). Each file exports exactly this:

| Export | Meaning |
|---|---|
| `from` | the `schema_version` a document must carry for this step to apply |
| `to` | the `schema_version` the step writes |
| `kind` | which center documents it reads: `center-config` (`center/center.config.json`), `brand` (`center/brand.json`), `room` (every `center/rooms/<id>/room.json`), `people` (`center/people/people.json`) |
| `migrate(doc)` | a pure function: a document in, a document out; no clock, no I/O, never mutate the input (`structuredClone` first) |

`lib/migrate.mjs` chains steps per file by `schema_version` (`from` of the next equals `to` of the previous, up to 32 steps), validates the result against the shipped schema whenever that schema pins the target version, backs the original up under `.dotfield/migrate-<stamp>/<same relative path>` and rewrites atomically. A result that fails its schema is refused and reported as `DF_ENGINE_MIGRATION_PENDING`; nothing is written for that file.

## Two rules that are easy to get wrong

1. **A migration moves `schema_version`.** `dotfield doctor` and `lib/migrate.mjs` agree that a step is pending when `doc.schema_version === from`. A step with `from === to` would therefore be pending forever on every center, so a same-version rewrite is not expressible: bump the version, even for a rename.
2. **Ship the schema with the bump.** If `to` is a version the shipped schema does not pin (`const` / `enum` on `schema_version`), the result is accepted by shape only; a real bump changes the schema's `const` in the same release, or `migrate` refuses to write.

## What ships today

| File | Applies to | Does |
|---|---|---|
| `0001-center-config-v1.mjs` | `dotfield.center-config/0` → `/1` | the scaffold: fills the eight blocks `init` writes (`installed_packs`, `provider`, `server`, `privacy`, `connect`, `approval`, `store`, `conductor`) where a pre-release config lacked them |
| `0002-room-mode-write-after-approval.mjs` | `dotfield.room/0` → `/1` | aliases `mode: "write_after_approval"` to `proposal_only` |

A center created by `dotfield init` 0.1.0 is already at `/1` everywhere, so neither applies to it; both exist as the executable pattern and are exercised by `test/fork-sim.test.js` (a `/0` document migrates, validates and is no longer pending).

## Writing the next one

Copy `0001-center-config-v1.mjs`, give it the next number, set `from`/`to`/`kind`, write `migrate(doc)`, bump the schema's `schema_version` pin in `schemas/<kind>.schema.json`, add a round-trip case to `test/migrate.test.js` (dry run writes nothing; apply backs up the original bytes; a second run has nothing pending), run `npm run manifest` so `engine.manifest.json` lists the new file, and note the bump in `references/MATURITY.md`.
