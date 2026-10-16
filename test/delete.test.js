// dotfield delete: owner-only, removes records and sweeps every derived copy
// — the store .bak, link fields here and in other rooms, renders, connect
// scenes, run transcripts and run.json, proposals, outbound projections —
// and asserts afterwards that no file under data/ or .dotfield/ (the delete
// receipt included) still contains a deleted id. Temp dirs only, dry
// provider, one clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { runCli } from './helpers/cli.mjs';
import { EPOCH_ENV, NOW_ISO, cloneRoom, readJson, scaffoldCenter } from './helpers/center.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { createStore } from '../lib/store.mjs';
import { DERIVED_RE, idPattern, scrubRecord } from '../lib/commands/delete.mjs';

const SKEPTIC = { id: 'skeptic', display: 'Skeptic', tier: 'challenger', domain: 'review', primary_field: 'methodology', adjacent_fields: [], lens: 'the burden of proof is on the claim', keywords: ['review', 'verify'], challenger_for: ['scribe'], influences: [], constraint: 'never approves; it only asks for evidence', prompt: null };
const cli = (args, c, env = {}, extra = {}) => runCli(args, { cwd: c.root, env: { ...EPOCH_ENV, ...env }, ...extra });
const codes = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.code);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
/** Every file under data/ and .dotfield/ whose bytes mention the id as a whole token. */
function mentions(c, id) {
  const re = idPattern([id]);
  return [...walk(c.dataDir), ...walk(c.dotDir)].filter((f) => { re.lastIndex = 0; return re.test(readFileSync(f, 'utf8')); }).map((f) => f.slice(c.root.length + 1));
}

/** A center with records in two rooms (papers links into notes), a render, a dry run, an import proposal, a .bak and the owner token. */
async function populated(dir) {
  const c = scaffoldCenter(dir);
  cloneRoom(c, 'notes', 'papers', (d) => { d.label = 'Papers'; d.desks = [SKEPTIC]; });
  mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
  writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'delete-test-session-key\n');
  const token = join(c.dataDir, 'keys', 'owner.token');
  writeFileSync(token, 'delete-test-owner-token\n', { mode: 0o600 }); chmodSync(token, 0o600);
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const examples = readJson(c.roomFile('notes', 'examples.json'));
  const notes = createStore({ room: d.rooms.find((r) => r.id === 'notes'), dataDir: c.dataDir, config: c.config, env: {}, root: c.root });
  await notes.write(examples.slice(0, 3), { approved: true, now: new Date(NOW_ISO), by: 'test' });
  await notes.write(examples, { approved: true, now: new Date(NOW_ISO), by: 'test' }); // leaves a .bak that names every id
  const papers = createStore({ room: d.rooms.find((r) => r.id === 'papers'), dataDir: c.dataDir, config: c.config, env: {}, root: c.root });
  await papers.write([{ note_id: 'paper-1', title: 'Survey', body: 'cites note-0001 by id', tags: ['reading'], links: ['note-0001', 'note-0003'], logged_on: '2026-09-02' }], { approved: true, now: new Date(NOW_ISO), by: 'test' });
  assert.equal(cli(['render', 'room:notes/graph', '--json'], c).code, 0);
  assert.equal(cli(['connect', '--between', 'notes,papers', '--json'], c).code, 0);
  assert.equal(cli(['run', 'summarize the calibration note', '--provider', 'dry', '--budget', '20000', '--json'], c).code, 3);
  assert.equal(cli(['import', 'records', 'notes', join(c.root, 'center', 'rooms', 'notes', 'examples.json'), '--json'], c).code, 3);
  return { c, token, notes, papers };
}

test('DERIVED_RE: renders, imports, connect scenes, the template demo and outbound projections are derived; sketches, receipts and proposals are not', () => {
  for (const rel of ['.dotfield/renders/x/out.html', '.dotfield/imports/a.json', '.dotfield/connect/s.json', '.dotfield/demo/index.html', '.dotfield/demo/graph.html', 'data/projections/p.json']) assert.ok(DERIVED_RE.test(rel), rel);
  for (const rel of ['.dotfield/sketches/mine.sketch.json', '.dotfield/receipts/r.json', '.dotfield/benchmark/q.json', 'data/proposals/p.json', '.dotfield/demolition/x.html', 'x/.dotfield/demo/y.html']) assert.ok(!DERIVED_RE.test(rel), rel);
});

test('idPattern matches whole ids only; scrubRecord drops deleted links and redacts strings', () => {
  const re = idPattern(['note-1', 'x.y']);
  assert.ok(re.test('id notes-note-1 here')); re.lastIndex = 0;
  assert.ok(!re.test('note-10')); re.lastIndex = 0;
  assert.ok(re.test('(x.y)')); re.lastIndex = 0;
  assert.ok(!re.test('xzy'));
  const out = scrubRecord({ note_id: 'n2', body: 'see note-1 and note-10', links: ['note-1', 'n3'], parent: 'note-1' }, { re: idPattern(['note-1']), linkFields: ['links', 'parent'], ids: new Set(['note-1']) });
  assert.deepEqual(out, { note_id: 'n2', body: 'see [deleted] and note-10', links: ['n3'], parent: null });
});

test('delete --records sweeps every trace: no file under data/ or .dotfield/ still contains the id, links are scrubbed, the receipt names no id', async () => {
  await withTmp(async (dir) => {
    const { c, token } = await populated(dir);
    mkdirSync(join(c.dotDir, 'demo'), { recursive: true });
    writeFileSync(join(c.dotDir, 'demo', 'graph.html'), '<p>note-0001</p>\n');
    mkdirSync(join(c.dotDir, 'sketches'), { recursive: true });
    writeFileSync(join(c.dotDir, 'sketches', 'mine.sketch.json'), '{"nodes": ["note-0001", "note-0002"]}\n');
    const before = mentions(c, 'note-0001');
    for (const must of ['data/rooms/notes.json', 'data/rooms/notes.json.bak', 'data/rooms/papers.json', '.dotfield/runs']) assert.ok(before.some((f) => f.startsWith(must)), `${must} should name the id before delete: ${before.join(', ')}`);
    assert.ok(before.some((f) => /^\.dotfield\/renders\/.*\/out\.html$/.test(f)) && before.some((f) => f.startsWith('data/proposals/')));
    const piped = cli(['delete', 'notes', '--records', 'note-0001', '--json'], c, {}, { stdin: '' });
    assert.equal(piped.code, 3); assert.ok(codes(piped.json).includes('DF_APPROVE_NOT_OWNER'));
    assert.equal(readJson(join(c.dataDir, 'rooms', 'notes.json')).count, 4, 'a refused delete changes nothing');
    const r = cli(['delete', 'notes', '--records', 'note-0001', '--token-file', token, '--json'], c);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.status, 'written');
    assert.ok(!JSON.stringify(r.json).includes('note-0001'), 'the delete receipt never carries the id (argv is redacted)');
    assert.ok(r.json.outputs.some((o) => o.action === 'removed' && o.ref.endsWith('.bak')));
    assert.ok(r.json.outputs.some((o) => o.action === 'removed' && /renders\/.*out\.html$/.test(o.ref)));
    assert.ok(r.json.outputs.some((o) => o.action === 'redacted' && o.ref.startsWith('data/proposals/')));
    assert.ok(r.json.outputs.some((o) => o.action === 'redacted' && o.ref === 'data/rooms/papers.json'), 'the other room linking into notes is scrubbed');
    assert.ok(r.json.outputs.some((o) => o.action === 'removed' && o.ref === '.dotfield/demo/graph.html'), 'the template demo is derived output: removed');
    assert.ok(r.json.outputs.some((o) => o.action === 'redacted' && o.ref === '.dotfield/sketches/mine.sketch.json'), 'an authored sketch is redacted, never removed');
    assert.match(readFileSync(join(c.dotDir, 'sketches', 'mine.sketch.json'), 'utf8'), /\[deleted\]/);
    assert.deepEqual(mentions(c, 'note-0001'), [], 'nothing under data/ or .dotfield/ still contains the id');
    const store = readJson(join(c.dataDir, 'rooms', 'notes.json'));
    assert.deepEqual(store.records.map((x) => x.note_id), ['note-0002', 'note-0003', 'note-0004']);
    assert.deepEqual(store.records.find((x) => x.note_id === 'note-0003').links, ['note-0002']);
    assert.deepEqual(readJson(join(c.dataDir, 'rooms', 'papers.json')).records[0].links, ['note-0003']);
    assert.ok(!existsSync(join(c.dataDir, 'rooms', 'notes.json.bak')));
    const proposal = readdirSync(join(c.dataDir, 'proposals')).map((f) => readJson(join(c.dataDir, 'proposals', f))).find((p) => p.kind === 'records');
    assert.equal(proposal.records.length, 3); assert.equal(proposal.ext.redacted_by_delete.ids, 1);
    assert.ok(existsSync(join(c.dotDir, 'receipts', `${r.json.receipt_id}.json`)));
    assert.equal(cli(['verify', join(c.dotDir, 'receipts', `${r.json.receipt_id}.json`), '--json'], c).code, 0, 'the delete receipt verifies');
    const again = cli(['delete', 'notes', '--records', 'note-0001', '--token-file', token, '--json'], c);
    assert.equal(again.code, 0); assert.equal(again.json.status, 'read');
  });
});

test('delete --all empties the room; a person scope is refused; a corrupt store is a storage fault (exit 4)', async () => {
  await withTmp(async (dir) => {
    const { c, token } = await populated(dir);
    assert.equal(cli(['delete', 'notes', '--all', '--as', 'ada', '--token-file', token, '--json'], c).code, 3);
    const r = cli(['delete', 'notes', '--all', '--token-file', token, '--json'], c);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readJson(join(c.dataDir, 'rooms', 'notes.json')).count, 0);
    for (const id of ['note-0001', 'note-0002', 'note-0003', 'note-0004']) assert.deepEqual(mentions(c, id), [], id);
    assert.equal(cli(['delete', 'notes', '--json'], c).code, 1, 'neither --records nor --all is a usage error');
    assert.equal(cli(['delete', 'nope', '--all', '--token-file', token, '--json'], c).code, 2);
    writeFileSync(join(c.dataDir, 'rooms', 'papers.json'), '{not json');
    const bad = cli(['delete', 'papers', '--all', '--token-file', token, '--json'], c);
    assert.equal(bad.code, 4); assert.ok(codes(bad.json).includes('DF_STORE_CORRUPT'));
    assert.equal(statSync(token).mode & 0o077, process.platform === 'win32' ? statSync(token).mode & 0o077 : 0);
  });
});
