# Recipe — share a projection with one colleague

Sharing is a file exchange: nothing is sent by the engine. The receiving side needs your public key first, entered by fingerprint, and you need theirs. `release_tag` on every receipt in this recipe is `v1.1-provisional` until the two-center proof in `references/MATURITY.md` exists.

1. **Exchange fingerprints.** `dotfield init` created your ed25519 key; `doctor` prints its word-list fingerprint. Your colleague runs `node bin/dotfield.mjs add person you.json --fingerprint "<the words you read to them>"`, and you do the same for them. There is no trust-on-first-use: a projection from an unknown key is refused (`DF_OVERLAY_KEY_UNKNOWN`).
2. **Write the rule.** Copy `examples/share-rule.example.json`, set `receiver.id`, the `subject.selector` (rooms, tags, kinds) and `redaction.fields_allowed` — a subset of the room's `public_fields` or `DF_SHARE_FIELD_NOT_PUBLIC`. Keep `aggregate` and `train` false; the projector refuses a rule that sets either to true in v1 (`DF_SHARE_SWITCH_UNSUPPORTED`).
3. **Add and approve.** `node bin/dotfield.mjs add rule rule-01.json` creates it in `awaiting_owner`. Only `dotfield approve rule-01 --decision approve` (from a TTY) moves it to `active`. A rule in `awaiting_owner` produces nothing.
4. **Project.** `node bin/dotfield.mjs share project --rule rule-01` writes `data/projections/out/<receiver>-<rule>-<ts>.json`, signed over everything but the signature, so it cannot be replayed to someone else. The envelope is exactly `fields_allowed` plus fixed metadata; a label is emitted only if `label_field` is allowed, else the stub is `<room> · <6-char digest>`.
5. **Hand over the file.** By any channel you trust. The engine has no send path.
6. **They import.** `node bin/dotfield.mjs import projection <file>`: wrong receiver, unknown key or a bad signature refuse; ids are namespaced `person-<you>-…`; nothing of theirs is overwritten.
7. **Revoke honestly.** `share revoke rule-01` stops future emits and asks the receiver to re-import; it cannot recall a file already sent. Expiry is enforced on their side at every projection (`DF_OVERLAY_EXPIRED`).
