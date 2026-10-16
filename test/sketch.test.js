// The quick path (V2_PLAN §6, §7.1-2): a dotfield.sketch/1 file expands
// deterministically into a scene (importers/sketch.mjs), render takes a sketch
// with no out path and writes a gated page inside .dotfield/renders/, every
// template is at most ten lines and showcase-clean with every view, x- kinds
// come from one table (lib/rooms.mjs kindsFor, a sketch's inline kinds on top),
// npm run demo renders every template, and templates/ is fork-editable.
// Temp dirs only, zero network, one clock (SOURCE_DATE_EPOCH).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTmp } from './helpers/tmp.mjs';
import { runCli } from './helpers/cli.mjs';
import { EPOCH_ENV } from './helpers/center.mjs';
import { IMPORTERS, detect, importInput } from '../importers/index.mjs';
import * as sketch from '../importers/sketch.mjs';
import { dispatch } from '../bin/dotfield.mjs';
import { createContext } from '../lib/context.mjs';
import { canonical, sha256 } from '../lib/digest.mjs';
import { IR_ORDER, gateContext, runGates, withSceneKinds } from '../lib/pipeline.mjs';
import { kindsFor, kindsTable } from '../lib/rooms.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { renderSvg } from '../renderers/svg.mjs';
import { buildManifest, isForkEditableFile } from '../scripts/manifest.mjs';
import { runDemo, templateFiles } from '../scripts/demo.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEMPLATES = join(ROOT, 'templates');
const NOW = new Date('2026-10-07T09:00:00Z');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const tpl = (name) => read(join(TEMPLATES, `${name}.sketch.json`));
const expand = (name, now = NOW) => sketch.expandSketch(tpl(name), { now, name });
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const env = () => { const e = { ...process.env, ...EPOCH_ENV }; delete e.DOTFIELD_ROOT; return e; };
const NAMES = ['architecture', 'board', 'custom-kind', 'dataflow', 'graph', 'lifecycle', 'room', 'sequence', 'timeline', 'workflow'];

test('detect keys on schema_version dotfield.sketch/1 only, and the registry tries the sketch importer first', () => {
  assert.equal(IMPORTERS[0].id, 'sketch');
  const doc = tpl('architecture');
  assert.equal(sketch.detect({ doc }), true);
  assert.equal(detect({ name: 'a.sketch.json', doc }).id, 'sketch');
  const { schema_version: _v, ...bare } = doc;
  assert.equal(sketch.detect({ doc: bare }), false, 'a bare {type, nodes} shape is not a sketch');
  assert.equal(sketch.detect({ doc: { ...doc, schema_version: 'dotfield.sketch/2' } }), false);
  assert.equal(sketch.detect({ doc: { diagram_type: 'workflow', nodes: [] } }), false);
  assert.equal(sketch.detect(null), false);
  const r = importInput({ name: 'architecture.sketch.json', doc }, { now: NOW });
  assert.equal(r.importer, 'sketch');
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => c.code === 'DF_IMPORT_SKETCH_INVALID' && c.status === 'pass'));
});

test('every template is at most ten lines, a valid sketch, and expands to a scene that validates and passes the IR gates', async () => {
  assert.deepEqual(templateFiles(), NAMES.map((n) => `${n}.sketch.json`));
  await withTmp(async (dir) => {
    const gctx = gateContext(createContext({ cwd: dir, env: env() }), { viewer: 'self' });
    for (const name of NAMES) {
      const text = readFileSync(join(TEMPLATES, `${name}.sketch.json`), 'utf8');
      assert.ok((text.match(/\n/g) || []).length <= 10, `${name} is at most ten lines (wc -l)`);
      assert.deepEqual(sketch.sketchProblems(JSON.parse(text)), [], name);
      const scene = expand(name);
      assert.deepEqual(validate(loadSchema('scene'), scene).errors, [], `${name} validates`);
      const ir = runGates(scene, gctx, IR_ORDER);
      assert.deepEqual(fails(ir.checks), [], `${name}: ${JSON.stringify(fails(ir.checks))}`);
      assert.equal(ir.scene.laid_out, true);
    }
  });
});

test('expansion is deterministic and carries the quick-path invariants (ids, labels, e<index>, order, provenance, synthetic, views)', () => {
  const doc = tpl('architecture');
  const s = expand('architecture');
  assert.deepEqual(expand('architecture'), s, 'two expansions are identical');
  const later = expand('architecture', new Date('2027-01-02T00:00:00Z'));
  assert.equal(later.nodes[0].provenance.captured_on, '2027-01-02');
  assert.deepEqual({ ...later, nodes: later.nodes.map((n) => ({ ...n, provenance: { ...n.provenance, captured_on: 'x' } })) }, { ...s, nodes: s.nodes.map((n) => ({ ...n, provenance: { ...n.provenance, captured_on: 'x' } })) }, 'only the capture date follows now');
  const digest = sha256(canonical(doc));
  assert.equal(s.kind, 'workflow');
  assert.deepEqual(s.meta, { id: 'telemetry', title: 'Telemetry', output: 'telemetry.html', theme: 'studio', quality: 'checked', units: 'm', up_axis: 'y', privacy_mode: 'synthetic_data', maturity: 'prototype', legend: true });
  assert.deepEqual(s.nodes.map((n) => [n.id, n.label, n.kind, n.group ?? null]), [['bag', 'Bag', 'desk', 'edge'], ['ingest', 'Ingest', 'desk', 'edge'], ['sync', 'Sync', 'desk', 'core'], ['store', 'Store', 'desk', 'core'], ['report', 'Report', 'desk', null]]);
  for (const n of s.nodes) {
    assert.deepEqual(n.provenance, { owner_person_id: 'self', source: { kind: 'import', ref: 'sketch:architecture', digest }, captured_on: '2026-10-07' });
    assert.deepEqual(n.audience, { privacy_level: 'private', share_rule_ids: [] });
    assert.deepEqual(n.evidence_ids, ['ev-1']);
  }
  assert.deepEqual(s.evidence, [{ id: 'ev-1', kind: 'import', ref: 'sketch:architecture', digest, label: 'SRC 1' }]);
  assert.deepEqual(s.edges.map((e) => [e.id, e.from, e.to, e.kind, e.order, e.label ?? null]), [['e1', 'bag', 'ingest', 'flow', 1, 'frames'], ['e2', 'ingest', 'sync', 'flow', 2, null], ['e3', 'sync', 'store', 'flow', 3, 'rows'], ['e4', 'store', 'report', 'flow', 4, null]]);
  assert.deepEqual(s.groups.map((g) => [g.id, g.kind, g.wraps]), [['edge', 'zone', ['bag', 'ingest']], ['core', 'zone', ['sync', 'store']]]);
  assert.deepEqual(s.views['2d'], { layout: 'layered', seed: 7, direction: 'down' });
  assert.deepEqual(s.views['3d'], { layout: 'lift', scale_m: 6 });
  assert.deepEqual(s.views.vr, { enabled: true, scale_m: 4, entry_node: 'bag' });
  assert.deepEqual(s.ext.sketch, { name: 'architecture', type: 'architecture', digest });
  assert.equal(s.positions, undefined, 'the importer never lays out');
  assert.equal(sketch.labelFrom('pilot-study'), 'Pilot study');
  assert.equal(sketch.labelFrom('ORB-SLAM3'), 'ORB-SLAM3');
});

test('each type maps to its kind, layout, group kind and edge kind; sequence, lifecycle, timeline, room and custom kinds carry their extras', () => {
  const want = {
    architecture: ['workflow', 'layered', 'zone', 'flow'], workflow: ['workflow', 'layered', 'zone', 'flow'], dataflow: ['workflow', 'layered', 'zone', 'flow'],
    sequence: ['sequence', 'sequence', null, 'message'], lifecycle: ['lifecycle', 'lifecycle', null, 'transition'], graph: ['graph', 'force', 'discipline', 'relates'],
    timeline: ['timeline', 'timeline', null, 'precedes'], board: ['board', 'lanes', 'lane', 'depends'], room: ['room', 'metric', 'zone', 'depends'], 'custom-kind': ['workflow', 'layered', null, 'flow'],
  };
  for (const [name, [kind, layout, group, edge]] of Object.entries(want)) {
    const s = expand(name);
    assert.equal(s.kind, kind, name); assert.equal(s.views['2d'].layout, layout, name);
    if (group) assert.ok(s.groups.length && s.groups.every((g) => g.kind === group), name);
    assert.ok(s.edges.some((e) => e.kind === edge), name);
    assert.ok(s.edges.every((e, i) => e.id === `e${i + 1}` && Number.isInteger(e.order)), `${name}: every edge id'd and ordered`);
    assert.equal(s.views.vr.enabled, true, name);
  }
  const seq = expand('sequence');
  assert.deepEqual(seq.views.time, { axis: 'order', step: 'beat', playhead: null, motion: 'still' });
  assert.ok(seq.edges.every((e) => e.kind === 'message' && e.directed && e.route === 'straight'));
  assert.deepEqual(seq.edges.map((e) => e.variant), ['solid', 'solid', 'solid', 'dashed', 'dashed', 'dashed'], "'-->' draws a dashed reply");
  assert.equal(seq.nodes[0].kind, 'person');
  const life = expand('lifecycle');
  assert.deepEqual(life.nodes.map((n) => [n.id, n.tags, n.shape]), [['planned', ['initial'], 'pill'], ['running', [], 'pill'], ['analysed', [], 'pill'], ['aborted', ['final'], 'pill'], ['published', ['final'], 'pill']]);
  assert.equal(life.views['2d'].direction, 'right');
  const auto = sketch.expandSketch({ schema_version: 'dotfield.sketch/1', type: 'lifecycle', title: 'Door', nodes: ['open', 'closed'], edges: ['open -> closed'] }, { now: NOW, name: 'door' });
  assert.deepEqual(auto.nodes.map((n) => n.tags), [['initial'], ['final']], 'first and last state are tagged when the sketch tags none');
  assert.equal(expand('dataflow').views['2d'].direction, 'right');
  assert.ok(expand('dataflow').edges.every((e) => e.variant === 'flow'));
  assert.equal(expand('workflow').views['2d'].direction, 'right', 'a sketch direction wins');
  const tl = expand('timeline');
  assert.deepEqual(tl.nodes.map((n) => n.provenance.happened_on), ['2026-01-15', '2026-03-02', '2026-05-11', '2026-08-03', '2026-11-20']);
  assert.deepEqual(tl.views.time, { axis: 'date', field: 'happened_on', step: 'month', playhead: null, cumulative: true, motion: 'still' });
  assert.equal(tl.views['3d'].layout, 'tier-wall');
  const room = expand('room');
  assert.deepEqual(room.views['3d'], { layout: 'metric', scale_m: 1 });
  assert.deepEqual(room.nodes[0].pose_m, { xyz: [-2, 0.4, 0], rpy: [0, 0, 0] });
  for (const g of room.groups) {
    assert.equal(g.wraps, undefined);
    for (const n of room.nodes.filter((x) => x.group === g.id)) for (const k of [0, 2]) assert.ok(Math.abs(n.pose_m.xyz[k] - g.center_xyz_m[k]) <= g.size_xyz_m[k] / 2, `${n.id} inside ${g.id}`);
  }
  const custom = expand('custom-kind');
  assert.deepEqual(Object.keys(custom.ext.kinds), ['x-rig']);
  assert.equal(custom.nodes.filter((n) => n.kind === 'x-rig').length, 2);
  const timed = sketch.expandSketch({ ...tpl('dataflow'), time: { motion: 'trace' } }, { now: NOW, name: 'df' });
  assert.deepEqual(timed.views.time, { motion: 'trace', axis: 'order', step: 'beat' }, 'an authored time block is completed with the axis default');
});

test('DF_IMPORT_SKETCH_INVALID names the path of every field the expansion cannot use', () => {
  const base = { schema_version: 'dotfield.sketch/1', type: 'graph', title: 'T', nodes: ['a', 'b'], edges: ['a -> b'] };
  const paths = (doc) => sketch.sketchProblems(doc).map((c) => [c.code, c.path, c.blocking]);
  assert.deepEqual(paths(base), []);
  const cases = [
    [{ ...base, nodes: ['a', 'b', 7] }, '$.nodes[2]'],
    [{ ...base, nodes: ['a', 'b', 'x: y'] }, '$.nodes[2]'],
    [{ ...base, nodes: ['a', 'A'] }, '$.nodes[1]'],
    [{ ...base, edges: ['a -> c'] }, '$.edges[0]'],
    [{ ...base, edges: ['a => b'] }, '$.edges[0]'],
    [{ ...base, edges: [{ from: 'a', to: 'zz' }] }, '$.edges[0].to'],
    [{ ...base, edges: [{ from: 'a', to: 'b', colour: 'red' }] }, '$.edges[0].colour'],
    [{ ...base, groups: { g: ['a'], h: ['a'] } }, '$.groups["h"][0]'],
    [{ ...base, groups: { g: ['nope'] } }, '$.groups["g"][0]'],
    [{ ...base, nodes: ['a', { id: 'b', pose: [0, 0, 0] }] }, '$.nodes[1]'],
    [{ ...base, type: 'room', nodes: [{ id: 'a', pose: [0, 0, 0] }, 'b'] }, '$.nodes[1]'],
    [{ ...base, nodes: ['a', { id: 'b', kind: 'boundary' }] }, '$.nodes[1].kind'],
    [{ ...base, kinds: { 'x-rig': { glyph2d: 'blob', primitive3d: 'box', size_mult: 1, label_anchor: 'below' } } }, '$.kinds["x-rig"].glyph2d'],
    [{ ...base, type: 'mindmap' }, '$.type'],
    [{ ...base, extra: true }, '$.extra'],
  ];
  for (const [doc, path] of cases) {
    const got = paths(doc);
    assert.ok(got.some(([code, p, blocking]) => code === 'DF_IMPORT_SKETCH_INVALID' && p === path && blocking === true), `${path}: ${JSON.stringify(got)}`);
  }
  assert.throws(() => sketch.expandSketch({ ...base, edges: ['a -> c'] }, { now: NOW }), /expandSketch: 1 problem/);
  const r = sketch.run({ name: 'bad.sketch.json', doc: { ...base, edges: ['a -> c'] } }, { now: NOW });
  assert.equal(r.ok, false); assert.equal(r.scene, null);
  assert.deepEqual(fails(r.checks).map((c) => c.code), ['DF_IMPORT_SKETCH_INVALID']);
});

test('render <template> with no out path: exit 0, 0 fail, written inside .dotfield/renders/, the sketch is the input and scene.json the expanded scene', async () => {
  await withTmp(async (dir) => {
    cpSync(TEMPLATES, join(dir, 'templates'), { recursive: true });
    const r = runCli(['render', 'templates/architecture.sketch.json', '--view', 'all', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(fails(r.json.checks), []);
    assert.equal(r.json.inputs[0].ref, 'templates/architecture.sketch.json');
    assert.ok(r.json.checks.some((c) => c.code === 'DF_IMPORT_SKETCH_INVALID' && c.status === 'pass'));
    const html = r.json.outputs.find((o) => o.kind === 'html');
    assert.match(html.ref, /^\.dotfield\/renders\/workflow-telemetry-\d{8}T\d{6}Z\/out\.html$/);
    assert.equal(html.embedded_three, false, 'the default self render uses the pinned CDN importmap');
    const page = readFileSync(join(dir, html.ref), 'utf8');
    const urls = page.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    assert.ok(urls.length > 0 && urls.every((u) => u.startsWith('https://cdn.jsdelivr.net/npm/three@0.180.0/')), 'jsdelivr is the only origin');
    const scene = read(join(dir, r.json.outputs.find((o) => o.kind === 'scene').ref));
    assert.equal(scene.kind, 'workflow'); assert.equal(scene.laid_out, true);
    assert.equal(scene.ext.sketch.name, 'architecture'); assert.equal(scene.meta.privacy_mode, 'synthetic_data');
    const out = runCli(['render', 'templates/architecture.sketch.json', 'out.html', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(out.code, 0);
    assert.deepEqual(fails(out.json.checks).map((c) => [c.code, c.blocking]), [['DF_RENDER_SELF_VIEW_EXPORTED', false]], 'a sketch is synthetic, and a self render outside .dotfield/ still warns');
    writeFileSync(join(dir, 'templates', 'broken.sketch.json'), JSON.stringify({ schema_version: 'dotfield.sketch/1', type: 'graph', title: 'T', nodes: ['a'], edges: ['a -> b'] }));
    const bad = runCli(['render', 'templates/broken.sketch.json', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(bad.code, 2);
    assert.deepEqual(fails(bad.json.checks).map((c) => [c.code, c.path]), [['DF_IMPORT_SKETCH_INVALID', '$.edges[0]']]);
    assert.equal(bad.json.outputs.length, 0, 'nothing is written');
  });
});

test('every template renders at --quality showcase with --view all: exit 0, no fail row of any kind, and an x- kind reaches the 3D config', async () => {
  await withTmp(async (dir) => {
    for (const name of NAMES) {
      const { receipt } = await dispatch(['render', join(TEMPLATES, `${name}.sketch.json`), '--view', 'all', '--quality', 'showcase', '--no-embed-three', '--json'], { cwd: dir, env: env(), stdin: null, stdout: null });
      assert.equal(receipt.exit_code, 0, `${name}: ${JSON.stringify(fails(receipt.checks))}`);
      assert.deepEqual(fails(receipt.checks), [], name);
      assert.ok(!receipt.checks.some((c) => c.code === 'DF_RENDER_VIEW_DISABLED' && c.status === 'fail'), `${name}: every tab renders`);
      if (name !== 'custom-kind') continue;
      const page = readFileSync(join(dir, receipt.outputs.find((o) => o.kind === 'html').ref), 'utf8');
      const cfg = JSON.parse(/<script type="application\/json" data-df="config">([\s\S]*?)<\/script>/.exec(page)[1]);
      assert.deepEqual(cfg.shapes['x-rig'], { primitive3d: 'box' }, 'the x- kind keeps its 3D primitive in the browser');
      assert.ok(page.includes('shapes: cfg.shapes'), 'the bootstrap hands the kinds table to mount3d');
    }
  });
});

test('kindsFor merges shapes.json <- installed packs <- center/kinds.json <- sketch kinds; an invalid kinds.json is DF_SCHEMA_* and adds no row', async () => {
  await withTmp(async (dir) => {
    const centerDir = join(dir, 'center'); mkdirSync(centerDir);
    writeFileSync(join(centerDir, 'kinds.json'), JSON.stringify({ schema_version: 'dotfield.kinds/1', 'x-rig': { glyph2d: 'star', primitive3d: 'box', size_mult: 1, label_anchor: 'below' }, 'x-bench': { glyph2d: 'square', primitive3d: 'box', size_mult: 2, label_anchor: 'below' } }));
    const ctx = { packageRoot: ROOT, centerDir, config: { installed_packs: [{ id: 'robotics-lab' }] }, env: {} };
    const t = kindsTable(ctx, { sketchKinds: { 'x-bench': { glyph2d: 'pin', primitive3d: 'cone', size_mult: 1, label_anchor: 'left' } } });
    assert.deepEqual(t.checks, []);
    assert.deepEqual(t.sources, ['renderers/shapes.json', 'packs/robotics-lab/kinds.json', 'center/kinds.json', '$.ext.kinds']);
    assert.equal(t.kinds.record.glyph2d, 'circle'); assert.equal(t.kinds['x-sensor'].glyph2d, 'diamond');
    assert.equal(t.kinds['x-rig'].glyph2d, 'star', 'center/kinds.json over the pack'); assert.equal(t.kinds['x-bench'].glyph2d, 'pin', 'the sketch over the center');
    assert.equal(kindsFor(ctx), kindsFor(ctx), 'memoised per context');
    assert.equal(kindsFor({ packageRoot: ROOT })['x-rig'], undefined, 'no pack installed, no pack kinds');
    writeFileSync(join(centerDir, 'kinds.json'), JSON.stringify({ schema_version: 'dotfield.kinds/1', 'x-bad': { glyph2d: 'blob', primitive3d: 'box', size_mult: 1, label_anchor: 'below' }, record: {} }));
    const bad = kindsTable({ ...ctx, config: null });
    assert.deepEqual(bad.checks.map((c) => [c.code, c.path]), [['DF_SCHEMA_ENUM', 'center/kinds.json#$["x-bad"].glyph2d'], ['DF_SCHEMA_UNKNOWN_FIELD', 'center/kinds.json#$.record']]);
    assert.equal(bad.kinds['x-bad'], undefined);
    cpSync(join(TEMPLATES, 'graph.sketch.json'), join(dir, 'graph.sketch.json'));
    const r = runCli(['render', 'graph.sketch.json', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(r.code, 2, 'a broken kinds.json blocks the render with its own code and path');
    assert.ok(fails(r.json.checks).some((c) => c.code === 'DF_SCHEMA_ENUM' && c.path.startsWith('center/kinds.json#')));
  });
});

test('inline kinds ride in ext.kinds: they make an x- kind known to the gates; an invalid block is DF_SCHEMA_* at $.ext.kinds', async () => {
  await withTmp(async (dir) => {
    const ctx = createContext({ cwd: dir, env: env() });
    const gctx = gateContext(ctx, { viewer: 'self' });
    assert.equal(gctx.shapes.record.glyph2d, 'circle', 'every gate context carries the kinds table');
    assert.equal(gctx.theme, undefined, 'no theme unless the context names one');
    assert.equal(gateContext({ ...ctx, theme: 'paper' }).theme, 'paper');
    const s = expand('custom-kind');
    assert.deepEqual(fails(runGates(s, gctx, IR_ORDER).checks), []);
    assert.equal(withSceneKinds(s, gctx).ctx.shapes['x-rig'].size_mult, 1.3);
    const { kinds: _k, ...extNoKinds } = s.ext;
    assert.ok(fails(runGates({ ...s, ext: extNoKinds }, gctx, IR_ORDER).checks).some((c) => c.code === 'DF_IR_KIND_UNKNOWN'), 'without the block x-rig is unknown');
    const broken = { ...s, ext: { ...s.ext, kinds: { 'x-rig': { ...s.ext.kinds['x-rig'], glyph2d: 'blob' } } } };
    const r = runGates(broken, gctx, IR_ORDER);
    assert.equal(r.blocked, true); assert.equal(r.stopped_at, 'schema');
    assert.deepEqual(fails(r.checks).map((c) => [c.code, c.path]), [['DF_SCHEMA_ENUM', '$.ext.kinds["x-rig"].glyph2d']]);
    const paper = renderSvg(sketch.expandSketch({ ...tpl('architecture'), theme: 'paper' }, { now: NOW, name: 'a' }), ctx.tokens().css);
    assert.match(paper, /data-theme="paper"/);
  });
});

test('npm run demo renders every template --view all into .dotfield/demo/ with a standalone index.html', async () => {
  await withTmp(async (dir) => {
    const r = await runDemo({ cwd: dir, env: env() });
    assert.equal(r.ok, true, JSON.stringify(r.rows.filter((x) => x.exit !== 0)));
    assert.deepEqual(r.rows.map((x) => x.name), NAMES);
    assert.ok(r.rows.every((x) => x.failed === 0 && existsSync(x.html)));
    assert.deepEqual(readdirSync(join(dir, '.dotfield', 'demo')).sort(), [...NAMES.map((n) => `${n}.html`), 'index.html'].sort());
    const index = readFileSync(r.index, 'utf8');
    for (const n of NAMES) assert.ok(index.includes(`href="${n}.html"`), n);
    assert.ok(!/https?:\/\//.test(index), 'the index makes no external request');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(index.replace(/<style data-df="tokens">[\s\S]*?<\/style>/, '')), 'colours are tokens');
  });
});

test('templates/ is fork-editable: the engine manifest never hashes it', () => {
  assert.ok(isForkEditableFile('templates/architecture.sketch.json'));
  assert.ok(!isForkEditableFile('templates.json') && !isForkEditableFile('lib/templates/x.mjs'));
  const m = buildManifest(ROOT);
  assert.ok(!Object.keys(m.files).some((f) => f.startsWith('templates/')));
  assert.ok(m.excluded.includes('templates/**'));
  assert.ok(m.files['importers/sketch.mjs'] && m.files['schemas/sketch.schema.json'] && m.files['schemas/kinds.schema.json']);
});
