// lib/store.mjs: atomic write (tmp + fsync + rename, no tmp left) with the
// previous version in .bak, read as copies, limits, the approved flag, typed
// {status: 503, storage: true} faults, corrupt files, the env pin honoured
// only under NODE_TEST_CONTEXT or allow_env_pins, the object backend over a
// stubbed fetch (no network), the memory backend, and scope sharding. Every
// test runs inside its own temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoreError, clearMemoryStores, createStore, envPinName, isStoreError, writeFileAtomic } from '../lib/store.mjs';
import { resolveScope } from '../lib/scope.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { NOW, scaffoldCenter } from './helpers/center.mjs';
import { makeTmp, withTmp } from './helpers/tmp.mjs';

const ENV = {}; // no NODE_TEST_CONTEXT, no pins: what a customer's shell looks like
const rec = (i, extra = {}) => ({ note_id: `n-${i}`, title: `Note ${i}`, logged_on: '2026-10-01', ...extra });

function boot(dir) {
  const c = scaffoldCenter(dir);
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  assert.equal(d.ok, true);
  return { c, room: d.rooms[0] };
}

test('atomic write: envelope, no tmp file, .bak keeps the previous version, reads are copies', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  const store = createStore({ room, dataDir: c.dataDir, config: c.config, env: ENV, root: c.root });
  assert.equal(store.backend, 'file');
  assert.equal(store.path(), join(c.dataDir, 'rooms', 'notes.json'));
  assert.deepEqual(store.target(), { target: 'data/rooms/notes.json', backend: 'file' });
  assert.equal(validate(loadSchema('receipt').properties.store, store.target()).ok, true, 'target() is the receipt store shape');
  assert.deepEqual(await store.read(), [], 'an absent store reads as empty');
  assert.equal(store.exists(), false);
  const w1 = await store.write([rec(1)], { approved: true, now: NOW, by: 'test' });
  assert.deepEqual(readdirSync(join(c.dataDir, 'rooms')), ['notes.json'], 'no tmp file and no .bak before a second write');
  assert.equal(w1.backup, false);
  assert.equal(w1.count, 1);
  assert.match(w1.digest, /^sha256:[0-9a-f]{64}$/);
  const env1 = JSON.parse(readFileSync(store.path(), 'utf8'));
  assert.equal(env1.schema_version, 'dotfield.store/1');
  assert.equal(env1.room, 'notes');
  assert.equal(env1.scope, 'owner');
  assert.equal(env1.written_at, '2026-10-01T10:15:00Z');
  assert.equal(env1.written_by, 'test');
  assert.deepEqual(env1.records, [rec(1)]);
  const w2 = await store.write([rec(1), rec(2)], { approved: true, now: NOW });
  assert.equal(w2.backup, true);
  assert.deepEqual(readdirSync(join(c.dataDir, 'rooms')).sort(), ['notes.json', 'notes.json.bak']);
  assert.deepEqual(JSON.parse(readFileSync(`${store.path()}.bak`, 'utf8')).records, [rec(1)], '.bak is the previous version');
  const got = await store.read();
  assert.deepEqual(got, [rec(1), rec(2)]);
  got[0].title = 'mutated';
  assert.equal((await store.read())[0].title, 'Note 1', 'read() hands out copies');
}));

test('a write without approved: true is refused with DF_STORE_WRITE_WITHOUT_APPROVAL and nothing lands on disk', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  const store = createStore({ room, dataDir: c.dataDir, env: ENV });
  for (const opts of [undefined, {}, { approved: false }, { approved: 'yes' }, { approved: 1 }]) {
    await assert.rejects(store.write([rec(1)], opts), (e) => isStoreError(e) && e.code === 'DF_STORE_WRITE_WITHOUT_APPROVAL' && e.status === 403 && e.storage === false && e.check.status === 'fail' && e.check.blocking === true);
  }
  assert.equal(existsSync(join(c.dataDir, 'rooms')), false);
}));

test('limits: max_records and max_record_bytes are checked before any byte is written', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  room.manifest.store.max_records = 2;
  room.manifest.store.max_record_bytes = 300;
  const store = createStore({ room, dataDir: c.dataDir, env: ENV });
  assert.deepEqual(store.limits, { max_records: 2, max_record_bytes: 300 });
  await assert.rejects(store.write([rec(1), rec(2), rec(3)], { approved: true }), (e) => e.code === 'DF_STORE_MAX_RECORDS' && e.status === 422 && !e.storage);
  await assert.rejects(store.write([rec(1, { body: 'x'.repeat(400) })], { approved: true }), (e) => e.code === 'DF_STORE_MAX_BYTES' && e.check.path === '$[0]');
  assert.equal(existsSync(store.path()), false);
  const checks = store.checkLimits([rec(1), rec(2), rec(3, { body: 'x'.repeat(400) })]);
  assert.deepEqual(checks.map((x) => [x.code, x.status]), [['DF_STORE_MAX_RECORDS', 'fail'], ['DF_STORE_MAX_BYTES', 'fail']]);
  assert.deepEqual(store.checkLimits([rec(1)]).map((x) => [x.code, x.status]), [['DF_STORE_MAX_RECORDS', 'pass'], ['DF_STORE_MAX_BYTES', 'pass']]);
  assert.equal(store.checkLimits('nope')[0].code, 'DF_STORE_MAX_RECORDS');
  await store.write([rec(1), rec(2)], { approved: true });
  assert.equal((await store.read()).length, 2);
}));

test('faults are typed 503s: corrupt JSON, a bad envelope, and an unwritable path (tmp cleaned up)', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  const store = createStore({ room, dataDir: c.dataDir, env: ENV });
  mkdirSync(join(c.dataDir, 'rooms'), { recursive: true });
  writeFileSync(store.path(), '{not json');
  await assert.rejects(store.read(), (e) => e instanceof StoreError && e.code === 'DF_STORE_CORRUPT' && e.status === 503 && e.storage === true && /\.bak/.test(e.message));
  writeFileSync(store.path(), '{"records": "nope"}');
  await assert.rejects(store.read(), (e) => e.code === 'DF_STORE_CORRUPT');
  writeFileSync(store.path(), '[{"note_id":"bare"}]');
  assert.deepEqual(await store.read(), [{ note_id: 'bare' }], 'a bare array is read as records');
  const blocked = createStore({ room, dataDir: join(c.dataDir, 'blocked'), env: ENV });
  mkdirSync(join(c.dataDir, 'blocked'), { recursive: true });
  writeFileSync(join(c.dataDir, 'blocked', 'rooms'), 'a file where the directory should be');
  await assert.rejects(blocked.write([rec(1)], { approved: true }), (e) => e.code === 'DF_STORE_FAULT' && e.status === 503 && e.storage === true && e.check.code === 'DF_STORE_FAULT');
  assert.throws(() => writeFileAtomic(join(c.dataDir, 'blocked', 'rooms', 'x.json'), '{}'), (e) => e.code === 'DF_STORE_FAULT');
  assert.deepEqual(readdirSync(join(c.dataDir, 'blocked')), ['rooms'], 'no tmp file survives a fault');
}));

test('env pin DOTFIELD_STORE_<ROOM>_FILE: honoured under NODE_TEST_CONTEXT or allow_env_pins, otherwise DF_STORE_ENV_PIN_IGNORED and the path stays', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  assert.equal(envPinName('notes'), 'DOTFIELD_STORE_NOTES_FILE');
  assert.equal(envPinName('my-room.2'), 'DOTFIELD_STORE_MY_ROOM_2_FILE');
  const pin = join(dir, 'elsewhere', 'pinned.json');
  const pinned = createStore({ room, dataDir: c.dataDir, config: c.config, env: { DOTFIELD_STORE_NOTES_FILE: pin, NODE_TEST_CONTEXT: 'child' }, root: c.root });
  assert.equal(pinned.path(), pin, 'the pin moves the store PATH, not only the backend');
  assert.deepEqual(pinned.checks.map((x) => [x.code, x.status]), [['DF_STORE_ENV_PIN_IGNORED', 'pass']]);
  await pinned.write([rec(1)], { approved: true });
  assert.ok(existsSync(pin) && !existsSync(join(c.dataDir, 'rooms', 'notes.json')), 'the real store is untouched');
  assert.equal(pinned.target().target, 'elsewhere/pinned.json', 'a pin under the root prints relative');
  const outside = await makeTmp({ prefix: 'dotfield-outside-' });
  try {
    const far = createStore({ room, dataDir: c.dataDir, config: c.config, env: { DOTFIELD_STORE_NOTES_FILE: join(outside.dir, 'far.json'), NODE_TEST_CONTEXT: 'child' }, root: c.root });
    assert.equal(far.target().target, join(outside.dir, 'far.json').split('\\').join('/'), 'a pin outside the root prints its own path');
  } finally { await outside.cleanup(); }
  const ignored = createStore({ room, dataDir: c.dataDir, config: c.config, env: { DOTFIELD_STORE_NOTES_FILE: pin }, root: c.root });
  assert.equal(ignored.path(), join(c.dataDir, 'rooms', 'notes.json'));
  assert.deepEqual(ignored.checks.map((x) => [x.code, x.status, x.blocking]), [['DF_STORE_ENV_PIN_IGNORED', 'fail', false]]);
  assert.match(ignored.checks[0].message, /ignored/);
  const allowed = createStore({ room, dataDir: c.dataDir, config: { ...c.config, store: { allow_env_pins: true, object_store_url: null } }, env: { DOTFIELD_STORE_NOTES_FILE: 'rel/pin.json' }, root: c.root });
  assert.equal(allowed.path(), join(c.root, 'rel', 'pin.json'), 'a relative pin resolves against the root');
  assert.equal(allowed.target().target, 'rel/pin.json');
  const none = createStore({ room, dataDir: c.dataDir, env: { DOTFIELD_STORE_NOTES_FILE: '   ' } });
  assert.equal(none.path(), join(c.dataDir, 'rooms', 'notes.json'), 'a blank pin is no pin');
}));

test('object backend: config.store.object_store_url with a stubbed fetch; 404 reads empty, 5xx and network errors are 503 storage faults', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  const calls = [];
  let objects = new Map();
  let mode = 'ok';
  const fetchStub = async (url, init = {}) => {
    calls.push([init.method || 'GET', url]);
    if (mode === 'throw') throw new Error('socket hang up');
    if (mode === '500') return { ok: false, status: 500, text: async () => 'boom' };
    if ((init.method || 'GET') === 'GET') return objects.has(url) ? { ok: true, status: 200, text: async () => objects.get(url) } : { ok: false, status: 404, text: async () => '' };
    objects.set(url, init.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  const config = { ...c.config, store: { allow_env_pins: false, object_store_url: 'https://objects.example.test/base/' } };
  const store = createStore({ room, dataDir: c.dataDir, config, env: ENV, fetch: fetchStub, root: c.root });
  assert.equal(store.backend, 'object');
  assert.deepEqual(store.target(), { target: 'https://objects.example.test/base/rooms/notes.json', backend: 'object' });
  assert.equal(store.exists(), null);
  assert.deepEqual(await store.read(), []);
  const w = await store.write([rec(1)], { approved: true, now: NOW });
  assert.equal(w.backend, 'object');
  assert.deepEqual(await store.read(), [rec(1)]);
  assert.deepEqual(calls.map((x) => x[0]), ['GET', 'PUT', 'GET']);
  assert.ok(calls.every((x) => x[1] === 'https://objects.example.test/base/rooms/notes.json'));
  assert.equal(existsSync(join(c.dataDir, 'rooms')), false, 'nothing is written to disk');
  mode = '500';
  await assert.rejects(store.read(), (e) => e.code === 'DF_STORE_FAULT' && e.status === 503 && e.storage === true);
  await assert.rejects(store.write([rec(1)], { approved: true }), (e) => e.code === 'DF_STORE_FAULT' && e.status === 503);
  mode = 'throw';
  await assert.rejects(store.read(), (e) => e.code === 'DF_STORE_FAULT' && /socket hang up/.test(e.message));
  mode = 'ok';
  objects = new Map([['https://objects.example.test/base/rooms/notes.json', 'not json']]);
  await assert.rejects(store.read(), (e) => e.code === 'DF_STORE_CORRUPT' && e.storage === true);
  const pinnedOverObject = createStore({ room, dataDir: c.dataDir, config, env: { DOTFIELD_STORE_NOTES_FILE: join(dir, 'pin.json'), NODE_TEST_CONTEXT: '1' }, fetch: fetchStub });
  assert.equal(pinnedOverObject.backend, 'file', 'an honoured pin outranks the object store');
  const ignoredPinOverObject = createStore({ room, dataDir: c.dataDir, config, env: { DOTFIELD_STORE_NOTES_FILE: join(dir, 'pin.json') }, fetch: fetchStub });
  assert.equal(ignoredPinOverObject.backend, 'object', 'an ignored pin does not disable the object store');
}));

test('memory backend: isolated per target, cleared by clearMemoryStores()', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  clearMemoryStores();
  const store = createStore({ room, dataDir: c.dataDir, env: ENV, backend: 'memory' });
  assert.deepEqual(store.target(), { target: 'memory:rooms/notes.json', backend: 'memory' });
  assert.equal(store.exists(), false);
  await store.write([rec(1)], { approved: true });
  assert.equal(store.exists(), true);
  assert.deepEqual(await createStore({ room, dataDir: c.dataDir, env: ENV, backend: 'memory' }).read(), [rec(1)]);
  assert.equal(existsSync(join(c.dataDir, 'rooms')), false);
  clearMemoryStores();
  assert.deepEqual(await store.read(), []);
  assert.throws(() => createStore({ room, dataDir: c.dataDir, env: ENV, backend: 'disk' }), TypeError);
}));

test('scope: person-scoped rooms shard per person; owner-scoped rooms refuse person writes; public and refused scopes open nothing', () => withTmp(async (dir) => {
  const { c, room } = boot(dir);
  const ada = resolveScope({ as: 'ada' });
  const ownerRoomAsAda = createStore({ room, dataDir: c.dataDir, scope: ada, env: ENV, root: c.root });
  assert.equal(ownerRoomAsAda.target().target, 'data/rooms/notes.json', 'an owner-scoped room has one file whoever views it');
  assert.deepEqual(await ownerRoomAsAda.read(), []);
  await assert.rejects(ownerRoomAsAda.write([rec(1)], { approved: true }), (e) => e.code === 'DF_STORE_SCOPE_REFUSED' && e.status === 403);
  room.manifest.store.scope = 'person';
  const shard = createStore({ room, dataDir: c.dataDir, scope: 'person_ada', env: ENV, root: c.root });
  assert.equal(shard.target().target, 'data/person_ada/rooms/notes.json');
  await shard.write([rec(9)], { approved: true });
  assert.ok(existsSync(join(c.dataDir, 'person_ada', 'rooms', 'notes.json')));
  assert.deepEqual(await createStore({ room, dataDir: c.dataDir, scope: 'owner', env: ENV }).read(), [], "the owner container is not ada's");
  assert.throws(() => createStore({ room, dataDir: c.dataDir, scope: 'public', env: ENV }), (e) => e.code === 'DF_STORE_SCOPE_REFUSED' && e.status === 401);
  const refused = resolveScope({ origin: 'remote' });
  assert.throws(() => createStore({ room, dataDir: c.dataDir, scope: refused, env: ENV }), (e) => e.code === 'DF_STORE_SCOPE_REFUSED' && e.status === 401);
  assert.throws(() => createStore({ room, dataDir: c.dataDir, scope: 'Person_x', env: ENV }), (e) => e.code === 'DF_STORE_SCOPE_REFUSED');
  assert.throws(() => createStore({ room: { label: 'no id' }, dataDir: c.dataDir }), TypeError);
  assert.throws(() => createStore({ room }), TypeError);
  const bare = createStore({ room: room.manifest, dataDir: c.dataDir, env: ENV });
  assert.equal(bare.room, 'notes', 'a bare manifest works too');
}));
