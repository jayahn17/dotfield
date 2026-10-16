// The archify example corpus (V2_PLAN §11 archify-corpus): archify is MIT,
// so its 15 example diagrams at the pinned commit are vendored under
// test/fixtures/archify/ beside its LICENSE, each pinned by sha256 in
// manifest.json. Every file goes through the real verbs in process —
// import archify -> validate -> render --quality showcase (--view 2d, and
// --view all with the CDN importmap) — and must exit 0 with no blocking
// failure; the only non-blocking rows allowed are the two informational
// codes named below. The benchmark row (lib/bench/corpus.mjs) must report the
// same fraction. Then the parity rules that make the corpus clean: archify's
// canvas via stays in ext, sides become from_side/to_side, the lattice router
// keeps runs off each other and off nodes, and the channel router turns a
// leaving leg before an arriving one. Temp dirs only, zero network (the
// fetch script is driven by a stub), one clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { dispatch } from '../bin/dotfield.mjs';
import { CORPUS_DIR, MANIFEST_PATH, digest, entriesOf, fetchCorpus, readManifest, repin, urlOf, verifyCorpus } from '../scripts/fetch-archify-corpus.mjs';
import { IMPORT_EPOCH, IMPORT_NOW, archifyContext, archifyRows, showcaseOf } from '../lib/bench/corpus.mjs';
import { importPath } from '../importers/index.mjs';
import * as archify from '../importers/archify.mjs';
import { ROUTE_GRID, intentOf, latticeCentres, routeGrid } from '../importers/archify-route.mjs';
import { trackOrder } from '../lib/layout/channels.mjs';
import { pointSegmentDistance2, routePoints, segmentsOverlap } from '../lib/layout/geometry.mjs';

const PINNED = '73aaa0696e8f72c232ea710e6fa94fd953f3e773';
/** The only non-blocking rows a corpus file may carry: an order archify left implicit, and a lifecycle retry loop drawn against the layers. */
const ALLOWED_NON_BLOCKING = Object.freeze(['DF_IMPORT_ORDER_FILLED', 'DF_LAYOUT_LAYER_CYCLE_BROKEN']);
const env = () => { const e = { ...process.env, SOURCE_DATE_EPOCH: IMPORT_EPOCH }; delete e.DOTFIELD_ROOT; return e; };
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const blocking = (checks) => fails(checks).filter((c) => c.blocking);
const MANIFEST = readManifest();
const FILES = MANIFEST.files.map((f) => f.file);
const run = async (dir, argv) => (await dispatch([...argv, '--json'], { cwd: dir, env: env(), stdin: null, stdout: null })).receipt;
const showcase = { clean: 0, rows: [] };

test('manifest: archify pinned by commit, its MIT licence recorded before vendoring, 15 examples over the five diagram types', () => {
  assert.equal(MANIFEST.repo, 'tt-a1i/archify'); assert.equal(MANIFEST.commit, PINNED);
  assert.deepEqual([MANIFEST.license.name, MANIFEST.license.spdx], ['MIT License', 'MIT']);
  const licence = readFileSync(join(CORPUS_DIR, 'LICENSE'), 'utf8');
  assert.match(licence, /^MIT License\n/); for (const c of MANIFEST.license.copyright) assert.ok(licence.includes(c), c);
  assert.deepEqual([...MANIFEST.diagram_types].sort(), [...archify.SUPPORTED].sort(), 'every archify diagram type at the pin is one the importer supports');
  assert.equal(FILES.length, 15);
  const byType = {};
  for (const f of MANIFEST.files) {
    const doc = JSON.parse(readFileSync(join(CORPUS_DIR, f.file), 'utf8'));
    assert.equal(doc.diagram_type, f.diagram_type, f.file); assert.ok(f.file.endsWith(`.${f.diagram_type}.json`), f.file);
    assert.equal(f.path, `archify/examples/${f.file}`);
    byType[f.diagram_type] = (byType[f.diagram_type] ?? 0) + 1;
  }
  assert.deepEqual(byType, { lifecycle: 2, workflow: 4, sequence: 2, architecture: 5, dataflow: 2 });
  assert.deepEqual(readdirSync(CORPUS_DIR).sort(), [...FILES, 'LICENSE', 'manifest.json'].sort(), 'nothing unpinned in the corpus folder');
});

test('--verify: every vendored byte matches its pinned sha256, with no network', () => {
  const v = verifyCorpus({ manifest: MANIFEST });
  assert.equal(v.ok, true, JSON.stringify(v.files.filter((f) => f.status !== 'ok')));
  assert.equal(v.files.length, 16);
  for (const f of entriesOf(MANIFEST)) assert.equal(digest(readFileSync(join(CORPUS_DIR, f.file))), f.sha256, f.file);
});

test('fetch: raw.githubusercontent.com at the pinned commit; a byte that does not match is refused and never lands; --from copies only matching bytes; re-pin rewrites digests (stub fetch)', async () => {
  for (const f of entriesOf(MANIFEST)) assert.equal(urlOf(MANIFEST, f), `https://raw.githubusercontent.com/tt-a1i/archify/${PINNED}/${f.path}`);
  const served = new Map(entriesOf(MANIFEST).map((f) => [urlOf(MANIFEST, f), readFileSync(join(CORPUS_DIR, f.file))]));
  const stub = (tamper = null) => async (url) => {
    const bytes = served.get(url);
    if (!bytes) return { ok: false, status: 404 };
    const body = url.endsWith(tamper ?? '\0') ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
  await withTmp(async (dir) => {
    const bad = await fetchCorpus({ manifest: MANIFEST, dir, fetchImpl: stub('web-app.architecture.json') });
    assert.equal(bad.ok, false); assert.equal(bad.fetched, 15);
    assert.equal(bad.files.find((f) => f.file === 'web-app.architecture.json').status, 'refused');
    assert.equal(existsSync(join(dir, 'web-app.architecture.json')), false, 'a refused file is never written');
    const good = await fetchCorpus({ manifest: MANIFEST, dir, fetchImpl: stub() });
    assert.deepEqual([good.ok, good.fetched, good.skipped], [true, 1, 15]);
  });
  await withTmp(async (dir) => {
    const copy = await fetchCorpus({ manifest: MANIFEST, dir, from: CORPUS_DIR });
    assert.deepEqual([copy.ok, copy.fetched], [true, 16]);
    writeFileSync(join(dir, 'LICENSE'), 'edited');
    assert.equal(verifyCorpus({ manifest: MANIFEST, dir }).files.find((f) => f.file === 'LICENSE').status, 'mismatch');
  });
  const next = await repin({ manifest: MANIFEST, commit: 'f'.repeat(40), fetchImpl: async (url) => stub()(url.replace('f'.repeat(40), PINNED)) });
  assert.equal(next.ok, true); assert.equal(next.manifest.commit, 'f'.repeat(40)); assert.deepEqual(next.manifest.files.map((f) => f.sha256), MANIFEST.files.map((f) => f.sha256));
  await withTmp(async (dir) => {
    const write = (patch) => { const p = join(dir, 'm.json'); writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), ...patch })); return p; };
    assert.throws(() => readManifest(write({ license: { ...MANIFEST.license, spdx: 'GPL-3.0-only' } })), /fetch at test time only/);
    assert.throws(() => readManifest(write({ files: [{ ...MANIFEST.files[0], file: '../escape.json' }] })), /plain file name/);
    assert.throws(() => readManifest(write({ commit: 'main' })), /40-hex/);
  });
});

test('corpus: every archify example imports, validates, lays out and renders gate-clean at --quality showcase (the real verbs, in process)', async (t) => {
  await withTmp(async (dir) => {
    for (const file of FILES) {
      const type = MANIFEST.files.find((f) => f.file === file).diagram_type;
      const out = `${file.replace(/\.json$/, '')}.scene.json`;
      const imp = await run(dir, ['import', 'archify', join(CORPUS_DIR, file), '-o', out]);
      const val = await run(dir, ['validate', out, '--quality', 'showcase']);
      const r2d = await run(dir, ['render', out, '--quality', 'showcase']);
      const all = await run(dir, ['render', out, '--quality', 'showcase', '--view', 'all', '--no-embed-three']);
      const receipts = { import: imp, validate: val, 'render 2d': r2d, 'render all': all };
      const notes = [...new Set(Object.values(receipts).flatMap((r) => fails(r.checks).filter((c) => !c.blocking).map((c) => c.code)))].sort();
      const clean = Object.values(receipts).every((r) => r.exit_code === 0 && blocking(r.checks).length === 0);
      showcase.rows.push({ file, type, codes: Object.fromEntries(Object.entries(receipts).map(([k, r]) => [k, r.exit_code])), notes });
      if (clean) showcase.clean += 1;
      t.diagnostic(`${file.padEnd(42)} ${type.padEnd(12)} ${Object.entries(receipts).map(([k, r]) => `${k} ${r.exit_code}`).join(' · ')}${notes.length ? ` · non-blocking ${notes.join(', ')}` : ''}`);
      for (const [k, r] of Object.entries(receipts)) {
        assert.equal(r.exit_code, 0, `${file}: ${k} exit ${r.exit_code} ${JSON.stringify(blocking(r.checks).map((c) => `${c.code} ${c.path} ${c.message}`))}`);
        assert.deepEqual(blocking(r.checks), [], `${file}: ${k}`);
      }
      for (const code of notes) assert.ok(ALLOWED_NON_BLOCKING.includes(code), `${file}: unexpected non-blocking ${code}`);
      if (type === 'lifecycle' && notes.includes('DF_LAYOUT_LAYER_CYCLE_BROKEN')) assert.ok(JSON.parse(readFileSync(join(dir, out), 'utf8')).edges.length > 0);
      if (type === 'sequence') {
        const seq = JSON.parse(readFileSync(join(dir, out), 'utf8')); const src = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8'));
        assert.deepEqual([seq.edges.length, seq.ext.archify.dropped_messages], [src.messages.length, undefined], `${file}: every message kept, a repeated pair on its own beat (ARCHIFY_PARITY.md §5)`);
      }
    }
    t.diagnostic(`archify corpus @ ${PINNED.slice(0, 12)}: ${showcase.clean}/${FILES.length} showcase-clean`);
  });
  assert.equal(showcase.clean, FILES.length);
});

test('benchmark row: archify.types_supported 5 of 5 and corpus_showcase_clean n/15, the same fraction the verbs measured', () => {
  const a = archifyRows();
  assert.deepEqual([a.types_supported, a.archify_total_types, a.refused_by_name.length], [5, 5, 0]);
  assert.deepEqual([a.pinned_commit, a.license_spdx, a.corpus_files, a.corpus_verified, a.corpus_imported], [PINNED, 'MIT', 15, 15, 15]);
  assert.equal(a.corpus_showcase_clean, `${showcase.clean}/15`);
  for (const r of a.rows.filter((x) => x.corpus)) {
    assert.equal(r.status, 'accepted', r.name); assert.equal(r.showcase.status, 'clean', `${r.name}: ${r.showcase.blocking.join(', ')}`);
    for (const code of [...r.notes, ...r.showcase.non_blocking]) assert.ok(ALLOWED_NON_BLOCKING.includes(code), `${r.name}: ${code}`);
  }
  assert.equal(archifyRows(undefined, { measure: false }).corpus_showcase_clean, 'not_measured');
});

test('parity: archify canvas via stays under ext, sides become from_side/to_side, route hints shape the lattice route, a colliding label moves along its route', () => {
  const imp = (file) => importPath(join(CORPUS_DIR, file), { now: IMPORT_NOW }).scene;
  const pa = imp('product-analytics.dataflow.json');
  const click = pa.edges.find((e) => e.id === 'web-clickstream');
  assert.deepEqual(pa.ext.archify.connections['web-clickstream'].via, [[205, 157], [205, 271]], 'archify canvas pixels round-trip');
  assert.notDeepEqual(click.via, [[205, 157], [205, 271]]);
  assert.deepEqual([click.from_side, click.to_side], ['right', 'left']); assert.ok(!('fromSide' in (pa.ext.archify.connections['web-clickstream'] ?? {})));
  const at = imp('agent-tool-call.workflow.json');
  const reply = at.edges.find((e) => e.id === 'external-reply');
  assert.equal(at.ext.archify.connections['external-reply'].route, 'outside-right');
  const pos = (s, id) => { const n = s.nodes.find((x) => x.id === id); const [, , w, h] = s.views['2d'].viewBox; return [w / 2 + n.pos.x * (w / 2 - archify.CELL.pad), h / 2 + n.pos.y * (h / 2 - archify.CELL.pad)]; };
  const ext = pos(at, 'external'); const fin = pos(at, 'final');
  assert.ok(reply.via[0][0] > ext[0] && Math.abs(reply.via[0][1] - ext[1]) <= ROUTE_GRID.port_pitch, 'leaves External API by its right side');
  assert.ok(reply.via[reply.via.length - 1][0] > fin[0], 'enters Final Reply by its right side');
  assert.ok(Math.max(...reply.via.map((p) => p[0])) > pos(at, 'retry')[0] + 200, 'outside-right runs right of the column it would cross');
  assert.equal(at.edges.find((e) => e.id === 'request-chat').via, undefined, 'an unobstructed neighbour keeps its straight chord');
  const bare = JSON.parse(JSON.stringify(at)); for (const e of bare.edges) { delete e.via; delete e.label_at; }
  assert.deepEqual(showcaseOf(bare, archifyContext()).blocking, ['DF_LAYOUT_ROUTE_OVERLAP', 'DF_LAYOUT_ROUTE_THROUGH_NODE'], 'without the lattice via the same scene is blocked at showcase: the gate was not relaxed');
  const pd = imp('production-deployment.architecture.json');
  const vpc = pd.edges.filter((e) => e.label === 'VPC route');
  assert.equal(vpc.length, 2); assert.equal(vpc.filter((e) => e.label_at !== undefined).length, 1, 'the second of two colliding labels moves; the first keeps its default');
});

test('lattice router: sides are direction contracts, no two runs share a line, no run passes a node it does not connect, deterministic', () => {
  const frame = { cols: 3, rows: 3, width: 1600, height: 1300, pad: 50, cells: [[0, 0], [0, 2], [0, 1], [2, 1], [2, 2]], free: [] };
  const edges = [
    { id: 'ab', a: 0, b: 1, route: 'orthogonal' }, { id: 'ba', a: 1, b: 0, route: 'orthogonal', hint: 'bottom-channel' },
    { id: 'ad', a: 0, b: 3, route: 'orthogonal', from_side: 'bottom', to_side: 'top' }, { id: 'ae', a: 0, b: 4, route: 'orthogonal' },
    { id: 'cd', a: 2, b: 3, route: 'orthogonal' }, { id: 'be', a: 1, b: 4, route: 'orthogonal', hint: 'outside-right' },
  ];
  const via = routeGrid({ ...frame, edges });
  assert.deepEqual(routeGrid({ ...frame, edges }), via, 'deterministic');
  assert.ok(via.ab && via.ab.length >= 2, 'ab cannot run straight through the occupied middle cell');
  const c = latticeCentres(frame);
  const polys = edges.map((e) => routePoints({ via: via[e.id] ?? undefined }, c[e.a], c[e.b]));
  for (let i = 0; i < edges.length; i += 1) {
    for (let k = 0; k < c.length; k += 1) {
      if (k === edges[i].a || k === edges[i].b) continue;
      for (let s = 1; s < polys[i].length; s += 1) assert.ok(pointSegmentDistance2(c[k][0], c[k][1], ...polys[i][s - 1], ...polys[i][s]) >= ROUTE_GRID.clear_px ** 2, `${edges[i].id} passes node ${k}`);
    }
    for (let j = i + 1; j < edges.length; j += 1) for (let s = 1; s < polys[i].length; s += 1) for (let u = 1; u < polys[j].length; u += 1) {
      assert.ok(!segmentsOverlap(polys[i][s - 1], polys[i][s], polys[j][u - 1], polys[j][u]), `${edges[i].id} runs along ${edges[j].id}`);
    }
  }
  const ad = polys[2]; const ba = polys[1];
  assert.ok(ad[1][1] > ad[0][1] && ad[ad.length - 1][1] > ad[ad.length - 2][1], 'ad leaves by the bottom and enters by the top');
  assert.ok(ba[1][1] > ba[0][1] && ba[ba.length - 1][1] < ba[ba.length - 2][1], 'a bottom channel leaves and enters by the bottom');
  assert.ok(Math.max(...ba.map((p) => p[1])) > c[0][1] + 150, 'and runs below the row');
  assert.deepEqual(intentOf({ hint: 'drop' }, [2, 0], [0, 0]), { out: [3], in: [3], prefer: null }, 'a drop upward leaves by the top');
  assert.deepEqual(intentOf({ from_side: 'left', hint: 'outside-right' }, [0, 0], [1, 1]).out, [2], 'an authored side beats the hint');
});

test('channels: trackOrder keeps the mid order unless a leg leaving at a coordinate meets a leg arriving there (the deployment-release overlap)', () => {
  const it = (mid, ua, ub) => ({ mid, pc: { ua, ub } });
  const arrive = it(298.5, 257, 340); const leave = it(378.5, 340, 417);
  assert.deepEqual(trackOrder([arrive, leave], 1), [leave, arrive], 'the leg leaving at 340 turns first');
  assert.deepEqual(trackOrder([arrive, leave], -1), [arrive, leave], 'mirrored for up|left');
  const a = it(1, 0, 10); const b = it(2, 20, 30);
  assert.deepEqual(trackOrder([a, b], 1), [a, b], 'no constraint: mid order');
  const p = it(1, 340, 417); const q = it(2, 417, 340);
  assert.deepEqual(trackOrder([p, q], 1), [p, q], 'a swap is a cycle: mid order');
});
