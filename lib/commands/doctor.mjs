// dotfield doctor [--fetch-vendor] (VISION §8.2): node ≥ min_node, the
// configured provider, the optional MCP SDK, vendored three.js hashes,
// DF_ENGINE_MODIFIED against engine.manifest.json, pending migrations, the
// key files and the store target. A report, not a run: provider and SDK
// findings are non-blocking here; only an old Node or a tampered vendor file
// blocks. --fetch-vendor delegates to scripts/fetch-vendor.mjs when present.
import { existsSync, readdirSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256File } from '../digest.mjs';
import { buildReceipt } from '../receipt.mjs';
import { PINNED, fail, pass } from '../rules.mjs';
import { compareManifest } from '../../scripts/manifest.mjs';
import { keysStatus } from '../context.mjs';
import { isBlockingFail, readJsonFile } from '../pipeline.mjs';

export const verb = 'doctor';
export const leaves = ['doctor'];
export const usage = 'doctor [--fetch-vendor] [--json]';
export const ADAPTERS = Object.freeze(['dry', 'claude-cli', 'anthropic', 'relay']);
export const VENDOR_FILES = Object.freeze(['three.module.js', 'three.core.js', 'OrbitControls.js', 'XRButton.js']);
const soft = (c) => ({ ...c, blocking: false });
/** DF_ENGINE_MODIFIED entries listed before one summary entry (a stale manifest should not drown the report). */
export const MAX_LISTED = 10;

/** '24.18.0' >= '22.13' by numeric parts. */
export function versionAtLeast(current, min) {
  const a = String(current).split('.').map((x) => parseInt(x, 10) || 0);
  const b = String(min).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0; }
  return true;
}

export function findOnPath(env, name) {
  for (const dir of String(env && env.PATH ? env.PATH : '').split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

function engineChecks(root) {
  const out = [];
  out.push(existsSync(join(root, 'skill-release.json')) ? pass('DF_ENGINE_RELEASE_MISSING') : fail('DF_ENGINE_RELEASE_MISSING', { path: 'skill-release.json' }));
  if (!existsSync(join(root, 'engine.manifest.json'))) return [...out, fail('DF_ENGINE_MANIFEST_MISSING', { path: 'engine.manifest.json' }), pass('DF_ENGINE_MODIFIED')];
  out.push(pass('DF_ENGINE_MANIFEST_MISSING'));
  try {
    const cmp = compareManifest(root);
    if (cmp.ok) out.push(pass('DF_ENGINE_MODIFIED'));
    const all = [...cmp.changed.map((r) => [r, 'content differs from engine.manifest.json']), ...cmp.missing.map((r) => [r, 'listed in engine.manifest.json but absent']), ...cmp.added.map((r) => [r, 'not listed in engine.manifest.json'])];
    for (const [rel, detail] of all.slice(0, MAX_LISTED)) out.push(fail('DF_ENGINE_MODIFIED', { path: rel, detail }));
    if (all.length > MAX_LISTED) out.push(fail('DF_ENGINE_MODIFIED', { path: 'engine.manifest.json', detail: `${all.length - MAX_LISTED} more file(s) differ (${cmp.changed.length} changed, ${cmp.missing.length} missing, ${cmp.added.length} unlisted); run node scripts/manifest.mjs --check for the full list` }));
  } catch (e) { out.push(fail('DF_ENGINE_MANIFEST_MISSING', { path: 'engine.manifest.json', detail: `unreadable: ${e.message}` })); }
  return out;
}

function providerChecks(config, env) {
  const p = config && config.provider ? config.provider : null;
  if (!p) return [pass('DF_PROVIDER_UNKNOWN_ADAPTER'), soft(fail('DF_PROVIDER_UNAVAILABLE', { path: 'center/center.config.json#$.provider', detail: 'no center config, so no provider is configured' }))];
  if (!ADAPTERS.includes(p.adapter)) return [soft(fail('DF_PROVIDER_UNKNOWN_ADAPTER', { path: '$.provider.adapter', detail: `'${String(p.adapter)}'` })), pass('DF_PROVIDER_UNAVAILABLE')];
  const out = [pass('DF_PROVIDER_UNKNOWN_ADAPTER')];
  if (p.adapter === 'claude-cli' && !findOnPath(env, 'claude')) out.push(soft(fail('DF_PROVIDER_UNAVAILABLE', { path: '$.provider.adapter', detail: 'no `claude` executable on PATH' })));
  else if (p.adapter === 'anthropic' && !env.ANTHROPIC_API_KEY) out.push(soft(fail('DF_PROVIDER_UNAVAILABLE', { path: '$.provider.adapter', detail: 'ANTHROPIC_API_KEY is not set' })));
  else out.push(pass('DF_PROVIDER_UNAVAILABLE'));
  return out;
}

export function vendorChecks(root) {
  const manifest = readJsonFile(join(root, 'vendor', 'manifest.json'));
  if (!manifest.ok) return [fail('DF_ENGINE_VENDOR_MISSING', { path: 'vendor/manifest.json', detail: 'absent or unreadable (render-3d-vr not installed); 3D/VR renders fall back to the honest overlay' }), pass('DF_ENGINE_VENDOR_HASH_MISMATCH')];
  const rows = Array.isArray(manifest.doc.files) ? manifest.doc.files : Object.entries(manifest.doc.files || {}).map(([specifier, v]) => ({ specifier, ...v }));
  const out = [];
  let missing = 0; let bad = 0;
  for (const r of rows) {
    const name = basename(String(r.file || r.path || r.local || ''));
    if (!name) continue;
    const abs = join(root, 'vendor', 'three', name);
    if (!existsSync(abs)) { missing += 1; out.push(fail('DF_ENGINE_VENDOR_MISSING', { path: `vendor/three/${name}`, detail: 'not fetched' })); continue; }
    const want = r.sha256_post || r.post_sha256 || r.sha256 || null;
    if (want && sha256File(abs) !== want) { bad += 1; out.push(fail('DF_ENGINE_VENDOR_HASH_MISMATCH', { path: `vendor/three/${name}`, detail: `expected ${want}` })); }
  }
  if (!missing) out.push(pass('DF_ENGINE_VENDOR_MISSING'));
  if (!bad) out.push(pass('DF_ENGINE_VENDOR_HASH_MISMATCH'));
  return out;
}

const MIGRATION_TARGETS = { 'center-config': (ctx) => [join(ctx.centerDir, 'center.config.json')], brand: (ctx) => [join(ctx.centerDir, 'brand.json')], room: (ctx) => ctx.rooms().rooms.map((r) => r.files['room.json']).filter(Boolean), people: (ctx) => [join(ctx.centerDir, 'people', 'people.json')] };

async function migrationChecks(ctx) {
  const dir = join(ctx.packageRoot, 'migrations');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-.*\.mjs$/.test(f)).sort() : [];
  const out = [];
  for (const f of files) {
    let mod;
    try { mod = await import(pathToFileURL(join(dir, f)).href); } catch (e) { out.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: `migrations/${f}`, detail: `cannot be loaded: ${e.message}` })); continue; }
    const targets = MIGRATION_TARGETS[mod.kind];
    if (!targets) { out.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: `migrations/${f}`, detail: `unknown kind '${String(mod.kind)}'` })); continue; }
    for (const file of ctx.hasCenter ? targets(ctx) : []) {
      const doc = readJsonFile(file);
      if (doc.ok && doc.doc && doc.doc.schema_version === mod.from) out.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: ctx.relRef(file), detail: `${mod.from} → ${mod.to} (migrations/${f})` }));
    }
  }
  if (!out.length) out.push(pass('DF_ENGINE_MIGRATION_PENDING'));
  return out;
}

async function fetchVendor(ctx) {
  const script = join(ctx.packageRoot, 'scripts', 'fetch-vendor.mjs');
  if (!existsSync(script)) return [fail('DF_ENGINE_VENDOR_MISSING', { path: 'scripts/fetch-vendor.mjs', detail: 'not installed (render-3d-vr); nothing was fetched' })];
  try {
    const mod = await import(pathToFileURL(script).href);
    const fn = mod.fetchVendor || mod.main || mod.default;
    if (typeof fn !== 'function') throw new TypeError('scripts/fetch-vendor.mjs exports no fetchVendor()/main()');
    await fn({ root: ctx.packageRoot });
    return [];
  } catch (e) { return [fail('DF_ENGINE_VENDOR_MISSING', { path: 'vendor/three', detail: `fetch failed: ${e.message}` })]; }
}

export async function run(args, ctx) {
  const root = ctx.packageRoot;
  const checks = [];
  const nodeVersion = process.versions.node;
  checks.push(versionAtLeast(nodeVersion, PINNED.min_node) ? pass('DF_ENGINE_NODE_VERSION') : fail('DF_ENGINE_NODE_VERSION', { path: 'process.versions.node', detail: `${nodeVersion} < ${PINNED.min_node}` }));
  checks.push(...engineChecks(root));
  checks.push(...ctx.configChecks);
  checks.push(...providerChecks(ctx.config, ctx.env));
  checks.push(existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')) ? pass('DF_MCP_SDK_MISSING') : fail('DF_MCP_SDK_MISSING', { path: 'node_modules/@modelcontextprotocol/sdk', detail: 'npm install @modelcontextprotocol/sdk' }));
  if (args.flags['fetch-vendor'] === true) checks.push(...await fetchVendor(ctx));
  checks.push(...vendorChecks(root));
  const keys = keysStatus(ctx);
  checks.push(keys.missing.length ? fail('DF_ENGINE_KEYS_MISSING', { path: 'data/keys', detail: `missing ${keys.missing.join(', ')}` }) : pass('DF_ENGINE_KEYS_MISSING'));
  checks.push(...await migrationChecks(ctx));
  const inputs = ['skill-release.json', 'engine.manifest.json'].map((f) => ctx.inputRef(join(root, f))).concat(ctx.hasCenter ? [ctx.inputRef(join(ctx.centerDir, 'center.config.json'))] : []).filter(Boolean);
  const cfg = ctx.config;
  const url = cfg && cfg.store && typeof cfg.store.object_store_url === 'string' && cfg.store.object_store_url ? cfg.store.object_store_url : null;
  const provider = cfg && cfg.provider && ADAPTERS.includes(cfg.provider.adapter) ? { adapter: cfg.provider.adapter, model: typeof cfg.provider.model === 'string' ? cfg.provider.model : null } : null;
  const rooms = ctx.hasCenter ? ctx.rooms().rooms : [];
  const failed = checks.filter((c) => c.status === 'fail');
  const blocked = checks.some(isBlockingFail);
  return buildReceipt({
    command: verb, argv: args.argv, now: ctx.now, root, inputs, checks, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, provider,
    store: { target: url ?? 'data/rooms', backend: url ? 'object' : 'file' }, status: blocked ? 'blocked' : 'read',
    nextAction: blocked ? undefined : `node ${nodeVersion}, ${rooms.length} room(s)${ctx.hasCenter ? '' : ' (no center here)'}, ${failed.length ? `${failed.length} non-blocking finding(s): ${[...new Set(failed.map((c) => c.code))].join(', ')}` : 'everything in order'}.`,
  });
}
