#!/usr/bin/env node
// scripts/benchmark.mjs — the measuring contract (V2_PLAN §9).
//
//   node scripts/benchmark.mjs [--write] [--check] [--json <path>] [--quick]
//
//   --quick   shipped scenes at checked and showcase with --view 2d; the synthetic
//             tree family at n = 100 and 500 at checked, one in-process run; the
//             archify fixtures; no fresh-clone spawn, no CLI wall timing, no 3D
//             render; the layout gate's determinism probe runs once per scene
//             through a deps.runner memo. No timing is recorded, so the quick
//             JSON is byte-reproducible under one SOURCE_DATE_EPOCH. Target < 60 s.
//   (full)    three families at 100, 500, 2000 (5000 timing-only), both qualities,
//             --view 2d and all, median of 3, one CLI wall ms, the test-runner
//             summary and the fresh-clone simulation (this file spawns; lib/bench never does).
//   --write   regenerate the two blocks of references/BENCHMARK.md and write
//             .dotfield/benchmark/<compactStamp(now)>.json
//   --check   regenerate in memory; exit 2 on any byte difference in either block
//   --json    write the full JSON document to <path>
// Exit 0 ok · 1 error · 2 drift. Timings, the wall clock and child processes live
// here only: lib/bench/ is pure and the structure scan covers it.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dispatch } from '../bin/dotfield.mjs';
import { createContext } from '../lib/context.mjs';
import { canonical, sha256 } from '../lib/digest.mjs';
import { buildReceipt, compactStamp, engineDigests, isoSeconds, verifyReceipt, writeReceipt } from '../lib/receipt.mjs';
import { MODES_2D, layoutScene, layoutTables } from '../lib/layout/index.mjs';
import { renderHtmlDetailed } from '../renderers/html.mjs';
import { corpus } from '../lib/bench/corpus.mjs';
import { failsLabel, measureScene } from '../lib/bench/measure.mjs';
import { memoRunner, probes } from '../lib/bench/probes.mjs';
import { AUTO_END, AUTO_START, CHECKLIST_END, CHECKLIST_START, extractBlock, renderChecklistBlock, renderMarkdownBlock, replaceBlock, toJson } from '../lib/bench/report.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BENCHMARK_MD = join(ROOT, 'references', 'BENCHMARK.md');
export const CHECKLIST_JSON = join(ROOT, 'references', 'benchmark-checklist.json');
export const OUT_DIR = join(ROOT, '.dotfield', 'benchmark');
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, DRIFT: 2 });
export const QUALITIES = Object.freeze(['checked', 'showcase']);
export const FRESH_CLONE_SKIP = Object.freeze(['node_modules', '.dotfield', 'data', 'center', '.git']);
export const USAGE = 'usage: node scripts/benchmark.mjs [--write] [--check] [--json <path>] [--quick]';

export function parseArgs(argv) {
  const out = { write: false, check: false, json: null, quick: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--check') out.check = true;
    else if (a === '--quick') out.quick = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') { out.json = argv[i + 1] ?? null; i += 1; }
    else if (a.startsWith('--json=')) out.json = a.slice(7);
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return out;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const round = (ms) => Math.round(ms * 10) / 10;
function timed(fn) { const t0 = performance.now(); const value = fn(); return { value, ms: performance.now() - t0 }; }
const strip = (row) => { const { laid, ...rest } = row; return rest; };

function measureRuns(scene, ctx, { quick, runner, v1ViewBox = null, qualities = QUALITIES, viewsList = quick ? ['2d'] : ['2d', 'all'] }) {
  const runs = []; const timings = {}; const bytes = {};
  for (const views of viewsList) for (const quality of qualities) {
    const reps = quick ? 1 : 3; const ms = []; let row = null;
    for (let i = 0; i < reps; i += 1) { const t = timed(() => measureScene(scene, ctx, { quality, views, runner, v1ViewBox })); row = t.value; ms.push(t.ms); }
    runs.push({ quality, views, ...strip(row) });
    const key = `${quality}|${views}`;
    if (!quick) timings[key] = { in_process_ms_median_of_3: round(median(ms)) };
    if (row.render) bytes[key] = { html: row.render.bytes_html, svg: row.render.bytes_svg };
  }
  return { runs, timings, bytes };
}

/** One test-runner pass (full bench only): the summary lines of the TAP reporter. */
export function runTestSuite(root) {
  const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => join('test', f));
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const grab = (name) => { const m = new RegExp(`^# ${name} (\\d+)`, 'm').exec(r.stdout ?? ''); return m ? Number(m[1]) : null; };
  return { tests: grab('tests'), pass: grab('pass'), fail: grab('fail'), skipped: grab('skipped'), exit: r.status, wall_ms: round(performance.now() - t0) };
}

/** The fresh-clone simulation (full bench only): copy the tree minus vendor/three, node_modules, .dotfield, data, center; count commands until exit 0. */
export function freshClone(root, env) {
  const tmp = mkdtempSync(join(tmpdir(), 'dotfield-fresh-'));
  const clone = join(tmp, 'clone');
  const out = { copied_without: [...FRESH_CLONE_SKIP, 'vendor/three'], steps: {}, note: 'step 1 is the clone itself; commands are counted until one exits 0' };
  try {
    cpSync(root, clone, { recursive: true, filter: (src) => { const rel = relative(root, src); if (!rel) return true; const top = rel.split(sep)[0]; if (FRESH_CLONE_SKIP.includes(top)) return false; return !(rel === join('vendor', 'three') || rel.startsWith(join('vendor', 'three') + sep)); } });
    const spawn = (args) => {
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [join(clone, 'bin', 'dotfield.mjs'), ...args, '--json'], { cwd: clone, encoding: 'utf8', env: { ...env } });
      let json = null; try { json = JSON.parse(r.stdout); } catch { json = null; }
      return { exit: r.status, wall_ms: round(performance.now() - t0), codes: json ? [...new Set(json.checks.filter((c) => c.status === 'fail' && c.blocking).map((c) => c.code))] : [], status: json ? json.status : null };
    };
    for (const [name, view] of [['2d', '2d'], ['all', 'all']]) {
      const r = spawn(['render', 'examples/scene-graph.json', '--view', view]);
      out.steps[name] = { commands: ['git clone', `render examples/scene-graph.json --view ${view}`], steps_to_exit_0: r.exit === 0 ? 2 : null, ...r };
    }
    const emb = spawn(['render', 'examples/scene-graph.json', '--view', 'all', '--embed-three']);
    out.steps.embed = { commands: ['git clone', 'render … --view all --embed-three'], steps_to_exit_0: emb.exit === 0 ? 2 : null, ...emb, next: emb.exit === 0 ? null : 'npm run vendor (network, once), then render again: not run here' };
    out.cli = { render_2d_wall_ms: out.steps['2d'].wall_ms };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/**
 * The quick path (V2_PLAN §6) measured in process, in a temp root (both modes; no
 * spawn, no timing): render templates/architecture.sketch.json with no out path at
 * --view 2d and --view all (steps = the clone + that one render when it exits 0),
 * then every template at --quality showcase --view all --no-embed-three, counting
 * every fail row (blocking or not).
 */
export async function firstOutput(root, env) {
  const tmp = mkdtempSync(join(tmpdir(), 'dotfield-first-'));
  const e = { ...env }; delete e.DOTFIELD_ROOT;
  try {
    const dir = join(root, 'templates');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sketch.json')).sort() : [];
    const quick = join(dir, 'architecture.sketch.json');
    const render = async (args) => (await dispatch(['render', ...args], { cwd: tmp, env: e, stdin: null, stdout: null })).receipt;
    const steps = async (view) => (existsSync(quick) && (await render([quick, '--view', view])).exit_code === 0 ? 2 : null);
    const rows = [];
    for (const f of files) {
      const r = await render([join(dir, f), '--view', 'all', '--quality', 'showcase', '--no-embed-three']);
      rows.push({ template: `templates/${f}`, exit: r.exit_code, fail_rows: r.checks.filter((c) => c.status === 'fail').length });
    }
    return { command: 'node bin/dotfield.mjs render templates/architecture.sketch.json --view 2d|all', steps_2d: await steps('2d'), steps_all: await steps('all'), templates: rows.length, templates_exit_0: rows.filter((r) => r.exit === 0).length, template_fail_rows: rows.reduce((n, r) => n + r.fail_rows, 0), rows };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function loadTools(root) {
  try { const mod = await import(pathToFileURL(join(root, 'mcp', 'server.mjs')).href); return Array.isArray(mod.TOOLS) ? mod.TOOLS : []; } catch { return []; }
}

function receiptRoundTrip(ctx) {
  const tmp = mkdtempSync(join(tmpdir(), 'dotfield-bench-receipt-'));
  try {
    const receipt = buildReceipt({ command: 'validate', argv: ['validate', 'benchmark'], now: ctx.now, inputs: [], checks: [], status: 'read', root: ctx.packageRoot });
    const path = writeReceipt(receipt, tmp);
    return verifyReceipt(path, { root: tmp, engineRoot: ctx.packageRoot }).ok === true;
  } catch { return false; } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * runBenchmark({ quick, root, env, sceneIds }) -> { result, json, auto, checklist, elapsed_ms }
 * `sceneIds` narrows the shipped scenes (tests use three). Nothing is written.
 */
export async function runBenchmark({ quick = true, root = ROOT, env = process.env, sceneIds = null } = {}) {
  const t0 = performance.now();
  const ctx = createContext({ cwd: root, env });
  const c = corpus({ quick, root });
  if (sceneIds) c.scenes = c.scenes.filter((s) => sceneIds.includes(s.id));
  // Every row's determinism probe compares all four tables (positions, routes, labels, plan), synthetic and workflow rows included.
  const runner = memoRunner(layoutTables);
  const timings = quick ? null : { scenes: {}, synthetic: {}, workflows: {} };
  const bytes = { scenes: {}, synthetic: {}, probes: {} };
  const scenes = [];
  for (const s of c.scenes) {
    const m = measureRuns(s.scene, ctx, { quick, runner, v1ViewBox: s.viewbox_2026_10_07 });
    scenes.push({ id: s.id, path: s.path, sha256: s.sha256, nodes: m.runs[0].nodes, edges: m.runs[0].edges, mode2d: m.runs[0].mode2d, runs: m.runs });
    if (timings) timings.scenes[s.id] = m.timings;
    bytes.scenes[s.id] = m.bytes;
  }
  const synthetic = [];
  for (const s of c.synthetic) {
    const digest = sha256(canonical(s.scene));
    const base = { id: s.id, family: s.family, n: s.n, seed: s.seed, timing_only: s.timing_only, digest, nodes: s.scene.nodes.length, edges: s.scene.edges.length, mode2d: s.scene.views['2d'].layout };
    if (s.timing_only) { const t = timed(() => layoutScene(s.scene)); if (timings) timings.synthetic[s.id] = { layout_ms: round(t.ms) }; synthetic.push({ ...base, runs: [] }); continue; }
    const m = measureRuns(s.scene, ctx, { quick, runner, qualities: quick ? ['checked'] : QUALITIES });
    synthetic.push({ ...base, runs: m.runs });
    if (timings) timings.synthetic[s.id] = m.timings;
    bytes.synthetic[s.id] = m.bytes;
  }
  const workflows = [];
  for (const w of c.workflows) {
    if (!MODES_2D.includes(w.layout)) { workflows.push({ id: w.id, layout: w.layout, status: 'not_implemented', fails: null, runs: [] }); continue; }
    const t = timed(() => measureScene(w.scene, ctx, { quality: 'checked', views: '2d', runner }));
    const row = t.value;
    workflows.push({ id: w.id, layout: w.layout, status: row.status === 'written' ? 'written' : `blocked at ${row.blocked_at}`, fails: failsLabel(row.fails), runs: [{ quality: 'checked', views: '2d', ...strip(row) }] });
    if (timings) timings.workflows[w.id] = { in_process_ms: round(t.ms) };
  }
  const probeScene = (c.scenes.find((s) => s.id === 'scene-graph') ?? c.scenes[0]).scene;
  const tokensCss = ctx.tokens().css; const vendorDir = join(ctx.packageRoot, 'vendor'); const rendererDir = join(ctx.packageRoot, 'renderers');
  const render = (embedThree) => renderHtmlDetailed(probeScene, { views: 'all', tokensCss, embedThree, vendorDir, rendererDir, now: ctx.now });
  const def = render(false); const def2 = render(false); const emb = render(true);
  bytes.probes = { default_all_views_html: def.bytes, embed_all_views_html: emb.bytes, vendor_present: emb.importmap.missing.length === 0, renderer_present: emb.renderer.present };
  const tests = quick ? null : runTestSuite(root);
  const pr = probes({ root, html: def.html, htmlEmbedded: emb.html, scenes: c.scenes.map((s) => s.scene), tools: await loadTools(root), testSummary: tests, receiptRoundTrip: receiptRoundTrip(ctx), renderDigests: [sha256(def.html), sha256(def2.html)] });
  pr.memo = { ...runner.stats };
  const fresh = quick ? null : freshClone(root, env);
  const first = await firstOutput(root, env);
  const result = { corpus: c, scenes, synthetic, workflows, probes: pr, quick };
  const checklistDoc = JSON.parse(readFileSync(CHECKLIST_JSON, 'utf8'));
  const auto = renderMarkdownBlock(result);
  const checklist = renderChecklistBlock(checklistDoc, pr);
  const elapsed = round(performance.now() - t0);
  const json = toJson(result, { mode: quick ? 'quick' : 'full', timings, bytes, node: process.version, digests: engineDigests(root), generated_at: isoSeconds(ctx.now), fresh_clone: fresh, cli: fresh ? fresh.cli : null, tests });
  json.first_output = first;
  if (!quick) json.elapsed_ms = elapsed;
  return { result, json, auto, checklist, elapsed_ms: elapsed, ctx };
}

function firstDiff(a, b) {
  const la = String(a).split('\n'); const lb = String(b).split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) if (la[i] !== lb[i]) return { line: i + 1, committed: lb[i] ?? '<missing>', fresh: la[i] ?? '<missing>' };
  return null;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { stderr.write(`${e.message}\n`); return EXIT.ERROR; }
  if (args.help) { stdout.write(`${USAGE}\n`); return EXIT.OK; }
  const { json, auto, checklist, elapsed_ms, ctx } = await runBenchmark({ quick: args.quick });
  if (args.json) { const path = resolve(args.json); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`); stdout.write(`benchmark: wrote ${path}\n`); }
  if (args.check) {
    const md = existsSync(BENCHMARK_MD) ? readFileSync(BENCHMARK_MD, 'utf8') : '';
    const drift = [];
    for (const [name, start, end, body] of [['auto', AUTO_START, AUTO_END, auto], ['checklist', CHECKLIST_START, CHECKLIST_END, checklist]]) {
      const current = extractBlock(md, start, end);
      if (current === null) { drift.push(`${name}: markers missing from references/BENCHMARK.md`); continue; }
      if (current !== `\n${body}\n`) { const d = firstDiff(`\n${body}\n`, current); drift.push(`${name}: block differs at line ${d.line}\n  committed: ${d.committed}\n  fresh:     ${d.fresh}`); }
    }
    if (drift.length) { stderr.write(`benchmark: stale (${elapsed_ms} ms, ${args.quick ? 'quick' : 'full'}) — run: node scripts/benchmark.mjs --write${args.quick ? ' --quick' : ''}\n${drift.join('\n')}\n`); return EXIT.DRIFT; }
    stdout.write(`benchmark: ok — both blocks of references/BENCHMARK.md are current (${elapsed_ms} ms, ${args.quick ? 'quick' : 'full'})\n`);
  }
  if (args.write) {
    const md = readFileSync(BENCHMARK_MD, 'utf8');
    writeFileSync(BENCHMARK_MD, replaceBlock(replaceBlock(md, AUTO_START, AUTO_END, auto), CHECKLIST_START, CHECKLIST_END, checklist));
    mkdirSync(OUT_DIR, { recursive: true });
    const out = join(OUT_DIR, `${compactStamp(ctx.now)}.json`);
    writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
    stdout.write(`benchmark: wrote references/BENCHMARK.md blocks and ${relative(ROOT, out)} (${elapsed_ms} ms, ${args.quick ? 'quick' : 'full'})\n`);
  }
  if (!args.check && !args.write && !args.json) stdout.write(`${auto}\n\n(${elapsed_ms} ms, ${args.quick ? 'quick' : 'full'}; pass --write, --check or --json)\n`);
  return EXIT.OK;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`benchmark: ${e && e.stack ? e.stack : String(e)}\n`); process.exitCode = EXIT.ERROR; });
