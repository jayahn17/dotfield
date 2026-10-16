// The benchmark (V2_PLAN §9): the corpus is deterministic and valid, the
// layout metrics have known values on hand-built scenes, the cap sentinel is
// parsed by one pinned regex, the probes answer true | false |
// not_implemented, the Markdown auto block carries no bytes, timings or
// dates, two in-process runs under one epoch are byte-identical, lib/bench
// never reads a clock or spawns, and references/BENCHMARK.md holds both
// marker pairs, the regenerated header sentence and no numeric score for
// anything the script did not run. node:test, zero network; the one file
// write happens in a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { read, walk, lineCount } from './helpers/scan.mjs';
import { canonical, sha256File } from '../lib/digest.mjs';
import { validateAgainst } from '../lib/validate.mjs';
import { layoutScene, positions2d } from '../lib/layout/index.mjs';
import { corpus, dateOfDay, labelFrom, syntheticScene, workflowScene, SHIPPED_SCENES, VIEWBOX_2026_10_07 } from '../lib/bench/corpus.mjs';
import { labelLegibility, layoutMetrics, oneEditStability, viewBoxV1 } from '../lib/bench/metrics.mjs';
import { CAP_SENTINEL_RE, NOT_IMPLEMENTED, memoRunner, motionLoops, parseCapSentinel } from '../lib/bench/probes.mjs';
import { failsByCode, failsLabel } from '../lib/bench/measure.mjs';
import { AUTO_END, AUTO_START, CELL_VALUES, CHECKLIST_END, CHECKLIST_START, HEADER_SENTENCE, extractBlock, probeCell, renderMarkdownBlock, replaceBlock } from '../lib/bench/report.mjs';
import { EXIT, main, parseArgs, runBenchmark } from '../scripts/benchmark.mjs';
import { mulberry32 } from '../lib/layout/rng.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const THREE = ['scene-graph', 'scene-method-web', 'scene-run-history'];
const EPOCH = Object.freeze({ ...process.env, SOURCE_DATE_EPOCH: '1760000000' });
const DIG = `sha256:${'0'.repeat(64)}`;
const SCORE_RE = /^\| .*\| *[0-9]+(\.[0-9]+)? *\/ *10/m;
/** One in-process quick run over three scenes, shared by the tests below (nothing is written). */
const RUN = await runBenchmark({ quick: true, env: EPOCH, sceneIds: THREE });

function node(id, x, y) {
  return { id, kind: 'record', label: id, weight: 0.5, tags: [], color_token: 'series-1', status: 'accepted', pos: x === undefined ? undefined : { x, y },
    provenance: { owner_person_id: 'self', source: { kind: 'record', ref: `r/${id}`, digest: DIG }, captured_on: '2026-01-01' }, audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [] };
}
const edge = (from, to) => ({ id: `${from}-${to}`, from, to, kind: 'relates', directed: false, variant: 'solid', route: 'auto' });
function scene(nodes, edges, positions, viewBox = [0, 0, 400, 400]) {
  for (const n of nodes) delete n.pos;
  return { schema_version: 'dotfield.scene/1', kind: 'graph', meta: { id: 'bench-fixture', title: 'Bench fixture', theme: 'default', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype' },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] }, nodes, edges, positions, laid_out: true, views: { '2d': { layout: 'force', seed: 1, viewBox } } };
}
const finiteNumbers = (v, path = '$', out = []) => {
  if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(path); return out; }
  if (Array.isArray(v)) v.forEach((x, i) => finiteNumbers(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) finiteNumbers(x, `${path}.${k}`, out);
  return out;
};

test('corpus: 17 shipped scenes with file digests and the 2026-10-07 viewBoxes, archify rows accepted|refused with a code, synthetic tree at 100 and 500 under --quick', () => {
  const c = corpus({ quick: true, root: ROOT });
  assert.equal(c.scenes.length, SHIPPED_SCENES.length);
  for (const s of c.scenes) {
    assert.equal(s.sha256, sha256File(join(ROOT, s.path)));
    assert.deepEqual(s.viewbox_2026_10_07, VIEWBOX_2026_10_07[s.path]);
    assert.equal(s.scene.schema_version, 'dotfield.scene/1');
  }
  assert.deepEqual(c.synthetic.map((s) => s.id), ['synthetic-tree-100', 'synthetic-tree-500']);
  assert.deepEqual(c.workflows.map((w) => w.layout), ['grid', 'layered']);
  assert.ok(c.archify.rows.length >= 2);
  for (const r of c.archify.rows) {
    assert.ok(['accepted', 'refused', 'missing'].includes(r.status), r.status);
    if (r.status === 'refused') assert.ok(r.codes.every((code) => code.startsWith('DF_IMPORT_')), r.codes.join());
    if (r.status === 'accepted') assert.deepEqual(r.codes, []);
  }
  assert.equal(c.archify.types_supported, c.archify.supported.length);
  assert.ok(c.archify.archify_total_types === 'unknown' || Number.isInteger(c.archify.archify_total_types));
  assert.match(c.digest, /^sha256:[0-9a-f]{64}$/);
  const full = corpus({ quick: false, root: ROOT });
  assert.deepEqual([...new Set(full.synthetic.map((s) => s.family))], ['tree', 'clustered', 'sparse']);
  assert.deepEqual(full.synthetic.filter((s) => s.timing_only).map((s) => s.n), [5000]);
});

test('synthetic generator: deterministic under its seeds, labels 8–24 characters, dates inside 2026, every family and both workflows validate against the scene schema', () => {
  for (const family of ['tree', 'clustered', 'sparse']) {
    const a = syntheticScene({ family, n: 120 }); const b = syntheticScene({ family, n: 120 });
    assert.equal(canonical(a), canonical(b), `${family} is deterministic`);
    const v = validateAgainst('scene', a);
    assert.ok(v.ok, `${family}: ${JSON.stringify(v.errors.slice(0, 2))}`);
    for (const n of a.nodes) {
      assert.ok(n.label.length >= 8 && n.label.length <= 24, n.label);
      assert.match(n.provenance.happened_on, /^2026-\d{2}-\d{2}$/);
    }
    assert.ok(validateAgainst('scene', layoutScene(a)).ok, `${family} laid out still validates`);
  }
  for (const layout of ['grid', 'layered']) assert.ok(validateAgainst('scene', workflowScene({ layout })).ok, layout);
  assert.equal(dateOfDay(0), '2026-01-01'); assert.equal(dateOfDay(31), '2026-02-01'); assert.equal(dateOfDay(364), '2026-12-31'); assert.equal(dateOfDay(900), '2026-12-31');
  const rng = mulberry32(7);
  for (let i = 0; i < 50; i += 1) { const l = labelFrom(rng); assert.ok(l.length >= 8 && l.length <= 24 && !/^\s|\s$/.test(l), l); }
  assert.throws(() => syntheticScene({ family: 'nope', n: 3 }), TypeError);
});

test('layoutMetrics: a square with one crossing, a uniform path with zero stress, an empty scene; the v1 viewBox formula is frozen', () => {
  const sq = scene([node('a'), node('b'), node('c'), node('d')], [edge('a', 'c'), edge('b', 'd'), edge('a', 'b')], { a: [100, 100], b: [300, 100], c: [300, 300], d: [100, 300] });
  const m = layoutMetrics(sq);
  assert.equal(m.crossings, 1, 'the two diagonals cross once; a-b shares endpoints and never counts');
  assert.equal(m.overlap_pairs, 0); assert.equal(m.route_through_node, 0); assert.equal(m.containment_violations, 0);
  assert.equal(m.labels_total, 4); assert.equal(m.labels_measured, 4);
  assert.equal(m.viewbox_area_ratio, Math.round((400 * 400 / (1600 * 1000)) * 1000) / 1000);
  const path = scene([node('p'), node('q'), node('r')], [edge('p', 'q'), edge('q', 'r')], { p: [50, 200], q: [200, 200], r: [350, 200] });
  const pm = layoutMetrics(path);
  assert.equal(pm.stress, 0, 'equal hops at equal spacing: the least-squares scale makes the stress exactly 0');
  assert.equal(pm.edge_uniformity, 0); assert.equal(pm.neighborhood_preservation, 1); assert.equal(pm.crossings, 0);
  const touching = scene([node('x'), node('y')], [], { x: [100, 100], y: [105, 100] });
  assert.equal(layoutMetrics(touching).overlap_pairs, 1);
  const empty = layoutMetrics(scene([], [], {}));
  assert.deepEqual([empty.nodes, empty.edges, empty.stress, empty.crossings, empty.labels_total], [0, 0, 0, 0, 0]);
  assert.deepEqual(viewBoxV1(10, 48), [0, 0, 1600, 1000]);
  assert.ok(viewBoxV1(2000, 48)[2] > 1600, 'the frozen formula grows with n');
  assert.deepEqual(finiteNumbers(m), []);
});

test('oneEditStability: finite for a graph, not applicable for a metric room, and metrics.mjs is the only lib module that sets ctx.incremental', () => {
  const g = layoutScene(syntheticScene({ family: 'tree', n: 30 }));
  const st = oneEditStability(g);
  assert.equal(st.applicable, true); assert.equal(st.moved, 30);
  assert.ok(Number.isFinite(st.mean) && Number.isFinite(st.max) && st.max >= st.mean && st.mean >= 0);
  assert.equal(st.spacing, 48);
  const room = JSON.parse(read('examples/scene-room.json'));
  assert.deepEqual(oneEditStability(room), { mean: 0, max: 0, moved: 0, applicable: false, spacing: null });
  const setters = walk('lib', { exts: new Set(['.mjs']) }).filter((rel) => /incremental:\s*true/.test(read(rel)));
  assert.deepEqual(setters, ['lib/bench/metrics.mjs'], 'warm starts are a benchmark instrument, never a render path');
  const legible = labelLegibility('<svg><text font-size="12" textLength="30">ab</text><text font-size="12" textLength="5">a long label here</text></svg>');
  assert.deepEqual(legible, { labels: 2, shrunk: 1, shrunk_share: 0.5 });
});

test('parseCapSentinel: one pinned regex reads the pre-v2 sentinel (no total) and the v2 sentinel (with total); failsByCode flags capped rows', () => {
  assert.equal(CAP_SENTINEL_RE.source, 'further (?:(\\d+) )?(DF_[A-Z0-9_]+) findings not listed \\((\\d+) shown(?: of (\\d+))?\\)');
  assert.deepEqual(parseCapSentinel('A label collides with a neighbouring glyph or label: further DF_LAYOUT_LABEL_CLEARANCE findings not listed (200 shown)'), { shown: 200, total: null, code: 'DF_LAYOUT_LABEL_CLEARANCE' });
  assert.deepEqual(parseCapSentinel('x: further 147 DF_LAYOUT_LABEL_CLEARANCE findings not listed (200 shown of 347)'), { shown: 200, total: 347, code: 'DF_LAYOUT_LABEL_CLEARANCE' });
  assert.equal(parseCapSentinel('further 3 DF_X findings not listed (200 shown)').total, 203, 'a count without a total still gives one');
  assert.equal(parseCapSentinel('nothing to see'), null); assert.equal(parseCapSentinel(undefined), null);
  const checks = [
    { code: 'DF_LAYOUT_OVERLAP', status: 'fail', blocking: true, message: 'a' }, { code: 'DF_LAYOUT_OVERLAP', status: 'fail', blocking: true, message: 'b' },
    { code: 'DF_LAYOUT_OVERLAP', status: 'fail', blocking: true, message: 'further 5 DF_LAYOUT_OVERLAP findings not listed (2 shown of 7)' },
    { code: 'DF_LAYOUT_LABEL_CLEARANCE', status: 'fail', blocking: false, message: 'c' }, { code: 'DF_IR_DUP_ID', status: 'pass', blocking: true },
  ];
  const f = failsByCode(checks);
  assert.deepEqual(f, { DF_LAYOUT_LABEL_CLEARANCE: { rows: 1, shown: 1, total: 1, capped: false, blocking: false }, DF_LAYOUT_OVERLAP: { rows: 3, shown: 2, total: 7, capped: true, blocking: true } });
  assert.equal(failsLabel(f), 'DF_LAYOUT_LABEL_CLEARANCE 1, DF_LAYOUT_OVERLAP 7!^');
  assert.equal(failsLabel({}), 'none');
});

test('memoRunner: cold for the first two calls per scene (the gate probe stays a real two-run probe), served afterwards', () => {
  const s = syntheticScene({ family: 'sparse', n: 25 });
  let calls = 0;
  const runner = memoRunner((scene, ctx) => { calls += 1; return positions2d(scene, ctx); });
  const a = runner(s, { force: true }); const b = runner(s, { force: true }); const c = runner(s, { force: true });
  assert.equal(calls, 2); assert.deepEqual(a, b); assert.equal(c, b);
  assert.deepEqual(runner.stats, { cold: 2, served: 1 });
  runner(syntheticScene({ family: 'sparse', n: 26 }), { force: true });
  assert.equal(calls, 3, 'a different scene is a different key');
});

test('motionLoops: a label containing the word infinite never trips; a CSS keyframe loop and a SMIL indefinite loop do; an iteration count of 1 passes', () => {
  assert.deepEqual(motionLoops('<svg><text>infinite loop closure</text></svg><style>.a{animation:x 1s ease 1}</style>'), []);
  assert.equal(motionLoops('<style>.b{animation:df-flow 1.2s linear infinite}</style>').length, 1);
  assert.equal(motionLoops('<style>.c{animation-iteration-count: 3}</style>').length, 1);
  assert.equal(motionLoops('<svg><animate attributeName="x" repeatCount="indefinite"/></svg>').length, 1);
  assert.equal(motionLoops('<style data-df="tokens">.t{animation:x 2s infinite}</style>').length, 0, 'the tokens block is exempt');
  assert.equal(motionLoops(`<script>${JSON.stringify({ k: 'data:text/javascript;base64,' + Buffer.from('/* animation: y 1s infinite */').toString('base64') })}</script>`).length, 1, 'embedded modules are decoded');
});

test('probes on a real --view all render: 4 CDN references by default and 0 embedded, parity holds, every 4D probe is true, false or not_implemented', () => {
  const p = RUN.result.probes;
  assert.deepEqual([p.standalone.external_refs_default, p.standalone.external_refs_default_by_origin.other, p.standalone.external_refs_embed, p.standalone.importmap_mode, p.standalone.sri_complete], [4, 0, 0, 'cdn', true]);
  assert.equal(p.parity.parity_holds, true); assert.equal(p.parity.vr_mismatches, 0);
  assert.equal(p.determinism.layouts_deterministic, true); assert.equal(p.determinism.renders_identical, true);
  for (const [k, v] of Object.entries(p.fourd)) if (k !== 'infinite_motion_hits') assert.ok(v === true || v === false || v === NOT_IMPLEMENTED, `${k}: ${v}`);
  assert.equal(typeof p.fourd.no_infinite_motion, 'boolean', 'the motion probe is always runnable');
  assert.equal(p.agent.mcp_tools, 12); assert.equal(p.agent.approve_tool_absent, true); assert.equal(p.agent.owner_gate_present, true);
  assert.equal(p.agent.codes_without_repair, 0); assert.ok(p.agent.rule_codes >= 224); assert.equal(p.agent.receipt_round_trip, true);
  assert.equal(p.maintainability.dependencies, 0); assert.equal(p.maintainability.files_at_or_over_400, 0); assert.equal(p.maintainability.test_calls, null, 'quick runs never spawn the suite');
  assert.equal(p.viewer.key_table_present, true); assert.equal(p.viewer.hash_state_present, true); assert.equal(p.layout.gate_blocks_overlap, true);
  assert.deepEqual(p.memo.cold <= p.memo.cold + p.memo.served, true);
});

test('report: the auto block carries no bytes, timings or dates and no x/10 score; two runs under one epoch are byte-identical; every number is finite', async () => {
  const block = renderMarkdownBlock(RUN.result);
  assert.equal(block, RUN.auto);
  assert.ok(!/\b\d+(\.\d+)?\s?(bytes|B|KB|MB|ms|s)\b/.test(block), 'no bytes or timings in the block');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(block), 'no dates in the block');
  assert.ok(!SCORE_RE.test(block), 'no numeric score out of ten');
  assert.ok(block.includes('| scene-graph |') && block.includes('| synthetic-tree-100 |') && block.includes('archify.types_supported'));
  assert.ok(RUN.checklist.startsWith(`_${HEADER_SENTENCE}_`), 'the header sentence is regenerated');
  const again = await runBenchmark({ quick: true, env: EPOCH, sceneIds: THREE });
  assert.equal(JSON.stringify(again.json), JSON.stringify(RUN.json), 'byte-identical under one SOURCE_DATE_EPOCH');
  assert.equal(RUN.json.timings, null); assert.equal(RUN.json.fresh_clone, null); assert.equal(RUN.json.mode, 'quick');
  assert.deepEqual(finiteNumbers(RUN.json), []);
  assert.equal(RUN.json.generated_at, '2025-10-09T08:53:20Z');
  assert.ok(RUN.elapsed_ms < 20000, `three scenes in ${RUN.elapsed_ms} ms`);
  const text = `${AUTO_START}\nold\n${AUTO_END}`;
  assert.equal(extractBlock(replaceBlock(text, AUTO_START, AUTO_END, 'new'), AUTO_START, AUTO_END), '\nnew\n');
  assert.equal(extractBlock('nothing', AUTO_START, AUTO_END), null);
  assert.throws(() => replaceBlock('nothing', AUTO_START, AUTO_END, 'x'), /markers/);
  assert.equal(probeCell({ a: { b: true } }, 'a.b'), 'present'); assert.equal(probeCell({ a: { b: NOT_IMPLEMENTED } }, 'a.b'), 'absent'); assert.equal(probeCell({}, 'a.b'), 'unknown');
});

test('lib/bench is pure (no Date.now, new Date(), Math.random, performance or child_process) and every benchmark file is under 400 lines', () => {
  const files = walk('lib/bench', { exts: new Set(['.mjs']) });
  assert.deepEqual(files, ['lib/bench/corpus.mjs', 'lib/bench/measure.mjs', 'lib/bench/metrics.mjs', 'lib/bench/probes.mjs', 'lib/bench/report.mjs']);
  for (const rel of files) {
    const text = read(rel);
    assert.ok(!/\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bMath\.random\s*\(|\bperformance\b|child_process/.test(text), `${rel} reads a clock or spawns`);
  }
  for (const rel of [...files, 'scripts/benchmark.mjs', 'test/benchmark.test.js']) assert.ok(lineCount(read(rel)) < 400, `${rel} is under 400 lines`);
});

test('references/BENCHMARK.md: both marker pairs, the header sentence, no x/10 score in any table row; benchmark-checklist.json cells are present|absent|unknown with a source, Dotfield cells name live probes', () => {
  const md = read('references/BENCHMARK.md');
  for (const m of [AUTO_START, AUTO_END, CHECKLIST_START, CHECKLIST_END]) assert.ok(md.includes(m), `${m} missing`);
  assert.ok(md.includes('no competitor was executed'));
  assert.ok(!SCORE_RE.test(md), 'a numeric score for something the script did not run');
  const doc = JSON.parse(read('references/benchmark-checklist.json'));
  assert.equal(doc.schema_version, 'dotfield.benchmark-checklist/1');
  assert.equal(doc.systems.length, 15); assert.ok(doc.features.length >= 30);
  assert.equal(doc.selection.applied, false, 'star counts were not fetched: the rule is recorded, not claimed');
  const ids = new Set(doc.features.map((f) => f.id));
  for (const s of doc.systems) {
    assert.ok(typeof s.repo === 'string' && s.repo.length > 0, s.id);
    assert.deepEqual(Object.keys(s.cells).sort(), [...ids].sort(), `${s.id} has every feature`);
    for (const [fid, c] of Object.entries(s.cells)) {
      assert.ok(typeof c.source === 'string' && c.source.length > 0, `${s.id}.${fid} has a source`);
      if (c.probe) { assert.equal(s.id, 'dotfield'); assert.notEqual(probeCell(RUN.result.probes, c.probe), 'unknown', `${c.probe} resolves`); } else assert.ok(CELL_VALUES.includes(c.value), `${s.id}.${fid}: ${c.value}`);
      assert.ok(!/\b\d+ ?\/ ?10\b/.test(c.source), 'no score in a source sentence');
    }
  }
  assert.equal(doc.systems.find((s) => s.id === 'archify').pinned_commit, '73aaa0696e8f72c232ea710e6fa94fd953f3e773');
  assert.ok(doc.systems.filter((s) => s.id === 'dotfield').every((s) => Object.values(s.cells).filter((c) => c.probe).length >= 20), 'most Dotfield cells are computed');
});

test('CLI: parseArgs, --json writes a reproducible file into a temp dir, --help exits 0, an unknown flag exits 1', async () => {
  assert.deepEqual(parseArgs(['--quick', '--check']), { write: false, check: true, json: null, quick: true, help: false });
  assert.deepEqual(parseArgs(['--json', 'out.json', '--write']), { write: true, check: false, json: 'out.json', quick: false, help: false });
  assert.equal(parseArgs(['--json=x.json']).json, 'x.json');
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.equal(EXIT.DRIFT, 2);
  const quiet = { write() { return true; } };
  assert.equal(await main(['--help'], { stdout: quiet, stderr: quiet }), 0);
  assert.equal(await main(['--nope'], { stdout: quiet, stderr: quiet }), 1);
  await withTmp(async (dir) => {
    const out = join(dir, 'bench', 'a.json');
    const saved = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = '1760000000';
    try { assert.equal(await main(['--quick', '--json', out], { stdout: quiet, stderr: quiet }), 0); } finally { if (saved === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = saved; }
    assert.ok(existsSync(out) && statSync(out).size > 1000);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(doc.schema_version, 'dotfield.benchmark/1'); assert.equal(doc.corpus.scenes.length, 17); assert.equal(doc.mode, 'quick');
    assert.deepEqual(readdirSync(dir), ['bench'], 'nothing else was written');
  });
});
