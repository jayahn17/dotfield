# INTERFACES — the v1 component interfaces, the receipt envelope and the skill allow-list

> Moved verbatim from `VISION.md` on 2026-10-07 (V2_PLAN §8 cleanup): §14 (the interface table), the receipt envelope example of §8.4 and the allow-list block of §8.1. The v2 additions and changes live beside this file in `references/INTERFACES_V2.md`; `BUILD_CONTRACT.md` §2 states the shared conventions.

## 14. Interfaces between components (so separate builders agree before integration)

```
lib/validate.mjs        validate(schema, doc, {path='$'}) → {ok, errors:[{code, path, message, repair}]}; loadSchema(name) (throws a typed DF_SCHEMA_NOT_FOUND | DF_SCHEMA_INVALID_SCHEMA only on a broken install; tryLoadSchema(name) and validateAgainst(name, doc) never throw); openPaths(schema) → string[]
lib/rules.mjs           RULES = {DF_*: {gate, blocking, message, repair, exit?}}; finding(code, {path, detail, status}); pass(code); fail(code, {path, detail}); PINNED {cli_verbs, cli_leaf_subverbs, mcp_tools, …}; RULE_CATALOG_VERSION; ABSOLUTE_PATH_RE
lib/digest.mjs          sha256(input); hmac(key, input); canonical(obj); digestTree(dir, {include}) → {digest, files}   (the one tree digest: receipts and skill-release.json use it)
lib/receipt.mjs         buildReceipt({command, argv, now, …}) (deterministic id; `now` is required — nowFrom(env, fallback) honours SOURCE_DATE_EPOCH); writeReceipt(receipt, dir, {filename}); verifyReceipt(path, {root, engineRoot = root}) (refs against root, engine-folder refs falling back to engineRoot, drift against engineRoot); engineDigests(root) → {lib, schemas, match_release}
lib/privacy-levels.mjs  LEVELS, PRIVATE_SET, atOrBelow(level, ceiling), requiresOperators(level)
lib/exit-codes.mjs      OK, GATE, AWAITING_OWNER, STORAGE, PROVIDER (and EXIT_CODES); fromReceipt(receipt)
lib/gates/<g>.mjs       export const id; export function check(scene, ctx) → check[]   (ctx: {viewer, rooms, tokensCss, config, sessionKey, quality, requireProjected, shapes, dataDir}); gates/privacy.mjs also stamp(scene, key), verifyStamp(scene, key)
lib/pipeline.mjs        runGates(scene, ctx, order) → {checks, blocked, scene}; loadScene(target, ctx, {viewer}) (a file or room:<id>/<view>); gateContext(ctx, over); renderScene(scene, ctx, opts); GATE_ORDER, IR_ORDER, SHARE_ORDER
lib/layout/index.mjs    layoutScene(scene, ctx) → scene (positions + laid_out); positions3d(scene, ctx) → {id:[x,y,z]}; positionsVr(scene, ctx); frame.mjs toSvg(p), toThree(p), toVr(p, view)
lib/layout/trig.mjs     SLOTS (committed golden-angle table); rng.mjs mulberry32(seed)
renderers/svg.mjs       renderSvg(scene, tokens, {shapes, ownerId, inlineTokens, theme}) → string
renderers/html.mjs      renderHtml(scene, {views, tokensCss, embedThree, vendorDir, viewer, theme, svg, shapes, now, centerName, quality}) → string; renderHtmlDetailed(scene, opts) → {html, importmap, renderer, bytes, …}
lib/theme.mjs           buildTokens(brand, baseCss, {fontFiles}) → {ok, css, ledger, failures, fonts, bytes}; resolveToken(css, name, theme); parseThemes(css)
lib/rooms.mjs           discoverRooms(centerDir, {dotDir}) → {rooms, checks}; loadRoom(centerDir, id, {dotDir, roomIds}); loadConfig(centerDir) → {config, checks}; buildRegistry(rooms, config); writeRegistry(registry, dotDir)
lib/scope.mjs           resolveScope({config, as, session, origin}) → {ok, scope} | {ok:false, status:401, code, checks}
lib/store.mjs           createStore({room, dataDir, scope, config, env, root}) → {async read(), async write(records, {approved, now, by}), path(), target()}   (a storage fault throws with status 503)
lib/sandbox.mjs         async runModule({file, exportName, args, allowRead, allowWrite, timeoutMs}) → {ok, output, checks, exit_code, …}; async runTest({dir, allowRead, allowWrite}) → {ok, passed, failed, summary, checks}; permissionSupport()   (child node --permission)
lib/proposals.mjs       async propose({room, records, by, scope, kind, source, now, dataDir, config, env, argv, root}) → {ok, proposal, proposals, receipt}; summarize({room, records, …}) → summary; async decide(id, {decision, note, edited, reviewedDigest, now, dataDir, dotDir, rooms, config, env, argv, root}) → {proposal, written, receipt, idempotent}; list({dataDir, status, room, kind}); checkRecords(room, records)
lib/project.mjs         async readRecords({room, viewer, rules, circles, grants, dataDir, config, env, root, now}) → {records, checks}; async project({rooms, viewer, rules, circles, view, authored?, limit?, now, sessionKey, dataDir, config, env, root}) → scene (HMAC-stamped, tainted, expired overlays dropped); projectDetailed(same) → {scene, checks, dropped, viewer}
lib/share.mjs           evaluate(rule, viewer, node, ctx) → {allow, code, reason, operators}; redact(node, rule); envelope(node, rule, room, ctx) → {node, groups}; emitProjection({rule, nodes, edges, rooms, people, circles, disciplines, grants, rules, key, keyId, grantorId, now, dataDir, root, argv}) → {ok, projections, paths, checks, receipt}
lib/overlay.mjs         importProjection(file|doc, {people, self, dataDir, now, root, localIds, boundaryIds, reciprocalIds}) → {ok, overlay, path, dropped, removed, sanitized, checks, receipt}; computeTaint(scene, {owner}); loadPeopleDir(centerDir); applyRuleDecision({proposal, centerDir, now, receiptRef}); revokeRule({ruleId, centerDir, now})
lib/sign.mjs            generateKeyPair(); keyFromSeed(seed); sign(obj, privateKey, keyId); verify(obj, sig, publicKey); fingerprint(publicKey) → words; fingerprintMatches(publicKey, words); loadKey(dataDir, personId)
lib/meet.mjs            meet({left, right, disciplines, vocab, threshold, viewer, owner, now}) → scene(kind:'meet'); sideFromScene(scene, {id, label, roomId}); sideFromOverlay(overlay, {now, label}); pairRows(scene, edgeIds); applyPairDecision({proposal, dataDir, now})
lib/agents/roster.mjs   buildRoster(rooms, config) → {roster, checks}; deskIds(roster); router.mjs route(task, roster, {rooms, terms, desks}) and plan(task, roster, opts); loop.mjs async run({task, roster, provider, budget, between?, withPerson?, records, scene?, fieldsAllowed, personTerms, planned?, now, dataDir, dotDir, config, env}) → {ok, run, receipt, proposal, paths, checks}; fence.mjs fence(value, {person, rule}) → string
lib/providers/<p>.mjs   export const id; export async function ask({system, prompt, maxTokens, signal}) → {text, tokens_used, model}; index.mjs loadProvider(name, {config, env, relayDir, tmpDir})
```

Every command, route and tool: build the receipt, write it when the verb has an output, exit with `fromReceipt(receipt)`.

## B. The receipt envelope example (VISION §8.4)

```json
{
  "receipt_id": "rcpt_20261001T101500Z_7f3a",
  "schema_version": "dotfield.receipt/1",
  "command": "render",
  "argv": ["render", "room:experiments/graph", "out.html", "--view", "all", "--for", "ada"],
  "generated_at": "2026-10-01T10:15:00Z",
  "engine_version": "0.1.0",
  "release_tag": "v1.1-provisional",
  "engine_digests": { "lib": "sha256:…", "schemas": "sha256:…", "match_release": true, "meaning": "detects unintended local edits; not tamper evidence" },
  "status": "written",
  "ok": true,
  "exit_code": 0,
  "maturity": "local_beta",
  "scope": "owner",
  "viewer": "ada",
  "mode": "proposal_only",
  "store": { "target": "data/rooms/experiments.json", "backend": "file" },
  "inputs": [ { "ref": "center/rooms/experiments/room.json", "digest": "sha256:…" }, { "ref": "data/rooms/experiments.json", "digest": "sha256:…" } ],
  "checks": [ { "code": "DF_IR_DANGLING_EDGE", "gate": "topology", "blocking": true, "status": "pass" },
              { "code": "DF_LAYOUT_LABEL_CLEARANCE", "gate": "layout", "blocking": false, "status": "fail", "path": "nodes[3]", "repair": "Shorten the label or raise views.2d.spacing." } ],
  "outputs": [ { "ref": ".dotfield/renders/graph-experiments-20261001T101500Z/out.html", "digest": "sha256:…", "bytes": 3012033, "embedded_three": true } ],
  "owner_decision": { "state": "not_required", "reviewed_summary_digest": null },
  "blocked_actions": [],
  "provider": null,
  "foreign_spans_digest": null,
  "evidence": { "browser": "not_captured", "screenshot_ref": null, "device": null },
  "next_action": "Open the HTML in a browser (or on the headset via adb reverse) and record the screenshot path to move this render from provisional to reviewed."
}
```

## C. The skill allow-list (VISION §8.1)

```yaml
allowed-tools: Bash(node bin/dotfield.mjs validate *), Bash(node bin/dotfield.mjs render *), Bash(node bin/dotfield.mjs plan *),
  Bash(node bin/dotfield.mjs run *), Bash(node bin/dotfield.mjs import *), Bash(node bin/dotfield.mjs share rule *),
  Bash(node bin/dotfield.mjs connect *), Bash(node bin/dotfield.mjs verify *), Bash(node bin/dotfield.mjs doctor *),
  Bash(node bin/dotfield.mjs prove *), Bash(node bin/dotfield.mjs add *), Bash(node bin/dotfield.mjs theme *),
  Bash(npx -y github:jayahn17/dotfield#v0.1.0 validate *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 render *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 plan *),
  Bash(npx -y github:jayahn17/dotfield#v0.1.0 run *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 import *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 share rule *),
  Bash(npx -y github:jayahn17/dotfield#v0.1.0 connect *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 verify *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 doctor *),
  Bash(npx -y github:jayahn17/dotfield#v0.1.0 prove *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 add *), Bash(npx -y github:jayahn17/dotfield#v0.1.0 theme *)
```
