# GOVERNANCE — the five commitments and the threat model of local approval

A fork may extend this file in `center/docs/`; it may never reduce it. `test/governance.test.js` asserts that the five commitments, the one aggregate/train sentence, the threat-model limit and the four honesty statements below stay verbatim (the other sentences are prose around them).

## The five commitments

1. **No attention resale.** Nothing in Dotfield measures, ranks or sells your attention; there is no feed, no engagement metric and no telemetry.
2. **No ads.** No surface in a center, a render or a projection ever carries advertising, and no fork may add one and still call itself Dotfield.
3. **Export is a right.** `dotfield export` writes every record, proposal, rule and receipt as plain JSON, at any time, with a receipt.
4. **Delete is a right.** `dotfield delete` removes records and sweeps every derived copy (`.bak`, renders, run transcripts, proposals), listing each in the receipt.
5. **No training without a grant.** No record, projection or run transcript is used to train anything unless a share rule the owner approved says `train: true` — and in v1 the projector refuses such a rule.

## The `aggregate` and `train` switches

The two switches use one sentence in every place they appear: recorded in receipts and shown on the node card; the projector refuses a rule that sets either to true in v1 (`DF_SHARE_SWITCH_UNSUPPORTED`).

## The threat model of local approval

The approve verb is a CLI command and one button on the local inbox page. It is not an MCP tool, it matches no pattern in the skill's allow-list, and `dotfield approve` refuses with `DF_APPROVE_NOT_OWNER` when `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` is set or stdin is not a TTY, unless `--token-file` names `data/keys/owner.token`. The limit, stated plainly: an agent with shell access as the owner can read that file; the hop is a permission discipline enforced by tests and allow-lists, not cryptography.

## What the engine does not promise

- Storage: data is plaintext JSON on the owner's disk, use OS disk encryption. Dotfield adds no encryption at rest of its own.
- Recall: renders already sent cannot be recalled. `share revoke` stops future emits and asks the receiver to re-import; it cannot reach a file that already left.
- Anonymity: pseudonyms are linkable within one rule, not anonymous. `pseudonymize` is an HMAC with the rule's own salt, so two nodes under one rule stay correlatable to each other and to nothing else.
- Integrity: `match_release` detects unintended local edits, not tamper evidence. The digests in `skill-release.json` tell an owner that a file under `lib/` or `schemas/` differs from the release; an adversary who can edit those files can also regenerate the digests.
