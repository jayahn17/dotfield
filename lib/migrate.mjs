// Migrations (VISION §2.1, §6, §8.2): migrations/NNNN-<name>.mjs each export
// {from, to, kind, migrate(doc) -> doc} and move one kind of center document
// (center-config, brand, room, people) from one schema_version to the next.
// planMigrations() chains them per file without writing; applyPlan() backs
// every file up under .dotfield/migrate-<ts>/ (same relative path) before
// the atomic rewrite, and refuses a result that fails the shipped schema.
// packPlans() compares each installed pack with center/ through
// center/pack-lock.json (lib/packs.mjs: what init copied, what the owner has,
// what the pack ships now); applyPacks() writes only the files the owner
// never touched, backs each one up first, leaves every file the owner
// changed as it is (the shipped version goes beside the backups for a hand
// merge), and moves installed_packs forward once nothing is left to merge.
// No clock is read here: callers pass now.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, digestTree } from './digest.mjs';
import { MERGE_ACTIONS, PACK_LOCK, applyPackUpdates, packUpdatePlan, readLock, writeLock } from './packs.mjs';
import { compactStamp } from './receipt.mjs';
import { listRoomIds, schemaChecks, writeJsonAtomic } from './rooms.mjs';
import { fail, pass } from './rules.mjs';
import { tryLoadSchema, validate } from './validate.mjs';

export const MIGRATION_RE = /^([0-9]{4})-([a-z0-9][a-z0-9-]*)\.mjs$/;
export const KINDS = Object.freeze(['center-config', 'brand', 'room', 'people']);
export const SCHEMA_OF = Object.freeze({ 'center-config': 'center-config', brand: 'brand', room: 'room', people: null });
export const MAX_CHAIN = 32;
const posix = (p) => p.split(sep).join('/');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readJson(file) {
  try { return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** The center files a migration kind applies to (existing ones only). */
export function targetsFor(kind, centerDir) {
  const files = kind === 'center-config' ? [join(centerDir, 'center.config.json')]
    : kind === 'brand' ? [join(centerDir, 'brand.json')]
      : kind === 'room' ? listRoomIds(centerDir).map((id) => join(centerDir, 'rooms', id, 'room.json'))
        : kind === 'people' ? [join(centerDir, 'people', 'people.json')] : [];
  return files.filter(existsSync);
}

/** loadMigrations(dir) -> {migrations: [{file, id, name, from, to, kind, migrate, path}] sorted, checks}. */
export async function loadMigrations(dir) {
  const checks = [];
  const migrations = [];
  if (!dir || !existsSync(dir)) return { migrations, checks };
  for (const file of readdirSync(dir).filter((f) => MIGRATION_RE.test(f)).sort()) {
    const path = join(dir, file);
    let mod;
    try { mod = await import(pathToFileURL(path).href); } catch (e) { checks.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: `migrations/${file}`, detail: `cannot be loaded: ${e && e.message ? e.message : String(e)}` })); continue; }
    const fn = [mod.migrate, mod.up, mod.default].find((f) => typeof f === 'function') ?? null;
    const missing = [['from', typeof mod.from === 'string'], ['to', typeof mod.to === 'string'], ['kind', KINDS.includes(mod.kind)], ['migrate()', Boolean(fn)]].filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) { checks.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: `migrations/${file}`, detail: `exports missing or invalid: ${missing.join(', ')}` })); continue; }
    const m = MIGRATION_RE.exec(file);
    migrations.push({ file, id: m[1], name: m[2], from: mod.from, to: mod.to, kind: mod.kind, migrate: fn, path });
  }
  return { migrations, checks };
}

/** LCS line diff: ['-old', '+new', ' same', ...]. Files are small; O(n·m) is fine. */
export function diffLines(a, b) {
  const A = String(a).split('\n'); const B = String(b).split('\n');
  const n = A.length; const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(` ${A[i]}`); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${A[i]}`); i += 1; } else { out.push(`+${B[j]}`); j += 1; }
  }
  while (i < n) { out.push(`-${A[i]}`); i += 1; }
  while (j < m) { out.push(`+${B[j]}`); j += 1; }
  return out;
}

/** A readable patch: headers, changed lines with `context` unchanged lines around them, long unchanged runs folded. */
export function diffText(a, b, { label = 'file', context = 2 } = {}) {
  const lines = diffLines(a, b);
  if (!lines.some((l) => l[0] !== ' ')) return '';
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, k) => { if (l[0] !== ' ') for (let d = -context; d <= context; d += 1) if (lines[k + d] !== undefined) keep[k + d] = true; });
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let skipped = 0;
  lines.forEach((l, k) => { if (keep[k]) { if (skipped) out.push(`@@ ${skipped} unchanged line(s) @@`); skipped = 0; out.push(l); } else skipped += 1; });
  if (skipped) out.push(`@@ ${skipped} unchanged line(s) @@`);
  return `${out.join('\n')}\n`;
}

function validateResult(kind, doc) {
  const name = SCHEMA_OF[kind];
  const loaded = name ? tryLoadSchema(name) : { ok: false };
  if (!loaded.ok) return { validated: false, checks: [] };
  const sv = loaded.schema.properties && loaded.schema.properties.schema_version;
  const pinned = sv && (sv.const !== undefined ? [sv.const] : Array.isArray(sv.enum) ? sv.enum : null);
  if (pinned && !pinned.includes(doc.schema_version)) return { validated: false, checks: [] };
  return { validated: true, checks: schemaChecks(validate(loaded.schema, doc).errors, kind) };
}

/**
 * planMigrations(migrations, {centerDir, root}) -> {steps, checks}
 * step = {file, ref, kind, from, to, chain: [migration files], before, after, patch, valid, checks}
 */
export function planMigrations(migrations, { centerDir, root }) {
  const steps = [];
  const checks = [];
  for (const kind of KINDS) {
    for (const file of targetsFor(kind, centerDir)) {
      const read = readJson(file);
      if (!read.ok || !isObject(read.doc)) continue;
      let current = read.doc;
      const chain = [];
      const used = new Set();
      while (chain.length < MAX_CHAIN) {
        const m = migrations.find((x) => x.kind === kind && x.from === current.schema_version && !used.has(x.file));
        if (!m) break;
        used.add(m.file);
        const next = m.migrate(structuredClone(current));
        if (!isObject(next)) { checks.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: `migrations/${m.file}`, detail: 'migrate() returned no document' })); break; }
        chain.push(m.file);
        current = next;
      }
      if (!chain.length) continue;
      const ref = posix(relative(root, file));
      const v = validateResult(kind, current);
      const before = `${JSON.stringify(read.doc, null, 2)}\n`;
      const after = `${JSON.stringify(current, null, 2)}\n`;
      steps.push({ file, ref, kind, from: read.doc.schema_version, to: current.schema_version, chain, before: read.doc, after: current, patch: diffText(before, after, { label: ref }), valid: !v.checks.some((c) => c.blocking), validated: v.validated, checks: v.checks });
    }
  }
  return { steps, checks };
}

/** applyPlan(steps, {root, dotDir, now, dryRun}) -> {backupDir, written: [{file, ref, backup}], skipped: [ref]}. Valid steps only; a dry run writes nothing. */
export function applyPlan(steps, { root, dotDir, now, dryRun = false }) {
  const out = { backupDir: null, written: [], skipped: steps.filter((s) => !s.valid).map((s) => s.ref) };
  const todo = steps.filter((s) => s.valid);
  if (dryRun || !todo.length) return out;
  out.backupDir = join(dotDir, `migrate-${compactStamp(now)}`);
  for (const s of todo) {
    const backup = join(out.backupDir, relative(root, s.file));
    mkdirSync(join(backup, '..'), { recursive: true });
    cpSync(s.file, backup);
    writeJsonAtomic(s.file, s.after);
    out.written.push({ file: s.file, ref: s.ref, backup });
  }
  return out;
}

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** packPlans({packsDir, centerDir, config}) -> {lock, plans: [{pack, packDir, version, digest, rows: [{centerRel, action, patch}]}], checks}. Reads only. */
export function packPlans({ packsDir, centerDir, config }) {
  const lock = readLock(centerDir);
  const plans = [];
  const checks = [];
  let drift = 0;
  for (const installed of Array.isArray(config && config.installed_packs) ? config.installed_packs : []) {
    const packDir = join(packsDir, installed.id);
    const pack = readJson(join(packDir, 'pack.json'));
    if (!pack.ok || !isObject(pack.doc)) { plans.push({ pack: installed.id, packDir, version: null, digest: null, missing: true, rows: [] }); continue; }
    const digest = digestTree(packDir).digest;
    if (installed.version !== pack.doc.version || installed.digest !== digest) { drift += 1; checks.push(fail('DF_PACK_VERSION_DRIFT', { path: `center/center.config.json#$.installed_packs[${installed.id}]`, detail: `installed ${installed.version} (${String(installed.digest).slice(0, 15)}…), shipped ${pack.doc.version} (${digest.slice(0, 15)}…)` })); }
    const rows = packUpdatePlan({ packDir, packId: installed.id, centerDir, lock }).map((r) => {
      const label = `center/${r.centerRel}`;
      const shows = r.action === 'update' || r.action === 'add' || MERGE_ACTIONS.includes(r.action);
      return { ...r, patch: shows && r.packRel ? diffText(readText(join(centerDir, r.centerRel)), readText(join(packDir, r.packRel)), { label }) : '' };
    });
    plans.push({ pack: installed.id, packDir, version: pack.doc.version, digest, missing: false, rows });
  }
  if (!drift) checks.push(pass('DF_PACK_VERSION_DRIFT'));
  return { lock, plans, checks };
}

/**
 * applyPacks(plans, {lock, centerDir, root, backupDir, resolved}) -> {written: [{file, ref, backup}], merges: [{ref, shipped}], advanced: [pack ids]}
 * update/add rows are written (each replaced file backed up first); merge rows keep the owner's file and copy the
 * shipped one to <backupDir>/shipped/; `resolved` (dotfield migrate --resolved) records those as merged instead.
 * The lock follows every row it settled; installed_packs moves to the shipped version once a pack has no merge left.
 */
export function applyPacks(plans, { lock, centerDir, root, backupDir, resolved = false }) {
  const out = { written: [], merges: [], advanced: [] };
  const next = { packs: { ...(lock && isObject(lock.packs) ? lock.packs : {}) } };
  const backup = (file) => { if (!existsSync(file)) return null; const b = join(backupDir, 'center', relative(centerDir, file)); mkdirSync(join(b, '..'), { recursive: true }); cpSync(file, b); return b; };
  const config = readJson(join(centerDir, 'center.config.json'));
  let configChanged = false;
  for (const plan of plans.filter((p) => !p.missing)) {
    const apply = applyPackUpdates(plan.rows.filter((r) => r.action === 'update' || r.action === 'add'), { packDir: plan.packDir, centerDir, backupDir });
    for (const r of apply.written) {
      const file = join(centerDir, r.centerRel);
      const b = join(backupDir, 'center', r.centerRel);
      out.written.push({ file, ref: posix(relative(root, file)), backup: existsSync(b) ? b : null });
    }
    const files = {};
    let open = 0;
    for (const r of plan.rows) {
      if (r.action === 'dropped_by_pack') continue;
      if (MERGE_ACTIONS.includes(r.action) && !resolved) {
        open += 1;
        if (r.lockNow) files[r.centerRel] = r.lockNow;
        out.merges.push(...applyPackUpdates([r], { packDir: plan.packDir, centerDir, backupDir }).conflicts.map((c) => ({ ref: posix(relative(root, join(centerDir, c.centerRel))), shipped: c.shipped, action: r.action })));
      } else files[r.centerRel] = r.packNow;
    }
    next.packs[plan.pack] = { version: open ? (next.packs[plan.pack] && next.packs[plan.pack].version) ?? null : plan.version, files };
    if (!open && config.ok && Array.isArray(config.doc.installed_packs)) {
      const i = config.doc.installed_packs.findIndex((x) => isObject(x) && x.id === plan.pack);
      const want = { id: plan.pack, version: plan.version, digest: plan.digest };
      if (i >= 0 && canonical(config.doc.installed_packs[i]) !== canonical(want)) { config.doc.installed_packs[i] = want; configChanged = true; out.advanced.push(plan.pack); }
    }
  }
  if (!lock || canonical(lock.packs) !== canonical(next.packs)) {
    const file = join(centerDir, PACK_LOCK);
    const b = backup(file);
    writeLock(centerDir, next);
    out.written.push({ file, ref: posix(relative(root, file)), backup: b });
  }
  if (configChanged) {
    const file = join(centerDir, 'center.config.json');
    const b = backup(file);
    writeJsonAtomic(file, config.doc);
    out.written.push({ file, ref: posix(relative(root, file)), backup: b });
  }
  return out;
}

/**
 * migrate({packageRoot, centerDir, dotDir, root, config, now, dryRun, resolved, migrationsDir, packsDir})
 *   -> {migrations, steps, applied, packs, packApplied, checks, patch}
 */
export async function migrate({ packageRoot, centerDir, dotDir, root, config = null, now, dryRun = false, resolved = false, migrationsDir = null, packsDir = null } = {}) {
  if (now === undefined || now === null) throw new TypeError('migrate needs now (ctx.now)');
  const loaded = await loadMigrations(migrationsDir ?? join(packageRoot, 'migrations'));
  const plan = planMigrations(loaded.migrations, { centerDir, root });
  const applied = applyPlan(plan.steps, { root, dotDir, now, dryRun });
  const packs = packPlans({ packsDir: packsDir ?? join(packageRoot, 'packs'), centerDir, config });
  const touchesPacks = packs.plans.some((p) => p.rows.some((r) => r.action !== 'same' && r.action !== 'kept_deleted')) || (!packs.lock && packs.plans.some((p) => !p.missing));
  const backupDir = applied.backupDir ?? join(dotDir, `migrate-${compactStamp(now)}`);
  const packApplied = dryRun || !touchesPacks ? { written: [], merges: [], advanced: [] } : applyPacks(packs.plans, { lock: packs.lock, centerDir, root, backupDir, resolved });
  if ((packApplied.written.length || packApplied.merges.length) && !applied.backupDir) applied.backupDir = backupDir;
  // A pack this run moved to the shipped version no longer drifts.
  const settled = (c) => c.code === 'DF_PACK_VERSION_DRIFT' && c.status === 'fail' && packApplied.advanced.some((id) => String(c.path).endsWith(`[${id}]`));
  const packChecks = packs.checks.filter((c) => !settled(c));
  if (packChecks.length < packs.checks.length && !packChecks.some((c) => c.code === 'DF_PACK_VERSION_DRIFT')) packChecks.push(pass('DF_PACK_VERSION_DRIFT'));
  const checks = [...loaded.checks, ...plan.checks, ...plan.steps.flatMap((s) => s.checks), ...packChecks];
  const pending = plan.steps.filter((s) => !applied.written.some((w) => w.file === s.file));
  for (const s of pending) checks.push(fail('DF_ENGINE_MIGRATION_PENDING', { path: s.ref, detail: `${s.from} → ${s.to} via ${s.chain.join(', ')}${s.valid ? (dryRun ? ' (dry run; nothing written)' : '') : ' (refused: the result fails its schema)'}` }));
  if (!checks.some((c) => c.code === 'DF_ENGINE_MIGRATION_PENDING')) checks.push(pass('DF_ENGINE_MIGRATION_PENDING'));
  const packPatches = packs.plans.flatMap((p) => p.rows.filter((r) => r.patch).map((r) => r.patch));
  const patch = [...plan.steps.map((s) => s.patch), ...packPatches].filter(Boolean).join('\n');
  return { migrations: loaded.migrations, steps: plan.steps, applied, packs, packApplied, checks, patch };
}
