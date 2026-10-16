# Starter pack

The default pack: `dotfield init` with no `--pack` writes `center/` from it (`scripts/pack-init-check.mjs` proves it instantiates). Two rooms, four desks, one theme. Maturity `local_beta`: the generic proof passes, nobody has validated it against their own data yet.

## Rooms

| Room | Records | Views | Public fields |
|---|---|---|---|
| `notes` | dated notes with tags and links between them | `graph` (force, lift, VR on) · `timeline` | `title`, `tags` |
| `contacts` | people and organisations, their disciplines, who introduced them; handles are HMAC values under `data/keys/handle.salt` | `constellation` (cluster-disc, lift, VR on) · `met` (timeline) | `display_name`, `disciplines` |

`notes` records are born `private`; `contacts` records are born `sensitive`, so a share rule over them needs a redaction operator before the projector emits anything.

## Desks

`scribe` (core, notes) · `planner` (support, notes) · `connector` (core, contacts: who you met, who could introduce whom) · `skeptic` (challenger for all three). The conductor is not here; it comes from `center.config.json`.

## What crosses the boundary

The pack expects to share **note titles and tags** and **contact display names and disciplines**, nothing else, and only under an active share rule the owner approved. `boundary_vocab` is empty: the starter center meets other centers on whatever disciplines the owner adds to `center/people/disciplines.json`.

## A negative case

A rule over `contacts` whose `fields_allowed` lists `handles` is refused with `DF_SHARE_FIELD_NOT_PUBLIC`: `handles` is not in `record.public_fields`, so no projection can carry it, whatever the rule says. A note body never leaves either; `body` is the sublabel field, and a sublabel is emitted only when its source field is public.

## Theme

`theme.json` is the `paper` preset; `init` merges it into `center/brand.json` under the center's name.
