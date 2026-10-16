// Static hygiene scans over the engine tree (VISION §10, BUILD_CONTRACT §2).
// Every scan tolerates folders that do not exist yet: components land in
// order, and an empty folder is simply nothing to check. The two count pins
// (26 CLI leaves, 12 MCP tools) skip, not fail, while their folders are empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import {
  ROOT, SCAN_DIRS, CODE_EXTS, SOURCE_EXTS, TEXT_EXTS, SKIP_DIRS, JAY_RE, EMAIL_RE, PHONE_RE, HEX_RE,
  walk, walkMany, read, exists, hasFiles, lineCount, imports, resolveSpecifier, absolutePathRe, absolutePathHits, matchLines, walkJson,
} from './helpers/scan.mjs';
import { PINNED } from '../lib/rules.mjs';

const ROOM_FILES = ['room.json', 'record.schema.json', 'views.json', 'examples.json'];
const STORE_IMPORTERS = new Set(['lib/project.mjs', 'lib/proposals.mjs', 'lib/commands/export.mjs', 'lib/commands/delete.mjs']);
const SPAWNERS = new Set(['lib/sandbox.mjs', 'lib/providers/claude-cli.mjs', 'lib/commands/serve.mjs']);
const CLOCK_EXEMPT = new Set(['lib/context.mjs']);
const HEX_EXEMPT = (rel) => rel === 'renderers/tokens.css'
  || /^packs\/(?:draft\/)?[^/]+\/theme\.json$/.test(rel) || rel.endsWith('.generated.css');
const ABS_EXEMPT = new Set(['lib/rules/privacy.mjs', 'VISION.md', 'references/PROVENANCE.md']);
const JAY_EXEMPT = (rel) => rel === 'LICENSE' || (/^[^/]+\.md$/.test(rel));

const codeFiles = () => walkMany(SCAN_DIRS, { exts: CODE_EXTS });
const sourceFiles = () => walkMany(SCAN_DIRS, { exts: SOURCE_EXTS });
const textFiles = () => walkMany(SCAN_DIRS, { exts: TEXT_EXTS });
const fmt = (hits) => hits.map((h) => `  ${h.file}:${h.line ?? ''} ${h.match ?? h.detail ?? ''}`).join('\n');

function roomDirs() {
  const dirs = new Set();
  for (const rel of walkMany(['packs'])) {
    const m = rel.match(/^(packs(?:\/draft)?\/[^/]+\/rooms\/[^/]+)\//);
    if (m) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

test('every room folder carries the four required files', () => {
  const missing = [];
  for (const dir of roomDirs()) for (const f of ROOM_FILES) if (!exists(`${dir}/${f}`)) missing.push(`${dir}/${f}`);
  assert.deepEqual(missing, [], `room folders missing files:\n  ${missing.join('\n  ')}`);
});

test('only project.mjs, proposals.mjs, export.mjs, delete.mjs and tests import lib/store.mjs', () => {
  const bad = [];
  for (const rel of codeFiles()) {
    for (const spec of imports(read(rel))) {
      const abs = resolveSpecifier(rel, spec);
      if (abs && abs.endsWith('/lib/store.mjs') && !STORE_IMPORTERS.has(rel)) bad.push({ file: rel, detail: spec });
    }
  }
  assert.deepEqual(bad, [], `the exit door is lib/project.mjs; these import the store directly:\n${fmt(bad)}`);
});

test('server/ and mcp/ files that build nodes go through project.mjs or meet.mjs', () => {
  const bad = [];
  for (const rel of walkMany(['server', 'mcp'], { exts: CODE_EXTS })) {
    const text = read(rel);
    if (!/\bnodes\s*:/.test(text)) continue;
    const specs = imports(text);
    const ok = specs.some((s) => /(^|\/)(project|meet)\.mjs$/.test(s));
    if (!ok) bad.push({ file: rel, detail: 'serialises nodes without importing lib/project.mjs or lib/meet.mjs' });
  }
  assert.deepEqual(bad, [], fmt(bad));
});

test('customer modules are spawned only through lib/sandbox.mjs', () => {
  const bad = [];
  for (const rel of codeFiles()) {
    const specs = imports(read(rel));
    const spawns = specs.some((s) => s === 'node:child_process' || s === 'child_process');
    if (spawns && !SPAWNERS.has(rel)) bad.push({ file: rel, detail: 'imports child_process' });
    for (const s of specs) {
      if (/(^|\/)(actions|test)\.mjs$/.test(s) || /center\/importers\//.test(s)) {
        if (rel !== 'lib/sandbox.mjs') bad.push({ file: rel, detail: `imports customer module ${s}` });
      }
    }
  }
  assert.deepEqual(bad, [], `only lib/sandbox.mjs (and claude-cli.mjs, serve.mjs) may spawn:\n${fmt(bad)}`);
});

test('renderers are free of fetch( and localStorage', () => {
  const bad = [];
  for (const rel of walk('renderers', { exts: SOURCE_EXTS })) {
    const text = read(rel);
    for (const h of matchLines(text, /\bfetch\s*\(/g)) bad.push({ file: rel, ...h });
    for (const h of matchLines(text, /\blocalStorage\b/g)) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `renderers are pure functions of (scene, tokens):\n${fmt(bad)}`);
});

test('no raw hex colour outside renderers/tokens.css (exempt center/brand.json, packs/*/theme.json, *.generated.css)', () => {
  const bad = [];
  const exts = new Set([...SOURCE_EXTS, '.json']);
  for (const rel of walkMany(SCAN_DIRS, { exts })) {
    if (HEX_EXEMPT(rel)) continue;
    for (const h of matchLines(read(rel), HEX_RE)) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `DF_RENDER_HEX_LITERAL — use a --df-* token:\n${fmt(bad)}`);
});

test('no .ext reference under renderers/ or lib/layout/', () => {
  const bad = [];
  for (const rel of walkMany(['renderers', 'lib/layout'], { exts: CODE_EXTS })) {
    const text = read(rel);
    for (const h of matchLines(text, /\.ext\b|\[\s*["']ext["']\s*\]/g)) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `ext is for customer round-tripping only:\n${fmt(bad)}`);
});

test('no proof.command key anywhere (proof is {test, expected[]}, never a shell string)', () => {
  const bad = [];
  for (const rel of textFiles()) {
    const text = read(rel);
    if (rel.endsWith('.json')) {
      let doc;
      try { doc = JSON.parse(text); } catch { continue; }
      walkJson(doc, (key, value, path) => {
        if (key === 'proof' && value && typeof value === 'object' && !Array.isArray(value)
          && Object.hasOwn(value, 'command')) bad.push({ file: rel, detail: path });
      });
    } else if (CODE_EXTS.has(`.${rel.split('.').pop()}`)) {
      for (const h of matchLines(text, /\bproof\s*:\s*\{[^}]*\bcommand\s*:/g)) bad.push({ file: rel, ...h });
    }
  }
  assert.deepEqual(bad, [], `DF_ROOM_PROOF_COMMAND_FORBIDDEN:\n${fmt(bad)}`);
});

test('every source file is under 400 lines (scan set, scripts/, test/ minus fixtures)', () => {
  const bad = [];
  const files = new Set([
    ...sourceFiles(),
    ...walk('scripts', { exts: CODE_EXTS }),
    ...walk('test', { exts: CODE_EXTS, skip: new Set([...SKIP_DIRS, 'fixtures']) }),
  ]);
  for (const rel of files) {
    const n = lineCount(read(rel));
    if (n >= 400) bad.push({ file: rel, detail: `${n} lines` });
  }
  assert.deepEqual(bad, [], `split these files:\n${fmt(bad)}`);
});

test('no jay, email or phone number under the scanned folders', () => {
  const bad = [];
  for (const rel of textFiles()) {
    const text = read(rel);
    if (!JAY_EXEMPT(rel)) for (const h of matchLines(text, new RegExp(JAY_RE.source, 'gi'))) bad.push({ file: rel, ...h });
    for (const h of matchLines(text, EMAIL_RE)) bad.push({ file: rel, ...h });
    for (const h of matchLines(text, PHONE_RE)) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `private identifiers never enter the template:\n${fmt(bad)}`);
});

test('no absolute home path under the scanned folders (ABSOLUTE_PATH_RE from lib/rules.mjs when present)', async () => {
  const re = await absolutePathRe();
  const bad = [];
  for (const rel of textFiles()) {
    if (ABS_EXEMPT.has(rel)) continue;
    for (const h of absolutePathHits(read(rel), re, { json: rel.endsWith('.json') })) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `DF_PRIVACY_ABSOLUTE_PATH:\n${fmt(bad)}`);
});

test('library code uses ctx.now and lib/layout/rng.mjs, never Date.now() or Math.random()', () => {
  const bad = [];
  for (const rel of walkMany(['bin', 'lib', 'renderers', 'server', 'mcp', 'importers'], { exts: SOURCE_EXTS })) {
    if (CLOCK_EXEMPT.has(rel)) continue;
    const text = read(rel);
    for (const h of matchLines(text, /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\.random\s*\(/g)) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `determinism is engineered (exempt: lib/context.mjs):\n${fmt(bad)}`);
});

test('no engine file or test reads the folder\'s own center/: a fork customises it and the template ships none', () => {
  const re = /\b(?:ROOT|PACKAGE_ROOT|packageRoot)\s*,\s*['"]center['"]/;
  const bad = [];
  for (const rel of walkMany(['bin', 'lib', 'renderers', 'server', 'mcp', 'importers', 'scripts', 'test'], { exts: CODE_EXTS })) {
    if (rel === 'test/structure.test.js') continue;
    for (const h of matchLines(read(rel), new RegExp(re.source, 'g'))) bad.push({ file: rel, ...h });
  }
  assert.deepEqual(bad, [], `boot a center in a temp dir (test/helpers/center.mjs scaffoldCenter or initCenter):\n${fmt(bad)}`);
});

test('the template tracks no center/ (runs where DOTFIELD_TEMPLATE_REPO=1: the template repository and its CI)', async (t) => {
  if (process.env.DOTFIELD_TEMPLATE_REPO !== '1') return t.skip('a fork tracks its own center/; set DOTFIELD_TEMPLATE_REPO=1 in the template');
  const { trackedCenter } = await import('../scripts/pack-init-check.mjs');
  assert.deepEqual(trackedCenter(ROOT), [], 'git rm --cached -r center/: the template ships packs, init writes the center');
});

test('packs hold no code (JSON, a README, example CSV) and the root ignores data/, .dotfield/, vendor/three/', () => {
  const code = walk('packs', { exts: CODE_EXTS });
  assert.deepEqual(code, [], `packs never carry code:\n  ${code.join('\n  ')}`);
  const ignore = read('.gitignore');
  for (const line of ['data/', '.dotfield/', 'vendor/three/']) assert.match(ignore, new RegExp(`^${line.replace('.', '\\.')}$`, 'm'));
  assert.doesNotMatch(read('.gitattributes'), /merge=ours/, 'the template ships no center/, so pulling upstream needs no merge driver');
  assert.doesNotMatch(ignore, /^\/?center\/?$/m, 'a fork commits the center init writes; only the generated tokens file is ignored');
});

test(`CLI verbs: PINNED.cli_verbs verbs and PINNED.cli_leaf_subverbs leaf subverbs (${PINNED.cli_verbs}/${PINNED.cli_leaf_subverbs}; skips until lib/commands/ exists)`, async (t) => {
  if (!hasFiles('lib/commands')) return t.skip('lib/commands/ not built yet (cli-core, cli-full)');
  const verbs = [];
  let leaves = 0;
  for (const rel of walk('lib/commands', { exts: CODE_EXTS })) {
    const mod = await import(new URL(`../${rel}`, import.meta.url).href);
    const verb = mod.verb ?? basename(rel, '.mjs');
    verbs.push(verb);
    leaves += Array.isArray(mod.leaves) && mod.leaves.length ? mod.leaves.length : 1;
  }
  assert.equal(verbs.length, PINNED.cli_verbs, `${PINNED.cli_verbs} verbs expected, ${verbs.length} present: ${verbs.sort().join(', ')}`);
  assert.equal(leaves, PINNED.cli_leaf_subverbs, `${PINNED.cli_leaf_subverbs} leaf subverbs expected, counted ${leaves}`);
});

test('MCP: exactly 12 tools, none named *approve*, *project*, *export* or *delete* (skips until mcp/ exists)', async (t) => {
  if (!hasFiles('mcp')) return t.skip('mcp/ not built yet');
  let names = null;
  if (exists('mcp/server.mjs')) {
    try {
      const mod = await import(new URL('../mcp/server.mjs', import.meta.url).href);
      const tools = mod.TOOLS ?? mod.tools ?? null;
      if (Array.isArray(tools)) names = tools.map((x) => (typeof x === 'string' ? x : x.name));
    } catch {
      names = null;
    }
  }
  if (!names) {
    const set = new Set();
    for (const rel of walk('mcp', { exts: CODE_EXTS })) {
      for (const m of read(rel).matchAll(/name:\s*['"](dotfield_[a-z_]+)['"]/g)) set.add(m[1]);
    }
    names = [...set];
  }
  names = [...new Set(names)].sort();
  assert.equal(names.length, 12, `12 tools expected: ${names.join(', ')}`);
  const forbidden = names.filter((n) => /approve|project|export|delete/i.test(n));
  assert.deepEqual(forbidden, [], `the agent cannot close its own loop: ${forbidden.join(', ')}`);
});

test('the scan root is the engine folder: it holds VISION.md and package.json whatever the checkout is named', () => {
  // The folder name is not pinned: after `git subtree split` a clone may be called anything (VISION §0, §11 slice 8).
  assert.ok(exists('VISION.md') && exists('package.json'), `no VISION.md/package.json at ${basename(ROOT)}`);
  assert.ok(exists('lib/validate.mjs') && exists('schemas/receipt.schema.json'), 'the engine folders sit beside the manifests');
});
