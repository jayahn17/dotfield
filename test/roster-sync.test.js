// roster == router == MCP enum: one desk universe. buildRoster lifts room
// desks unchanged (room.schema.json#/$defs/desk keys plus room and parent),
// the router scores exactly that set, examples/roster.example.json is the
// byte-honest output of buildRoster over the manifests below, and mcp/ (when
// it exists) must derive its desk enum from lib/agents/roster.mjs rather than
// write one by hand. node:test, no network, no temp dirs needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENTER_MIN, readJson } from './helpers/center.mjs';
import { discoverRooms, loadConfig } from '../lib/rooms.mjs';
import { loadSchema, resolvePointer, validate } from '../lib/validate.mjs';
import { CONDUCTOR_ID, DESK_KEYS, buildRoster, deskById, deskIds, desksForRooms, liftDesk } from '../lib/agents/roster.mjs';
import { route } from '../lib/agents/router.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'examples', 'roster.example.json');

const desk = (o) => ({ adjacent_fields: [], challenger_for: [], influences: [], prompt: null, ...o });
/** The manifests examples/roster.example.json was generated from (a robotics-lab-shaped center). */
const MANIFESTS = [
  { id: 'robots', desks: [desk({ id: 'sim-ops', display: 'Simulation ops', tier: 'core', domain: 'robot simulation', primary_field: 'simulation', adjacent_fields: ['control', 'kinematics'], lens: 'a simulator is a hypothesis about the plant, not the plant', keywords: ['simulation', 'sim', 'urdf', 'gazebo', 'robot', 'platform'], influences: ['data-ops'], constraint: 'never starts a simulator; proposes the launch file' })] },
  { id: 'experiments', desks: [
    desk({ id: 'method-review', display: 'Method review', tier: 'challenger', domain: 'experimental robotics', primary_field: 'robot evaluation', adjacent_fields: ['statistics', 'metrology'], lens: 'an experiment is a measurement with an error budget, not a demo', keywords: ['experiment', 'metric', 'ate', 'benchmark', 'ablation'], challenger_for: ['sim-ops'], influences: ['data-ops'], constraint: 'never reports a number without a record id as evidence' }),
    desk({ id: 'safety', display: 'Safety', tier: 'challenger', domain: 'lab safety', primary_field: 'hardware safety', adjacent_fields: ['electrical engineering'], lens: 'every launch is a hazard review first', keywords: ['safety', 'estop', 'hardware', 'launch'], challenger_for: ['sim-ops', 'data-ops'], constraint: 'never names launch_hardware as done' }),
  ] },
  { id: 'datasets', desks: [desk({ id: 'data-ops', display: 'Data ops', tier: 'support', domain: 'dataset operations', primary_field: 'data engineering', adjacent_fields: ['storage', 'licensing'], lens: 'a dataset is a contract: modality, size, license, digest', keywords: ['dataset', 'data', 'license', 'modality', 'storage'], constraint: 'never uploads; proposes the manifest row' })] },
  { id: 'papers', desks: [desk({ id: 'lit-review', display: 'Literature review', tier: 'core', domain: 'literature', primary_field: 'robotics literature', adjacent_fields: ['citation analysis'], lens: 'a paper is a method with a claimed regime of validity', keywords: ['paper', 'citation', 'survey', 'method', 'reading', 'doi'], constraint: 'cites by record id, never by memory' })] },
  { id: 'notes', desks: [
    desk({ id: 'scribe', display: 'Scribe', tier: 'core', domain: 'note taking', primary_field: 'writing', adjacent_fields: ['archiving'], lens: 'a note is a dated claim with a source, not a passing thought', keywords: ['note', 'journal', 'draft', 'summary'], constraint: 'never invents a date; an undated note carries logged_on only' }),
    desk({ id: 'planner', display: 'Planner', tier: 'support', domain: 'planning', primary_field: 'project planning', adjacent_fields: ['scheduling'], lens: 'a plan is a list of dated commitments with an owner', keywords: ['plan', 'schedule', 'todo', 'milestone', 'deadline'], influences: ['scribe'], constraint: 'never commits the owner to a date without a note' }),
  ] },
  { id: 'contacts', desks: [desk({ id: 'skeptic', display: 'Skeptic', tier: 'challenger', domain: 'review', primary_field: 'methodology', adjacent_fields: ['statistics'], lens: 'the burden of proof is on the claim', keywords: ['review', 'check', 'doubt', 'verify'], challenger_for: ['scribe', 'planner'], constraint: 'never approves; it only asks for evidence' })] },
];
const CONFIG = { center: { name: 'Hall Lab', owner_person_id: 'self' }, conductor: { display: 'Conductor', lens: 'turn one question into a mission brief, route it to at most five desks and one challenger, and stop at awaiting_owner' } };
const clone = (x) => JSON.parse(JSON.stringify(x));

test('examples/roster.example.json is exactly buildRoster over the fixture manifests, and validates', () => {
  const { roster, checks, ok } = buildRoster(clone(MANIFESTS), CONFIG);
  assert.equal(ok, true, JSON.stringify(checks.filter((c) => c.status === 'fail')));
  const example = readJson(EXAMPLE);
  delete example.$schema;
  assert.deepEqual(example, roster, 'regenerate the example from the manifests in this test when the roster shape changes');
  assert.equal(validate(loadSchema('roster'), roster).ok, true);
  assert.deepEqual(deskIds(roster), ['data-ops', 'lit-review', 'method-review', 'planner', 'safety', 'scribe', 'sim-ops', 'skeptic']);
  assert.equal(roster.conductor.id, CONDUCTOR_ID);
  assert.equal(roster.conductor.display, 'Conductor');
  assert.match(roster.digest, /^sha256:[0-9a-f]{64}$/);
});

test('roster == router: route scores every roster desk, no more and no less, in every scope', () => {
  const { roster } = buildRoster(clone(MANIFESTS), CONFIG);
  const all = route('', roster);
  assert.deepEqual(all.scored.map((s) => s.id).sort(), deskIds(roster));
  assert.deepEqual(desksForRooms(roster).map((d) => d.id).sort(), deskIds(roster));
  const fromManifests = MANIFESTS.flatMap((m) => m.desks.map((d) => d.id)).sort();
  assert.deepEqual(deskIds(roster), fromManifests);
  assert.deepEqual(roster.sources.flatMap((s) => s.desk_ids).sort(), fromManifests);
  for (const m of MANIFESTS) {
    const scoped = route('', roster, { rooms: [m.id] });
    assert.deepEqual(scoped.scored.map((s) => s.id).sort(), m.desks.map((d) => d.id).sort(), m.id);
  }
  for (const d of roster.desks) assert.equal(deskById(roster, d.id), d);
});

test('a room desk lifts unchanged: roster desk keys = room.schema.json desk keys + room + parent', () => {
  const roomDesk = readJson(join(ROOT, 'schemas', 'room.schema.json')).$defs.desk;
  const rosterDesk = readJson(join(ROOT, 'schemas', 'roster.schema.json')).$defs.desk;
  const roomKeys = Object.keys(roomDesk.properties).sort();
  const rosterKeys = Object.keys(rosterDesk.properties).sort();
  assert.deepEqual(rosterKeys, [...roomKeys, 'parent', 'room'].sort());
  assert.deepEqual([...DESK_KEYS].sort(), rosterKeys);
  const roomSchema = readJson(join(ROOT, 'schemas', 'room.schema.json'));
  const rosterSchema = readJson(join(ROOT, 'schemas', 'roster.schema.json'));
  const deref = (node, root) => {
    if (Array.isArray(node)) return node.map((n) => deref(n, root));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') return deref(resolvePointer(root, node.$ref), root);
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, root)]));
  };
  for (const k of roomKeys) assert.deepEqual(deref(rosterDesk.properties[k], rosterSchema), deref(roomDesk.properties[k], roomSchema), `desk.${k} is the same constraint in both schemas`);
  assert.deepEqual(roomDesk.required.filter((k) => k !== 'constraint'), rosterDesk.required);
  const lifted = liftDesk(MANIFESTS[0].desks[0], 'robots');
  assert.equal(lifted.room, 'robots');
  assert.equal(lifted.parent, null);
  for (const k of Object.keys(MANIFESTS[0].desks[0])) assert.deepEqual(lifted[k], MANIFESTS[0].desks[0][k]);
});

test('duplicates, the reserved conductor id and unknown challenger_for/influences targets are DF_RUN_DESK_UNKNOWN', () => {
  const dup = clone(MANIFESTS);
  dup[3].desks.push(clone(MANIFESTS[4].desks[0]));
  const r1 = buildRoster(dup, CONFIG);
  assert.equal(r1.ok, false);
  const dupCheck = r1.checks.find((c) => c.code === 'DF_RUN_DESK_UNKNOWN' && c.status === 'fail');
  assert.match(dupCheck.path, /center\/rooms\/papers\/room\.json#\$\.desks\[1\]\.id/);
  assert.equal(deskById(r1.roster, 'scribe').room, 'notes', 'the first room (sorted by id) keeps the desk');
  assert.equal(r1.roster.desks.filter((d) => d.id === 'scribe').length, 1);
  const cond = clone(MANIFESTS);
  cond[0].desks.push(desk({ id: 'conductor', display: 'Not allowed', tier: 'core', domain: 'x', primary_field: 'x', lens: 'x', keywords: ['x'], constraint: 'x' }));
  const r2 = buildRoster(cond, CONFIG);
  assert.ok(r2.checks.some((c) => c.code === 'DF_RUN_DESK_UNKNOWN' && c.status === 'fail' && /reserved/.test(c.message)));
  assert.equal(deskById(r2.roster, 'conductor'), null);
  const unknown = clone(MANIFESTS);
  unknown[1].desks[0].challenger_for = ['ghost'];
  unknown[2].desks[0].influences = ['phantom'];
  const r3 = buildRoster(unknown, CONFIG);
  assert.equal(r3.ok, false);
  const msgs = r3.checks.filter((c) => c.code === 'DF_RUN_DESK_UNKNOWN' && c.status === 'fail').map((c) => c.path);
  assert.ok(msgs.some((p) => p.endsWith('desks[method-review].challenger_for[0]')));
  assert.ok(msgs.some((p) => p.endsWith('desks[data-ops].influences[0]')));
  const clean = buildRoster(clone(MANIFESTS), CONFIG);
  assert.ok(clean.checks.some((c) => c.code === 'DF_RUN_DESK_UNKNOWN' && c.status === 'pass'));
});

test('invalid rooms contribute nothing; the digest is stable and changes with any desk', () => {
  const entries = MANIFESTS.map((m) => ({ id: m.id, ok: true, manifest: clone(m) }));
  entries[1].ok = false;
  const r = buildRoster(entries, CONFIG);
  assert.deepEqual(deskIds(r.roster), ['data-ops', 'lit-review', 'planner', 'scribe', 'sim-ops', 'skeptic']);
  const a = buildRoster(clone(MANIFESTS), CONFIG).roster.digest;
  const b = buildRoster(clone(MANIFESTS), CONFIG).roster.digest;
  assert.equal(a, b);
  const changed = clone(MANIFESTS);
  changed[4].desks[0].keywords.push('memo');
  assert.notEqual(buildRoster(changed, CONFIG).roster.digest, a);
  const noConductor = buildRoster(clone(MANIFESTS), null).roster.conductor;
  assert.equal(noConductor.id, CONDUCTOR_ID);
  assert.ok(noConductor.lens.length > 10);
});

test('the fixture center yields one desk and no challenger: routing says so with DF_RUN_NO_CHALLENGER', () => {
  const d = discoverRooms(CENTER_MIN);
  const config = loadConfig(CENTER_MIN).config;
  const { roster, ok } = buildRoster(d.rooms, config);
  assert.equal(ok, true);
  assert.deepEqual(deskIds(roster), ['scribe']);
  assert.equal(roster.conductor.display, config.conductor.display);
  const r = route('write a note', roster);
  assert.deepEqual(r.specialists.map((s) => s.id), ['scribe']);
  assert.equal(r.challenger, null);
  assert.ok(r.checks.some((c) => c.code === 'DF_RUN_NO_CHALLENGER' && c.status === 'fail'));
});

test('MCP derives its desk enum from lib/agents/roster.mjs (binding once mcp/server.mjs exists)', (t) => {
  const file = join(ROOT, 'mcp', 'server.mjs');
  if (!existsSync(file)) return t.skip('mcp/server.mjs not built yet; when it lands it must import deskIds or buildRoster from lib/agents/roster.mjs');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /agents\/roster\.mjs/, 'mcp/server.mjs imports the roster module');
  assert.match(text, /\b(deskIds|buildRoster)\b/, 'the desk enum comes from deskIds()/buildRoster(), never a hand-written list');
  return undefined;
});
