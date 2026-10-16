// The scene IR: schemas/scene.schema.json (exactly five open maps), the
// three gates (schema, topology, privacy) over the shipped examples and over
// one failing and one passing fixture per DF_IR_* / DF_PRIVACY_* code plus
// DF_RENDER_UNPROJECTED, the HMAC stamp (a pasted block fails), viewer
// visibility, the v2 codes (sequence, lifecycle, routed modes, view
// references, the time window) and the never-throws promise. node:test, no
// network, no temp files: every input is a committed fixture or built in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSchema, loadSchema, openPaths, validate } from '../lib/validate.mjs';
import { RULES, codesForFamily } from '../lib/rules.mjs';
import { canonical } from '../lib/digest.mjs';
import * as schemaGate from '../lib/gates/schema.mjs';
import * as topology from '../lib/gates/topology.mjs';
import * as topologyViews from '../lib/gates/topology-views.mjs';
import * as privacy from '../lib/gates/privacy.mjs';
import { EXAMPLE_SESSION_KEY, examples, graphScene } from './fixtures/ir/examples.mjs';
import { FIXTURE_CODES, FIXTURE_SESSION_KEY, base, checkGenerated, expandFixture, fixtureDocs, fixtureName, lifecycle, sequence, shared } from './fixtures/ir/build-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures', 'ir');
const EXAMPLES = join(ROOT, 'examples');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const CHECK_KEYS = ['code', 'gate', 'blocking', 'status', 'path', 'message', 'repair'];
const GATES = [schemaGate, topology, privacy];
const DEFAULT_CTX = Object.freeze({ sessionKey: FIXTURE_SESSION_KEY, quality: 'checked', config: { center: { owner_person_id: 'self' } } });

const fails = (checks) => checks.filter((c) => c.status === 'fail');
const codesOf = (checks) => [...new Set(fails(checks).map((c) => c.code))].sort();
const run = (scene, ctx = DEFAULT_CTX) => GATES.flatMap((g) => g.check(scene, ctx));

function assertCheckShape(c) {
  assert.ok(RULES[c.code], `${c.code} is a catalog code`);
  assert.equal(c.gate, RULES[c.code].gate);
  assert.equal(typeof c.blocking, 'boolean');
  assert.ok(c.status === 'pass' || c.status === 'fail');
  assert.ok(Object.keys(c).every((k) => CHECK_KEYS.includes(k)), `check keys: ${Object.keys(c)}`);
  if (c.status === 'pass') assert.deepEqual(Object.keys(c), ['code', 'gate', 'blocking', 'status']);
  else {
    assert.match(c.path, /^\$/);
    assert.ok(c.message.startsWith(RULES[c.code].message.replace(/\.$/, '')), `${c.code} message starts with the catalog message: ${c.message}`);
    assert.equal(c.repair, RULES[c.code].repair);
  }
}

test('scene.schema.json: dotfield id, supported subset only, exactly five open maps', () => {
  const schema = loadSchema('scene');
  assert.equal(schema.$id, 'dotfield.scene/1');
  assert.deepEqual(inspectSchema(schema), []);
  assert.deepEqual(openPaths(schema), ['$.ext', '$.labels', '$.nodes[*].fields', '$.positions', '$.routes'], 'the three geometry tables, node.fields and ext; views.2d.plan is closed (arrays, no new open path); the views.json value map lives in the room schema');
  assert.equal(validate(schema, { ...graphScene(), routes: { 'Bad Key': [[1, 2], [3, 4]] } }).errors[0].code, 'DF_SCHEMA_UNKNOWN_FIELD', 'routes keys must be edge ids');
  assert.equal(validate(schema, { ...graphScene(), routes: { e1: [[1, 2]] } }).errors[0].code, 'DF_SCHEMA_MIN_ITEMS', 'a route is a polyline of at least two points');
  assert.equal(validate(schema, { ...graphScene(), labels: { 'exp-0412': 'sideways' } }).errors[0].code, 'DF_SCHEMA_ENUM', 'a label side is one of five');
  const plan = graphScene(); plan.views['2d'].plan = { mode: 'force', crossings: 2, extra: 1 };
  assert.equal(validate(schema, plan).errors[0].code, 'DF_SCHEMA_UNKNOWN_FIELD', 'plan is closed');
  assert.equal(validate(schema, { ...graphScene(), surprise: 1 }).errors[0].code, 'DF_SCHEMA_UNKNOWN_FIELD');
  assert.equal(validate(schema, { ...graphScene(), positions: { 'Bad Key': [1, 2] } }).errors[0].code, 'DF_SCHEMA_UNKNOWN_FIELD', 'positions keys must be node ids');
  const hex = graphScene(); hex.nodes[0].color_token = 'series-7';
  assert.equal(validate(schema, hex).errors[0].code, 'DF_SCHEMA_PATTERN', 'color tokens are a closed vocabulary');
});

test('topology vocabularies agree with the schema', () => {
  const schema = loadSchema('scene');
  assert.deepEqual(schema.properties.kind.enum, [...topology.SCENE_KINDS]);
  assert.deepEqual(schema.$defs.edge.properties.kind.enum, [...topology.EDGE_KINDS]);
  assert.deepEqual(schema.$defs.group.properties.kind.enum, [...topology.GROUP_KINDS]);
  assert.deepEqual(topology.SCENE_KINDS.slice(-2), ['sequence', 'lifecycle']);
  assert.deepEqual([...topology.EDGE_KINDS].slice(-2), ['message', 'transition']);
  assert.deepEqual([...topology.ORDERED_EDGE_KINDS], ['message', 'transition']);
  assert.deepEqual([...topology.SELF_LOOP_SCENE_KINDS], ['sequence', 'lifecycle']);
  assert.deepEqual([...topology.ROUTED_MODES], ['layered', 'sequence', 'lifecycle']);
  for (const m of topology.ROUTED_MODES) assert.ok(schema.$defs.views.properties['2d'].properties.layout.enum.includes(m), `${m} is a 2D mode`);
  assert.deepEqual(schema.$defs.views.properties['2d'].properties.plan.properties.mode.enum, schema.$defs.views.properties['2d'].properties.layout.enum, 'plan.mode names the same modes as layout');
  assert.deepEqual(schema.$defs.time.properties.step.enum, [...topologyViews.DATE_STEPS, ...topologyViews.ORDER_STEPS]);
  assert.ok(schema.$defs.time.properties.field.enum.includes(topologyViews.DEFAULT_TIME_FIELD));
  assert.deepEqual(schema.$defs.views.properties.vr.properties.snap_turn_deg.enum, [0, 30, 45, 90]);
  const kindRe = new RegExp(schema.$defs.node.properties.kind.pattern, 'u');
  for (const k of topology.NODE_KINDS) assert.ok(kindRe.test(k), k);
  assert.ok(kindRe.test('x-sensor') && !kindRe.test('X-sensor') && !kindRe.test('sensor'));
  assert.ok(topology.X_KIND_RE.test('x-sensor') && !topology.X_KIND_RE.test('x-'));
  assert.deepEqual(topology.LIMITS, { max_nodes: 2000, fields_budget_bytes: 1048576, field_bytes: 4096, field_string_bytes: 1024 });
  assert.ok(topology.kindKnown('record') && !topology.kindKnown('x-nope') && topology.kindKnown('x-nope', { shapes: { 'x-nope': {} } }));
  assert.ok(topology.kindKnown('x-row', { shapes: [{ kind: 'x-row' }] }) && topology.kindKnown('x-row', { shapes: { kinds: { 'x-row': {} } } }));
});

test('gates: id and check(), one check per code, catalog shape, deterministic, never throw', () => {
  assert.deepEqual(GATES.map((g) => g.id), ['schema', 'topology', 'privacy']);
  const scene = shared();
  for (const g of GATES) {
    const out = g.check(scene, DEFAULT_CTX);
    for (const c of out) assertCheckShape(c);
    assert.deepEqual(out, g.check(scene, DEFAULT_CTX), 'same input, same checks');
  }
  assert.deepEqual(schemaGate.check(scene).map((c) => c.code), codesForFamily('schema'));
  assert.deepEqual(topology.check(scene).map((c) => c.code), codesForFamily('ir'));
  assert.deepEqual(privacy.check(scene).map((c) => c.code), codesForFamily('privacy'), 'DF_RENDER_UNPROJECTED only with requireProjected');
  assert.deepEqual(privacy.check(scene, { requireProjected: true }).map((c) => c.code), [...codesForFamily('privacy'), 'DF_RENDER_UNPROJECTED']);
  for (const bad of [undefined, null, 42, 'scene', [], {}, { nodes: 'x', edges: 7, groups: {}, views: null, evidence: 1 }, { nodes: [null, 1, {}], edges: [{}], groups: [{ wraps: 'x' }] }]) {
    for (const g of GATES) for (const ctx of [undefined, null, 'ctx', { viewer: 5, rooms: 1, shapes: 'x', requireProjected: true, sessionKey: 7 }]) {
      const out = g.check(bad, ctx);
      assert.ok(Array.isArray(out) && out.length > 0, `${g.id} returns checks for ${JSON.stringify(bad)}`);
      for (const c of out) assertCheckShape(c);
    }
  }
  assert.ok(fails(schemaGate.check(null)).length > 0, 'the schema gate is the one that reports a non-scene');
  assert.deepEqual(fails(topology.check(null)), [], 'an empty topology has nothing to fail');
});

test('examples/: current with the generator, schema-valid, clean through all three gates, stamped', () => {
  const built = examples();
  assert.deepEqual(Object.keys(built), ['scene-graph', 'scene-room', 'scene-timeline', 'scene-workflow', 'scene-sequence', 'scene-lifecycle', 'scene-architecture']);
  for (const [name, scene] of Object.entries(built)) {
    const file = join(EXAMPLES, `${name}.json`);
    assert.ok(existsSync(file), `${file} exists`);
    const onDisk = readJson(file);
    assert.deepEqual(onDisk, scene, `${name}.json equals the generator output`);
    for (const ctx of [DEFAULT_CTX, { ...DEFAULT_CTX, sessionKey: EXAMPLE_SESSION_KEY, requireProjected: true }, { ...DEFAULT_CTX, viewer: 'self' }]) {
      const out = run(onDisk, ctx);
      assert.deepEqual(fails(out), [], `${name} is clean under ${JSON.stringify(ctx)}`);
    }
    assert.ok(onDisk.laid_out === true && Object.keys(onDisk.positions).sort().join() === onDisk.nodes.map((n) => n.id).sort().join(), `${name}: every node has a position`);
    assert.ok(privacy.verifyStamp(onDisk, EXAMPLE_SESSION_KEY), `${name}: the committed stamp verifies`);
    assert.ok(!privacy.verifyStamp(onDisk, 'another key'));
  }
  assert.deepEqual(['graph', 'room', 'timeline', 'workflow', 'sequence', 'lifecycle', 'workflow'], Object.values(built).map((s) => s.kind));
  assert.ok(built['scene-workflow'].ext.archify.diagram_type === 'dataflow');
});

test('scene-graph.json is the VISION §4 example (digests expanded, stamp real)', () => {
  const s = readJson(join(EXAMPLES, 'scene-graph.json'));
  assert.deepEqual(s.nodes.map((n) => n.id), ['exp-0412', 'paper-orb3', 'robot-hb1', 'person-ada', 'person-ada-calib-cadence', 'idea-vib-cadence']);
  assert.deepEqual(s.edges.map((e) => `${e.id}:${e.from}>${e.to}:${e.kind}`), ['e1:exp-0412>paper-orb3:cites', 'e2:exp-0412>robot-hb1:depends', 'e3:person-ada>person-ada-calib-cadence:share', 'e4:idea-vib-cadence>person-ada-calib-cadence:relates', 'e5:idea-vib-cadence>exp-0412:relates']);
  assert.deepEqual(s.positions, { 'exp-0412': [612, 418], 'paper-orb3': [748, 505], 'robot-hb1': [430, 560], 'person-ada': [1110, 420], 'person-ada-calib-cadence': [1180, 540], 'idea-vib-cadence': [880, 300] });
  assert.deepEqual(s.groups.map((g) => g.id), ['g-slam', 'g-people']);
  assert.equal(s.meta.id, 'experiments-graph');
  assert.deepEqual(s.views['2d'], { layout: 'cluster-disc', seed: 7, viewBox: [0, 0, 1600, 1000], plan: { mode: 'cluster-disc' } });
  assert.deepEqual(s.views.vr, { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6, entry_node: 'exp-0412', label_budget: 64 });
  assert.equal(s.nodes[0].provenance.source.digest, `sha256:${'9b1c'.repeat(16)}`);
  assert.deepEqual(s.nodes[5].provenance.derived_from, [{ person_id: 'ada', rule_ref: 'ada/rule-01', key_id: 'ada-k1' }]);
  assert.equal(s.receipt.receipt_id, 'rcpt_20261001T101500Z_7f3a');
  assert.equal(s.projected.at, '2026-10-01T10:14:58Z');
  assert.match(s.projected.mac, /^hmac-sha256:[0-9a-f]{64}$/);
});

test('every DF_IR_*, DF_PRIVACY_* code and DF_RENDER_UNPROJECTED has a failing and a passing fixture', (t) => {
  assert.deepEqual([...FIXTURE_CODES], [...codesForFamily('ir'), ...codesForFamily('privacy'), 'DF_RENDER_UNPROJECTED']);
  assert.ok(FIXTURE_CODES.length >= 25);
  let files = 0;
  for (const code of FIXTURE_CODES) {
    for (const expect of ['fail', 'pass']) {
      const file = join(FIX, `${code}.${expect}.json`);
      assert.ok(existsSync(file), `${code}.${expect}.json exists`);
      files += 1;
      const doc = expandFixture(readJson(file));
      assert.equal(doc.code, code);
      assert.equal(doc.expect, expect);
      assert.ok(typeof doc.why === 'string' && doc.why.length > 8);
      assert.deepEqual(fails(schemaGate.check(doc.scene)), [], `${code}.${expect}: the fixture is schema-valid so it isolates one rule`);
      const ctx = { ...DEFAULT_CTX, ...(doc.ctx ?? {}) };
      const out = [...topology.check(doc.scene, ctx), ...privacy.check(doc.scene, ctx)];
      for (const c of out) assertCheckShape(c);
      if (expect === 'fail') {
        assert.deepEqual(codesOf(out), [code], `${code}.fail raises exactly ${code}; got ${codesOf(out)}: ${fails(out).map((c) => `${c.path} ${c.message}`).join(' | ')}`);
        assert.ok(fails(out).every((c) => c.code === code && c.path && c.repair));
      } else {
        assert.deepEqual(fails(out), [], `${code}.pass is clean: ${fails(out).map((c) => `${c.code} ${c.path} ${c.message}`).join(' | ')}`);
        assert.ok(out.some((c) => c.code === code && c.status === 'pass'), `${code}.pass reports ${code} as evaluated`);
      }
    }
  }
  t.diagnostic(`${files} fixtures over ${FIXTURE_CODES.length} codes`);
  const large = expandFixture(readJson(join(FIX, 'DF_IR_TOO_LARGE.fail.json')));
  assert.equal(large.scene.nodes.length, 2001);
  assert.equal(expandFixture(readJson(join(FIX, 'DF_IR_TOO_LARGE.pass.json'))).scene.nodes.length, 2000, 'the limit is more than 2000, not 2000');
});

test('fixtures and examples are byte-current with test/fixtures/ir/build-fixtures.mjs', () => {
  const { diffs, count } = checkGenerated(ROOT);
  assert.deepEqual(diffs, [], 'run: node test/fixtures/ir/build-fixtures.mjs');
  assert.equal(count, FIXTURE_CODES.length * 2 + Object.keys(examples()).length);
  assert.equal(Object.keys(examples()).length, 7);
  assert.deepEqual(fixtureDocs().map(fixtureName).sort(), FIXTURE_CODES.flatMap((c) => [`${c}.fail.json`, `${c}.pass.json`]).sort());
});

test('the projected stamp: canonical(scene minus projected and receipt); a pasted or hand-typed block fails', () => {
  const s = readJson(join(EXAMPLES, 'scene-graph.json'));
  const ctx = { ...DEFAULT_CTX, sessionKey: EXAMPLE_SESSION_KEY, requireProjected: true };
  const stripped = { ...s }; delete stripped.projected; delete stripped.receipt;
  assert.equal(privacy.stampInput(s), canonical(stripped));
  assert.equal(privacy.stampInput(s), privacy.stampInput(stripped), 'receipt and projected are the only excluded keys');
  assert.equal(privacy.stamp(s, EXAMPLE_SESSION_KEY), s.projected.mac);
  assert.deepEqual(codesOf(privacy.check(s, ctx)), []);
  const unprojected = (scene, c = ctx) => fails(privacy.check(scene, c)).filter((x) => x.code === 'DF_RENDER_UNPROJECTED');
  const edited = JSON.parse(JSON.stringify(s)); edited.nodes[0].label = 'ORB-SLAM3 on hall-loop (edited)';
  assert.equal(unprojected(edited).length, 1, 'any edit after stamping breaks the mac');
  assert.equal(unprojected(edited)[0].path, '$.projected.mac');
  const pasted = JSON.parse(JSON.stringify(s)); pasted.projected = readJson(join(EXAMPLES, 'scene-room.json')).projected;
  assert.equal(unprojected(pasted).length, 1, 'a stamp pasted from another scene fails');
  const typed = JSON.parse(JSON.stringify(s)); typed.projected.mac = `hmac-sha256:${'4c4c'.repeat(16)}`;
  assert.equal(unprojected(typed).length, 1, 'a hand-typed HMAC-shaped mac fails');
  assert.equal(unprojected(s, { ...ctx, sessionKey: 'wrong key' }).length, 1, 'the wrong key fails');
  assert.equal(unprojected(s, { ...ctx, sessionKey: undefined })[0].message.includes('no session key'), true);
  const missing = JSON.parse(JSON.stringify(s)); delete missing.projected;
  assert.equal(unprojected(missing)[0].path, '$.projected');
  assert.deepEqual(privacy.check(typed, { ...ctx, requireProjected: false }).filter((c) => c.code === 'DF_RENDER_UNPROJECTED'), [], 'not evaluated unless required');
  assert.ok(privacy.verifyStamp(s, Buffer.from(EXAMPLE_SESSION_KEY)), 'a byte key works too');
  assert.ok(!privacy.verifyStamp(s, '') && !privacy.verifyStamp(null, EXAMPLE_SESSION_KEY));
  const receiptEdit = JSON.parse(JSON.stringify(s)); receiptEdit.receipt.checks_passed = 99;
  assert.equal(unprojected(receiptEdit).length, 0, 'the receipt summary is outside the stamp');
});

test('viewer resolution and visibility: owner sees all, grants are per rule, blocked never leaves, public sees public', () => {
  const scene = shared();
  const n1 = scene.nodes.find((n) => n.id === 'n-1');
  const stub = scene.nodes.find((n) => n.id === 'person-ada-stub');
  const self = privacy.resolveViewer(scene, {});
  assert.deepEqual(self, { person_id: 'self', mode: 'self', rule_refs: [] });
  assert.deepEqual(privacy.resolveViewer(scene, { viewer: 'ada' }), { person_id: 'ada', mode: 'person', rule_refs: [] });
  assert.deepEqual(privacy.resolveViewer(scene, { viewer: { person_id: 'ada', mode: 'self' } }).mode, 'person', 'nobody but the owner is self');
  assert.deepEqual(privacy.resolveViewer(scene, { viewer: 'hall-owner', config: { center: { owner_person_id: 'hall-owner' } } }).mode, 'self');
  assert.deepEqual(privacy.resolveViewer({ ...scene, viewer: { person_id: 'ada', mode: 'person', rule_refs: ['self/rule-01'] } }, { viewer: 'ada' }).rule_refs, ['self/rule-01'], 'the scene rule_refs carry over for the same person');
  const ada = { person_id: 'ada', mode: 'person', rule_refs: ['self/rule-01'] };
  assert.equal(privacy.visibleTo(n1, self).ok, true);
  assert.equal(privacy.visibleTo(n1, ada).ok, false, 'private and not listed under rule-01');
  assert.equal(privacy.visibleTo({ ...n1, audience: { privacy_level: 'private', share_rule_ids: ['rule-01'] } }, ada).ok, true);
  assert.equal(privacy.visibleTo({ ...n1, audience: { privacy_level: 'private', share_rule_ids: ['rule-01'] } }, { ...ada, rule_refs: ['bob/rule-01'] }).ok, false, 'another grantor\'s rule-01 does not collide');
  assert.equal(privacy.visibleTo({ ...n1, audience: { privacy_level: 'blocked', share_rule_ids: ['rule-01'] } }, ada).ok, false, 'blocked never leaves');
  assert.equal(privacy.visibleTo({ ...n1, audience: { privacy_level: 'public', share_rule_ids: [] } }, { person_id: 'anyone', mode: 'public', rule_refs: [] }).ok, true);
  assert.equal(privacy.visibleTo(n1, { person_id: 'anyone', mode: 'public', rule_refs: [] }).ok, false);
  assert.equal(privacy.visibleTo(stub, { person_id: 'ada', mode: 'person', rule_refs: [] }).ok, true, 'ada sees the node she shared');
  const forAda = privacy.check(scene, { ...DEFAULT_CTX, viewer: 'ada' });
  assert.ok(fails(forAda).some((c) => c.code === 'DF_PRIVACY_VIEWER_EXCLUDED' && c.path === '$.viewer'), 'a scene projected for self is not rendered for ada');
  assert.deepEqual(privacy.publicFieldsIndex({ notes: { record: { public_fields: ['title'] } } }).get('notes'), new Set(['title']));
  assert.deepEqual(privacy.publicFieldsIndex(new Map([['notes', { public_fields: ['a', 'b'] }]])).get('notes'), new Set(['a', 'b']));
  assert.deepEqual(privacy.publicFieldsIndex({ rooms: [{ id: 'x', record: { public_fields: [] } }] }).get('x'), new Set());
  const unknownRoom = base(); unknownRoom.nodes[0].room = 'elsewhere';
  assert.deepEqual(codesOf(privacy.check(unknownRoom, { ...DEFAULT_CTX, rooms: [] })), [], 'a room the context does not know is skipped');
});

test('topology details: reversed undirected duplicates, repeated messages by beat, view references, group shape per scene kind, field sizes in bytes', () => {
  const rev = base();
  rev.edges.push({ id: 'e3', from: 'n-1', to: 'n-3', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' });
  assert.deepEqual(codesOf(topology.check(rev)), ['DF_IR_DUP_EDGE'], 'n-3 — n-1 already exists as e2');
  const seq = sequence(); seq.edges.push({ ...seq.edges[0], id: 'm4', order: 4 });
  assert.deepEqual(codesOf(topology.check(seq)), [], 'a sequence repeats a message on one pair at another beat (IR.md §4)');
  seq.edges.push({ ...seq.edges[0], id: 'm5' });
  assert.deepEqual(fails(topology.check(seq)).map((c) => `${c.code} ${c.path}`), ['DF_IR_DUP_EDGE $.edges[4]'], 'the same pair at the same beat is one message too many');
  const life = lifecycle(); life.edges.push({ ...life.edges[0], id: 't4', order: 4 });
  assert.deepEqual(codesOf(topology.check(life)), ['DF_IR_DUP_EDGE'], 'a lifecycle keeps one transition per pair');
  const views = base();
  views.views.interactive.focus = 'ghost';
  views.views.interactive.lenses[0].match.groups = ['g-ghost'];
  views.views.vr = { enabled: true, entry_node: 'ghost' };
  const out = fails(topology.check(views));
  assert.deepEqual(out.map((c) => `${c.code} ${c.path}`).sort(), ['DF_IR_DANGLING_VIEW_REF $.views.interactive.focus', 'DF_IR_DANGLING_VIEW_REF $.views.vr.entry_node', 'DF_IR_GROUP_UNDECLARED $.views.interactive.lenses[0].match.groups[0]'], 'view references are DF_IR_DANGLING_VIEW_REF, never DF_IR_DANGLING_EDGE (IR.md §10)');
  assert.ok(!out.some((c) => c.code === 'DF_IR_DANGLING_EDGE'), 'DF_IR_DANGLING_EDGE is edges-only');
  const room = base(); room.kind = 'room';
  assert.deepEqual(codesOf(topology.check(room)), ['DF_IR_GROUP_SHAPE'], 'a room scene group needs a metric box');
  const half = base(); half.groups[0] = { id: 'g-a', label: 'A', kind: 'zone', center_xyz_m: [0, 0, 0] };
  assert.ok(fails(topology.check({ ...half, kind: 'room' })).some((c) => c.code === 'DF_IR_GROUP_SHAPE' && /both center_xyz_m and size_xyz_m/.test(c.message)));
  const bytes = base();
  bytes.nodes[0].fields = { title: 'a'.repeat(1024) };
  assert.deepEqual(codesOf(topology.check(bytes)), [], '1024 bytes is the limit, not over it');
  bytes.nodes[0].fields = { title: 'a'.repeat(1025) };
  assert.deepEqual(codesOf(topology.check(bytes)), ['DF_IR_FIELD_TOO_LARGE']);
  const proposalImport = base(); proposalImport.nodes[2].status = 'proposal'; proposalImport.nodes[2].provenance.source = { kind: 'import', ref: 'import:csv/runs.csv', digest: `sha256:${'ab'.repeat(32)}` };
  assert.deepEqual(codesOf(topology.check(proposalImport)), [], 'import is a valid proposal source');
});

test('schema gate: one fail per validator error with its path, pass for every untouched code, overrides', () => {
  const broken = base();
  delete broken.nodes[0].label;
  broken.nodes[1].weight = 7;
  broken.meta.theme = 'neon';
  const out = schemaGate.check(broken);
  const bad = fails(out);
  assert.deepEqual(bad.map((c) => `${c.code} ${c.path}`).sort(), ['DF_SCHEMA_ENUM $.meta.theme', 'DF_SCHEMA_MAXIMUM $.nodes[1].weight', 'DF_SCHEMA_REQUIRED $.nodes[0].label']);
  assert.equal(out.length, codesForFamily('schema').length, 'every schema code appears exactly once here');
  assert.equal(out.filter((c) => c.status === 'pass').length, codesForFamily('schema').length - 3);
  assert.deepEqual(codesOf(schemaGate.check(base(), { schemaName: 'nope' })), ['DF_SCHEMA_NOT_FOUND']);
  assert.deepEqual(codesOf(schemaGate.check({ a: 1 }, { schema: { type: 'object', required: ['b'] } })), ['DF_SCHEMA_REQUIRED'], 'ctx.schema overrides the shipped schema');
  assert.deepEqual(codesOf(schemaGate.check(1, { schema: { type: 'object', allOf: [] } })), ['DF_SCHEMA_UNSUPPORTED_KEYWORD']);
  assert.deepEqual(schemaGate.errors(base()), []);
  assert.equal(schemaGate.SCHEMA_NAME, 'scene');
});

test('v2 codes: blocking policy, SELF_EDGE exemption, ORDER_MISSING, EDGE_ID_REQUIRED, LIFECYCLE_NO_INITIAL', () => {
  for (const c of ['DF_IR_DANGLING_VIEW_REF', 'DF_IR_ORDER_MISSING', 'DF_IR_EDGE_ID_REQUIRED', 'DF_IR_TIME_WINDOW_INVALID']) assert.equal(RULES[c].blocking, true, `${c} blocks`);
  for (const c of ['DF_IR_LIFECYCLE_NO_INITIAL', 'DF_IR_TIME_RANGE_EMPTY']) assert.equal(RULES[c].blocking, false, `${c} is non-blocking`);
  assert.deepEqual(codesForFamily('ir').slice(-6), ['DF_IR_DANGLING_VIEW_REF', 'DF_IR_ORDER_MISSING', 'DF_IR_EDGE_ID_REQUIRED', 'DF_IR_LIFECYCLE_NO_INITIAL', 'DF_IR_TIME_WINDOW_INVALID', 'DF_IR_TIME_RANGE_EMPTY']);
  assert.match(RULES.DF_IR_SELF_EDGE.message, /allowed in sequence and lifecycle scenes/);
  assert.match(RULES.DF_IR_KIND_UNKNOWN.repair, /kinds\.json/);
  const seq = sequence();
  assert.deepEqual(codesOf(topology.check(seq)), [], 'a self message in a sequence scene is clean');
  const life = lifecycle();
  assert.deepEqual(codesOf(topology.check(life)), [], 'a lifecycle with a back edge and an initial state is clean');
  life.edges.push({ id: 't4', from: 'review', to: 'review', kind: 'transition', directed: true, label: 'revise', order: 4, variant: 'dashed', route: 'orthogonal' });
  assert.deepEqual(codesOf(topology.check(life)), [], 'a self transition in a lifecycle scene is clean');
  const graphSelf = base(); graphSelf.edges.push({ id: 'm1', from: 'n-1', to: 'n-1', kind: 'message', directed: true, order: 1, variant: 'solid', route: 'straight' });
  assert.deepEqual(codesOf(topology.check(graphSelf)), ['DF_IR_SELF_EDGE'], 'the exemption is by scene kind, not edge kind');
  const noOrder = sequence(); delete noOrder.edges[0].order;
  assert.deepEqual(fails(topology.check(noOrder)).map((c) => `${c.code} ${c.path}`), ['DF_IR_ORDER_MISSING $.edges[0].order']);
  const floatOrder = base(); floatOrder.edges.push({ id: 't1', from: 'n-1', to: 'n-3', kind: 'transition', directed: true, order: 1.5, variant: 'solid', route: 'auto' });
  assert.deepEqual(codesOf(topology.check(floatOrder)), ['DF_IR_ORDER_MISSING'], 'order must be an integer');
  const relatesInSequence = sequence(); relatesInSequence.edges.push({ id: 'r1', from: 'n-1', to: 'n-3', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' });
  assert.deepEqual(codesOf(topology.check(relatesInSequence)), ['DF_IR_ORDER_MISSING'], 'every edge of a sequence scene needs an order');
  const relatesInGraph = base(); relatesInGraph.edges.push({ id: 'r1', from: 'n-2', to: 'n-3', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' });
  assert.deepEqual(codesOf(topology.check(relatesInGraph)), [], 'a relates edge in a graph needs no order');
  const noId = sequence(); delete noId.edges[2].id;
  assert.deepEqual(fails(topology.check(noId)).map((c) => `${c.code} ${c.path}`), ['DF_IR_EDGE_ID_REQUIRED $.edges[2].id'], 'a routed mode refuses an id-less edge');
  const emptyId = base(); emptyId.views['2d'].layout = 'layered'; emptyId.edges[1].id = '';
  assert.deepEqual(codesOf(topology.check(emptyId)), ['DF_IR_EDGE_ID_REQUIRED'], 'an empty id is no id');
  for (const mode of ['layered', 'sequence', 'lifecycle']) {
    const routed = base(); routed.views['2d'].layout = mode; delete routed.edges[0].id;
    assert.deepEqual(codesOf(topology.check(routed)), ['DF_IR_EDGE_ID_REQUIRED'], mode);
  }
  const freeForm = base(); delete freeForm.edges[0].id;
  assert.deepEqual(codesOf(topology.check(freeForm)), [], 'cluster-disc keys nothing by id: an id-less relates edge is allowed');
  const noInitial = lifecycle(); noInitial.nodes[0].tags = [];
  const warn = fails(topology.check(noInitial));
  assert.deepEqual(warn.map((c) => `${c.code} ${c.path} ${c.blocking}`), ['DF_IR_LIFECYCLE_NO_INITIAL $.nodes false']);
  const graphNoInitial = base();
  assert.deepEqual(codesOf(topology.check(graphNoInitial)), [], 'only lifecycle scenes need an initial state');
});

test('v2 codes: DANGLING_VIEW_REF covers steps[] and edges by id; the time window is checked per axis', () => {
  const steps = base();
  steps.views.interactive.steps = [{ id: 's1', label: 'A', nodes: ['n-1', 'ghost'], edges: ['e1', 'e-ghost'], playhead: 0 }];
  assert.deepEqual(fails(topology.check(steps)).map((c) => `${c.code} ${c.path}`), ['DF_IR_DANGLING_VIEW_REF $.views.interactive.steps[0].nodes[1]', 'DF_IR_DANGLING_VIEW_REF $.views.interactive.steps[0].edges[1]']);
  const idless = base(); delete idless.edges[0].id; idless.views.interactive.steps = [{ id: 's1', nodes: ['n-1'], edges: ['e1'] }];
  assert.deepEqual(codesOf(topology.check(idless)), ['DF_IR_DANGLING_VIEW_REF'], 'a step edge resolves by edge id only');
  const T = (time, extra = (s) => s) => { const s = extra(base()); s.views.time = time; return fails(topology.check(s)).map((c) => `${c.code} ${c.path}`); };
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: '2026-09-01', to: '2026-09-03', step: 'day', playhead: '2026-09-02' }), []);
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: '2026-09-03', to: '2026-09-01' }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.from']);
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: '2026-09-01', to: '2026-09-03', playhead: '2026-08-31' }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.playhead'], 'playhead before from');
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: '2026-09-01', to: '2026-09-03', playhead: '2026-09-04' }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.playhead'], 'playhead after to');
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: '2026-09-01', to: '2026-09-01', playhead: '2026-09-01' }), [], 'a one-day window with the playhead on it');
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: 3 }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.from'], 'an integer on a date axis');
  assert.deepEqual(T({ axis: 'order', from: '2026-09-01' }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.from'], 'a date on an order axis');
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', step: 'beat' }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.step']);
  for (const step of ['day', 'week', 'month', 'year', 'event']) assert.deepEqual(T({ axis: 'order', step }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.step'], step);
  assert.deepEqual(T({ axis: 'order', step: 'beat', from: 0, to: 3, playhead: 2 }), []);
  assert.deepEqual(T({ axis: 'order', from: 3, to: 1 }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.from']);
  assert.deepEqual(T({ axis: 'order', from: 0, to: 3, playhead: 4 }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.playhead']);
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: null, to: null, playhead: null }), [], 'null means unset');
  assert.deepEqual(T({ axis: 'date', field: 'happened_on' }), ['DF_IR_TIME_RANGE_EMPTY $.views.time.field']);
  assert.deepEqual(T({ axis: 'date' }), ['DF_IR_TIME_RANGE_EMPTY $.views.time.field'], 'field defaults to happened_on');
  assert.deepEqual(T({ axis: 'date', field: 'happened_on' }, (s) => { s.nodes[2].provenance.happened_on = '2026-09-05'; return s; }), [], 'one dated node is a range');
  assert.deepEqual(T({ axis: 'order' }), [], 'an order axis is never empty');
  assert.equal(fails(topology.check({ ...base(), views: { ...base().views, time: { axis: 'date', field: 'happened_on' } } })).find((c) => c.code === 'DF_IR_TIME_RANGE_EMPTY').blocking, false);
  assert.deepEqual(T({ axis: 'date', field: 'captured_on', from: '2026-09-03', to: '2026-09-01', step: 'beat', playhead: 7 }), ['DF_IR_TIME_WINDOW_INVALID $.views.time.playhead', 'DF_IR_TIME_WINDOW_INVALID $.views.time.step', 'DF_IR_TIME_WINDOW_INVALID $.views.time.from'], 'one fail per offending path');
  const collected = [];
  topologyViews.checkViews(null, (code, path, detail) => collected.push([code, path, detail]), null);
  topologyViews.checkViews({ views: { interactive: { steps: 'x', focus: 7 }, time: 'now' } }, (code, path, detail) => collected.push([code, path, detail]), {});
  assert.deepEqual(collected, [], 'the views half never throws and reports nothing for shapes the schema gate owns');
  assert.equal(topologyViews.axisOfValue('2026-01-01'), 'date');
  assert.equal(topologyViews.axisOfValue(0), 'order');
  assert.equal(topologyViews.axisOfValue(-1), null);
  assert.equal(topologyViews.axisOfValue(null), null);
});
