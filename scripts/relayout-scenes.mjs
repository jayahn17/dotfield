#!/usr/bin/env node
// Re-lay committed scenes cold (V2_PLAN §3: committed tables are always
// cold-run outputs). Every laid_out scene-*.json under the targets is run
// through lib/layout/index.mjs layoutScene(scene, {force: true}) with the
// shipped renderers/tokens.css and the scene's own meta.theme, and written
// back in the repository's JSON style (two-space indent, arrays of scalars
// and of [x, y] pairs on one line) with routes and labels right after
// positions. A scene that is not laid_out is left alone (it is laid out at
// render time). --check runs the same cold layout in memory, writes
// nothing, and exits 1 naming every file and table entry that differs.
//
//   node scripts/relayout-scenes.mjs <target>... [--check]
//     target  a scene file, or a folder: its scene-*.json and those in
//             <folder>/*/examples/ (so `packs` means packs/*/examples, the
//             shipped packs; drafts live one level deeper and are not touched)
//   exit 0 written / current, 1 drift under --check, 2 usage error
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutScene } from '../lib/layout/index.mjs';
import { canonical } from '../lib/digest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, 'renderers', 'tokens.css');
const SCENE_RE = /^scene-.*\.json$/;
const TABLES = ['positions', 'routes', 'labels'];
const LINE_WIDTH = 120;
export const USAGE = 'usage: node scripts/relayout-scenes.mjs <scene file | folder>... [--check]';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const scalar = (v) => v === null || typeof v !== 'object';
const flat = (v) => Array.isArray(v) && v.every((x) => scalar(x) || (Array.isArray(x) && x.every(scalar)));

/** JSON in the repository's style: two-space indent; an array of scalars or of scalar arrays stays on one line while that line fits 120 columns. */
export function formatJson(value, depth = 0, lead = 0) {
  const pad = (d) => '  '.repeat(d);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (flat(value)) {
      const inline = `[${value.map((x) => (Array.isArray(x) ? `[${x.map((y) => JSON.stringify(y)).join(', ')}]` : JSON.stringify(x))).join(', ')}]`;
      if (lead + inline.length + 1 <= LINE_WIDTH) return inline;
    }
    return `[\n${value.map((x) => `${pad(depth + 1)}${formatJson(x, depth + 1, (depth + 1) * 2)}`).join(',\n')}\n${pad(depth)}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => { const head = `${pad(depth + 1)}${JSON.stringify(k)}: `; return `${head}${formatJson(value[k], depth + 1, head.length)}`; }).join(',\n')}\n${pad(depth)}}`;
  }
  return JSON.stringify(value);
}

// The scene files a target names: a file, or a folder's scene files plus those in each <folder>/<child>/examples, sorted.
export function sceneFiles(target, root = ROOT) {
  const abs = resolve(root, target);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  const out = readdirSync(abs).filter((f) => SCENE_RE.test(f)).map((f) => join(abs, f));
  for (const d of readdirSync(abs).sort()) {
    const ex = join(abs, d, 'examples');
    if (statSync(join(abs, d)).isDirectory() && existsSync(ex)) for (const f of readdirSync(ex)) if (SCENE_RE.test(f)) out.push(join(ex, f));
  }
  return out.sort();
}

/** The scene re-laid cold, keys in the committed order with routes and labels right after positions. */
export function relaid(scene, tokensCss) {
  const laid = layoutScene(scene, { force: true, tokensCss, theme: isObject(scene.meta) ? scene.meta.theme : undefined });
  const out = {};
  const put = (k) => { if (Object.hasOwn(laid, k) && !Object.hasOwn(out, k)) out[k] = laid[k]; };
  for (const k of Object.keys(scene)) {
    if (k === 'routes' || k === 'labels') continue;
    if (k === 'laid_out') { put('positions'); put('routes'); put('labels'); }
    put(k);
    if (k === 'positions') { put('routes'); put('labels'); }
  }
  for (const k of ['positions', 'routes', 'labels', 'laid_out', ...Object.keys(laid)]) put(k);
  return out;
}

/** The table entries two scenes disagree on: 'positions.n7', 'routes.e3', 'labels.n2', 'views.2d.plan', 'views.2d.viewBox'. */
export function tableDiffs(a, b) {
  const diffs = [];
  for (const t of TABLES) {
    const A = isObject(a[t]) ? a[t] : {}; const B = isObject(b[t]) ? b[t] : {};
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (canonical(A[k] ?? null) !== canonical(B[k] ?? null)) diffs.push(`${t}.${k}`);
  }
  const va = isObject(a.views) && isObject(a.views['2d']) ? a.views['2d'] : {};
  const vb = isObject(b.views) && isObject(b.views['2d']) ? b.views['2d'] : {};
  for (const k of ['plan', 'viewBox']) if (canonical(va[k] ?? null) !== canonical(vb[k] ?? null)) diffs.push(`views.2d.${k}`);
  return diffs;
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, root = ROOT } = {}) {
  const check = argv.includes('--check');
  const targets = argv.filter((a) => a !== '--check');
  if (!targets.length || targets.some((t) => t.startsWith('-'))) { stderr.write(`${USAGE}\n`); return 2; }
  const tokensCss = readFileSync(TOKENS, 'utf8');
  const files = [...new Set(targets.flatMap((t) => sceneFiles(t, root)))];
  if (!files.length) { stderr.write(`relayout-scenes: no scene-*.json under ${targets.join(', ')}\n${USAGE}\n`); return 2; }
  let drift = 0; let written = 0; let skipped = 0;
  for (const file of files) {
    const rel = relative(root, file);
    const text = readFileSync(file, 'utf8');
    const scene = JSON.parse(text);
    if (!isObject(scene) || scene.laid_out !== true) { skipped += 1; stdout.write(`skip ${rel} (not laid_out)\n`); continue; }
    const next = relaid(scene, tokensCss);
    const body = `${formatJson(next)}\n`;
    if (check) {
      if (body !== text) { drift += 1; const d = tableDiffs(scene, next); stdout.write(`drift ${rel}: ${d.length ? d.slice(0, 8).join(', ') + (d.length > 8 ? ` and ${d.length - 8} more` : '') : 'formatting'}\n`); }
      continue;
    }
    if (body !== text) { writeFileSync(file, body); written += 1; stdout.write(`wrote ${rel}\n`); }
  }
  if (check) {
    stdout.write(drift ? `relayout-scenes --check: ${drift} of ${files.length - skipped} scene(s) differ from a cold run; run node scripts/relayout-scenes.mjs ${targets.join(' ')}\n` : `relayout-scenes --check: ${files.length - skipped} scene(s) current\n`);
    return drift ? 1 : 0;
  }
  stdout.write(`relayout-scenes: ${written} written, ${files.length - skipped - written} unchanged, ${skipped} skipped\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
