// lib/gates/render.mjs — the render gate over the emitted HTML/SVG. One entry
// per DF_RENDER_* code in catalog order (pass, or one fail per offending
// path); never throws, never mutates.
//
//   check(scene, ctx) with ctx = {
//     html, svg            the strings renderers/html.mjs / svg.mjs produced (either or both)
//     views                requested views ('all' | '2d,3d' | [...]); embedThree; vendorDir
//     tokensCss, theme     the css the render used (default renderers/tokens.css) and the theme
//     outputPath, root, dotDir, iKnow      for DF_RENDER_SELF_VIEW_EXPORTED (non-blocking)
//     viewer, config, sessionKey, requireProjected   for DF_RENDER_UNPROJECTED (delegated to privacy)
//     viewsOff             views a room's views.json disables; shapes  (kind -> row) override
//   }
//
// Motion is governed by structure (V2_PLAN §5): DF_RENDER_MOTION_INFINITE
// reads only <style> blocks other than the tokens block, style="…"
// attributes, SMIL <animate…> loops and the decoded data:text/javascript;
// base64 payloads of embedded modules, and refuses any CSS animation whose
// iteration count is not exactly 1 (a var() count cannot be proven 1) and any
// repeatCount|repeatDur="indefinite"; text content (a label or caption that
// says "infinite") is never read. DF_RENDER_MOTION_WITHOUT_STILL refuses a
// scene whose views.time.motion is trace|playback while the SVG carries no
// data-phase, so every motion scene degrades to a still. No privacy code
// (DF_RENDER_SELF_VIEW_EXPORTED included) has an author-declared exemption.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { codesForFamily, fail, pass } from '../rules.mjs';
import { resolveViewer, verifyStamp } from './privacy.mjs';
import { shapesTable } from '../layout/metrics.mjs';
import { parseThemes, resolveToken } from '../theme.mjs';
import { GLYPHS } from '../../renderers/svg.mjs';
import { CDN_BASE, ROOT, THREE_SPECIFIERS, needsThree, normalizeViews } from '../../renderers/html.mjs';

export const id = 'render';
export const PLAIN_BUDGET_BYTES = 4 * 1024 * 1024;
export const EMBED_BUDGET_BYTES = 8 * 1024 * 1024;
export const PINNED_PREFIX = CDN_BASE;
/** Same source as the structure scan's HEX_RE: a raw colour literal, never an entity or a word fragment. */
export const HEX_RE = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const REF_ATTR_RE = /<(?:script|link|img|iframe|video|audio|source|object|embed|use)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const TOKENS_BLOCK_RE = /<style data-df="tokens">[\s\S]*?<\/style>/g;
const DATA_BLOCK_RE = /<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g;
const IMPORTMAP_RE = /<script type="importmap">([\s\S]*?)<\/script>/;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_ATTR_RE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const DATA_JS_RE = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g;
/** A CSS animation declaration (shorthand or iteration-count longhand); the value is judged by badCounts(). */
const ANIMATION_DECL_RE = /animation(-iteration-count)?\s*:([^;}"'`<>]*)/gi;
/** SMIL loops: an animation element repeating indefinitely. */
export const SMIL_LOOP_RE = /<(?:animate|animateTransform|animateMotion|animateColor|set)\b[^>]*\brepeat(?:Count|Dur)\s*=\s*["']\s*indefinite\s*["'][^>]*>/gi;
export const MOTION_MODES = Object.freeze(['trace', 'playback']);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** The HTML with the exempt blocks removed: tokens (hex by design), data blocks (scene content, not references). */
export function stripExempt(html) {
  return String(html || '').replace(TOKENS_BLOCK_RE, '<style data-df="tokens"></style>').replace(DATA_BLOCK_RE, '');
}

export function importmapOf(html) {
  const m = IMPORTMAP_RE.exec(String(html || ''));
  if (!m) return null;
  try { const json = JSON.parse(m[1]); return isObject(json) ? { json, raw: m[0] } : null; } catch { return null; }
}

/** [{match, line}] for every raw hex colour outside the exempt blocks. */
export function hexLiterals(text) {
  const out = [];
  const src = String(text || '');
  for (const m of src.matchAll(HEX_RE)) out.push({ match: m[0], line: lineOf(src, m.index) });
  return out;
}

/** References that would leave the single file: [{ref, where}]; the pinned importmap is the one allowed origin. */
export function externalRefs(html) {
  const out = [];
  const stripped = stripExempt(html);
  const map = importmapOf(stripped);
  let rest = stripped;
  if (map) {
    rest = stripped.replace(map.raw, '');
    const urls = [...Object.values(isObject(map.json.imports) ? map.json.imports : {}), ...Object.keys(isObject(map.json.integrity) ? map.json.integrity : {})];
    for (const u of urls) if (typeof u === 'string' && !u.startsWith('data:') && !u.startsWith(PINNED_PREFIX)) out.push({ ref: u, where: 'importmap' });
  }
  for (const m of rest.matchAll(URL_RE)) out.push({ ref: m[0], where: `line ${lineOf(rest, m.index)}` });
  for (const m of rest.matchAll(REF_ATTR_RE)) {
    const ref = m[1];
    if (/^(data:|#|about:blank)/.test(ref) || /^https?:\/\//i.test(ref)) continue;
    out.push({ ref, where: `line ${lineOf(rest, m.index)}` });
  }
  return out;
}

/** The text with every data:text/javascript;base64 payload decoded in place (data:text/javascript;decoded,<source>). */
export function decodeDataUrls(text) {
  return String(text || '').replace(DATA_JS_RE, (m, b64) => `data:text/javascript;decoded,${Buffer.from(b64, 'base64').toString('utf8')}`);
}

/** Iteration counts in one declaration value that are not exactly 1: 'infinite', any other number, or an unprovable var(). */
export function badCounts(value, longhand = false) {
  const raw = String(value || '');
  if (/\bvar\s*\(/i.test(raw)) return ['var()'];
  let v = raw; let prev;
  do { prev = v; v = v.replace(/[a-z-]+\([^()]*\)/gi, ' '); } while (v !== prev);
  const out = [];
  for (const layer of v.split(',')) {
    const tokens = layer.trim().split(/\s+/).filter(Boolean);
    const counts = longhand ? tokens : tokens.filter((t) => /^(infinite|[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/i.test(t));
    for (const t of counts) if (t.toLowerCase() === 'infinite' || Number(t) !== 1) out.push(t);
  }
  return out;
}

function cssLoops(text, where, hits) {
  for (const m of String(text).matchAll(ANIMATION_DECL_RE)) {
    const bad = badCounts(m[2], Boolean(m[1]));
    if (bad.length) hits.push({ match: m[0].trim().slice(0, 80), where });
  }
}

/**
 * Looping motion in a render: [{match, where}] over the HTML (and the
 * standalone SVG when given) — <style> blocks minus the tokens block, style
 * attributes, SMIL loops, and the decoded data:text/javascript;base64
 * payloads. Scene data blocks are stripped first, so text never trips it.
 */
export function motionLoops(html, svg = null) {
  const hits = [];
  const scan = (doc, prefix) => {
    if (typeof doc !== 'string' || !doc) return;
    const markup = stripExempt(doc.replace(DATA_JS_RE, 'data:text/javascript;base64,'));
    for (const m of markup.matchAll(STYLE_BLOCK_RE)) cssLoops(m[1], `${prefix}style block`, hits);
    const outside = markup.replace(STYLE_BLOCK_RE, '');
    for (const m of outside.matchAll(STYLE_ATTR_RE)) cssLoops(m[1] ?? m[2] ?? '', `${prefix}style attribute`, hits);
    for (const m of outside.matchAll(SMIL_LOOP_RE)) hits.push({ match: m[0].slice(0, 80), where: `${prefix}SMIL` });
    for (const m of doc.matchAll(DATA_JS_RE)) {
      const src = Buffer.from(m[1], 'base64').toString('utf8');
      cssLoops(src, `${prefix}embedded module`, hits);
      for (const x of src.matchAll(SMIL_LOOP_RE)) hits.push({ match: x[0].slice(0, 80), where: `${prefix}embedded module` });
    }
  };
  scan(html, '');
  scan(svg, 'svg ');
  return hits;
}

/** True when views.time.motion is trace|playback, the scene has edges, and the SVG carries no data-phase (no still frame). */
export function motionWithoutStill(scene, svg) {
  const views = isObject(scene) && isObject(scene.views) ? scene.views : {};
  const time = isObject(views.time) ? views.time : null;
  if (!time || !MOTION_MODES.includes(time.motion)) return false;
  if (!(Array.isArray(scene.edges) && scene.edges.some(isObject))) return false;
  return !/\sdata-phase\s*=\s*"/.test(String(svg ?? ''));
}

/** CDN importmap entries without an integrity value: [url]. */
export function sriMissing(html) {
  const map = importmapOf(String(html || ''));
  if (!map) return [];
  const integrity = isObject(map.json.integrity) ? map.json.integrity : {};
  return Object.values(isObject(map.json.imports) ? map.json.imports : {})
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u) && !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(String(integrity[u] || '')));
}

export function vendorStatus(vendorDir) {
  const dir = vendorDir || join(ROOT, 'vendor');
  const missing = THREE_SPECIFIERS.map((s) => join('three', s.file)).filter((rel) => !existsSync(join(dir, rel)));
  return { dir, missing, present: missing.length === 0 };
}

export const budgetFor = (embedThree) => (embedThree ? EMBED_BUDGET_BYTES : PLAIN_BUDGET_BYTES);

function insideDir(file, dir) {
  const rel = relative(resolve(dir), resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function checkOutput(s, c, F) {
  const html = typeof c.html === 'string' ? c.html : null;
  const svg = typeof c.svg === 'string' ? c.svg : null;
  const embed = c.embedThree === true;
  if (html !== null) {
    for (const h of hexLiterals(stripExempt(html)).slice(0, 50)) F('DF_RENDER_HEX_LITERAL', '$.html', `${h.match} at line ${h.line}`);
    for (const r of externalRefs(html).slice(0, 50)) F('DF_RENDER_EXTERNAL_REF', '$.html', `${r.ref} (${r.where})`);
    for (const u of sriMissing(html)) F('DF_RENDER_SRI_MISSING', '$.html', `${u} has no integrity entry in the importmap`);
  }
  if (svg !== null) {
    for (const h of hexLiterals(stripExempt(svg)).slice(0, 50)) F('DF_RENDER_HEX_LITERAL', '$.svg', `${h.match} at line ${h.line}`);
    for (const m of String(svg).replace(TOKENS_BLOCK_RE, '').matchAll(URL_RE)) if (!m[0].startsWith('http://www.w3.org/')) F('DF_RENDER_EXTERNAL_REF', '$.svg', m[0]);
  }
  const out = html !== null ? html : svg;
  if (out !== null) {
    const bytes = Buffer.byteLength(out, 'utf8');
    const budget = budgetFor(embed);
    if (bytes > budget) F('DF_RENDER_SIZE_BUDGET', html !== null ? '$.html' : '$.svg', `${bytes} bytes > ${budget} (${embed ? 'embedded three' : 'plain'})`);
  }
}

function checkViews(s, c, F) {
  const views = normalizeViews(c.views);
  const sv = isObject(s.views) ? s.views : {};
  const off = Array.isArray(c.viewsOff) ? c.viewsOff : [];
  for (const v of views) {
    if (off.includes(v)) F('DF_RENDER_VIEW_DISABLED', `$.views.${v}`, `'${v}' is listed in views_off`);
    else if (v === '3d' && !isObject(sv['3d'])) F('DF_RENDER_VIEW_DISABLED', '$.views.3d', 'the scene declares no 3d view');
    else if (v === 'vr' && !(isObject(sv.vr) && sv.vr.enabled === true)) F('DF_RENDER_VIEW_DISABLED', '$.views.vr', isObject(sv.vr) ? 'views.vr.enabled is false' : 'the scene declares no vr view');
  }
  if (c.embedThree === true && needsThree(views)) {
    const vs = vendorStatus(c.vendorDir);
    for (const rel of vs.missing) F('DF_RENDER_VENDOR_MISSING', '$.views', `vendor/${rel} is absent`);
  }
}

function checkSelfExport(s, c, F) {
  if (typeof c.outputPath !== 'string' || !c.outputPath || c.iKnow === true) return;
  const viewer = resolveViewer(s, c);
  if (viewer.mode !== 'self') return;
  const root = typeof c.root === 'string' && c.root ? c.root : process.cwd();
  const dotDir = typeof c.dotDir === 'string' && c.dotDir ? c.dotDir : join(root, '.dotfield');
  const file = isAbsolute(c.outputPath) ? c.outputPath : resolve(root, c.outputPath);
  if (!insideDir(file, dotDir)) F('DF_RENDER_SELF_VIEW_EXPORTED', '$.meta.output', `${relative(root, file) || file} is outside ${relative(root, dotDir) || '.dotfield'}`);
}

function checkShapesAndTokens(s, c, F) {
  const shapes = shapesTable(c);
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  nodes.forEach((n, i) => {
    if (!isObject(n)) return;
    if (!isObject(shapes[n.kind])) F('DF_RENDER_SHAPE_UNKNOWN', `$.nodes[${i}].kind`, `'${String(n.kind)}' has no shapes.json row`);
    else if (!GLYPHS.includes(shapes[n.kind].glyph2d)) F('DF_RENDER_SHAPE_UNKNOWN', `$.nodes[${i}].kind`, `row '${String(n.kind)}' names unknown glyph2d '${String(shapes[n.kind].glyph2d)}'`);
    if (n.shape !== undefined && !GLYPHS.includes(n.shape)) F('DF_RENDER_SHAPE_UNKNOWN', `$.nodes[${i}].shape`, `'${String(n.shape)}' is not a glyph svg.mjs draws (${GLYPHS.join(', ')})`);
  });
  const css = typeof c.tokensCss === 'string' ? c.tokensCss : null;
  const parsed = parseThemes(css !== null ? css : defaultTokens());
  const theme = typeof c.theme === 'string' ? c.theme : (isObject(s.meta) && typeof s.meta.theme === 'string' ? s.meta.theme : 'default');
  const known = (token) => typeof token === 'string' && resolveToken(parsed, token, theme) !== null;
  nodes.forEach((n, i) => { if (isObject(n) && n.color_token !== undefined && !known(n.color_token)) F('DF_RENDER_TOKEN_UNKNOWN', `$.nodes[${i}].color_token`, `'${String(n.color_token)}' is not defined for theme ${theme}`); });
  (Array.isArray(s.groups) ? s.groups : []).forEach((g, i) => { if (isObject(g) && g.color_token !== undefined && !known(g.color_token)) F('DF_RENDER_TOKEN_UNKNOWN', `$.groups[${i}].color_token`, `'${String(g.color_token)}' is not defined for theme ${theme}`); });
}

function checkMotion(s, c, F) {
  const html = typeof c.html === 'string' ? c.html : null;
  const svg = typeof c.svg === 'string' ? c.svg : null;
  for (const h of motionLoops(html, svg).slice(0, 50)) F('DF_RENDER_MOTION_INFINITE', h.where.startsWith('svg ') ? '$.svg' : '$.html', `${h.match} (${h.where})`);
  const still = svg ?? html;
  if (still !== null && motionWithoutStill(s, still)) F('DF_RENDER_MOTION_WITHOUT_STILL', '$.views.time.motion', `motion '${s.views.time.motion}' but the SVG carries no data-phase, so there is no still frame`);
}

let tokensCache;
function defaultTokens() {
  if (tokensCache === undefined) {
    const file = join(ROOT, 'renderers', 'tokens.css');
    try { tokensCache = existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { tokensCache = ''; }
  }
  return tokensCache;
}

/** Gate entry: one check per DF_RENDER_* code in catalog order; never throws. */
export function check(scene, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  const fails = new Map();
  const F = (code, path, detail) => {
    if (!fails.has(code)) fails.set(code, []);
    fails.get(code).push(fail(code, { path, detail }));
  };
  try {
    const s = isObject(scene) ? scene : {};
    checkOutput(s, c, F);
    if (c.requireProjected && !verifyStamp(s, c.sessionKey)) F('DF_RENDER_UNPROJECTED', '$.projected.mac', 'the projected stamp is missing or does not verify under the session key');
    checkViews(s, c, F);
    checkSelfExport(s, c, F);
    checkShapesAndTokens(s, c, F);
    checkMotion(s, c, F);
  } catch (e) {
    F('DF_RENDER_EXTERNAL_REF', '$', `render gate stopped: ${e && e.message ? e.message : String(e)}`);
  }
  return codesForFamily('render').map((code) => (fails.has(code) ? fails.get(code) : [pass(code)])).flat();
}
