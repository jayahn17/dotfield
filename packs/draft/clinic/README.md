# Clinic pack (draft)

A shareable protocol library, synthetic-id cases, the literature behind the protocols and the follow-ups they generate. **Draft**: `dotfield init --pack clinic` is refused with `DF_PACK_DRAFT`; the pack is validated and rendered by `test/packs.test.js` like any other. It is not a medical record system and does not become one by leaving draft.

## Rooms

| Room | Records | Views | Public fields |
|---|---|---|---|
| `protocols` | condition, version, steps, evidence grade, the literature cited | `outcomes` (includes cases and literature) · `versions` | `title`, `condition`, `version`, `steps_count`, `tags`, `effective_on` |
| `cases` | a synthetic study id, the protocol followed, the outcome; `sensitive` | `timeline` | none |
| `literature` | citation, DOI, finding, evidence level | `web` | `citation`, `doi`, `finding`, `evidence_level`, `tags`, `published_on` |
| `followups` | due date, kind, status per case; `sensitive` | `board` (lanes by status) | none |

`views_off: ["vr"]`: every view sets `vr.enabled: false`. `owner_gates.aggregate` and `owner_gates.train` are `blocked` on every room, and `aggregate_cases` is a blocked action besides, so no mode and no rule can switch them on.

## Desks

`evidence` (core, protocols) · `triage-support` (support, cases; never a diagnosis) · `audit` (support, cases) · `safety-review` (challenger for evidence, triage-support and audit, followups).

## What crosses the boundary

The pack expects to share **protocols** with other clinics on `protocol`, `outcome`, `adherence` and `triage`: title, condition, version, step count and effective date. Nothing from `cases` or `followups` ever crosses: their `public_fields` are empty.

## A negative case

A rule whose subject selects `cases` emits nothing: the records are `sensitive`, so the rule needs the `redact` operator (`DF_SHARE_SENSITIVE_WITHOUT_OPERATORS` without it), and with it every node is a stub with no fields because `public_fields` is `[]`. A rule with `switches.aggregate: true` is refused with `DF_SHARE_SWITCH_UNSUPPORTED` whatever the room.

## Leaving draft

The pack moves from `packs/draft/` to `packs/` when all three exist, each recorded as a receipt or a document in `references/MATURITY.md`:

1. **One practitioner's review**: a clinician has read every room, desk constraint and regulatory note and signed off that nothing here presents itself as a diagnosis, a treatment decision or a medical record.
2. **An at-rest encryption story**: `data/rooms/cases.json` and `data/rooms/followups.json` have a documented encryption-at-rest arrangement (volume, key custody, recovery) that the clinic's governance accepts.
3. **A documented retention and delete sweep**: `dotfield delete` over a closed case and its follow-ups is run and shown to leave no record, proposal, render or receipt body behind, with the retention period written down.

## Theme

`theme.json` is the `light` preset.
