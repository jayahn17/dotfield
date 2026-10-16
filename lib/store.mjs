// One room store (VISION §3 data/, §5 "what the customer gets"): atomic
// writes (tmp + fsync + rename, previous version kept as .bak), size limits,
// typed faults ({status: 503, storage: true}) so a disk or bucket outage is
// a 503 to retry rather than a 200 that lost the write. Only lib/project.mjs,
// lib/proposals.mjs, lib/commands/{export,delete}.mjs and tests import this
// file (test/structure.test.js). Every write states approved: true; the only
// caller that may is proposals.decide() plus the owner-only delete verb.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, sha256 } from './digest.mjs';
import { isoSeconds } from './receipt.mjs';
import { fail, pass } from './rules.mjs';
import { OWNER_SCOPE, containerOf, isScope } from './scope.mjs';

export const STORE_SCHEMA_VERSION = 'dotfield.store/1';
export const DEFAULT_MAX_RECORDS = 2000;
export const DEFAULT_MAX_RECORD_BYTES = 16384;
export const BACKENDS = Object.freeze(['file', 'object', 'memory']);
const MEMORY = new Map();

/** A typed store failure: .code (DF_STORE_*), .status (HTTP-like), .storage (true for 503), .check (a fail finding). */
export class StoreError extends Error {
  constructor(code, { status = 503, detail, path, cause } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
    this.storage = status === 503;
    this.check = fail(code, { path, detail });
    if (cause !== undefined) this.cause = cause;
  }
}

export function isStoreError(e) {
  return e instanceof StoreError;
}

export function fault(detail, { path, cause } = {}) {
  return new StoreError('DF_STORE_FAULT', { status: 503, detail, path, cause });
}

/** The env var that pins a room store to a file: DOTFIELD_STORE_<ROOM>_FILE. */
export function envPinName(roomId) {
  return `DOTFIELD_STORE_${String(roomId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FILE`;
}

function manifestOf(room) {
  const m = room && room.manifest ? room.manifest : room;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string') throw new TypeError('createStore needs a room (a discovered room or its manifest)');
  return m;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function fsyncDir(dir) {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort on platforms without directory fsync */ }
}

/** tmp + fsync + rename; the previous file (when any) is copied to <file>.bak first. Throws StoreError on any fault. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const backup = existsSync(file);
    if (backup) copyFileSync(file, `${file}.bak`);
    renameSync(tmp, file);
    fsyncDir(dirname(file));
    return { backup };
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw fault(`cannot write ${file}: ${e && e.message ? e.message : String(e)}`, { path: file, cause: e });
  }
}

function parseEnvelope(text, where) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    throw new StoreError('DF_STORE_CORRUPT', { status: 503, path: where, detail: `${where} is not valid JSON (${e.message}); restore ${where}.bak` });
  }
  if (Array.isArray(doc)) return { records: doc };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.records)) {
    throw new StoreError('DF_STORE_CORRUPT', { status: 503, path: where, detail: `${where} does not hold a records array; restore ${where}.bak` });
  }
  return doc;
}

/**
 * createStore({room, dataDir, scope, config, env, backend, root, fetch}) -> store
 *   .read() -> Promise<records[]>            .readEnvelope() -> Promise<{records, written_at, ...}>
 *   .write(records, {approved, now, by}) -> Promise<{target, count, bytes, digest, backup}>
 *   .path() -> file path or target string   .target() -> {target, backend} for receipts
 *   .checkLimits(records) -> checks[]        .checks -> findings raised while resolving (env pin)
 * scope is a resolveScope() result or a scope string; a public or refused
 * scope throws DF_STORE_SCOPE_REFUSED because no store exists for it.
 */
export function createStore({ room, dataDir, scope = OWNER_SCOPE, config = null, env = process.env, backend = null, root = null, fetch: fetchImpl = null } = {}) {
  const m = manifestOf(room);
  const scopeName = typeof scope === 'string' ? scope : (scope && scope.ok ? scope.scope : null);
  if (!isScope(scopeName) || containerOf(scopeName) === null) {
    throw new StoreError('DF_STORE_SCOPE_REFUSED', { status: scope && scope.status ? scope.status : 401, detail: `no store opens for scope ${JSON.stringify(scopeName)}` });
  }
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createStore needs dataDir');
  const storeCfg = m.store || {};
  const namespace = storeCfg.namespace || m.id;
  const container = storeCfg.scope === 'person' ? containerOf(scopeName) : '';
  const limits = { max_records: storeCfg.max_records ?? DEFAULT_MAX_RECORDS, max_record_bytes: storeCfg.max_record_bytes ?? DEFAULT_MAX_RECORD_BYTES };
  const rootDir = root || resolve(dataDir, '..');
  const checks = [];
  const relPath = join(container, 'rooms', `${namespace}.json`);
  let kind = backend || 'file';
  let file = resolve(dataDir, relPath);
  let url = null;
  let pinned = false;
  const pin = env ? env[envPinName(m.id)] : undefined;
  if (typeof pin === 'string' && pin.trim()) {
    const allowed = Boolean(env.NODE_TEST_CONTEXT) || Boolean(config && config.store && config.store.allow_env_pins === true);
    if (allowed) { pinned = true; kind = 'file'; file = isAbsolute(pin) ? pin : resolve(rootDir, pin); }
    else checks.push(fail('DF_STORE_ENV_PIN_IGNORED', { path: envPinName(m.id), detail: 'set store.allow_env_pins: true in center.config.json or run under NODE_TEST_CONTEXT' }));
  }
  if (!checks.length) checks.push(pass('DF_STORE_ENV_PIN_IGNORED'));
  if (kind === 'file' && !pinned && config && config.store && typeof config.store.object_store_url === 'string' && config.store.object_store_url) {
    kind = 'object';
    url = `${config.store.object_store_url.replace(/\/+$/, '')}/${toPosix(relPath)}`;
  }
  if (!BACKENDS.includes(kind)) throw new TypeError(`unknown store backend ${String(kind)}`);
  const memoryKey = `memory:${toPosix(relPath)}`;
  const targetName = () => {
    if (kind === 'object') return url;
    if (kind === 'memory') return memoryKey;
    const rel = toPosix(relative(rootDir, file));
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : toPosix(file);
  };
  const doFetch = () => fetchImpl || globalThis.fetch;

  async function readEnvelope() {
    if (kind === 'memory') return MEMORY.has(memoryKey) ? structuredClone(MEMORY.get(memoryKey)) : { records: [] };
    if (kind === 'object') {
      let res;
      try { res = await doFetch()(url, { method: 'GET', headers: { accept: 'application/json' } }); } catch (e) { throw fault(`GET ${url}: ${e.message}`, { path: url, cause: e }); }
      if (res.status === 404) return { records: [] };
      if (!res.ok) throw fault(`GET ${url} answered ${res.status}`, { path: url });
      return parseEnvelope(await res.text(), url);
    }
    if (!existsSync(file)) return { records: [] };
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) { throw fault(`cannot read ${file}: ${e.message}`, { path: file, cause: e }); }
    return parseEnvelope(text, targetName());
  }

  function checkLimits(records) {
    const out = [];
    if (!Array.isArray(records)) return [fail('DF_STORE_MAX_RECORDS', { detail: 'records is not an array' })];
    if (records.length > limits.max_records) out.push(fail('DF_STORE_MAX_RECORDS', { path: targetName(), detail: `${records.length} records > store.max_records ${limits.max_records}` }));
    else out.push(pass('DF_STORE_MAX_RECORDS'));
    let big = 0;
    records.forEach((r, i) => {
      const bytes = Buffer.byteLength(canonical(r), 'utf8');
      if (bytes > limits.max_record_bytes) { big += 1; out.push(fail('DF_STORE_MAX_BYTES', { path: `$[${i}]`, detail: `${bytes} bytes > store.max_record_bytes ${limits.max_record_bytes}` })); }
    });
    if (!big) out.push(pass('DF_STORE_MAX_BYTES'));
    return out;
  }

  async function write(records, { approved = false, now = null, by = 'self' } = {}) {
    if (approved !== true) throw new StoreError('DF_STORE_WRITE_WITHOUT_APPROVAL', { status: 403, path: targetName(), detail: 'store.write() is reached only through proposals.decide() (dotfield approve) or dotfield delete' });
    if (storeCfg.scope !== 'person' && scopeName !== OWNER_SCOPE) throw new StoreError('DF_STORE_SCOPE_REFUSED', { status: 403, path: targetName(), detail: `room ${m.id} is owner-scoped; ${scopeName} cannot write it` });
    const failing = checkLimits(records).filter((c) => c.status === 'fail');
    if (failing.length) throw new StoreError(failing[0].code, { status: 422, path: failing[0].path, detail: failing[0].message });
    const envelope = {
      schema_version: STORE_SCHEMA_VERSION, room: m.id, namespace, scope: scopeName,
      written_at: now === null || now === undefined ? null : isoSeconds(now), written_by: String(by),
      count: records.length, digest: sha256(records), records,
    };
    const text = `${JSON.stringify(envelope, null, 2)}\n`;
    const bytes = Buffer.byteLength(text, 'utf8');
    let backup = false;
    if (kind === 'memory') { backup = MEMORY.has(memoryKey); MEMORY.set(memoryKey, structuredClone(envelope)); }
    else if (kind === 'object') {
      let res;
      try { res = await doFetch()(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text }); } catch (e) { throw fault(`PUT ${url}: ${e.message}`, { path: url, cause: e }); }
      if (!res.ok) throw fault(`PUT ${url} answered ${res.status}`, { path: url });
    } else ({ backup } = writeFileAtomic(file, text));
    return { target: targetName(), backend: kind, count: records.length, bytes, digest: envelope.digest, backup };
  }

  return Object.freeze({
    room: m.id, namespace, scope: scopeName, backend: kind, limits, checks,
    path: () => (kind === 'file' ? file : targetName()),
    target: () => ({ target: targetName(), backend: kind }),
    exists: () => (kind === 'memory' ? MEMORY.has(memoryKey) : kind === 'file' ? existsSync(file) : null),
    readEnvelope,
    read: async () => (await readEnvelope()).records.map((r) => structuredClone(r)),
    checkLimits,
    write,
  });
}

/** Tests only: forget every memory-backend store. */
export function clearMemoryStores() {
  MEMORY.clear();
}
