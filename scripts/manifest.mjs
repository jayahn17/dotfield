#!/usr/bin/env node
// Regenerates skill-release.json and engine.manifest.json.
//
//   node scripts/manifest.mjs            write both files
//   node scripts/manifest.mjs --check    recompute and exit 1 on any difference
//
// engine.manifest.json hashes every file that is not the customer's
// (center/**) and not in fork_editable[] (a trailing / names a folder: every
// file under templates/ is the fork's). package.json and skill-release.json
// are hashed with their fork-editable fields blanked, so a fork may rename
// itself without tripping DF_ENGINE_MODIFIED. The output carries no timestamp:
// two runs over one tree are byte-identical, which is what --check relies on.
// `dotfield doctor` imports compareManifest() from here.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../lib/digest.mjs';
import { RULE_CATALOG_VERSION } from '../lib/rules.mjs';

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_FILE = 'skill-release.json';
export const MANIFEST_FILE = 'engine.manifest.json';
export { RULE_CATALOG_VERSION };
export const THREE_REVISION = '180';

/** Whole files a fork may edit, one folder prefix (trailing /: the sketch templates), plus the field-level exceptions. */
export const FORK_EDITABLE = [
  'README.md',
  'AGENTS.md',
  'templates/',
  'package.json#name',
  'package.json#description',
  'skill-release.json#name',
];
const NORMALIZED = { 'package.json': ['name', 'description'], 'skill-release.json': ['name'] };
/** Never hashed: the customer directory, owner data, derived output, deps, fetched assets. */
const SKIP_DIRS = new Set(['center', 'data', '.dotfield', 'node_modules', '.git']);
const SKIP_PATHS = new Set(['vendor/three', MANIFEST_FILE]);
const SKIP_SUFFIX = ['.generated.css'];

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;
const toPosix = (p) => p.split(sep).join('/');

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}
export const canonical = (value) => JSON.stringify(sortKeys(value));

export function listFiles(root, relDir = '') {
  const out = [];
  const start = relDir ? resolve(root, relDir) : root;
  if (!existsSync(start)) return out;
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name);
      const rel = toPosix(abs.slice(root.length + 1));
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(rel)) continue;
        stack.push(abs);
      } else if (entry.isFile() && !SKIP_PATHS.has(rel)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

export function isForkEditableFile(rel) {
  return FORK_EDITABLE.includes(rel) || FORK_EDITABLE.some((e) => e.endsWith('/') && rel.startsWith(e));
}

/** Digest of one file; fork-editable fields are blanked before hashing. */
export function fileDigest(root, rel) {
  const buf = readFileSync(resolve(root, rel));
  const fields = NORMALIZED[rel];
  if (!fields) return { digest: sha256(buf) };
  const doc = JSON.parse(buf.toString('utf8'));
  for (const f of fields) delete doc[f];
  return { digest: sha256(canonical(doc)), normalized: fields };
}

/**
 * One digest for a whole folder, computed exactly as lib/receipt.mjs
 * engineDigests() does (lib/digest.mjs digestTree over the same include), so a
 * receipt's engine_digests.match_release can be true against this release.
 */
export function treeDigest(root, relDir) {
  const include = relDir === 'schemas' ? (p) => p.endsWith('.json') : () => true;
  return digestTree(resolve(root, relDir), { include }).digest;
}

function schemaVersions(root) {
  const out = {};
  for (const rel of listFiles(root, 'schemas')) {
    if (!rel.endsWith('.schema.json')) continue;
    try {
      const doc = JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
      const name = rel.slice('schemas/'.length, -'.schema.json'.length);
      out[name] = typeof doc.$id === 'string' ? doc.$id : `dotfield.${name}/1`;
    } catch {
      // an unparsable schema fails validate.test.js; the manifest just skips it
    }
  }
  return out;
}

function readPackage(root) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
}

function readExistingName(root, file, fallback) {
  const abs = resolve(root, file);
  if (!existsSync(abs)) return fallback;
  try {
    const doc = JSON.parse(readFileSync(abs, 'utf8'));
    return typeof doc.name === 'string' ? doc.name : fallback;
  } catch {
    return fallback;
  }
}

/** skill-release.json content (keeps the fork's own `name`). */
export function buildRelease(root = DEFAULT_ROOT) {
  const pkg = readPackage(root);
  const minNode = String(pkg.engines?.node ?? '>=22.13').replace(/^[^\d]*/, '');
  return {
    name: readExistingName(root, RELEASE_FILE, pkg.name),
    version: pkg.version,
    schema_versions: schemaVersions(root),
    rule_catalog_version: RULE_CATALOG_VERSION,
    three_revision: THREE_REVISION,
    min_node: minNode,
    digests: { lib: treeDigest(root, 'lib'), schemas: treeDigest(root, 'schemas') },
    fork_editable: [...FORK_EDITABLE],
  };
}

/** engine.manifest.json content; expects skill-release.json to be current. */
export function buildManifest(root = DEFAULT_ROOT) {
  const pkg = readPackage(root);
  const files = {};
  for (const rel of listFiles(root)) {
    if (isForkEditableFile(rel)) continue;
    if (SKIP_SUFFIX.some((s) => rel.endsWith(s))) continue;
    files[rel] = fileDigest(root, rel);
  }
  return {
    schema_version: 'dotfield.engine-manifest/1',
    engine_version: pkg.version,
    algorithm: 'sha256',
    excluded: ['center/**', ...FORK_EDITABLE.map((e) => (e.endsWith('/') ? `${e}**` : e)), 'data/**', '.dotfield/**', 'vendor/three/**', '*.generated.css', MANIFEST_FILE],
    file_count: Object.keys(files).length,
    files,
  };
}

const render = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/** Write both files. Returns their contents. */
export function writeManifests(root = DEFAULT_ROOT) {
  const release = buildRelease(root);
  writeFileSync(resolve(root, RELEASE_FILE), render(release));
  const manifest = buildManifest(root);
  writeFileSync(resolve(root, MANIFEST_FILE), render(manifest));
  return { release, manifest };
}

/**
 * compareManifest(root, manifest?) → {ok, changed[], missing[], added[]}
 * `added` lists engine-area files the manifest does not know about.
 */
/** Files npm never puts in a package: absent from an engine installed through npm or npx, which is not a modification. */
export const NPM_NEVER_PACKED = Object.freeze(new Set(['.gitignore', '.npmignore', '.npmrc', 'package-lock.json']));

export function compareManifest(root = DEFAULT_ROOT, manifest = null) {
  const known = manifest ?? JSON.parse(readFileSync(resolve(root, MANIFEST_FILE), 'utf8'));
  const current = buildManifest(root).files;
  const changed = [];
  const missing = [];
  for (const [rel, entry] of Object.entries(known.files ?? {})) {
    if (!current[rel]) { if (!NPM_NEVER_PACKED.has(rel)) missing.push(rel); }
    else if (current[rel].digest !== entry.digest) changed.push(rel);
  }
  const added = Object.keys(current).filter((rel) => !known.files?.[rel]);
  return { ok: changed.length === 0 && missing.length === 0 && added.length === 0, changed, missing, added };
}

/** --check: both files must equal a fresh build byte for byte. */
export function checkManifests(root = DEFAULT_ROOT) {
  const diffs = [];
  const want = { [RELEASE_FILE]: render(buildRelease(root)) };
  want[MANIFEST_FILE] = render(buildManifest(root));
  for (const [file, expected] of Object.entries(want)) {
    const abs = resolve(root, file);
    if (!existsSync(abs)) diffs.push(`${file}: missing (run: node scripts/manifest.mjs)`);
    else if (readFileSync(abs, 'utf8') !== expected) diffs.push(`${file}: stale (run: node scripts/manifest.mjs)`);
  }
  if (existsSync(resolve(root, MANIFEST_FILE))) {
    const cmp = compareManifest(root);
    for (const rel of cmp.changed) diffs.push(`changed: ${rel}`);
    for (const rel of cmp.missing) diffs.push(`missing: ${rel}`);
    for (const rel of cmp.added) diffs.push(`unlisted: ${rel}`);
  }
  return { ok: diffs.length === 0, diffs };
}

function main(argv) {
  const check = argv.includes('--check');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : DEFAULT_ROOT;
  if (check) {
    const result = checkManifests(root);
    if (result.ok) {
      process.stdout.write(`manifest: ok (${Object.keys(buildManifest(root).files).length} engine files)\n`);
      return 0;
    }
    for (const line of result.diffs) process.stdout.write(`manifest: ${line}\n`);
    return 1;
  }
  const { release, manifest } = writeManifests(root);
  process.stdout.write(`wrote ${RELEASE_FILE} (lib ${release.digests.lib.slice(0, 19)}…, schemas ${release.digests.schemas.slice(0, 19)}…)\n`);
  process.stdout.write(`wrote ${MANIFEST_FILE} (${manifest.file_count} engine files)\n`);
  return 0;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
