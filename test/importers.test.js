// importers/*.mjs on the synthetic fixtures under test/fixtures/importers/:
// every scene importer passes the three IR gates (schema, topology, privacy),
// every record importer passes the notes room's record schema and the
// DF_RECORD_* checks, archify keeps components, labels, boundaries,
// connection labels and sources (as evidence) and imports all five archify
// types (sequence and lifecycle through archify-seq/-life) without writing a
// position: lib/layout lays every imported scene out, csv honours --map / --relax / --id, and nothing reads a clock. node:test,
// zero network, disk only inside a temp dir (the propose round-trip).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, codesForFamily } from '../lib/rules.mjs';
import { canonical } from '../lib/digest.mjs';
import { validate } from '../lib/validate.mjs';
import * as schemaGate from '../lib/gates/schema.mjs';
import * as topology from '../lib/gates/topology.mjs';
import * as privacy from '../lib/gates/privacy.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { propose } from '../lib/proposals.mjs';
import { IMPORTERS, byId, detect, fromText, importInput, importPath, loadInput } from '../importers/index.mjs';
import * as csv from '../importers/csv.mjs';
import * as markdownDir from '../importers/markdown-dir.mjs';
import { mapRecords, parseMap } from '../importers/records.mjs';
import * as layoutGate from '../lib/gates/layout.mjs';
import { layoutScene } from '../lib/layout/index.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { NOW, NOW_ISO, readJson, scaffoldCenter } from './helpers/center.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures', 'importers');
const NOTES_DIR = join(ROOT, 'test', 'fixtures', 'rooms', 'center-min', 'rooms', 'notes');
const room = { manifest: readJson(join(NOTES_DIR, 'room.json')), recordSchema: readJson(join(NOTES_DIR, 'record.schema.json')) };
const CTX = Object.freeze({ viewer: 'self', config: { center: { owner_person_id: 'self' } }, requireProjected: false });
const EXAMPLE = readJson(join(ROOT, 'examples', 'scene-workflow.json'));

const fx = (name) => join(FIX, name);
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const codes = (checks) => [...new Set(fails(checks).map((c) => c.code))].sort();
const blocking = (checks) => fails(checks).filter((c) => c.blocking).map((c) => c.code);
const gates = (scene) => [schemaGate, topology, privacy].flatMap((g) => g.check(scene, CTX));
const run = (name, opts = {}) => importPath(fx(name), { now: NOW_ISO, ...opts });
const archifyDoc = () => readJson(fx('telemetry.archify.json'));
const asInput = (doc, name) => fromText(JSON.stringify(doc), { name });
const nodeById = (scene, id) => scene.nodes.find((n) => n.id === id);
const TOKENS_CSS = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const laid = (scene) => layoutScene(scene, { tokensCss: TOKENS_CSS });
/** The scene laid out by lib/layout passes the layout gate at showcase with no blocking finding. */
function assertShowcaseLayout(scene) {
  const out = laid(scene);
  const bad = layoutGate.check(out, { quality: 'showcase', tokensCss: TOKENS_CSS }).filter((c) => c.status === 'fail' && c.blocking);
  assert.deepEqual(bad.map((c) => [c.code, c.path]), [], 'showcase layout');
  return out;
}

function assertGateClean(scene) {
  const checks = gates(scene);
  assert.deepEqual(codes(checks), [], `IR gates: ${JSON.stringify(fails(checks).map((c) => [c.code, c.path, c.message]), null, 1)}`);
  for (const c of checks) assert.ok(RULES[c.code], `${c.code} is a catalog code`);
}

function assertImportChecks(checks) {
  for (const code of codesForFamily('import')) assert.equal(checks.filter((c) => c.code === code).length, 1, `${code} listed once`);
  for (const c of checks) {
    assert.equal(c.gate, RULES[c.code].gate);
    if (c.status === 'fail') { assert.equal(typeof c.message, 'string'); assert.equal(c.repair, RULES[c.code].repair); }
  }
}

test('registry: seven importers (sketch first), each {id, detect, run}; detect() picks the right one per fixture', () => {
  assert.deepEqual(IMPORTERS.map((i) => i.id), ['sketch', 'archify', 'son-graph', 'spatial-asset-scene', 'markdown-dir', 'csv', 'json']);
  for (const i of IMPORTERS) { assert.equal(typeof i.detect, 'function'); assert.equal(typeof i.run, 'function'); assert.equal(byId(i.id), i); }
  assert.equal(byId('nope'), null);
  const expected = { 'telemetry.archify.json': 'archify', 'handoff.sequence.archify.json': 'archify', 'son-graph.json': 'son-graph', 'spatial-asset-scene.json': 'spatial-asset-scene', 'notes.csv': 'csv', 'notes.records.json': 'json', 'notes-md': 'markdown-dir' };
  for (const [file, id] of Object.entries(expected)) assert.equal(detect(loadInput(fx(file))).id, id, file);
  const missing = importPath(fx('does-not-exist.json'), { now: NOW_ISO });
  assert.equal(missing.ok, false); assert.deepEqual(blocking(missing.checks), ['DF_IMPORT_FILE_UNREADABLE']); assertImportChecks(missing.checks);
  const unknown = importInput(fromText('one line of prose, with a comma, is no table', { name: 'x.bin' }), { now: NOW_ISO });
  assert.equal(unknown.kind, 'unknown'); assert.deepEqual(blocking(unknown.checks), ['DF_IMPORT_FORMAT_UNKNOWN']);
  const named = importInput(asInput({ a: 1 }, 'x.json'), { importer: 'nothing', now: NOW_ISO });
  assert.deepEqual(blocking(named.checks), ['DF_IMPORT_FORMAT_UNKNOWN']);
});

test('no clock: importers need opts.now and are deterministic for one now', () => {
  assert.throws(() => importPath(fx('telemetry.archify.json'), {}), /opts\.now/);
  assert.throws(() => importPath(fx('notes-md'), { room }), /opts\.now/);
  const a = run('telemetry.archify.json'); const b = run('telemetry.archify.json');
  assert.equal(canonical(a.scene), canonical(b.scene));
  const c = run('telemetry.archify.json', { now: new Date('2026-09-25T00:00:00Z') });
  assert.equal(c.scene.nodes[0].provenance.captured_on, '2026-09-25');
});

test('archify: dataflow → gate-clean workflow scene shaped like examples/scene-workflow.json', () => {
  const r = run('telemetry.archify.json');
  assert.equal(r.ok, true); assertImportChecks(r.checks); assert.deepEqual(codes(r.checks), []);
  const s = r.scene;
  assertGateClean(s);
  assert.equal(s.kind, 'workflow'); assert.equal(s.schema_version, 'dotfield.scene/1');
  for (const k of Object.keys(s)) assert.ok(k in EXAMPLE, `top-level key ${k} is in the example too`);
  assert.deepEqual(Object.keys(s.views['2d']), Object.keys(EXAMPLE.views['2d']).filter((k) => k !== 'plan'), 'the example minus the plan its layout wrote');
  assert.equal(s.views['2d'].layout, 'grid'); assert.equal(s.views['2d'].columns, 3);
  for (const k of ['positions', 'routes', 'labels', 'laid_out']) assert.ok(!(k in s), `the importer never writes ${k}`);
  assert.equal(laid(s).laid_out, true);
  assert.equal(s.meta.title, 'Telemetry pipeline'); assert.equal(s.meta.id, 'telemetry-pipeline');
  assert.equal(s.evidence[0].kind, 'import'); assert.equal(s.evidence[0].ref, 'import:archify/telemetry.archify.json'); assert.equal(s.evidence[0].label, 'SRC 1');
  assert.deepEqual(s.nodes[0].provenance.source, { kind: 'import', ref: 'import:archify/telemetry.archify.json', digest: s.evidence[0].digest });
  assert.deepEqual(Object.keys(s.nodes[0]).filter((k) => k !== 'pos').sort(), Object.keys(EXAMPLE.nodes[0]).sort(), 'the example plus the grid pin (nodes[].pos)');
  assert.deepEqual(s.nodes[0].pos, { x: 1 / 3 - 1, y: 1 / 3 - 1 }, "cell (0, 0) of a 3 x 3 grid");
});

test('archify: component count, labels, boundaries, grid and ext.archify survive', () => {
  const doc = archifyDoc(); const imported = run('telemetry.archify.json').scene; const s = laid(imported);
  assert.equal(s.nodes.length, doc.components.length);
  assert.deepEqual(s.nodes.map((n) => n.label), doc.components.map((c) => c.label));
  assert.deepEqual(s.nodes.map((n) => n.id), doc.components.map((c) => c.id));
  assert.deepEqual(s.nodes.map((n) => n.kind), ['file', 'asset', 'asset', 'file', 'asset', 'file', 'asset']);
  assert.deepEqual(s.groups.map((g) => [g.id, g.label, g.kind]), doc.boundaries.map((b) => [b.id, b.label, 'zone']));
  assert.deepEqual(s.groups.map((g) => g.wraps), [['src-rosbag', 'svc-ingest'], ['svc-sync', 'store-parquet', 'svc-eval'], ['out-report']]);
  for (const g of s.groups) for (const id of g.wraps) { assert.equal(nodeById(s, id).group, g.id); assert.equal(nodeById(s, id).color_token, g.color_token); }
  assert.equal(nodeById(s, 'ops-dash').group, undefined); assert.equal(nodeById(s, 'ops-dash').color_token, 'muted');
  assert.equal(nodeById(s, 'svc-ingest').sublabel, 'Splits a bag into frames');
  assert.deepEqual(nodeById(s, 'store-parquet').tags, ['datastore', 'cold']);
  assert.deepEqual(imported.nodes.map((n) => n.pos), s.nodes.map((n) => n.pos), 'cells pin nodes through nodes[].pos only');
  assert.deepEqual(s.positions['src-rosbag'], [300, 250]); assert.deepEqual(s.positions['svc-ingest'], [800, 250]); assert.deepEqual(s.positions['out-report'], [1300, 650]);
  const [, , w, h] = s.views['2d'].viewBox; const [px, py] = s.positions['svc-eval'];
  assert.ok(px > 0 && px < w && py > h / 2 && py < h, 'pos {x:0,y:0.6} lands in the lower half of the viewBox');
  assert.equal(Object.keys(s.positions).length, s.nodes.length);
  const a = s.ext.archify;
  assert.equal(a.diagram_type, 'dataflow'); assert.equal(a.quality_profile, 'checked'); assert.equal(a.visual_preset, 'blueprint'); assert.equal(a.icon, 'pipeline');
  assert.equal(a.nodes['src-rosbag'].tech, 'rosbag2'); assert.equal(a.nodes['out-report'].icon, 'document'); assert.deepEqual(a.boundaries.edge, { style: 'dashed' });
  assert.equal(a.connections.f3.protocol, 'arrow-flight');
  assert.ok(!('tech' in nodeById(s, 'src-rosbag')), 'presentation fields never land on the node');
});

test('archify: connections → flow edges with labels, orthogonal routes, via, label_at and order; one flow per pair', () => {
  const doc = archifyDoc(); const r = run('telemetry.archify.json'); const s = r.scene;
  assert.equal(s.edges.length, 6);
  const byId = Object.fromEntries(s.edges.map((e) => [e.id, e]));
  for (const cn of doc.connections.slice(0, 5)) assert.equal(byId[cn.id].label, cn.label, cn.id);
  for (const e of s.edges) { assert.equal(e.kind, 'flow'); assert.equal(e.directed, true); assert.equal(e.variant, 'flow'); assert.equal(typeof e.order, 'number'); }
  assert.deepEqual(s.edges.map((e) => e.route), ['orthogonal', 'orthogonal', 'orthogonal', 'straight', 'orthogonal', 'orthogonal']);
  assert.deepEqual(byId.f2.via, [[1050, 180], [1050, 250]]); assert.equal(byId.f2.label_at, 0.3); assert.equal(byId.f1.via, undefined);
  assert.equal(byId.f6.label, 'live metrics; alerts');
  assert.deepEqual(r.dropped.map((d) => [d.id, d.why]), [['f7', 'duplicate flow, merged into f6'], ['f8', 'unknown component']]);
  assert.deepEqual(s.ext.archify.dropped_connections, r.dropped);
  assert.equal(s.views.interactive.reach, 'out'); assert.equal(s.views.interactive.focus, 'src-rosbag'); assert.equal(s.views.vr.entry_node, 'src-rosbag');
});

test('archify: components[].sources → evidence of kind file labelled SRC n; absolute paths never enter', () => {
  const s = run('telemetry.archify.json').scene;
  const files = s.evidence.filter((e) => e.kind === 'file');
  assert.deepEqual(files.map((e) => e.ref), ['tools/capture/record.sh', 'capture.md#1-40', 'services/ingest/index.mjs', 'services/sync/align.py', 'jobs/eval/run.py', 'jobs/eval/metrics.py']);
  assert.deepEqual(s.evidence.map((e) => e.label), s.evidence.map((_, i) => `SRC ${i + 1}`));
  assert.equal(files[2].digest, 'sha256:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', 'a source sha256 is kept');
  assert.deepEqual(nodeById(s, 'src-rosbag').evidence_ids, ['ev-1', 'ev-2', 'ev-3']);
  assert.deepEqual(nodeById(s, 'svc-eval').evidence_ids, ['ev-1', 'ev-6', 'ev-7']);
  assert.deepEqual(nodeById(s, 'ops-dash').evidence_ids, ['ev-1']);
  assert.ok(!/\/home\//.test(canonical(s)), 'no absolute home path anywhere in the scene');
});

test('archify: all five types import, nothing is refused by name; an unknown diagram_type is refused with a repair line', () => {
  assert.deepEqual(byId('archify').SUPPORTED, ['architecture', 'workflow', 'dataflow', 'sequence', 'lifecycle']); assert.deepEqual(byId('archify').REFUSED, []);
  for (const type of ['architecture', 'workflow']) {
    const r = importInput(asInput({ ...archifyDoc(), diagram_type: type }, `${type}.archify.json`), { now: NOW_ISO });
    assert.equal(r.ok, true, type); assert.equal(r.scene.kind, 'workflow'); assert.equal(r.scene.ext.archify.diagram_type, type); assertGateClean(r.scene);
  }
  const { diagram_type: _dt, ...untyped } = archifyDoc();
  const assumed = importInput(asInput(untyped, 'untyped.json'), { now: NOW_ISO });
  assert.equal(assumed.importer, 'archify'); assert.equal(assumed.ok, true); assert.equal(assumed.scene.ext.archify.diagram_type_assumed, true);
  for (const [file, kind] of [['handoff.sequence.archify.json', 'sequence'], ['checkout.sequence.archify.json', 'sequence'], ['release.lifecycle.archify.json', 'lifecycle']]) {
    const r = run(file); assert.equal(r.ok, true, file); assert.equal(r.scene.kind, kind); assertImportChecks(r.checks); assert.deepEqual(blocking(r.checks), []); assertGateClean(r.scene);
  }
  const r = importInput(asInput({ ...archifyDoc(), diagram_type: 'Mindmap' }, 'm.json'), { now: NOW_ISO });
  assert.equal(r.ok, false); assert.equal(r.scene, null); assert.equal(r.kind, 'scene');
  assert.deepEqual(blocking(r.checks), ['DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE']); assertImportChecks(r.checks);
  const c = fails(r.checks)[0];
  assert.equal(c.path, '$.diagram_type'); assert.match(c.repair, /architecture, workflow, dataflow, sequence and lifecycle; <type> is not one of them/);
  assert.match(c.message, /'mindmap' is not a diagram type this importer knows; supported: architecture, workflow, dataflow, sequence, lifecycle/);
  const empty = importInput(asInput({ diagram_type: 'dataflow', components: [] }, 'e.json'), { now: NOW_ISO });
  assert.deepEqual(blocking(empty.checks), ['DF_IMPORT_EMPTY']);
  assert.deepEqual(blocking(importInput(asInput({ diagram_type: 'sequence', participants: [], messages: [] }, 's.json'), { now: NOW_ISO }).checks), ['DF_IMPORT_EMPTY']);
});

test('archify grid types: ids minted e<index>, mainPath → presentation + steps, trace → views.time, cards round-trip, derived order listed', () => {
  const doc = archifyDoc();
  doc.connections = doc.connections.slice(0, 6).map(({ id: _id, order: _o, ...cn }) => cn);
  Object.assign(doc, { meta: { animation: 'trace' }, mainPath: ['src-rosbag', 'svc-ingest', 'svc-sync', 'store-parquet'], cards: [{ title: 'Why', items: ['one bag, one run'] }] });
  const r = importInput(asInput(doc, 'trace.archify.json'), { now: NOW_ISO }); const s = r.scene;
  assert.equal(r.ok, true); assertImportChecks(r.checks); assertGateClean(s);
  assert.deepEqual(s.edges.map((e) => e.id), ['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(s.edges.map((e) => e.order), [1, 2, 3, 4, 5, 5], 'breadth-first depth of the source from mainPath[0] + 1');
  assert.deepEqual(codes(r.checks), ['DF_IMPORT_ORDER_FILLED']); assert.equal(RULES.DF_IMPORT_ORDER_FILLED.blocking, false);
  assert.deepEqual(s.ext.archify.order_filled, { how: "derived by breadth-first depth from mainPath[0] 'src-rosbag'", edges: 6, of: 6 });
  assert.deepEqual(s.views.time, { axis: 'order', step: 'beat', playhead: null, motion: 'trace' });
  assert.deepEqual(s.views.interactive.presentation, doc.mainPath);
  assert.deepEqual(s.views.interactive.steps.map((st) => [st.id, st.nodes, st.edges]), [['main-1', ['src-rosbag'], undefined], ['main-2', ['svc-ingest'], ['e0']], ['main-3', ['svc-sync'], ['e1']], ['main-4', ['store-parquet'], ['e2']]]);
  assert.deepEqual(s.ext.archify.cards, doc.cards);
  assert.equal(codes(run('telemetry.archify.json').checks).length, 0, 'no trace, no derived order listed');
  assertShowcaseLayout(s);
});

test('archify sequence: participants by type, beats = distinct y, return dashed, self message, activations, segments → steps, sources → evidence', () => {
  const doc = readJson(fx('checkout.sequence.archify.json')); const r = run('checkout.sequence.archify.json'); const s = r.scene;
  assert.equal(r.ok, true); assert.deepEqual(codes(r.checks), []); assertGateClean(s);
  assert.equal(s.kind, 'sequence'); assert.deepEqual(s.views['2d'], { layout: 'sequence', seed: 0 }); assert.equal(s.views['3d'].lift.mode, 'flat');
  assert.deepEqual(s.nodes.map((n) => [n.id, n.kind]), [['shopper', 'person'], ['web', 'desk'], ['api', 'desk'], ['guard', 'asset'], ['bus', 'asset'], ['db', 'record']]);
  assert.ok(s.edges.every((e) => e.kind === 'message' && e.directed && /^e\d+$/.test(e.id) && Number.isInteger(e.order)));
  const distinctY = new Set(doc.messages.map((m) => m.y)).size;
  assert.equal(new Set(s.edges.map((e) => e.order)).size, distinctY); assert.equal(s.edges.length, doc.messages.length);
  assert.equal(s.edges[3].order, s.edges[4].order, 'equal y = one beat');
  assert.deepEqual(s.edges.filter((e) => e.variant === 'dashed').map((e) => e.label), ['low risk', 'order.created', 'row id', '201 created', 'receipt page']);
  assert.deepEqual(s.edges.filter((e) => e.from === e.to).map((e) => e.label), ['validate payload', 'show spinner']);
  assert.deepEqual(s.ext.archify.activations.map((a) => [a.participant, a.beats]), [['api', [2, 9]], ['guard', [4, 5]], ['db', [6, 8]]]);
  assert.deepEqual(s.views.interactive.steps.map((st) => [st.label, st.edges.length, st.playhead]), [['Place order', 5, 4], ['Persist and publish', 4, 8], ['Confirm', 2, 10]]);
  assert.deepEqual(s.views.time, { axis: 'order', step: 'beat', playhead: null, motion: 'trace' });
  assert.equal(s.evidence.length, 1 + 2, 'SRC 1 is the import, then one per participant source');
  assert.deepEqual(nodeById(s, 'api').evidence_ids, ['ev-1', 'ev-2', 'ev-3']);
  assert.ok(!('positions' in s) && !('routes' in s));
  const out = assertShowcaseLayout(s);
  assert.equal(out.views['2d'].plan.beats, distinctY); assert.equal(Object.keys(out.routes).length, s.edges.length);
});

test('archify lifecycle: pill states tagged initial/final, lanes, transitions with sides, derived order (non-blocking), playback steps', () => {
  const r = run('release.lifecycle.archify.json'); const s = r.scene;
  assert.equal(r.ok, true); assertImportChecks(r.checks); assertGateClean(s);
  assert.deepEqual(codes(r.checks), ['DF_IMPORT_ORDER_FILLED']); assert.deepEqual(blocking(r.checks), []);
  assert.equal(s.kind, 'lifecycle'); assert.deepEqual(s.views['2d'], { layout: 'lifecycle', direction: 'right', seed: 0 });
  assert.ok(s.nodes.every((n) => n.kind === 'event' && n.shape === 'pill'));
  assert.deepEqual(s.nodes.filter((n) => n.tags.includes('initial')).map((n) => n.id), ['drafted']);
  assert.deepEqual(s.nodes.filter((n) => n.tags.includes('final')).map((n) => n.id), ['released', 'abandoned']);
  assert.deepEqual(s.groups.map((g) => [g.id, g.kind, g.wraps.length]), [['main', 'lane', 4], ['waits', 'lane', 1], ['exits', 'lane', 2]]);
  assert.ok(s.edges.every((e) => e.kind === 'transition' && Number.isInteger(e.order) && e.order >= 1));
  const byId = Object.fromEntries(s.edges.map((e) => [e.id, e]));
  assert.deepEqual([byId.hold.from_side, byId.hold.to_side, byId.hold.order], ['bottom', 'top', 3]);
  assert.equal(byId.resume.variant, 'dashed'); assert.equal(byId.rebuild.from, byId.rebuild.to);
  assert.deepEqual(s.ext.archify.rail.implied, ['e6', 'e7', 'e8']); assert.equal(byId.e6.order, 1);
  assert.deepEqual(s.ext.archify.transitions.retry.via, [[60, 380], [60, 80], [420, 80]], 'archify canvas via points round-trip; lib/layout routes the edge');
  assert.equal(byId.retry.via, undefined);
  assert.deepEqual(s.views.time, { axis: 'order', step: 'beat', playhead: null, motion: 'playback' });
  assert.equal(s.views.interactive.steps[0].nodes[0], 'drafted'); assert.equal(s.views.interactive.steps.length, s.nodes.length);
  const out = assertShowcaseLayout(s);
  assert.equal(out.views['2d'].plan.mode, 'lifecycle'); assert.deepEqual(out.views['2d'].plan.reversed, ['resume', 'retry']);
  assert.ok(out.positions.drafted[0] < out.positions.released[0], 'initial leftmost, finals on the last layer');
});

test('son-graph: a saved /api/graph JSON → gate-clean graph scene (kinds, groups, links, drops)', () => {
  const r = run('son-graph.json'); const s = r.scene;
  assert.equal(r.ok, true); assertImportChecks(r.checks); assertGateClean(s);
  assert.equal(s.kind, 'graph'); assert.equal(s.nodes.length, 7); assert.equal(s.views['2d'].layout, 'force');
  assert.deepEqual(s.nodes.map((n) => n.kind), ['note', 'note', 'note', 'note', 'tag', 'desk', 'desk']);
  assert.deepEqual(s.groups.map((g) => [g.id, g.kind]), [['docs', 'region'], ['memory', 'region'], ['tag', 'discipline'], ['agent', 'person']]);
  const cal = nodeById(s, 'docs-calibration.md');
  assert.equal(cal.weight, 1); assert.equal(cal.sublabel, 'Recalibrate by cumulative vibration, not by the calendar.'); assert.deepEqual(cal.tags, ['calibration', 'vibration', 'robotics']);
  const ghost = nodeById(s, 'ghost:loop-closure-survey');
  assert.equal(ghost.weight, 0.1); assert.deepEqual(ghost.tags, ['general', 'unresolved']);
  assert.deepEqual(s.edges.map((e) => [e.kind, e.directed]), [['link', true], ['link', true], ['member', true], ['link', true], ['relates', false], ['influences', true], ['influences', true]]);
  assert.deepEqual(r.dropped.map((d) => d.why), ['duplicate', 'unknown node', 'self link']);
  assert.equal(s.ext.son_graph.ids['docs-calibration.md'], 'docs/calibration.md');
  assert.deepEqual(s.ext.son_graph.stats, { notes: 3, links: 10, agents: 2, tags: 1 });
  assert.equal(s.ext.son_graph.nodes['agent:conductor'].tier, 'core');
  assert.ok(!/\/home\//.test(canonical(s))); assert.equal(s.ext.scrubbed.strings, 1);
  const bad = importInput(asInput({ nodes: [{ label: 'no id' }], links: [] }, 'g.json'), { now: NOW_ISO });
  assert.deepEqual(blocking(bad.checks), ['DF_IMPORT_SOURCE_UNKNOWN']);
});

test('spatial-asset-scene: zones with a box and assets with a pose → gate-clean metric room', () => {
  const r = run('spatial-asset-scene.json'); const s = r.scene;
  assert.equal(r.ok, true); assertImportChecks(r.checks); assertGateClean(s);
  assert.equal(s.kind, 'room'); assert.equal(s.views['2d'].layout, 'metric'); assert.equal(s.views['3d'].layout, 'metric'); assert.equal(s.meta.title, 'Bench room prototype');
  assert.deepEqual(s.groups.map((g) => [g.id, g.kind, g.center_xyz_m, g.size_xyz_m, g.wraps]), [
    ['zone_desk', 'zone', [-1.35, 0.01, 0.45], [1.8, 0.02, 1.3], undefined], ['zone_shelf', 'zone', [1.55, 0.01, -0.85], [1.6, 0.02, 1.1], undefined], ['zone_floor', 'zone', [0, 0, 1.2], [3, 0.02, 2], undefined]]);
  assert.equal(s.nodes.length, 5); assert.deepEqual(s.nodes.map((n) => n.kind), ['asset', 'asset', 'asset', 'file', 'asset']);
  for (const n of s.nodes) assert.ok(n.pose_m && n.pose_m.xyz.length === 3 && n.pose_m.rpy.length === 3, `${n.id} has pose_m`);
  assert.deepEqual(nodeById(s, 'asset_laptop').pose_m, { xyz: [-1.65, 0.24, 0.55], rpy: [0, 0.1, 0] }); assert.deepEqual(nodeById(s, 'asset_laptop').size_m, [0.36, 0.02, 0.25]);
  assert.deepEqual(nodeById(s, 'asset_imu').pose_m.xyz, [1.4, 0.3, -0.8]);
  assert.deepEqual(nodeById(s, 'asset_urdf').pose_m.xyz, [-1.35, 0.01, 0.45]); assert.equal(s.ext.spatial.assets.asset_urdf.pose_assumed, 'zone centre');
  assert.equal(nodeById(s, 'asset_crate').group, undefined); assert.equal(s.ext.spatial.assets.asset_crate.zone_unknown, 'zone_missing');
  assert.equal(nodeById(s, 'asset_laptop').sublabel, 'Generic Field 16'); assert.deepEqual(nodeById(s, 'asset_imu').tags, ['sensor', 'imu']);
  assert.deepEqual(s.evidence.map((e) => [e.kind, e.ref]), [['import', 'import:spatial-asset-scene/spatial-asset-scene.json'], ['file', 'laptop.pdf'], ['file', 'https://example.invalid/rig-bringup'], ['file', 'models/rover.urdf']]);
  assert.equal(s.evidence[2].digest, 'sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a');
  assert.deepEqual(nodeById(s, 'asset_laptop').evidence_ids, ['ev-1', 'ev-2', 'ev-3']);
  assert.deepEqual(s.edges.map((e) => [e.from, e.to, e.kind]), [['asset_laptop', 'asset_imu', 'relates'], ['asset_laptop', 'asset_headset', 'relates']]);
  const text = canonical(s);
  assert.ok(!/accent_color|#8bd7ff|"handle"|\/home\//.test(text), 'hex colours, handles and home paths are stripped'); assert.equal(s.ext.scrubbed.keys, 1);
  assert.equal(s.ext.spatial.room.name, 'Bench room'); assert.equal(s.ext.spatial.assets.asset_laptop.metadata.confidence_score, 0.9);
});

test('csv: RFC 4180 parse (quotes, doubled quotes, embedded newline, CRLF)', () => {
  const table = csv.parseCsv(loadInput(fx('notes.csv')).text);
  assert.equal(table.length, 7); assert.deepEqual(table[0], ['Title', 'body', 'tags', 'links', 'happened_on', 'logged_on', 'score', 'ref', 'source']);
  assert.equal(table[2][1], 'Twelve passes, two with the lights off.\nThe dark passes are the interesting ones.');
  assert.equal(table[6][1], 'Short one: "ship the summary".');
  assert.deepEqual(csv.parseCsv('a,b\n1,"x,y"\n'), [['a', 'b'], ['1', 'x,y']]);
  assert.deepEqual(csv.rowsOf([['a'], ['1', '2']]), [{ a: '1', col_2: '2' }]);
});

test('csv: --map, --id <col> and --relax → six schema-valid notes records with unknown columns kept aside', () => {
  const r = run('notes.csv', { room, map: 'Title=title', id: 'ref', relax: true });
  assert.equal(r.kind, 'records'); assert.equal(r.room, 'notes'); assert.equal(r.ok, true); assertImportChecks(r.checks);
  assert.equal(r.records.length, 6);
  assert.deepEqual(r.records.map((x) => x.note_id), ['note-0001', 'note-0002', 'note-0003', 'note-0004', 'note-0005', 'note-0006']);
  const first = r.records[0];
  assert.equal(first.title, 'Calibrate before the long run'); assert.equal(first.score, 7); assert.deepEqual(first.tags, ['idea', 'calibration']); assert.deepEqual(first.links, ['note-0002']);
  assert.equal(r.records[1].happened_on, '2026-09-12'); assert.equal(r.records[3].happened_on, '2026-09-21'); assert.deepEqual(r.records[2].links, ['note-0001', 'note-0002']);
  assert.ok(!('body' in r.records[4]), 'an empty cell is no field'); assert.ok(!('ref' in first) && !('source' in first) && !('Title' in first));
  assert.deepEqual(r.ext_rows, { 0: { source: 'notebook' }, 1: { source: 'notebook' }, 2: { source: 'reader' }, 3: { source: 'notebook' }, 4: { source: 'phone' }, 5: { source: 'notebook' } });
  assert.deepEqual(codes(r.checks), ['DF_RECORD_EXT_MOVED']); assert.deepEqual(blocking(r.checks), []);
  for (const code of codesForFamily('record')) if (code !== 'DF_RECORD_LINK_UNRESOLVED') assert.ok(r.checks.some((c) => c.code === code), `${code} listed (LINK_UNRESOLVED is the projector's)`);
  assert.deepEqual(r.source, { kind: 'import', ref: 'import:csv/notes.csv', digest: r.source.digest }); assert.match(r.source.digest, /^sha256:[0-9a-f]{64}$/);
  for (const rec of r.records) assert.deepEqual(validate(room.recordSchema, rec).errors, []);
});

test('csv: strict mode flags unknown columns; --id hash, --id missing, bad --map, header and empty cases', () => {
  const strict = run('notes.csv', { room, map: 'Title=title', id: 'hash' });
  assert.equal(strict.ok, false); assert.deepEqual(blocking(strict.checks), ['DF_RECORD_UNKNOWN_COLUMN', 'DF_RECORD_UNKNOWN_COLUMN']);
  assert.deepEqual(fails(strict.checks).map((c) => c.path), ['$[0].ref', '$[0].source']);
  assert.match(strict.records[0].note_id, /^r-[0-9a-f]{16}$/); assert.equal(strict.records[0].note_id, run('notes.csv', { room, map: 'Title=title', id: 'hash' }).records[0].note_id);
  const noId = run('notes.csv', { room, map: 'Title=title', id: 'nosuch', relax: true });
  assert.equal(noId.ok, false); assert.equal(fails(noId.checks)[0].code, 'DF_RECORD_ID_MISSING'); assert.equal(fails(noId.checks)[0].path, '--id nosuch');
  assert.ok(blocking(noId.checks).includes('DF_RECORD_SCHEMA_INVALID'), 'rows without note_id also fail the record schema');
  const badMap = run('notes.csv', { room, map: 'Title=nosuch', id: 'ref', relax: true });
  assert.equal(fails(badMap.checks)[0].code, 'DF_RECORD_MAP_FIELD_UNKNOWN'); assert.equal(fails(badMap.checks)[0].path, '--map Title=nosuch');
  const broken = run('notes.csv', { room, map: 'broken', id: 'ref', relax: true });
  assert.equal(broken.ok, false); assert.deepEqual(fails(broken.checks)[0], { ...fails(broken.checks)[0], code: 'DF_IMPORT_MAP_INVALID', path: '--map broken', blocking: true });
  assert.deepEqual(parseMap({ a: 'B', c: 'D' }).map, { a: 'B', c: 'D' }); assert.deepEqual(parseMap(['a=B', 'c=D,e=F']).map, { a: 'B', c: 'D', e: 'F' });
  assert.deepEqual(blocking(csv.run(fromText('', { name: 'empty.csv' }), { room, now: NOW_ISO }).checks), ['DF_IMPORT_CSV_HEADER_MISSING']);
  assert.deepEqual(blocking(csv.run(fromText('a,,c\n1,2,3\n', { name: 'gap.csv' }), { room, now: NOW_ISO }).checks), ['DF_IMPORT_CSV_HEADER_MISSING']);
  assert.deepEqual(blocking(csv.run(fromText('note_id,title,logged_on\n', { name: 'h.csv' }), { room, now: NOW_ISO }).checks), ['DF_IMPORT_EMPTY']);
  const dup = csv.run(fromText('note_id,title,logged_on\nn-1,A,2026-01-02\nn-1,B,2026-01-03\n', { name: 'd.csv' }), { room, now: NOW_ISO });
  assert.deepEqual(blocking(dup.checks), ['DF_RECORD_DUP_ID']);
  const date = csv.run(fromText('note_id,title,logged_on\nn-1,A,yesterday\n', { name: 'd.csv' }), { room, now: NOW_ISO });
  assert.ok(blocking(date.checks).includes('DF_RECORD_DATE_INVALID'));
  const noRoom = run('notes.csv', { map: 'Title=title' });
  assert.equal(noRoom.room, null); assert.equal(noRoom.records.length, 6); assert.equal(noRoom.records[0].title, 'Calibrate before the long run'); assert.equal(noRoom.records[0].score, '7');
  assert.deepEqual(mapRecords([{ a: '1' }], {}).records, [{ a: '1' }]);
});

test('csv → propose(): the mapped rows become one awaiting proposal and no store file', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const discovered = discoverRooms(c.centerDir, { dotDir: c.dotDir });
    const notes = discovered.rooms.find((x) => x.id === 'notes');
    const r = run('notes.csv', { room: notes, map: 'Title=title', id: 'ref', relax: true });
    assert.equal(r.ok, true); assert.equal(r.records.length, 6);
    const p = await propose({ room: notes, records: r.records, by: 'import:csv', now: NOW, dataDir: c.dataDir, config: c.config, env: {}, source: r.source });
    assert.deepEqual(p.proposal.source, r.source);
    assert.equal(p.ok, true); assert.equal(p.receipt.status, 'proposal'); assert.equal(p.proposal.records.length, 6);
    assert.equal(readdirSync(join(c.dataDir, 'proposals')).length, 1);
    assert.equal(existsSync(join(c.dataDir, 'rooms', 'notes.json')), false);
  });
});

test('json: an array of records (or {records}) → records with the same checks; non-JSON refused', () => {
  const r = run('notes.records.json', { room });
  assert.equal(r.importer, 'json'); assert.equal(r.ok, true); assert.equal(r.records.length, 3); assert.equal(r.records[1].score, 6);
  for (const rec of r.records) assert.deepEqual(validate(room.recordSchema, rec).errors, []);
  const wrapped = importInput(asInput({ schema_version: 'dotfield.store/1', records: readJson(fx('notes.records.json')) }, 's.json'), { room, now: NOW_ISO });
  assert.equal(wrapped.importer, 'json'); assert.equal(wrapped.records.length, 3);
  assert.deepEqual(blocking(importInput(fromText('{not json', { name: 'b.json' }), { importer: 'json', room, now: NOW_ISO }).checks), ['DF_IMPORT_FILE_UNREADABLE']);
  assert.deepEqual(blocking(importInput(asInput({ hello: 1 }, 'o.json'), { importer: 'json', room, now: NOW_ISO }).checks), ['DF_IMPORT_FORMAT_UNKNOWN']);
});

test('markdown-dir: four notes → records (title, tags, dates, links) plus link edges; unresolved listed', () => {
  const r = run('notes-md', { room });
  assert.equal(r.kind, 'records'); assert.equal(r.room, 'notes'); assert.equal(r.ok, true); assert.deepEqual(blocking(r.checks), []);
  assert.deepEqual(r.records.map((x) => x.note_id), ['calibration', 'hall-loop', 'reading-loop-closure-survey', 'weekly-plan']);
  assert.deepEqual(r.records.map((x) => x.title), ['Calibrate before the long run', 'Hall loop', 'Reading: loop closure survey', 'weekly-plan']);
  const cal = r.records[0];
  assert.deepEqual(cal.tags, ['idea', 'calibration', 'vibration']); assert.equal(cal.logged_on, '2026-09-19'); assert.equal(cal.happened_on, '2026-09-18'); assert.equal(cal.score, 7);
  assert.deepEqual(cal.links, ['hall-loop', 'missing-note', 'reading-loop-closure-survey']);
  assert.deepEqual(r.records[1].links, ['calibration'], 'alias links resolve, fenced links are ignored'); assert.equal(r.records[1].logged_on, '2026-10-01');
  assert.deepEqual(r.records[2].tags, ['reading', 'slam']); assert.deepEqual(r.records[2].links, ['calibration', 'hall-loop']);
  assert.deepEqual(r.records[3].links, ['calibration', 'hall-loop']); assert.deepEqual(r.records[3].tags, ['plan']);
  assert.equal(r.edges.length, 8); for (const e of r.edges) { assert.equal(e.kind, 'link'); assert.equal(e.directed, true); }
  assert.deepEqual(r.unresolved, [{ from: 'calibration', target: 'Missing note', id: 'missing-note' }]);
  for (const rec of r.records) assert.deepEqual(validate(room.recordSchema, rec).errors, []);
  const bare = run('notes-md');
  assert.equal(bare.room, 'notes'); assert.deepEqual(Object.keys(bare.records[0]).sort(), ['body', 'happened_on', 'links', 'logged_on', 'note_id', 'score', 'tags', 'title']);
  assert.deepEqual(markdownDir.frontMatter('---\ntitle: T\ntags:\n  - a\n  - b\n---\nbody').meta, { title: 'T', tags: ['a', 'b'] });
});

test('markdown-dir: an empty folder is DF_IMPORT_EMPTY; a folder of other files is not detected', async () => {
  await withTmp(async (dir) => {
    const empty = join(dir, 'empty'); mkdirSync(empty);
    const r = importPath(empty, { room, now: NOW_ISO });
    assert.equal(r.kind, 'unknown'); assert.deepEqual(blocking(r.checks), ['DF_IMPORT_FORMAT_UNKNOWN']);
    const direct = markdownDir.run(loadInput(empty), { room, now: NOW_ISO });
    assert.deepEqual(blocking(direct.checks), ['DF_IMPORT_EMPTY']); assert.deepEqual(direct.records, []);
  });
});
