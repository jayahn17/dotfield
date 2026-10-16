// cli-fixes: the init/prove/verify behaviours added after review round 2 —
// the sandbox read set of prove (never the fork root, so data/keys/ is
// unreadable), init on a fresh clone without --force, init --force writing
// center/ from ONE pack (other packs' rooms removed, stores kept), the
// research-lab release tag, and verify/validate of receipts from a center
// outside the engine tree (no DRIFT, no REF_MISSING, no DIGEST_MISMATCH from
// either root). Real bin, temp dirs, one clock, no network, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { ROOT, runCli } from './helpers/cli.mjs';
import { EPOCH_ENV, NOW_ISO, cloneRoom, patchJson, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { createStore } from '../lib/store.mjs';

const fails = (r) => r.checks.filter((c) => c.status === 'fail');
const codes = (r) => fails(r).map((c) => c.code);
const cli = (args, c, env = {}, extra = {}) => runCli(args, { cwd: c.root, env: { ...EPOCH_ENV, ...env }, ...extra });

async function seed(c, roomId, records) {
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const store = createStore({ room: d.rooms.find((r) => r.id === roomId), dataDir: c.dataDir, config: c.config, env: {}, root: c.root });
  await store.write(records, { approved: true, now: new Date(NOW_ISO), by: 'test' });
}
function keyFiles(c) {
  mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
  writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'cli-test-session-key\n');
  writeFileSync(join(c.dataDir, 'keys', 'handle.salt'), 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n');
  const token = join(c.dataDir, 'keys', 'owner.token');
  writeFileSync(token, 'test-owner-token-0123456789abcdef\n', { mode: 0o600 });
  chmodSync(token, 0o600);
  return token;
}
/** A center with the notes room, a papers clone, seeded records and the key files. */
async function ready(dir) {
  const c = scaffoldCenter(dir);
  cloneRoom(c, 'notes', 'papers', (d) => { d.label = 'Papers'; });
  const examples = readJson(c.roomFile('notes', 'examples.json'));
  await seed(c, 'notes', examples);
  await seed(c, 'papers', examples);
  keyFiles(c);
  return { c };
}

test('prove: a hostile test.mjs that reads data/keys/ is DF_SANDBOX_READ_DENIED — the sandbox read set is the room folder plus the engine, never the fork root', async () => {
  await withTmp(async (dir) => {
    const { c } = await ready(dir);
    const secret = readFileSync(join(c.dataDir, 'keys', 'owner.token'), 'utf8').trim();
    cpSync(join(ROOT, 'test', 'fixtures', 'sandbox', 'test-reads-keys.mjs'), c.roomFile('papers', 'test.mjs'));
    patchJson(c.roomFile('papers', 'room.json'), (d) => { d.maturity = 'tested'; });
    const r = cli(['prove', 'papers', '--json'], c);
    assert.equal(r.code, 2, r.stdout);
    assert.ok(codes(r.json).includes('DF_SANDBOX_READ_DENIED'), codes(r.json).join());
    assert.ok(codes(r.json).includes('DF_ROOM_MATURITY_OVERCLAIM'), 'a test that cannot run proves nothing');
    assert.equal(readJson(join(c.dotDir, 'prove', 'papers.json')).ok, false);
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'the key bytes never leave the sandbox');
    const { testReadSet } = await import('../lib/commands/prove.mjs');
    const reads = testReadSet({ dir: c.roomDir('papers') }, { packageRoot: ROOT });
    assert.deepEqual(reads, [c.roomDir('papers'), join(ROOT, 'lib'), join(ROOT, 'schemas'), join(ROOT, 'renderers')]);
    assert.ok(!reads.some((p) => p === c.root || p === ROOT), 'neither the fork root nor the package root is readable');
  });
});

test('init on a fresh clone: no center/ ships, so the first init needs no flag; a second init is refused without --force and rewrites nothing', async () => {
  await withTmp(async (dir) => {
    const c = { root: dir };
    const r = cli(['init', '--pack', 'starter', '--name', 'My Center', '--json'], c);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.status, 'written');
    assert.equal(readJson(join(dir, 'center', 'center.config.json')).center.name, 'My Center');
    assert.ok(existsSync(join(dir, 'data', 'keys', 'owner.token')));
    assert.ok(existsSync(join(dir, 'center', 'pack-lock.json')), 'init records what it copied, for migrate');
    const again = cli(['init', '--pack', 'starter', '--name', 'Twice', '--json'], c);
    assert.equal(again.code, 3, 'a center exists now');
    assert.match(again.json.next_action, /already exists at .*; pass --force/);
    assert.equal(readJson(join(dir, 'center', 'center.config.json')).center.name, 'My Center', 'nothing was rewritten');
  });
});

test('init --force re-initialises from ONE pack: other packs\' rooms leave center/ (stores stay), a pack: null room stays, installed_packs is the pack written; research-lab receipts are v1.1-provisional', async () => {
  await withTmp(async (dir) => {
    const c = { root: dir };
    const research = cli(['init', '--pack', 'research-lab', '--name', 'Lab', '--force', '--json'], c);
    assert.equal(research.code, 0, research.stdout);
    assert.equal(research.json.release_tag, 'v1.1-provisional', 'VISION §13 tags research-lab v1.1');
    assert.deepEqual(readdirSync(join(dir, 'center', 'rooms')).sort(), ['collaborators', 'datasets', 'experiments', 'papers']);
    assert.equal(cli(['add', 'room', 'scratch', '--blank', '--json'], c).code, 0);
    writeJson(join(dir, 'data', 'rooms', 'papers.json'), { schema_version: 'dotfield.store/1', room: 'papers', namespace: 'papers', scope: 'owner', written_at: NOW_ISO, written_by: 'test', count: 0, digest: `sha256:${'0'.repeat(64)}`, records: [] });
    const robotics = cli(['init', '--pack', 'robotics-lab', '--name', 'Hall Lab', '--force', '--json'], c);
    assert.equal(robotics.code, 0, robotics.stdout);
    assert.equal(robotics.json.release_tag, 'v1.0');
    assert.deepEqual(readdirSync(join(dir, 'center', 'rooms')).sort(), ['datasets', 'experiments', 'papers', 'robots', 'scratch'], 'research-lab rooms left; the blank (pack: null) room stayed');
    assert.equal(readJson(join(dir, 'center', 'rooms', 'papers', 'room.json')).pack, 'robotics-lab', 'a same-named room is the new pack\'s');
    assert.deepEqual(readJson(join(dir, 'center', 'center.config.json')).installed_packs.map((p) => p.id), ['robotics-lab']);
    assert.match(robotics.json.next_action, /removed collaborators \(pack research-lab\)/);
    assert.ok(robotics.json.outputs.some((o) => o.ref === 'center/rooms/collaborators/room.json' && o.action === 'removed'), 'the receipt lists each removed file');
    assert.ok(existsSync(join(dir, 'data', 'rooms', 'papers.json')), 'stores under data/ are never deleted by init');
    const same = cli(['init', '--pack', 'robotics-lab', '--name', 'Hall Lab', '--force', '--json'], c);
    assert.equal(same.code, 0, same.stdout);
    assert.ok(!/removed/.test(same.json.next_action), 'the same pack again removes nothing');
    assert.match(cli(['init', '--pack', 'starter', '--json'], c).json.next_action, /rooms whose room\.json names another pack are removed/);
  });
});

test('verify from anywhere: an init receipt and a render receipt of a center outside the engine tree verify from that root and from the package dir with no DRIFT, no REF_MISSING and no DIGEST_MISMATCH', async () => {
  await withTmp(async (dir) => {
    const c = { root: dir };
    const init = cli(['init', '--pack', 'starter', '--name', 'Away', '--json'], c);
    assert.equal(init.code, 0, init.stdout);
    assert.ok(init.json.inputs.some((i) => i.ref === 'packs/starter/pack.json'), 'pack inputs are recorded package-relative');
    const initReceipt = join(dir, '.dotfield', 'receipts', `${init.json.receipt_id}.json`);
    assert.ok(existsSync(initReceipt));
    const render = cli(['render', 'room:notes/graph', '--json'], c);
    assert.equal(render.code, 0, render.stdout);
    const renderReceipt = join(dir, render.json.outputs[0].ref.replace(/\/[^/]+$/, ''), 'receipt.json');
    assert.ok(existsSync(renderReceipt));
    const noise = ['DF_RECEIPT_ENGINE_DRIFT', 'DF_RECEIPT_REF_MISSING', 'DF_RECEIPT_DIGEST_MISMATCH'];
    for (const [cwd, label] of [[dir, 'the fork root'], [ROOT, 'the package dir']]) {
      for (const file of [initReceipt, renderReceipt]) {
        const v = runCli(['verify', file, '--json'], { cwd, env: EPOCH_ENV });
        assert.equal(v.code, 0, `${label}: ${v.stdout}`);
        assert.deepEqual(codes(v.json).filter((code) => noise.includes(code)), [], `${label}: ${file}`);
        assert.match(v.json.next_action, /verifies/);
        const val = runCli(['validate', file, '--json'], { cwd, env: EPOCH_ENV });
        assert.equal(val.code, 0, `${label} validate: ${val.stdout}`);
        assert.deepEqual(codes(val.json).filter((code) => noise.includes(code)), []);
      }
    }
    const { verifyReceipt } = await import('../lib/receipt.mjs');
    assert.ok(verifyReceipt(renderReceipt, { root: dir }).checks.some((x) => x.code === 'DF_RECEIPT_ENGINE_DRIFT' && x.status === 'fail'), 'without engineRoot the fork root has no lib/ to compare: drift');
    assert.ok(verifyReceipt(renderReceipt, { root: dir, engineRoot: ROOT }).checks.every((x) => x.code !== 'DF_RECEIPT_ENGINE_DRIFT' || x.status === 'pass'));
  });
});
