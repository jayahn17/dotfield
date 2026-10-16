// lib/packs.mjs — the shipped packs, and how a center keeps up with them.
//
// The template ships packs only; `dotfield init` writes center/ from one
// pack and records, in center/pack-lock.json, the digest of every pack file
// it copied. `dotfield migrate` later compares three digests per file —
// the lock (what init copied), the center (what the owner has now) and the
// pack (what the engine ships now) — and acts only when that is safe:
//
//   pack == lock                       nothing shipped changed           -> same
//   center == lock, pack != lock       the owner never touched it        -> update
//   center absent, lock present        the owner deleted it on purpose   -> kept_deleted
//   center absent, lock absent         the pack added a file             -> add
//   center != lock, pack != lock       both changed                      -> conflict
//   center == pack                     already current                   -> same
//   pack stopped shipping a locked file  the owner's copy stays            -> dropped_by_pack
//
// With no lock (a center written before locks existed) a file that differs
// is unknown_no_lock and a missing one missing_no_lock: nobody can tell who
// changed it. Those and conflicts are MERGE_ACTIONS: never overwritten; the
// shipped version is written beside the backups under .dotfield/migrate-<ts>/
// for the owner to merge by hand.
//
//   listPacks(root) -> [{id, dir, draft}]
//   resolvePack(id, {root}) -> {ok, id, dir, draft, checks}
//   packDigest(dir) -> 'sha256:…'
//   trackedFiles(packDir) -> [{packRel, centerRel}]     rooms/** and disciplines.json
//   lockEntry(packDir, {id, version}) -> {version, files: {centerRel: digest}}
//   readLock(centerDir) / writeLock(centerDir, lock)
//   packUpdatePlan({packDir, packId, centerDir, lock}) -> [{centerRel, packRel, action}]
//   applyPackUpdates(plan, {packDir, centerDir, backupDir}) -> {written, conflicts}
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree, listFiles, sha256File } from './digest.mjs';
import { fail } from './rules.mjs';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const PACK_LOCK = 'pack-lock.json';
export const PACK_LOCK_VERSION = 'dotfield.pack-lock/1';
/** Rows a migrate never applies on its own: the owner changed the file, or (no lock) nobody can tell who did. */
export const MERGE_ACTIONS = Object.freeze(['conflict', 'unknown_no_lock', 'missing_no_lock']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every pack folder: [{id, dir, draft}] sorted by id; drafts live under packs/draft/. */
export function listPacks(root = PACKAGE_ROOT) {
  const out = [];
  const scan = (base, draft) => {
    if (!existsSync(base)) return;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || (!draft && e.name === 'draft')) continue;
      if (PACK_ID_RE.test(e.name) && existsSync(join(base, e.name, 'pack.json'))) out.push({ id: e.name, dir: join(base, e.name), draft });
    }
  };
  scan(join(root, 'packs'), false);
  scan(join(root, 'packs', 'draft'), true);
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The one place that says which packs init may instantiate: a URL is refused unopened, a draft is found but refused, an unknown id is not found. */
export function resolvePack(id, { root = PACKAGE_ROOT } = {}) {
  const raw = String(id ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('://')) return { ok: false, id: raw, dir: null, draft: false, checks: [fail('DF_PACK_URL_REFUSED', { path: '--pack', detail: raw })] };
  if (!PACK_ID_RE.test(raw)) return { ok: false, id: raw, dir: null, draft: false, checks: [fail('DF_PACK_NOT_FOUND', { path: '--pack', detail: `'${raw}' is not a pack id` })] };
  const found = listPacks(root).find((p) => p.id === raw);
  if (!found) return { ok: false, id: raw, dir: null, draft: false, checks: [fail('DF_PACK_NOT_FOUND', { path: '--pack', detail: `no packs/${raw}/pack.json` })] };
  if (found.draft) return { ok: false, id: raw, dir: found.dir, draft: true, checks: [fail('DF_PACK_DRAFT', { path: `packs/draft/${raw}/pack.json`, detail: 'see the README section "Leaving draft"' })] };
  return { ok: true, id: raw, dir: found.dir, draft: false, checks: [] };
}

/** The digest center.config.json installed_packs[] records: one digest over every file of the pack folder. */
export function packDigest(dir) {
  return digestTree(dir).digest;
}

/** The pack files init copies verbatim into center/: every file under rooms/, and disciplines.json as people/disciplines.json. */
export function trackedFiles(packDir) {
  const out = [];
  if (existsSync(join(packDir, 'rooms'))) for (const rel of listFiles(join(packDir, 'rooms'))) out.push({ packRel: `rooms/${rel}`, centerRel: `rooms/${rel}` });
  if (existsSync(join(packDir, 'disciplines.json'))) out.push({ packRel: 'disciplines.json', centerRel: 'people/disciplines.json' });
  return out.sort((a, b) => (a.centerRel < b.centerRel ? -1 : 1));
}

/** The lock entry for one installed pack: its version and the digest of every tracked file as copied. */
export function lockEntry(packDir, { version }) {
  const files = {};
  for (const t of trackedFiles(packDir)) files[t.centerRel] = sha256File(join(packDir, t.packRel));
  return { version, files };
}

export function readLock(centerDir) {
  const p = join(centerDir, PACK_LOCK);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return isObject(doc) && doc.schema_version === PACK_LOCK_VERSION && isObject(doc.packs) ? doc : null;
  } catch { return null; }
}

export function writeLock(centerDir, lock) {
  mkdirSync(centerDir, { recursive: true });
  writeFileSync(join(centerDir, PACK_LOCK), `${JSON.stringify({ schema_version: PACK_LOCK_VERSION, packs: lock.packs }, null, 2)}\n`);
}

/** One row per tracked file of the shipped pack, plus locked files the pack no longer ships (reported, never deleted). */
export function packUpdatePlan({ packDir, packId, centerDir, lock }) {
  const locked = lock && isObject(lock.packs) && isObject(lock.packs[packId]) && isObject(lock.packs[packId].files) ? lock.packs[packId].files : null;
  const rows = [];
  // A new file for a room the owner deleted stays out: re-adding one file would leave a broken room.
  const roomDeleted = (rel) => { const m = /^rooms\/([^/]+)\//.exec(rel); return Boolean(m && locked && !existsSync(join(centerDir, 'rooms', m[1])) && Object.keys(locked).some((k) => k.startsWith(`rooms/${m[1]}/`))); };
  for (const t of trackedFiles(packDir)) {
    const packNow = sha256File(join(packDir, t.packRel));
    const centerPath = join(centerDir, t.centerRel);
    const centerNow = existsSync(centerPath) ? sha256File(centerPath) : null;
    const lockNow = locked ? locked[t.centerRel] ?? null : null;
    let action;
    if (centerNow === packNow) action = 'same';
    else if (!locked) action = centerNow === null ? 'missing_no_lock' : 'unknown_no_lock';
    else if (lockNow === packNow) action = 'same';
    else if (centerNow === null) action = lockNow !== null || roomDeleted(t.centerRel) ? 'kept_deleted' : 'add';
    else if (centerNow === lockNow) action = 'update';
    else action = 'conflict';
    rows.push({ ...t, action, packNow, centerNow, lockNow });
  }
  if (locked) for (const rel of Object.keys(locked)) if (!rows.some((r) => r.centerRel === rel)) rows.push({ packRel: null, centerRel: rel, action: 'dropped_by_pack', packNow: null, centerNow: null, lockNow: locked[rel] });
  return rows;
}

/** Apply the safe rows: back up every file it replaces, write the shipped version of each conflict beside the backups, and return what changed. */
export function applyPackUpdates(plan, { packDir, centerDir, backupDir }) {
  const written = [];
  const conflicts = [];
  for (const r of plan) {
    if (r.action === 'update' || r.action === 'add') {
      const dst = join(centerDir, r.centerRel);
      if (existsSync(dst)) { const b = join(backupDir, 'center', r.centerRel); mkdirSync(dirname(b), { recursive: true }); cpSync(dst, b); }
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(packDir, r.packRel), dst);
      written.push(r);
    } else if (MERGE_ACTIONS.includes(r.action)) {
      const shipped = join(backupDir, 'shipped', r.centerRel);
      mkdirSync(dirname(shipped), { recursive: true });
      cpSync(join(packDir, r.packRel), shipped);
      conflicts.push({ ...r, shipped });
    }
  }
  return { written, conflicts };
}
