#!/usr/bin/env node
// scripts/fetch-archify-corpus.mjs — fill test/fixtures/archify/ with the
// archify example files (and archify's LICENSE) that
// test/fixtures/archify/manifest.json pins by commit and sha256. archify is
// MIT (SPDX MIT), which permits redistribution with its notice, so the corpus
// is vendored and committed; this script is how it was fetched and how a
// maintainer re-checks or re-pins it. Every byte is checked against the
// pinned digest before anything is written; a mismatch is refused, nothing
// lands on disk for that file and the exit code is 1. `--verify` touches no
// network and reports the state on disk.
//
//   node scripts/fetch-archify-corpus.mjs [--force] [--json] [--dir <dir>] [--manifest <file>]
//   node scripts/fetch-archify-corpus.mjs --from <local-copy-dir>   (offline: same digests required)
//   node scripts/fetch-archify-corpus.mjs --verify [--json] [...]
//   node scripts/fetch-archify-corpus.mjs --repin <40-hex commit>   (fetch that commit, rewrite the digests)
//
// Exported for tests (zero network there: fetchCorpus takes a fetch stub):
//   readManifest(file) -> manifest        digest(bytes) -> 'sha256:<hex>'
//   entriesOf(manifest) -> [{file, path, sha256, bytes}]  (the examples, then the LICENSE)
//   urlOf(manifest, entry) -> raw.githubusercontent.com URL at the pinned commit
//   verifyCorpus({manifest, dir}) -> {ok, files[]}
//   fetchCorpus({manifest, dir, fetchImpl, force, from}) -> {ok, fetched, skipped, files[]}
//   repin({manifest, commit, fetchImpl}) -> {ok, manifest, bytes: Map<file, Buffer>, files[]}
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const CORPUS_DIR = join(ROOT, 'test', 'fixtures', 'archify');
export const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');
export const SCHEMA_VERSION = 'dotfield.archify-corpus/1';
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const RAW_PREFIX = 'https://raw.githubusercontent.com/';
/** A vendored file name: one plain name, no directory part, so nothing can be written outside the corpus folder. */
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export const REDISTRIBUTABLE_SPDX = Object.freeze(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

export const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Parse and validate the manifest; throws a plain Error naming the first problem. */
export function readManifest(file = MANIFEST_PATH) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  if (m.schema_version !== SCHEMA_VERSION) throw new Error(`manifest: schema_version must be ${SCHEMA_VERSION} (${file})`);
  if (typeof m.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repo)) throw new Error('manifest: repo must be <owner>/<name>');
  if (!COMMIT_RE.test(String(m.commit))) throw new Error('manifest: commit must be a 40-hex commit sha');
  const lic = m.license;
  if (!lic || typeof lic.name !== 'string' || typeof lic.spdx !== 'string' || !lic.file) throw new Error('manifest: license needs {name, spdx, file} (record the licence before vendoring)');
  if (!REDISTRIBUTABLE_SPDX.includes(lic.spdx)) throw new Error(`manifest: licence ${lic.spdx} is not one this script vendors; fetch at test time only (V2_PLAN §11 archify-corpus)`);
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('manifest: files[] is empty');
  if (!Array.isArray(m.diagram_types) || !m.diagram_types.every((t) => typeof t === 'string')) throw new Error('manifest: diagram_types[] must list archify diagram types');
  const seen = new Set();
  for (const f of [...m.files, lic.file]) {
    for (const k of ['file', 'path', 'sha256']) if (typeof f[k] !== 'string') throw new Error(`manifest: ${f.file || '?'} lacks ${k}`);
    if (!FILE_RE.test(f.file) || f.file === 'manifest.json') throw new Error(`manifest: ${f.file} must be a plain file name inside the corpus folder`);
    if (f.path.includes('..') || f.path.startsWith('/')) throw new Error(`manifest: ${f.file} path must be repository-relative`);
    if (!DIGEST_RE.test(f.sha256)) throw new Error(`manifest: ${f.file} sha256 must be sha256:<64 hex>`);
    if (seen.has(f.file)) throw new Error(`manifest: ${f.file} is listed twice`);
    seen.add(f.file);
  }
  return m;
}

/** The examples in manifest order, then the LICENSE. */
export function entriesOf(manifest) {
  return [...manifest.files, manifest.license.file];
}

export function urlOf(manifest, entry, commit = manifest.commit) {
  return `${RAW_PREFIX}${manifest.repo}/${commit}/${entry.path}`;
}

/** The state of every pinned file on disk: ok | missing | mismatch. */
export function verifyCorpus({ manifest, dir = CORPUS_DIR }) {
  const files = entriesOf(manifest).map((f) => {
    const path = join(dir, f.file);
    if (!existsSync(path)) return { file: f.file, status: 'missing', expected: f.sha256, actual: null };
    const actual = digest(readFileSync(path));
    return { file: f.file, status: actual === f.sha256 ? 'ok' : 'mismatch', expected: f.sha256, actual };
  });
  return { ok: files.every((f) => f.status === 'ok'), dir, commit: manifest.commit, files };
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
 * Fetch (or copy from `from`, a local folder holding the same file names)
 * every file whose on-disk digest is not already pinned, or all with force.
 * A file is written only when its bytes match the pinned sha256; one refusal
 * does not stop the others; `ok` is false unless every file verifies at the end.
 */
export async function fetchCorpus({ manifest, dir = CORPUS_DIR, fetchImpl = globalThis.fetch, force = false, from = null }) {
  if (!from && typeof fetchImpl !== 'function') throw new Error('no fetch available: Node >= 22.13 is required');
  const before = verifyCorpus({ manifest, dir });
  const files = []; let fetched = 0; let skipped = 0;
  for (const f of entriesOf(manifest)) {
    const state = before.files.find((x) => x.file === f.file);
    if (!force && state.status === 'ok') { skipped += 1; files.push({ ...state, action: 'kept' }); continue; }
    const source = from ? join(from, f.file) : urlOf(manifest, f);
    try {
      const bytes = from ? readFileSync(source) : await download(fetchImpl, source);
      const got = digest(bytes);
      if (got !== f.sha256) {
        files.push({ file: f.file, status: 'refused', action: 'none', reason: `bytes digest ${got} != pinned ${f.sha256}`, source });
        continue;
      }
      writeAtomic(join(dir, f.file), bytes);
      fetched += 1;
      files.push({ file: f.file, status: 'ok', action: 'written', bytes: bytes.length, sha256: got });
    } catch (e) {
      files.push({ file: f.file, status: 'error', action: 'none', reason: e && e.message ? e.message : String(e), source });
    }
  }
  for (const f of entriesOf(manifest)) { const p = `${join(dir, f.file)}.part`; if (existsSync(p)) rmSync(p, { force: true }); }
  const after = verifyCorpus({ manifest, dir });
  return { ok: after.ok, fetched, skipped, dir, commit: manifest.commit, files, verify: after.files };
}

/** Download every listed file at `commit` and return a manifest with that commit and the served digests (nothing written). */
export async function repin({ manifest, commit, fetchImpl = globalThis.fetch }) {
  if (!COMMIT_RE.test(String(commit))) throw new Error('repin: commit must be a 40-hex commit sha');
  const bytes = new Map(); const files = [];
  const next = JSON.parse(JSON.stringify(manifest));
  next.commit = commit;
  for (const f of [...next.files, next.license.file]) {
    try {
      const b = await download(fetchImpl, urlOf(next, f, commit));
      bytes.set(f.file, b);
      f.sha256 = digest(b); f.bytes = b.length;
      files.push({ file: f.file, status: 'ok', bytes: b.length, sha256: f.sha256 });
    } catch (e) {
      files.push({ file: f.file, status: 'error', reason: e && e.message ? e.message : String(e) });
    }
  }
  return { ok: files.every((f) => f.status === 'ok'), manifest: next, bytes, files };
}

function parseArgs(argv) {
  const out = { verify: false, force: false, json: false, dir: CORPUS_DIR, manifest: MANIFEST_PATH, from: null, repin: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { if (!argv[i + 1]) throw new Error(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--verify') out.verify = true;
    else if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dir') out.dir = resolve(value());
    else if (a === '--manifest') out.manifest = resolve(value());
    else if (a === '--from') out.from = resolve(value());
    else if (a === '--repin') out.repin = value();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const line = (f) => `  ${f.status.padEnd(8)} ${f.file}${f.reason ? ` — ${f.reason}` : ''}${f.action === 'written' ? ` (${f.bytes} bytes)` : ''}`;
export const USAGE = 'usage: node scripts/fetch-archify-corpus.mjs [--verify] [--force] [--from <dir>] [--repin <commit>] [--json] [--dir <dir>] [--manifest <file>]';

export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let args;
  try { args = parseArgs(argv); } catch (e) { io.error(`${e.message}\n${USAGE}`); return 2; }
  if (args.help) { io.log(USAGE); return 0; }
  let manifest;
  try { manifest = readManifest(args.manifest); } catch (e) { io.error(`archify corpus manifest unusable: ${e.message}`); return 2; }
  const head = `archify ${manifest.repo}@${manifest.commit.slice(0, 12)} (${manifest.license.spdx})`;
  if (args.verify) {
    const v = verifyCorpus({ manifest, dir: args.dir });
    if (args.json) io.log(JSON.stringify({ mode: 'verify', ...v }, null, 2));
    else {
      io.log(`${head} in ${v.dir}: ${v.files.filter((f) => f.status === 'ok').length} of ${v.files.length} files verify`);
      for (const f of v.files) if (f.status !== 'ok') io.log(line(f));
      if (!v.ok) io.log('rerun without --verify (add --force for a mismatch) to fetch the pinned bytes');
    }
    return v.ok ? 0 : 1;
  }
  if (args.repin) {
    const r = await repin({ manifest, commit: args.repin });
    if (!r.ok) { for (const f of r.files) if (f.status !== 'ok') io.error(line(f)); io.error('repin refused: nothing was written'); return 1; }
    for (const [file, b] of r.bytes) writeAtomic(join(args.dir, file), b);
    writeAtomic(args.manifest, Buffer.from(`${JSON.stringify(r.manifest, null, 2)}\n`));
    io.log(`re-pinned to ${args.repin}: ${r.files.length} files written with their served digests; review the diff before committing`);
    return 0;
  }
  const r = await fetchCorpus({ manifest, dir: args.dir, force: args.force, from: args.from });
  if (args.json) io.log(JSON.stringify({ mode: args.from ? 'copy' : 'fetch', ...r }, null, 2));
  else {
    io.log(`${head} -> ${r.dir} (${r.fetched} written, ${r.skipped} already current):`);
    for (const f of r.files) if (f.action !== 'kept') io.log(line(f));
    if (!r.ok) io.log('refused: nothing was written for the files above; the pinned digests in the manifest stand');
  }
  return r.ok ? 0 : 1;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
}
