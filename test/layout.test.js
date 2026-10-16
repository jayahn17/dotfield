// Layout: the positions table and the geometry tables beside it (routes, labels, plan), seeded,
// engineered determinism; the 3D/VR derivations; the repair passes (label sides, declutter, routes);
// lib/gates/layout.mjs over every shipped scene and one failing + one passing case per DF_LAYOUT_* code.
// test/fixtures/layout-500/-2000.json pin positions exactly. Anti-gaming: VIEWS_2026_10_07 pins every
// shipped scene's views.2d (minus viewBox and plan) and its node and edge counts, so a showcase win cannot
// come from a changed layout, seed, spacing, columns or label_budget. node:test, no network, nothing
// written — regenerate the fixtures with: DOTFIELD_WRITE_LAYOUT_FIXTURES=1 node --test test/layout.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codesForFamily } from '../lib/rules.mjs';
import { sha256 } from '../lib/digest.mjs';
import { validateAgainst } from '../lib/validate.mjs';
import { mulberry32 } from '../lib/layout/rng.mjs';
import { SLOTS, slot, sunflower } from '../lib/layout/trig.mjs';
import { frameOf, toThree, toVr, vrFrame } from '../lib/layout/frame.mjs';
import { fontMetrics, fontStackFor, glyphExtent, labelAnchor, labelBudgetOf, labelStyle, labelWidth, parsedTokens, shapesTable } from '../lib/layout/metrics.mjs';
import { edgePolyline, pointAt, segmentsOverlap, trim } from '../lib/layout/geometry.mjs';
import { liftPolyline, liftZ } from '../lib/layout/lift.mjs';
import { declutter } from '../lib/layout/noverlap.mjs';
import { layoutDetailed, layoutScene, layoutTables, positions3d, positionsVr, prepare, groupSeries, routesComplete, verifyDeterminism, mode3dOf, MODES_2D } from '../lib/layout/index.mjs';
import * as gate from '../lib/gates/layout.mjs';
import { syntheticScene as benchScene } from '../lib/bench/corpus.mjs';
import { oneEditStability } from '../lib/bench/metrics.mjs';
import { parseCapSentinel } from '../lib/bench/probes.mjs';
import { main as relayoutMain } from '../scripts/relayout-scenes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures');
const TOKENS = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const scenesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^scene-.*\.json$/.test(f)).sort().map((f) => join(dir, f)) : []);
const SHIPPED = [...scenesIn(join(ROOT, 'examples')), ...readdirSync(join(ROOT, 'packs')).sort().flatMap((p) => scenesIn(join(ROOT, 'packs', p, 'examples')))]
  .map((f) => [f.slice(ROOT.length + 1), readJson(f)]);
const EXAMPLES = SHIPPED.filter(([rel, s]) => rel.startsWith('examples/') && s.laid_out === true);
/** views.2d minus viewBox and plan (sha256 prefix), nodes, edges — committed 2026-10-07, before layout-core re-laid anything. */
const VIEWS_2026_10_07 = {
  'scene-graph': ['af1311a285083a66', 6, 5], 'scene-meet.example': ['84209aac409d4dc4', 6, 4], 'scene-room': ['fbccf65575168e3c', 5, 3],
  'scene-timeline': ['fe798a9e9e30e1c6', 6, 5], 'scene-workflow': ['819968b0967c6228', 6, 5], 'scene-citation-web': ['4e0d38b6e1f55a5e', 4, 5],
  'scene-collaborators': ['fe71fdee916925f5', 4, 2], 'scene-experiment-timeline': ['f3339849a36abee4', 4, 0], 'scene-influence-graph': ['05e2a4f1f8ed8adf', 4, 3],
  'scene-method-web': ['af1311a285083a66', 15, 19], 'scene-rig-room': ['fbccf65575168e3c', 5, 2], 'scene-run-history': ['f3339849a36abee4', 6, 0],
  'scene-contacts-constellation': ['ed4dc960773f9784', 4, 2], 'scene-notes-web': ['699886d3875f2fd6', 5, 5],
  'scene-sequence': ['f816240287070ed2', 3, 6], 'scene-lifecycle': ['ccfef08fad42d367', 5, 7], 'scene-architecture': ['896a579f18cabc58', 12, 13], // v2 examples, 2026-10-08
};
const LAYOUT_CODES = codesForFamily('layout');
const DIGEST = `sha256:${'0'.repeat(64)}`;
const GENERATORS = Object.freeze({ 500: { n: 500, seed: 500, groups: 12, layout: 'force' }, 2000: { n: 2000, seed: 2000, groups: 24, layout: 'force' } });
const WRITE = process.env.DOTFIELD_WRITE_LAYOUT_FIXTURES === '1';

const fails = (checks, code) => checks.filter((c) => c.status === 'fail' && (!code || c.code === code));
const blocking = (checks) => fails(checks).filter((c) => c.blocking);
const pos = (x, y) => ({ pos: { x, y } });
const pose = (x, y, z) => ({ pose_m: { xyz: [x, y, z], rpy: [0, 0, 0] } });
const r1 = (v) => Math.round(v * 10) / 10;
const quick = (laid) => ({ runner: () => layoutTables(laid) });

function node(id, extra = {}) {
  return { id, kind: 'record', label: `Node ${id}`, weight: 0.5, tags: [], color_token: 'series-1', status: 'accepted',
    provenance: { owner_person_id: 'self', source: { kind: 'record', ref: `r/${id}`, digest: DIGEST }, captured_on: '2026-01-01' },
    audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [], ...extra };
}
function edge(from, to, extra = {}) { return { id: `${from}-${to}`, from, to, kind: 'relates', directed: true, variant: 'solid', route: 'auto', ...extra }; }
function scene({ kind = 'graph', nodes = [], edges = [], groups, views = {}, meta = {}, ...rest } = {}) {
  const s = { schema_version: 'dotfield.scene/1', kind, meta: { id: 'fixture', title: 'Fixture', theme: 'default', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype', ...meta },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] }, nodes, edges, views: { '2d': { layout: kind === 'room' ? 'metric' : 'force', seed: 1, viewBox: [0, 0, 800, 500] }, ...views }, ...rest };
  if (groups) s.groups = groups;
  return s;
}
/** A committed (laid_out) scene: measured exactly as given, never re-simulated. */
const frozen = (opts, positions, extra = {}) => ({ ...scene(opts), positions, ...extra, laid_out: true });
const seqScene = () => scene({ kind: 'sequence', nodes: [node('a'), node('b'), node('c')],
  edges: [edge('a', 'b', { id: 'm1', kind: 'message', order: 1, label: 'brief' }), edge('b', 'c', { id: 'm2', kind: 'message', order: 2 }), edge('c', 'c', { id: 'm3', kind: 'message', order: 3 })], views: { '2d': { layout: 'sequence' } } });
/** The fixture generator: never change its draws, the committed positions depend on them. */
function syntheticScene({ n, seed, groups, layout = 'force', viewBox = null }) {
  const rng = mulberry32(seed);
  const kinds = ['record', 'note', 'event', 'asset', 'file', 'person', 'idea'];
  const gs = Array.from({ length: groups }, (_, g) => ({ id: `g-${g}`, label: `Group ${g}`, kind: 'region', wraps: [] }));
  const nodes = []; const edges = [];
  for (let i = 0; i < n; i += 1) {
    const id = `n-${String(i).padStart(4, '0')}`;
    const gi = rng() < 0.15 ? -1 : Math.floor(rng() * groups);
    const nd = node(id, { kind: kinds[i % kinds.length], label: `Node ${i}`, weight: Math.round(rng() * 100) / 100 });
    if (gi >= 0) { nd.group = gs[gi].id; gs[gi].wraps.push(id); }
    nodes.push(nd);
    const m = i === 0 ? 0 : 1 + (rng() < 0.5 ? 1 : 0);
    for (let k = 0; k < m; k += 1) edges.push(edge(id, nodes[Math.floor(rng() * i)].id, { id: `e-${edges.length}`, directed: false }));
  }
  const v2 = { layout, seed }; if (viewBox) v2.viewBox = viewBox;
  return scene({ nodes, edges, groups: gs, views: { '2d': v2, '3d': { layout: 'lift', scale_m: 6, lift: { mode: 'group-weight', amplitude_m: 1.5 } }, vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6 } } });
}
function renderFixture(generator, laid) {
  const head = { schema_version: 'dotfield.layout-fixture/1', note: 'Frozen output of lib/layout over syntheticScene(generator) in test/layout.test.js; the test re-runs the layout and asserts exact equality. Regenerate: DOTFIELD_WRITE_LAYOUT_FIXTURES=1 node --test test/layout.test.js', generator, viewBox: laid.views['2d'].viewBox, positions_digest: sha256(laid.positions) };
  const lines = Object.entries(laid.positions).map(([id, p]) => `    ${JSON.stringify(id)}: [${p[0]}, ${p[1]}]`);
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "positions": {\n${lines.join(',\n')}\n  }\n}\n`;
}
function inFrame(laid) {
  const f = frameOf(laid);
  return Object.values(laid.positions).every((p) => p[0] >= f.x0 + f.padding && p[0] <= f.x0 + f.w - f.padding && p[1] >= f.y0 + f.padding && p[1] <= f.y0 + f.h - f.padding);
}

// ---- the committed fixtures and the synthetic trees ----------------------------
for (const size of [500, 2000]) {
  test(`fixture layout-${size}.json: committed positions reproduce exactly, within ${size === 500 ? 3 : 10} s, gate-clean`, () => {
    const file = join(FIX, `layout-${size}.json`); const s = syntheticScene(GENERATORS[size]);
    const t0 = performance.now(); const laid = layoutScene(s); const ms = performance.now() - t0;
    assert.ok(ms < (size === 500 ? 3000 : 10000), `${size} nodes laid out in ${ms.toFixed(0)} ms`);
    if (WRITE) writeFileSync(file, renderFixture(GENERATORS[size], laid));
    const fx = readJson(file);
    assert.deepEqual(fx.generator, GENERATORS[size]); assert.equal(Object.keys(laid.positions).length, size);
    assert.deepEqual(laid.views['2d'].viewBox, fx.viewBox); assert.deepEqual(laid.positions, fx.positions);
    assert.equal(sha256(laid.positions), fx.positions_digest);
    assert.deepEqual(layoutScene(s, { force: true }).positions, fx.positions, 'a forced re-run is identical');
    assert.deepEqual(blocking(gate.check(laid, { quality: 'checked' }, quick(laid))), [], `no blocking layout finding on ${size} nodes`);
    assert.ok(inFrame(laid));
    assert.ok(validateAgainst('scene', laid).ok, 'the laid-out scene (routes, labels, plan) validates');
  });
}

test('synthetic trees (lib/bench/corpus.mjs) at checked: 100, 500 and 2000 nodes with no overlap, no containment and no clearance hit among measured labels; 100 with no route through a node; 2000 in < 10 s', () => {
  for (const n of [100, 500, 2000]) {
    const s = benchScene({ family: 'tree', n });
    const t0 = performance.now(); const laid = layoutScene(s, { tokensCss: TOKENS }); const ms = performance.now() - t0;
    if (n === 2000) assert.ok(ms < 10000, `2000 nodes laid out in ${ms.toFixed(0)} ms`);
    const checks = gate.check(laid, { quality: 'checked', tokensCss: TOKENS }, quick(laid));
    const codes = ['DF_LAYOUT_OVERLAP', 'DF_LAYOUT_REGION_CONTAINMENT', 'DF_LAYOUT_LABEL_CLEARANCE', ...(n === 100 ? ['DF_LAYOUT_ROUTE_THROUGH_NODE'] : [])];
    for (const code of codes) assert.deepEqual(fails(checks, code).map((c) => c.message), [], `tree-${n}: ${code}`);
    assert.equal(fails(checks, 'DF_LAYOUT_LABEL_BUDGET').length, n > 300 ? 1 : 0, `tree-${n}: the unmeasured labels are counted`);
    const input = prepare(laid);
    for (const [id, side] of Object.entries(laid.labels ?? {})) assert.notEqual(side, labelAnchor(input.nodes[input.ids.get(id)], shapesTable()), `tree-${n}: labels holds only non-default sides`);
  }
});

test('one-edit stability: adding a leaf to the max-degree node and re-laying warm (ctx.incremental) moves the existing nodes < 0.5 spacing on average', () => {
  for (const s of [benchScene({ family: 'tree', n: 100 }), SHIPPED.find(([rel]) => rel.endsWith('scene-method-web.json'))[1]]) {
    const st = oneEditStability(layoutScene(s, { tokensCss: TOKENS }), { tokensCss: TOKENS });
    assert.equal(st.applicable, true); assert.ok(st.mean < 0.5 * st.spacing, `mean ${st.mean} px against spacing ${st.spacing}`);
  }
});

// ---- the shipped scenes -------------------------------------------------------
test('shipped scenes: views.2d and counts as committed 2026-10-07, label_budget covers every node, routes complete, labels sparse, plan reproduced cold, showcase-clean as committed', () => {
  assert.equal(SHIPPED.length, Object.keys(VIEWS_2026_10_07).length, 'every shipped scene has a 2026-10-07 row');
  for (const [rel, s] of SHIPPED) {
    const name = rel.replace(/^.*\//, '').replace(/\.json$/, '');
    const v2 = { ...s.views['2d'] }; delete v2.viewBox; delete v2.plan;
    assert.deepEqual([sha256(v2).slice(7, 23), s.nodes.length, s.edges.length], VIEWS_2026_10_07[name], `${rel}: anti-gaming row`);
    assert.ok(labelBudgetOf(s, s.nodes.length) >= s.nodes.length, `${rel}: every label is measured`);
    if (s.laid_out === true) { assert.ok(routesComplete(s), `${rel}: routes complete`); assert.equal(layoutScene(s), s, `${rel} is never re-simulated`); }
    for (const [id, side] of Object.entries(s.labels ?? {})) assert.notEqual(side, labelAnchor(s.nodes.find((n) => n.id === id), shapesTable()), `${rel}: ${id} is off its default side`);
    if (rel.startsWith('packs/')) assert.ok(s.views['2d'].plan, `${rel} carries the plan its cold run wrote`);
    if (s.views['2d'].plan) assert.deepEqual(layoutDetailed(s, { force: true, tokensCss: TOKENS }).plan, s.views['2d'].plan, `${rel}: cold plan`);
    assert.deepEqual(blocking(gate.check(s, { quality: 'showcase', tokensCss: TOKENS })).map((c) => `${c.code} ${c.message}`), [], rel);
    if (s.laid_out === true) assert.ok(inFrame(s), rel);
  }
  const sink = { write() {} }; assert.equal(relayoutMain(['packs', 'packs/draft', '--check'], { stdout: sink, stderr: sink }), 0, 'pack scenes, drafts included, are cold-run outputs');
  const detailed = layoutDetailed(SHIPPED.find(([rel]) => rel.endsWith('scene-notes-web.json'))[1], { tokensCss: TOKENS }); assert.equal(detailed.metrics.overlap_pairs, 0);
});

test('grid from scratch on examples/scene-workflow.json: the same three column centres, one row band per zone', () => {
  const s = EXAMPLES.find(([n]) => n.endsWith('scene-workflow.json'))[1];
  const laid = layoutScene(s, { force: true }); assert.deepEqual([...new Set(Object.values(laid.positions).map((p) => p[0]))].sort((a, b) => a - b), [300, 800, 1300]);
  const bands = s.groups.map((g) => new Set(g.wraps.map((id) => laid.positions[id][1])));
  bands.forEach((rows, i) => bands.forEach((other, j) => { if (i !== j) for (const y of rows) assert.ok(!other.has(y), `zones ${i} and ${j} share no row`); }));
  assert.deepEqual(blocking(gate.check(laid)), []);
});

// ---- precedence and the frame -------------------------------------------------
test('authored pos pins a graph node (normalised -1..1 over the padded box); pose_m there is ignored and reported', () => {
  const laid = layoutScene(scene({ nodes: [node('a', pos(0.5, -0.5)), node('b', pose(9, 9, 9)), node('c')], edges: [edge('a', 'b')] }));
  assert.deepEqual(laid.positions.a, [575, 150]); assert.ok(inFrame(laid));
  assert.deepEqual(fails(gate.check(laid), 'DF_LAYOUT_POSE_IGNORED').map((c) => [c.path, c.blocking]), [['$.nodes[1].pose_m', false]]);
});

test('room: pose_m drives the top-down map at one uniform scale; pos is ignored and reported; a missing pose blocks', () => {
  const nodes = () => [node('w', pose(-2, 0, 0)), node('e', pose(2, 0, 1)), node('n', pose(0, 0, -3))];
  const plain = layoutScene(scene({ kind: 'room', nodes: nodes() }));
  const withPos = layoutScene(scene({ kind: 'room', nodes: [{ ...nodes()[0], ...pos(1, 1) }, nodes()[1], nodes()[2]] })); assert.deepEqual(withPos.positions, plain.positions, 'pos changes nothing in a room');
  assert.ok(plain.positions.w[0] < plain.positions.e[0] && plain.positions.n[1] < plain.positions.e[1]);
  assert.ok(Math.abs((plain.positions.e[0] - plain.positions.w[0]) / 4 - (plain.positions.e[1] - plain.positions.n[1]) / 4) < 1e-6, 'px per metre is uniform');
  assert.deepEqual(fails(gate.check(withPos), 'DF_LAYOUT_POSE_IGNORED').map((c) => c.path), ['$.nodes[0].pos']);
  assert.deepEqual(fails(gate.check(scene({ kind: 'room', nodes: [node('a', pose(0, 0, 0)), node('b')] })), 'DF_LAYOUT_METRIC_NO_POSE').map((c) => [c.path, c.blocking]), [['$.nodes[1].pose_m', true]]);
  assert.deepEqual(fails(gate.check(plain), 'DF_LAYOUT_METRIC_NO_POSE'), []);
});

test('vr(p) == toVr(3d(p)) exactly, lift z stays within +-0.5 scale_m, 3D is toThree of the 2D table, a route lifts by arc length', () => {
  for (const [name, s] of [...EXAMPLES, ['synthetic', layoutScene(syntheticScene({ n: 60, seed: 9, groups: 5 }))]]) {
    const p3 = positions3d(s); const vr = positionsVr(s); const vf = vrFrame(s, mode3dOf(s)); assert.deepEqual(Object.keys(vr), Object.keys(p3));
    for (const id of Object.keys(p3)) assert.deepEqual(vr[id], toVr(p3[id], vf), `${name}/${id}`);
    if (mode3dOf(s) !== 'lift') continue;
    const input = prepare(s); const z = liftZ(input); const f = frameOf(s);
    input.nodes.forEach((n, i) => {
      assert.ok(Math.abs(z[i]) <= 0.5 * (s.views['3d'] ? s.views['3d'].scale_m : 6) + 1e-9, `${name}/${n.id} z ${z[i]}`);
      assert.deepEqual(p3[n.id], toThree([s.positions[n.id][0], s.positions[n.id][1], z[i]], f).map((v) => Math.round(v * 10000) / 10000));
    });
  }
  const f = frameOf(scene()); assert.ok(toThree([f.cx, f.cy - 100, 0], f)[1] > 0, 'SVG y down becomes three y up');
  const lifted = liftPolyline({ frame: f }, [[f.cx, f.cy], [f.cx + 30, f.cy + 40], [f.cx + 90, f.cy + 120]], 0, 1.5);
  assert.deepEqual(lifted.map((p) => r1(p[2] * 10)), [0, 5, 15], 'via z = za + (zb - za) * arc-length fraction');
  assert.deepEqual(lifted[0], toThree([f.cx, f.cy, 0], f));
});

test('tier-wall (timeline) stands groups on shelves above the floor; metric 3D passes pose_m through', () => {
  const p3 = positions3d(EXAMPLES.find(([n]) => n.endsWith('scene-timeline.json'))[1]);
  const ys = new Set(Object.values(p3).map((p) => p[1]));
  assert.equal(ys.size, 2, 'one shelf per tier (the group and the ungrouped node)'); assert.ok([...ys].every((y) => y > 0.5));
  assert.deepEqual(positions3d(EXAMPLES.find(([n]) => n.endsWith('scene-room.json'))[1])['robot-hb1'], [-2, 0.4, 0]);
});

// ---- one failing and one passing case per code ----------------------------------
test('DF_LAYOUT_OVERLAP: coincident glyphs fail (blocking at checked, not at draft); separated glyphs pass; past 200 rows the sentinel carries the total', () => {
  const bad = scene({ nodes: [node('a', pos(0, 0)), node('b', pos(0, 0))] });
  const f = fails(gate.check(bad), 'DF_LAYOUT_OVERLAP'); assert.equal(f.length, 1); assert.equal(f[0].blocking, true); assert.match(f[0].message, /'a' and 'b'/);
  assert.equal(fails(gate.check(bad, { quality: 'draft' }), 'DF_LAYOUT_OVERLAP')[0].blocking, false);
  assert.deepEqual(fails(gate.check(scene({ nodes: [node('a', pos(-0.5, 0)), node('b', pos(0.5, 0))] })), 'DF_LAYOUT_OVERLAP'), []);
  const pile = Array.from({ length: 25 }, (_, i) => node(`p${i}`, { label: '' }));
  const capped = fails(gate.check(frozen({ nodes: pile }, Object.fromEntries(pile.map((n) => [n.id, [400, 250]])))), 'DF_LAYOUT_OVERLAP');
  assert.equal(capped.length, 201); assert.deepEqual(parseCapSentinel(capped[200].message), { shown: 200, total: 300, code: 'DF_LAYOUT_OVERLAP' });
  assert.match(capped[200].message, /further 100 DF_LAYOUT_OVERLAP findings not listed \(200 shown of 300\)/);
});

test('DF_LAYOUT_LABEL_CLEARANCE: measured with font-metrics.json on the committed side; non-blocking at checked, blocking at showcase; the layout moves a colliding label', () => {
  const label = 'A long label that surely spans the gap';
  const nodes = [node('a', { label }), node('b', { label })];
  const bad = frozen({ nodes }, { a: [380, 250], b: [420, 250] });
  const f = fails(gate.check(bad), 'DF_LAYOUT_LABEL_CLEARANCE'); assert.ok(f.length >= 1); assert.equal(f[0].blocking, false);
  assert.equal(fails(gate.check(bad, { quality: 'showcase' }), 'DF_LAYOUT_LABEL_CLEARANCE')[0].blocking, true);
  assert.deepEqual(fails(gate.check({ ...bad, positions: { a: [150, 250], b: [650, 250] } }), 'DF_LAYOUT_LABEL_CLEARANCE'), []);
  const relaid = layoutScene(scene({ nodes: [node('a', { label, ...pos(-0.1, 0) }), node('b', { label, ...pos(0.1, 0) })] }));
  assert.equal(Object.keys(relaid.labels).length, 1, 'one label moved off its default side');
  assert.deepEqual(fails(gate.check(relaid, { quality: 'showcase' }), 'DF_LAYOUT_LABEL_CLEARANCE'), []);
  const style = labelStyle(); assert.equal(style.source, 'font-metrics.json');
  const chars = fontMetrics()[style.stack].chars;
  assert.equal(labelWidth('Hallbot 1', style), [...'Hallbot 1'].reduce((em, ch) => em + chars[ch], 0) * style.size);
});

test('the font follows the theme: paper titles measure in serif, the gate measures node labels in the theme text stack', () => {
  const parsed = parsedTokens(TOKENS);
  assert.equal(fontStackFor(parsed, 'display', 'paper'), 'serif'); assert.equal(fontStackFor(parsed, 'display', 'default'), 'grotesk');
  assert.equal(labelStyle({ tokensCss: TOKENS, theme: 'paper' }).stack, 'sans');
  const css = `${TOKENS}\n:root[data-theme="mono-test"] { --df-font-metrics-text: mono; }\n`;
  assert.equal(labelStyle({ tokensCss: css, theme: 'mono-test' }).stack, 'mono');
  assert.equal(labelStyle({ tokensCss: css }).stack, 'sans', 'the first match in the file no longer decides');
  const label = 'Operator handoff';
  const bad = frozen({ nodes: [node('a', { label }), node('b', { label })], meta: { theme: 'paper' } }, { a: [380, 250], b: [420, 250] });
  for (const [ctx, stack] of [[{ tokensCss: TOKENS }, 'sans'], [{ tokensCss: css, theme: 'mono-test' }, 'mono']]) {
    const width = r1(labelWidth(label, { stack, size: 12 }));
    assert.ok(fails(gate.check(bad, ctx), 'DF_LAYOUT_LABEL_CLEARANCE').some((c) => c.message.includes(`(${width} px wide)`)), `${stack}: ${width} px`);
  }
});

test('DF_LAYOUT_ROUTE_THROUGH_NODE: a straight edge over a third node fails (blocking only at showcase); via[] clears it; an auto edge is routed around', () => {
  const nodes = [node('a', pos(-0.8, 0)), node('b', pos(0, 0)), node('c', pos(0.8, 0))];
  const bad = scene({ nodes, edges: [edge('a', 'c', { route: 'straight' })] });
  const f = fails(gate.check(bad), 'DF_LAYOUT_ROUTE_THROUGH_NODE');
  assert.deepEqual(f.map((c) => [c.path, c.blocking]), [['$.edges[0]', false]]); assert.match(f[0].message, /'b'/);
  assert.equal(fails(gate.check(bad, { quality: 'showcase' }), 'DF_LAYOUT_ROUTE_THROUGH_NODE')[0].blocking, true);
  assert.deepEqual(fails(gate.check(scene({ nodes, edges: [edge('a', 'c', { route: 'straight', via: [[400, 120]] })] })), 'DF_LAYOUT_ROUTE_THROUGH_NODE'), []);
  const auto = layoutScene(scene({ nodes, edges: [edge('a', 'c')] }));
  assert.equal(auto.routes['a-c'].length, 3, 'one via point beside b');
  assert.deepEqual(fails(gate.check(auto, { quality: 'showcase' }), 'DF_LAYOUT_ROUTE_THROUGH_NODE'), []);
});

test('DF_LAYOUT_REGION_CONTAINMENT: a foreign node inside a padded hull fails; a room member outside its box fails; a layered zone is a band; clean scenes pass', () => {
  const g = [{ id: 'g', label: 'G', kind: 'region', wraps: ['a', 'c'] }];
  const bad = scene({ nodes: [node('a', pos(-0.5, 0)), node('b', pos(0, 0)), node('c', pos(0.5, 0))], groups: g });
  assert.deepEqual(fails(gate.check(bad), 'DF_LAYOUT_REGION_CONTAINMENT').map((c) => [c.path, c.blocking]), [['$.groups[0].wraps', true]]);
  assert.deepEqual(fails(gate.check(scene({ nodes: [node('a', pos(-0.5, 0)), node('b', pos(0, 0.9)), node('c', pos(0.5, 0))], groups: g })), 'DF_LAYOUT_REGION_CONTAINMENT'), []);
  const box = [{ id: 'bench', label: 'Bench', kind: 'zone', center_xyz_m: [0, 0, 0], size_xyz_m: [2, 2, 2] }];
  const roomBad = scene({ kind: 'room', nodes: [node('a', { group: 'bench', ...pose(5, 0, 0) }), node('b', pose(0, 0, 4))], groups: box });
  assert.deepEqual(fails(gate.check(roomBad), 'DF_LAYOUT_REGION_CONTAINMENT').map((c) => c.path), ['$.nodes[0].pose_m']);
  assert.deepEqual(fails(gate.check(scene({ kind: 'room', nodes: [node('a', { group: 'bench', ...pose(0.5, 0, 0) }), node('b', pose(0, 0, 4))], groups: box })), 'DF_LAYOUT_REGION_CONTAINMENT'), []);
  const zones = [{ id: 'za', label: 'A', kind: 'zone', wraps: ['a', 'b'] }, { id: 'zb', label: 'B', kind: 'zone', wraps: ['c'] }];
  const lay = { kind: 'workflow', nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')], groups: zones, views: { '2d': { layout: 'layered' } } };
  assert.deepEqual(fails(gate.check(layoutScene(scene(lay))), 'DF_LAYOUT_REGION_CONTAINMENT'), [], 'the layered layout keeps zones in disjoint bands');
  const banded = frozen(lay, { a: [400, 100], b: [400, 300], c: [410, 200] }, { routes: { 'a-b': [[400, 100], [400, 300]], 'b-c': [[400, 300], [410, 200]] } });
  assert.match(fails(gate.check(banded), 'DF_LAYOUT_REGION_CONTAINMENT')[0].message, /'c' is not a member of 'za' but lies inside its band/);
});

test('DF_LAYOUT_SERIES_COLLISION: two untokened groups hashing to one series fail (non-blocking); explicit tokens pass', () => {
  let k = 1; while (groupSeries('g-0') !== groupSeries(`g-${k}`)) k += 1;
  const groups = ['g-0', `g-${k}`].map((id) => ({ id, label: id, kind: 'region', wraps: [] }));
  const f = fails(gate.check(scene({ nodes: [node('a')], groups })), 'DF_LAYOUT_SERIES_COLLISION'); assert.equal(f.length, 1); assert.equal(f[0].blocking, false); assert.equal(f[0].path, '$.groups[1].color_token');
  assert.deepEqual(fails(gate.check(scene({ nodes: [node('a')], groups: groups.map((g) => ({ ...g, color_token: 'series-2' })) })), 'DF_LAYOUT_SERIES_COLLISION'), []);
  for (let i = 0; i < 50; i += 1) assert.match(groupSeries(`id-${i}`), /^series-[1-6]$/);
});

test('DF_LAYOUT_NONDETERMINISTIC: the probe runs the layout twice over all four tables; a flaky position or a flipped route fails, the shipped modes pass', () => {
  const s = syntheticScene({ n: 30, seed: 5, groups: 3 });
  let calls = 0;
  const flaky = (sc, ctx) => { calls += 1; const p = layoutScene(sc, ctx).positions; return calls % 2 ? p : { ...p, 'n-0001': [1, 1] }; };
  const f = fails(gate.check(s, {}, { runner: flaky }), 'DF_LAYOUT_NONDETERMINISTIC'); assert.equal(f.length, 1); assert.equal(f[0].blocking, true); assert.match(f[0].message, /positions\.n-0001/);
  const seq = seqScene(); let n = 0;
  const flip = (sc, ctx) => { n += 1; const t = layoutTables(sc, ctx); return n % 2 ? t : { ...t, routes: { ...t.routes, m2: [[0, 0], [1, 1]] } }; };
  assert.deepEqual(verifyDeterminism(seq, {}, flip).diffs, ['routes.m2']);
  assert.match(fails(gate.check(seq, {}, { runner: flip }), 'DF_LAYOUT_NONDETERMINISTIC')[0].message, /routes\.m2/);
  assert.deepEqual(fails(gate.check(s), 'DF_LAYOUT_NONDETERMINISTIC'), []); assert.equal(verifyDeterminism(s).deterministic, true); assert.equal(verifyDeterminism(seq).deterministic, true);
  assert.notDeepEqual(layoutScene(s).positions, layoutScene({ ...s, views: { ...s.views, '2d': { ...s.views['2d'], seed: 6 } } }).positions, 'the seed matters');
});

test('DF_LAYOUT_UNKNOWN_MODE: a mode that does not exist or does not apply fails; declared modes that apply pass', () => {
  const v = (l2, l3) => ({ views: { '2d': { layout: l2, seed: 1 }, '3d': { layout: l3, scale_m: 6 } } });
  assert.deepEqual(fails(gate.check(scene({ nodes: [node('a')], ...v('spiral', 'lift') })), 'DF_LAYOUT_UNKNOWN_MODE').map((c) => c.path), ['$.views.2d.layout']);
  assert.deepEqual(fails(gate.check(scene({ nodes: [node('a')], ...v('metric', 'metric') })), 'DF_LAYOUT_UNKNOWN_MODE').map((c) => c.path), ['$.views.2d.layout', '$.views.3d.layout']);
  assert.deepEqual(fails(gate.check(scene({ kind: 'room', nodes: [node('a', pose(0, 0, 0))], ...v('force', 'tier-wall') })), 'DF_LAYOUT_UNKNOWN_MODE').length, 2);
  assert.equal(MODES_2D.length, 9); for (const mode of MODES_2D.filter((m) => m !== 'metric')) assert.deepEqual(fails(gate.check(scene({ nodes: [node('a')], ...v(mode, 'tier-wall') })), 'DF_LAYOUT_UNKNOWN_MODE'), [], mode);
});

test('DF_LAYOUT_POSITION_MISSING and DF_LAYOUT_ROUTE_MISSING: a laid_out scene must carry complete tables whose keys name something', () => {
  const s = scene({ nodes: [node('a'), node('b')] });
  assert.deepEqual(fails(gate.check({ ...layoutScene(s), positions: { a: [100, 100] } }), 'DF_LAYOUT_POSITION_MISSING').map((c) => [c.path, c.blocking]), [['$.positions.b', true]]);
  assert.deepEqual(fails(gate.check(s), 'DF_LAYOUT_POSITION_MISSING'), [], 'an unlaid scene is laid out in memory, not reported');
  const seq = layoutScene(seqScene()); assert.deepEqual(Object.keys(seq.routes), ['m1', 'm2', 'm3'], 'a routed mode writes every id\'d edge, the self message included');
  assert.equal(routesComplete(seq), true); assert.deepEqual(fails(gate.check(seq), 'DF_LAYOUT_ROUTE_MISSING'), []);
  const gap = { ...seq, routes: { m1: seq.routes.m1, m3: seq.routes.m3, ghost: [[0, 0], [1, 1]] }, labels: { nobody: 'above' } };
  assert.equal(routesComplete(gap), false); for (const x of [gap, { ...layoutScene(s), positions: { a: [100, 100] } }]) assert.equal(layoutScene(x), x, 'a laid_out scene is never re-laid, its tables complete or not: the gate reports what is missing');
  assert.deepEqual(fails(gate.check(gap), 'DF_LAYOUT_ROUTE_MISSING').map((c) => [c.path, c.blocking]), [['$.routes.ghost', true], ['$.routes.m2', true], ['$.labels.nobody', true]]);
  assert.equal(routesComplete({ ...layoutScene(s), routes: { 'a-b': [[0, 0], [1, 1]] } }), false, 'a key that names no edge');
});

test('DF_LAYOUT_LAYER_CYCLE_BROKEN, DF_LAYOUT_VIEWBOX_GROWN and DF_LAYOUT_LABEL_BUDGET: read from the committed plan and budget, non-blocking', () => {
  const cyc = layoutScene(scene({ kind: 'workflow', nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], views: { '2d': { layout: 'layered' } } }));
  assert.deepEqual(cyc.views['2d'].plan.reversed, ['c-a']);
  assert.deepEqual(fails(gate.check(cyc), 'DF_LAYOUT_LAYER_CYCLE_BROKEN').map((c) => [c.path, c.blocking]), [['$.edges[2]', false]]);
  assert.deepEqual(fails(gate.check(layoutScene(scene({ kind: 'workflow', nodes: [node('a'), node('b')], edges: [edge('a', 'b')], views: { '2d': { layout: 'layered' } } }))), 'DF_LAYOUT_LAYER_CYCLE_BROKEN'), []);
  const wide = 'A label far wider than this little authored box';
  const tiny = layoutScene(scene({ nodes: ['a', 'b', 'c', 'd'].map((id) => node(id, { label: wide })), views: { '2d': { layout: 'force', seed: 1, viewBox: [0, 0, 300, 200] } } }));
  assert.deepEqual(tiny.views['2d'].plan.viewbox_grown_from, [300, 200]);
  assert.ok(tiny.views['2d'].viewBox[2] > 300 && tiny.views['2d'].viewBox[3] >= 200, 'grown, never shrunk');
  assert.deepEqual(fails(gate.check(tiny, { quality: 'showcase' }), 'DF_LAYOUT_VIEWBOX_GROWN').map((c) => [c.path, c.blocking]), [['$.views.2d.viewBox', false]]);
  assert.deepEqual(blocking(gate.check(tiny, { quality: 'showcase' })), [], 'grown, so every glyph and label fits');
  const nodes = [node('a', { label: 'Overlapping label one', weight: 0.9 }), node('b', { label: 'Overlapping label two', weight: 0.1 })];
  const bud = (budget) => frozen({ nodes, views: { '2d': { layout: 'force', viewBox: [0, 0, 800, 500], label_budget: budget } } }, { a: [380, 250], b: [440, 250] });
  assert.equal(fails(gate.check(bud(2)), 'DF_LAYOUT_LABEL_CLEARANCE').length > 0, true);
  assert.deepEqual(fails(gate.check(bud(2)), 'DF_LAYOUT_LABEL_BUDGET'), []);
  assert.deepEqual(fails(gate.check(bud(1)), 'DF_LAYOUT_LABEL_CLEARANCE'), [], 'the label beyond the budget is not measured');
  assert.match(fails(gate.check(bud(1)), 'DF_LAYOUT_LABEL_BUDGET')[0].message, /1 of 2 labels lie beyond the budget of 1/);
});

test('DF_LAYOUT_EDGE_LABEL_CLEARANCE and DF_LAYOUT_ROUTE_OVERLAP: edge labels in edgeLabelBox on edgePolyline; parallel edges fan; blocking only at showcase', () => {
  const ab = frozen({ nodes: [node('a', { label: '' }), node('b', { label: '' }), node('c', { label: '' })], edges: [edge('a', 'b', { label: 'handoff' })] }, { a: [100, 250], b: [500, 250], c: [300, 240] });
  const f = fails(gate.check(ab), 'DF_LAYOUT_EDGE_LABEL_CLEARANCE'); assert.deepEqual(f.map((c) => [c.path, c.blocking]), [['$.edges[0].label', false]]); assert.match(f[0].message, /glyph of 'c'/);
  assert.equal(fails(gate.check(ab, { quality: 'showcase' }), 'DF_LAYOUT_EDGE_LABEL_CLEARANCE')[0].blocking, true);
  assert.deepEqual(fails(gate.check({ ...ab, positions: { ...ab.positions, c: [300, 400] } }), 'DF_LAYOUT_EDGE_LABEL_CLEARANCE'), []);
  const three = ['p1', 'p2', 'p3'].map((id) => edge('a', 'b', { id }));
  const fanned = layoutScene(scene({ nodes: [node('a'), node('b')], edges: three })); assert.deepEqual(Object.keys(fanned.routes), ['p1', 'p2', 'p3']);
  assert.equal(new Set(Object.values(fanned.routes).map((r) => JSON.stringify(r[1]))).size, 3, 'one via point per edge');
  assert.deepEqual(fails(gate.check(fanned, { quality: 'showcase' }), 'DF_LAYOUT_ROUTE_OVERLAP'), []);
  const twin = frozen({ nodes: [node('a'), node('b')], edges: three.slice(0, 2) }, { a: [100, 250], b: [600, 250] });
  assert.deepEqual(fails(gate.check(twin), 'DF_LAYOUT_ROUTE_OVERLAP').map((c) => [c.path, c.blocking]), [['$.edges[1]', false]]);
  assert.equal(fails(gate.check(twin, { quality: 'showcase' }), 'DF_LAYOUT_ROUTE_OVERLAP')[0].blocking, true);
});

// ---- gate shape, modes, primitives --------------------------------------------
test('gate shape: one entry per DF_LAYOUT_* code in catalog order; never throws; pass entries carry four keys', () => {
  for (const input of [null, 'x', [], {}, { nodes: 'no' }, scene()]) {
    const checks = gate.check(input);
    assert.deepEqual(checks.map((c) => c.code), LAYOUT_CODES);
    for (const c of checks) { assert.equal(c.status, 'pass'); assert.deepEqual(Object.keys(c), ['code', 'gate', 'blocking', 'status']); assert.equal(c.gate, 'layout'); }
  }
  assert.equal(gate.qualityOf(scene({ meta: { quality: 'showcase' } })), 'showcase'); assert.equal(gate.qualityOf(scene(), { quality: 'draft' }), 'draft');
});

test('every 2D mode lays out inside the padded viewBox, rounds to 1e-3, writes valid tables, sets laid_out, never mutates its input', () => {
  for (const mode of MODES_2D.filter((m) => m !== 'metric')) {
    const s = syntheticScene({ n: 30, seed: 11, groups: 3, layout: mode, viewBox: [0, 0, 1200, 700] });
    const snapshot = JSON.stringify(s); const laid = layoutScene(s);
    assert.equal(JSON.stringify(s), snapshot, `${mode} leaves the input alone`);
    assert.equal(laid.laid_out, true); assert.equal(s.laid_out, undefined); assert.equal(Object.keys(laid.positions).length, 30);
    assert.ok(inFrame(laid), mode); assert.equal(laid.views['2d'].plan.mode, mode);
    assert.ok(Object.values(laid.positions).every((p) => p.every((v) => Math.round(v * 1000) / 1000 === v)), `${mode} rounds to 1e-3`);
    assert.deepEqual(layoutScene(laid), laid, 'a complete table is kept');
    assert.ok(routesComplete(laid), mode); assert.ok(validateAgainst('scene', laid).ok, `${mode} validates`);
    assert.deepEqual(blocking(gate.check(laid)).map((c) => c.code), [], `${mode} is gate-clean at checked`);
  }
  const t = layoutScene(scene({ kind: 'timeline', nodes: [node('late', { provenance: { ...node('x').provenance, happened_on: '2026-03-01' } }), node('early', { provenance: { ...node('x').provenance, happened_on: '2026-01-01' } })], views: { '2d': { layout: 'timeline' } } }));
  assert.ok(t.positions.early[0] < t.positions.late[0], 'timeline orders by date');
  const l = layoutScene(scene({ kind: 'board', nodes: [node('a', { group: 'l1' }), node('b', { group: 'l2' }), node('c', { group: 'l1' })], groups: [{ id: 'l1', label: 'L1', kind: 'lane' }, { id: 'l2', label: 'L2', kind: 'lane' }], views: { '2d': { layout: 'lanes' } } }));
  assert.equal(l.positions.a[0], l.positions.c[0]); assert.ok(l.positions.a[0] < l.positions.b[0]);
  assert.ok(layoutScene(scene({ nodes: Array.from({ length: 400 }, (_, i) => node(`n${i}`)), views: { '2d': { layout: 'force' } } })).views['2d'].viewBox[2] > 1600, 'the default viewBox grows with the node count');
});

test('primitives: golden-angle slots, mulberry32, pill extents, polylines, collinear overlap, declutter', () => {
  assert.equal(SLOTS.length, 512); for (const [c, s] of SLOTS) assert.ok(Math.abs(Math.sqrt(c * c + s * s) - 1) < 1e-5);
  assert.deepEqual(slot(-1), slot(511)); assert.deepEqual(slot(512), slot(0)); assert.equal(sunflower(10, 100).length, 10);
  const a = mulberry32(7); const b = mulberry32(7); const c = mulberry32(8);
  const sa = [a(), a(), a()]; assert.deepEqual(sa, [b(), b(), b()]); assert.notDeepEqual(sa, [c(), c(), c()]);
  assert.deepEqual(glyphExtent(node('t', { kind: 'tag' })), [13, 6]); assert.deepEqual(glyphExtent(node('p', { shape: 'pill' })), [13, 6]); assert.deepEqual(glyphExtent(node('r')), [10, 10]);
  const e = edge('a', 'b'); assert.deepEqual(edgePolyline({}, e, [0, 0], [10, 0]), [[0, 0], [10, 0]]);
  assert.deepEqual(edgePolyline({ routes: { 'a-b': [[0, 0], [5, 5], [10, 0]] } }, e, [0, 0], [10, 0]), [[0, 0], [5, 5], [10, 0]]);
  assert.deepEqual(pointAt([[0, 0], [30, 40], [30, 90]], 0.5), [30, 40]); assert.deepEqual(trim([[0, 0], [30, 40]], 5, 10), [[3, 4], [24, 32]]);
  assert.equal(segmentsOverlap([0, 0], [10, 0], [5, 0], [20, 0]), true); assert.equal(segmentsOverlap([5, 0], [20, 0], [0, 0], [10, 0]), true);
  assert.equal(segmentsOverlap([0, 0], [10, 0], [5, 0.5], [20, 0.5]), false); assert.equal(segmentsOverlap([0, 0], [10, 0], [9.5, 0], [30, 0]), false, 'a shared run under 1 px');
  const X = new Float64Array([400, 401]); const Y = new Float64Array([250, 250]);
  const boxes = [{ left: -40, right: 40, top: -10, bottom: 20 }, { left: -40, right: 40, top: -10, bottom: 20 }];
  const d = declutter(X, Y, boxes, new Uint8Array(2), frameOf(scene()));
  assert.equal(d.moved, 0); assert.ok(X[1] - X[0] >= 80 || Y[1] - Y[0] >= 30, 'the two boxes no longer intersect');
});
