// lib/rooms.mjs and the four schemas of this component: discovery of the
// minimal center, the registry, every DF_ROOM_* code raised by a mutated
// copy of the fixture, the views grammar and its JSONPath subset, prove
// state, config loading (no multi_person), and the exact open paths of each
// schema. Every mutation happens in a temp copy from test/helpers/center.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOM_FILES, buildRegistry, checkExamples, checkViews, discoverRooms, evalPath, listRoomIds, loadConfig, loadRoom, manifestFields,
  normalizeManifest, parsePath, proveState, schemaChecks, writeJsonAtomic, writeRegistry,
} from '../lib/rooms.mjs';
import { inspectSchema, loadSchema, openPaths, validate } from '../lib/validate.mjs';
import { RULES, codesForFamily } from '../lib/rules.mjs';
import { sha256File } from '../lib/digest.mjs';
import { CENTER_MIN, cloneRoom, patchJson, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { withTmp } from './helpers/tmp.mjs';

const fails = (checks, code) => checks.filter((c) => c.code === code && c.status === 'fail');
const codes = (checks) => [...new Set(checks.filter((c) => c.status === 'fail').map((c) => c.code))].sort();
const blockingCodes = (checks) => [...new Set(checks.filter((c) => c.status === 'fail' && c.blocking).map((c) => c.code))].sort();

test('the minimal center discovers one valid room; only DF_ROOM_MATURITY_UNPROVEN (non-blocking) fails before a prove', () => {
  const d = discoverRooms(CENTER_MIN, { dotDir: join(CENTER_MIN, 'no-such-dotdir') });
  assert.equal(d.ok, true);
  assert.deepEqual(d.rooms.map((r) => [r.id, r.ok]), [['notes', true]]);
  assert.deepEqual(codes(d.checks), ['DF_ROOM_MATURITY_UNPROVEN']);
  assert.deepEqual(blockingCodes(d.checks), []);
  const room = d.rooms[0];
  assert.equal(room.manifest.id, 'notes');
  assert.equal(room.manifest.store.max_records, 2000);
  assert.deepEqual(Object.keys(room.files).sort(), [...ROOM_FILES, 'actions.mjs', 'test.mjs'].sort());
  assert.equal(room.files['test.mjs'], null);
  assert.equal(room.recordSchema.properties.title.type, 'string');
  assert.equal(room.views.length, 2);
  assert.equal(room.examples.length, 4);
  assert.match(room.manifest_digest, /^sha256:/);
  assert.deepEqual(room.prove, { present: false, ok: null, current: false, maturity_reached: null, path: join(CENTER_MIN, 'no-such-dotdir', 'prove', 'notes.json') });
  for (const c of d.checks) {
    assert.deepEqual(Object.keys(c).slice(0, 4), ['code', 'gate', 'blocking', 'status'], 'the one check shape');
    if (c.status === 'fail') assert.ok(c.message && c.repair && c.path, JSON.stringify(c));
  }
  assert.ok(d.checks.some((c) => c.code === 'DF_ROOM_NAMESPACE_SHARED' && c.status === 'pass'));
  assert.deepEqual(listRoomIds(CENTER_MIN), ['notes']);
  assert.deepEqual(listRoomIds(join(CENTER_MIN, 'nope')), []);
});

test('the registry lists valid rooms only, is deterministic, carries its digest, and is written atomically', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const cfg = loadConfig(c.centerDir);
  assert.equal(cfg.ok, true, JSON.stringify(cfg.checks));
  const reg = buildRegistry(d.rooms, cfg.config);
  assert.equal(reg.schema_version, 'dotfield.registry/1');
  assert.deepEqual(reg.center, { name: 'Minimal center', owner_person_id: 'self' });
  assert.equal(reg.rooms.length, 1);
  assert.deepEqual(reg.invalid, []);
  const e = reg.rooms[0];
  assert.deepEqual(e.views, [{ id: 'graph', label: 'Note web', kind: 'graph' }, { id: 'timeline', label: 'Note history', kind: 'timeline' }]);
  assert.deepEqual(e.desks, [{ id: 'scribe', display: 'Scribe', tier: 'core' }]);
  assert.deepEqual(e.record.public_fields, ['title', 'tags']);
  assert.deepEqual(e.files, { test: false, actions: false });
  assert.equal(e.prove.present, false);
  assert.equal(JSON.stringify(buildRegistry(d.rooms, cfg.config)), JSON.stringify(reg), 'same input, same bytes');
  assert.match(reg.digest, /^sha256:[0-9a-f]{64}$/);
  const file = writeRegistry(reg, c.dotDir);
  assert.equal(file, join(c.dotDir, 'registry.json'));
  assert.deepEqual(readJson(file), reg);
  assert.ok(!existsSync(`${file}.tmp`));
  cloneRoom(c, 'notes', 'broken', (doc) => { doc.record.label_field = 'nope'; });
  const d2 = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const reg2 = buildRegistry(d2.rooms, cfg.config);
  assert.deepEqual(reg2.rooms.map((r) => r.id), ['notes']);
  assert.deepEqual(reg2.invalid, [{ id: 'broken', codes: ['DF_ROOM_FIELD_MISSING'] }]);
  assert.equal(buildRegistry([], null).center.owner_person_id, 'self');
}));

test('the four schemas: supported subset only, dotfield ids, exact open paths; openPaths terminates on record-meta', () => {
  for (const [name, open] of [['room', ['$.ext']], ['proposal', ['$.ext', '$.records[*]', '$.summary.sample_rows[*]']], ['center-config', ['$.ext']]]) {
    const s = loadSchema(name);
    assert.deepEqual(inspectSchema(s), [], name);
    assert.equal(s.$id, `dotfield.${name}/1`);
    assert.deepEqual(openPaths(s), open, `${name} open maps`);
  }
  const meta = loadSchema('record-meta');
  assert.deepEqual(inspectSchema(meta), []);
  assert.equal(meta.$id, 'dotfield.record-meta/1');
  const open = openPaths(meta);
  assert.ok(open.includes('$.properties') && open.every((p) => p.startsWith('$.properties') || p.startsWith('$.$defs')), JSON.stringify(open));
});

test('the fixture validates file by file against its schemas, and the views file against the grammar', () => {
  const dir = join(CENTER_MIN, 'rooms', 'notes');
  assert.equal(validate(loadSchema('room'), readJson(join(dir, 'room.json'))).ok, true);
  assert.equal(validate(loadSchema('record-meta'), readJson(join(dir, 'record.schema.json'))).ok, true);
  assert.deepEqual(checkViews(readJson(join(dir, 'views.json')), readJson(join(dir, 'record.schema.json')), ['notes']).filter((c) => c.status === 'fail'), []);
  assert.deepEqual(checkExamples(readJson(join(dir, 'examples.json')), readJson(join(dir, 'record.schema.json'))).map((c) => c.status), ['pass']);
  assert.equal(validate(loadSchema('center-config'), readJson(join(CENTER_MIN, 'center.config.json'))).ok, true);
  assert.equal(validate(loadSchema('brand'), readJson(join(CENTER_MIN, 'brand.json'))).ok, true);
  const people = readJson(join(CENTER_MIN, 'people', 'people.json')).people;
  assert.deepEqual(people.filter((p) => p.kind === 'self').map((p) => p.person_id), ['self'], 'exactly one kind: self');
});

test('DF_ROOM_FILE_MISSING: an absent or unparsable required file; the room is not registered', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  rmSync(c.roomFile('notes', 'views.json'));
  let r = loadRoom(c.centerDir, 'notes');
  assert.equal(r.ok, false);
  assert.deepEqual(fails(r.checks, 'DF_ROOM_FILE_MISSING').map((x) => x.path), ['center/rooms/notes/views.json']);
  assert.equal(r.manifest.id, 'notes', 'the other files are still read');
  writeFileSync(c.roomFile('notes', 'room.json'), '{ not json');
  r = loadRoom(c.centerDir, 'notes');
  assert.deepEqual(fails(r.checks, 'DF_ROOM_FILE_MISSING').map((x) => x.path).sort(), ['center/rooms/notes/room.json', 'center/rooms/notes/views.json']);
  assert.match(fails(r.checks, 'DF_ROOM_FILE_MISSING')[0].message, /not valid JSON/);
  assert.equal(r.manifest, null);
  assert.equal(discoverRooms(c.centerDir).rooms[0].ok, false);
}));

test('DF_ROOM_ID_MISMATCH, DF_ROOM_FIELD_MISSING (every manifest field incl. public_fields), DF_ROOM_LINK_ROOM_UNKNOWN (non-blocking)', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  patchJson(c.roomFile('notes', 'room.json'), (doc) => {
    doc.id = 'other';
    doc.record.label_field = 'titel';
    doc.record.public_fields = ['title', 'secret'];
    doc.record.dates.happened_on = 'when';
    doc.record.link_fields.push({ field: 'paper_ids', to_room: 'papers', kind: 'cites' });
  });
  const d = discoverRooms(c.centerDir);
  const r = d.rooms[0];
  assert.equal(r.ok, false);
  assert.deepEqual(fails(r.checks, 'DF_ROOM_ID_MISMATCH').map((x) => x.path), ['center/rooms/notes/room.json#$.id']);
  assert.deepEqual(fails(r.checks, 'DF_ROOM_FIELD_MISSING').map((x) => x.path).sort(), [
    'room.json#$.record.dates.happened_on', 'room.json#$.record.label_field', 'room.json#$.record.link_fields[1].field', 'room.json#$.record.public_fields[1]',
  ]);
  const link = fails(d.checks, 'DF_ROOM_LINK_ROOM_UNKNOWN');
  assert.equal(link.length, 1);
  assert.equal(link[0].blocking, false);
  assert.equal(link[0].path, 'center/rooms/notes/room.json#$.record.link_fields[1].to_room');
  assert.deepEqual(manifestFields(r.manifest).map((f) => f.field), ['note_id', 'titel', 'body', 'tags', 'score', 'when', 'logged_on', 'links', 'paper_ids', 'title', 'secret']);
}));

test('DF_ROOM_NAMESPACE_SHARED flags both rooms; a link to a sibling room resolves', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  cloneRoom(c, 'notes', 'journal', (doc) => { doc.store.namespace = 'notes'; doc.record.link_fields = [{ field: 'links', to_room: 'notes', kind: 'relates' }]; });
  const d = discoverRooms(c.centerDir);
  assert.equal(d.ok, false);
  assert.deepEqual(fails(d.checks, 'DF_ROOM_NAMESPACE_SHARED').map((x) => x.path).sort(), ['center/rooms/journal/room.json#$.store.namespace', 'center/rooms/notes/room.json#$.store.namespace']);
  assert.deepEqual(d.rooms.map((r) => r.ok), [false, false]);
  assert.deepEqual(fails(d.checks, 'DF_ROOM_LINK_ROOM_UNKNOWN'), []);
  patchJson(c.roomFile('journal', 'room.json'), (doc) => { doc.store.namespace = 'journal'; });
  assert.equal(discoverRooms(c.centerDir).ok, true);
}));

test('DF_ROOM_EXAMPLES_INVALID: count outside 3..20 and a record that fails record.schema.json', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  const ex = readJson(c.roomFile('notes', 'examples.json'));
  writeJson(c.roomFile('notes', 'examples.json'), ex.slice(0, 2));
  let r = loadRoom(c.centerDir, 'notes');
  assert.deepEqual(fails(r.checks, 'DF_ROOM_EXAMPLES_INVALID').map((x) => x.path), ['examples.json#$']);
  ex[1].title = 7;
  ex[2].surprise = true;
  writeJson(c.roomFile('notes', 'examples.json'), ex);
  r = loadRoom(c.centerDir, 'notes');
  const bad = fails(r.checks, 'DF_ROOM_EXAMPLES_INVALID');
  assert.deepEqual(bad.map((x) => x.path), ['examples.json#$[1]', 'examples.json#$[2]']);
  assert.match(bad[0].message, /DF_SCHEMA_TYPE/);
  assert.match(bad[1].message, /DF_SCHEMA_UNKNOWN_FIELD/);
  assert.equal(r.ok, false);
  assert.equal(checkExamples('nope', {})[0].code, 'DF_ROOM_EXAMPLES_INVALID');
}));

test('DF_ROOM_PROOF_COMMAND_FORBIDDEN and DF_ROOM_MODE_DEPRECATED (non-blocking, read as proposal_only)', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  patchJson(c.roomFile('notes', 'room.json'), (doc) => { doc.proof.command = 'npm test'; doc.mode = 'write_after_approval'; });
  const r = loadRoom(c.centerDir, 'notes');
  assert.deepEqual(fails(r.checks, 'DF_ROOM_PROOF_COMMAND_FORBIDDEN').map((x) => [x.path, x.blocking]), [['center/rooms/notes/room.json#$.proof.command', true]]);
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MODE_DEPRECATED').map((x) => x.blocking), [false]);
  assert.equal(r.manifest.mode, 'proposal_only');
  assert.equal(r.ok, false, 'the proof.command is blocking');
  assert.deepEqual(fails(r.checks, 'DF_SCHEMA_UNKNOWN_FIELD'), [], 'the forbidden key is reported once, under its own code');
  const n = normalizeManifest({ mode: 'write_after_approval', store: {}, record: {} });
  assert.equal(n.manifest.mode, 'proposal_only');
  assert.deepEqual(n.manifest.store, { max_records: 2000, max_record_bytes: 16384 });
  assert.equal(normalizeManifest(null).manifest, null);
}));

test('room.json schema findings: no mode without the owner write gate, unknown fields, bad enums', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  patchJson(c.roomFile('notes', 'room.json'), (doc) => { doc.owner_gates.writes = 'blocked'; doc.extra = 1; doc.mode = 'open'; });
  const r = loadRoom(c.centerDir, 'notes');
  assert.equal(r.ok, false);
  assert.equal(r.manifest, null, 'an invalid manifest is not normalised into a room');
  assert.deepEqual(fails(r.checks, 'DF_SCHEMA_ENUM').map((x) => x.path).sort(), ['center/rooms/notes/room.json#$.mode', 'center/rooms/notes/room.json#$.owner_gates.writes']);
  assert.deepEqual(fails(r.checks, 'DF_SCHEMA_UNKNOWN_FIELD').map((x) => x.path), ['center/rooms/notes/room.json#$.extra']);
  assert.equal(validate(loadSchema('room'), { ...readJson(c.roomFile('notes', 'room.json')), owner_gates: { writes: 'required', external_sends: 'blocked', share: 'blocked', aggregate: 'blocked', train: 'blocked' }, mode: 'proposal_only', extra: undefined }).errors[0].path, '$.owner_gates.share');
  assert.equal(schemaChecks([{ code: 'DF_SCHEMA_TYPE', path: '$.x', message: 'm', repair: 'r' }], 'f.json')[0].path, 'f.json#$.x');
}));

test('DF_ROOM_VIEW_INVALID: grammar, timeline without date, board without lane, undeclared field, unknown lens, duplicate id; unknown include_rooms is non-blocking', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  const views = readJson(c.roomFile('notes', 'views.json'));
  views[1].date = undefined;
  views[0].node.label = '$.title|upper';
  views[0].node.sublabel = '$.summary';
  views[0].limit.default_lens = 'missing';
  views[0].include_rooms = ['papers'];
  views.push({ id: 'graph', label: 'Dup', kind: 'board', node: { kind: 'record', label: '$.title' } });
  writeJson(c.roomFile('notes', 'views.json'), views);
  const r = loadRoom(c.centerDir, 'notes');
  const bad = fails(r.checks, 'DF_ROOM_VIEW_INVALID');
  assert.deepEqual(bad.map((x) => x.path).sort(), ['views.json#$[0].limit.default_lens', 'views.json#$[0].node.label', 'views.json#$[0].node.sublabel', 'views.json#$[1].date', 'views.json#$[2].id', 'views.json#$[2].lane']);
  assert.ok(bad.every((x) => x.blocking && x.repair.includes('ROOMS.md')));
  assert.deepEqual(fails(r.checks, 'DF_ROOM_LINK_ROOM_UNKNOWN').map((x) => [x.path, x.blocking]), [['views.json#$[0].include_rooms', false]]);
  assert.equal(r.ok, false);
  assert.equal(checkViews('not an array', {})[0].code, 'DF_ROOM_VIEW_INVALID');
  assert.deepEqual(checkViews([{ id: 'g', label: 'G', kind: 'graph', node: { kind: 'record', label: '$.title' }, include_rooms: ['notes'] }], { properties: { title: {} } }, ['notes']).map((x) => x.status), ['pass', 'pass']);
}));

test('the JSONPath subset: $.a.b, $.a[*], $.a[0], /n; everything else is refused', () => {
  const rec = { title: 'T', tags: ['x', 'y'], score: 7, runs: [{ ate: 0.1 }, { ate: 0.2 }], meta: { depth: { n: 4 } } };
  assert.equal(evalPath(rec, '$.title'), 'T');
  assert.equal(evalPath(rec, '$.tags[0]'), 'x');
  assert.equal(evalPath(rec, '$.tags[5]'), undefined);
  assert.deepEqual(evalPath(rec, '$.tags[*]'), ['x', 'y']);
  assert.deepEqual(evalPath(rec, '$.runs[*].ate'), [0.1, 0.2]);
  assert.deepEqual(evalPath(rec, '$.runs[*].ate/2'), [0.05, 0.1]);
  assert.equal(evalPath(rec, '$.score/10'), 0.7);
  assert.equal(evalPath(rec, '$.meta.depth.n'), 4);
  assert.equal(evalPath(rec, '$.title/10'), 'T', '/n leaves non-numbers alone');
  assert.equal(evalPath(rec, '$.missing.x'), undefined);
  assert.equal(evalPath(rec, '$.title.x'), undefined);
  assert.equal(evalPath(null, '$.title'), undefined);
  for (const bad of ['$', '$a', '$.Title', '$.a[-1]', '$.a/0', '$.a|upper', 'title', '$.a.b.c.d.e.f.g', '$.a[*][*]', '$..a', '']) {
    assert.equal(parsePath(bad).ok, false, bad);
    assert.equal(evalPath(rec, bad), undefined, bad);
  }
  assert.deepEqual(parsePath('$.runs[*].ate/2'), { ok: true, segments: [{ key: 'runs', index: '*' }, { key: 'ate', index: null }], divide: 2 });
  assert.deepEqual(parsePath('$.tags[3]').segments, [{ key: 'tags', index: 3 }]);
});

test('maturity: tested without test.mjs is DF_ROOM_MATURITY_OVERCLAIM; prove records absent, stale, failed (blocking) and passing', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  patchJson(c.roomFile('notes', 'room.json'), (doc) => { doc.maturity = 'tested'; });
  let r = loadRoom(c.centerDir, 'notes', { dotDir: c.dotDir });
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MATURITY_OVERCLAIM').map((x) => x.blocking), [true]);
  assert.equal(r.ok, false);
  writeFileSync(c.roomFile('notes', 'test.mjs'), "import test from 'node:test';\ntest('x', () => {});\n");
  r = loadRoom(c.centerDir, 'notes', { dotDir: c.dotDir });
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MATURITY_OVERCLAIM'), []);
  assert.equal(r.files['test.mjs'], c.roomFile('notes', 'test.mjs'));
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MATURITY_UNPROVEN').map((x) => x.blocking), [false]);
  assert.equal(r.ok, true, 'unproven is not blocking');
  const digest = sha256File(c.roomFile('notes', 'room.json'));
  const proveFile = join(c.dotDir, 'prove', 'notes.json');
  writeJson(proveFile, { schema_version: 'dotfield.prove/1', room: 'notes', ok: true, maturity_reached: 'tested', manifest_digest: digest, proved_at: '2026-10-01T10:15:00Z', receipt_ref: null });
  r = loadRoom(c.centerDir, 'notes', { dotDir: c.dotDir });
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MATURITY_UNPROVEN'), []);
  assert.deepEqual(r.prove, { present: true, ok: true, current: true, maturity_reached: 'tested', path: proveFile });
  writeJson(proveFile, { schema_version: 'dotfield.prove/1', room: 'notes', ok: false, maturity_reached: null, manifest_digest: digest, proved_at: '2026-10-01T10:15:00Z', receipt_ref: null });
  r = loadRoom(c.centerDir, 'notes', { dotDir: c.dotDir });
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MATURITY_UNPROVEN').map((x) => x.blocking), [true], 'a failed prove of this exact manifest blocks');
  assert.equal(r.ok, false);
  patchJson(c.roomFile('notes', 'room.json'), (doc) => { doc.purpose = 'edited after the prove'; });
  r = loadRoom(c.centerDir, 'notes', { dotDir: c.dotDir });
  assert.deepEqual(fails(r.checks, 'DF_ROOM_MATURITY_UNPROVEN').map((x) => [x.blocking, /predates/.test(x.message)]), [[false, true]], 'a stale prove record is non-blocking');
  assert.equal(proveState(null, 'notes', digest).present, false);
  writeFileSync(proveFile, 'garbage');
  assert.deepEqual(proveState(c.dotDir, 'notes', digest).ok, false);
}));

test('center.config.json: loads and validates; multi_person is an unknown field; absent or unparsable files are findings, not throws', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  patchJson(c.configPath, (doc) => { doc.multi_person = true; });
  let r = loadConfig(c.centerDir);
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.map((x) => [x.code, x.path]), [['DF_SCHEMA_UNKNOWN_FIELD', 'center/center.config.json#$.multi_person']]);
  assert.equal(r.config, null);
  writeFileSync(c.configPath, 'nope');
  r = loadConfig(c.centerDir);
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].code, 'DF_SCHEMA_TYPE');
  rmSync(c.configPath);
  r = loadConfig(c.centerDir);
  assert.equal(r.checks[0].code, 'DF_SCHEMA_REQUIRED');
  assert.match(r.checks[0].message, /dotfield init/);
  const good = readJson(join(CENTER_MIN, 'center.config.json'));
  assert.equal(validate(loadSchema('center-config'), good).ok, true);
  assert.equal(validate(loadSchema('center-config'), { ...good, store: { allow_env_pins: false, object_store_url: 'ftp://x' } }).errors[0].code, 'DF_SCHEMA_PATTERN');
  assert.equal(validate(loadSchema('center-config'), { ...good, approval: { max_records_per_proposal: 0 } }).errors[0].code, 'DF_SCHEMA_MINIMUM');
}));

test('every room-family code is raised by this file or explained; writeJsonAtomic leaves no tmp file', () => withTmp(async (dir) => {
  const raisedHere = ['DF_ROOM_FILE_MISSING', 'DF_ROOM_ID_MISMATCH', 'DF_ROOM_FIELD_MISSING', 'DF_ROOM_EXAMPLES_INVALID', 'DF_ROOM_MATURITY_UNPROVEN', 'DF_ROOM_MATURITY_OVERCLAIM',
    'DF_ROOM_PROOF_COMMAND_FORBIDDEN', 'DF_ROOM_NAMESPACE_SHARED', 'DF_ROOM_MODE_DEPRECATED', 'DF_ROOM_VIEW_INVALID', 'DF_ROOM_LINK_ROOM_UNKNOWN'];
  assert.deepEqual([...codesForFamily('room')].sort(), [...raisedHere].sort(), 'lib/rules/room.mjs and lib/rooms.mjs agree on the family');
  assert.equal(RULES.DF_ROOM_MATURITY_UNPROVEN.blocking, false);
  const file = join(dir, 'a', 'b.json');
  mkdirSync(join(dir, 'a'), { recursive: true });
  writeJsonAtomic(file, { x: 1 });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "x": 1\n}\n');
  assert.ok(!existsSync(`${file}.tmp`));
}));
