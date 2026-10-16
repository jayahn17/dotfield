// recipes/backup-and-restore.md, run: a center with approved records exports
// them (no key material, no handles), and a fresh center restores them with
// the verbs the owner already uses — init, import records per room (exit 3,
// a proposal), approve with the owner token file — ending with the same
// records byte for byte. Real bin, temp dirs, one clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { runCli } from './helpers/cli.mjs';
import { EPOCH_ENV, initCenter, readJson } from './helpers/center.mjs';

const cli = (c, args) => runCli([...args, '--json'], { cwd: c.root, env: { ...EPOCH_ENV, DOTFIELD_ROOT: c.root } });
const walk = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, join(rel, e.name)) : [join(rel, e.name)]));

/** import records <room> <file>, then approve the proposal it left with the owner token file. */
function importApproved(c, room, file) {
  const imp = cli(c, ['import', 'records', room, file]);
  assert.equal(imp.code, 3, imp.stdout);
  assert.equal(imp.json.status, 'proposal');
  const id = /prop_[0-9A-Za-z_]+/.exec(imp.json.next_action)[0];
  const ok = cli(c, ['approve', id, '--decision', 'approve', '--token-file', join(c.dataDir, 'keys', 'owner.token')]);
  assert.equal(ok.code, 0, ok.stdout);
  return ok;
}

test('export then restore into a fresh center: the same records, no keys or handles in the export, nothing written before approve', async () => {
  await withTmp(async (dir) => {
    const a = initCenter(join(dir, 'a'), { name: 'Original' });
    importApproved(a, 'notes', a.roomFile('notes', 'examples.json'));
    const before = readJson(join(a.dataDir, 'rooms', 'notes.json'));
    assert.ok(before.records.length >= 3);
    const exp = cli(a, ['export', '-o', join(dir, 'export')]);
    assert.equal(exp.code, 0, exp.stdout);
    const files = walk(join(dir, 'export'));
    assert.ok(files.includes(join('rooms', 'notes.json')) && files.includes('export.json'));
    assert.ok(!files.some((f) => /keys|\.token$|\.key$|\.ed25519$|handle\.salt/.test(f)), `no key material: ${files.join(', ')}`);
    for (const p of readJson(join(dir, 'export', 'people', 'people.json')).people) assert.deepEqual(p.handles ?? [], [], 'handles never leave the center');
    const exported = readJson(join(dir, 'export', 'rooms', 'notes.json'));
    assert.equal(exported.schema_version, 'dotfield.export/1');
    assert.equal(exported.count, before.records.length);

    const b = initCenter(join(dir, 'b'), { name: 'Restored' });
    assert.equal(existsSync(join(b.dataDir, 'rooms', 'notes.json')), false);
    const imp = cli(b, ['import', 'records', 'notes', join(dir, 'export', 'rooms', 'notes.json')]);
    assert.equal(imp.code, 3, 'a restore is a proposal like any import');
    assert.equal(existsSync(join(b.dataDir, 'rooms', 'notes.json')), false, 'nothing is written before approve');
    const id = /prop_[0-9A-Za-z_]+/.exec(imp.json.next_action)[0];
    assert.equal(cli(b, ['approve', id, '--decision', 'approve', '--token-file', join(b.dataDir, 'keys', 'owner.token')]).code, 0);
    const after = readJson(join(b.dataDir, 'rooms', 'notes.json'));
    assert.deepEqual(after.records, before.records, 'every record restored, field for field');
    assert.notEqual(readFileSync(join(b.dataDir, 'keys', 'owner.token'), 'utf8'), readFileSync(join(a.dataDir, 'keys', 'owner.token'), 'utf8'), 'a restore from an export starts with new keys (the recipe says so)');
  });
});

test('the recipe ships: every shipped pack copies backup-and-restore.md into center/docs/recipes/, and the README links it', async () => {
  const { listPacks } = await import('../lib/packs.mjs');
  const { ROOT } = await import('./helpers/cli.mjs');
  for (const p of listPacks(ROOT).filter((x) => !x.draft)) assert.ok(readJson(join(p.dir, 'pack.json')).recipes.includes('backup-and-restore.md'), p.id);
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /recipes\/backup-and-restore\.md/);
  await withTmp(async (dir) => {
    const c = initCenter(dir);
    assert.ok(existsSync(join(c.centerDir, 'docs', 'recipes', 'backup-and-restore.md')));
  });
});
