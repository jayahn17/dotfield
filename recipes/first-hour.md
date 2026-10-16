# Recipe — the first hour, step by step

Goal: a branded center with seeded rooms, one approved import, one agent run stopped at `awaiting_owner`, one meeting-layer scene and one embedded HTML you can send. Not yet timed (see `README.md`).

1. **Install and initialise.** `npm install` then `node bin/dotfield.mjs init --pack starter --name "My Center"`. The init receipt ends with `prove all` and `validate all`; exit 0 means every seeded room validates. Keys land in `data/keys/` (0600); never print or commit them.
2. **Health.** `node bin/dotfield.mjs doctor --json`. Read `checks[]`: `DF_ENGINE_MODIFIED` names an engine file that differs from the manifest; `DF_MCP_SDK_MISSING` prints the one install command; a missing vendor hash means `--fetch-vendor` has not run (only needed for 3D/VR).
3. **Serve.** `node bin/dotfield.mjs serve`. The terminal (a TTY) prints `http://127.0.0.1:4100/inbox?t=…`; the token is read once by the page and dropped from the URL. Rooms with an empty store are seeded from their `examples.json`.
4. **Import.** `node bin/dotfield.mjs import records notes my-notes.csv --map Title=title,Body=body`. Exit 3 and `status: awaiting_owner` is the expected outcome: a proposal file exists, the store is untouched. Open `/inbox`, read the summary (adds, fields touched, sample rows) — the buttons enable only after it is shown — and approve.
5. **Ask Claude.** Open `claude` in the folder; the skill and the MCP server are auto-discovered. Ask for "a plan for reviewing this week's notes". It runs `plan`, then `run`, and stops at `awaiting_owner` with a proposal id. Approve or reject on `/inbox`.
6. **Meet.** `node bin/dotfield.mjs connect --between notes,contacts -o meet.json` then `render meet.json out.html --view 2d`. Candidate edges are dashed and never persisted; accepting one is itself a proposal.
7. **Send.** `node bin/dotfield.mjs render room:notes/graph out.html --view all --for <person_id>`. With `--for` not `self`, three.js is embedded and only `public_fields` under an active rule cross; the footer names the viewer. The receipt says `evidence.browser: not_captured` until you record a screenshot path, so the honest label is `provisional`.
