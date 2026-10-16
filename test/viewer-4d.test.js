// The 4D viewer (V2_PLAN §11 viewer-4d): time.js mounted with the time bar,
// the guide and a finite tween. The browser fragments are evaluated here with
// a DF stub (new Function, as test/time.test.js does) and a stub clock, so the
// hash round-trip, the playback patches and DF.animate run in Node; a frame at
// any stop deep-equals lib/time visibleAt, the dash window mirrors
// svg-edges.mjs, and rendered pages stay standalone and loop-free. The SVG is
// untouched (svg-golden owns it). Temp dirs only, zero network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, read, exists, lineCount } from './helpers/scan.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { EPOCH_ENV } from './helpers/center.mjs';
import { sequence, lifecycle } from './fixtures/ir/build-fixtures.mjs';
import { renderHtml, renderHtmlDetailed, viewerBundle, scriptJson, stepsOf, timebarHtml, rendererSpecifiers, rewriteRendererImports, VIEWER_FILES, RENDERER_SPECIFIERS, RENDERER_FILE_RE } from '../renderers/html.mjs';
import { renderSvg } from '../renderers/svg.mjs';
import { dashWindow } from '../renderers/svg-edges.mjs';
import { TIME_CSS } from '../renderers/viewer/style-4d.js';
import * as P from '../lib/time/playhead.mjs';
import { dayIndex, fromDayIndex } from '../lib/time/ticks.mjs';
import * as gate from '../lib/gates/render.mjs';
import { fourdProbe, viewerProbe } from '../lib/bench/probes.mjs';
import { createContext } from '../lib/context.mjs';
import { IR_ORDER, gateContext, loadScene, renderScene, runGates } from '../lib/pipeline.mjs';

const TOKENS = read('renderers/tokens.css');
const EXAMPLES = readdirSync(join(ROOT, 'examples')).filter((f) => /^scene-[a-z0-9-]+\.json$/.test(f)).sort();
const example = (f) => JSON.parse(read(`examples/${f}`));
const clone = (v) => JSON.parse(JSON.stringify(v));
const withTime = (s, time) => ({ ...clone(s), views: { ...(s.views || {}), time } });
const ORDER_TRACE = { axis: 'order', step: 'beat', playhead: null, motion: 'trace', trace: { beads: 3 } };
const timed = (s) => P.timeOf(s) !== null && P.ticks(s).length > 0;
/** scene-workflow as committed, with the order/trace block examples-recipes gives it when the committed copy has none. */
const workflow = () => { const s = example('scene-workflow.json'); return timed(s) ? s : withTime(s, ORDER_TRACE); };
/** A lifecycle scene: the committed example when present, else the ir-v2 fixture. */
const lifecycleScene = () => (exists('examples/scene-lifecycle.json') ? example('scene-lifecycle.json') : lifecycle());
const FRAGMENTS = ['state.js', 'time.js', 'lens.js', 'motion-2d.js', 'timebar.js', 'steps.js', 'keys.js'];
/** An import line built from tokens, so the no-son-imports scan (which reads test sources) never sees a literal one here. */
const imp = (what, from) => `${['import', what, what ? 'from' : '', `'${from}'`].filter(Boolean).join(' ')};\n`;

/** The fragments over a DF stub, booted as shell.js boots them up to the defaults (no DOM is touched). */
function viewer(scene, config = {}) {
  const DF = {};
  for (const f of FRAGMENTS) new Function('DF', read(`renderers/viewer/${f}`))(DF);
  DF.scene = scene;
  DF.config = { views: ['2d'], themes: ['default', 'paper'], theme: 'default', deep_link: true, steps: stepsOf(scene).steps, ...config };
  DF.buildIndex(); DF.TB = DF.timeModel(); DF.STEPS = DF.stepList(); DF.defaults = DF.defaultState(); DF.state = DF.defaults;
  return DF;
}
/** setState without a DOM: the patch is sanitised exactly as the browser does, and recorded. */
function recording(DF) {
  const patches = [];
  DF.setState = (patch) => { patches.push(patch); DF.state = DF.sanitize({ ...DF.state, ...patch }); return DF.state; };
  return patches;
}
/** A stub clock for DF.env: rAF queue, listeners, reduced/hidden switches. */
function stubEnv(DF, { reduced = false } = {}) {
  const env = { queue: [], listeners: [], reduced, hidden: false, ts: 0 };
  DF.env = {
    raf: (fn) => { env.queue.push(fn); return env.queue.length; },
    caf: (id) => { env.queue[id - 1] = null; },
    reduced: () => env.reduced, hidden: () => env.hidden, doc: () => 'doc',
    listen: (target, type, fn) => { const row = { target, type, fn }; env.listeners.push(row); return () => { env.listeners = env.listeners.filter((r) => r !== row); }; },
  };
  env.run = (dt = 16, max = 100000) => { let n = 0; while (env.queue.some(Boolean) && n < max) { const i = env.queue.findIndex(Boolean); const fn = env.queue[i]; env.queue[i] = null; env.ts += dt; fn(env.ts); n += 1; } return n; };
  env.fire = (type) => { for (const r of env.listeners.filter((x) => x.type === type)) r.fn(); };
  return env;
}

test('time.js and the 4D fragments mount before shell.js inside the one IIFE; one key table; nothing under renderers/ loops', () => {
  for (const f of ['time.js', 'motion-2d.js', 'timebar.js', 'steps.js']) {
    assert.ok(VIEWER_FILES.includes(f), `${f} is mounted`);
    assert.ok(VIEWER_FILES.indexOf(f) < VIEWER_FILES.indexOf('shell.js'), `${f} before shell.js`);
  }
  assert.equal(VIEWER_FILES[0], 'state.js');
  assert.ok(VIEWER_FILES.indexOf('time.js') < VIEWER_FILES.indexOf('timebar.js'));
  const bundle = viewerBundle();
  assert.doesNotThrow(() => new Script(bundle));
  assert.equal((bundle.match(/DF\.HELP\s*=/g) || []).length, 1, 'one DF.HELP table');
  assert.doesNotMatch(bundle, /@keyframes|animation\s*:|setInterval|repeatCount|\bfetch\s*\(|localStorage|sessionStorage|Date\.now|Math\.random/);
  for (const f of ['motion-2d.js', 'timebar.js', 'steps.js']) assert.doesNotMatch(read(`renderers/viewer/${f}`), /setTimeout|setInterval|performance\.now/, `${f}: rAF and the frame clock only`);
  for (const k of ['.', ',', '[', ']', 'p', 'g', 'n', 'b', 't']) assert.ok(bundle.includes(`case '${k}':`), `key ${k}`);
  const DF = viewer(workflow());
  assert.deepEqual(DF.KEYS.slice(-3), ['t', 'step', 'live']);
  const keys = DF.HELP.map(([k]) => k).join(' ');
  for (const k of ['. / ,', '[ / ]', 'P', 'G', 'N / B', 'T']) assert.ok(keys.includes(k), `help row ${k}`);
  const files = []; const walk = (d) => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) (e.isDirectory() ? walk(`${d}/${e.name}`) : files.push(`${d}/${e.name}`)); };
  walk('renderers');
  for (const f of files.filter((x) => /\.(m?js|css|json)$/.test(x))) assert.doesNotMatch(read(f), /infinite/, `${f} never names an endless loop`);
  for (const f of ['motion-2d.js', 'timebar.js', 'steps.js', 'style-4d.js']) assert.ok(lineCount(read(`renderers/viewer/${f}`)) < 400, f);
  const html = renderHtml(workflow(), { tokensCss: TOKENS });
  assert.equal(fourdProbe({ root: ROOT, html }).playhead_in_hash, true, 'the benchmark sees t in DF.KEYS');
  assert.equal(viewerProbe(html).key_table_present, true);
});

test('the time bar is written only when views.time has scrub stops; the guide only with steps; the inline SVG is renderSvg unchanged', () => {
  const corpus = EXAMPLES.map((f) => [f, example(f)]);
  const room = example('scene-room.json');
  corpus.push(['workflow without time', { ...clone(workflow()), views: { ...workflow().views, time: undefined } }], ['room with time', withTime(room, ORDER_TRACE)], ['no dated point', withTime(room, { axis: 'date' })]);
  let withBar = 0; let without = 0;
  for (const [name, s] of corpus) {
    const html = renderHtml(s, { tokensCss: TOKENS });
    const want = timed(s);
    assert.equal(/<div class="df-timebar" data-df="timebar"/.test(html), want, `${name}: time bar iff views.time has stops`);
    assert.equal(html.includes(TIME_CSS), want || stepsOf(s).steps.length > 0, `${name}: 4D styles only with a bar or a guide`);
    assert.equal(/<aside class="df-steps" data-df="steps"/.test(html), stepsOf(s).steps.length > 0, `${name}: guide iff steps`);
    assert.equal(/<button [^>]*data-df="guide"/.test(html), stepsOf(s).steps.length > 0, `${name}: guide button iff steps`);
    const theme = s.meta && s.meta.theme ? s.meta.theme : 'default';
    assert.ok(html.includes(renderSvg(s, TOKENS, { xmlns: false, theme })), `${name}: the SVG is the still svg.mjs writes`);
    if (want) withBar += 1; else without += 1;
  }
  assert.ok(withBar >= 2 && without >= 2, `both cases are exercised (${withBar} with, ${without} without)`);
  const g = example('scene-graph.json');
  const gs = timed(g) ? g : withTime(g, { axis: 'date', field: 'happened_on', from: '2026-06-01', to: '2026-10-01', step: 'week' });
  const bar = timebarHtml(gs); const time = P.timeOf(gs); const stops = P.ticks(gs);
  assert.match(bar, new RegExp(`min="${dayIndex(stops[0])}" max="${dayIndex(stops.at(-1))}" step="1" value="${dayIndex(time.playhead)}"`));
  assert.match(bar, new RegExp(`data-df="t-now">${time.playhead}<`));
  for (const df of ['t-start', 't-prev', 't-play', 't-next', 't-end', 't-range', 't-ticks', 't-from', 't-to']) assert.ok(bar.includes(`data-df="${df}"`), df);
  assert.equal(timebarHtml({ kind: 'graph', nodes: [], edges: [] }), '');
});

test('hash round-trip: t, step and live serialise, restore on load, and fall back or clamp when invalid', () => {
  const life = lifecycleScene();
  const L = viewer(life);
  const M = L.TB;
  assert.ok(M && M.time.axis === 'order', 'the lifecycle scene has an order axis');
  assert.equal(L.serializeState(L.defaults), '', 'the defaults write nothing');
  const step = L.STEPS[1];
  const st = L.sanitize({ ...L.defaults, ...L.parseHash(`#t=${M.from + 1}&step=${step.id}&live=true&theme=paper`) });
  assert.deepEqual([st.t, st.step, st.live, st.theme], [M.from + 1, step.id, true, 'paper']);
  const hash = L.serializeState(st);
  for (const part of [`t=${M.from + 1}`, `step=${step.id}`, 'live=true', 'theme=paper']) assert.ok(hash.split('&').includes(part), `${part} in ${hash}`);
  assert.deepEqual(L.sanitize({ ...L.defaults, ...L.parseHash(`#${hash}`) }), st, 'what is written is what restores');
  const restore = (h) => L.sanitize({ ...L.defaults, ...L.parseHash(h) });
  assert.equal(restore(`#t=${M.to + 40}`).t, M.to, 'clamped into the window');
  for (const bad of ['#t=abc', '#t=-1', '#t=', '#t=1.5']) assert.equal(restore(bad).t, L.defaults.t, bad);
  assert.equal(restore('#step=nope').step, null);
  assert.equal(restore('#live=maybe').live, false);
  const g = example('scene-graph.json');
  const G = viewer(timed(g) ? g : withTime(g, { axis: 'date', from: '2026-06-01', to: '2026-10-01', step: 'week' }));
  const gTo = fromDayIndex(G.TB.to);
  assert.equal(G.sanitize({ ...G.defaults, ...G.parseHash('#t=2026-08-05') }).t, '2026-08-05');
  assert.equal(G.serializeState({ ...G.defaults, t: '2026-08-05' }), 't=2026-08-05');
  assert.equal(G.sanitize({ ...G.defaults, ...G.parseHash('#t=2027-01-01') }).t, gTo, 'a late date clamps to the end');
  for (const bad of ['#t=2026-13-40', '#t=20000', '#t=2026-02-30']) assert.equal(G.sanitize({ ...G.defaults, ...G.parseHash(bad) }).t, G.defaults.t, bad);
  const R = viewer(example('scene-room.json'));
  assert.equal(R.TB, null);
  assert.equal(R.sanitize({ ...R.defaults, ...R.parseHash('#t=3') }).t, null, 'no time block, no t');
  const bare = viewer({ ...clone(example('scene-room.json')), views: { '2d': { layout: 'metric' } } });
  assert.equal(bare.sanitize({ ...bare.defaults, live: 'true' }).live, false, 'nothing to play, never live');
});

test('DF.animate: one tick under reduced motion; otherwise a finite rAF chain that pauses while hidden and on pointerdown', () => {
  const DF = viewer(workflow());
  let env = stubEnv(DF, { reduced: true });
  const frames = []; let done = 0;
  const h = DF.animate({ duration: 4000, frame: (p) => frames.push(p), done: () => { done += 1; } });
  assert.deepEqual([frames, done, h.finished, h.running, env.queue.length], [[1], 1, true, false, 0], 'one synchronous frame at p = 1, no rAF');
  env = stubEnv(DF);
  const seen = []; let ended = 0;
  const h2 = DF.animate({ duration: 1000, ease: DF.ease.linear, frame: (p) => seen.push(p), done: () => { ended += 1; } });
  const ticks = env.run(16);
  assert.equal(ended, 1); assert.equal(seen.at(-1), 1); assert.ok(seen.every((p, i) => i === 0 || p >= seen[i - 1]), 'monotone');
  assert.ok(ticks <= Math.ceil(1000 / 16) + 2, `finite: ${ticks} frames`); assert.equal(env.queue.some(Boolean), false, 'nothing left scheduled');
  assert.equal(h2.running, false); assert.deepEqual(env.listeners, [], 'listeners removed at the end');
  env = stubEnv(DF);
  const h3 = DF.animate({ duration: 1000, ease: DF.ease.linear, frame: () => {} });
  for (let i = 0; i < 3; i += 1) { const fn = env.queue.find(Boolean); env.queue[env.queue.indexOf(fn)] = null; env.ts += 100; fn(env.ts); }
  const before = h3.elapsed;
  env.hidden = true; env.run(5000, 1);
  assert.deepEqual([h3.paused, h3.pausedBy, env.queue.some(Boolean)], [true, 'hidden', false], 'hidden: paused, no frame requested');
  env.hidden = false; env.fire('visibilitychange');
  assert.equal(h3.paused, false); env.ts += 60000; env.run(16);
  assert.equal(h3.finished, true); assert.ok(before >= 200 && before < 1000, 'progress kept across the hidden gap');
  env = stubEnv(DF);
  let paused = 0; let finished = 0;
  const target = { name: 'main' };
  const h4 = DF.animate({ duration: 1000, pauseOnPointer: target, frame: () => {}, onPause: () => { paused += 1; }, done: () => { finished += 1; } });
  env.run(16, 3);
  env.listeners.filter((r) => r.target === target && r.type === 'pointerdown').forEach((r) => r.fn());
  assert.deepEqual([h4.paused, h4.pausedBy, paused, env.queue.some(Boolean)], [true, 'pointer', 1, false]);
  h4.cancel(); assert.deepEqual([h4.running, finished], [false, 0], 'cancel never calls done');
  env = stubEnv(DF);
  assert.equal(DF.animate({ duration: 1e9, frame: () => {} }).duration, DF.MOTION_MAX_MS, 'capped duration');
  env = stubEnv(DF);
  let last = null; let stuck = 0;
  DF.animate({ duration: 1000, frame: (p) => { last = p; }, done: () => { stuck += 1; } });
  env.run(0);
  assert.deepEqual([stuck, last], [1, 1], 'a clock that never advances still ends at the frame budget');
  for (const hz of [360, 1000]) {
    env = stubEnv(DF); let before = 0; let at = 0;
    DF.animate({ duration: DF.MOTION_MAX_MS, ease: DF.ease.linear, frame: (p, h) => { if (p < 1) before = p; else at = h.elapsed; } });
    env.run(1000 / hz);
    assert.ok(before > 1 - 2000 / hz / DF.MOTION_MAX_MS && at === DF.MOTION_MAX_MS, `${hz} Hz: the clock ends the longest tween (last tween frame p=${before}), never the frame budget`);
  }
});

test('a scrubbed frame is the still: frameAt equals visibleAt at every stop, the dash window mirrors svg-edges, in-flight edges rewrite the SVG attributes', () => {
  const graph = example('scene-graph.json');
  const windowed = withTime(graph, { axis: 'date', field: 'captured_on', step: 'month', cumulative: false, motion: 'playback' });
  const corpus = [...EXAMPLES.map((f) => example(f)).filter(timed), withTime(example('scene-room.json'), ORDER_TRACE), windowed, withTime(graph, { axis: 'date', step: 'day' }), sequence(), lifecycle(), workflow()];
  let pairs = 0;
  for (const s of corpus) {
    const DF = viewer(s);
    for (const tick of DF.TB.ticks) {
      const f = DF.frameAt(DF.time.toNum(tick, DF.TB.time.axis)); const v = P.visibleAt(s, tick);
      assert.deepEqual([f.t, f.present, f.fresh, f.active, f.edgePhase], [tick, v.present, v.fresh, v.active, v.edgePhase], `${s.meta && s.meta.id} at ${tick}`);
      pairs += 1;
    }
  }
  assert.ok(pairs >= 20, `${pairs} (scene, stop) pairs`);
  const DF = viewer(workflow());
  for (const pattern of [null, [6, 4], [10, 6]]) for (const length of [0, 1, 37.5, 120, 999.99, 2000]) for (const phase of [null, undefined, -1, 0, 0.001, 0.25, 0.5, 0.999, 1, 2]) {
    assert.deepEqual(DF.dashWindow(pattern, length, phase), dashWindow(pattern, length, phase), `${pattern} ${length} ${phase}`);
  }
  assert.deepEqual(DF.traceWindow(0.5, 0.25), { dasharray: '25 200', dashoffset: '-25' });
  assert.deepEqual(DF.traceWindow(0.1, 0.25), { dasharray: '10 200', dashoffset: '0' });
  assert.deepEqual([DF.traceWindow(0, 0.25), DF.traceWindow(1, 0.25)], [null, null]);
  const g = example('scene-graph.json');
  const gs = timed(g) && P.timeOf(g).axis === 'date' ? g : withTime(g, { axis: 'date', from: '2026-06-01', to: '2026-10-01', step: 'week' });
  const G = viewer(gs);
  let day = null;
  for (let n = G.TB.from; n <= G.TB.to && day === null; n += 1) if ([...G.frameAt(n).edgePhase.values()].some((p) => p > 0 && p < 1)) day = n;
  assert.notEqual(day, null, 'some day has an edge in flight');
  const svg = renderSvg(gs, TOKENS, { playhead: fromDayIndex(day) });
  const frame = G.frameAt(day);
  let flying = 0;
  for (const m of svg.matchAll(/<g class="df-edge-group[^"]*"(?: data-edge-id="([^"]+)")?[^>]*><path ([^>]*)\/>/g)) {
    const at = (k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(` ${m[2]}`) || [])[1];
    const key = m[1]; const phase = frame.edgePhase.get(key);
    assert.equal(at('data-phase'), G.fmt(phase), `${key}: data-phase`);
    if (!(phase > 0 && phase < 1)) continue;
    flying += 1;
    const edge = gs.edges.find((e) => e.id === key);
    const w = G.dashWindow(G.patternOf(edge), G.polyLength(at('d')), phase);
    assert.equal(at('stroke-dashoffset'), w.dashoffset, `${key}: offset`);
    const mine = w.dasharray.split(' ').map(Number); const theirs = at('stroke-dasharray').split(' ').map(Number);
    assert.equal(mine.length, theirs.length, `${key}: dash entries`);
    mine.forEach((v, i) => assert.ok(Math.abs(v - theirs[i]) < 0.02, `${key}: dash ${i} ${v} vs ${theirs[i]}`));
  }
  assert.ok(flying >= 1, 'an in-flight edge was compared');
});

test('the guide: steps[] over presentation[] over a lifecycle default; dropped ids; a step moves focus and playhead; p, n, b, g, ., [ and ] patch the state', () => {
  const life = lifecycleScene();
  const bare = { ...clone(life), views: { ...life.views, interactive: { ...(life.views.interactive || {}), steps: undefined, presentation: undefined } } };
  const auto = stepsOf(bare);
  assert.equal(auto.source, 'lifecycle');
  const heads = auto.steps.map((s) => s.playhead);
  assert.deepEqual(heads, [...heads].sort((a, b) => a - b), 'lifecycle steps in playhead order');
  assert.equal(heads[0], P.timeOf(bare).from, 'the initial state opens at the start of the window');
  assert.ok(auto.steps.slice(1).every((s) => s.edges.length === 1), 'each later step names the transition that enters it');
  const pres = { ...clone(bare), views: { ...bare.views, interactive: { presentation: [bare.nodes[1].id, bare.nodes[0].id] } } };
  assert.deepEqual(stepsOf(pres).steps.map((s) => [s.id, s.nodes]), [['p1', [bare.nodes[1].id]], ['p2', [bare.nodes[0].id]]]);
  const authored = { ...clone(pres), views: { ...pres.views, interactive: { presentation: [bare.nodes[0].id], steps: [{ id: 's1', label: 'One', caption: 'why', nodes: [bare.nodes[2].id, 'ghost'], playhead: 2 }, { id: 's2', nodes: ['ghost'] }] } } };
  assert.equal(stepsOf(authored).source, 'steps');
  const A = viewer(authored);
  assert.deepEqual(A.STEPS.map((s) => [s.id, s.nodes, s.playhead, s.caption]), [['s1', [bare.nodes[2].id], 2, 'why']], 'ghost ids dropped, the empty step skipped');
  const patches = recording(A);
  A.goStep('s1');
  assert.deepEqual(patches.at(-1), { step: 's1', live: false, focus: bare.nodes[2].id, t: 2 });
  assert.deepEqual([A.state.step, A.state.focus, A.state.t], ['s1', bare.nodes[2].id, 2]);
  assert.equal(A.toggleGuide(), true); assert.equal(A.state.step, null, 'g closes an open guide');
  const L = viewer(bare); const lp = recording(L);
  assert.equal(L.nextStep(1), true); assert.equal(L.state.step, L.STEPS[0].id, 'n opens the first step');
  L.nextStep(1); assert.deepEqual([L.state.step, L.state.t], [L.STEPS[1].id, L.STEPS[1].playhead]);
  L.nextStep(-1); assert.equal(L.state.step, L.STEPS[0].id, 'b goes back');
  assert.equal(L.stepAtT(L.STEPS[1].playhead).id, L.STEPS[1].id);
  assert.equal(L.jumpTime('end'), true); assert.equal(L.state.t, L.TB.to);
  assert.equal(L.jumpTime('start'), true); assert.equal(L.state.t, L.TB.from);
  L.stepTime(1); assert.equal(L.state.t, L.TB.nums[1], '. is the next stop');
  L.stepTime(-1); L.stepTime(-1); assert.equal(L.state.t, L.TB.from, ', stops at the start');
  assert.equal(L.togglePlay(), true); assert.deepEqual(lp.at(-1), { live: true });
  const none = viewer({ ...clone(example('scene-room.json')), views: { '2d': { layout: 'metric' } } }); recording(none);
  for (const fn of [() => none.togglePlay(), () => none.stepTime(1), () => none.jumpTime('end'), () => none.nextStep(1), () => none.toggleGuide()]) assert.equal(fn(), false, 'a key with nothing to do is not swallowed');
});

test('render --view all of scene-workflow and the lifecycle: data-phase, the time bar and the guide, gate-clean and standalone', async () => {
  await withTmp(async (dir) => {
    const ctx = createContext({ cwd: dir, env: { ...process.env, ...EPOCH_ENV, DOTFIELD_ROOT: '' } });
    mkdirSync(join(dir, 'in'), { recursive: true });
    const inputs = [['scene-workflow', workflow()], ['lifecycle', lifecycleScene()]];
    if (!exists('examples/scene-lifecycle.json')) inputs.push(['lifecycle template', null]);
    for (const [name, scene] of inputs) {
      const file = scene ? join(dir, 'in', `${name}.json`) : join(ROOT, 'templates', 'lifecycle.sketch.json');
      if (scene) writeFileSync(file, JSON.stringify(scene));
      const loaded = await loadScene(file, ctx, { viewer: 'self' });
      assert.ok(loaded.ok, `${name}: loads`);
      const ir = runGates(loaded.scene, gateContext(ctx, { viewer: 'self', quality: 'showcase' }), IR_ORDER);
      assert.equal(ir.blocked, false, `${name}: IR gates`);
      const r = renderScene(ir.scene, ctx, { views: 'all', quality: 'showcase', embedThree: false, outputPath: join(dir, '.dotfield', 'renders', name, 'out.html') });
      const fails = r.checks.filter((c) => c.status === 'fail');
      assert.deepEqual(fails.filter((c) => c.blocking).map((c) => c.code), [], `${name}: no blocking render fail`);
      for (const code of ['DF_RENDER_EXTERNAL_REF', 'DF_RENDER_HEX_LITERAL', 'DF_RENDER_MOTION_INFINITE', 'DF_RENDER_MOTION_WITHOUT_STILL', 'DF_RENDER_SIZE_BUDGET']) assert.ok(!fails.some((c) => c.code === code), `${name}: ${code}`);
      const html = r.html;
      assert.match(html, /\sdata-phase="/, `${name}: data-phase`);
      assert.match(html, /<div class="df-timebar" data-df="timebar"[^>]*data-axis="order"/, `${name}: time bar`);
      assert.match(html, /<aside class="df-steps" data-df="steps"/, `${name}: guide`);
      assert.deepEqual(gate.externalRefs(html), [], `${name}: only the pinned importmap leaves the file`);
      assert.deepEqual(gate.motionLoops(html, r.svgStandalone), [], `${name}: no loop`);
      const data = /<script type="application\/json" id="dotfield-scene" data-df="scene">([\s\S]*?)<\/script>/.exec(html)[1];
      assert.equal(data, scriptJson(ir.scene), `${name}: the scene round-trips`);
      const cfg = JSON.parse(/<script type="application\/json" data-df="config">([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.deepEqual(cfg.steps, stepsOf(ir.scene).steps, `${name}: steps in the config`);
      assert.equal(new Set(cfg.steps.map((s) => s.id)).size, cfg.steps.length);
      for (const m of html.matchAll(/<g ([^>]*data-node-id="[^"]+"[^>]*)>/g)) assert.match(m[1], /tabindex="0"/);
    }
  });
});

test('renderer specifiers come from the files present on disk; a split renderer resolves its siblings through the importmap', async () => {
  assert.deepEqual(RENDERER_SPECIFIERS.slice(0, 2).map((r) => [r.specifier, r.file]), [['dotfield/three', 'three.mjs'], ['dotfield/xr', 'xr.mjs']]);
  for (const r of RENDERER_SPECIFIERS.slice(2)) { assert.match(r.file, RENDERER_FILE_RE); assert.ok(exists(`renderers/${r.file}`), r.file); }
  await withTmp(async (dir) => {
    const rend = join(dir, 'r'); mkdirSync(rend);
    for (const f of ['three.mjs', 'xr.mjs', 'three-labels.mjs', 'motion.mjs', 'svg.mjs', 'notes.txt', 'three_old.mjs']) writeFileSync(join(rend, f), f === 'three.mjs' ? `${imp('{ LabelAtlas }', './three-labels.mjs')}${imp('', './svg.mjs')}export function mount3d() { return LabelAtlas; }\n` : 'export const X = 1;\n');
    const specs = rendererSpecifiers(rend);
    assert.deepEqual(specs.map((r) => r.specifier), ['dotfield/three', 'dotfield/xr', 'dotfield/motion', 'dotfield/three-labels']);
    assert.deepEqual(rendererSpecifiers(join(dir, 'absent')).map((r) => r.file), ['three.mjs', 'xr.mjs'], 'the two the bootstrap imports are always listed');
    assert.equal(rewriteRendererImports(read('renderers/svg.mjs'), specs), read('renderers/svg.mjs'), 'a file without sibling imports is unchanged');
    const d = renderHtmlDetailed(workflow(), { views: 'all', tokensCss: TOKENS, rendererDir: rend, vendorDir: join(dir, 'vendor') });
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(d.html)[1]);
    for (const s of specs) assert.ok(map.imports[s.specifier].startsWith('data:text/javascript;base64,'), s.specifier);
    const three = Buffer.from(map.imports['dotfield/three'].split(',')[1], 'base64').toString('utf8');
    assert.ok(three.includes(imp('{ LabelAtlas }', 'dotfield/three-labels')), 'the sibling resolves through its specifier');
    assert.ok(three.includes(imp('', './svg.mjs')), 'only renderer siblings are rewritten');
    const missing = renderHtmlDetailed(workflow(), { views: 'all', tokensCss: TOKENS, rendererDir: join(dir, 'absent'), vendorDir: join(dir, 'vendor') });
    assert.deepEqual([missing.renderer.present, missing.renderer.missing], [false, ['three.mjs', 'xr.mjs']]);
  });
});
