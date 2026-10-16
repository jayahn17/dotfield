#!/usr/bin/env node
// scripts/subtree-check.mjs — can dotfield/ leave the parent repository intact?
//
//   node scripts/subtree-check.mjs [--root <dir>] [--json]
//
// Two halves, no `git subtree` call: (1) git — every file under the folder
// that git would not carry across a split (untracked and not ignored) and
// every tracked symlink that points outside are findings; (2) the import and
// path scan — every import/require specifier in code must be a node builtin,
// the MCP SDK (under mcp/ only), three (under renderers/ only) or a relative
// path that stays inside the folder, and no script, config or doc may name a
// `../` path that resolves outside it. Exit 0 when nothing escapes; exit 1
// with one line per finding otherwise. When the folder is not tracked at all
// the git half is reported as provisional and only the scan decides.
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_EXTS = new Set(['.mjs', '.js', '.cjs']);
export const TEXT_EXTS = new Set(['.mjs', '.js', '.cjs', '.json', '.sh', '.yml', '.yaml', '.md']);
/** center/ is the owner's (init writes it; a fork tracks it, the template never does), like data/ and .dotfield/. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.dotfield', 'center']);
export const SKIP_PATHS = new Set(['vendor/three']);
/** Prose that names parent-repo paths on purpose (lineage, the ownership map). */
export const PATH_EXEMPT = new Set(['VISION.md', 'references/PROVENANCE.md', 'references/BUILD_CONTRACT.md']);
export const FORBIDDEN_PACKAGES = /^(zod|aframe|a-frame|@?three(?!$|\/)|express|react|vue|svelte)/i;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const IMPORT_RES = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const DOTS_RE = /(?:^|[\s"'`(=:])((?:\.\.\/)+[\w-][\w./-]*)/g;
const posix = (p) => p.split(sep).join('/');

/** Every module specifier a file names (static, re-export, dynamic, require). */
export function imports(text) {
  const found = new Set();
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) found.add(m[1]);
  return [...found];
}

export function inside(root, abs) {
  const rel = relative(resolve(root), resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Sorted root-relative posix paths of every file (symlinks included) under root, skipping owner data, deps and the git dir. */
export function listTree(root) {
  const out = [];
  const stack = [resolve(root)];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, e.name);
      const rel = posix(relative(root, abs));
      if (e.isDirectory() && !e.isSymbolicLink()) { if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(rel)) stack.push(abs); } else out.push(rel);
    }
  }
  return out.sort();
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
const zlist = (text) => text.split('\0').filter(Boolean).map(posix);

/** {available, toplevel, prefix, tracked[], untracked[], symlinks[{rel, target}], status} — status: tracked | untracked | unavailable. */
export function gitFiles(root) {
  const out = { available: false, toplevel: null, prefix: null, tracked: [], untracked: [], symlinks: [], status: 'unavailable' };
  try {
    out.toplevel = git(root, ['rev-parse', '--show-toplevel']).trim();
    out.prefix = posix(relative(realpathSync(out.toplevel), realpathSync(root)));
    out.available = true;
    out.tracked = zlist(git(root, ['ls-files', '-z', '--', '.']));
    out.untracked = zlist(git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']));
    for (const line of git(root, ['ls-files', '-s', '-z', '--', '.']).split('\0').filter(Boolean)) {
      const m = /^(\d{6}) \S+ \d\t(.+)$/.exec(line);
      if (m && m[1] === '120000') { const rel = posix(m[2]); let target = null; try { target = readlinkSync(resolve(root, rel)); } catch { target = null; } out.symlinks.push({ rel, target }); }
    }
    out.status = out.tracked.length ? 'tracked' : 'untracked';
  } catch { out.available = false; }
  return out;
}

function classify(root, rel, spec) {
  if (BUILTINS.has(spec)) return null;
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const abs = spec.startsWith('/') ? spec : resolve(root, dirname(rel), spec);
    return inside(root, abs) ? null : { code: 'import-outside', detail: spec };
  }
  if (spec.startsWith('@modelcontextprotocol/sdk')) return rel.startsWith('mcp/') ? null : { code: 'import-package', detail: `MCP SDK outside mcp/: ${spec}` };
  if (spec === 'three' || spec.startsWith('three/')) return rel.startsWith('renderers/') ? null : { code: 'import-package', detail: `three outside renderers/: ${spec}` };
  if (FORBIDDEN_PACKAGES.test(spec)) return { code: 'import-package', detail: `forbidden package: ${spec}` };
  return { code: 'import-package', detail: `bare specifier with dependencies {}: ${spec}` };
}

/** Findings over the tree: imports that escape or name a package, and `../` paths that leave the folder. */
export function scanFindings(root, files = listTree(root)) {
  const findings = [];
  for (const rel of files) {
    const ext = extname(rel);
    if (!TEXT_EXTS.has(ext)) continue;
    let text;
    try { text = readFileSync(resolve(root, rel), 'utf8'); } catch { continue; }
    if (CODE_EXTS.has(ext)) for (const spec of imports(text)) { const f = classify(root, rel, spec); if (f) findings.push({ level: 'fail', file: rel, ...f }); }
    if (PATH_EXEMPT.has(rel)) continue;
    for (const m of text.matchAll(DOTS_RE)) {
      const target = resolve(root, dirname(rel), m[1]);
      if (!inside(root, target)) findings.push({ level: 'fail', code: 'path-outside', file: rel, detail: m[1] });
    }
  }
  return findings;
}

/** Findings from git: files a split would drop, symlinks that point outside, or the provisional notes. */
export function gitFindings(root, g = gitFiles(root)) {
  if (!g.available) return [{ level: 'info', code: 'git-unavailable', file: '.', detail: 'not a git checkout (or git is missing): the tracked-file half is provisional' }];
  if (g.status === 'untracked') return [{ level: 'info', code: 'not-tracked', file: g.prefix || '.', detail: 'no file under this folder is tracked yet; the split cannot be checked until it is committed (provisional)' }];
  const out = g.untracked.map((rel) => ({ level: 'fail', code: 'untracked', file: rel, detail: 'on disk, not ignored, not tracked: a subtree split would drop it (git add it or ignore it)' }));
  for (const s of g.symlinks) if (s.target === null || !inside(root, resolve(root, dirname(s.rel), s.target))) out.push({ level: 'fail', code: 'symlink-outside', file: s.rel, detail: `symlink to ${s.target ?? '?'} leaves the folder` });
  return out;
}

/** checkSubtree({root}) -> {ok, root, git, counts, findings} — ok when no finding has level fail. */
export function checkSubtree({ root = DEFAULT_ROOT } = {}) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return { ok: false, root, git: null, counts: { files: 0 }, findings: [{ level: 'fail', code: 'root-missing', file: '.', detail: `${root} is not a directory` }] };
  const files = listTree(root);
  const g = gitFiles(root);
  const findings = [...gitFindings(root, g), ...scanFindings(root, files)];
  const { tracked, untracked, ...gitInfo } = g;
  return { ok: !findings.some((f) => f.level === 'fail'), root, git: { ...gitInfo, tracked: tracked.length, untracked: untracked.length }, counts: { files: files.length, code: files.filter((f) => CODE_EXTS.has(extname(f))).length }, findings };
}

export function format(report) {
  const lines = [];
  for (const f of report.findings) lines.push(`${f.level === 'fail' ? 'FAIL' : 'note'} ${f.code} ${f.file}: ${f.detail}`);
  const g = report.git;
  const gitLine = !g ? 'git: n/a' : !g.available ? 'git: unavailable' : g.status === 'untracked' ? `git: ${g.prefix || '.'} is not tracked (provisional)` : `git: ${g.tracked} tracked, ${g.untracked} untracked under ${g.prefix || 'the repository root'}`;
  lines.push(`subtree-check: ${report.ok ? 'ok' : 'FAILED'} — ${report.counts.files} file(s), ${report.counts.code ?? 0} code file(s) scanned; ${gitLine}`);
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--root' && argv[i + 1]) { out.root = resolve(argv[i + 1]); i += 1; }
    else if (argv[i].startsWith('--root=')) out.root = resolve(argv[i].slice(7));
  }
  return out;
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const report = checkSubtree({ root: args.root });
  stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : format(report));
  return report.ok ? 0 : 1;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) process.exitCode = main();
