// lib/project.mjs, the one exit door: records -> scene per view kind,
// deterministic and gate-clean under requireProjected; the three dates;
// defaults private; the public_fields ceiling on label, sublabel and tags for
// anyone but the owner; viewers (self, a granted person, an ungranted person,
// the public viewer, a blocked room); limit -> projected.dropped; overlays
// merged live and dropped expired; taint computed transitively; and the
// promise that project() writes nothing. Every test boots a scaffolded center
// inside its own temp dir; no network, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverRooms } from '../lib/rooms.mjs';
import { createStore } from '../lib/store.mjs';
import { DEFAULT_MAX_NODES, applyLimit, nodeIdFor, project, projectDetailed, readRecords, seriesToken, viewerSpec } from '../lib/project.mjs';
import { STUB_RE } from '../lib/share.mjs';
import { emptyOverlay, overlayPath } from '../lib/overlay.mjs';
import { writeJsonAtomic } from '../lib/rooms.mjs';
import { canonical, sha256 } from '../lib/digest.mjs';
import * as schemaGate from '../lib/gates/schema.mjs';
import * as topology from '../lib/gates/topology.mjs';
import * as privacy from '../lib/gates/privacy.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { shared } from './fixtures/ir/build-fixtures.mjs';
import { NOW, cloneRoom, patchJson, readJson, scaffoldCenter } from './helpers/center.mjs';
import { withTmp } from './helpers/tmp.mjs';

const ENV = {};
const KEY = 'project-test-session-key';
const SALT = `base64:${Buffer.alloc(32, 5).toString('base64')}`;
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const codes = (checks) => [...new Set(fails(checks).map((c) => c.code))].sort();
const gates = (scene, ctx) => [...schemaGate.check(scene, ctx), ...topology.check(scene, ctx), ...privacy.check(scene, ctx)];
const ids = (scene) => scene.nodes.map((n) => n.id);

/** A boundary stub as data/overlays/ada.json stores it. */
const stub = (id, expires, extra = {}) => ({
  id, kind: 'boundary', label: 'Inspection cadence', tags: ['vibration'], fields: { title: 'Inspection cadence' },
  provenance: { owner_person_id: 'ada', source: { kind: 'share', ref: 'proj-ada-to-self-rule-01-20260920', digest: `sha256:${'e7'.repeat(32)}` }, captured_on: '2026-09-20', released_on: '2026-09-20', imported_via_rule_ref: 'ada/rule-01' },
  audience: { privacy_level: 'private', share_rule_ids: ['rule-01'] }, boundary: { rule_ref: 'ada/rule-01', digest: `sha256:${'e7'.repeat(32)}`, shared_by: 'ada', released_on: '2026-09-20', expires_on: expires, key_id: 'ada-k1' },
  weight: 0.3, color_token: 'foreign', status: 'accepted', evidence_ids: [], ...extra,
});

function rule(over = {}) {
  return {
    schema_version: 'dotfield.share-rule/1', rule_id: 'rule-01', grantor_person_id: 'self', receiver: { type: 'person', id: 'ada' },
    subject: { selector: { rooms: ['notes'], tags: ['idea'] } }, switches: { view: true, annotate: true, re_share: false, aggregate: false, train: false },
    redaction: { privacy_level_ceiling: 'private', fields_allowed: ['title', 'tags'], operators: [], salt: SALT },
    dates: { granted_on: '2026-10-01', released_on: '2026-10-01', expires_on: '2027-10-01' }, state: 'active',
    approval: { proposal_id: 'prop_20261001T101500Z_0a0a0a', decided_at: '2026-10-01T10:15:00Z', receipt_ref: null }, evidence_refs: [], ...over,
  };
}

async function boot(dir, { patch = null, seed = true } = {}) {
  const c = scaffoldCenter(dir);
  if (patch) patchJson(c.roomFile('notes', 'room.json'), patch);
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  assert.equal(d.ok, true, JSON.stringify(fails(d.checks)));
  if (seed) {
    const store = createStore({ room: d.rooms[0], dataDir: c.dataDir, config: c.config, env: ENV, root: c.root });
    await store.write(readJson(c.roomFile('notes', 'examples.json')), { approved: true, now: NOW, by: 'test' });
  }
  const base = { rooms: d, now: NOW, dataDir: c.dataDir, config: c.config, env: ENV, root: c.root, sessionKey: KEY };
  return { c, d, room: d.rooms[0], base, ctx: { sessionKey: KEY, requireProjected: true, rooms: d, config: c.config } };
}

test('notes graph for self: schema-valid, gate-clean, deterministic; one node per record, one edge per link, groups by first tag, the three dates, fields under the public ceiling', () => withTmp(async (dir) => {
  const { base, ctx } = await boot(dir);
  const r = await projectDetailed({ ...base, view: 'room:notes/graph' });
  const s = r.scene;
  assert.equal(validate(loadSchema('scene'), s).ok, true, JSON.stringify(validate(loadSchema('scene'), s).errors));
  assert.deepEqual(fails(gates(s, ctx)), [], 'clean through schema, topology and privacy with the stamp required');
  assert.deepEqual(fails(r.checks), [], 'no unresolved link, no store fault');
  assert.deepEqual(await project({ ...base, view: 'notes/graph' }), s, 'same inputs, same scene');
  assert.equal(s.kind, 'graph');
  assert.deepEqual(s.meta, { id: 'notes-graph', title: 'Notes — Note web', theme: 'paper', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'local_beta', legend: true, room: 'notes', view: 'graph' });
  assert.deepEqual(s.viewer, { person_id: 'self', mode: 'self', rule_refs: [] });
  assert.deepEqual(ids(s), ['notes-note-0001', 'notes-note-0002', 'notes-note-0003', 'notes-note-0004']);
  assert.deepEqual(s.edges.map((e) => `${e.from}>${e.to}:${e.kind}:${e.directed}`), ['notes-note-0001>notes-note-0002:relates:false', 'notes-note-0003>notes-note-0001:relates:false', 'notes-note-0003>notes-note-0002:relates:false', 'notes-note-0004>notes-note-0001:relates:false']);
  assert.deepEqual(s.groups.map((g) => [g.id, g.kind, g.wraps, g.color_token]), [['g-idea', 'discipline', ['notes-note-0001'], seriesToken('g-idea')], ['g-dataset', 'discipline', ['notes-note-0002'], seriesToken('g-dataset')], ['g-reading', 'discipline', ['notes-note-0003'], seriesToken('g-reading')], ['g-plan', 'discipline', ['notes-note-0004'], seriesToken('g-plan')]]);
  const n = s.nodes[0];
  assert.equal(n.kind, 'note');
  assert.equal(n.label, 'Calibrate before the long run');
  assert.equal(n.sublabel, 'The drift grows with cumulative vibration, not with the calendar.');
  assert.deepEqual([n.room, n.record_id, n.group, n.weight, n.tags, n.status, n.color_token], ['notes', 'note-0001', 'g-idea', 0.7, ['idea', 'calibration'], 'accepted', seriesToken('g-idea')]);
  assert.deepEqual(n.fields, { title: 'Calibrate before the long run', tags: ['idea', 'calibration'] }, 'the owner view still carries only public_fields in fields');
  const record = readJson(join(dir, 'center', 'rooms', 'notes', 'examples.json'))[0];
  assert.deepEqual(n.provenance, { owner_person_id: 'self', source: { kind: 'record', ref: 'notes/note-0001', digest: sha256(canonical(record)) }, captured_on: '2026-09-19', happened_on: '2026-09-18', remembered_on: '2026-09-19' }, 'captured = remembered (logged_on), happened = happened_on');
  assert.deepEqual(n.audience, { privacy_level: 'private', share_rule_ids: [] }, 'default is none');
  assert.deepEqual(s.evidence.map((e) => [e.id, e.kind, e.ref, e.label]), [['ev-1', 'record', 'notes/note-0001', 'SRC 1'], ['ev-2', 'record', 'notes/note-0002', 'SRC 2'], ['ev-3', 'record', 'notes/note-0003', 'SRC 3'], ['ev-4', 'record', 'notes/note-0004', 'SRC 4']]);
  assert.deepEqual(s.nodes.map((x) => x.evidence_ids), [['ev-1'], ['ev-2'], ['ev-3'], ['ev-4']]);
  assert.deepEqual(s.views['2d'], { layout: 'force', seed: 7 });
  assert.deepEqual(s.views['3d'], { layout: 'lift', scale_m: 6, lift: { mode: 'group-weight', amplitude_m: 1.5 } });
  assert.deepEqual(s.views.vr, { enabled: true, scale_m: 4 });
  assert.deepEqual(s.views.interactive, { focus: null, reach: 'both', lenses: [{ id: 'ideas', label: 'Ideas', match: { tags: ['idea'] } }], default_lens: null, deep_link: true });
  assert.deepEqual({ ...s.projected, mac: 'x' }, { by: 'lib/project.mjs', engine_version: '0.1.0', viewer: 'self', at: '2026-10-01T10:15:00Z', dropped: 0, limit: { focus: null, reach: null, lens: null, max_nodes: 600 }, mac: 'x' });
  assert.ok(privacy.verifyStamp(s, KEY) && !privacy.verifyStamp(s, 'another key'));
  assert.equal(s.receipt, undefined, 'render adds the receipt summary, not the projector');
}));

test('timeline view: kind timeline, timeline layout, happened_on from the date expression, no overlays; the default view of a room with no views.json entry is a record graph', () => withTmp(async (dir) => {
  const { c, base, ctx } = await boot(dir);
  writeJsonAtomic(overlayPath(c.dataDir, 'ada'), { ...emptyOverlay('ada'), nodes: [stub('person-ada-s1', '2027-01-01')], grants: { 'ada/rule-01': { re_share: false } } });
  const t = await project({ ...base, view: 'notes/timeline' });
  assert.equal(t.kind, 'timeline');
  assert.deepEqual(t.views['2d'], { layout: 'timeline' });
  assert.deepEqual(t.views['3d'], { layout: 'tier-wall', scale_m: 5 });
  assert.deepEqual(t.views.vr, { enabled: false });
  assert.deepEqual(t.nodes.map((n) => [n.kind, n.provenance.happened_on]), [['event', '2026-09-18'], ['event', '2026-09-12'], ['event', '2026-08-30'], ['event', '2026-09-21']]);
  assert.deepEqual(t.groups, [], 'no group_by on the timeline view');
  assert.ok(!t.nodes.some((n) => n.kind === 'boundary'), 'overlays merge into graph and meet views only');
  assert.deepEqual(fails(gates(t, ctx)), []);
  const g = await project({ ...base, view: 'notes/graph' });
  assert.ok(g.nodes.some((n) => n.id === 'person-ada-s1'), 'the same overlay does merge into the graph view');
  await assert.rejects(project({ ...base, view: 'notes/nope' }), TypeError);
  await assert.rejects(project({ ...base, view: 'ghost/graph' }), TypeError);
}));

test('viewers: the public viewer and an ungranted person get nothing; a granted person gets the selected record with fields_allowed only, a stub label when the label field is not allowed, no tags when the tag field is not allowed; the owner view lists the granting rule', () => withTmp(async (dir) => {
  const { base, ctx } = await boot(dir);
  const pub = await project({ ...base, view: 'notes/graph', viewer: 'public' });
  assert.deepEqual([pub.nodes, pub.viewer, pub.projected.viewer], [[], { person_id: 'public', mode: 'public', rule_refs: [] }, 'public']);
  assert.deepEqual((await project({ ...base, view: 'notes/graph', viewer: 'ada' })).nodes, [], 'no rule -> absent');
  assert.deepEqual((await project({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule({ state: 'awaiting_owner' })] })).nodes, [], 'a rule in awaiting_owner grants nothing');
  const r = await projectDetailed({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule()] });
  const s = r.scene;
  assert.deepEqual(ids(s), ['notes-note-0001']);
  const n = s.nodes[0];
  assert.deepEqual([n.label, n.sublabel, n.tags, n.fields, n.audience, n.record_id], ['Calibrate before the long run', undefined, ['idea', 'calibration'], { title: 'Calibrate before the long run', tags: ['idea', 'calibration'] }, { privacy_level: 'private', share_rule_ids: ['rule-01'] }, 'note-0001']);
  assert.notEqual(n.provenance.source.digest, sha256(canonical(readJson(join(dir, 'center', 'rooms', 'notes', 'examples.json'))[0])), 'digests of private records never leave');
  assert.deepEqual(s.viewer, { person_id: 'ada', mode: 'person', rule_refs: ['self/rule-01'] });
  assert.deepEqual(fails(gates(s, { ...ctx, viewer: 'ada' })), [], 'clean for ada with the rooms ceiling');
  assert.deepEqual(codes(privacy.check(s, { ...ctx, viewer: 'bob' })), ['DF_PRIVACY_VIEWER_EXCLUDED'], 'the same scene rendered for bob is refused by the gate');
  assert.deepEqual(s.evidence.length, 1);
  const tagsOnly = (await project({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule({ redaction: { ...rule().redaction, fields_allowed: ['tags'] } })] })).nodes[0];
  assert.match(tagsOnly.label, STUB_RE);
  assert.ok(tagsOnly.label.startsWith('notes · '));
  assert.deepEqual([tagsOnly.tags, Object.keys(tagsOnly.fields)], [['idea', 'calibration'], ['tags']]);
  const titleOnly = (await project({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule({ redaction: { ...rule().redaction, fields_allowed: ['title'] } })] })).nodes[0];
  assert.deepEqual([titleOnly.label, titleOnly.tags, Object.keys(titleOnly.fields)], ['Calibrate before the long run', [], ['title']]);
  const self = await project({ ...base, view: 'notes/graph', rules: [rule()] });
  assert.deepEqual(self.nodes.map((x) => x.audience.share_rule_ids), [['rule-01'], [], [], []], 'the owner sees which nodes an active rule selects');
  assert.deepEqual((await project({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule({ dates: { granted_on: '2026-01-01', released_on: '2026-01-01', expires_on: '2026-09-30' } })] })).nodes, [], 'expired by date -> nothing');
}));

test('readRecords: self reads every field; a granted person reads fields_allowed; a public room reads public_fields to anyone; a blocked room reads to nobody; a sensitive room needs operators and then pseudonymises', () => withTmp(async (dir) => {
  const { c, room, base } = await boot(dir);
  const opts = { room, dataDir: c.dataDir, config: c.config, env: ENV, root: c.root, now: NOW };
  const self = await readRecords({ ...opts });
  assert.equal(self.records.length, 4);
  assert.deepEqual(Object.keys(self.records[0]), ['note_id', 'title', 'body', 'tags', 'links', 'happened_on', 'logged_on', 'score']);
  assert.deepEqual(self.visible[0].id, 'note-0001');
  const ada = await readRecords({ ...opts, viewer: 'ada', rules: [rule()] });
  assert.deepEqual(ada.records, [{ title: 'Calibrate before the long run', tags: ['idea', 'calibration'] }]);
  assert.deepEqual([ada.visible[0].id, ada.visible[0].rule_refs, ada.visible[0].fields], ['note-0001', ['self/rule-01'], ['title', 'tags']]);
  assert.deepEqual((await readRecords({ ...opts, viewer: 'public' })).records, []);
  const { d: dPub } = await boot(join(dir, 'pub'), { patch: (m) => { m.record.default_privacy_level = 'public'; } });
  const pubRead = await readRecords({ ...opts, room: dPub.rooms[0], dataDir: join(dir, 'pub', 'data'), root: join(dir, 'pub'), viewer: 'public' });
  assert.equal(pubRead.records.length, 4);
  assert.deepEqual(Object.keys(pubRead.records[0]), ['title', 'tags'], 'public_fields only');
  const pubScene = await project({ ...base, rooms: dPub, dataDir: join(dir, 'pub', 'data'), root: join(dir, 'pub'), view: 'notes/graph', viewer: 'public' });
  assert.equal(pubScene.nodes.length, 4);
  assert.deepEqual(fails(gates(pubScene, { sessionKey: KEY, requireProjected: true, rooms: dPub, viewer: 'public' })), []);
  const { d: dBlocked } = await boot(join(dir, 'blk'), { patch: (m) => { m.record.default_privacy_level = 'blocked'; } });
  assert.deepEqual((await readRecords({ ...opts, room: dBlocked.rooms[0], dataDir: join(dir, 'blk', 'data'), root: join(dir, 'blk'), viewer: 'ada', rules: [rule({ redaction: { ...rule().redaction, privacy_level_ceiling: 'sensitive', operators: ['replace'] } })] })).records, [], 'blocked never leaves');
  const { d: dSens } = await boot(join(dir, 'sens'), { patch: (m) => { m.record.default_privacy_level = 'sensitive'; } });
  const sensOpts = { ...opts, room: dSens.rooms[0], dataDir: join(dir, 'sens', 'data'), root: join(dir, 'sens'), viewer: 'ada' };
  assert.deepEqual((await readRecords({ ...sensOpts, rules: [rule({ redaction: { ...rule().redaction, privacy_level_ceiling: 'sensitive' } })] })).records, [], 'sensitive without operators is refused');
  assert.deepEqual((await readRecords({ ...sensOpts, rules: [rule({ redaction: { ...rule().redaction, operators: ['pseudonymize'] } })] })).records, [], 'a private ceiling does not cover sensitive');
  const pseu = await readRecords({ ...sensOpts, rules: [rule({ redaction: { ...rule().redaction, privacy_level_ceiling: 'sensitive', operators: ['pseudonymize'] } })] });
  assert.match(pseu.records[0].title, /^pseu-[0-9a-f]{16}$/);
  assert.ok(pseu.records[0].tags.every((t) => /^pseu-[0-9a-f]{16}$/.test(t)));
}));

test('limit: over max_nodes the projector cuts a focus/reach subgraph and reports dropped; an explicit lens filters; focus and reach are honoured; the result stays gate-clean', () => withTmp(async (dir) => {
  const { base, ctx } = await boot(dir);
  const cut = await project({ ...base, view: 'notes/graph', limit: { max_nodes: 2 } });
  assert.deepEqual(ids(cut), ['notes-note-0001', 'notes-note-0003'], 'the heaviest node and its heaviest neighbour');
  assert.deepEqual(cut.projected.dropped, 2);
  assert.deepEqual(cut.projected.limit, { focus: 'notes-note-0001', reach: 'both', lens: null, max_nodes: 2 });
  assert.deepEqual(cut.edges.map((e) => e.id), ['e-2']);
  assert.deepEqual(cut.groups.map((g) => g.wraps), [['notes-note-0001'], [], ['notes-note-0003'], []]);
  assert.deepEqual(cut.evidence.map((e) => e.id), ['ev-1', 'ev-3']);
  assert.deepEqual(fails(gates(cut, ctx)), []);
  const lens = await project({ ...base, view: 'notes/graph', limit: { lens: 'ideas' } });
  assert.deepEqual([ids(lens), lens.projected.dropped, lens.projected.limit.lens], [['notes-note-0001'], 3, 'ideas']);
  const out = await project({ ...base, view: 'notes/graph', limit: { focus: 'notes-note-0003', reach: 'out' } });
  assert.deepEqual([ids(out).sort(), out.projected.limit], [['notes-note-0001', 'notes-note-0002', 'notes-note-0003', 'notes-note-0004'], { focus: 'notes-note-0003', reach: 'out', lens: null, max_nodes: 600 }], 'undirected relates edges are walked both ways, so out reaches the whole component');
  const none = await project({ ...base, view: 'notes/graph', limit: { focus: 'notes-note-0002', reach: 'none' } });
  assert.deepEqual([ids(none), none.projected.dropped], [['notes-note-0002'], 3]);
  assert.equal((await project({ ...base, view: 'notes/graph', limit: { focus: 'ghost' } })).nodes.length, 4, 'an unknown focus is ignored');
  assert.equal(DEFAULT_MAX_NODES, 2000);
  const big = { nodes: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, weight: i / 10, tags: [] })), edges: [{ from: 'n4', to: 'n0', directed: true }, { from: 'n1', to: 'n4', directed: true }], views: { interactive: { lenses: [], default_lens: null } } };
  assert.deepEqual(applyLimit(big, { max_nodes: 2 }).scene.nodes.map((n) => n.id), ['n1', 'n4'], 'the heaviest node and its heaviest neighbour, in scene order');
  assert.deepEqual(applyLimit(big, { max_nodes: 3 }).scene.nodes.map((n) => n.id), ['n0', 'n1', 'n4']);
  assert.deepEqual(applyLimit(big, { max_nodes: 4 }).scene.nodes.map((n) => n.id), ['n0', 'n1', 'n3', 'n4'], 'a disconnected remainder is filled by weight');
  assert.deepEqual(applyLimit(big, { focus: 'n4', reach: 'out' }).scene.nodes.map((n) => n.id), ['n0', 'n4'], 'out follows the arrow');
  assert.deepEqual(applyLimit(big, { focus: 'n4', reach: 'in' }).scene.nodes.map((n) => n.id), ['n1', 'n4'], 'in walks against it');
  assert.deepEqual(applyLimit(big, { focus: 'n4', reach: 'both' }).scene.nodes.map((n) => n.id), ['n0', 'n1', 'n4']);
}));

test('overlays: live stubs merge as foreign boundary nodes with projection evidence and their groups; expired stubs are dropped with DF_OVERLAY_EXPIRED; a third party never sees them; includeOverlays false skips them', () => withTmp(async (dir) => {
  const { c, base, ctx } = await boot(dir);
  const overlay = { ...emptyOverlay('ada'), grants: { 'ada/rule-01': { re_share: false, key_id: 'ada-k1' } },
    groups: [{ id: 'person-ada-g-vibration', label: 'vibration', kind: 'discipline' }],
    nodes: [stub('person-ada-s1', '2027-09-20', { group: 'person-ada-g-vibration' }), stub('person-ada-s2', '2026-09-30')],
    edges: [{ id: 'person-ada-e1', from: 'person-ada-s1', to: 'person-ada-s2', kind: 'relates', directed: false }] };
  writeJsonAtomic(overlayPath(c.dataDir, 'ada'), overlay);
  const r = await projectDetailed({ ...base, view: 'notes/graph' });
  const s = r.scene;
  assert.deepEqual(ids(s).slice(4), ['person-ada-s1'], 'the expired stub is not merged');
  assert.deepEqual(codes(r.checks), ['DF_OVERLAY_EXPIRED']);
  assert.equal(fails(r.checks)[0].blocking, false);
  const n = s.nodes[4];
  assert.deepEqual([n.kind, n.color_token, n.status, n.weight, n.group, n.evidence_ids], ['boundary', 'foreign', 'accepted', 0.3, 'person-ada-g-vibration', ['ev-5']]);
  assert.deepEqual(s.evidence[4], { id: 'ev-5', kind: 'projection', ref: 'data/overlays/ada.json#person-ada-s1', digest: `sha256:${'e7'.repeat(32)}`, label: 'SRC 5' });
  assert.deepEqual(s.groups.at(-1), { id: 'person-ada-g-vibration', label: 'vibration', kind: 'discipline', wraps: ['person-ada-s1'], color_token: 'foreign' });
  assert.deepEqual(s.edges.filter((e) => e.id.startsWith('person-')), [], 'an edge to the expired stub is gone');
  assert.deepEqual(fails(gates(s, ctx)), []);
  const bob = await project({ ...base, view: 'notes/graph', viewer: 'bob' });
  assert.deepEqual(bob.nodes, [], 'other people\'s overlays never leave');
  const ada = await project({ ...base, view: 'notes/graph', viewer: 'ada' });
  assert.deepEqual(ids(ada), ['person-ada-s1'], 'the grantor sees her own stub back');
  assert.deepEqual(ids(await project({ ...base, view: 'notes/graph', includeOverlays: false })).length, 4);
  assert.deepEqual(ids(await project({ ...base, view: 'notes/graph', overlays: [] })).length, 4, 'an explicit overlay list wins over data/overlays/');
}));

test('taint: an authored scene gets derived_from for every local node that reaches a stub, one hop and transitively; an authored scene projected for a person keeps only what they may see', () => withTmp(async (dir) => {
  const { base } = await boot(dir, { seed: false });
  const s = shared();
  delete s.nodes.find((n) => n.id === 'idea-1').provenance.derived_from;
  s.nodes.push({ id: 'idea-2', kind: 'idea', label: 'Second-order idea', weight: 0.4, tags: [], color_token: 'accent', status: 'proposal',
    provenance: { owner_person_id: 'self', source: { kind: 'run', ref: 'run-20261001-02', digest: `sha256:${'f2'.repeat(32)}` }, captured_on: '2026-10-01' }, audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [] });
  s.edges.push({ id: 'e-idea-2', from: 'idea-2', to: 'idea-1', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' });
  s.positions['idea-2'] = [600, 700];
  const out = await project({ ...base, authored: s, includeOverlays: false });
  const origin = [{ person_id: 'ada', rule_ref: 'ada/rule-01', key_id: 'ada-k1' }];
  assert.deepEqual(out.nodes.find((n) => n.id === 'idea-1').provenance.derived_from, origin, 'one hop: a run-sourced node adjacent to the stub');
  assert.deepEqual(out.nodes.find((n) => n.id === 'idea-2').provenance.derived_from, origin, 'transitive: a run-sourced node adjacent to a tainted node');
  assert.equal(out.nodes.find((n) => n.id === 'n-1').provenance.derived_from, undefined);
  assert.deepEqual(fails(gates(out, { sessionKey: KEY, requireProjected: true, config: base.config })), []);
  assert.deepEqual(out.positions, { ...s.positions }, 'authored positions survive');
  assert.deepEqual(await project({ ...base, authored: s, includeOverlays: false }), out);
  const ada = await project({ ...base, authored: s, viewer: 'ada', includeOverlays: false });
  assert.deepEqual(ids(ada), ['n-2', 'person-ada-stub'], 'public nodes and her own stub only');
  assert.deepEqual(ada.viewer, { person_id: 'ada', mode: 'person', rule_refs: [] });
  assert.deepEqual(ada.edges, []);
  assert.deepEqual(Object.keys(ada.positions), ['n-2', 'person-ada-stub']);
  assert.deepEqual(fails(gates(ada, { sessionKey: KEY, requireProjected: true, config: base.config, viewer: 'ada' })), []);
}));

test('project never writes, refuses to run without a clock or a session key, and its id helpers are deterministic', () => withTmp(async (dir) => {
  const { c, base } = await boot(dir);
  await project({ ...base, view: 'notes/graph' });
  await project({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule()] });
  assert.deepEqual(readdirSync(c.dataDir), ['rooms'], 'only the seeded store exists');
  assert.deepEqual(readdirSync(c.dotDir), []);
  await assert.rejects(project({ ...base, view: 'notes/graph', sessionKey: undefined }), TypeError);
  await assert.rejects(project({ ...base, view: 'notes/graph', sessionKey: '' }), TypeError);
  await assert.rejects(project({ ...base, view: 'notes/graph', now: undefined }), TypeError);
  assert.equal(nodeIdFor('notes', 'Note 0001'), 'notes-note0001');
  assert.equal(nodeIdFor('notes', '../x'), 'notes-x');
  assert.equal(nodeIdFor('notes', '', 'r7'), 'notes-r7');
  assert.match(seriesToken('g-anything'), /^series-[1-6]$/);
  assert.equal(seriesToken('g-a'), seriesToken('g-a'));
  assert.deepEqual([viewerSpec('self'), viewerSpec('public'), viewerSpec('ada'), viewerSpec({ person_id: 'owner-x' }, { center: { owner_person_id: 'owner-x' } })], [{ person_id: 'self', mode: 'self' }, { person_id: 'public', mode: 'public' }, { person_id: 'ada', mode: 'person' }, { person_id: 'self', mode: 'self' }]);
  const second = cloneRoom(c, 'notes', 'journal');
  assert.ok(second.endsWith('journal'));
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const r = await projectDetailed({ ...base, rooms: d, view: 'journal/graph' });
  assert.deepEqual(r.scene.nodes, [], 'an empty store projects an empty, still-stamped scene');
  assert.ok(privacy.verifyStamp(r.scene, KEY));
}));
