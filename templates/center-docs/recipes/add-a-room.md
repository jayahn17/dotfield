# Recipe — add a room

A room is one folder, `center/rooms/<id>/`, discovered at boot. You never write the four files from scratch.

1. **Scaffold.** From a pack room: `node bin/dotfield.mjs add room papers --from robotics-lab/papers`. Blank: `node bin/dotfield.mjs add room journal --blank` — the receipt names the three fields to fill (`purpose`, `record.label_field`, `record.public_fields`).
2. **Describe one record.** Edit `record.schema.json` (plain JSON Schema, closed). Every field the manifest names (`id_field`, `label_field`, `sublabel_field`, `tag_field`, `weight_field`, `dates.*`, `link_fields[].field`, `public_fields[]`) must exist here or `validate` raises `DF_ROOM_FIELD_MISSING`.
3. **Set the ceiling.** `record.public_fields` is the most that can ever be shared from this room: labels, sublabels and tags included. Leave it short. `default_privacy_level` is `private` unless you have a reason.
4. **Map records to scenes.** `views.json` is declarative: `$.title`, `$.tags[0]`, `$.score/10`, value maps. Give every view a `limit.max_nodes` and, above it, a `default_lens`.
5. **Seed examples.** 3–20 synthetic records in `examples.json`; they must validate (`DF_ROOM_EXAMPLES_INVALID`) and `serve` seeds them when the store is empty. No real names, paths, emails or phone numbers.
6. **Prove.** `node bin/dotfield.mjs validate journal --json` until exit 0, then `prove journal`. Without a `test.mjs` the generic proof lifts the room to `local_beta` at most; claiming `maturity: tested` without a passing `test.mjs` is a blocking `DF_ROOM_MATURITY_OVERCLAIM`.
7. **Optional code, sandboxed.** `test.mjs` (node:test) runs under `dotfield prove` in a child process with read access to its own room folder and the engine's `lib/`, `schemas/` and `renderers/` only (never `data/` or `data/keys/`) and write access to `.dotfield/tmp`; it cannot reach a store. `actions.mjs` (`export const <name> = (records, input) => records[]`) is reserved for a later release: nothing executes it yet.
