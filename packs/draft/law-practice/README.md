# Law practice pack (draft)

Matters, clients, deadlines and authorities for a small practice. **Draft**: `dotfield init --pack law-practice` is refused with `DF_PACK_DRAFT`; the pack is validated and rendered by `test/packs.test.js` like any other so that leaving draft is a move, not a rewrite.

## Rooms

| Room | Records | Views | Public fields |
|---|---|---|---|
| `matters` | title (the client; stays private), client reference, practice area, status, dates, deadlines, authorities, related matters | `board` (lanes by status) · `graph` (includes authorities and deadlines) | `practice_area`, `status` |
| `clients` | people and organisations with conflict tags; `sensitive` | `roster` | none |
| `deadlines` | filings, hearings, responses, internal reviews with the rule that produced each date | `wall` (timeline) | `kind`, `status` |
| `authorities` | citation, court, year, holding, what it cites | `citations` | `citation`, `court`, `year`, `holding`, `tags` |

`views_off: ["vr"]`: every view sets `vr.enabled: false`. Every room blocks `send_email` and `file_with_court`.

## Desks

`intake` (core, matters) · `docket` (support, deadlines) · `researcher` (core, authorities) · `conflicts` (challenger for intake and researcher, clients). Every desk carries the constraint `research only, not licensed legal advice`.

## What crosses the boundary

The pack expects to meet accountants, compliance officers and other practices on `contract`, `liability`, `compliance` and `evidence`. Under an active rule a matter projects as a stub (`matters · <6 hex>`) with `practice_area` and `status`; authorities project in full because they are public law.

## A negative case

A rule over `clients` is refused before it emits anything: `clients` records are `sensitive`, so `DF_SHARE_SENSITIVE_WITHOUT_OPERATORS` applies without the `mask` operator, and with it the projector still emits only stubs because `public_fields` is empty. A rule over `matters` with `fields_allowed: ["title"]` is refused with `DF_SHARE_FIELD_NOT_PUBLIC`: the title names the client.

## Leaving draft

The pack moves from `packs/draft/` to `packs/` when all three exist, each recorded as a receipt or a document in `references/MATURITY.md`:

1. **One practitioner's review**: a practising lawyer has read every room, desk constraint and regulatory note and signed off that nothing here presents itself as legal advice or as a docket of record.
2. **An at-rest encryption story**: `data/rooms/clients.json` and `data/rooms/matters.json` have a documented encryption-at-rest arrangement (volume, key custody, recovery) that the firm's policy accepts.
3. **A documented retention and delete sweep**: `dotfield delete` over a closed matter and its client is run and shown to leave no record, proposal, render or receipt body behind, with the retention period written down.

## Theme

`theme.json` is the `paper` preset tinted for print.
