#!/usr/bin/env node
// scripts/fetch-vendor.mjs — fill vendor/three/ (gitignored) with the four
// three@0.180.0 modules vendor/manifest.json pins, by hash. Every download
// is checked against sha256_pre before anything is written; three.module.js
// then gets its one specifier rewrite ('./three.core.js' -> 'three/core',
// the count asserted against manifest.rewrite.count) and is checked against
// sha256_post. A mismatch is refused: nothing lands on disk and the exit
// code is 1. `--verify` touches no network and reports the state on disk.
//
//   node scripts/fetch-vendor.mjs [--force] [--json] [--vendor-dir <dir>] [--manifest <file>]
//   node scripts/fetch-vendor.mjs --verify [--json] [...]
//
// Exported for tests (zero network there: fetchVendor takes a fetch stub):
//   readManifest(file) -> manifest           rewriteCore(text, rewrite) -> {text, count}
//   digest(bytes) -> 'sha256:<hex>'          verifyVendor({manifest, vendorDir}) -> {ok, files[]}
//   fetchVendor({manifest, vendorDir, fetchImpl, force}) -> {ok, fetched, skipped, files[]}
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const MANIFEST_PATH = join(ROOT, 'vendor', 'manifest.json');
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const PINNED_PREFIX = 'https://cdn.jsdelivr.net/npm/three@';

export const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse and validate the manifest; throws a plain Error naming the first problem. */
export function readManifest(file = MANIFEST_PATH) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  if (m.schema_version !== 'dotfield.vendor/1') throw new Error(`manifest: schema_version must be dotfield.vendor/1 (${file})`);
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('manifest: files[] is empty');
  const r = m.rewrite;
  if (!r || typeof r.file !== 'string' || typeof r.from !== 'string' || typeof r.to !== 'string' || !Number.isInteger(r.count) || r.count < 1) {
    throw new Error('manifest: rewrite needs {file, from, to, count >= 1}');
  }
  for (const f of m.files) {
    for (const k of ['specifier', 'file', 'url', 'sha256_pre', 'sha256_post']) if (typeof f[k] !== 'string') throw new Error(`manifest: ${f.specifier || '?'} lacks ${k}`);
    if (!DIGEST_RE.test(f.sha256_pre) || !DIGEST_RE.test(f.sha256_post)) throw new Error(`manifest: ${f.specifier} digests must be sha256:<64 hex>`);
    if (!f.url.startsWith(`${PINNED_PREFIX}${m.three_version}/`)) throw new Error(`manifest: ${f.specifier} url is not under ${PINNED_PREFIX}${m.three_version}/`);
    if (f.file.includes('..') || f.file.startsWith('/')) throw new Error(`manifest: ${f.specifier} file must be a relative path under vendor/`);
  }
  if (!m.files.some((f) => f.file === r.file)) throw new Error(`manifest: rewrite.file ${r.file} is not one of files[]`);
  return m;
}

/** Replace every quoted occurrence of rewrite.from with rewrite.to; the caller asserts the count. */
export function rewriteCore(text, rewrite) {
  const re = new RegExp(`(['"])${escapeRe(rewrite.from)}\\1`, 'g');
  const count = (text.match(re) || []).length;
  return { text: text.replace(re, `$1${rewrite.to}$1`), count };
}

/** The state of every pinned file on disk: ok | missing | mismatch (digest differs from sha256_post). */
export function verifyVendor({ manifest, vendorDir = join(ROOT, 'vendor') }) {
  const files = manifest.files.map((f) => {
    const path = join(vendorDir, f.file);
    if (!existsSync(path)) return { specifier: f.specifier, file: f.file, status: 'missing', expected: f.sha256_post, actual: null };
    const actual = digest(readFileSync(path));
    return { specifier: f.specifier, file: f.file, status: actual === f.sha256_post ? 'ok' : 'mismatch', expected: f.sha256_post, actual };
  });
  return { ok: files.every((f) => f.status === 'ok'), vendorDir, files };
}

async function download(fetchImpl, url) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res || !res.ok) throw new Error(`fetch failed: ${url} -> ${res ? res.status : 'no response'}`);
  return Buffer.from(await res.arrayBuffer());
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/**
 * Fetch every file whose on-disk digest is not already sha256_post (or all,
 * with force). A file is written only after its served bytes match
 * sha256_pre and, for the rewrite target, the rewritten bytes match
 * sha256_post with exactly manifest.rewrite.count replacements. One refusal
 * does not stop the others; `ok` is false if any file is not 'ok' at the end.
 */
export async function fetchVendor({ manifest, vendorDir = join(ROOT, 'vendor'), fetchImpl = globalThis.fetch, force = false }) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available: Node >= 22.13 is required');
  const before = verifyVendor({ manifest, vendorDir });
  const files = []; let fetched = 0; let skipped = 0;
  for (const f of manifest.files) {
    const state = before.files.find((x) => x.file === f.file);
    if (!force && state.status === 'ok') { skipped += 1; files.push({ ...state, action: 'kept' }); continue; }
    const path = join(vendorDir, f.file);
    try {
      const served = await download(fetchImpl, f.url);
      const pre = digest(served);
      if (pre !== f.sha256_pre) {
        files.push({ specifier: f.specifier, file: f.file, status: 'refused', action: 'none', reason: `served bytes digest ${pre} != pinned sha256_pre ${f.sha256_pre}`, url: f.url });
        continue;
      }
      let out = served;
      if (f.file === manifest.rewrite.file) {
        const { text, count } = rewriteCore(served.toString('utf8'), manifest.rewrite);
        if (count !== manifest.rewrite.count) {
          files.push({ specifier: f.specifier, file: f.file, status: 'refused', action: 'none', reason: `specifier ${JSON.stringify(manifest.rewrite.from)} occurs ${count} times, manifest pins ${manifest.rewrite.count}`, url: f.url });
          continue;
        }
        out = Buffer.from(text, 'utf8');
      }
      const post = digest(out);
      if (post !== f.sha256_post) {
        files.push({ specifier: f.specifier, file: f.file, status: 'refused', action: 'none', reason: `post-rewrite digest ${post} != pinned sha256_post ${f.sha256_post}`, url: f.url });
        continue;
      }
      writeAtomic(path, out);
      fetched += 1;
      files.push({ specifier: f.specifier, file: f.file, status: 'ok', action: 'written', bytes: out.length, sha256_post: post });
    } catch (e) {
      files.push({ specifier: f.specifier, file: f.file, status: 'error', action: 'none', reason: e && e.message ? e.message : String(e), url: f.url });
    }
  }
  for (const f of manifest.files) { const p = `${join(vendorDir, f.file)}.part`; if (existsSync(p)) rmSync(p, { force: true }); }
  const after = verifyVendor({ manifest, vendorDir });
  return { ok: after.ok, fetched, skipped, vendorDir, files, verify: after.files };
}

function parseArgs(argv) {
  const out = { verify: false, force: false, json: false, vendorDir: join(ROOT, 'vendor'), manifest: MANIFEST_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verify') out.verify = true;
    else if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--vendor-dir' && argv[i + 1]) { out.vendorDir = resolve(argv[i + 1]); i += 1; }
    else if (a === '--manifest' && argv[i + 1]) { out.manifest = resolve(argv[i + 1]); i += 1; }
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const line = (f) => `  ${f.status.padEnd(8)} ${f.file}${f.reason ? ` — ${f.reason}` : ''}${f.action === 'written' ? ` (${f.bytes} bytes)` : ''}`;

export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let args;
  try { args = parseArgs(argv); } catch (e) { io.error(e.message); return 2; }
  if (args.help) { io.log('usage: node scripts/fetch-vendor.mjs [--verify] [--force] [--json] [--vendor-dir <dir>] [--manifest <file>]'); return 0; }
  let manifest;
  try { manifest = readManifest(args.manifest); } catch (e) { io.error(`vendor manifest unusable: ${e.message}`); return 2; }
  if (args.verify) {
    const v = verifyVendor({ manifest, vendorDir: args.vendorDir });
    if (args.json) io.log(JSON.stringify({ mode: 'verify', three_version: manifest.three_version, ...v }, null, 2));
    else {
      io.log(`three@${manifest.three_version} in ${v.vendorDir}:`);
      for (const f of v.files) io.log(line(f));
      if (!v.ok) io.log(v.files.some((f) => f.status === 'mismatch') ? 'mismatch: a vendored file differs from its pinned digest — rerun without --verify (add --force) to refetch it' : 'incomplete: run node scripts/fetch-vendor.mjs');
    }
    return v.ok ? 0 : 1;
  }
  const r = await fetchVendor({ manifest, vendorDir: args.vendorDir, force: args.force });
  if (args.json) io.log(JSON.stringify({ mode: 'fetch', three_version: manifest.three_version, ...r }, null, 2));
  else {
    io.log(`three@${manifest.three_version} -> ${r.vendorDir} (${r.fetched} written, ${r.skipped} already current):`);
    for (const f of r.files) io.log(line(f));
    if (!r.ok) io.log('refused: nothing was written for the files above; the pinned digests in vendor/manifest.json stand');
  }
  return r.ok ? 0 : 1;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
}
