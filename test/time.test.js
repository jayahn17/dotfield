// The one playhead, twice: lib/time (Node) and renderers/viewer/time.js (the
// classic-script mirror, evaluated here with a DF stub) must agree to the last
// Set member on every examples/scene-*.json present on disk (discovered, so
// later examples join on their own), on the ir-v2 sequence/lifecycle fixtures
// and on three synthetic scenes; the day arithmetic is pinned against Date.UTC
// and the month-end / leap-year clamps V2_PLAN §5 names. Zero network, no disk writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, read, lineCount } from './helpers/scan.mjs';
import * as K from '../lib/time/ticks.mjs';
import * as P from '../lib/time/playhead.mjs';
import * as G from '../lib/gates/topology-views.mjs';
import { sequence, lifecycle } from './fixtures/ir/build-fixtures.mjs';

const MIRROR = read('renderers/viewer/time.js');
const DF = {};
new Function('DF', MIRROR)(DF);
const PUBLIC = ['daysInMonth', 'parseIso', 'isIsoDate', 'formatIso', 'dayIndex', 'fromDayIndex', 'addStep', 'floorToStep',
  'enteringOrders', 'timeIndex', 'bornAt', 'edgeAt', 'timeOf', 'ticks', 'phaseOf', 'stepIndexOf', 'visibleAt'];
const LIB = { ...K, ...P };

const EXAMPLES = readdirSync(join(ROOT, 'examples')).filter((f) => /^scene-.*\.json$/.test(f)).sort();
const example = (f) => JSON.parse(read(`examples/${f}`));
const clone = (v) => JSON.parse(JSON.stringify(v));
const withTime = (scene, time) => { const s = clone(scene); s.views = { ...(s.views || {}), time }; return s; };
const prov = (captured, extra = {}) => ({ owner_person_id: 'self', source: { kind: 'record', ref: `r/${captured}`, digest: `sha256:${'0'.repeat(64)}` }, captured_on: captured, ...extra });
const node = (id, captured, extra = {}, tags) => ({ id, kind: 'note', label: id, provenance: prov(captured, extra), ...(tags ? { tags } : {}) });

/** Three synthetic scenes: a cumulative date axis, a windowed date axis, an order axis. */
function dateCumulative() {
  return {
    schema_version: 'dotfield.scene/1', kind: 'graph', meta: { id: 'syn-date', title: 'Synthetic dates' },
    nodes: [node('a', '2026-01-10', { happened_on: '2026-01-05' }), node('b', '2026-01-31'), node('c', '2026-02-29'.replace('29', '28'), { happened_on: '2026-03-01' }), node('u', '2026-02-02', {}), node('x', '2026-02-10', { happened_on: 'not-a-date' })],
    edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'relates' }, { id: 'e2', from: 'b', to: 'c', kind: 'relates', at: '2026-02-14' }, { from: 'a', to: 'c', kind: 'cites' }, { id: 'e4', from: 'a', to: 'ghost', kind: 'relates' }],
    views: { '2d': { layout: 'force' }, time: { axis: 'date', field: 'happened_on', step: 'week', from: '2026-01-01', to: '2026-03-15', playhead: null, cumulative: true, motion: 'trace', trace: { trail: 0.5 } } },
  };
}
function dateWindow() {
  const s = dateCumulative();
  s.meta.id = 'syn-window';
  s.views.time = { axis: 'date', step: 'month', cumulative: false, motion: 'playback', playhead: '2026-02-20' };
  return s;
}
function orderAxis() {
  return {
    schema_version: 'dotfield.scene/1', kind: 'workflow', meta: { id: 'syn-order', title: 'Synthetic order' },
    nodes: [node('src', '2026-01-01'), node('mid', '2026-01-01'), node('alt', '2026-01-01'), node('end', '2026-01-01'), node('late', '2026-01-01', {}, ['initial'])],
    edges: [
      { id: 'f1', from: 'src', to: 'mid', kind: 'flow', order: 1 }, { id: 'f2', from: 'src', to: 'alt', kind: 'flow', order: 1 },
      { id: 'f3', from: 'mid', to: 'end', kind: 'flow', order: 4 }, { id: 'f4', from: 'alt', to: 'end', kind: 'flow', order: 2, directed: false },
      { id: 'f5', from: 'end', to: 'late', kind: 'flow', order: 7 }, { id: 'f6', from: 'late', to: 'src', kind: 'relates' },
    ],
    views: { '2d': { layout: 'grid' }, time: { axis: 'order', step: 'beat', from: 0, to: 9, playhead: 4 } },
  };
}

const DATE_T = { axis: 'date', field: 'happened_on', step: 'week', playhead: null, cumulative: true, motion: 'still' };
const ORDER_T = { axis: 'order', step: 'beat', playhead: null, motion: 'still' };
/** Every scene the mirror is checked on: each example as shipped, with a date block and with an order block; the two fixtures; the three synthetic. */
function corpus() {
  const out = [];
  for (const f of EXAMPLES) { const s = example(f); out.push([f, s], [`${f}+date`, withTime(s, DATE_T)], [`${f}+captured`, withTime(s, { ...DATE_T, field: 'captured_on', step: 'month' })], [`${f}+order`, withTime(s, ORDER_T)]); }
  out.push(['fixture sequence', sequence()], ['fixture lifecycle', lifecycle()], ['syn date', dateCumulative()], ['syn window', dateWindow()], ['syn order', orderAxis()]);
  return out;
}

/** The probe points for a scene: every tick, the playhead, null, one point before and after the window, and a mid-step point. */
function probes(scene) {
  const time = P.timeOf(scene);
  const pts = [null, undefined, ...P.ticks(scene)];
  if (!time) return [...pts, 0, '2026-01-01'];
  pts.push(time.playhead);
  if (time.axis === 'date' && time.from) pts.push(K.addStep(time.from, 'day', -1), K.addStep(time.to, 'day', 1), K.addStep(time.from, 'day', 3), K.dayIndex(time.from) + 10, 'bad', 5);
  else pts.push(-1, (time.to ?? 0) + 1, 'bad', '2026-01-01');
  return pts;
}

test('every public function of lib/time is on DF with the same name, and no DF entry is missing or extra', () => {
  for (const name of PUBLIC) { assert.equal(typeof LIB[name], 'function', `lib exports ${name}`); assert.equal(typeof DF[name], 'function', `DF.${name}`); }
  assert.deepEqual(DF.DATE_STEPS, [...P.DATE_STEPS]); assert.deepEqual(DF.ORDER_STEPS, [...P.ORDER_STEPS]); assert.deepEqual(DF.CALENDAR_STEPS, [...K.CALENDAR_STEPS]);
  assert.equal(DF.DEFAULT_TIME_FIELD, P.DEFAULT_TIME_FIELD); assert.deepEqual(DF.STEP_LEN, { ...P.STEP_LEN });
  const onDF = Object.keys(DF).filter((k) => typeof DF[k] === 'function').sort();
  assert.deepEqual(onDF, [...PUBLIC].sort(), 'the mirror carries exactly the public surface (helpers live under DF.time)');
});

test('lib/time agrees with lib/gates/topology-views.mjs on the default field and the steps of each axis', () => {
  assert.equal(P.DEFAULT_TIME_FIELD, G.DEFAULT_TIME_FIELD);
  assert.deepEqual([...P.DATE_STEPS], [...G.DATE_STEPS]); assert.deepEqual([...P.ORDER_STEPS], [...G.ORDER_STEPS]);
  for (const s of [...P.DATE_STEPS, ...P.ORDER_STEPS]) assert.ok(P.STEP_LEN[s] > 0, `STEP_LEN.${s}`);
});

test('day arithmetic matches Date.UTC over 1900..2200 and round-trips; invalid dates are null', () => {
  for (let n = -25567; n <= 84000; n += 37) {
    const iso = new Date(n * 86400000).toISOString().slice(0, 10);
    assert.equal(K.fromDayIndex(n), iso); assert.equal(K.dayIndex(iso), n); assert.equal(DF.dayIndex(iso), n); assert.equal(DF.fromDayIndex(n), iso);
  }
  assert.equal(K.dayIndex('1970-01-01'), 0); assert.equal(K.dayIndex('2000-02-29'), 11016); assert.equal(K.fromDayIndex(11016), '2000-02-29');
  for (const bad of ['2026-13-40', '2026-02-30', '2023-02-29', '2026-1-5', '20260105', 12, null, undefined, '', '2026-00-10']) {
    assert.equal(K.dayIndex(bad), null, String(bad)); assert.equal(K.isIsoDate(bad), false); assert.equal(DF.dayIndex(bad), null);
  }
  assert.equal(K.isIsoDate('2024-02-29'), true); assert.equal(K.fromDayIndex(1.5), null); assert.equal(K.fromDayIndex('3'), null);
});

test('month and year steps move calendar fields and clamp the day: the month-end and leap-year cases', () => {
  const cases = [
    ['2026-01-31', 'month', 1, '2026-02-28'], ['2024-02-29', 'year', 1, '2025-02-28'], ['2024-01-31', 'month', 1, '2024-02-29'],
    ['2026-03-31', 'month', -1, '2026-02-28'], ['2026-01-31', 'month', 3, '2026-04-30'], ['2025-12-31', 'month', 2, '2026-02-28'],
    ['2024-02-29', 'year', 4, '2028-02-29'], ['2024-02-29', 'year', -1, '2023-02-28'], ['2026-10-31', 'month', 12, '2027-10-31'],
    ['2026-01-01', 'day', -1, '2025-12-31'], ['2026-12-31', 'day', 1, '2027-01-01'], ['2026-10-07', 'week', 2, '2026-10-21'], ['2026-10-07', 'week', -1, '2026-09-30'],
    ['2026-10-07', 'event', 5, '2026-10-07'], ['2026-10-07', 'beat', 1, '2026-10-07'], ['2026-10-07', 'day', 0, '2026-10-07'],
  ];
  for (const [d, step, k, want] of cases) { assert.equal(K.addStep(d, step, k), want, `${d} + ${k} ${step}`); assert.equal(DF.addStep(d, step, k), want); }
  assert.equal(K.addStep('2026-01-31', 'month'), '2026-02-28', 'k defaults to 1'); assert.equal(DF.addStep('2026-01-31', 'month'), '2026-02-28');
  assert.equal(K.addStep('2026-02-30', 'day', 1), null); assert.equal(K.addStep('2026-01-31', 'day', 1.5), '2026-01-31');
  assert.equal(K.daysInMonth(2024, 2), 29); assert.equal(K.daysInMonth(1900, 2), 28); assert.equal(K.daysInMonth(2000, 2), 29); assert.equal(K.daysInMonth(2026, 11), 30);
});

test('floorToStep: Monday weeks, first of month, January 1st; event and beat leave the date', () => {
  const cases = [['2026-10-07', 'week', '2026-10-05'], ['2026-10-05', 'week', '2026-10-05'], ['2026-10-04', 'week', '2026-09-28'], ['1970-01-01', 'week', '1969-12-29'],
    ['2026-10-07', 'month', '2026-10-01'], ['2026-10-07', 'year', '2026-01-01'], ['2026-10-07', 'day', '2026-10-07'], ['2026-10-07', 'event', '2026-10-07'], ['2026-10-07', 'beat', '2026-10-07']];
  for (const [d, step, want] of cases) { assert.equal(K.floorToStep(d, step), want, `${d} ${step}`); assert.equal(DF.floorToStep(d, step), want); }
  assert.equal(K.floorToStep('nope', 'week'), null); assert.equal(DF.floorToStep(null, 'month'), null);
});

test('the mirror deep-equals lib/time on every example scene (as shipped, with a date block, with an order block), both fixtures and the three synthetic scenes', () => {
  const all = corpus();
  assert.ok(EXAMPLES.length >= 4, `examples discovered: ${EXAMPLES.join(', ')}`);
  let compared = 0;
  for (const [name, scene] of all) {
    const time = P.timeOf(scene);
    assert.deepEqual(DF.timeOf(scene), time, `${name}: timeOf`);
    assert.deepEqual(DF.ticks(scene), P.ticks(scene), `${name}: ticks`);
    const idx = P.timeIndex(scene); const didx = DF.timeIndex(scene);
    assert.deepEqual(didx, idx, `${name}: timeIndex`); assert.deepEqual(DF.enteringOrders(scene), P.enteringOrders(scene), `${name}: enteringOrders`);
    for (const n of scene.nodes) assert.deepEqual(DF.bornAt(n, time, didx.adjacency), P.bornAt(n, time, idx.adjacency), `${name}: bornAt ${n.id}`);
    for (const e of scene.edges || []) assert.deepEqual(DF.edgeAt(e, didx.nodesById, time), P.edgeAt(e, idx.nodesById, time), `${name}: edgeAt ${e.id}`);
    for (const t of probes(scene)) {
      assert.deepEqual(DF.visibleAt(scene, t), P.visibleAt(scene, t), `${name}: visibleAt(${JSON.stringify(t)})`);
      assert.equal(DF.stepIndexOf(scene, t), P.stepIndexOf(scene, t), `${name}: stepIndexOf(${JSON.stringify(t)})`);
      compared += 1;
    }
  }
  for (const at of [0, 3, '2026-02-14', null, undefined, { at: 5 }, { at: '2026-02-14' }, {}]) {
    for (const t of [0, 2, 3, 4, 10, '2026-02-10', '2026-02-14', '2026-02-20', 'bad', null]) {
      for (const len of [1, 7, 30, 0, -2, undefined]) assert.equal(DF.phaseOf(at, t, len), P.phaseOf(at, t, len), `phaseOf(${JSON.stringify(at)}, ${JSON.stringify(t)}, ${len})`);
    }
  }
  assert.ok(compared >= 100, `${compared} (scene, t) pairs compared across ${all.length} scenes`);
});

test('timeOf: null without a block; defaults from the dated points (edges included), playhead null -> to, cumulative true, motion still, trace filled', () => {
  assert.equal(P.timeOf(example(EXAMPLES[0])), null); assert.equal(P.timeOf({}), null); assert.equal(P.timeOf(null), null);
  assert.equal(P.timeOf(withTime(dateCumulative(), { axis: 'sideways' })), null, 'an axis the schema refuses is no time block');
  const s = dateCumulative(); delete s.views.time.from; delete s.views.time.to;
  const t = P.timeOf(s);
  assert.deepEqual(t, { axis: 'date', field: 'happened_on', step: 'week', from: '2026-01-05', to: '2026-03-01', playhead: '2026-03-01', cumulative: true, motion: 'trace', trace: { trail: 0.5, beads: 3, duration_ms: 4000 } });
  const o = P.timeOf(orderAxis());
  assert.deepEqual(o, { axis: 'order', field: 'happened_on', step: 'beat', from: 0, to: 9, playhead: 4, cumulative: true, motion: 'still', trace: { trail: 0.25, beads: 3, duration_ms: 4000 } });
  const oo = orderAxis(); oo.views.time = { axis: 'order' };
  assert.deepEqual([P.timeOf(oo).from, P.timeOf(oo).to, P.timeOf(oo).playhead, P.timeOf(oo).step], [0, 7, 7, 'beat'], 'order defaults span births and the last beat');
  const seq = P.timeOf(sequence()); assert.deepEqual([seq.from, seq.to, seq.playhead], [0, 3, 3], 'the self message at beat 3 is inside the window');
  const off = withTime(dateCumulative(), { axis: 'date', step: 'beat', from: 3, to: '2026-02-01', playhead: -1 });
  assert.deepEqual([P.timeOf(off).step, P.timeOf(off).from, P.timeOf(off).to, P.timeOf(off).playhead], ['event', '2026-01-05', '2026-02-01', '2026-02-01'], 'values off the axis fall back to defaults (the gate blocks them)');
});

test('bornAt and edgeAt: field with captured_on fallback, missing dates, order axis births at 0 / initial / smallest entering order, equal orders', () => {
  const s = dateCumulative(); const time = P.timeOf(s); const idx = P.timeIndex(s);
  const by = (id) => idx.nodesById.get(id);
  assert.equal(P.bornAt(by('a'), time, idx.adjacency), '2026-01-05', 'the named field'); assert.equal(P.bornAt(by('b'), time, idx.adjacency), '2026-01-31', 'captured_on fallback');
  assert.equal(P.bornAt(by('x'), time, idx.adjacency), '2026-02-10', 'a malformed field value falls back to captured_on');
  assert.equal(P.bornAt({ id: 'bare', kind: 'note' }, time, idx.adjacency), null, 'no provenance: undated'); assert.equal(P.bornAt(by('a'), null, idx.adjacency), null);
  assert.equal(P.edgeAt(s.edges[0], idx.nodesById, time), '2026-01-31', 'later endpoint'); assert.equal(P.edgeAt(s.edges[1], idx.nodesById, time), '2026-02-14', 'authored at wins');
  assert.equal(P.edgeAt(s.edges[3], idx.nodesById, time), '2026-01-05', 'a dangling end: the dated end'); assert.equal(P.edgeAt({ from: 'ghost', to: 'ghost2' }, idx.nodesById, time), null);
  const o = orderAxis(); const ot = P.timeOf(o); const oi = P.timeIndex(o);
  assert.deepEqual([...oi.adjacency], [['mid', 1], ['alt', 1], ['end', 2], ['late', 7]], 'smallest entering order; an undirected edge enters both ends');
  assert.deepEqual(o.nodes.map((n) => P.bornAt(n, ot, oi.adjacency)), [0, 1, 1, 2, 0], 'src: nothing enters; late: tagged initial despite f5');
  assert.deepEqual(o.edges.map((e) => P.edgeAt(e, oi.nodesById, ot)), [1, 1, 4, 2, 7, null], 'edge time = order; an unordered edge is undated');
  assert.deepEqual([...P.enteringOrders(sequence())], [], 'sequence participants are lifelines: nothing is entered');
  assert.deepEqual(sequence().nodes.map((n) => P.bornAt(n, P.timeOf(sequence()), P.enteringOrders(sequence()))), [0, 0, 0]);
  assert.deepEqual(lifecycle().nodes.map((n) => P.bornAt(n, P.timeOf(lifecycle()), P.enteringOrders(lifecycle()))), [0, 1, 2], 'the initial state is born at 0 despite the back edge t3');
});

test('ticks: aligned calendar stops between from and to, every dated point on event/beat, and both bounds; empty without time or dated points', () => {
  assert.deepEqual(P.ticks(dateCumulative()).slice(0, 3), ['2026-01-01', '2026-01-05', '2026-01-12'], 'from, then Mondays');
  const w = P.ticks(dateCumulative()); assert.equal(w[w.length - 1], '2026-03-15'); assert.equal(w.length, 12); assert.deepEqual([...w].sort(), w);
  assert.deepEqual(P.ticks(dateWindow()), ['2026-01-05', '2026-02-01', '2026-03-01']);
  const ev = withTime(dateCumulative(), { axis: 'date', step: 'event' });
  assert.deepEqual(P.ticks(ev), ['2026-01-05', '2026-01-31', '2026-02-02', '2026-02-10', '2026-02-14', '2026-03-01'], 'event: births (captured_on fallbacks for u and x included) and edge times');
  assert.deepEqual(P.ticks(orderAxis()), [0, 1, 2, 4, 7, 9]); assert.deepEqual(P.ticks(sequence()), [0, 1, 2, 3]); assert.deepEqual(P.ticks(lifecycle()), [0, 1, 2, 3]);
  const one = withTime(dateCumulative(), { axis: 'date', from: '2026-02-01', to: '2026-02-01', step: 'day' }); assert.deepEqual(P.ticks(one), ['2026-02-01']);
  const yr = withTime(dateCumulative(), { axis: 'date', from: '2024-02-29', to: '2027-01-01', step: 'year' }); assert.deepEqual(P.ticks(yr), ['2024-02-29', '2025-01-01', '2026-01-01', '2027-01-01']);
  const mo = withTime(dateCumulative(), { axis: 'date', from: '2026-01-31', to: '2026-04-02', step: 'month' }); assert.deepEqual(P.ticks(mo), ['2026-01-31', '2026-02-01', '2026-03-01', '2026-04-01', '2026-04-02']);
  assert.deepEqual(P.ticks(example(EXAMPLES[0])), []); assert.deepEqual(P.ticks({ nodes: [{ id: 'n' }], views: { time: { axis: 'date' } } }), [], 'no dated points: no window');
  const inverted = withTime(dateCumulative(), { axis: 'date', from: '2026-03-01', to: '2026-01-01' }); assert.deepEqual(P.ticks(inverted), [], 'from > to (gate-blocked) yields no stops');
});

test('visibleAt on a cumulative date axis: births gate presence, undated nodes and edges never hide, fresh = born this step, phases tween over one step', () => {
  const s = dateCumulative();
  const v = P.visibleAt(s, '2026-02-01');
  assert.deepEqual([...v.present].sort(), ['a', 'b'], 'u (captured 02-02), x (fallback 02-10) and c (03-01) are unborn on 02-01');
  assert.deepEqual([...P.visibleAt(s, '2026-02-02').present].sort(), ['a', 'b', 'u'], 'u arrives on its captured_on');
  assert.deepEqual([...v.fresh], ['b'], 'b was born Saturday 01-31, in the Monday-based week that ends on Sunday 02-01');
  assert.deepEqual([...P.visibleAt(s, '2026-02-02').fresh], ['u'], 'Monday 02-02 starts a new week; only u (captured that day) is born in it so far');
  assert.deepEqual([...v.edgePhase], [['e1', 1], ['e2', 0], ['#2', 0], ['e4', 1]], 'e2 at 02-14 is more than a week away; the id-less third edge is keyed by index; e4 at 01-05 is drawn');
  assert.equal(P.visibleAt(s, '2026-02-10').edgePhase.get('e2'), 3 / 7, 'four days before 02-14 at a week step');
  const bare = { ...s, nodes: [...s.nodes, { id: 'bare', kind: 'note' }], edges: [...s.edges, { id: 'static', from: 'bare', to: 'ghost', kind: 'relates' }] };
  const vb = P.visibleAt(bare, '2026-01-01');
  assert.ok(vb.present.has('bare') && !vb.present.has('a'), 'an undated node is present before anyone else is born'); assert.equal(vb.edgePhase.get('static'), 1, 'an undated edge has phase 1');
  const end = P.visibleAt(s, null); assert.deepEqual([...end.present].sort(), ['a', 'b', 'c', 'u', 'x'].sort(), 'null t = the playhead = to'); assert.equal(end.edgePhase.get('e2'), 1);
  assert.equal(end.active, 'c', 'the target of the latest edge (the id-less cites, at c on 03-01)');
  assert.equal(P.visibleAt(s, K.dayIndex('2026-02-01')).present.size, v.present.size, 'a day index is accepted for t');
});

test('visibleAt on a windowed date axis shows one step at a time; phases outside the step are 0, undated edges stay 1', () => {
  const s = dateWindow();
  const feb = P.visibleAt(s, '2026-02-20');
  assert.deepEqual([...feb.present].sort(), ['u', 'x'], 'born in February'); assert.deepEqual([...feb.fresh].sort(), ['u', 'x']);
  assert.deepEqual([...feb.edgePhase], [['e1', 0], ['e2', 1], ['#2', 0], ['e4', 0]], 'only the edge dated in February is drawn');
  const jan = P.visibleAt(s, '2026-01-02'); assert.deepEqual([...jan.present].sort(), ['a', 'b'], 'the whole month is the window, even before b is born'); assert.ok(jan.edgePhase.get('e1') > 0 && jan.edgePhase.get('e1') < 1);
  assert.deepEqual(P.timeOf(s).playhead, '2026-02-20'); assert.equal(P.stepIndexOf(s, null), 1);
});

test('visibleAt on an order axis: equal orders are one beat, the active node is the latest transition target, then the initial state', () => {
  const o = orderAxis();
  const b0 = P.visibleAt(o, 0); assert.deepEqual([...b0.present], ['src', 'late']); assert.equal(b0.active, 'late', 'no edge yet: the present initial state');
  const b1 = P.visibleAt(o, 1); assert.deepEqual([...b1.present], ['src', 'mid', 'alt', 'late']); assert.deepEqual([...b1.fresh], ['mid', 'alt'], 'f1 and f2 share order 1: one beat');
  assert.deepEqual([...b1.edgePhase], [['f1', 1], ['f2', 1], ['f3', 0], ['f4', 0], ['f5', 0], ['f6', 1]]); assert.equal(b1.active, 'mid', 'first of the tied edges');
  const b3 = P.visibleAt(o, 3); assert.equal(b3.edgePhase.get('f3'), 0, 'one beat before order 4'); assert.equal(b3.active, 'end', 'f4 at beat 2 is the latest');
  const b4 = P.visibleAt(o, 4); assert.equal(b4.edgePhase.get('f3'), 1); assert.equal(b4.fresh.size, 0); assert.equal(P.visibleAt(o, null).active, 'end', 'playhead 4');
  const b9 = P.visibleAt(o, 9); assert.equal(b9.active, 'late'); assert.equal(b9.present.size, 5);
  const lc = lifecycle(); assert.deepEqual([0, 1, 2, 3].map((t) => P.visibleAt(lc, t).active), ['draft', 'review', 'done', 'draft']);
  const seq = P.visibleAt(sequence(), 0); assert.equal(seq.present.size, 3, 'all lifelines at beat 0'); assert.equal(seq.active, 'n-1');
  const none = P.visibleAt(example(EXAMPLES[0]), 3); assert.equal(none.present.size, example(EXAMPLES[0]).nodes.length); assert.equal(none.active, null); assert.ok([...none.edgePhase.values()].every((p) => p === 1));
  assert.deepEqual(P.visibleAt(null, 1), { present: new Set(), fresh: new Set(), edgePhase: new Map(), active: null }, 'never throws');
});

test('phaseOf and stepIndexOf: the clamp formula; the index of the last tick <= t', () => {
  assert.equal(P.phaseOf({ at: 5 }, 5, 1), 1); assert.equal(P.phaseOf({ at: 5 }, 4, 1), 0); assert.equal(P.phaseOf({ at: 5 }, 4.5, 1), 1, 'a non-integer t is not a point: undated -> 1');
  assert.equal(P.phaseOf({ at: '2026-01-10' }, '2026-01-05', 7), 2 / 7); assert.equal(P.phaseOf('2026-01-10', '2026-01-03', 7), 0); assert.equal(P.phaseOf(10, 100, 7), 1);
  assert.equal(P.phaseOf({}, 3, 1), 1); assert.equal(P.phaseOf({ at: 3 }, 3, 0), 1); assert.equal(P.phaseOf({ at: 3 }, 2, -4), 0, 'a bad stepLen means one step');
  const s = dateCumulative();
  assert.equal(P.stepIndexOf(s, '2026-01-01'), 0); assert.equal(P.stepIndexOf(s, '2026-01-04'), 0); assert.equal(P.stepIndexOf(s, '2026-01-05'), 1); assert.equal(P.stepIndexOf(s, '2025-12-31'), -1);
  assert.equal(P.stepIndexOf(s, null), P.ticks(s).length - 1, 'the playhead (to) is the last stop'); assert.equal(P.stepIndexOf(s, '2027-01-01'), P.ticks(s).length - 1);
  assert.equal(P.stepIndexOf(orderAxis(), 3), 2); assert.equal(P.stepIndexOf(orderAxis(), 'bad'), -1); assert.equal(P.stepIndexOf(example(EXAMPLES[0]), 0), -1);
});

test('time.js is a classic-script fragment: header, DF-only surface, no fetch, storage, clock, randomness, keyframes or looping motion, under 400 lines', () => {
  assert.match(MIRROR.split('\n')[0], /^\/\/ renderers\/viewer\/time\.js — browser fragment/);
  assert.doesNotThrow(() => new Script(MIRROR));
  assert.doesNotMatch(MIRROR, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket|import\s|export\s|require\s*\(/);
  assert.doesNotMatch(MIRROR, /@keyframes|infinite|requestAnimationFrame|setInterval|setTimeout|Date\.now|new Date|Math\.random|document\.|window\./);
  assert.ok(lineCount(MIRROR) < 400); assert.ok(lineCount(read('lib/time/ticks.mjs')) <= 120); assert.ok(lineCount(read('lib/time/playhead.mjs')) <= 220);
  for (const fn of ['DF.timeOf', 'DF.bornAt', 'DF.edgeAt', 'DF.ticks', 'DF.visibleAt', 'DF.phaseOf', 'DF.stepIndexOf']) assert.match(MIRROR, new RegExp(`${fn.replace('.', '[.]')} = function`), fn);
});
