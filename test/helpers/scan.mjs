// Shared static-scan helpers. structure.test.js, no-son-imports.test.js and
// the skill/release tests all read the tree through these so one definition
// of "a source file", "an import" and "a forbidden string" exists.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The folders the privacy / hygiene scans cover (BUILD_CONTRACT §2). */
/** The engine folders; center/ is the owner's (a fork's records and prose), never scanned by engine tests. */
export const SCAN_DIRS = ['bin', 'lib', 'renderers', 'server', 'mcp', 'importers', 'packs', 'schemas', 'examples', 'templates'];
export const CODE_EXTS = new Set(['.mjs', '.js', '.cjs']);
export const SOURCE_EXTS = new Set(['.mjs', '.js', '.cjs', '.css', '.html']);
export const TEXT_EXTS = new Set(['.mjs', '.js', '.cjs', '.json', '.css', '.html', '.md', '.csv', '.txt', '.yml', '.yaml', '.sh']);
/** Never descended: owner data, derived output, deps, the pinned browser asset. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.dotfield']);
export const SKIP_PATHS = new Set(['vendor/three']);

export const JAY_RE = /jay/i;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const PHONE_RE = /(?<![\w.:/-])(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g;
export const HEX_RE = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
/** Fallback until core-validate lands lib/rules.mjs; identical source. */
const ABSOLUTE_PATH_FALLBACK = /^(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|\\\\)/;

export function toPosix(p) {
  return p.split(sep).join('/');
}

/** Does `rel` (a directory) exist and hold at least one file, recursively? */
export function hasFiles(rel) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return false;
  return walk(rel).length > 0;
}

/**
 * walk(relDir, {exts, skip}) → sorted repo-relative posix paths of files.
 * A missing directory yields []: other components land later.
 */
export function walk(relDir, { exts = null, skip = SKIP_DIRS } = {}) {
  const out = [];
  const start = resolve(ROOT, relDir);
  if (!existsSync(start)) return out;
  if (!statSync(start).isDirectory()) return [toPosix(relDir)];
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name);
      const rel = toPosix(abs.slice(ROOT.length + 1));
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || SKIP_PATHS.has(rel)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        if (!exts || exts.has(extname(entry.name))) out.push(rel);
      }
    }
  }
  return out.sort();
}

export function walkMany(relDirs, opts) {
  const seen = new Set();
  for (const d of relDirs) for (const f of walk(d, opts)) seen.add(f);
  return [...seen].sort();
}

export function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

export function exists(rel) {
  return existsSync(resolve(ROOT, rel));
}

/** Physical line count: a trailing newline does not add a line. */
export function lineCount(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Every module specifier a file names: static import/export-from, dynamic
 * import(), and require(). Returns a de-duplicated array of strings.
 */
export function imports(text) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]);
  return [...found];
}

/** Resolve a relative specifier against the importing file; null for bare ones. */
export function resolveSpecifier(fromRel, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const abs = spec.startsWith('/') ? spec : resolve(ROOT, dirname(fromRel), spec);
  return toPosix(abs);
}

export function isInsideRoot(absPosix) {
  const root = toPosix(ROOT);
  return absPosix === root || absPosix.startsWith(`${root}/`);
}

/** Claude Code allow-list glob → RegExp. `*` matches any run of characters. */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

/** The one absolute-path regex, anchored exactly as lib/rules.mjs exports it. */
export async function absolutePathRe() {
  if (exists('lib/rules.mjs')) {
    try {
      const mod = await import(new URL('../../lib/rules.mjs', import.meta.url).href);
      if (mod.ABSOLUTE_PATH_RE instanceof RegExp) return new RegExp(mod.ABSOLUTE_PATH_RE.source, mod.ABSOLUTE_PATH_RE.flags.replace('g', ''));
    } catch {
      return ABSOLUTE_PATH_FALLBACK;
    }
  }
  return ABSOLUTE_PATH_FALLBACK;
}

/**
 * The gate tests a whole ref string against the anchored regex, so the scan
 * does the same: for JSON that parses, every decoded key and string value;
 * otherwise every quoted / whitespace-delimited token. Returns [{line, match}].
 */
export function absolutePathHits(text, re, { json = false } = {}) {
  const hits = [];
  if (json) {
    try {
      const strings = [];
      walkJson(JSON.parse(text), (key, value) => {
        strings.push(key);
        if (typeof value === 'string') strings.push(value);
      });
      for (const s of strings) {
        if (!re.test(s)) continue;
        const at = text.indexOf(JSON.stringify(s));
        const line = at >= 0 ? text.slice(0, at).split('\n').length : null;
        hits.push({ line, match: s.slice(0, 60) });
      }
      return hits;
    } catch {
      // unparsable JSON: fall through to the token scan
    }
  }
  text.split('\n').forEach((line, i) => {
    for (const token of line.split(/[\s"'`()[\],;<>]+/)) {
      if (token && re.test(token)) hits.push({ line: i + 1, match: token.slice(0, 60) });
    }
  });
  return hits;
}

/** Lines of `text` (1-based) where `re` matches; `re` must carry the g flag. */
export function matchLines(text, re) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    re.lastIndex = 0;
    const m = re.exec(line);
    if (m) hits.push({ line: i + 1, match: m[0] });
  });
  return hits;
}

/** Walk a parsed JSON value; call fn(key, value, path) for every object key. */
export function walkJson(value, fn, path = '$') {
  if (Array.isArray(value)) value.forEach((v, i) => walkJson(v, fn, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      fn(k, v, `${path}.${k}`);
      walkJson(v, fn, `${path}.${k}`);
    }
  }
}
