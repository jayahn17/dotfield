// The shipped examples (V2_PLAN §2.1 and §3): every committed
// examples/scene-<name>.json is exactly what test/fixtures/ir/examples.mjs
// generates, validates against dotfield.scene/1, is laid_out with a complete
// positions table, a written views.2d.viewBox and the views.2d.plan its mode
// writes, complete routes for its mode (dense in routed modes), a label
// budget that measures every node, an id on every edge, synthetic data only,
// a stamp that verifies under EXAMPLE_SESSION_KEY, and is clean at showcase
// through every gate in process (the IR gates and the 2D render gate). The
// routed scenes are cold-run outputs of lib/layout, so the browser and the
// goldens never re-simulate. scene-meet.example.json is projector input laid
// out at gate time, so the scene-<name>.json pattern leaves it out (as the
// golden test does). node:test, zero network, no disk writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/scan.mjs';
import { validateAgainst } from '../lib/validate.mjs';
import { verifyStamp } from '../lib/gates/privacy.mjs';
import { createContext } from '../lib/context.mjs';
import { IR_ORDER, renderScene, runGates } from '../lib/pipeline.mjs';
import { ROUTED_MODES, layoutTables, mode2dOf, positionsComplete, routableEdgeIds, routesComplete } from '../lib/layout/index.mjs';
import { labelBudgetOf } from '../lib/layout/metrics.mjs';
import { timeOf, visibleAt } from '../lib/time/playhead.mjs';
import { renderSvg } from '../renderers/svg.mjs';
import { EXAMPLE_SESSION_KEY, TOKENS_CSS, examples } from './fixtures/ir/examples.mjs';

const FILES = readdirSync(join(ROOT, 'examples')).filter((f) => /^scene-[a-z0-9-]+\.json$/.test(f)).sort();
const SCENES = FILES.map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(ROOT, 'examples', f), 'utf8'))]);
const BUILT = examples();
const blocking = (checks) => checks.filter((c) => c.status === 'fail' && c.blocking).map((c) => `${c.code} ${c.path ?? ''} ${c.message ?? ''}`);
const ctx = createContext({ cwd: ROOT, env: { SOURCE_DATE_EPOCH: '1760000000' } });
const IR_CTX = { quality: 'showcase', tokensCss: TOKENS_CSS, sessionKey: EXAMPLE_SESSION_KEY, requireProjected: true, config: ctx.config, viewer: 'self' };

test('the seven examples on disk are the generator output, one file per generated scene', () => {
  assert.deepEqual(FILES.map((f) => f.slice(0, -5)), Object.keys(BUILT).sort());
  assert.deepEqual(FILES.map((f) => f.slice(0, -5)), ['scene-architecture', 'scene-graph', 'scene-lifecycle', 'scene-room', 'scene-sequence', 'scene-timeline', 'scene-workflow']);
  for (const [name, s] of SCENES) assert.deepEqual(s, BUILT[name], `${name}.json equals examples.mjs (run: node test/fixtures/ir/build-fixtures.mjs)`);
  assert.deepEqual(SCENES.map(([, s]) => s.kind).sort(), ['graph', 'lifecycle', 'room', 'sequence', 'timeline', 'workflow', 'workflow']);
});

test('every example validates, is laid_out with a written viewBox and the plan of its mode, routes complete, every label measured, every edge named', () => {
  for (const [name, s] of SCENES) {
    const v = validateAgainst('scene', s);
    assert.ok(v.ok, `${name}: ${JSON.stringify(v.errors ?? v)}`);
    assert.equal(s.laid_out, true, `${name} laid_out`);
    assert.ok(positionsComplete(s), `${name}: every node has a position`);
    const vb = s.views['2d'].viewBox;
    assert.ok(Array.isArray(vb) && vb.length === 4 && vb[2] > 0 && vb[3] > 0, `${name}: a written viewBox`);
    assert.equal(s.views['2d'].plan?.mode, mode2dOf(s), `${name}: plan.mode is the 2D mode`);
    assert.ok(routesComplete(s), `${name}: routes complete for ${mode2dOf(s)}`);
    assert.ok(labelBudgetOf(s, s.nodes.length) >= s.nodes.length, `${name}: label budget covers every node`);
    for (const [i, e] of s.edges.entries()) assert.ok(typeof e.id === 'string' && e.id.length > 0, `${name}: edges[${i}] has an id`);
    assert.equal(s.meta.privacy_mode, 'synthetic_data', `${name}: synthetic data only`);
    for (const id of Object.keys(s.labels ?? {})) assert.ok(s.nodes.some((n) => n.id === id), `${name}: labels.${id} names a node`);
  }
});

test('every example carries a projected stamp that verifies under the fixture key and no other', () => {
  for (const [name, s] of SCENES) {
    assert.ok(s.projected && s.receipt, `${name}: projected + receipt`);
    assert.ok(verifyStamp(s, EXAMPLE_SESSION_KEY), `${name}: the committed stamp verifies`);
    assert.ok(!verifyStamp(s, 'another key'), `${name}: another key does not verify`);
    const edited = JSON.parse(JSON.stringify(s)); edited.nodes[0].label = `${edited.nodes[0].label} (edited)`;
    assert.ok(!verifyStamp(edited, EXAMPLE_SESSION_KEY), `${name}: an edit breaks the stamp`);
  }
});

test('the routed examples are cold-run outputs: dense routes for every edge, positions, routes, labels and plan reproduced by lib/layout', () => {
  const routed = SCENES.filter(([, s]) => ROUTED_MODES.includes(mode2dOf(s)));
  assert.deepEqual(routed.map(([n]) => n), ['scene-architecture', 'scene-lifecycle', 'scene-sequence']);
  for (const [name, s] of routed) {
    const { routable } = routableEdgeIds(s);
    assert.deepEqual(routable, s.edges.map((e) => e.id), `${name}: every edge is routable`);
    assert.deepEqual(Object.keys(s.routes).sort(), s.edges.map((e) => e.id).sort(), `${name}: dense routes, chord and loop included`);
    const cold = layoutTables(s, { force: true, tokensCss: TOKENS_CSS });
    assert.deepEqual(cold, { positions: s.positions, routes: s.routes, labels: s.labels ?? {}, plan: s.views['2d'].plan }, `${name}: committed tables are the cold run`);
  }
  const by = Object.fromEntries(SCENES);
  assert.deepEqual(by['scene-sequence'].views['2d'].plan, { mode: 'sequence', beats: 5 }, 'six messages on five beats: m2 and m3 share one');
  assert.ok(by['scene-sequence'].edges.some((e) => e.from === e.to), 'a self message');
  const lc = by['scene-lifecycle'];
  assert.deepEqual(lc.nodes.filter((n) => n.tags.includes('initial')).map((n) => n.id), ['draft']);
  assert.deepEqual(lc.nodes.filter((n) => n.tags.includes('final')).map((n) => n.id), ['archived']);
  assert.ok(lc.nodes.every((n) => n.shape === 'pill') && lc.edges.length === 7 && lc.edges.some((e) => e.from === e.to));
  assert.equal(lc.views['2d'].direction, 'right'); assert.deepEqual([lc.views.time.axis, lc.views.time.motion], ['order', 'playback']);
  const arch = by['scene-architecture'];
  assert.equal(arch.nodes.length, 12); assert.equal(arch.groups.length, 3); assert.ok(arch.groups.every((g) => g.kind === 'zone'));
  assert.deepEqual([arch.views['2d'].layout, arch.views['2d'].direction], ['layered', 'down']);
  assert.ok(arch.edges.every((e) => e.route === 'orthogonal'));
  assert.equal(arch.edges.filter((e) => e.from_side || e.to_side).length, 2, 'two authored port hints');
});

test('the time blocks: graph on a dated week axis with two steps, workflow traced on its order, sequence and lifecycle on beats', () => {
  const by = Object.fromEntries(SCENES);
  const g = by['scene-graph'];
  assert.deepEqual(g.views.time, { axis: 'date', field: 'happened_on', from: '2026-06-01', to: '2026-10-01', step: 'week', playhead: null, cumulative: true, motion: 'still' });
  assert.deepEqual(g.views.interactive.steps.map((s) => s.id), ['s1', 's2']);
  assert.ok(g.views.interactive.presentation.length > 0, 'presentation[] is kept beside steps[]');
  assert.deepEqual(by['scene-workflow'].views.time, { axis: 'order', step: 'beat', playhead: null, motion: 'trace', trace: { beads: 3 } });
  assert.equal(timeOf(by['scene-architecture']), null, 'the architecture has no time block');
  for (const name of ['scene-workflow', 'scene-sequence', 'scene-lifecycle']) {
    const s = by[name]; const svg = renderSvg(s, TOKENS_CSS); const v = visibleAt(s, timeOf(s).playhead);
    for (const e of s.edges) assert.match(svg, new RegExp(`data-edge-id="${e.id}"[^>]*><path [^>]*data-phase="${v.edgePhase.get(e.id)}"`), `${name}/${e.id} carries data-phase`);
    assert.equal((svg.match(/<g class="df-badge"/g) || []).length, s.edges.length, `${name}: a numbered badge per ordered edge`);
  }
});

test('every example is clean at showcase in process: the IR gates and the 2D render gate raise no blocking finding', () => {
  for (const [name, s] of SCENES) {
    const ir = runGates(s, IR_CTX, IR_ORDER);
    assert.equal(ir.blocked, false, `${name}: ${blocking(ir.checks).join(' | ')}`);
    assert.equal(ir.scene, s, `${name}: the layout gate never re-simulates a committed example`);
    assert.deepEqual(blocking(ir.checks), [], name);
    const out = renderScene(s, ctx, { quality: 'showcase', views: ['2d'] });
    assert.deepEqual(blocking(out.checks), [], `${name}: render gate at showcase`);
    assert.ok(out.checks.some((c) => c.code === 'DF_RENDER_MOTION_WITHOUT_STILL' && c.status === 'pass'), `${name}: the still check ran`);
  }
});
