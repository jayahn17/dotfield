// lib/migrate.mjs and dotfield migrate: migrations/NNNN-*.mjs chain per
// center file, a dry run writes nothing, an apply backs every file up under
// .dotfield/migrate-<ts>/ (the round trip: backup bytes == original bytes),
// a second run has nothing pending, an invalid module is reported, and pack
// updates go through center/pack-lock.json: a file the owner never touched is
// updated with a backup, a file the owner changed is kept (the shipped one
// goes beside the backups) and DF_PACK_VERSION_DRIFT stays until --resolved,
// a file the owner deleted stays deleted, a center without a lock adopts one
// and applies nothing it cannot tell apart. Temp dirs; DOTFIELD_MIGRATIONS_DIR
// / DOTFIELD_PACKS_DIR point the CLI at the temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { runCli } from './helpers/cli.mjs';
import { CENTER_MIN, EPOCH_ENV, NOW, patchJson, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { applyPacks, applyPlan, diffLines, diffText, loadMigrations, migrate, packPlans, planMigrations, targetsFor } from '../lib/migrate.mjs';
import { lockEntry, readLock, writeLock } from '../lib/packs.mjs';
import { digestTree } from '../lib/digest.mjs';

const MIGRATION = `export const from = 'dotfield.center-config/1';
export const to = 'dotfield.center-config/2';
export const kind = 'center-config';
export function migrate(doc) { return { ...doc, schema_version: to, ext: { ...(doc.ext || {}), migrated_by: '0001' } }; }
`;
const BRAND_MIGRATION = `export const from = 'dotfield.brand/1';
export const to = 'dotfield.brand/1';
export const kind = 'brand';
export function migrate(doc) { return doc.room_preset === 'paper' ? { ...doc, room_preset: 'studio' } : doc; }
`;
const cli = (args, c, env = {}) => runCli(args, { cwd: c.root, env: { ...EPOCH_ENV, ...env } });
const codes = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.code);

function migrationsDir(dir, files = { '0001-center-config-v2.mjs': MIGRATION }) {
  const d = join(dir, 'migrations');
  mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}
function packsDir(dir) {
  const d = join(dir, 'packs', 'starter');
  cpSync(join(CENTER_MIN, 'rooms', 'notes'), join(d, 'rooms', 'notes'), { recursive: true });
  writeJson(join(d, 'pack.json'), { schema_version: 'dotfield.pack/1', id: 'starter', version: '0.1.0', rooms: ['notes'] });
  return join(dir, 'packs');
}

test('diffLines/diffText: an LCS line diff with folded unchanged runs; identical texts give an empty patch', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc'), [' a', '-b', '+x', ' c']);
  assert.equal(diffText('same\n', 'same\n'), '');
  const patch = diffText(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 12 }, (_, i) => (i === 6 ? 'changed' : `l${i}`)).join('\n'), { label: 'f.json', context: 1 });
  assert.match(patch, /^--- a\/f\.json\n\+\+\+ b\/f\.json\n/);
  assert.match(patch, /@@ 5 unchanged line\(s\) @@\n l5\n-l6\n\+changed\n l7\n@@ 4 unchanged line\(s\) @@/);
});

test('loadMigrations: sorted, invalid modules reported, kinds pinned; targetsFor finds the center files', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const d = migrationsDir(dir, { '0002-brand-studio.mjs': BRAND_MIGRATION, '0001-center-config-v2.mjs': MIGRATION, '0003-broken.mjs': 'export const from = 1;', 'notes.txt': 'ignored' });
    const { migrations, checks } = await loadMigrations(d);
    assert.deepEqual(migrations.map((m) => m.file), ['0001-center-config-v2.mjs', '0002-brand-studio.mjs']);
    assert.equal(checks.length, 1); assert.equal(checks[0].code, 'DF_ENGINE_MIGRATION_PENDING'); assert.equal(checks[0].path, 'migrations/0003-broken.mjs'); assert.match(checks[0].message, /from, to, kind, migrate\(\)/);
    assert.deepEqual((await loadMigrations(join(dir, 'absent'))).migrations, []);
    assert.deepEqual(targetsFor('room', c.centerDir), [c.roomFile('notes', 'room.json')]);
    assert.deepEqual(targetsFor('center-config', c.centerDir), [c.configPath]);
    assert.deepEqual(targetsFor('people', c.centerDir), [join(c.centerDir, 'people', 'people.json')]);
  });
});

test('a v1 config round-trips: plan → dry run writes nothing → apply backs up the original bytes → nothing pending → restore equals the original', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const original = readFileSync(c.configPath);
    const { migrations } = await loadMigrations(migrationsDir(dir));
    const plan = planMigrations(migrations, { centerDir: c.centerDir, root: c.root });
    assert.equal(plan.steps.length, 1);
    const step = plan.steps[0];
    assert.equal(step.ref, 'center/center.config.json'); assert.equal(step.from, 'dotfield.center-config/1'); assert.equal(step.to, 'dotfield.center-config/2');
    assert.deepEqual(step.chain, ['0001-center-config-v2.mjs']); assert.equal(step.valid, true); assert.equal(step.validated, false, 'no shipped schema pins /2 yet, so the result is accepted by shape');
    assert.match(step.patch, /-  "schema_version": "dotfield\.center-config\/1",\n\+  "schema_version": "dotfield\.center-config\/2",/);
    const dry = applyPlan(plan.steps, { root: c.root, dotDir: c.dotDir, now: NOW, dryRun: true });
    assert.deepEqual(dry.written, []); assert.ok(readFileSync(c.configPath).equals(original));
    const applied = applyPlan(plan.steps, { root: c.root, dotDir: c.dotDir, now: NOW });
    assert.equal(applied.written.length, 1);
    assert.equal(applied.backupDir, join(c.dotDir, 'migrate-20261001T101500Z'));
    const backup = join(applied.backupDir, 'center', 'center.config.json');
    assert.ok(readFileSync(backup).equals(original), 'the backup holds the original bytes');
    assert.equal(readJson(c.configPath).schema_version, 'dotfield.center-config/2');
    assert.equal(readJson(c.configPath).ext.migrated_by, '0001');
    assert.equal(planMigrations(migrations, { centerDir: c.centerDir, root: c.root }).steps.length, 0, 'nothing pending after apply');
    cpSync(backup, c.configPath);
    assert.ok(readFileSync(c.configPath).equals(original), 'restoring the backup round-trips');
    assert.equal(planMigrations(migrations, { centerDir: c.centerDir, root: c.root }).steps.length, 1, 'and the migration is pending again');
  });
});

test('a migration whose result fails the shipped schema is refused and left pending', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const bad = `export const from = 'dotfield.brand/1'; export const to = 'dotfield.brand/1'; export const kind = 'brand'; export function migrate(doc) { return { ...doc, room_preset: 'not-a-preset' }; }\n`;
    const r = await migrate({ packageRoot: c.root, centerDir: c.centerDir, dotDir: c.dotDir, root: c.root, config: c.config, now: NOW, migrationsDir: migrationsDir(dir, { '0001-brand-bad.mjs': bad }), packsDir: join(dir, 'nopacks') });
    assert.equal(r.steps.length, 1); assert.equal(r.steps[0].valid, false); assert.equal(r.steps[0].validated, true);
    assert.deepEqual(r.applied.written, []); assert.deepEqual(r.applied.skipped, ['center/brand.json']);
    assert.ok(r.checks.some((x) => x.code === 'DF_SCHEMA_ENUM' && x.status === 'fail'));
    assert.ok(r.checks.some((x) => x.code === 'DF_ENGINE_MIGRATION_PENDING' && x.status === 'fail' && /refused/.test(x.message)));
    assert.equal(readJson(join(c.centerDir, 'brand.json')).room_preset, 'paper');
  });
});

/** A center whose notes room came from a one-room pack, with the lock init would have written. */
function lockedCenter(dir) {
  const c = scaffoldCenter(dir);
  const packs = packsDir(dir);
  const packDir = join(packs, 'starter');
  patchJson(c.configPath, (cfg) => { cfg.installed_packs = [{ id: 'starter', version: '0.1.0', digest: digestTree(packDir).digest }]; });
  writeLock(c.centerDir, { packs: { starter: lockEntry(packDir, { version: '0.1.0' }) } });
  return { c, packs, packDir };
}
const actions = (plans) => Object.fromEntries(plans[0].rows.map((r) => [r.centerRel, r.action]));

test('packPlans + applyPacks: an untouched file is updated with a backup, an owner edit is kept with the shipped copy beside it, an owner deletion stays, and drift stays until resolved', async () => {
  await withTmp(async (dir) => {
    const { c, packs, packDir } = lockedCenter(dir);
    const plan0 = packPlans({ packsDir: packs, centerDir: c.centerDir, config: readJson(c.configPath) });
    assert.ok(Object.values(actions(plan0.plans)).every((a) => a === 'same'), 'a fresh center is current');
    assert.ok(plan0.checks.some((x) => x.code === 'DF_PACK_VERSION_DRIFT' && x.status === 'pass'));
    // Upstream changes two files; the owner edited one of them and deleted a third.
    patchJson(join(packDir, 'rooms', 'notes', 'views.json'), (v) => { v[0].label = 'Shipped label'; });
    patchJson(join(packDir, 'rooms', 'notes', 'room.json'), (d) => { d.label = 'Notes v2'; });
    patchJson(c.roomFile('notes', 'room.json'), (d) => { d.label = 'My notes'; });
    writeFileSync(join(packDir, 'rooms', 'notes', 'examples.json'), `${JSON.stringify([], null, 2)}\n`);
    const removed = c.roomFile('notes', 'examples.json');
    rmSync(removed);
    const plan = packPlans({ packsDir: packs, centerDir: c.centerDir, config: readJson(c.configPath) });
    assert.deepEqual(actions(plan.plans), { 'rooms/notes/examples.json': 'kept_deleted', 'rooms/notes/record.schema.json': 'same', 'rooms/notes/room.json': 'conflict', 'rooms/notes/views.json': 'update' });
    const drift = plan.checks.find((x) => x.code === 'DF_PACK_VERSION_DRIFT');
    assert.equal(drift.status, 'fail'); assert.equal(drift.blocking, false);
    assert.match(plan.plans[0].rows.find((r) => r.action === 'conflict').patch, /-  "label": "My notes",\n\+  "label": "Notes v2",/);
    const viewsBefore = readFileSync(c.roomFile('notes', 'views.json'), 'utf8');
    const backupDir = join(c.dotDir, 'migrate-test');
    const out = applyPacks(plan.plans, { lock: plan.lock, centerDir: c.centerDir, root: c.root, backupDir });
    assert.equal(readJson(c.roomFile('notes', 'views.json'))[0].label, 'Shipped label', 'the untouched file took the update');
    assert.equal(readFileSync(join(backupDir, 'center', 'rooms', 'notes', 'views.json'), 'utf8'), viewsBefore, 'its original is backed up byte for byte');
    assert.equal(readJson(c.roomFile('notes', 'room.json')).label, 'My notes', 'the owner edit is never overwritten');
    assert.deepEqual(out.merges.map((m) => m.ref), ['center/rooms/notes/room.json']);
    assert.equal(readJson(join(backupDir, 'shipped', 'rooms', 'notes', 'room.json')).label, 'Notes v2', 'the shipped version waits beside the backups');
    assert.equal(existsSync(removed), false, 'an owner deletion stays deleted');
    assert.deepEqual(out.advanced, [], 'installed_packs stays behind while a merge is open');
    const again = packPlans({ packsDir: packs, centerDir: c.centerDir, config: readJson(c.configPath) });
    assert.deepEqual(actions(again.plans), { 'rooms/notes/examples.json': 'same', 'rooms/notes/record.schema.json': 'same', 'rooms/notes/room.json': 'conflict', 'rooms/notes/views.json': 'same' }, 'the conflict persists until resolved; the deletion is settled (the lock moved on, the file stays absent)');
    assert.equal(existsSync(removed), false);
    const done = applyPacks(again.plans, { lock: again.lock, centerDir: c.centerDir, root: c.root, backupDir, resolved: true });
    assert.deepEqual(done.advanced, ['starter']);
    assert.deepEqual(readJson(c.configPath).installed_packs, [{ id: 'starter', version: '0.1.0', digest: digestTree(packDir).digest }]);
    const after = packPlans({ packsDir: packs, centerDir: c.centerDir, config: readJson(c.configPath) });
    assert.ok(Object.values(actions(after.plans)).every((a) => a === 'same' || a === 'kept_deleted'));
    assert.ok(after.checks.some((x) => x.code === 'DF_PACK_VERSION_DRIFT' && x.status === 'pass'), 'no drift once resolved');
    assert.equal(readJson(c.roomFile('notes', 'room.json')).label, 'My notes', 'resolving keeps the owner file');
  });
});

test('packPlans: a pack file added upstream is added; a center without a lock adopts one and applies nothing it cannot tell apart', async () => {
  await withTmp(async (dir) => {
    const { c, packs, packDir } = lockedCenter(dir);
    cpSync(join(packDir, 'rooms', 'notes'), join(packDir, 'rooms', 'journal'), { recursive: true });
    patchJson(join(packDir, 'rooms', 'journal', 'room.json'), (d) => { d.id = 'journal'; d.store.namespace = 'journal'; });
    const plan = packPlans({ packsDir: packs, centerDir: c.centerDir, config: readJson(c.configPath) });
    assert.equal(actions(plan.plans)['rooms/journal/room.json'], 'add');
    applyPacks(plan.plans, { lock: plan.lock, centerDir: c.centerDir, root: c.root, backupDir: join(c.dotDir, 'm1') });
    assert.equal(readJson(c.roomFile('journal', 'room.json')).id, 'journal', 'a new room arrives whole');
    assert.equal(Object.keys(readLock(c.centerDir).packs.starter.files).length, 8);
    // No lock: identical files are adopted, a differing one is a merge, nothing is written over.
    rmSync(join(c.centerDir, 'pack-lock.json'));
    patchJson(c.roomFile('notes', 'room.json'), (d) => { d.label = 'Hand edited'; });
    const legacy = packPlans({ packsDir: packs, centerDir: c.centerDir, config: readJson(c.configPath) });
    assert.equal(legacy.lock, null);
    assert.equal(actions(legacy.plans)['rooms/notes/room.json'], 'unknown_no_lock');
    const out = applyPacks(legacy.plans, { lock: null, centerDir: c.centerDir, root: c.root, backupDir: join(c.dotDir, 'm2') });
    assert.equal(readJson(c.roomFile('notes', 'room.json')).label, 'Hand edited');
    assert.deepEqual(out.merges.map((m) => m.action), ['unknown_no_lock']);
    const lock = readLock(c.centerDir);
    assert.ok(lock && !('rooms/notes/room.json' in lock.packs.starter.files) && 'rooms/notes/views.json' in lock.packs.starter.files, 'the lock adopts only what is identical');
  });
});

test('CLI: migrate --dry-run prints the patch and writes nothing; migrate applies with a backup and a written receipt; no migrations is a clean read', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const none = cli(['migrate', '--json'], c, { DOTFIELD_MIGRATIONS_DIR: join(dir, 'absent'), DOTFIELD_PACKS_DIR: join(dir, 'absent') });
    assert.equal(none.code, 0, none.stdout); assert.equal(none.json.status, 'read'); assert.deepEqual(codes(none.json), []);
    const env = { DOTFIELD_MIGRATIONS_DIR: migrationsDir(dir), DOTFIELD_PACKS_DIR: packsDir(dir) };
    const original = readFileSync(c.configPath, 'utf8');
    const dry = cli(['migrate', '--dry-run'], c, env);
    assert.equal(dry.code, 0, dry.stderr); assert.match(dry.stdout, /\+\+\+ b\/center\/center\.config\.json/); assert.equal(readFileSync(c.configPath, 'utf8'), original);
    const dryJson = cli(['migrate', '--dry-run', '--json'], c, env);
    assert.equal(dryJson.json.status, 'read'); assert.ok(codes(dryJson.json).includes('DF_ENGINE_MIGRATION_PENDING')); assert.deepEqual(dryJson.json.outputs, []);
    const apply = cli(['migrate', '--json'], c, env);
    assert.equal(apply.code, 0, apply.stdout); assert.equal(apply.json.status, 'written');
    assert.deepEqual(apply.json.outputs.map((o) => o.kind), ['migrated', 'backup']);
    assert.ok(existsSync(join(c.root, apply.json.outputs[1].ref)) && readFileSync(join(c.root, apply.json.outputs[1].ref), 'utf8') === original);
    assert.equal(readJson(c.configPath).schema_version, 'dotfield.center-config/2');
    assert.ok(existsSync(join(c.dotDir, 'receipts', `${apply.json.receipt_id}.json`)));
    assert.ok(!codes(cli(['migrate', '--json'], c, env).json).includes('DF_ENGINE_MIGRATION_PENDING'), 'a second run has nothing pending');
  });
});
