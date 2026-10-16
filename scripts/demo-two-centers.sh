#!/usr/bin/env bash
# scripts/demo-two-centers.sh — the research-lab two-center demo, end to end,
# inside one temp dir (VISION §7, §10, §11 slice 7).
#
#   bash scripts/demo-two-centers.sh                 run; one line per step
#   DEMO_KEEP=1 bash scripts/demo-two-centers.sh     keep the temp dir (path printed)
#   DEMO_RECEIPTS=<dir> bash scripts/demo-two-centers.sh   copy every receipt there (CI artifact)
#
# What it proves: two scratch centers (alpha, beta) initialised from
# packs/research-lab with the demo keys the pack README names; each pins the
# other by fingerprint (export self-card → add person); a projection from an
# unknown key and one addressed to the wrong receiver are refused; a share rule
# in alpha is approved with DOTFIELD_OWNER_TOKEN_FILE set explicitly, projected
# and imported into beta; beta renders the meeting layer --for alpha and a dry
# run --with alpha ends awaiting_owner (exit 3); revoke stops the next emit.
# Every step runs `node bin/dotfield.mjs` with the cwd set to the center, and an
# unexpected exit code stops the script non-zero. No network, provider dry
# only, nothing written outside the temp dir (and DEMO_RECEIPTS when set).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin/dotfield.mjs"
EXAMPLES="$ROOT/packs/research-lab/examples"
ROOMS="$ROOT/packs/research-lab/rooms"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1790849700}"   # one clock: the same ids every run
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dotfield-two-centers.XXXXXX")"
RECEIPTS="$WORK/receipts"
A="$WORK/alpha"
B="$WORK/beta"
STEP=0

cleanup() {
  local rc=$?
  if [ -n "${DEMO_RECEIPTS:-}" ] && [ -d "$RECEIPTS" ]; then mkdir -p "$DEMO_RECEIPTS" && cp -R "$RECEIPTS"/. "$DEMO_RECEIPTS"/; fi
  if [ "${DEMO_KEEP:-0}" = "1" ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
  if [ "$rc" -ne 0 ]; then echo "demo-two-centers: FAILED (exit $rc) after step $STEP" >&2; fi
}
trap cleanup EXIT
mkdir -p "$RECEIPTS" "$A" "$B"

# json <file> <expression over r>  — node is the JSON reader (no jq dependency).
json() {
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = new Function("r", "return (" + process.argv[2] + ")")(r); process.stdout.write(v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"
}
# expect_code <receipt> <code>: the receipt must carry that failing check.
expect_code() {
  if ! node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(r.checks.some((c) => c.code === process.argv[2] && c.status === "fail") ? 0 : 1);' "$1" "$2"; then
    echo "expected $2 in $(basename "$1")" >&2; exit 1
  fi
}
# step <expected exit> <label> <cwd> <cli args...>: runs the CLI with --json from <cwd>,
# keeps the receipt under receipts/, and stops the demo on any other exit code.
# OWNER_TOKEN_FILE, when set, is passed as DOTFIELD_OWNER_TOKEN_FILE (the explicit owner gate).
step() {
  local want="$1" label="$2" dir="$3"; shift 3
  STEP=$((STEP + 1))
  LAST="$RECEIPTS/$(printf '%02d' "$STEP")-$label.json"
  local rc=0
  if [ -n "${OWNER_TOKEN_FILE:-}" ]; then
    (cd "$dir" && DOTFIELD_OWNER_TOKEN_FILE="$OWNER_TOKEN_FILE" node "$BIN" "$@" --json) >"$LAST" 2>"$LAST.stderr" || rc=$?
  else
    (cd "$dir" && node "$BIN" "$@" --json) >"$LAST" 2>"$LAST.stderr" || rc=$?
  fi
  if [ "$rc" -ne "$want" ]; then
    echo "step $STEP ($label): expected exit $want, got $rc" >&2
    cat "$LAST" "$LAST.stderr" >&2 || true
    exit 1
  fi
  rm -f "$LAST.stderr"
  printf '%2d  %-26s exit %d  %s\n' "$STEP" "$label" "$rc" "$(json "$LAST" 'r.status + " · " + r.release_tag + (r.owner_decision && r.owner_decision.state !== "not_required" ? " · owner " + r.owner_decision.state : "")')"
}
# owner_step: the same, with the owner token file named explicitly (approve never relies on a TTY here).
owner_step() { local dir="$3"; OWNER_TOKEN_FILE="$dir/data/keys/owner.token" step "$@"; }

# seed_center <dir> <id>: the example config, the self person only (the other
# center is pinned by fingerprint below) and the demo key the README names
# (keyFromSeed of a public seed; never pin these for a real person).
seed_center() {
  local dir="$1" id="$2"
  mkdir -p "$dir/center/people" "$dir/data/keys"
  cp "$EXAMPLES/center-$id.config.json" "$dir/center/center.config.json"
  node -e 'const fs = require("fs"); const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); doc.people = doc.people.filter((p) => p.kind === "self"); fs.writeFileSync(process.argv[2], JSON.stringify(doc, null, 2) + "\n");' "$EXAMPLES/people-$id.json" "$dir/center/people/people.json"
  node --input-type=module -e 'const m = await import(process.argv[1]); const k = m.keyFromSeed(process.argv[3]); m.writeKeyFile(m.keyPath(process.argv[2], process.argv[4]), k.privateKey);' "file://$ROOT/lib/sign.mjs" "$dir/data" "dotfield-research-lab-example-$id" "$id"
}

echo "two-center demo under $WORK (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"

# 1. Two scratch centers from the research-lab pack (init keeps the seeded config, people and key).
seed_center "$A" alpha
seed_center "$B" beta
step 0 init-alpha "$A" init --pack research-lab --name "Center Alpha" --force
step 0 init-beta "$B" init --pack research-lab --name "Center Beta" --force

# 2. Records: the pack's examples, proposed by import and approved by the owner (token file explicit).
#    Alpha holds the experiments, beta the papers and datasets: two centers with different
#    records, so what later crosses from alpha is foreign in beta (the run's fences prove it).
import_approve() {
  local dir="$1" room="$2" n; n="$(basename "$dir")"
  step 3 "import-$room-$n" "$dir" import records "$room" "$ROOMS/$room/examples.json"
  PID="$(json "$LAST" 'r.outputs.map((o) => o.ref).filter((x) => /data\/proposals\//.test(x)).map((x) => x.split("/").pop().replace(/\.json$/, ""))[0]')"
  [ -n "$PID" ] || { echo "no proposal id in the import receipt" >&2; exit 1; }
  owner_step 0 "approve-$room-$n" "$dir" approve "$PID" --decision approve
}
import_approve "$A" experiments
import_approve "$B" papers
import_approve "$B" datasets
import_approve "$B" collaborators

# 3. A projection from a key beta has not pinned is refused: no trust-on-first-use.
step 2 import-unknown-key "$B" import projection "$EXAMPLES/projection-alpha-to-beta.json"
expect_code "$LAST" DF_OVERLAY_KEY_UNKNOWN

# 4. Each center hands the other its self-card (export) and is pinned by the fingerprint words read out of band.
step 0 export-alpha "$A" export -o "$WORK/alpha-export"
step 0 export-beta "$B" export -o "$WORK/beta-export"
WORDS_A="$(json "$WORK/alpha-export/people/self-card.json" 'r.ext.fingerprint')"
WORDS_B="$(json "$WORK/beta-export/people/self-card.json" 'r.ext.fingerprint')"
step 2 pin-wrong-fingerprint "$B" add person "$WORK/alpha-export/people/self-card.json" --fingerprint "$WORDS_B"
expect_code "$LAST" DF_OVERLAY_KEY_UNKNOWN
step 0 pin-alpha-in-beta "$B" add person "$WORK/alpha-export/people/self-card.json" --fingerprint "$WORDS_A"
step 0 pin-beta-in-alpha "$A" add person "$WORK/beta-export/people/self-card.json" --fingerprint "$WORDS_B"

# 5. A projection addressed to beta is refused by alpha even though the key is known.
step 2 import-wrong-receiver "$A" import projection "$EXAMPLES/projection-alpha-to-beta.json"
expect_code "$LAST" DF_OVERLAY_WRONG_RECEIVER
# ...and the shipped projection addressed to alpha, signed with beta's demo key, imports once beta is pinned.
step 0 import-shipped-into-alpha "$A" import projection "$EXAMPLES/projection-beta-to-alpha.json"

# 6. The rule: proposed in alpha, nothing emitted before the owner approves it (token file named explicitly).
#    Until approve, the rule exists only as a proposal, so share project finds no rule to emit under.
node -e 'const fs = require("fs"); const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); r.receiver.id = "beta"; r.grantor_person_id = "alpha"; r.state = "draft"; fs.writeFileSync(process.argv[2], JSON.stringify(r, null, 2) + "\n");' "$ROOT/examples/share-rule.example.json" "$WORK/rule.json"
step 3 share-rule-alpha "$A" share rule "$WORK/rule.json"
step 2 project-before-approve "$A" share project --rule rule-01
expect_code "$LAST" DF_SHARE_RULE_NOT_FOUND
[ ! -d "$A/data/projections" ] || { echo "a projection was written before approve" >&2; exit 1; }
owner_step 0 approve-rule-alpha "$A" approve rule-01 --decision approve
step 0 share-project-alpha "$A" share project --rule rule-01
PROJ="$(json "$LAST" 'r.outputs.map((o) => o.ref).filter((x) => /data\/projections\/out\//.test(x))[0]')"
[ -n "$PROJ" ] || { echo "share project wrote no projection" >&2; exit 1; }

# 7. Beta imports it, builds the meeting layer with alpha, renders it for alpha, and a dry run stops at the owner.
step 0 import-projection-beta "$B" import projection "$A/$PROJ"
[ -f "$B/data/overlays/alpha.json" ] || { echo "no overlay written in beta" >&2; exit 1; }
step 0 connect-with-alpha "$B" connect --with alpha -o "$B/meet.json"
CANDIDATES="$(json "$B/meet.json" 'r.edges.filter((e) => e.kind === "candidate").length')"
step 0 render-meet-for-alpha "$B" render "$B/meet.json" --view 2d --for alpha
#    The run is scoped to collaborators (grants desk) and experiments (the methods challenger; empty in beta):
#    the loop fences every foreign value and aborts when one appears bare, and a local node that carries the
#    same tag set as a shared node reads as such a leak, so the rooms whose records overlap alpha's stay out.
step 3 run-with-alpha "$B" run "draft a grant proposal with alpha's consortium for a replication of their vibration method" --with alpha --rooms collaborators,experiments --provider dry
[ "$(json "$LAST" 'r.status')" = "awaiting_owner" ] || { echo "run did not stop at awaiting_owner" >&2; exit 1; }

# 8. Revoke: the next emit is refused (exit 3); files already sent cannot be recalled.
step 0 share-revoke-alpha "$A" share revoke rule-01
step 3 project-after-revoke "$A" share project --rule rule-01

echo "ok: $STEP steps, $CANDIDATES candidate pair(s) between beta and alpha; receipts under $RECEIPTS (${DEMO_RECEIPTS:-not copied})"
