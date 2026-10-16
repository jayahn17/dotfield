// The 3D/VR renderers against the REAL vendored three@0.180.0, headless:
// Node resolves the importmap's bare specifiers ('three', 'three/core', the
// two addons) to vendor/three/ through a module.register() hook, so the very
// bytes the browser gets are the bytes under test (no stub three, no second
// copy). WebGLRenderer is never constructed; buildScene is. The split modules
// (three-labels, three-edges, three-mount, motion) are pinned here: polyline
// edges against lib/layout liftPolyline, the time layer against lib/time
// visibleAt, snap turn and adaptive DPR against stubs. Tests that need
// vendor/three/ skip with a named reason when it is absent. Zero network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, read, imports } from './helpers/scan.mjs';
import { positions3d as layoutPositions3d, positionsVr, mode3dOf as layoutMode3d } from '../lib/layout/index.mjs';
import { frameOf as layoutFrameOf } from '../lib/layout/frame.mjs';
import { liftPolyline as layoutLift } from '../lib/layout/lift.mjs';
import { edgePolyline as layoutPolyline } from '../lib/layout/geometry.mjs';
import { visibleAt, ticks, timeOf } from '../lib/time/playhead.mjs';
import { dayIndex } from '../lib/time/ticks.mjs';
import { parseThemes, resolveToken } from '../lib/theme.mjs';
import { renderSvg } from '../renderers/svg.mjs';
import { renderHtmlDetailed, rendererSpecifiers, THREE_SPECIFIERS, RENDERER_SPECIFIERS, RENDERER_FILE_RE, CDN_BASE } from '../renderers/html.mjs';
import * as gate from '../lib/gates/render.mjs';

const VENDOR = join(ROOT, 'vendor');
const vendorFile = (spec) => join(VENDOR, 'three', THREE_SPECIFIERS.find((s) => s.specifier === spec).file);
const present = THREE_SPECIFIERS.every((s) => existsSync(vendorFile(s.specifier)));
const SKIP = present ? false : 'vendor/three/ is absent: run node scripts/fetch-vendor.mjs (network) and rerun';
const EXAMPLES = ['scene-graph', 'scene-room', 'scene-timeline', 'scene-workflow'];
const SHIPPED = readdirSync(join(ROOT, 'examples')).filter((f) => /^scene-[a-z0-9-]+\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
const SPLIT = ['three-labels.mjs', 'three-edges.mjs', 'three-mount.mjs', 'motion.mjs'];
const example = (name) => JSON.parse(read(`examples/${name}.json`));
const TOKENS_CSS = read('renderers/tokens.css');
const PARSED = parseThemes(TOKENS_CSS);
const tokensFor = (theme = 'default') => Object.fromEntries(Object.keys(PARSED.themes.default).filter((k) => k.startsWith('--df-')).map((k) => [k, resolveToken(PARSED, k, theme)]));
const near = (a, b, eps = 1e-5) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= eps);

let THREE = null; let T = null; let X = null; let E = null; let MO = null; let MT = null;
if (present) {
  const map = Object.fromEntries(THREE_SPECIFIERS.map((s) => [s.specifier, pathToFileURL(vendorFile(s.specifier)).href]));
  const hooks = 'let map = {};\nexport function initialize(d) { map = d.map; }\nexport async function resolve(spec, ctx, next) { return Object.hasOwn(map, spec) ? { url: map[spec], shortCircuit: true } : next(spec, ctx); }\n';
  register(`data:text/javascript;base64,${Buffer.from(hooks).toString('base64')}`, { parentURL: import.meta.url, data: { map } });
  THREE = await import(map.three);
  const load = (f) => import(pathToFileURL(join(ROOT, 'renderers', f)).href);
  [T, X, E, MO, MT] = await Promise.all(['three.mjs', 'xr.mjs', 'three-edges.mjs', 'motion.mjs', 'three-mount.mjs'].map(load));
}

const instanceCount = (bucket) => [...bucket.values()].reduce((a, m) => a + m.count, 0);
const segments = (b) => (b.edges.solid.geometry.attributes.position.count + b.edges.dashed.geometry.attributes.position.count) / 2;
const nodes = (scene) => scene.nodes.filter((n) => n && typeof n === 'object');
const vertex = (ls, v) => { const p = ls.geometry.attributes.position; return [p.getX(v), p.getY(v), p.getZ(v)]; };
const lineOf = (b, x) => (x.dashed ? b.edges.dashed : b.edges.solid);
const scaleAt = (im, i) => { const m = new THREE.Matrix4(); im.getMatrixAt(i, m); return [m.elements[0], m.elements[5], m.elements[10], m.elements[12], m.elements[13], m.elements[14]]; };

/** A document whose canvas measures text and records draws, so the atlas path runs headlessly. */
function stubDocument() {
  const draws = [];
  const ctx = { font: '', textBaseline: '', textAlign: '', fillStyle: '', globalAlpha: 1, measureText: (t) => ({ width: t.length * 11 }), clearRect() {}, beginPath() {}, roundRect() {}, rect() {}, fill() {}, fillText(t) { draws.push(t); } };
  return { draws, createElement: (tag) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => ctx } : { textContent: '', hidden: false, setAttribute() {}, addEventListener() {}, remove() {}, classList: { add() {} } }), dispatchEvent() {} };
}
function stubElement() { const h = {}; return { textContent: '', hidden: false, disabled: false, className: '', type: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { h[t] = f; }, click() { if (h.click) h.click(); }, remove() {}, classList: { add() {} } }; }
function stubSession() { return { h: {}, addEventListener(t, f) { this.h[t] = f; }, removeEventListener() {}, async end() { if (this.h.end) this.h.end(); } }; }
function stubRendererXr() { const pads = [new THREE.Group(), new THREE.Group()]; return { xr: { enabled: false, isPresenting: false, setReferenceSpaceType() {}, getController: (i) => pads[i], addEventListener() {}, setSession: async () => {} } }; }

test('the 3D renderer modules import only importmap specifiers and their siblings, never each other in a cycle; three.mjs <= 300 lines; discovery lists every file on disk', () => {
  const siblings = new Set(RENDERER_SPECIFIERS.map((r) => `./${r.file}`));
  const allowed = new Set([...THREE_SPECIFIERS.map((s) => s.specifier), ...siblings]);
  for (const f of ['three.mjs', 'xr.mjs', ...SPLIT]) {
    const rel = `renderers/${f}`; const text = read(rel);
    for (const spec of imports(text)) assert.ok(allowed.has(spec), `${rel} imports ${spec}: a data: URL module resolves importmap specifiers (siblings are rewritten to dotfield/<name>)`);
    assert.doesNotMatch(text, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|import\.meta/, rel);
    assert.ok(text.split('\n').length < 400, `${rel} stays under 400 lines`);
    if (f !== 'three.mjs') assert.ok(!imports(text).includes('./three.mjs'), `${rel} never imports three.mjs back (three-mount gets buildScene by argument)`);
  }
  assert.ok(read('renderers/three.mjs').split('\n').length - 1 <= 300, 'three.mjs is <= 300 lines after the split');
  assert.ok(imports(read('renderers/xr.mjs')).every((s) => s === 'three/addons/webxr/XRButton.js'), 'xr.mjs takes THREE and the built scene from three.mjs by argument, never by import');
  const onDisk = readdirSync(join(ROOT, 'renderers')).filter((f) => RENDERER_FILE_RE.test(f) && f !== 'three.mjs' && f !== 'xr.mjs').sort();
  assert.deepEqual(RENDERER_SPECIFIERS.map((r) => r.file), ['three.mjs', 'xr.mjs', ...onDisk]);
  assert.deepEqual(rendererSpecifiers(join(ROOT, 'renderers')).map((r) => r.file), ['three.mjs', 'xr.mjs', 'motion.mjs', 'three-edges.mjs', 'three-labels.mjs', 'three-mount.mjs']);
});

test('the embedded primitive table mirrors renderers/shapes.json and the positions mirror agrees with lib/layout on mode, frame, positions and VR', { skip: SKIP }, () => {
  const shapes = JSON.parse(read('renderers/shapes.json')).kinds;
  assert.deepEqual(T.DEFAULT_SHAPES, Object.fromEntries(Object.entries(shapes).map(([k, row]) => [k, row.primitive3d])));
  for (const name of SHIPPED) {
    const scene = example(name);
    assert.equal(T.mode3dOf(scene), layoutMode3d(scene), name);
    const mine = T.positions3d(scene);
    assert.deepEqual(mine.positions, layoutPositions3d(scene), `${name}: one positions table`);
    assert.equal(mine.unplaced.size, 0, name);
    const vr = positionsVr(scene); const pl = T.vrPlacement(scene);
    for (const [id, p] of Object.entries(mine.positions)) assert.deepEqual(T.toVr(p, pl), vr[id], `${name}/${id}: vr == T(3d)`);
  }
  for (const [kind, want] of [['graph', 'lift'], ['board', 'lift'], ['meet', 'lift'], ['timeline', 'tier-wall'], ['room', 'metric'], ['lifecycle', 'lift']]) assert.equal(T.mode3dOf({ kind }), want);
  assert.equal(T.mode3dOf({ kind: 'graph', views: { '3d': { layout: 'tier-wall' } } }), 'tier-wall');
  const bare = { kind: 'graph', nodes: [{ id: 'a', kind: 'record', label: 'a label long enough to have grown the old default box' }, { id: 'b', kind: 'note' }], edges: [] };
  const un = T.positions3d(bare);
  assert.deepEqual([...un.unplaced], ['a', 'b'], 'a scene without positions is drawn at the frame centre, never re-simulated');
  assert.deepEqual(un.positions, { a: [0, 0, 0], b: [0, 0, 0] });
  assert.deepEqual(T.frameOf(bare).viewBox, layoutFrameOf(bare).viewBox, 'no written viewBox: the 1600x1000 default of lib/layout/frame.mjs, no stale default-viewBox mirror');
  assert.deepEqual([T.vrPlacement(bare).snap_turn_deg, T.vrPlacement({ views: { vr: { snap_turn_deg: 30 } } }).snap_turn_deg, T.vrPlacement({ views: { vr: { snap_turn_deg: 20 } } }).snap_turn_deg], [45, 30, 45]);
});

test('buildScene on the real three: one instance per node, one segment per polyline vertex pair (lifted by arc length), a halo per foreign node, a region per group', { skip: SKIP }, () => {
  const tokens = tokensFor();
  for (const name of SHIPPED) {
    const scene = example(name); const b = T.buildScene(scene, THREE, tokens);
    const ns = nodes(scene); const proposals = ns.filter((n) => n.status === 'proposal').length;
    assert.equal(THREE.REVISION, '180');
    assert.equal(instanceCount(b.solid) + instanceCount(b.proposal), ns.length, `${name}: every node is an instance`);
    assert.equal(instanceCount(b.proposal), proposals, `${name}: proposals are the wireframe twin`);
    for (const im of b.proposal.values()) { assert.equal(im.material.wireframe, true); assert.ok(im.isInstancedMesh); }
    for (const im of b.solid.values()) { assert.equal(im.material.wireframe, false); assert.equal(im.count, im.userData.ids.length); }
    const p2 = Object.fromEntries(ns.map((n) => [n.id, scene.positions[n.id]])); const p3 = layoutPositions3d(scene); const lf = { frame: layoutFrameOf(scene) };
    const want = scene.edges.map((e) => (T.mode3dOf(scene) === 'metric' ? 1 : layoutPolyline(scene, e, p2[e.from], p2[e.to]).length - 1));
    assert.equal(segments(b), want.reduce((s, v) => s + v, 0), `${name}: one segment per polyline vertex pair`);
    assert.equal(b.edges.list.length, scene.edges.length); assert.equal(b.counts.segments, segments(b));
    for (const x of b.edges.list) {
      const poly = layoutPolyline(scene, x.edge, p2[x.edge.from], p2[x.edge.to]);
      if (T.mode3dOf(scene) === 'lift') assert.deepEqual(x.points, layoutLift(lf, poly, p3[x.edge.from][2], p3[x.edge.to][2]), `${name}/${x.key}: the lib/layout liftPolyline, vertex for vertex`);
      if (T.mode3dOf(scene) !== 'metric') assert.equal(x.points.length, poly.length);
      for (let k = 0; k < x.segs; k += 1) { assert.ok(near(vertex(lineOf(b, x), x.start + 2 * k), x.points[k]) && near(vertex(lineOf(b, x), x.start + 2 * k + 1), x.points[k + 1]), `${name}/${x.key} segment ${k}`); }
      const on = scene.kind === 'sequence' ? (p, q, rr) => Math.abs(p[0] - q[0]) <= rr : near; // a message runs at its beat, on the lifelines
      assert.ok(on(x.points[0], b.positions[x.edge.from], b.slots[x.a].radius) && on(x.points[x.points.length - 1], b.positions[x.edge.to], b.slots[x.b].radius), `${name}/${x.key}: the polyline starts and ends on its nodes (a port lies within the glyph)`);
    }
    assert.equal(b.edges.dashed.material.isLineDashedMaterial, true); assert.ok(b.edges.dashed.geometry.attributes.lineDistance, 'computeLineDistances ran');
    assert.equal(b.edges.dashed.userData.list.length, scene.edges.filter((e) => e.variant === 'dashed' || e.variant === 'flow' || e.kind === 'share' || e.kind === 'candidate').length);
    const foreign = ns.filter((n) => n.kind === 'boundary' || n.color_token === 'foreign' || (n.provenance && n.provenance.owner_person_id !== 'self')).length;
    assert.equal(b.counts.foreign, foreign, name); assert.equal(b.halo ? b.halo.count : 0, foreign);
    const groupsWithMembers = (scene.groups || []).filter((g) => (g.center_xyz_m && g.size_xyz_m) || ns.some((n) => n.group === g.id || (g.wraps || []).includes(n.id))).length;
    assert.equal(b.regions.length, groupsWithMembers, `${name}: translucent region per group`);
    for (const r of b.regions) { assert.equal(r.mesh.material.transparent, true); assert.ok(r.mesh.material.opacity < 0.3); assert.ok(r.size.every((v) => v > 0)); }
    for (const s of b.slots) { assert.deepEqual(s.pos, b.positions[s.id]); assert.ok(s.radius > 0); assert.ok(s.mesh.userData.ids[s.index] === s.id); }
    assert.deepEqual(b.ids, ns.map((n) => n.id));
    assert.ok(b.bounds.isBox3 && !b.bounds.isEmpty());
  }
  const life = T.buildScene(example('scene-lifecycle'), THREE, tokens);
  assert.ok(segments(life) > life.edges.list.length, 'routed transitions draw their channel bends, not one chord per edge');
  const room = T.buildScene(example('scene-room'), THREE, tokens);
  const hb1 = room.slots.find((s) => s.id === 'robot-hb1');
  assert.equal(hb1.prim, 'octahedron'); assert.deepEqual(hb1.pos, [-2, 0.4, 0]); assert.equal(hb1.radius, 0.4, 'a metric node is sized by size_m');
  const bench = room.regions.find((r) => r.group.id === 'bench-a');
  assert.deepEqual(bench.center, [-1.5, 0.5, 0.5]); assert.deepEqual(bench.size, [3, 1, 2], 'a metric group box is drawn as declared');
  const zz = { kind: 'graph', positions: { a: [100, 100], b: [500, 300] }, nodes: [{ id: 'a', kind: 'record' }, { id: 'b', kind: 'record' }], edges: [{ id: 'z', from: 'a', to: 'b', route: 'orthogonal' }], views: { '2d': { viewBox: [0, 0, 600, 400] } } };
  const path = E.edgePath3d('tier-wall', T.frameOf(zz), E.edgePolyline(zz, zz.edges[0], [100, 100], [500, 300]), { pos: [0, 1, 0] }, { pos: [0, 2, 0] });
  assert.ok(near(path.fracs, [0, 1 / 6, 5 / 6, 1], 1e-12) && near(path.points.map((p) => p[1]), [1, 7 / 6, 11 / 6, 2], 1e-12), 'tier wall: a via vertex takes the height at its arc fraction (100 + 400 + 100 px)');
});

test('colours come from --df-* tokens, resolve once per theme and recolour every mesh; the CSS parser handles the forms getComputedStyle returns', { skip: SKIP }, () => {
  assert.deepEqual(T.parseCssColor('#ff0000'), [1, 0, 0, 1]);
  assert.deepEqual(T.parseCssColor('#f00'), [1, 0, 0, 1]);
  assert.deepEqual(T.parseCssColor('rgb(255, 0, 0)'), [1, 0, 0, 1]);
  assert.deepEqual(T.parseCssColor('rgb(255 0 0)'), [1, 0, 0, 1]);
  assert.deepEqual(T.parseCssColor('rgba(0, 0, 255, 0.5)'), [0, 0, 1, 0.5]);
  assert.deepEqual(T.parseCssColor('rgb(0 0 255 / 50%)'), [0, 0, 1, 0.5]);
  assert.equal(T.parseCssColor('6 4'), null); assert.equal(T.parseCssColor(undefined), null);
  assert.equal(T.colorOf(THREE, {}, 'missing').color.getHex(), 0x808080, 'no token at all falls back to mid grey');
  const scene = example('scene-graph'); const dark = tokensFor('default'); const light = tokensFor('light');
  const b = T.buildScene(scene, THREE, dark);
  const slot = b.slots.find((s) => s.token === 'series-2'); const c = new THREE.Color();
  slot.mesh.getColorAt(slot.index, c);
  assert.equal(c.getHexString(), T.colorOf(THREE, dark, 'series-2').color.getHexString(), 'an instance carries its token colour');
  assert.notEqual(T.colorOf(THREE, dark, 'series-2').color.getHexString(), T.colorOf(THREE, light, 'series-2').color.getHexString(), 'the fixture themes differ on series-2');
  b.recolor(light); slot.mesh.getColorAt(slot.index, c);
  assert.equal(c.getHexString(), T.colorOf(THREE, light, 'series-2').color.getHexString(), 'recolor moves every instance to the new theme');
  assert.equal(b.ring.material.color.getHexString(), T.colorOf(THREE, light, 'accent').color.getHexString());
  slot.ghost.getColorAt(slot.ghostIndex, c); assert.equal(c.getHexString(), T.colorOf(THREE, light, 'series-2').color.getHexString(), 'the ghost twin recolours with its node');
  assert.equal(b.motion.beads.material.color.getHexString(), T.colorOf(THREE, light, 'trace', 'accent').color.getHexString());
  const shareEdge = b.edges.dashed.userData.list.find((x) => x.edge.kind === 'share');
  const col = b.edges.dashed.geometry.attributes.color; const want = T.colorOf(THREE, light, 'foreign').color;
  for (let v = shareEdge.start; v < shareEdge.start + 2 * shareEdge.segs; v += 1) assert.ok(Math.abs(col.getX(v) - want.r) < 1e-6 && Math.abs(col.getY(v) - want.g) < 1e-6, 'every vertex of a share edge is drawn in the foreign colour');
  const text = [...['three.mjs', 'xr.mjs'], ...SPLIT].map((f) => read(`renderers/${f}`)).join('\n');
  assert.doesNotMatch(text, /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/, 'no raw hex in the renderers');
});

test('labels: the plan is bounded by label_budget with focus, hover and reach first; headless draws nothing; a canvas fills one shared atlas with per-instance UV rects', { skip: SKIP }, () => {
  const scene = example('scene-graph'); const tokens = tokensFor();
  const headless = T.buildScene(scene, THREE, tokens, { document: null });
  assert.equal(headless.labels.atlas, null); assert.equal(headless.budget, 64);
  const plan = headless.labels.plan({ focus: 'robot-hb1', hover: 'paper-orb3' });
  assert.deepEqual(plan.slice(0, 2), ['robot-hb1', 'paper-orb3']);
  assert.ok(plan.indexOf('exp-0412') < plan.indexOf('person-ada'), 'the one-hop reach of the focus comes before the rest');
  assert.equal(plan.length, scene.nodes.length);
  assert.deepEqual(headless.labels.apply(plan), plan); assert.equal(headless.labels.mesh.count, 0, 'no canvas, no label quads');
  const small = T.buildScene({ ...scene, views: { ...scene.views, vr: { ...scene.views.vr, label_budget: 2 } } }, THREE, tokens, { document: null });
  assert.equal(small.budget, 2); assert.deepEqual(small.labels.plan({ focus: 'idea-vib-cadence' }).length, 2);
  assert.deepEqual(small.labels.plan({ focus: 'idea-vib-cadence', visible: new Set(['paper-orb3']) }), ['paper-orb3'], 'a lens hides labels with the nodes');
  assert.equal(T.labelBudgetOf({ views: { vr: { label_budget: 100000 } } }), T.ATLAS_SLOTS, 'the atlas caps the budget');
  const doc = stubDocument(); const drawn = T.buildScene(scene, THREE, tokens, { document: doc });
  assert.ok(drawn.labels.atlas); assert.equal(drawn.labels.atlas.canvas.width, 2048); assert.equal(drawn.labels.atlas.canvas.height, 2048);
  const ids = drawn.labels.apply(drawn.labels.plan({ focus: 'exp-0412' }));
  assert.equal(drawn.labels.mesh.count, ids.length); assert.equal(doc.draws.length, ids.length);
  const uv = drawn.labels.mesh.geometry.attributes.uvRect; assert.equal(uv.itemSize, 4);
  for (let i = 0; i < ids.length; i += 1) { const r = [uv.getX(i), uv.getY(i), uv.getZ(i), uv.getW(i)]; assert.ok(r.every((v) => v >= 0 && v <= 1), `uv rect ${i} inside the atlas`); assert.equal(r[2], 256 / 2048); assert.equal(r[3], 32 / 2048); }
  const slots = new Set(ids.map((id) => drawn.labels.atlas.slots.get(id).slot)); assert.equal(slots.size, ids.length, 'one slot per label');
  drawn.labels.apply(['exp-0412']); assert.equal(drawn.labels.mesh.count, 1); assert.equal(drawn.labels.atlas.slots.size, 1, 'slots of dropped labels are released');
  assert.equal(drawn.labels.mesh.material.isShaderMaterial, true); assert.match(drawn.labels.mesh.material.vertexShader, /instanceMatrix/);
});

test('setVisible collapses hidden instances and every vertex of their edges and restores them; setFocus moves the ring', { skip: SKIP }, () => {
  const scene = example('scene-graph'); const b = T.buildScene(scene, THREE, tokensFor(), { document: null });
  const hidden = b.slots.find((s) => s.id === 'robot-hb1');
  b.setVisible(['exp-0412', 'paper-orb3']);
  assert.deepEqual(scaleAt(hidden.mesh, hidden.index).slice(0, 3), [0, 0, 0], 'a hidden node has zero scale');
  const e2 = b.edges.list.find((x) => x.edge.id === 'e2'); const ls = lineOf(b, e2);
  for (let v = e2.start; v < e2.start + 2 * e2.segs; v += 1) assert.ok(near(vertex(ls, v), e2.points[0]), 'an edge to a hidden node collapses to its first vertex');
  assert.deepEqual([...b.state.shown].sort(), ['exp-0412', 'paper-orb3']);
  b.setVisible(null);
  assert.ok(scaleAt(hidden.mesh, hidden.index)[0] > 0, 'restored'); assert.equal(b.state.shown, null);
  assert.ok(near(vertex(ls, e2.start + 1), e2.points[1]));
  assert.equal(b.setFocus('exp-0412'), 'exp-0412'); assert.equal(b.ring.visible, true); assert.deepEqual(b.ring.position.toArray(), b.positions['exp-0412']);
  assert.equal(b.setFocus('nope'), null); assert.equal(b.ring.visible, false);
  assert.deepEqual([...b.reachOf('exp-0412')].sort(), ['idea-vib-cadence', 'paper-orb3', 'robot-hb1']);
});

test('time in 3D: setTime(visibleAt(t)) ghosts the unborn, beads every edge with phase in (0, 1), truncates it at its phase, moves the now plane to the ruler x; the viewer detail shape draws the same frame', { skip: SKIP }, () => {
  const scene = example('scene-graph'); const tokens = tokensFor(); const b = T.buildScene(scene, THREE, tokens, { document: null });
  for (const name of SHIPPED) { const s = example(name); const st = ticks(s); const tb = MO.timeBlockOf(s); if (!timeOf(s)) { assert.equal(tb, null, name); continue; } if (timeOf(s).axis === 'date') assert.deepEqual([tb.from, tb.to], [dayIndex(st[0]), dayIndex(st[st.length - 1])], `${name}: the time window mirrors lib/time`); }
  const t = '2026-09-14'; const vis = visibleAt(scene, t); const flight = [...vis.edgePhase].filter(([, p]) => p > 0 && p < 1);
  const unborn = nodes(scene).filter((n) => !vis.present.has(n.id)).map((n) => n.id);
  assert.ok(flight.length >= 2 && unborn.length >= 2, 'the test t has edges in flight and unborn nodes');
  const r = b.setTime({ ...vis, t });
  assert.deepEqual(r.bead_edges.slice().sort(), flight.map(([k]) => k).sort(), 'beads exactly on the edges whose phase is in (0, 1)');
  const still = renderSvg({ ...scene, views: { ...scene.views, time: { ...scene.views.time, playhead: t } } }, TOKENS_CSS);
  const svgFlight = [...still.matchAll(/data-edge-id="([^"]+)"[\s\S]*?data-phase="([^"]+)"/g)].filter((m) => Number(m[2]) > 0 && Number(m[2]) < 1).map((m) => m[1]).sort();
  assert.deepEqual(r.bead_edges.slice().sort(), svgFlight, 'beads = the edges whose data-phase in the still at t is in (0, 1)');
  assert.equal(r.beads, flight.length * b.motion.beadsPerEdge); assert.equal(b.motion.beads.count, r.beads); assert.equal(b.motion.beadsPerEdge, timeOf(scene).trace.beads);
  for (const [key, p] of flight) {
    const x = b.edges.list.find((e) => e.key === key); const head = E.pointAlong(x.points, x.fracs, p);
    assert.ok(near(vertex(lineOf(b, x), x.start + 1), head), `${key}: the edge is drawn up to its phase`);
    assert.ok(r.bead_edges.includes(key) && near(scaleAt(b.motion.beads, r.bead_edges.indexOf(key) * b.motion.beadsPerEdge).slice(3), head), `${key}: the lead bead sits at the phase on the lifted route`);
  }
  assert.equal(b.motion.ghostMaterial.transparent, true); assert.equal(b.motion.ghostMaterial.opacity, Number(tokens['--df-ghost-opacity'])); assert.equal(b.motion.ghostMaterial.depthWrite, false);
  for (const s of b.slots) {
    const ghost = unborn.includes(s.id);
    assert.equal(scaleAt(s.mesh, s.index)[0] > 0, !ghost, `${s.id}: the solid instance is drawn only when born`);
    assert.equal(scaleAt(s.ghost, s.ghostIndex)[0] > 0, ghost, `${s.id}: the ghost material instance only when unborn`);
    if (ghost) assert.ok(near(scaleAt(s.ghost, s.ghostIndex).slice(3), s.pos), `${s.id}: the ghost sits where the node will be born`);
  }
  assert.equal(r.ghosts, unborn.length); assert.ok(unborn.every((id) => !b.state.shown.has(id)), 'unborn nodes carry no label');
  const lf = layoutFrameOf(scene); const st = ticks(scene); const a = dayIndex(st[0]); const z = dayIndex(st[st.length - 1]); const xL = lf.x0 + lf.padding; const xR = lf.x0 + lf.w - lf.padding;
  const rulerX = (xL + ((dayIndex(t) - a) / (z - a)) * (xR - xL) - lf.cx) * lf.metres_per_px;
  assert.equal(b.motion.plane.visible, true); assert.ok(Math.abs(b.motion.plane.position.x - rulerX) < 1e-9 && Math.abs(r.now_x - rulerX) < 1e-9, 'the now plane stands at the 2D ruler x for t');
  assert.equal(b.motion.plane.material.transparent, true); assert.ok(b.motion.plane.material.opacity < 0.3);
  const planeTop = b.motion.plane.position.y + b.motion.plane.scale.y / 2;
  assert.ok(b.slots.every((s) => s.pos[1] - s.radius > planeTop), 'the now plane stands below the node volume, as the 2D ruler runs below the frame: it never splits the nodes');
  const detail = { t, t_num: dayIndex(t), present: [...vis.present], fresh: [...vis.fresh], active: vis.active, taken: null, phases: Object.fromEntries(vis.edgePhase) };
  const b2 = T.buildScene(scene, THREE, tokens, { document: null }); assert.deepEqual(b2.setTime(detail), r, 'DF.frameDetail and visibleAt draw one frame');
  b.setVisible(['exp-0412', 'paper-orb3']); const lensed = b.setTime({ ...vis, t });
  assert.deepEqual(lensed.bead_edges, ['e1']); assert.equal(lensed.ghosts, unborn.filter((id) => ['exp-0412', 'paper-orb3'].includes(id)).length, 'a lens hides ghosts and beads with their nodes');
  b.setVisible(null); const none = b.setTime(null);
  assert.deepEqual([none.ghosts, none.beads, none.fresh, b.motion.plane.visible], [0, 0, 0, false]); assert.ok(b.slots.every((s) => scaleAt(s.mesh, s.index)[0] > 0), 'no frame: everything is drawn');
  assert.equal(T.buildScene(example('scene-room'), THREE, tokens).motion, null, 'no views.time, no time layer');
});

test('time in 3D on an order axis: a fractional beat beads the transition in flight along its routed channel, rings the fresh state and the active one; no now plane', { skip: SKIP }, () => {
  const scene = example('scene-lifecycle'); const b = T.buildScene(scene, THREE, tokensFor(), { document: null }); const vis = visibleAt(scene, 2);
  const phases = Object.fromEntries(scene.edges.map((e) => [e.id, Math.min(1, Math.max(0, (2.5 - e.order + 1) / 1))]));
  const r = b.setTime({ t: 2, t_num: 2.5, present: [...vis.present], fresh: [...vis.fresh], active: vis.active, taken: 't2', phases });
  const fly = scene.edges.filter((e) => phases[e.id] > 0 && phases[e.id] < 1).map((e) => e.id);
  assert.deepEqual(r.bead_edges, fly); assert.ok(fly.length > 0);
  const x = b.edges.list.find((e) => e.key === fly[0]); assert.ok(x.points.length > 2, 'the transition in flight follows its channel route');
  assert.ok(near(scaleAt(b.motion.beads, 0).slice(3), E.pointAlong(x.points, x.fracs, phases[fly[0]])));
  assert.equal(r.fresh, vis.fresh.size); assert.ok(r.fresh > 0); assert.equal(b.motion.fresh.count, r.fresh);
  assert.equal(r.active, vis.active); assert.equal(b.motion.active.visible, true); assert.deepEqual(b.motion.active.position.toArray(), b.positions[vis.active]);
  assert.equal(b.motion.plane, null, 'the now plane is for date axes'); assert.equal(r.now_x, null);
  const ver = [...b.solid.values()].map((im) => im.instanceMatrix.version); const head0 = scaleAt(b.motion.beads, 0).slice(3);
  b.setTime({ t: 2, t_num: 2.75, present: [...vis.present], fresh: [...vis.fresh], active: vis.active, phases: { ...phases, [fly[0]]: 0.75 } });
  assert.deepEqual([...b.solid.values()].map((im) => im.instanceMatrix.version), ver, 'a tween inside one stop leaves the node instances alone'); assert.ok(!near(scaleAt(b.motion.beads, 0).slice(3), head0), 'and moves the beads');
  const frames = [0, 1, 2, 3].map((k) => b.setTime({ ...visibleAt(scene, k), t: k }).beads); assert.deepEqual(frames, [0, 0, 0, 0], 'at a whole beat nothing is in flight');
});

test('adaptive DPR: 30 frames over 24 ms in a row drop the pixel ratio to 1, once; a fast frame resets the run; a hidden-tab gap is no sample', { skip: SKIP }, () => {
  const g = MT.createDprGovernor({ start: 2 });
  for (let i = 0; i < 29; i += 1) assert.equal(g.sample(30), null);
  assert.equal(g.sample(10), null, 'a fast frame resets the run'); assert.equal(g.slow, 0);
  for (let i = 0; i < 29; i += 1) g.sample(25); assert.equal(g.sample(5000), null, 'a gap is ignored'); assert.equal(g.slow, 29);
  assert.equal(g.sample(25), 1); assert.equal(g.ratio, 1); assert.equal(g.dropped, true); assert.equal(g.sample(100), null, 'it drops once');
  const f = MT.createDprGovernor({ start: 2 }); let out = null; for (let i = 0; i <= 30; i += 1) out = f.frame(i * 40) ?? out; assert.equal(out, 1, 'frame(time) samples rAF timestamps');
  const one = MT.createDprGovernor({ start: 1 }); for (let i = 0; i < 60; i += 1) assert.equal(one.sample(50), null, 'a ratio already at 1 has nothing to drop');
  assert.deepEqual([MT.DPR.budget_ms, MT.DPR.frames, MT.DPR.floor], [24, 30, 1]);
});

test('xr: support words, the VR-only session machine, its button text and the honest overlay, driven by stubs', { skip: SKIP }, async () => {
  assert.equal(await X.xrSupport(undefined), 'unsupported');
  assert.equal(await X.xrSupport({ xr: { isSessionSupported: async () => false } }), 'unsupported');
  assert.equal(await X.xrSupport({ xr: { isSessionSupported: async (m) => m === 'immersive-vr' } }), 'supported');
  assert.equal(await X.xrSupport({ xr: { isSessionSupported: async () => { throw new Error('policy'); } } }), 'blocked');
  assert.equal(await X.xrSupport({ xr: { isSessionSupported: async () => true } }, { secure: false }), 'insecure');
  for (const s of ['unsupported', 'blocked', 'insecure']) assert.ok(X.overlayText(s).length > 40 && /2D and 3D views are complete/.test(X.overlayText(s)), s);
  for (const s of ['ready', 'starting', 'presenting']) assert.equal(X.overlayText(s), '');
  assert.match(X.overlayText('error', 'denied'), /could not start: denied/);
  const doc = { createElement: () => stubElement() }; const renderer = stubRendererXr(); const session = stubSession(); const states = [];
  const nav = { xr: { isSessionSupported: async (m) => m === 'immersive-vr', requestSession: async (mode, init) => { assert.equal(mode, 'immersive-vr'); assert.ok(init.optionalFeatures.includes('local-floor')); return session; } } };
  const m = X.createVrSession({ renderer, nav, doc, onState: (s) => states.push(s) });
  assert.equal(m.state, 'checking'); assert.equal(m.button.textContent, 'CHECKING VR…'); assert.equal(m.button.hidden, true);
  await m.ready; assert.equal(m.state, 'ready'); assert.equal(m.button.textContent, 'ENTER VR'); assert.equal(m.button.hidden, false);
  const entering = m.enter(); assert.equal(m.state, 'starting'); assert.equal(m.button.disabled, true);
  await entering; assert.equal(m.state, 'presenting'); assert.equal(m.button.textContent, 'EXIT VR'); assert.equal(m.session, session);
  assert.equal(await m.enter(), 'presenting', 'enter while presenting is a no-op');
  m.button.click(); await Promise.resolve(); await Promise.resolve();
  assert.equal(m.state, 'ready'); assert.equal(m.session, null); assert.deepEqual(states, ['checking', 'ready', 'starting', 'presenting', 'ready']);
  const no = X.createVrSession({ renderer, nav: undefined, doc }); await no.ready;
  assert.equal(no.state, 'unsupported'); assert.equal(no.button.hidden, true, 'the Enter VR button appears only when immersive-vr is reported');
  const bad = X.createVrSession({ renderer, nav: { xr: { isSessionSupported: async () => true, requestSession: async () => { throw new Error('denied by policy'); } } }, doc }); await bad.ready; await bad.enter();
  assert.equal(bad.state, 'error'); assert.equal(bad.detail, 'denied by policy'); assert.equal(bad.button.textContent, 'VR ERROR — RETRY'); assert.equal(bad.button.hidden, false, 'a failed start can be retried');
  assert.equal(typeof X.XRButton.createButton, 'function', 'the vendored addon is re-exported for {button: "addon"}');
});

test('xr.enableXr: the VR placement is exactly lib/layout positionsVr, the floor sits at floor_y, two controller rays, teleport, snap turn about the head with a comfort fade, and leave', { skip: SKIP }, async () => {
  const scene = example('scene-graph'); const tokens = tokensFor(); const built = T.buildScene(scene, THREE, tokens, { document: null });
  const overlay = stubElement(); const host = { kids: [], append(b) { this.kids.push(b); }, querySelector: () => overlay };
  const renderer = stubRendererXr(); const world = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(); const rig = new THREE.Group(); rig.add(camera); world.add(rig, built.group);
  const controls = { target: new THREE.Vector3(1, 2, 3), updates: 0, update() { this.updates += 1; } }; const selected = [];
  const api = X.enableXr({ THREE, renderer, world, camera, rig, controls, built, host, document: { createElement: () => stubElement() }, navigator: undefined, window: { isSecureContext: true, performance: { now: () => 1000 } }, reduced: false, color: (n, fb) => T.colorOf(THREE, tokens, n, fb), onSelect: (id) => selected.push(id) });
  await api.machine.ready;
  assert.equal(renderer.xr.enabled, true); assert.equal(api.state(), 'unsupported'); assert.equal(overlay.hidden, false); assert.match(overlay.textContent, /not available in this browser/);
  assert.equal(host.kids.length, 1); assert.equal(host.kids[0].hidden, true);
  assert.equal(api.controllers.length, 2); assert.ok(api.controllers.every((c) => c.getObjectByName('ray')));
  assert.equal(api.floor.visible, false); assert.equal(api.floor.position.y, scene.views.vr.floor_y);
  api.place(); built.group.updateMatrixWorld(true);
  const pl = api.placement; assert.equal(built.group.scale.x, pl.k); assert.equal(built.group.position.y, pl.y0); assert.equal(api.floor.visible, true);
  const vr = positionsVr(scene); const v = new THREE.Vector3();
  for (const [id, p] of Object.entries(built.positions)) { v.set(p[0], p[1], p[2]).applyMatrix4(built.group.matrixWorld); for (let k = 0; k < 3; k += 1) assert.ok(Math.abs(v.getComponent(k) - vr[id][k]) < 1e-9, `${id}[${k}] in VR`); }
  assert.deepEqual(rig.position.toArray(), [0, 0, 0], 'desktop preview: the rig stays at the origin');
  const entry = vr[scene.views.vr.entry_node]; assert.deepEqual(controls.target.toArray(), entry); assert.equal(camera.position.y, pl.floor_y + pl.eye_height_m);
  renderer.xr.isPresenting = true; api.place();
  assert.equal(rig.position.x, entry[0]); assert.equal(rig.position.y, pl.floor_y); assert.ok(rig.position.z > entry[2], 'presenting: the headset stands in front of the entry node');
  const pad = api.controllers[0]; const gp = { axes: [0, 0, 0.9, 0] }; pad.dispatchEvent({ type: 'connected', data: { gamepad: gp } });
  const head = () => { camera.updateMatrixWorld(true); return camera.getWorldPosition(new THREE.Vector3()).toArray(); }; const h0 = head();
  api.update(1000); assert.ok(Math.abs(rig.rotation.y + Math.PI / 4) < 1e-12, 'stick right: one 45 degree turn to the right'); assert.ok(near(head(), h0, 1e-9), 'the turn is about the head');
  assert.equal(api.blink.visible, true, 'comfort fade on the turn');
  api.update(1010); assert.ok(Math.abs(rig.rotation.y + Math.PI / 4) < 1e-12, 'held: still one turn');
  gp.axes[2] = 0.1; api.update(1020); gp.axes[2] = -0.95; api.update(1030); assert.ok(Math.abs(rig.rotation.y) < 1e-12, 'released, then left: back');
  const s = X.createSnapTurn({ deg: 0 }); assert.deepEqual([s.sample(1), s.sample(-1)], [0, 0], 'snap_turn_deg 0 disables it');
  assert.deepEqual([X.stickX({ axes: [0.3, 0.2] }), X.stickX({ axes: [0, 0, -0.8, 0] }), X.stickX(null)], [0.3, -0.8, 0]);
  renderer.xr.isPresenting = false;
  api.teleport({ x: 1.5, z: -2 }); assert.deepEqual(rig.position.toArray(), [1.5, pl.floor_y, -2]); assert.equal(api.blink.visible, true);
  api.update(1100); assert.ok(api.blink.material.opacity > 0 && api.blink.material.opacity < 1); api.update(1200); assert.equal(api.blink.visible, false);
  api.leave();
  assert.equal(built.group.scale.x, 1); assert.equal(built.group.position.y, 0); assert.equal(api.floor.visible, false); assert.deepEqual(rig.position.toArray(), [0, 0, 0]); assert.deepEqual(controls.target.toArray(), [1, 2, 3], 'the 3D framing is restored');
  const still = X.enableXr({ THREE, renderer: stubRendererXr(), world: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), rig: new THREE.Group(), controls, built, host, document: { createElement: () => stubElement() }, navigator: undefined, window: { isSecureContext: true }, reduced: true, color: (n, fb) => T.colorOf(THREE, tokens, n, fb) });
  still.place(); still.teleport({ x: 0.5, z: 0.5 }); assert.notEqual(still.snapTurn(1), 0); assert.equal(still.blink.visible, false, 'reduced motion: no fade, the cut is instant');
  api.dispose(); still.dispose();
});

test('html.mjs embeds the real renderers and vendor files: a data: importmap for every specifier, siblings rewritten to dotfield/<name>, a clean render gate, inside the 8 MiB budget', { skip: SKIP }, () => {
  for (const name of ['scene-graph', 'scene-lifecycle']) {
    const scene = example(name);
    const r = renderHtmlDetailed(scene, { tokensCss: TOKENS_CSS, views: 'all', embedThree: true, vendorDir: VENDOR, rendererDir: join(ROOT, 'renderers') });
    assert.equal(r.importmap.mode, 'embedded'); assert.equal(r.importmap.present, true); assert.deepEqual(r.importmap.missing, []); assert.equal(r.renderer.present, true);
    const map = JSON.parse(r.html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]); const decode = (spec) => Buffer.from(map.imports[spec].slice('data:text/javascript;base64,'.length), 'base64').toString('utf8');
    assert.deepEqual(Object.keys(map.imports).sort(), [...THREE_SPECIFIERS.map((s) => s.specifier), ...RENDERER_SPECIFIERS.map((s) => s.specifier)].sort());
    for (const v of Object.values(map.imports)) assert.match(v, /^data:text\/javascript;base64,/);
    assert.doesNotMatch(decode('three'), /\.\/three\.core\.js/); assert.equal(decode('three'), readFileSync(vendorFile('three'), 'utf8'), 'the embedded module is the vendored bytes');
    assert.equal(decode('dotfield/xr'), read('renderers/xr.mjs'));
    for (const f of SPLIT) { assert.ok(decode('dotfield/three').includes(`'dotfield/${f.replace('.mjs', '')}'`), `three.mjs reaches ${f} through its specifier`); assert.ok(!decode('dotfield/three').includes(`'./${f}'`)); }
    assert.ok(decode('dotfield/motion').includes("'dotfield/three-edges'"), 'motion.mjs reaches three-edges through its specifier');
    assert.doesNotMatch(r.html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '').replace(/<script type="application\/json"[\s\S]*?<\/script>/g, ''), /https?:\/\//);
    assert.match(r.html, /dotfield:3d/); assert.ok(r.bytes < 8 * 1024 * 1024 && r.bytes > 2 * 1024 * 1024, `embedded render is ${r.bytes} bytes`);
    assert.deepEqual(gate.motionLoops(r.html), [], `${name}: no looping motion in any embedded module`);
    const checks = gate.check(scene, { html: r.html, views: 'all', embedThree: true, vendorDir: VENDOR, tokensCss: TOKENS_CSS });
    assert.deepEqual(checks.filter((c) => c.status === 'fail').map((c) => c.code), [], name);
  }
});

test('CDN mode: the pinned manifest gives every jsdelivr URL an integrity entry, so DF_RENDER_SRI_MISSING passes without vendor files', () => {
  const scene = example('scene-graph');
  const r = renderHtmlDetailed(scene, { tokensCss: TOKENS_CSS, views: '2d,3d', vendorDir: VENDOR, rendererDir: join(ROOT, 'renderers') });
  assert.equal(r.importmap.mode, 'cdn'); assert.equal(r.renderer.present, true);
  const map = JSON.parse(r.html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const s of THREE_SPECIFIERS) { const url = `${CDN_BASE}${s.cdn}`; assert.equal(map.imports[s.specifier], url); assert.match(map.integrity[url], /^sha256-[A-Za-z0-9+/=]+$/, url); }
  for (const s of RENDERER_SPECIFIERS) assert.match(map.imports[s.specifier], /^data:text\/javascript;base64,/, `${s.specifier} is embedded in CDN mode too`);
  const checks = gate.check(scene, { html: r.html, views: '2d,3d', vendorDir: VENDOR, tokensCss: TOKENS_CSS });
  assert.deepEqual(checks.filter((c) => c.status === 'fail').map((c) => c.code), []);
});
