// What is committed is what is measured, and what is measured is what is
// drawn (V2_PLAN §3, §4): a laid_out scene is never silently re-laid (its
// missing rows are the gate's, through the CLI too); sublabels, evidence
// pins, order badges and region labels are measured where svg.mjs draws
// them (lib/layout/drawn.mjs, one source for both); the channel router keeps
// swapped pieces off each other's lines; every committed scene but the VISION
// §4 example is a cold-run output, drafts included; the benchmark's label
// count follows the scene's theme and its determinism probe every table; the
// projector carries steps, labels and routes through the exit door; a
// playhead outside the filled window is refused; the compare picture never
// grades a change; a 3D pick changes focus and nothing else. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runCli } from './helpers/cli.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { NOW, scaffoldCenter, writeJson } from './helpers/center.mjs';
import * as gate from '../lib/gates/layout.mjs';
import * as topology from '../lib/gates/topology.mjs';
import { layoutScene, prepare } from '../lib/layout/index.mjs';
import { drawnItems } from '../lib/layout/drawn.mjs';
import { glyphShapes } from '../lib/layout/labels.mjs';
import { trackSlots } from '../lib/layout/channels.mjs';
import { expandSketch } from '../importers/sketch.mjs';
import { renderSvg, fmt } from '../renderers/svg.mjs';
import { DELTA_TOKENS } from '../renderers/svg-delta.mjs';
import { relaid, sceneFiles, tableDiffs } from '../scripts/relayout-scenes.mjs';
import { layoutMetrics } from '../lib/bench/metrics.mjs';
import { memoRunner } from '../lib/bench/probes.mjs';
import { projectDetailed } from '../lib/project.mjs';

const TOKENS = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const example = (name) => JSON.parse(readFileSync(join(ROOT, 'examples', `${name}.json`), 'utf8'));
const fails = (checks, code) => checks.filter((c) => c.status === 'fail' && (!code || c.code === code));
const codesOf = (json) => (json && Array.isArray(json.checks) ? json.checks.filter((c) => c.status === 'fail').map((c) => c.code) : []);
const AUD = { privacy_level: 'private', share_rule_ids: [] };
const PROV = { owner_person_id: 'self', source: { kind: 'import', ref: 'test:truth', digest: `sha256:${'a'.repeat(64)}` }, captured_on: '2026-10-08' };
const node = (id, extra = {}) => ({ id, kind: 'record', label: id.toUpperCase(), weight: 0.5, tags: [], color_token: 'series-1', status: 'accepted', provenance: PROV, audience: AUD, evidence_ids: [], ...extra });
const frozen = (nodes, positions, extra = {}) => ({
  schema_version: 'dotfield.scene/1', kind: 'graph',
  meta: { id: 'truth', title: 'Truth', theme: 'default', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype' },
  viewer: { person_id: 'self', mode: 'self', rule_refs: [] }, nodes, edges: [], positions, laid_out: true,
  views: { '2d': { layout: 'force', seed: 1, viewBox: [0, 0, 1000, 700] } }, ...extra,
});

test('a laid_out scene with a stale routes key or a missing position is blocked through validate and render, never re-laid with exit 0', async () => {
  await withTmp(async (dir) => {
    const base = example('scene-workflow');
    writeJson(join(dir, 'stale.json'), { ...base, routes: { 'stale-edge': [[0, 0], [10, 10]] } });
    const holed = structuredClone(base); delete holed.positions['out-report'];
    writeJson(join(dir, 'holed.json'), holed);
    for (const [file, code, path] of [['stale.json', 'DF_LAYOUT_ROUTE_MISSING', '$.routes.stale-edge'], ['holed.json', 'DF_LAYOUT_POSITION_MISSING', '$.positions.out-report']]) {
      const v = runCli(['validate', file, '--quality', 'showcase', '--json'], { cwd: dir });
      assert.equal(v.code, 2, `${file}: validate exits 2 (${codesOf(v.json).join(', ')})`);
      assert.ok(v.json.checks.some((c) => c.status === 'fail' && c.blocking && c.code === code && c.path === path), `${file}: ${code} at ${path}`);
      const r = runCli(['render', file, `${file}.html`, '--quality', 'showcase', '--json'], { cwd: dir });
      assert.equal(r.code, 2, `${file}: render exits 2`); assert.ok(!existsSync(join(dir, `${file}.html`)), `${file}: nothing written`);
    }
  });
});

test('channels: two pieces that swap coordinates take a pre-track, so no leg runs along another (the overlap sketch and a fuzz case stay showcase-clean)', () => {
  const a = { pc: { ua: 100, ub: 200 } }; const b = { pc: { ua: 200, ub: 100 } };
  assert.deepEqual(trackSlots([a, b]).map((s) => [s.it === a ? 'a' : 'b', s.pre]), [['b', true], ['a', false], ['b', false]], 'b leaves 200 before a arrives there');
  assert.deepEqual(trackSlots([{ pc: { ua: 1, ub: 2 } }, { pc: { ua: 3, ub: 4 } }]).map((s) => s.pre), [false, false], 'no swap, no pre-track');
  const sketches = [
    { type: 'workflow', title: 'Overlap', groups: { g0: ['n4'], g1: ['n0', 'n2'] }, nodes: ['n0', 'n1', 'n2', 'n3', 'n4'], edges: ['n3 -> n1', 'n3 -> n0: step 1', 'n3 -> n2: step 2', 'n0 -> n4', 'n0 -> n1: step 5', 'n4 -> n1: step 6', 'n0 -> n3'] },
    { type: 'architecture', title: 'F66', groups: { g0: ['n0', 'n3'], g1: ['n1', 'n4'] }, nodes: ['n0', 'n1', 'n2', 'n3', 'n4'], edges: ['n1 -> n3', 'n4 -> n0: step 1', 'n2 -> n1: step 2', 'n0 -> n4', 'n1 -> n4'] },
  ];
  for (const sk of sketches) {
    const laid = layoutScene(expandSketch({ schema_version: 'dotfield.sketch/1', ...sk }, { now: NOW }), { tokensCss: TOKENS });
    const bad = fails(gate.check(laid, { quality: 'showcase', tokensCss: TOKENS })).filter((c) => c.blocking);
    assert.deepEqual(bad.map((c) => `${c.code} ${c.path}`), [], `${sk.title}: showcase-clean`);
    assert.ok(Object.values(laid.routes).some((poly) => poly.length >= 6), `${sk.title}: a swapped piece changed column through its pre-track`);
  }
});

test('sublabels, evidence pins and order badges are measured: a sublabel through a glyph and a pin over a neighbour are LABEL_CLEARANCE at their own paths', () => {
  const s = frozen([node('a', { sublabel: 'a sublabel long enough to run far to the right', evidence_ids: ['ev-1'] }), node('b'), node('c')],
    { a: [300, 300], b: [430, 334], c: [325, 278] }, { evidence: [{ id: 'ev-1', kind: 'import', ref: 'x', digest: PROV.source.digest, label: 'SRC 1' }] });
  const rows = fails(gate.check(s, { quality: 'showcase', tokensCss: TOKENS }), 'DF_LAYOUT_LABEL_CLEARANCE');
  assert.ok(rows.some((c) => c.path === '$.nodes[0].sublabel' && /the glyph of 'b'/.test(c.message)), JSON.stringify(rows.map((c) => c.message)));
  assert.ok(rows.some((c) => c.path === '$.nodes[0].evidence_ids[0]' && /the glyph of 'c'/.test(c.message)), JSON.stringify(rows.map((c) => c.message)));
  assert.ok(rows.every((c) => c.blocking), 'blocking at showcase');
  assert.deepEqual(fails(gate.check({ ...s, positions: { a: [300, 300], b: [800, 600], c: [600, 120] } }, { quality: 'showcase', tokensCss: TOKENS })), [], 'moved apart: clean');
});

test('drawn = measured: every sublabel, pin and badge in the SVG sits exactly on the box or disc drawnItems() hands the gate', () => {
  const scenes = [example('scene-lifecycle'), example('scene-workflow'), JSON.parse(readFileSync(join(ROOT, 'packs/robotics-lab/examples/scene-method-web.json'), 'utf8'))];
  let n = 0;
  for (const s of scenes) {
    const input = prepare(s, { tokensCss: TOKENS }); const g = glyphShapes(input);
    const X = Float64Array.from(input.nodes, (nd) => s.positions[nd.id][0]); const Y = Float64Array.from(input.nodes, (nd) => s.positions[nd.id][1]);
    const items = drawnItems(s, input, X, Y, g); const svg = renderSvg(s, TOKENS);
    for (const it of items.filter((x) => x.kind === 'badge')) { assert.ok(svg.includes(`class="df-badge" data-order="${input.badges.get(it.ek)}" transform="translate(${fmt(it.cx)} ${fmt(it.cy)})"`), `${s.meta.id}: badge ${it.e.id}`); n += 1; }
    for (const it of items.filter((x) => x.kind === 'sublabel' || x.kind === 'pin')) {
      const nd = input.nodes[it.i]; const p = s.positions[nd.id];
      const y = it.kind === 'sublabel' ? it.y + 11 - p[1] : it.y + 9 - p[1];
      assert.ok(svg.includes(`x="${fmt(it.x - p[0])}" y="${fmt(y)}" font-size="${it.kind === 'sublabel' ? 11 : 9}" textLength="${fmt(it.w)}"`), `${s.meta.id}: ${it.kind} of ${nd.id}`); n += 1;
    }
  }
  assert.ok(n > 30, `${n} items checked`);
});

test('every committed scene but the VISION §4 example is a cold-run output, and every draft pack scene is showcase-clean', () => {
  for (const name of ['scene-room', 'scene-timeline', 'scene-workflow', 'scene-sequence', 'scene-lifecycle', 'scene-architecture']) {
    const s = example(name); assert.deepEqual(tableDiffs(s, relaid(s, TOKENS)), [], `${name}: tables equal a cold run`);
  }
  const drafts = sceneFiles('packs/draft', ROOT); assert.equal(drafts.length, 5);
  for (const file of drafts) {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(tableDiffs(s, relaid(s, TOKENS)), [], `${file}: cold-run output`);
    assert.deepEqual(fails(gate.check(s, { quality: 'showcase', tokensCss: TOKENS })).filter((c) => c.blocking).map((c) => c.code), [], `${file}: showcase-clean`);
  }
});

test('the benchmark label count follows the theme and agrees with the gate; the determinism memo runner compares every table', () => {
  const pair = (theme) => ({ ...frozen([node('a', { label: 'Operator handoff' }), node('b', { label: 'Operator handoff' })], { a: [300, 200], b: [400, 200] }), meta: { id: 'pair', title: 'Pair', theme, quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype' } });
  for (const [theme, hit] of [['blueprint', true], ['default', false]]) {
    const s = pair(theme);
    const gateHits = fails(gate.check(s, { quality: 'checked', tokensCss: TOKENS }), 'DF_LAYOUT_LABEL_CLEARANCE').length;
    assert.equal(gateHits > 0, hit, `${theme}: gate`); assert.equal(layoutMetrics(s, { tokensCss: TOKENS }).label_collisions > 0, hit, `${theme}: bench agrees with the gate`);
  }
  const tables = memoRunner()(example('scene-architecture'), { force: true, tokensCss: TOKENS });
  assert.deepEqual(Object.keys(tables).sort(), ['labels', 'plan', 'positions', 'routes'], 'positions, routes, labels and plan');
});

test('the exit door carries v2 tables: a projection drops hidden ids from steps, labels and routes, and render --for public writes the v2 examples', async () => {
  const graph = example('scene-graph');
  const authored = { ...graph, labels: { 'idea-vib-cadence': 'above' }, routes: { e4: [[880, 300], [1180, 540]] } };
  const out = await projectDetailed({ authored, viewer: 'public', now: NOW, sessionKey: 'truth-session-key' });
  const ids = new Set(out.scene.nodes.map((nd) => nd.id)); const edgeIds = new Set(out.scene.edges.map((e) => e.id));
  for (const st of out.scene.views.interactive.steps ?? []) { assert.ok(st.nodes.every((id) => ids.has(id)), st.id); assert.ok((st.edges ?? []).every((id) => edgeIds.has(id)), st.id); }
  assert.ok(Object.keys(out.scene.labels ?? {}).every((id) => ids.has(id))); assert.ok(Object.keys(out.scene.routes ?? {}).every((id) => edgeIds.has(id)));
  assert.equal(out.scene.views['2d'].plan, undefined, 'a projection that dropped anything carries no plan');
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir); mkdirSync(join(c.dataDir, 'keys'), { recursive: true }); writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'truth-session-key\n');
    for (const name of ['scene-graph', 'scene-sequence']) {
      const r = runCli(['render', join(ROOT, 'examples', `${name}.json`), `${name}.html`, '--view', '2d', '--for', 'public', '--json'], { cwd: c.root });
      assert.equal(r.code, 0, `${name}: ${codesOf(r.json).join(', ')}`); assert.ok(!codesOf(r.json).includes('DF_IR_DANGLING_VIEW_REF'));
    }
  });
});

test('a playhead outside the filled window is DF_IR_TIME_WINDOW_INVALID even when from and to are left to their defaults', () => {
  const s = structuredClone(example('scene-graph')); delete s.views.time.from; delete s.views.time.to;
  const check = (playhead) => fails(topology.check({ ...s, views: { ...s.views, time: { ...s.views.time, playhead } } }, {}), 'DF_IR_TIME_WINDOW_INVALID');
  assert.deepEqual(check('2026-01-01').map((c) => c.path), ['$.views.time.playhead']); assert.match(check('2026-01-01')[0].message, /first point on the axis/);
  assert.deepEqual(check('2027-06-01').map((c) => c.path), ['$.views.time.playhead']); assert.deepEqual(check(null), []);
});

test('the compare picture never grades a change, and a 3D pick hands focus to the shell without the hash', () => {
  for (const t of Object.values(DELTA_TOKENS)) assert.ok(!['good', 'warn', 'bad'].includes(t), `${t} is not a status token`);
  assert.equal(new Set(Object.values(DELTA_TOKENS)).size, 4, 'four classes, four tokens');
  const mount = readFileSync(join(ROOT, 'renderers', 'three-mount.mjs'), 'utf8');
  assert.doesNotMatch(mount, /\.hash\s*=/, 'three-mount never writes location.hash');
  const listeners = {}; const patches = [];
  const DF = { state: { focus: null, t: '2026-08-01', view: '3d', live: true }, setState: (p) => { patches.push(p); DF.state = { ...DF.state, ...p }; } };
  const saved = globalThis.document; globalThis.document = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  try {
    new Function('DF', readFileSync(join(ROOT, 'renderers', 'viewer', 'shell.js'), 'utf8'))(DF); DF.mountThreeBridge();
    listeners['dotfield:3d-select']({ detail: { id: 'exp-0412' } }); listeners['dotfield:3d-select']({ detail: { id: 'exp-0412' } });
  } finally { globalThis.document = saved; }
  assert.deepEqual(patches, [{ focus: 'exp-0412' }, { focus: null }]); assert.deepEqual([DF.state.t, DF.state.view, DF.state.live], ['2026-08-01', '3d', true], 'time, playback and view kept');
});

test('every example and pack scene stays under the drawn-truth gate at showcase (sublabels, pins, badges and region labels included)', () => {
  const files = [...readdirSync(join(ROOT, 'examples')).filter((f) => /^scene-.*\.json$/.test(f)).map((f) => join(ROOT, 'examples', f)), ...sceneFiles('packs', ROOT), ...sceneFiles('packs/draft', ROOT)];
  for (const file of files) {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(fails(gate.check(s, { quality: 'showcase', tokensCss: TOKENS })).filter((c) => c.blocking).map((c) => `${c.code} ${c.message}`), [], file);
  }
});
