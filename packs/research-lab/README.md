# Research lab pack

Four rooms for a lab whose questions have two halves: the papers and experiments on this side, the collaborator who holds the cohort on the other. Maturity `contract_only`: the rooms validate and render, and the two-center exchange below has been run only between two scratch centers on one machine, never with a real colleague.

## Rooms

| Room | Records | Views | Public fields |
|---|---|---|---|
| `papers` | citation, venue, DOI, the finding, `cites[]`, `influences[]` | `citations` · `influence` | `citation`, `venue`, `doi`, `finding`, `tags`, `published_on` |
| `experiments` | hypothesis, dataset, outcome, metric and value | `timeline` · `web` (includes papers and datasets) | `title`, `metric`, `value`, `run_on`, `tags` |
| `datasets` | modality, subjects, license, a digest of the files | `shelf` | `name`, `modality`, `license`, `tags` |
| `collaborators` | people and their disciplines; sensitive by default | `constellation` | `display_name`, `disciplines` |

## Desks

`lit-review` (core, papers) · `data-desk` (support, datasets) · `grants` (support, collaborators) · `methods` (challenger for lit-review and grants, experiments).

## What crosses the boundary

The pack expects to meet structural engineers and inspectors on `longitudinal-study`, `sensor`, `vibration` and `fatigue` (`boundary_vocab`). Under an active rule it shares experiment titles, metrics, values and run dates, and paper citations with their findings.

## The two-center demo (`examples/`)

Two scratch centers, `alpha` and `beta`, each with a config, a people file that pins the other's public key, and one signed projection addressed to the other:

| File | Role |
|---|---|
| `center-alpha.config.json`, `center-beta.config.json` | `center.config.json` for each scratch center |
| `people-alpha.json`, `people-beta.json` | `center/people/people.json` for each: one `kind: self` and the other center as a contact with `public_key` and `key_id` |
| `projection-alpha-to-beta.json`, `projection-beta-to-alpha.json` | signed projections; `import projection` into the receiving center verifies them and `connect --with` builds the meeting layer |

The key pairs are derived from the public seeds `dotfield-research-lab-example-alpha` and `dotfield-research-lab-example-beta` (`lib/sign.mjs keyFromSeed`). They exist so the demo runs without a second human; never pin them for a real person.

## A negative case

`projection-alpha-to-beta.json` imported into **alpha** is refused with `DF_OVERLAY_WRONG_RECEIVER` (it is addressed to `beta`), and imported into a center that has not pinned alpha's key it is refused with `DF_OVERLAY_KEY_UNKNOWN`: there is no trust-on-first-use. A rule over `collaborators` with `fields_allowed: ["affiliation"]` is refused with `DF_SHARE_FIELD_NOT_PUBLIC`.

## Theme

`theme.json` is the `story` preset.
