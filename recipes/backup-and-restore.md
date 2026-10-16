# Recipe — back up and restore a center

Goal: lose the laptop, not the center. A center is two halves, and git only carries one of them.

| Half | Holds | Where it lives | How it is kept |
|---|---|---|---|
| `center/` | rooms, record schemas, views, people, share rules, brand, docs | your fork's git history | push the fork to a **private** remote |
| `data/` | records, proposals, the keys (`session.key`, `owner.token`, `handle.salt`, your ed25519 key) | this machine only (`.gitignore` keeps it out of git) | an encrypted archive, below |

`.dotfield/` is derived (renders, receipts, caches) and can always be rebuilt; it needs no backup.

## 1. The full backup: data/ encrypted

The archive contains your private keys, so it is only ever stored encrypted and off this machine. With [age](https://age-encryption.org) (one binary, passphrase mode):

```
tar -czf - data | age -p > "dotfield-data-$(date +%Y%m%d).tar.gz.age"
```

Restore it next to the same `center/` (a fresh clone of your fork):

```
age -d dotfield-data-20261015.tar.gz.age | tar -xzf -
node bin/dotfield.mjs doctor
```

An encrypted disk image, or a backup tool that encrypts at rest (an encrypted Time Machine disk, restic, Borg), does the same job; whatever you use, test a restore once. Keep `data/keys/handle.salt` in that backup: stored handles are HMACs under it, so a center restored without it cannot match a returning contact to the person already in `people.json`.

## 2. The portable copy: dotfield export

```
node bin/dotfield.mjs export -o ~/dotfield-export
```

writes every room's records (`rooms/<room>.json`), the people directory **without handles**, the share rules, the open proposals and the receipts, plus `export.json` listing every file. It never writes a private key, so it is safe to keep in ordinary storage, and it outlives this engine version: each file is plain JSON with a `schema_version`.

Restore records into a fresh center (or a new machine without the encrypted archive) with the verbs you already use; nothing bypasses the approval hop:

```
node bin/dotfield.mjs init --pack <the pack you started from> --name "My Center"
node bin/dotfield.mjs import records notes ~/dotfield-export/rooms/notes.json
node bin/dotfield.mjs approve <proposal id> --decision approve
```

One `import records` per room; each one exits 3 with a proposal until you approve it (from a terminal or the `/inbox` page). A restore from an export starts with new keys, so receivers you shared with see a new fingerprint: send them your new `people/self-card.json`. `test/backup.test.js` runs this round trip on every commit.

## What never to do

- Commit `data/`, or copy `data/keys/` anywhere unencrypted.
- Ask Claude to run `export`, `approve` or `migrate`: the skill never calls them; they are yours.
