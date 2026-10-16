// The typed layouts (V2_PLAN §3 B-D): layered, sequence and lifecycle run
// directly over prepare() inputs. Zone bands, cycle reversal, id-less
// refusal, ports on the glyph, label-aware boxes, channel widening, exact
// crossing counts, beats and steps, and two-run identity. The committed
// test/fixtures/layout-layered.json pins one layered scene's tables exactly.
// node:test, no network, nothing written — regenerate the fixture with:
// DOTFIELD_WRITE_LAYOUT_FIXTURES=1 node --test test/layout-types.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha256 } from '../lib/digest.mjs';
import { mulberry32 } from '../lib/layout/rng.mjs';
import { prepare } from '../lib/layout/index.mjs';
import { GLYPH_GAP_PX, LABEL_LINE_HEIGHT, labelBox, labelStyle, labelWidth } from '../lib/layout/metrics.mjs';
import { boxesOverlap, distanceToPolyline } from '../lib/layout/geometry.mjs';
import { regionOf, insideRegion } from '../lib/gates/layout.mjs';
import { layeredLayout, layeredPlan, portsOf, boxModel, PORT_PITCH_PX } from '../lib/layout/layered.mjs';
import { TRACK_PITCH_PX, LAYER_PITCH_MULT, assignBands, countCrossings, extentOf } from '../lib/layout/layered-order.mjs';
import { LOOP_PX } from '../lib/layout/layered-order.mjs';
import { sequenceLayout, sequenceRows, SEQUENCE } from '../lib/layout/sequence.mjs';
import { lifecycleLayout, defaultLifecycleSteps } from '../lib/layout/lifecycle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'layout-layered.json');
const WRITE = process.env.DOTFIELD_WRITE_LAYOUT_FIXTURES === '1';
const DIGEST = `sha256:${'0'.repeat(64)}`;
const STYLE = labelStyle();

function node(id, extra = {}) {
  return { id, kind: 'record', label: `Node ${id}`, weight: 0.5, tags: [], color_token: 'series-1', status: 'accepted',
    provenance: { owner_person_id: 'self', source: { kind: 'record', ref: `r/${id}`, digest: DIGEST }, captured_on: '2026-01-01' },
    audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [], ...extra };
}
function edge(from, to, extra = {}) { return { id: `${from}-${to}`, from, to, kind: 'relates', directed: true, variant: 'solid', route: 'auto', ...extra }; }
function scene({ kind = 'workflow', nodes = [], edges = [], groups, views = {} } = {}) {
  const s = { schema_version: 'dotfield.scene/1', kind, meta: { id: 'fixture', title: 'Fixture', theme: 'default', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype' },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] }, nodes, edges, views: { '2d': { layout: kind === 'workflow' ? 'layered' : kind, seed: 1 }, ...views } };
  if (groups) s.groups = groups;
  return s;
}
const zone = (id, wraps) => ({ id, label: id, kind: 'zone', wraps });
const dist = (p, q) => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);

/** Two zones, six nodes each, a planar DAG plus one cross-zone edge: zero crossings exist. */
function twoZoneDag() {
  const A = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']; const B = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'];
  const nodes = [...A.map((id) => node(id, { group: 'za' })), ...B.map((id) => node(id, { group: 'zb' }))];
  const edges = [edge('a0', 'a1'), edge('a0', 'a2'), edge('a1', 'a3'), edge('a2', 'a4'), edge('a3', 'a5'), edge('a4', 'a5'),
    edge('b0', 'b1'), edge('b0', 'b2'), edge('b1', 'b3'), edge('b2', 'b4'), edge('b3', 'b5'), edge('b4', 'b5'), edge('a4', 'b5', { label: 'handoff' })];
  return scene({ nodes, edges, groups: [zone('za', A), zone('zb', B)] });
}
/** The committed fixture: the two-zone DAG plus a back edge, a long edge, a labelled self loop and a port hint. */
function fixtureScene() {
  const s = twoZoneDag();
  s.edges.push(edge('a5', 'a0', { label: 'loop back' }), edge('b0', 'b5', { label: 'express' }), edge('a3', 'a3', { label: 'retry' }), edge('a2', 'b4', { from_side: 'right' }));
  s.nodes.push(node('c0', { label: 'Ungrouped coordinator' })); s.edges.push(edge('c0', 'b2'));
  return s;
}
/** The lifecycle fixture: pills tagged initial/final, two 24-character transition labels, one back transition, one self transition. */
function lifecycleScene(direction = 'right') {
  const st = (id, label, tags = []) => node(id, { kind: 'event', shape: 'pill', label, tags });
  const t = (id, from, to, order, extra = {}) => edge(from, to, { id, kind: 'transition', order, ...extra });
  return scene({ kind: 'lifecycle', nodes: [st('queued', 'Queued', ['initial']), st('building', 'Building'), st('verifying', 'Verifying'), st('ready', 'Ready'), st('live', 'Live', ['final']), st('approval', 'Needs Approval'), st('cancelled', 'Cancelled', ['final'])],
    edges: [t('t1', 'queued', 'building', 1), t('t2', 'building', 'verifying', 2), t('t3', 'verifying', 'ready', 3), t('t4', 'ready', 'live', 4), t('t5', 'verifying', 'approval', 3, { label: 'needs release owner ok' }),
      t('t6', 'approval', 'ready', 4, { label: 'approved by the owner x' }), t('t7', 'approval', 'cancelled', 4), t('t8', 'ready', 'building', 5), t('t9', 'verifying', 'verifying', 2)],
    views: { '2d': { layout: 'lifecycle', direction } } });
}
function sequenceScene(views = {}) {
  const m = (id, from, to, order, label) => edge(from, to, { id, kind: 'message', order, label });
  return scene({ kind: 'sequence', nodes: [node('operator'), node('conductor'), node('desk')],
    edges: [m('m1', 'operator', 'conductor', 1, 'brief'), m('m2', 'conductor', 'desk', 2, 'packet'), m('m3', 'desk', 'desk', 3, 'work'), m('m4', 'desk', 'conductor', 3, 'ack'), m('m5', 'conductor', 'operator', 5)], views });
}
/** The exact edge-label box svg-edges.mjs draws (V2_PLAN §3 E): size 11 centred at pointAt(poly, label_at ?? 0.5), top q[1] - 4 - 11. */
function edgeLabelBoxOf(e, poly) {
  const lens = []; let total = 0;
  for (let i = 1; i < poly.length; i += 1) { const d = dist(poly[i], poly[i - 1]); lens.push(d); total += d; }
  let want = total * (typeof e.label_at === 'number' ? e.label_at : 0.5); let q = poly[0];
  for (let i = 0; i < lens.length; i += 1) {
    if (want <= lens[i] || i === lens.length - 1) { const f = lens[i] > 0 ? want / lens[i] : 0; q = [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * f, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * f]; break; }
    want -= lens[i];
  }
  const w = labelWidth(e.label, { ...STYLE, size: 11 });
  return { x: q[0] - w / 2, y: q[1] - 4 - 11, w, h: 11 * LABEL_LINE_HEIGHT };
}
function nodeBoxes(input, points) {
  return input.nodes.map((nd, i) => {
    const p = points[i]; const [hx, hy] = extentOf(nd, input.radii[i], input.shapes); const lb = labelBox(nd, p, input.radii[i], STYLE, input.shapes);
    const x = Math.min(p[0] - hx, lb.x); const y = Math.min(p[1] - hy, lb.y);
    return { x, y, w: Math.max(p[0] + hx, lb.x + lb.w) - x, h: Math.max(p[1] + hy, lb.y + lb.h) - y };
  });
}
/** The geometry every routed layout must deliver: ports on the glyph, no route through a third glyph, no box overlap, dense routes. */
function assertRouted(s, r, { name = 'scene', throughNode = true } = {}) {
  const input = prepare(s); const n = input.nodes.length;
  assert.equal(r.points.length, n, name);
  const boxes = nodeBoxes(input, r.points);
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) assert.ok(!boxesOverlap(boxes[i], boxes[j]), `${name}: boxes of ${input.nodes[i].id} and ${input.nodes[j].id} overlap`);
  const ids = input.edges.filter(([, , e]) => typeof e.id === 'string' && e.id).map(([, , e]) => e.id).sort();
  assert.deepEqual(Object.keys(r.routes).sort(), ids, `${name}: routes are dense over the id'd edges`);
  for (const [a, b, e] of input.edges) {
    const poly = r.routes[e.id]; if (!poly) continue;
    assert.ok(poly.length >= 2 && poly.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])), `${name}: ${e.id} is a finite polyline`);
    assert.ok(dist(poly[0], r.points[a]) <= input.radii[a] + 2e-3, `${name}: ${e.id} starts ${dist(poly[0], r.points[a]).toFixed(2)} px from '${e.from}', r ${input.radii[a]}`);
    assert.ok(dist(poly[poly.length - 1], r.points[b]) <= input.radii[b] + 2e-3, `${name}: ${e.id} ends on '${e.to}'`);
    if (throughNode) for (let k = 0; k < n; k += 1) { if (k === a || k === b) continue; const d = distanceToPolyline(r.points[k], poly, false); assert.ok(d >= input.radii[k] + GLYPH_GAP_PX / 2, `${name}: ${e.id} passes ${d.toFixed(1)} px from '${input.nodes[k].id}'`); }
  }
  return input;
}

// ---- layered -----------------------------------------------------------------
test('layered: a 12-node two-zone DAG orders with zero crossings, zone-contiguous bands, dense routes and a complete plan', () => {
  const s = twoZoneDag(); const input = prepare(s); const r = layeredLayout(input);
  assert.deepEqual(r.plan, { mode: 'layered', reversed: [], skipped: [], layers: 4, dummies: 0, crossings_before: 0, crossings_after: 0 });
  const xs = (g) => input.nodes.map((nd, i) => (nd.group === g ? r.points[i][0] : null)).filter((x) => x !== null);
  const [za, zb] = [xs('za'), xs('zb')];
  assert.ok(Math.max(...za) < Math.min(...zb) || Math.max(...zb) < Math.min(...za), 'the two zones occupy disjoint bands');
  assert.deepEqual(r.viewBox, [0, 0, 1600, 1000], 'the layout fits the default frame');
  assertRouted(s, r, { name: 'two-zone' });
  const bands = assignBands(input, layeredPlan(input).layers);
  assert.equal(bands.blocks.length, 2); assert.ok(bands.gap >= 18 + 10 + 6, 'bands sit REGION_PAD_PX + rMax + GLYPH_GAP_PX apart');
});

test('layered: an empty middle layer in zone A never lets a zone-B node into zone A\'s padded hull (containment by construction)', () => {
  const A = ['a0', 'a1', 'a2', 'a3', 'a4']; const B = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const nodes = [...A.map((id) => node(id, { group: 'za' })), ...B.map((id) => node(id, { group: 'zb' }))];
  const edges = [edge('a0', 'a2'), edge('a1', 'a3'), edge('a2', 'a4'), edge('a3', 'a4'), edge('a0', 'b2'), edge('a1', 'b3'), edge('b0', 'b2'), edge('b1', 'b3'), edge('b2', 'b4'), edge('b3', 'b5'), edge('b4', 'b6'), edge('b5', 'b6'), edge('b2', 'a2'), edge('b3', 'a3')];
  const s = scene({ nodes, edges, groups: [zone('za', A), zone('zb', B)] });
  const input = prepare(s); const plan = layeredPlan(input);
  assert.equal(plan.dummies, 2, 'a0->a2 and a1->a3 each span the empty layer (b2->a2 holds a2 at layer 2, a0->b2 keeps a0 at layer 0)');
  assert.ok(plan.layers[1].filter((v) => v >= nodes.length).every((v) => plan.sourceOf[v] < A.length), 'the dummies in the empty layer belong to zone A');
  assert.deepEqual(plan.layers[1].filter((v) => v < nodes.length).map((v) => nodes[v].id), ['b2', 'b3'], 'layer 1 holds no zone-A node');
  const r = layeredLayout(input);
  const pts = []; const rs = [];
  input.nodes.forEach((nd, i) => { if (nd.group === 'za') { pts.push(r.points[i]); rs.push(input.radii[i]); } });
  const region = regionOf(pts, rs);
  input.nodes.forEach((nd, i) => { if (nd.group === 'zb') assert.ok(!insideRegion(r.points[i], region), `${nd.id} lies inside zone A's region`); });
  assertRouted(s, r, { name: 'empty-middle' });
});

test('layered: a cycle is reported in plan.reversed, never thrown; the back edge detours around the layer span', () => {
  const s = scene({ nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')] });
  const r = layeredLayout(prepare(s));
  assert.deepEqual(r.plan.reversed, ['c-a']);
  assert.equal(r.plan.layers, 3);
  const back = r.routes['c-a'];
  assert.equal(back.length, 6, 'exit, two tracks, the outer column and the entry');
  assert.ok(back[1][1] > back[0][1] && back[3][1] < back[5][1] && back[3][1] === back[4][1], 'down past c, across, up above a');
  assert.ok(back[2][0] === back[3][0] && Math.abs(back[2][0] - r.points[0][0]) > 20, 'the vertical run lies outside the nodes');
  assertRouted(s, r, { name: 'cycle' });
});

test('layered: an id-less edge lands in plan.skipped and gets no route; the id\'d edges are all routed', () => {
  const s = scene({ nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), { from: 'b', to: 'c', kind: 'relates', directed: true, variant: 'solid', route: 'auto' }, edge('a', 'c')] });
  const r = layeredLayout(prepare(s));
  assert.deepEqual(r.plan.skipped, ['e1']);
  assert.deepEqual(Object.keys(r.routes).sort(), ['a-b', 'a-c']);
  assert.equal(r.plan.layers, 2, 'the refused edge takes no part in the layering, so c sits beside b');
});

test('layered: ports spread m same-side edges over the glyph at pitch min(8, 2r/(m+1)), every port on the glyph', () => {
  const targets = ['t0', 't1', 't2', 't3', 't4'];
  const s = scene({ nodes: [node('hub', { weight: 1 }), ...targets.map((id) => node(id))], edges: targets.map((id) => edge('hub', id)) });
  const input = prepare(s); const plan = layeredPlan(input); const r = layeredLayout(input);
  const ports = portsOf(input, input.nodes.map((_, i) => r.points[i]), plan, { direction: 'down' });
  const exits = Object.values(ports).map((p) => p.exit).sort((p, q) => p[0] - q[0]);
  const rHub = input.radii[0]; const pitch = Math.min(PORT_PITCH_PX, (2 * rHub) / (targets.length + 1));
  for (let k = 1; k < exits.length; k += 1) assert.ok(Math.abs(exits[k][0] - exits[k - 1][0] - pitch) < 1e-6, `port pitch ${pitch}`);
  for (const p of exits) assert.ok(Math.abs(dist(p, r.points[0]) - rHub) < 1e-6, 'each port lies on the circle of radius r');
  assert.ok(Object.values(ports).every((p) => p.exitSide === 'bottom' && p.entrySide === 'top'));
  assertRouted(s, r, { name: 'fan' });
});

test('layered: channel tracks widen the gap when they outgrow it, stay distinct and keep the track pitch', () => {
  const targets = Array.from({ length: 10 }, (_, k) => `t${k}`);
  const s = scene({ nodes: [node('hub'), ...targets.map((id) => node(id, { label: `A long target label ${id}` }))], edges: targets.map((id) => edge('hub', id)) });
  const input = prepare(s); const r = layeredLayout(input);
  const tracks = [...new Set(targets.map((id) => r.routes[`hub-${id}`]).filter((p) => p.length === 4).map((p) => p[1][1]))].sort((a, b) => a - b);
  assert.ok(tracks.length >= 8, `${tracks.length} bent routes take distinct tracks`);
  for (let k = 1; k < tracks.length; k += 1) assert.ok(tracks[k] - tracks[k - 1] >= (TRACK_PITCH_PX * tracks.length) / (tracks.length + 1) - 2e-3, 'tracks keep their pitch');
  const pitch = r.points[1][1] - r.points[0][1];
  assert.ok(pitch > input.frame.spacing * LAYER_PITCH_MULT + 15, `the layer pitch (${pitch.toFixed(1)}) widened for ${tracks.length} tracks`);
  assertRouted(s, r, { name: 'widen' });
});

test('layered: label boxes never overlap in either axis and every direction places its layers along the right axis', () => {
  const s = fixtureScene(); const input = prepare(s);
  const i0 = input.ids.get('a0'); const i5 = input.ids.get('a5');
  for (const direction of ['down', 'right', 'up', 'left']) {
    const r = layeredLayout(input, { direction });
    assertRouted(s, r, { name: direction });
    const [p0, p5] = [r.points[i0], r.points[i5]];
    if (direction === 'down') assert.ok(p5[1] > p0[1] && p0[0] === p5[0] ? true : p5[1] > p0[1]);
    if (direction === 'up') assert.ok(p5[1] < p0[1]);
    if (direction === 'right') assert.ok(p5[0] > p0[0]);
    if (direction === 'left') assert.ok(p5[0] < p0[0]);
    const geom = boxModel(input, layeredPlan(input), direction); const i3 = input.ids.get('a3'); const ext = extentOf(input.nodes[i3], input.radii[i3], input.shapes);
    const reach = direction === 'down' || direction === 'up' ? geom.uHi[i3] - ext[0] : -geom.uLo[i3] - ext[1];
    assert.ok(reach >= LOOP_PX, `a looped node reserves ${reach.toFixed(1)} px for its loop along the in-layer axis`);
  }
  const r = layeredLayout(input); const loop = r.routes['a3-a3'];
  assert.equal(loop.length, 4); assert.ok(Math.abs(loop[1][0] - loop[0][0] - LOOP_PX) < 11, 'a self edge loops 40 px past the glyph');
  assert.deepEqual(portsOf(input, r.points, layeredPlan(input), { direction: 'down' })[input.edges.findIndex(([, , e]) => e.id === 'a2-b4')].exitSide, 'right', 'an authored from_side overrides the forward side');
});

test('fixture layout-layered.json: committed positions, routes, plan and viewBox reproduce exactly', () => {
  const s = fixtureScene(); const input = prepare(s); const r = layeredLayout(input);
  const positions = {}; input.nodes.forEach((nd, i) => { positions[nd.id] = r.points[i]; });
  const doc = { schema_version: 'dotfield.layout-fixture/1', note: 'Frozen output of lib/layout/layered.mjs over fixtureScene() in test/layout-types.test.js; the test re-runs the layout and asserts exact equality. Regenerate: DOTFIELD_WRITE_LAYOUT_FIXTURES=1 node --test test/layout-types.test.js',
    generator: { nodes: input.nodes.length, edges: input.edges.length, direction: 'down' }, viewBox: r.viewBox, plan: r.plan, positions_digest: sha256(positions), routes_digest: sha256(r.routes), positions, routes: r.routes };
  if (WRITE) writeFileSync(FIXTURE, `${JSON.stringify(doc, null, 1)}\n`);
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(fx.generator, doc.generator);
  assert.deepEqual(fx.plan, r.plan); assert.deepEqual(fx.viewBox, r.viewBox);
  assert.deepEqual(fx.positions, positions); assert.deepEqual(fx.routes, r.routes);
  assert.equal(fx.positions_digest, sha256(positions)); assert.equal(fx.routes_digest, sha256(r.routes));
  assert.equal(r.plan.reversed.length, 1); assert.ok(r.plan.dummies >= 2); assert.equal(r.plan.skipped.length, 0);
});

test('countCrossings is exact: it matches the brute-force count on seeded bilayers, multi-edges included', () => {
  const rng = mulberry32(7);
  for (let round = 0; round < 40; round += 1) {
    const na = 2 + Math.floor(rng() * 7); const nb = 2 + Math.floor(rng() * 7);
    const A = Array.from({ length: na }, (_, i) => i); const B = Array.from({ length: nb }, (_, i) => 100 + i);
    const edges = Array.from({ length: Math.floor(rng() * 14) }, () => [Math.floor(rng() * na), 100 + Math.floor(rng() * nb)]);
    let brute = 0;
    for (let i = 0; i < edges.length; i += 1) for (let j = i + 1; j < edges.length; j += 1) {
      const [a1, b1] = edges[i]; const [a2, b2] = edges[j];
      if ((a1 < a2 && b1 > b2) || (a1 > a2 && b1 < b2)) brute += 1;
    }
    assert.equal(countCrossings(A, B, edges), brute);
  }
});

// ---- sequence ----------------------------------------------------------------
test('sequence: participants at lane pitch, beats equal distinct orders, equal orders share a row, a self message loops 40 px, the viewBox height follows the beats', () => {
  const s = sequenceScene(); const input = prepare(s); const r = sequenceLayout(input);
  assert.deepEqual(r.points, [[300, 146], [800, 146], [1300, 146]], 'three participants in a 1600 px frame');
  const rows = sequenceRows(input);
  assert.deepEqual(rows.beats, [1, 2, 3, 5]); assert.equal(r.plan.beats, 4); assert.equal(r.plan.mode, 'sequence');
  assert.equal(r.routes.m3[0][1], r.routes.m4[0][1], 'order 3 is one row');
  assert.ok(r.routes.m1[0][1] < r.routes.m2[0][1] && r.routes.m2[0][1] < r.routes.m3[0][1] && r.routes.m4[0][1] < r.routes.m5[0][1]);
  assert.equal(r.routes.m2[1][1] - r.routes.m1[1][1], rows.rowH); assert.equal(rows.rowH, input.frame.spacing * SEQUENCE.beat_mult);
  assert.deepEqual(r.routes.m3, [[1300, 434], [1340, 434], [1340, 474], [1300, 474]], 'a 40 px four-point loop');
  assert.deepEqual(r.routes.m4, [[1300, 434], [800, 434]], 'a message runs along its beat row between the lifelines');
  assert.deepEqual(r.viewBox, [0, 0, 1600, rows.lastY + rows.rowH + input.frame.padding], 'height = last beat + pitch + padding when none is authored');
  const authored = sequenceLayout(prepare(sequenceScene({ '2d': { layout: 'sequence', viewBox: [0, 0, 1600, 1000] } })));
  assert.deepEqual(authored.viewBox, [0, 0, 1600, 1000], 'an authored box is kept when it is tall enough');
  const noId = sequenceScene(); delete noId.edges[1].id;
  const r2 = sequenceLayout(prepare(noId));
  assert.deepEqual(r2.plan.skipped, ['e1']); assert.equal(r2.routes.m2, undefined); assert.equal(r2.plan.beats, 4, 'an id-less message keeps its beat but gets no route');
  const noOrder = sequenceScene(); delete noOrder.edges[4].order;
  assert.equal(sequenceLayout(prepare(noOrder)).plan.beats, 4, 'an order-less message gets a row of its own after the beats');
});

test('sequence: many participants or wide labels grow the lanes and the viewBox width, never shrinking the pitch below the label-aware minimum', () => {
  const ids = Array.from({ length: 12 }, (_, k) => `p${k}`);
  const s = scene({ kind: 'sequence', nodes: ids.map((id) => node(id, { label: `Participant ${id} with a long name` })), edges: ids.slice(1).map((id, k) => edge(ids[k], id, { id: `m${k}`, kind: 'message', order: k })) });
  const input = prepare(s); const r = sequenceLayout(input);
  const xs = r.points.map((p) => p[0]).sort((a, b) => a - b);
  const pitch = xs[1] - xs[0];
  const widest = Math.max(...input.nodes.map((nd, i) => labelBox(nd, [0, 0], input.radii[i], STYLE, input.shapes).w));
  assert.ok(pitch >= widest + input.frame.spacing, `pitch ${pitch.toFixed(1)} clears the widest label ${widest.toFixed(1)}`);
  assert.ok(r.viewBox[2] > 1600 && r.viewBox[2] >= 12 * pitch + 2 * input.frame.padding, 'the viewBox grows for the lanes');
});

// ---- lifecycle ---------------------------------------------------------------
test('lifecycle: initial first, finals last, direction right by default, a back transition detours, a self transition loops, two 24-char labels never meet a node label', () => {
  const s = lifecycleScene(); const input = prepare(s); const r = lifecycleLayout(input);
  const x = (id) => r.points[input.ids.get(id)][0];
  assert.equal(r.plan.mode, 'lifecycle'); assert.deepEqual(r.plan.reversed, ['t8']); assert.equal(r.plan.crossings_after, 0);
  assert.ok(input.nodes.every((nd) => x('queued') <= x(nd.id)), 'the initial state comes first');
  assert.ok(input.nodes.every((nd) => x(nd.id) <= x('live') && x(nd.id) <= x('cancelled')), 'final states sit on the last layer');
  assert.equal(x('live'), x('cancelled'));
  assert.equal(r.routes.t9.length, 4, 'a self transition is a four-point loop');
  assertRouted(s, r, { name: 'lifecycle' });
  const labels = input.nodes.map((nd, i) => labelBox(nd, r.points[i], input.radii[i], STYLE, input.shapes));
  const glyphs = input.nodes.map((nd, i) => { const [hx, hy] = extentOf(nd, input.radii[i], input.shapes); return { x: r.points[i][0] - hx, y: r.points[i][1] - hy, w: 2 * hx, h: 2 * hy }; });
  let labelled = 0;
  for (const [, , e] of input.edges) {
    if (typeof e.label !== 'string') continue;
    labelled += 1; const box = edgeLabelBoxOf(e, r.routes[e.id]);
    assert.ok(e.label.length === 22 || e.label.length === 23 || e.label.length === 24);
    labels.forEach((lb, i) => assert.ok(!boxesOverlap(box, lb), `edge label '${e.label}' meets the label of ${input.nodes[i].id}`));
    glyphs.forEach((g, i) => assert.ok(!boxesOverlap(box, g), `edge label '${e.label}' meets the glyph of ${input.nodes[i].id}`));
  }
  assert.equal(labelled, 2);
  assert.ok(extentOf(input.nodes[0], 10, input.shapes)[0] === 13 && extentOf(input.nodes[0], 10, input.shapes)[1] === 6, 'a pill is 1.3 r wide and 0.6 r tall');
  const down = lifecycleLayout(prepare(lifecycleScene('down')));
  const y = (id) => down.points[input.ids.get(id)][1];
  assert.ok(input.nodes.every((nd) => y('queued') <= y(nd.id) && y(nd.id) <= y('live')), 'an authored direction is honoured');
});

test('lifecycle: default steps are the BFS over transitions from the initial state, index tie-break, every state once', () => {
  const steps = defaultLifecycleSteps(lifecycleScene());
  assert.deepEqual(steps.map((st) => st.nodes[0]), ['queued', 'building', 'verifying', 'ready', 'approval', 'live', 'cancelled']);
  assert.deepEqual(steps.map((st) => st.edges), [[], ['t1'], ['t2'], ['t3'], ['t5'], ['t4'], ['t7']]);
  assert.deepEqual(steps[0], { id: 'step-1', label: 'Queued', nodes: ['queued'], edges: [] });
  assert.ok(steps.every((st) => st.label.length >= 1 && st.label.length <= 120));
  const orphan = lifecycleScene(); orphan.nodes.push(node('lost', { shape: 'pill', label: 'Lost' }));
  assert.equal(defaultLifecycleSteps(orphan).at(-1).nodes[0], 'lost', 'an unreachable state follows in node order');
  assert.deepEqual(defaultLifecycleSteps({}), []);
  const noInitial = lifecycleScene(); noInitial.nodes[0].tags = [];
  assert.equal(lifecycleLayout(prepare(noInitial)).plan.mode, 'lifecycle', 'no initial tag: the layered layout still runs from the sources');
});

// ---- determinism and edge cases -----------------------------------------------
test('two runs are identical over points, routes, sides and plan for every typed mode; empty scenes return empty tables', () => {
  const cases = [['layered', fixtureScene(), (i) => layeredLayout(i)], ['sequence', sequenceScene(), sequenceLayout], ['lifecycle', lifecycleScene(), lifecycleLayout]];
  for (const [name, s, run] of cases) {
    const a = run(prepare(s)); const b = run(prepare(JSON.parse(JSON.stringify(s))));
    assert.equal(canonical({ points: a.points, routes: a.routes, sides: a.sides ?? null, plan: a.plan }), canonical({ points: b.points, routes: b.routes, sides: b.sides ?? null, plan: b.plan }), name);
    const empty = run(prepare(scene({ kind: s.kind })));
    assert.deepEqual(empty.points, []); assert.deepEqual(empty.routes, {}); assert.equal(empty.plan.mode, name);
  }
  const pinned = fixtureScene(); pinned.nodes[0].pos = { x: -0.9, y: -0.9 };
  const r = layeredLayout(prepare(pinned));
  assert.deepEqual(r.points[0], [125, 95], 'an authored pos pins the node over the padded box (cx + x * (w/2 - padding))');
  assert.deepEqual(r.routes['a0-a1'][0], [125, 95], 'edges of a pinned node fall back to the chord');
});
