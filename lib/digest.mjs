// Digests and canonical JSON. Everything that is hashed anywhere in Dotfield
// goes through canonical() so two builds of the same inputs hash alike.
import { createHash, createHmac } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const HMAC_RE = /^hmac-sha256:[0-9a-f]{64}$/;

function primitive(v) {
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'number': return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint': return JSON.stringify(v.toString());
    default: return 'null';
  }
}

function skip(v) {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

function serialize(v) {
  if (v === null || typeof v !== 'object') return primitive(v);
  if (Array.isArray(v)) return `[${v.map((x) => (skip(x) ? 'null' : serialize(x))).join(',')}]`;
  if (typeof v.toJSON === 'function') return serialize(v.toJSON());
  const keys = Object.keys(v).filter((k) => !skip(v[k])).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(v[k])}`).join(',')}}`;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order at every
 * level, no whitespace, undefined members dropped, non-finite numbers and
 * unsupported values written as null. Deterministic across Node versions.
 */
export function canonical(value) {
  return serialize(value);
}

function toBytes(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (input instanceof Uint8Array) return input;
  return Buffer.from(canonical(input), 'utf8');
}

/** Bare hex sha256 of a string, byte array, or the canonical JSON of a value. */
export function sha256Hex(input) {
  return createHash('sha256').update(toBytes(input)).digest('hex');
}

/** "sha256:<64 hex>" — the form every digest field in Dotfield carries. */
export function sha256(input) {
  return `sha256:${sha256Hex(input)}`;
}

export function hmacHex(key, input) {
  return createHmac('sha256', toBytes(key)).update(toBytes(input)).digest('hex');
}

/** "hmac-sha256:<64 hex>" — the projected stamp form. */
export function hmac(key, input) {
  return `hmac-sha256:${hmacHex(key, input)}`;
}

export function isDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

/** The first n hex characters of a digest, for stub labels such as "<room> · <6-char digest>". */
export function shortDigest(digest, n = 6) {
  const hex = String(digest).replace(/^[a-z0-9-]+:/, '');
  return hex.slice(0, n);
}

export function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Regular files under dir as sorted, forward-slash relative paths; symlinks are skipped. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const absPath = join(abs, e.name);
      let st;
      try { st = lstatSync(absPath); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(absPath, relPath);
      else if (st.isFile()) out.push(relPath);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * One digest over a directory tree: sha256 of the canonical JSON of
 * [[relative path, file digest], ...] in sorted order. `include(relPath)`
 * filters files. Returns { digest, files: [{ path, digest, bytes }] }.
 */
export function digestTree(dir, { include = () => true } = {}) {
  const files = [];
  for (const rel of listFiles(dir)) {
    if (!include(rel)) continue;
    const buf = readFileSync(join(dir, rel));
    files.push({ path: rel, digest: `sha256:${createHash('sha256').update(buf).digest('hex')}`, bytes: buf.length });
  }
  return { digest: sha256(files.map((f) => [f.path, f.digest])), files };
}
