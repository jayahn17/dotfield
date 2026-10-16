# Your center

This folder — `center/` — is the only place you edit. Everything in it is JSON checked by a schema, so a mistake is a `DF_*` code with a repair sentence, never a stack trace. Everything outside it (`lib/`, `schemas/`, `renderers/`, `server/`, `mcp/`, `packs/`) is the engine; `dotfield doctor` tells you if a file there changed by accident.

## What is here

| Path | What it is |
|---|---|
| `center.config.json` | the center's name, owner id, provider, server port, approval limits |
| `brand.json` | six fields (accent, surface, ink, fonts, preset) → `dotfield theme` regenerates every colour everywhere |
| `rooms/<id>/` | one folder is one room: `room.json`, `record.schema.json`, `views.json`, `examples.json`, optional `test.mjs` (run by `dotfield prove` in a sandbox that reads only this folder and the engine code); `actions.mjs` is reserved for a later release and is not executed yet |
| `people/` | `people.json` (exactly one `kind: self`), `circles.json`, `share-rules.json`, `disciplines.json` |
| `importers/` | reserved for your own sandboxed importers — **planned**, not read by any command yet; today `import records` takes `.csv`, `.json` or a folder of markdown notes |
| `docs/` | this folder: your prose, your recipes (`docs/recipes/`) |

Your records live in `data/` (never committed, never deleted by tooling except `dotfield delete`); derived output lives in `.dotfield/` (safe to remove at any time).

## The first hour

The walkthrough below is **not yet timed**. When someone who did not write it runs it against the clock, the measured time, the date and the tester's role replace this sentence.

1. `npm install` · `node bin/dotfield.mjs init --pack starter --name "My Center"` — rooms, keys and a passing first receipt.
2. `node bin/dotfield.mjs doctor` — green means Node, the manifest and the keys are in order.
3. `node bin/dotfield.mjs serve` — open the `/inbox?t=…` URL the terminal prints; the seeded rooms are already there.
4. `node bin/dotfield.mjs import records notes <file.csv>` (or a `.json` file, or a folder of markdown notes) → a proposal → read the summary → approve on `/inbox`.
5. Open `claude` in this folder and ask for a plan; it runs `plan` / `run` and stops at `awaiting_owner`. You approve.
6. `node bin/dotfield.mjs connect --between notes,contacts` — the meeting layer across your own rooms.
7. `node bin/dotfield.mjs render room:notes/graph out.html --view all --for <person>` — one HTML file to send.

No source file is opened in those seven steps. Recipes for each are in `docs/recipes/`.

`center/` is yours: commit it in your fork (`data/` and `.dotfield/` stay out of git). After `git pull upstream main`, run `node bin/dotfield.mjs migrate --dry-run` then `migrate`: pack files you never edited move to the shipped version, files you changed are kept. Back up `data/` with `docs/recipes/backup-and-restore.md`; it holds your records and your keys.

## Three rules worth remembering

- **Agents propose, you approve.** Nothing an agent does changes a record until you say so from a terminal or the inbox page.
- **Default is none.** Every record is private with no share rule; `public_fields` in a room manifest is the ceiling on what can ever leave.
- **Receipts are proof.** Every command prints `maturity`, `release_tag` and `evidence.browser`; a render nobody has looked at says `provisional`.
