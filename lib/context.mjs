// The command context (BUILD_CONTRACT §2): createContext({cwd, env, stdin,
// stdout, as}) -> {root, centerDir, dataDir, dotDir, config, env, isTTY,
// viewer, now, ...}. This is the ONE place a wall clock is read
// (nowFrom(env, new Date()) — SOURCE_DATE_EPOCH wins); every command takes
// ctx.now from here so receipts and outputs are reproducible under one epoch.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PACKAGE_ROOT, nowFrom, receiptFilename, refDigest, writeReceipt } from './receipt.mjs';
import { discoverRooms, loadConfig } from './rooms.mjs';
import { resolveScope, sanitizeId } from './scope.mjs';

export const CENTER_CONFIG = 'center/center.config.json';
export const GENERATED_TOKENS = 'center/brand/tokens.generated.css';
export const SESSION_KEY_FILE = 'data/keys/session.key';
export const KEY_FILES = Object.freeze(['session.key', 'owner.token', 'handle.salt']);

export const toPosix = (p) => String(p).split(sep).join('/');

export const ROOT_ENV = 'DOTFIELD_ROOT';

/**
 * The fork root, in order: DOTFIELD_ROOT when set (explicit wins, center or
 * not); the nearest ancestor of cwd holding center/center.config.json; the
 * engine's own folder when cwd is one of its ancestors (the nested case:
 * `node dotfield/bin/dotfield.mjs …` from the parent repository — a parent
 * folder is never a fork root by accident, so `init` there writes the
 * engine's center/, not one beside it); else cwd itself (a project using the
 * engine from elsewhere, e.g. through npx).
 */
export function findRoot(cwd, env = process.env) {
  const pinned = env && typeof env[ROOT_ENV] === 'string' ? env[ROOT_ENV].trim() : '';
  if (pinned) return resolve(pinned);
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, CENTER_CONFIG))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (start !== PACKAGE_ROOT && insideDir(PACKAGE_ROOT, start)) return PACKAGE_ROOT;
  return start;
}

function isTty(stream) {
  return Boolean(stream && stream.isTTY === true);
}

/**
 * createContext({cwd, env, stdin, stdout, as}) -> ctx
 *   root, centerDir, dataDir, dotDir   the fork layout (root = findRoot(cwd))
 *   packageRoot                        the engine (lib/, schemas/, renderers/)
 *   config | null, configChecks        center.config.json validated by lib/rooms.mjs
 *   env, isTTY, stdinIsTTY, stdoutIsTTY, stdin, stdout
 *   viewer, scope, scopeChecks         --as resolved by lib/scope.mjs (default self / owner)
 *   now                                Date; SOURCE_DATE_EPOCH wins
 *   sessionKey()                       content of data/keys/session.key or null
 *   rooms()                            discoverRooms() memoised ({rooms: [], checks: []} without a center)
 *   tokens()                           {css, ref, path, generated}: the brand css when generated, else renderers/tokens.css
 *   relRef(path), absPath(ref)         receipt refs are root-relative (posix) when inside the root
 *   inputRef(path)                     {ref, digest, bytes} | null for a file
 *   persistReceipt(receipt, {dir})     writes <dir>/receipt.json and .dotfield/receipts/<id>.json -> paths[]
 */
export function createContext({ cwd = process.cwd(), env = process.env, stdin = null, stdout = null, as = null } = {}) {
  const root = findRoot(cwd, env);
  const centerDir = join(root, 'center');
  const dataDir = join(root, 'data');
  const dotDir = join(root, '.dotfield');
  const loaded = existsSync(join(root, CENTER_CONFIG)) ? loadConfig(centerDir) : { ok: false, config: null, checks: [], path: join(root, CENTER_CONFIG) };
  const config = loaded.ok ? loaded.config : null;
  const scope = resolveScope({ config, as: as === undefined || as === null || as === '' ? null : String(as) });
  const now = nowFrom(env, new Date());
  const memo = {};
  const ctx = {
    root, centerDir, dataDir, dotDir, packageRoot: PACKAGE_ROOT,
    config, configChecks: loaded.checks, hasCenter: loaded.ok || existsSync(join(root, CENTER_CONFIG)),
    env, stdin, stdout, stdinIsTTY: isTty(stdin), stdoutIsTTY: isTty(stdout), isTTY: isTty(stdin) && isTty(stdout),
    viewer: scope.ok ? scope.viewer : 'self', scope: scope.ok ? scope.scope : null, scopeChecks: scope.checks, scopeRefused: scope.ok ? null : scope,
    as: as === undefined || as === null || as === '' ? null : sanitizeId(as),
    now,
    sessionKey() {
      if (memo.sessionKey === undefined) {
        const file = join(dataDir, 'keys', 'session.key');
        memo.sessionKey = null;
        try { if (existsSync(file) && statSync(file).isFile()) { const text = readFileSync(file, 'utf8').trim(); memo.sessionKey = text.length ? text : null; } } catch { memo.sessionKey = null; }
      }
      return memo.sessionKey;
    },
    rooms() {
      if (memo.rooms === undefined) memo.rooms = existsSync(join(centerDir, 'rooms')) ? discoverRooms(centerDir, { dotDir }) : { rooms: [], checks: [], ok: true };
      return memo.rooms;
    },
    tokens() {
      if (memo.tokens === undefined) {
        const generated = join(root, GENERATED_TOKENS);
        const base = join(PACKAGE_ROOT, 'renderers', 'tokens.css');
        const useGenerated = existsSync(generated);
        const path = useGenerated ? generated : base;
        memo.tokens = { css: readFileSync(path, 'utf8'), path, ref: useGenerated ? GENERATED_TOKENS : 'renderers/tokens.css', generated: useGenerated };
      }
      return memo.tokens;
    },
    relRef(path) {
      const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
      const rel = relative(root, abs);
      return rel && !rel.startsWith('..') && !isAbsolute(rel) ? toPosix(rel) : toPosix(abs);
    },
    absPath(ref) {
      return isAbsolute(ref) ? resolve(ref) : resolve(root, ref);
    },
    inputRef(path) {
      const abs = ctx.absPath(path);
      const d = refDigest(abs, root);
      return d ? { ref: ctx.relRef(abs), digest: d.digest, bytes: d.bytes } : null;
    },
    persistReceipt(receipt, { dir = null, index = true } = {}) {
      const paths = [];
      if (dir) paths.push(writeReceipt(receipt, dir));
      if (index) {
        const indexDir = join(dotDir, 'receipts');
        mkdirSync(indexDir, { recursive: true });
        paths.push(writeReceipt(receipt, indexDir, { filename: receiptFilename(receipt) }));
      }
      return paths;
    },
  };
  return ctx;
}

/** Which of the four key files exist under data/keys/ (the self ed25519 key is named by the owner id). */
export function keysStatus(ctx) {
  const owner = ctx.config && ctx.config.center && typeof ctx.config.center.owner_person_id === 'string' ? ctx.config.center.owner_person_id : 'self';
  const wanted = [...KEY_FILES, `${owner}.ed25519`];
  const dir = join(ctx.dataDir, 'keys');
  const missing = wanted.filter((f) => !existsSync(join(dir, f)));
  return { dir, wanted, missing, present: wanted.filter((f) => !missing.includes(f)) };
}

/** The store target a room's owner-scoped records live at, without opening the store (lib/store.mjs stays behind the exit door). */
export function storeTarget(room, ctx) {
  const m = room && room.manifest ? room.manifest : room;
  if (!m || typeof m !== 'object') return null;
  const ns = m.store && m.store.namespace ? m.store.namespace : m.id;
  const container = m.store && m.store.scope === 'person' && ctx.scope && ctx.scope.startsWith('person_') ? `${ctx.scope}/` : '';
  const url = ctx.config && ctx.config.store && typeof ctx.config.store.object_store_url === 'string' && ctx.config.store.object_store_url;
  if (url) return { target: `${url.replace(/\/+$/, '')}/${container}rooms/${ns}.json`, backend: 'object' };
  return { target: `data/${container}rooms/${ns}.json`, backend: 'file' };
}

/** Is `file` inside `dir` (both resolved)? */
export function insideDir(file, dir) {
  const rel = relative(resolve(dir), resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
