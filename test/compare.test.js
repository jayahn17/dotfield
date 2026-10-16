// dotfield compare (V2_PLAN §11 compare): lib/delta.mjs pairs and classifies,
// the after viewBox only grows, the delta block validates in the scene and as
// delta.json, svg-delta draws only when a delta exists, and the CLI writes a
// gated before/after page under .dotfield/compares/ — or refuses two kinds,
// unstable ids and a blocked input. Fixtures: the hand-authored pair under
// test/fixtures/compare/ and archify's checkout-platform base/head when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { NOW_ISO, scaffoldCenter } from './helpers/center.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { createStore } from '../lib/store.mjs';
import { ROOT, runCli } from './helpers/cli.mjs';
import { CLAIMS, MOVE_EPS_PX, countsLine, deltaDocument, diffScenes, edgeKeys, growViewBox, pairEdges, unpairedRatio, withDelta } from '../lib/delta.mjs';
import { resolvePointer, validateAgainst } from '../lib/validate.mjs';
import { FAMILIES, PINNED, RULES, codesForFamily } from '../lib/rules.mjs';
import { listVerbs, loadCommand } from '../bin/dotfield.mjs';
import { DERIVED_RE } from '../lib/commands/delete.mjs';
import { HEX_RE, motionLoops } from '../lib/gates/render.mjs';
import { renderSvg } from '../renderers/svg.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'compare');
const ARCHIFY = join(ROOT, 'test', 'fixtures', 'archify');
const TOKENS = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const EPOCH = { SOURCE_DATE_EPOCH: '1760000000' };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pair = () => [readJson(join(FIX, 'before.json')), readJson(join(FIX, 'after.json'))];
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const row = (delta, id, list = 'nodes') => delta[list].find((r) => r.id === id);
const failsOf = (checks) => checks.filter((c) => c.status === 'fail');
const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[0] + outer[2] >= inner[0] + inner[2] && outer[1] + outer[3] >= inner[1] + inner[3];

test('the fixture pair: nodes pair by id, edges by id then (from, to, kind); every row classified with its axes', () => {
  const [before, after] = pair();
  const copy = JSON.stringify([before, after]);
  const { delta, checks } = diffScenes(before, after, { before: { ref: 'before.json', digest: `sha256:${'a'.repeat(64)}` } });
  assert.equal(JSON.stringify([before, after]), copy, 'diffScenes never mutates its inputs');
  assert.deepEqual(delta.counts, { nodes: { added: 1, removed: 1, changed: 2, moved: 1, same: 1 }, edges: { added: 2, removed: 2, changed: 1, moved: 0, same: 2 } });
  assert.deepEqual(delta.pairs, { nodes: 4, edges: 3, edges_by_endpoints: 1 });
  assert.equal(delta.unpaired_ratio, 0.2);
  assert.equal(delta.claims, CLAIMS);
  assert.deepEqual(delta.before, { ref: 'before.json', digest: `sha256:${'a'.repeat(64)}` });
  assert.equal(delta.after.ref, 'after', 'an unnamed input is the side name with the canonical scene digest');
  assert.deepEqual(row(delta, 'bag'), { id: 'bag', change: 'same', axes: [], label: 'Rosbag capture' });
  assert.deepEqual(row(delta, 'ingest').axes, ['semantic', 'topology'], 'label changed, and edges it touches were added and removed');
  assert.deepEqual(row(delta, 'sync'), { id: 'sync', change: 'moved', axes: ['geometry'], from: [1100, 300], label: 'Time sync' });
  assert.deepEqual(row(delta, 'store'), { id: 'store', change: 'added', axes: [], label: 'Parquet store' });
  assert.deepEqual(row(delta, 'report').axes, ['topology']);
  assert.deepEqual(row(delta, 'cache'), { id: 'cache', change: 'removed', axes: [], from: [700, 650], label: 'Frame cache', kind: 'record' });
  assert.deepEqual(delta.nodes.map((r) => r.id), ['bag', 'ingest', 'sync', 'store', 'report', 'cache'], 'after order, then the removed in before order');
  assert.deepEqual(row(delta, 'e2', 'edges'), { id: 'e2', change: 'changed', axes: ['semantic'] });
  assert.deepEqual(row(delta, 'sync~report~flow~0', 'edges'), { id: 'sync~report~flow~0', change: 'same', axes: [] });
  assert.deepEqual(row(delta, 'e4', 'edges'), { id: 'e4', change: 'removed', axes: [], ends: ['cache', 'report'] });
  const paired = failsOf(checks);
  assert.equal(paired.length, 1);
  assert.equal(paired[0].code, 'DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS');
  assert.equal(paired[0].blocking, false);
  assert.equal(paired[0].path, '$.edges[3]');
  assert.deepEqual(checks.filter((c) => c.status === 'pass').map((c) => c.code), ['DF_DELTA_KIND_MISMATCH', 'DF_DELTA_NO_STABLE_IDS']);
  assert.equal(countsLine(delta), 'nodes 1 added, 1 removed, 2 changed, 1 moved, 1 same; edges 2 added, 2 removed, 1 changed, 0 moved, 2 same');
});

test('each field family moves exactly its axis; sub-pixel drift is not a move; the import envelope is not a provenance change', () => {
  const [before] = pair();
  const variant = (fn) => { const a = structuredClone(before); fn(a); return row(diffScenes(before, a).delta, 'bag'); };
  const bag = (a) => a.nodes.find((n) => n.id === 'bag');
  assert.deepEqual(variant((a) => { bag(a).color_token = 'accent'; }), { id: 'bag', change: 'changed', axes: ['presentation'], label: 'Rosbag capture' });
  assert.deepEqual(variant((a) => { bag(a).audience = { privacy_level: 'public', share_rule_ids: [] }; }).axes, ['scope']);
  assert.deepEqual(variant((a) => { bag(a).evidence_ids = ['ev-9']; }).axes, ['evidence']);
  assert.deepEqual(variant((a) => { bag(a).tags = ['x']; }).axes, ['semantic']);
  assert.deepEqual(variant((a) => { bag(a).provenance.owner_person_id = 'ada'; }).axes, ['provenance']);
  assert.deepEqual(variant((a) => { a.groups = [{ id: 'g', label: 'G', kind: 'zone', wraps: ['bag'] }]; }).axes, ['topology']);
  assert.equal(variant((a) => { a.positions.bag = [300 + MOVE_EPS_PX / 2, 300]; }).change, 'same');
  const shifted = variant((a) => { a.positions.bag = [305, 300]; bag(a).label = 'Bag'; });
  assert.deepEqual([shifted.change, shifted.axes, shifted.from], ['changed', ['semantic', 'geometry'], [300, 300]], 'changed and moved: from is still recorded');
  const imported = (ref, digest, day) => { const s = structuredClone(before); for (const n of s.nodes) n.provenance = { ...n.provenance, source: { kind: 'import', ref, digest }, captured_on: day }; return s; };
  const d = diffScenes(imported('import:a.json', `sha256:${'1'.repeat(64)}`, '2026-10-01'), imported('import:b.json', `sha256:${'2'.repeat(64)}`, '2026-10-08')).delta;
  assert.equal(d.counts.nodes.same, 5, 'two imports of one diagram differ only in file, digest and day');
});

test('edge pairing: by id, then id-less by (from, to, kind) in scene order; two different ids never pair; keys are stable', () => {
  const e = (id, from, to, kind = 'flow', label) => ({ ...(id ? { id } : {}), from, to, kind, directed: true, variant: 'solid', route: 'auto', ...(label ? { label } : {}) });
  const before = { edges: [e(null, 'a', 'b', 'flow', 'one'), e(null, 'a', 'b', 'flow', 'two'), e('x', 'a', 'c'), e(null, 'b', 'c')] };
  const after = { edges: [e(null, 'a', 'b', 'flow', 'two'), e('y', 'a', 'c'), e('z', 'b', 'c')] };
  const r = pairEdges(before, after);
  assert.deepEqual(r.pairs, [[0, 0, true], [3, 2, true]], 'parallel id-less edges pair in order (labels may swap: the repair says so); an id on one side still pairs');
  assert.deepEqual(r.removed, [1, 2], 'x and y carry different ids, so x is removed and y added');
  assert.deepEqual(r.added, [1]);
  assert.deepEqual(edgeKeys(before), ['a~b~flow~0', 'a~b~flow~1', 'x', 'b~c~flow~0']);
  assert.ok(edgeKeys(before).every((k) => !HEX_RE.test(`"${k}"`)), 'no key can read as a hex colour in an attribute');
});

test('the after viewBox grows to cover every from and never shrinks', () => {
  const [before, after] = pair();
  const { delta } = diffScenes(before, after);
  assert.equal(growViewBox(after, delta).grown_from, null, 'every from already inside: unchanged');
  assert.equal(withDelta(after, delta).delta.viewbox_grown_from, undefined);
  const far = structuredClone(before);
  far.positions.cache = [2400, 1500];
  const d2 = diffScenes(far, after).delta;
  const grown = withDelta(after, d2);
  const vb = grown.views['2d'].viewBox;
  assert.deepEqual(grown.delta.viewbox_grown_from, [0, 0, 1600, 1000]);
  assert.ok(contains(vb, [0, 0, 1600, 1000]), 'never shrinks');
  assert.ok(contains(vb, [2400 - 48, 1500 - 48, 96, 96]), `covers the far ghost with the layout spacing around it: ${vb}`);
  assert.equal(Object.keys(grown.delta).at(-1), 'claims');
  const big = structuredClone(after);
  big.views['2d'].viewBox = [-500, -500, 5000, 4000];
  assert.equal(growViewBox(big, d2).grown_from, null, 'a box that already covers everything is kept as is');
  assert.deepEqual(growViewBox(big, d2).scene.views['2d'].viewBox, [-500, -500, 5000, 4000]);
});

test('two kinds and unstable ids are refused; the unpaired ratio is measured on the smaller scene', () => {
  const [before, after] = pair();
  const mismatch = diffScenes(before, { ...after, kind: 'graph' });
  assert.equal(mismatch.delta, null);
  assert.deepEqual(failsOf(mismatch.checks).map((c) => [c.code, c.blocking]), [['DF_DELTA_KIND_MISMATCH', true]]);
  const renamed = structuredClone(after);
  for (const n of renamed.nodes) n.id = `v2-${n.id}`;
  renamed.edges = [];
  renamed.positions = Object.fromEntries(Object.entries(after.positions).map(([k, v]) => [`v2-${k}`, v]));
  const r = diffScenes(before, renamed);
  assert.equal(r.delta.unpaired_ratio, 1);
  assert.ok(r.checks.some((c) => c.code === 'DF_DELTA_NO_STABLE_IDS' && c.status === 'fail' && c.blocking));
  assert.equal(unpairedRatio(0, 0, 9), 0, 'an empty side needs no stable ids');
  assert.equal(unpairedRatio(2, 2, 40), 0, 'growth alone never reads as unstable');
  assert.equal(unpairedRatio(1, 4, 5), 0.75);
});

/** A schema node with every $ref replaced by its target (siblings kept), so two files can be compared by shape. */
function resolved(node, root, depth = 0) {
  if (Array.isArray(node)) return node.map((x) => resolved(x, root, depth));
  if (!node || typeof node !== 'object') return node;
  const { $ref, ...rest } = node;
  const base = typeof $ref === 'string' && depth < 20 ? resolved(resolvePointer(root, $ref), root, depth + 1) : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(rest)) out[k] = resolved(v, root, depth);
  return out;
}

test('the delta block validates in the scene schema and as delta.json; both declarations resolve to one shape', () => {
  const [before, after] = pair();
  const scene = withDelta(after, diffScenes(before, after).delta);
  assert.equal(validateAgainst('scene', scene).ok, true, JSON.stringify(validateAgainst('scene', scene).errors));
  assert.equal(validateAgainst('delta', deltaDocument(scene.delta)).ok, true);
  const bad = structuredClone(scene);
  bad.delta.claims = 'low risk';
  assert.equal(validateAgainst('scene', bad).errors[0].path, '$.delta.claims', 'claims is the constant "no risk assessment"');
  bad.delta.claims = CLAIMS; bad.delta.nodes[0].verdict = 'safe';
  assert.ok(!validateAgainst('scene', bad).ok, 'closed: a delta row cannot carry a verdict');
  const sceneSchema = readJson(join(ROOT, 'schemas', 'scene.schema.json'));
  const deltaSchema = readJson(join(ROOT, 'schemas', 'delta.schema.json'));
  const a = resolved(sceneSchema.$defs.delta, sceneSchema);
  const b = resolved(deltaSchema, deltaSchema);
  const { schema_version: version, ...props } = b.properties;
  assert.deepEqual(version, { const: 'dotfield.delta/1' });
  assert.deepEqual(props, a.properties);
  assert.deepEqual(b.required, ['schema_version', ...a.required]);
});

test('svg: a delta adds classes, rings, ghosts, move connectors, halos and a legend; a scene without one draws none of it', () => {
  const [before, after] = pair();
  const scene = withDelta(after, diffScenes(before, after).delta);
  const svg = renderSvg(scene, TOKENS);
  assert.match(svg, /data-node-id="store"[^>]*/);
  assert.match(svg, /class="df-node df-node--record df-added"/);
  assert.match(svg, /class="df-node df-node--asset df-moved"[^>]*data-node-id="sync"/);
  assert.match(svg, /class="df-node df-node--asset df-changed"[^>]*data-node-id="ingest"/);
  assert.match(svg, /<g class="df-ghost df-removed" data-delta-node="cache" data-kind="record" transform="translate\(700 650\)">/);
  assert.doesNotMatch(svg, /data-node-id="cache"/, 'a ghost is never a selectable node');
  assert.equal((svg.match(/class="df-delta-move"/g) || []).length, 1);
  assert.equal((svg.match(/class="df-delta-ghost-edge"/g) || []).length, 2, 'both removed edges, drawn to the ghost');
  assert.equal((svg.match(/class="df-delta-halo df-delta-halo--added"/g) || []).length, 2);
  assert.match(svg, /<g class="df-delta-legend"[^]*no risk assessment/);
  assert.doesNotMatch(svg, /data-delta-edge="[^"]*#|data-edge-id="~/, 'delta marks never pose as edges');
  assert.equal([...svg.matchAll(HEX_RE)].length, 0, 'tokens only');
  assert.deepEqual(motionLoops('', svg), [], 'no animation of any kind');
  assert.equal(renderSvg(scene, TOKENS), svg, 'deterministic');
  const plain = renderSvg(after, TOKENS);
  for (const mark of ['df-delta', 'class="df-ghost', 'data-delta', 'df-added', 'df-moved', 'df-changed']) assert.ok(!plain.includes(mark), `no ${mark} without a delta`);
  for (const golden of readdirSync(join(ROOT, 'test', 'fixtures', 'golden')).filter((f) => f.endsWith('.svg'))) {
    assert.ok(!readFileSync(join(ROOT, 'test', 'fixtures', 'golden', golden), 'utf8').includes('df-delta'), `${golden} carries no delta mark`);
  }
});

function seed(dir, files) {
  for (const [name, value] of Object.entries(files)) writeJson(join(dir, name), value);
}

test('CLI: the fixture pair compares with exit 0 into .dotfield/compares/<slug>-<ts>/, deterministically', async () => {
  const runs = [];
  for (let k = 0; k < 2; k += 1) {
    await withTmp(async (dir) => {
      cpSync(FIX, dir, { recursive: true });
      const r = runCli(['compare', 'before.json', 'after.json', '--json'], { cwd: dir, env: EPOCH });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.json.exit_code, 0);
      assert.equal(r.json.release_tag, 'v1.1-provisional');
      assert.match(r.json.next_action, /^Compared nodes 1 added, 1 removed, 2 changed, 1 moved, 1 same; edges 2 added, 2 removed, 1 changed, 0 moved, 2 same; no risk assessment\./);
      assert.deepEqual(r.json.inputs.map((i) => i.ref), ['before.json', 'after.json']);
      assert.deepEqual(r.json.outputs.map((o) => o.kind), ['html', 'svg', 'scene', 'delta']);
      const folder = r.json.outputs[0].ref.replace(/\/out\.html$/, '');
      assert.match(folder, /^\.dotfield\/compares\/telemetry-pipeline-20251009T085320Z$/);
      assert.ok(DERIVED_RE.test(`${folder}/out.html`), 'the delete sweep removes compares');
      const codes = r.json.checks.filter((c) => c.status === 'fail').map((c) => c.code);
      assert.deepEqual(codes, ['DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS'], 'laid-out inputs: no cold-layout note');
      const scene = readJson(join(dir, folder, 'scene.json'));
      const delta = readJson(join(dir, folder, 'delta.json'));
      assert.equal(validateAgainst('scene', scene).ok, true);
      assert.equal(validateAgainst('delta', delta).ok, true);
      assert.deepEqual(delta, deltaDocument(scene.delta));
      assert.equal(delta.before.ref, 'before.json');
      assert.equal(delta.before.digest, r.json.inputs[0].digest);
      assert.equal(scene.receipt.receipt_id, r.json.receipt_id, 'the embedded receipt summary names this receipt');
      assert.ok(existsSync(join(dir, folder, 'receipt.json')));
      const html = readFileSync(join(dir, folder, 'out.html'), 'utf8');
      assert.match(html, /df-ghost df-removed/);
      runs.push(['out.html', 'out.svg', 'scene.json', 'delta.json'].map((f) => readFileSync(join(dir, folder, f), 'utf8')));
    });
  }
  assert.deepEqual(runs[0], runs[1], 'two compares under one SOURCE_DATE_EPOCH are byte-identical');
});

test('CLI: un-laid-out inputs are laid out cold and say so; a far ghost grows the written viewBox; refs never carry an absolute path', async () => {
  await withTmp(async (dir) => {
    const [before, after] = pair();
    for (const s of [before, after]) { delete s.positions; delete s.laid_out; }
    const inputs = join(dir, 'elsewhere');
    const root = join(dir, 'root');
    mkdirSync(inputs); mkdirSync(root);
    seed(inputs, { 'before.json': before, 'after.json': after });
    const r = runCli(['compare', join(inputs, 'before.json'), join(inputs, 'after.json'), '--json'], { cwd: root, env: EPOCH });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const cold = r.json.checks.filter((c) => c.code === 'DF_DELTA_LAID_OUT_COLD' && c.status === 'fail');
    assert.equal(cold.length, 2);
    assert.ok(cold.every((c) => c.blocking === false && /laid out cold in mode force with seed 0/.test(c.message)));
    const delta = readJson(join(root, r.json.outputs.find((o) => o.kind === 'delta').ref));
    assert.deepEqual([delta.before.ref, delta.after.ref], ['before.json', 'after.json'], 'an input outside the root is named by its file name');
  });
  await withTmp(async (dir) => {
    const [before, after] = pair();
    before.positions.cache = [2400, 1500];
    before.views['2d'].viewBox = [0, 0, 2600, 1700];
    seed(dir, { 'before.json': before, 'after.json': after });
    const r = runCli(['compare', 'before.json', 'after.json', '--json'], { cwd: dir, env: EPOCH });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.json.next_action, /The after viewBox grew to cover the before positions\./);
    const scene = readJson(join(dir, r.json.outputs.find((o) => o.kind === 'scene').ref));
    assert.deepEqual(scene.delta.viewbox_grown_from, [0, 0, 1600, 1000]);
    assert.ok(contains(scene.views['2d'].viewBox, [0, 0, 1600, 1000]) && contains(scene.views['2d'].viewBox, [2400, 1500, 0, 0]));
    const svg = readFileSync(join(dir, r.json.outputs.find((o) => o.kind === 'svg').ref), 'utf8');
    const vb = /viewBox="([^"]+)"/.exec(svg)[1].split(' ').map(Number);
    assert.ok(contains(vb, [2400, 1500, 0, 0]), 'the drawn SVG holds the ghost');
  });
});

test('CLI refusals: two kinds, unstable ids, a blocked input, a missing file, a missing argument', async () => {
  await withTmp(async (dir) => {
    const [before, after] = pair();
    const graph = { ...structuredClone(after), kind: 'graph' };
    const renamed = structuredClone(after);
    for (const n of renamed.nodes) n.id = `v2-${n.id}`;
    renamed.edges = [];
    renamed.positions = Object.fromEntries(Object.entries(after.positions).map(([k, v]) => [`v2-${k}`, v]));
    const dangling = structuredClone(after);
    dangling.edges.push({ id: 'e9', from: 'store', to: 'nowhere', kind: 'flow', directed: true, variant: 'solid', route: 'auto' });
    seed(dir, { 'before.json': before, 'graph.json': graph, 'renamed.json': renamed, 'dangling.json': dangling });
    const blockedBy = (args, code) => {
      const r = runCli(['compare', ...args, '--json'], { cwd: dir, env: EPOCH });
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.equal(r.json.status, 'blocked');
      assert.deepEqual(r.json.outputs, [], 'nothing written but the receipt');
      const hit = r.json.checks.find((c) => c.code === code && c.status === 'fail');
      assert.ok(hit && hit.blocking, `${code} in ${JSON.stringify(r.json.checks.filter((c) => c.status === 'fail'))}`);
      return hit;
    };
    assert.match(blockedBy(['before.json', 'graph.json'], 'DF_DELTA_KIND_MISMATCH').message, /before\.json is workflow, graph\.json is graph/);
    assert.match(blockedBy(['before.json', 'renamed.json'], 'DF_DELTA_NO_STABLE_IDS').message, /unpaired ratio 1/);
    const hit = blockedBy(['before.json', 'dangling.json'], 'DF_DELTA_INPUT_BLOCKED');
    assert.equal(hit.path, 'dangling.json');
    assert.match(hit.message, /after: DF_IR_DANGLING_EDGE at \$\.edges\[5\]\.to/);
    const missing = blockedBy(['nope.json', 'before.json'], 'DF_DELTA_INPUT_BLOCKED');
    assert.match(missing.message, /before: DF_SCHEMA_REQUIRED/);
    const usage = runCli(['compare', 'before.json', '--json'], { cwd: dir, env: EPOCH });
    assert.equal(usage.code, 1);
    assert.match(usage.json.next_action, /^usage: dotfield compare <before> <after>/);
  });
});

test('CLI: archify checkout-platform base/head (or the local pair when the corpus is absent) compare with exit 0 across every view', async () => {
  const base = join(ARCHIFY, 'checkout-platform.base.architecture.json');
  const head = join(ARCHIFY, 'checkout-platform.head.architecture.json');
  const files = existsSync(base) && existsSync(head) ? [base, head] : [join(FIX, 'before.json'), join(FIX, 'after.json')];
  await withTmp(async (dir) => {
    const r = runCli(['compare', ...files, '--view', 'all', '--json'], { cwd: dir, env: EPOCH });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const delta = readJson(join(dir, r.json.outputs.find((o) => o.kind === 'delta').ref));
    assert.equal(validateAgainst('delta', delta).ok, true);
    if (files[0] === base) {
      assert.equal(row(delta, 'fraud').change, 'added');
      assert.deepEqual([row(delta, 'cache').change, row(delta, 'cache').kind], ['removed', 'asset']);
      assert.equal(row(delta, 'authorize-payment', 'edges').change, 'changed', 'payments is now authorised by the fraud gate');
      assert.ok(row(delta, 'authorize-payment', 'edges').axes.includes('topology'));
      assert.equal(delta.counts.nodes.same + delta.counts.nodes.changed, 7, 'every other node pairs by id');
    }
    const html = readFileSync(join(dir, r.json.outputs[0].ref), 'utf8');
    assert.match(html, /df-delta-legend/);
  });
  if (files[0] !== base) return;
  await withTmp(async (dir) => {
    const r = runCli(['compare', ...files, '--for', 'ada', '--json'], { cwd: dir, env: EPOCH });
    assert.equal(r.code, 2, 'an imported diagram compares for the owner only');
    assert.ok(r.json.checks.some((c) => c.code === 'DF_DELTA_INPUT_BLOCKED' && c.status === 'fail' && /for the owner only/.test(c.message)));
  });
});

test('CLI --for ada: both inputs projected for ada, the delta re-stamped only over verified stamps; a node ada cannot see never ghosts', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
    writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'compare-test-session-key\n');
    const [before, after] = pair();
    for (const s of [before, after]) for (const n of s.nodes) n.audience = { privacy_level: 'public', share_rule_ids: [] };
    before.nodes.find((n) => n.id === 'cache').audience.privacy_level = 'private';
    seed(c.root, { 'before.json': before, 'after.json': after });
    const r = runCli(['compare', 'before.json', 'after.json', '--for', 'ada', '--json'], { cwd: c.root, env: EPOCH });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.viewer, 'ada');
    const scene = readJson(join(c.root, r.json.outputs.find((o) => o.kind === 'scene').ref));
    assert.equal(scene.projected.viewer, 'ada');
    assert.match(scene.projected.mac, /^hmac-sha256:[0-9a-f]{64}$/);
    assert.ok(!scene.delta.nodes.some((n) => n.id === 'cache'), 'the private node is not in ada\'s before, so it is not a ghost');
    assert.ok(!readFileSync(join(c.root, r.json.outputs[0].ref), 'utf8').includes('Frame cache'));
    assert.equal(scene.delta.counts.nodes.removed, 0);
  });
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    seed(c.root, { 'before.json': pair()[0], 'after.json': pair()[1] });
    const r = runCli(['compare', 'before.json', 'after.json', '--for', 'ada', '--json'], { cwd: c.root, env: EPOCH });
    assert.equal(r.code, 2, 'no session key: nothing can be projected, so nothing is compared');
    assert.ok(r.json.checks.some((x) => x.code === 'DF_RENDER_UNPROJECTED') && r.json.checks.some((x) => x.code === 'DF_DELTA_INPUT_BLOCKED' && x.status === 'fail'));
  });
});

test('CLI room:<id>/<view>: a room view compares through the exit door, re-stamped; the same view twice is all same', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
    writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'compare-test-session-key\n');
    const room = discoverRooms(c.centerDir, { dotDir: c.dotDir }).rooms[0];
    await createStore({ room, dataDir: c.dataDir, config: c.config, env: process.env, root: c.root }).write(readJson(c.roomFile('notes', 'examples.json')), { approved: true, now: new Date(NOW_ISO), by: 'test' });
    const r = runCli(['compare', 'room:notes/graph', 'room:notes/graph', '--json'], { cwd: c.root, env: EPOCH });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const scene = readJson(join(c.root, r.json.outputs.find((o) => o.kind === 'scene').ref));
    assert.equal(scene.delta.before.ref, 'room:notes/graph');
    assert.deepEqual(Object.values(scene.delta.counts.nodes), [0, 0, 0, 0, scene.nodes.length], 'one seed, one cold layout: nothing reads as moved');
    assert.match(scene.projected.mac, /^hmac-sha256:[0-9a-f]{64}$/);
  });
});

test('catalog: the compare verb and the delta family land with PINNED 19 / 27 / 24 and the blocking policy of V2_PLAN §11', async () => {
  const verbs = listVerbs();
  assert.ok(verbs.includes('compare'));
  assert.equal(verbs.length, PINNED.cli_verbs);
  assert.deepEqual([PINNED.cli_verbs, PINNED.cli_leaf_subverbs, PINNED.mcp_tools, PINNED.rule_families], [19, 27, 12, 24]);
  const mod = await loadCommand('compare');
  assert.deepEqual(mod.leaves, ['compare']);
  assert.equal(FAMILIES.at(-1).id, 'delta');
  assert.equal(FAMILIES.length, PINNED.rule_families);
  const policy = Object.fromEntries(codesForFamily('delta').map((c) => [c, RULES[c].blocking]));
  assert.deepEqual(policy, { DF_DELTA_KIND_MISMATCH: true, DF_DELTA_NO_STABLE_IDS: true, DF_DELTA_INPUT_BLOCKED: true, DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS: false, DF_DELTA_LAID_OUT_COLD: false });
  for (const c of codesForFamily('delta')) assert.ok(RULES[c].repair.length > 40 && RULES[c].gate === 'delta', c);
  assert.ok(DERIVED_RE.test('.dotfield/compares/x-20261008T000000Z/delta.json') && !DERIVED_RE.test('.dotfield/sketches/a.sketch.json'));
});

test('line budgets: the compare files stay under 400 lines and svg.mjs under 300', () => {
  const lines = (rel) => readFileSync(join(ROOT, rel), 'utf8').split('\n').length - 1;
  for (const rel of ['lib/commands/compare.mjs', 'lib/delta.mjs', 'lib/rules/delta.mjs', 'renderers/svg-delta.mjs', 'test/compare.test.js']) assert.ok(lines(rel) < 400, `${rel}: ${lines(rel)}`);
  assert.ok(lines('renderers/svg.mjs') < 300);
});
