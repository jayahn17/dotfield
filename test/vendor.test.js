// vendor/manifest.json pins three@0.180.0 and scripts/fetch-vendor.mjs fills
// vendor/three/ by hash. These tests check the pin against html.mjs's
// importmap table, drive the fetcher with a stub fetch in a temp dir (zero
// network), and, when the real vendor files are present, check both digests,
// the specifier rewrite and REVISION === '180'. They skip the real-file
// checks with a named reason when vendor/three/ is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withTmp } from './helpers/tmp.mjs';
import { ROOT, read } from './helpers/scan.mjs';
import { readManifest, rewriteCore, digest, verifyVendor, fetchVendor, DIGEST_RE, MANIFEST_PATH } from '../scripts/fetch-vendor.mjs';
import { THREE_SPECIFIERS, CDN_BASE, THREE_VERSION, readVendorManifest, toIntegrity } from '../renderers/html.mjs';

const VENDOR_DIR = join(ROOT, 'vendor');
const manifest = readManifest(MANIFEST_PATH);
const vendorPresent = manifest.files.every((f) => existsSync(join(VENDOR_DIR, f.file)));
const SKIP = vendorPresent ? false : 'vendor/three/ is absent: run node scripts/fetch-vendor.mjs (network) and rerun';
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

/** A manifest over stub module texts, with the rewrite target carrying `count` core specifiers. */
function stubWorld(dir, { count = 2, vendorSub = 'vendor' } = {}) {
  const core = "export const REVISION = '180';\nexport class Vector3 {}\n";
  const spec = Array.from({ length: count }, (_, i) => (i === 0 ? "import { Vector3 } from './three.core.js';" : "export * from './three.core.js';")).join('\n');
  const texts = {
    'three/three.module.js': `${spec}\nexport { Vector3 };\nexport class WebGLRenderer {}\n`,
    'three/three.core.js': core,
    'three/OrbitControls.js': 'export class OrbitControls {}\n',
    'three/XRButton.js': 'export class XRButton { static createButton() { return null; } }\n',
  };
  const rewrite = { file: 'three/three.module.js', from: './three.core.js', to: 'three/core', count };
  const files = manifest.files.map((f) => {
    const pre = texts[f.file]; const post = f.file === rewrite.file ? rewriteCore(pre, rewrite).text : pre;
    return { specifier: f.specifier, file: f.file, url: f.url, sha256_pre: sha(pre), sha256_post: sha(post) };
  });
  const m = { ...manifest, rewrite, files };
  const vendorDir = join(dir, vendorSub); mkdirSync(vendorDir, { recursive: true });
  const manifestPath = join(vendorDir, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(m));
  const served = Object.fromEntries(manifest.files.map((f) => [f.url, texts[f.file]]));
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); const body = served[url]; return body === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf8') }; };
  return { m, manifestPath, vendorDir, texts, served, fetchImpl, calls };
}

test('the manifest pins three@0.180.0 on jsdelivr with the four importmap specifiers, both digests and SRI', () => {
  assert.equal(manifest.schema_version, 'dotfield.vendor/1');
  assert.equal(manifest.three_version, THREE_VERSION);
  assert.equal(manifest.three_revision, '180');
  assert.equal(manifest.three_revision, JSON.parse(read('skill-release.json')).three_revision, 'skill-release.json#three_revision is the same pin');
  assert.equal(manifest.cdn_base, CDN_BASE);
  assert.deepEqual(manifest.files.map((f) => f.specifier), THREE_SPECIFIERS.map((s) => s.specifier));
  for (const s of THREE_SPECIFIERS) {
    const f = manifest.files.find((x) => x.specifier === s.specifier);
    assert.equal(f.file, `three/${s.file}`, s.specifier);
    assert.equal(f.url, `${CDN_BASE}${s.cdn}`, s.specifier);
    assert.match(f.sha256_pre, DIGEST_RE); assert.match(f.sha256_post, DIGEST_RE);
    assert.equal(f.integrity, toIntegrity(f.sha256_pre), 'integrity is the SRI form of the served digest');
    assert.equal(f.sha256_post === f.sha256_pre, f.file !== manifest.rewrite.file, 'only the rewrite target changes on disk');
  }
  assert.deepEqual({ file: manifest.rewrite.file, from: manifest.rewrite.from, to: manifest.rewrite.to }, { file: 'three/three.module.js', from: './three.core.js', to: 'three/core' });
  assert.ok(Number.isInteger(manifest.rewrite.count) && manifest.rewrite.count >= 1);
  const seen = readVendorManifest(VENDOR_DIR);
  for (const s of THREE_SPECIFIERS) { assert.equal(seen[s.specifier].url, `${CDN_BASE}${s.cdn}`); assert.match(seen[s.specifier].integrity, /^sha256-[A-Za-z0-9+/=]+$/); }
  assert.match(read('.gitignore'), /^vendor\/three\/$/m, 'the fetched files stay out of git');
});

test('rewriteCore rewrites every quoted core specifier and reports the count; readManifest refuses a malformed pin', async () => {
  const rw = manifest.rewrite;
  const one = rewriteCore("import { A } from './three.core.js';\nconst s = 'three.core.js';\n", rw);
  assert.equal(one.count, 1); assert.match(one.text, /from 'three\/core'/); assert.doesNotMatch(one.text, /\.\/three\.core\.js/);
  const quoted = (spec) => `const a = "${spec}"; const b = '${spec}'; const c = "x${spec}";`;
  const two = rewriteCore(quoted(rw.from), rw);
  assert.equal(two.count, 2, 'both quote styles count; a specifier inside a longer string does not'); assert.equal(two.text, quoted(rw.to).replace(`"x${rw.to}"`, `"x${rw.from}"`));
  assert.equal(rewriteCore('nothing here', rw).count, 0);
  await withTmp(async (dir) => {
    const bad = join(dir, 'm.json');
    writeFileSync(bad, JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], url: 'https://example.invalid/three.js' }] }));
    assert.throws(() => readManifest(bad), /not under https:\/\/cdn\.jsdelivr\.net\/npm\/three@/);
    writeFileSync(bad, JSON.stringify({ ...manifest, rewrite: { ...manifest.rewrite, count: 0 } }));
    assert.throws(() => readManifest(bad), /count >= 1/);
    writeFileSync(bad, JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], sha256_pre: 'sha256:short' }] }));
    assert.throws(() => readManifest(bad), /sha256:<64 hex>/);
  });
});

test('fetchVendor writes only bytes that match sha256_pre, rewrites with the pinned count, and refuses a mismatch (stub fetch, temp dir)', async () => {
  await withTmp(async (dir) => {
    const w = stubWorld(dir);
    assert.equal(verifyVendor({ manifest: w.m, vendorDir: w.vendorDir }).ok, false);
    const r = await fetchVendor({ manifest: w.m, vendorDir: w.vendorDir, fetchImpl: w.fetchImpl });
    assert.equal(r.ok, true); assert.equal(r.fetched, 4); assert.equal(r.skipped, 0); assert.equal(w.calls.length, 4);
    const onDisk = readFileSync(join(w.vendorDir, 'three/three.module.js'), 'utf8');
    assert.doesNotMatch(onDisk, /\.\/three\.core\.js/); assert.equal((onDisk.match(/'three\/core'/g) || []).length, 2);
    assert.equal(digest(readFileSync(join(w.vendorDir, 'three/three.module.js'))), w.m.files[0].sha256_post);
    assert.equal(verifyVendor({ manifest: w.m, vendorDir: w.vendorDir }).ok, true);
    const again = await fetchVendor({ manifest: w.m, vendorDir: w.vendorDir, fetchImpl: w.fetchImpl });
    assert.equal(again.fetched, 0); assert.equal(again.skipped, 4); assert.equal(w.calls.length, 4, 'files already current are not refetched');
    const forced = await fetchVendor({ manifest: w.m, vendorDir: w.vendorDir, fetchImpl: w.fetchImpl, force: true });
    assert.equal(forced.fetched, 4); assert.equal(w.calls.length, 8);
    // a tampered CDN body: refused, the good file on disk untouched
    const tampered = { ...w.served, [w.m.files[1].url]: `${w.texts['three/three.core.js']}// extra\n` };
    const bad = await fetchVendor({ manifest: w.m, vendorDir: join(dir, 'v2'), fetchImpl: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(tampered[url], 'utf8') }) });
    assert.equal(bad.ok, false);
    const core = bad.files.find((f) => f.file === 'three/three.core.js');
    assert.equal(core.status, 'refused'); assert.match(core.reason, /sha256_pre/); assert.equal(existsSync(join(dir, 'v2', 'three/three.core.js')), false);
    assert.equal(bad.files.filter((f) => f.status === 'ok').length, 3);
    // a module whose core specifier count drifted: refused by the count assertion
    const drift = stubWorld(join(dir, 'drift'), { count: 1 });
    drift.m.rewrite.count = 2; drift.m.files[0].sha256_post = sha(rewriteCore(drift.texts['three/three.module.js'], drift.m.rewrite).text);
    const d = await fetchVendor({ manifest: drift.m, vendorDir: drift.vendorDir, fetchImpl: drift.fetchImpl });
    const mod = d.files.find((f) => f.file === 'three/three.module.js');
    assert.equal(mod.status, 'refused'); assert.match(mod.reason, /occurs 1 times, manifest pins 2/);
    assert.equal(existsSync(join(drift.vendorDir, 'three/three.module.js')), false);
    // a 404 is an error, not a crash
    const missing = await fetchVendor({ manifest: w.m, vendorDir: join(dir, 'v3'), fetchImpl: async () => ({ ok: false, status: 404 }) });
    assert.equal(missing.ok, false); assert.ok(missing.files.every((f) => f.status === 'error' && /404/.test(f.reason)));
  });
});

test('the CLI: --verify exits 1 and names the missing files, 0 once the stub fetch has filled the dir; --json is machine-readable', async () => {
  await withTmp(async (dir) => {
    const w = stubWorld(dir);
    const run = (args) => spawnSync(process.execPath, [join(ROOT, 'scripts/fetch-vendor.mjs'), ...args, '--vendor-dir', w.vendorDir, '--manifest', w.manifestPath], { encoding: 'utf8' });
    const before = run(['--verify', '--json']);
    assert.equal(before.status, 1, before.stderr);
    const rep = JSON.parse(before.stdout);
    assert.equal(rep.mode, 'verify'); assert.equal(rep.ok, false); assert.equal(rep.files.filter((f) => f.status === 'missing').length, 4);
    await fetchVendor({ manifest: w.m, vendorDir: w.vendorDir, fetchImpl: w.fetchImpl });
    const after = run(['--verify']);
    assert.equal(after.status, 0, after.stderr); assert.match(after.stdout, /ok\s+three\/three\.module\.js/);
    writeFileSync(join(w.vendorDir, 'three/XRButton.js'), 'tampered');
    const tampered = run(['--verify']);
    assert.equal(tampered.status, 1); assert.match(tampered.stdout, /mismatch\s+three\/XRButton\.js/);
    assert.equal(run(['--bogus']).status, 2);
  });
});

test('the real vendored files match sha256_post, carry the rewrite and no stale core specifier, and REVISION is 180', { skip: SKIP }, async () => {
  const v = verifyVendor({ manifest, vendorDir: VENDOR_DIR });
  assert.deepEqual(v.files.map((f) => [f.file, f.status]), manifest.files.map((f) => [f.file, 'ok']));
  const mod = readFileSync(join(VENDOR_DIR, 'three/three.module.js'), 'utf8');
  assert.doesNotMatch(mod, /\.\/three\.core\.js/, 'the vendored module names its core only through the importmap');
  assert.equal((mod.match(/(['"])three\/core\1/g) || []).length, manifest.rewrite.count);
  for (const f of manifest.files) assert.equal(readFileSync(join(VENDOR_DIR, f.file)).length, f.bytes_post, `${f.file} byte count`);
  const core = await import(pathToFileURL(join(VENDOR_DIR, 'three/three.core.js')).href);
  assert.equal(core.REVISION, '180');
  assert.equal(typeof core.InstancedMesh, 'function');
});

test('fetch-vendor.mjs never embeds the parent repo or a second three: only node: builtins are imported', () => {
  const text = read('scripts/fetch-vendor.mjs');
  for (const m of text.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^node:/, m[1]);
});
