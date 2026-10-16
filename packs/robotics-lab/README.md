# Robotics lab pack

Four rooms for a lab that runs robots against datasets and writes the number down with its error budget. Maturity `local_beta`: the generic proof passes; the owner validates it against their own run log next (`import records experiments packs/robotics-lab/examples/runs.csv` is the first step of the under-an-hour path).

## Rooms

| Room | Records | Views | Public fields |
|---|---|---|---|
| `robots` | platform, sensors, URDF reference, `pose_m` and `size_m` on a named bench | `rig` (metric room: 2D plan, 3D, VR) · `fleet` | `name`, `platform`, `sensors`, `tags` |
| `experiments` | one run: robot, dataset, metric, value, the papers it tests (`max_records` 2000) | `graph` (method web, includes papers and robots) · `timeline` (run history) | `title`, `metric`, `value`, `run_on`, `tags` |
| `datasets` | modality, size, license, a digest of the files; never a path | `shelf` | `name`, `modality`, `license`, `tags` |
| `papers` | citation, DOI, the method in one line, `influences[]` | `influence` · `reading` | `citation`, `doi`, `method`, `tags`, `published_on` |

`examples/runs.csv` imports into `experiments` with no column mapping: its header is the record schema's field names, arrays are `;`-separated.

## Desks

`sim-ops` (core, robots) · `data-ops` (support, datasets) · `method-review` (challenger for sim-ops, experiments) · `safety` (challenger for sim-ops and method-review, robots). Every room blocks `launch_hardware`, `start_simulator` and `upload_dataset`: a desk proposes the plan as records; a human starts the machine.

## What crosses the boundary

The pack expects to meet structural engineers, inspectors and metrologists on `sensor-fusion`, `estop`, `vibration`, `inspection` and `calibration` (`boundary_vocab`, each a discipline in `disciplines.json`). Under an active rule it shares experiment titles, metrics, values, run dates and tags; `connect --between experiments,papers` is the solo meeting demo that needs no second person.

## A negative case

A share rule over `experiments` with `fields_allowed: ["notes"]` is refused with `DF_SHARE_FIELD_NOT_PUBLIC`: `notes` is the free-text field and is not in `record.public_fields`. A dataset record never carries a path at all; `path_digest` is a `sha256:` of the file list, so even `--for self` renders show no location on disk.

## Theme

`theme.json` is the `studio` preset.
