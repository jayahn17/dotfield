# AGENTS.md — the engine rules that never change

> Read order: [`VISION.md`](VISION.md) → this file → [`.claude/skills/dotfield/SKILL.md`](.claude/skills/dotfield/SKILL.md). The customer's own operating notes live in [`center/docs/AGENTS.md`](center/docs/AGENTS.md); this file is `fork_editable` only as a pointer — the rules below are restated by tests and do not bend in a fork.

## Commands

- Tests: `npm test` (`node --test test/*.test.js`; zero network, no provider, every test in its own temp dir; the two tests that need the optional `@modelcontextprotocol/sdk` and the ones that need `vendor/three/` skip with a named reason when those are absent — `npm install` and `node scripts/fetch-vendor.mjs` fill them).
- Gates: `node bin/dotfield.mjs validate all --json` · proof: `node bin/dotfield.mjs prove all --json` · health: `node bin/dotfield.mjs doctor --json`.
- Manifest: `npm run manifest` after any engine change, `npm run manifest:check` in CI. A stale manifest means a receipt will print `match_release: false`.
- When a parent repository nests this folder (the son repository does) the dot-files here are inert there; run the MCP server and the preview as `node dotfield/mcp/stdio.mjs` and `node dotfield/server/serve.mjs` from the parent. That works because `findRoot()` (lib/context.mjs) falls back to the engine's own folder whenever cwd is one of its ancestors, so a parent folder never becomes a fork root by accident; `DOTFIELD_ROOT=<fork root>` pins the center explicitly from anywhere.
- The template ships packs, not a center: `center/` appears with `init`, and only a fork commits it. Upstream CI sets `DOTFIELD_TEMPLATE_REPO=1`, which makes `npm test` and `npm run check` refuse a tracked `center/` here; `scripts/pack-init-check.mjs` proves every shipped pack instantiates.

## Proof-closed work guardrail (ported from son, see `references/PROVENANCE.md`)

- Before delegating to agents or editing code/docs, write the acceptance bar in the working note or final response: target files, output format, audience/user, "do not change" list, verification command, and what counts as done.
- Treat scouts and evaluators as bounded, read-only roles unless the owner explicitly approves edits. Their deliverable must cite source paths, separate fact/inference/speculation, list open proof gaps, and recommend the smallest reversible next action.
- No task is "done" until there is proof: tests, demo output, rendered screenshot, API smoke result, schema validation, diff review, or an explicit owner acceptance note. If proof cannot be run, label the result `provisional` or `blocked` with the exact missing verification.
- Prefer changes that simplify or replace stale paths over additive sprawl. When adding rather than deleting, state why the new artifact needs to exist and how future agents verify it.

## Rules the tests hold

- Agents propose, the owner approves. Every write path is a proposal file until `dotfield approve`; there is no environment flag that turns proposals into writes; no MCP tool is named `*approve*`; no skill allow-list pattern matches `approve`, `share project`, `share revoke`, `export`, `delete`, `serve` or `migrate`.
- A customer edits only `center/`. Everything else is hashed in `engine.manifest.json` minus `fork_editable[]`; `doctor` reports `DF_ENGINE_MODIFIED` with the path.
- One exit door: only `lib/project.mjs`, `lib/proposals.mjs`, `lib/commands/{export,delete}.mjs` and tests import `lib/store.mjs`. Customer code runs only through `lib/sandbox.mjs` — today that is a room's `test.mjs` (`prove`, reads limited to the room folder and the engine's `lib/`, `schemas/`, `renderers/`, never `data/keys/`); `actions.mjs` and `center/importers/*.mjs` are planned callers (`references/MATURITY.md`) and no verb runs them yet.
- Tokens, not hexes: a colour is written once, in `renderers/tokens.css`.
- Nothing under `bin lib renderers server mcp importers packs schemas examples templates` may carry an absolute home path, an email, a phone number or the string `jay`; no code in packs (JSON plus one README per pack and robotics-lab's `runs.csv`); every source file stays under 400 lines.
- Never claim success on a non-zero exit. Quote `DF_*` codes. A render without a screenshot path is `provisional`.

## Publishing the template

The public repository `github.com/jayahn17/dotfield` holds one commit per release: the tree of this folder, committed on top of the previous release under the GitHub no-reply address, so neither the son history nor a personal email is published. Son stays the working copy. To publish a release from the son root, on the commit to release:

```
git fetch https://github.com/jayahn17/dotfield.git main        # the previous release
tree=$(git rev-parse HEAD:dotfield)
export GIT_AUTHOR_NAME="SeongJae Ahn" GIT_COMMITTER_NAME="SeongJae Ahn"
export GIT_AUTHOR_EMAIL=137253280+jayahn17@users.noreply.github.com GIT_COMMITTER_EMAIL=137253280+jayahn17@users.noreply.github.com
commit=$(git commit-tree "$tree" -p FETCH_HEAD -m "Dotfield v<version>")
git push https://github.com/jayahn17/dotfield.git "$commit:refs/heads/main"
git push https://github.com/jayahn17/dotfield.git "$commit:refs/tags/v<version>"
```

Bump `package.json` `version` and the pinned `#v<version>` in the skill's npx patterns in the same son commit (`test/skill.test.js` holds them equal), run `npm test` and `DOTFIELD_TEMPLATE_REPO=1 npm run check` first, and push the tag only after `main`, so `npx -y github:jayahn17/dotfield#v<version>` resolves to the tree that was tested. A tag is never moved: a fix is the next version.
