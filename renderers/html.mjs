// renderers/html.mjs — one self-contained HTML from one scene: the tokens,
// the scene JSON, the inline SVG (renderers/svg.mjs), the viewer fragments
// (renderers/viewer/*.js, concatenated inside one IIFE) and, when a 3D or VR
// view is requested, an importmap for three@0.180.0 — pinned jsdelivr URLs
// with integrity from vendor/manifest.json, or data:text/javascript;base64
// entries read from vendor/three/ under --embed-three — plus a module
// bootstrap that imports renderers/three.mjs and renderers/xr.mjs (embedded
// the same way under the specifiers dotfield/three and dotfield/xr, plus a
// dotfield/<name> entry for every other three-*.mjs / motion.mjs found on
// disk, so a split renderer needs no change here). When those renderers are
// not installed the 3D/VR panels say so honestly instead of loading three for
// nothing. A scene with views.time gets the time bar under the header (wired
// by viewer/timebar.js from the DF.ticks mirror); one with steps, a
// presentation or a lifecycle gets the guide (viewer/steps.js), its steps
// normalised into the config block. Byte-reproducible: no clock unless opts.now.
//
//   renderHtml(scene, opts) -> string            renderHtmlDetailed(scene, opts) -> {html, views, importmap, renderer, time, steps, ...}
//   opts: {views=['2d'] | 'all', tokensCss, theme, embedThree=false, vendorDir, rendererDir, viewer, svg, shapes,
//          ownerId, now, centerName, quality}
//   rendererSpecifiers(dir) -> [{specifier, file}]   timebarHtml(scene) -> string   stepsOf(scene) -> {source, steps}
//   shapes3dOf(scene, shapes) -> {kind: {primitive3d}} for the kinds the scene uses (config.shapes, read by mount3d)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg, escapeXml } from './svg.mjs';
import { SHELL_CSS } from './viewer/style.js';
import { TIME_CSS } from './viewer/style-4d.js';
import { parseThemes } from '../lib/theme.mjs';
import { timeOf, ticks, timeIndex, edgeAt } from '../lib/time/playhead.mjs';
import { dayIndex, fromDayIndex } from '../lib/time/ticks.mjs';
import { defaultLifecycleSteps } from '../lib/layout/lifecycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const VIEWS = Object.freeze(['2d', '3d', 'vr']);
export const THREE_VERSION = '0.180.0';
export const CDN_BASE = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/`;
/** importmap specifier -> {file under vendor/three/, path under the jsdelivr package}. */
export const THREE_SPECIFIERS = Object.freeze([
  { specifier: 'three', file: 'three.module.js', cdn: 'build/three.module.js' },
  { specifier: 'three/core', file: 'three.core.js', cdn: 'build/three.core.js' },
  { specifier: 'three/addons/controls/OrbitControls.js', file: 'OrbitControls.js', cdn: 'examples/jsm/controls/OrbitControls.js' },
  { specifier: 'three/addons/webxr/XRButton.js', file: 'XRButton.js', cdn: 'examples/jsm/webxr/XRButton.js' },
]);
/** The two renderer modules the bootstrap imports; always listed, reported missing when absent. */
export const RENDERER_REQUIRED = Object.freeze(['three.mjs', 'xr.mjs']);
/** Other 3D/VR renderer modules picked up when present on disk (three-labels.mjs, motion.mjs, …). */
export const RENDERER_FILE_RE = /^(?:three|xr|motion)(?:-[a-z0-9]+)*\.mjs$/;
const specifierOf = (file) => `dotfield/${file.replace(/\.mjs$/, '')}`;

/** [{specifier, file}] for dir: three.mjs and xr.mjs first, then every other renderer module present on disk in name order. */
export function rendererSpecifiers(dir = HERE) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => RENDERER_FILE_RE.test(f) && !RENDERER_REQUIRED.includes(f)).sort(); } catch { files = []; }
  return [...RENDERER_REQUIRED, ...files].map((file) => Object.freeze({ specifier: specifierOf(file), file }));
}
export const RENDERER_SPECIFIERS = Object.freeze(rendererSpecifiers(HERE));
export const VIEWER_FILES = Object.freeze(['state.js', 'time.js', 'lens.js', 'evidence.js', 'export.js', 'motion-2d.js', 'timebar.js', 'steps.js', 'keys.js', 'shell.js']);
export const SCENE_SCRIPT_ID = 'dotfield-scene';
const OVERLAY_NO_RENDERER = '3D/VR renderer not installed: this build has no renderers/three.mjs and renderers/xr.mjs, so the 3D and VR views cannot start. The 2D view is complete.';
const overlayNoRenderer = (missing) => (missing.length === RENDERER_REQUIRED.length && RENDERER_REQUIRED.every((f) => missing.includes(f)) ? OVERLAY_NO_RENDERER
  : `3D/VR renderer incomplete: this build is missing renderers/${missing.join(', renderers/')}, so the 3D and VR views cannot start. The 2D view is complete.`);
const OVERLAY_NO_VENDOR = 'three.js vendor files are missing from vendor/three/ (run node scripts/fetch-vendor.mjs and render again). The 2D view is complete.';

const cache = new Map();
function readCached(file) {
  if (!cache.has(file)) cache.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null);
  return cache.get(file);
}
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** 'all' | '2d,3d' | ['2d', 'vr'] -> ordered unique subset of VIEWS (2d is always first and always present). */
export function normalizeViews(v) {
  const list = v === 'all' || v === undefined || v === null ? (v === 'all' ? VIEWS : ['2d']) : (Array.isArray(v) ? v : String(v).split(/[\s,]+/));
  const out = ['2d'];
  for (const x of list) if (VIEWS.includes(x) && !out.includes(x)) out.push(x);
  return out;
}
export const needsThree = (views) => views.includes('3d') || views.includes('vr');

/** 'sha256:<hex>' | '<hex>' | 'sha256-<b64>' | 'sha384-…' -> an SRI value, else null. */
export function toIntegrity(digest) {
  if (typeof digest !== 'string') return null;
  if (/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(digest)) return digest;
  const hex = digest.replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256-${Buffer.from(hex, 'hex').toString('base64')}` : null;
}

/** vendor/manifest.json as specifier -> {file, url, integrity}; tolerant of key names, {} when absent. */
export function readVendorManifest(vendorDir) {
  const file = join(vendorDir, 'manifest.json');
  let doc; try { doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { doc = null; }
  const rows = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.files) ? doc.files : (doc && isObject(doc.files) ? Object.entries(doc.files).map(([k, v]) => ({ specifier: k, ...v })) : []));
  const out = {};
  for (const r of rows) {
    if (!isObject(r)) continue;
    const spec = r.specifier || r.import || r.name;
    if (typeof spec !== 'string') continue;
    const pre = r.sha256_pre || r.pre_sha256 || r.cdn_sha256 || r.sha256_cdn || r.sha256 || r.digest_pre;
    out[spec] = { file: r.file || r.path || r.local || null, url: r.url || r.cdn || null, integrity: r.integrity || toIntegrity(pre) };
  }
  return out;
}

const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
/** The one specifier fetch-vendor.mjs rewrites; applied again here so an unrewritten vendor file still resolves through the map. */
export const rewriteCore = (text) => text.replace(/(['"])\.\/three\.core\.js\1/g, '$1three/core$1');

/** A renderer module's relative imports of another renderer module ('./three-labels.mjs') rewritten to its importmap specifier. */
export function rewriteRendererImports(text, specs) {
  const files = new Set(specs.map((r) => r.file));
  return text.replace(/(['"])\.\/([a-z0-9-]+\.mjs)\1/g, (m, q, file) => (files.has(file) ? `${q}${specifierOf(file)}${q}` : m));
}

/** The importmap for a 3D/VR render: {mode: none|embedded|cdn, json, missing[], renderer: {present, missing[]}}. */
export function buildImportmap({ views, embedThree, vendorDir, rendererDir }) {
  const renderer = { present: true, missing: [] };
  const modules = {};
  const specs = rendererSpecifiers(rendererDir);
  for (const r of specs) {
    const text = readCached(join(rendererDir, r.file));
    if (text === null) { renderer.present = false; renderer.missing.push(r.file); } else modules[r.specifier] = rewriteRendererImports(text, specs);
  }
  // A split renderer whose sibling is absent keeps a relative './<name>.mjs' import a data: URL cannot resolve: report it now, not at import time in the browser.
  for (const text of Object.values(modules)) {
    for (const m of text.matchAll(/(['"])\.\/([a-z0-9-]+\.mjs)\1/g)) if (RENDERER_FILE_RE.test(m[2]) && !renderer.missing.includes(m[2])) { renderer.present = false; renderer.missing.push(m[2]); }
  }
  if (!needsThree(views)) return { mode: 'none', json: null, missing: [], renderer };
  const manifest = readVendorManifest(vendorDir);
  const imports = {}; const integrity = {}; const missing = [];
  for (const s of THREE_SPECIFIERS) {
    const m = manifest[s.specifier] || {};
    if (embedThree) {
      const file = join(vendorDir, 'three', m.file ? m.file.replace(/^.*\//, '') : s.file);
      const text = readCached(file);
      if (text === null) missing.push(file.slice(vendorDir.length + 1));
      else imports[s.specifier] = dataUrl(rewriteCore(text));
    } else {
      const url = m.url || `${CDN_BASE}${s.cdn}`;
      imports[s.specifier] = url;
      if (m.integrity) integrity[url] = m.integrity;
    }
  }
  if (!renderer.present || missing.length) return { mode: embedThree ? 'embedded' : 'cdn', json: null, missing, renderer };
  for (const [spec, text] of Object.entries(modules)) imports[spec] = dataUrl(text);
  const map = { imports };
  if (Object.keys(integrity).length) map.integrity = integrity;
  return { mode: embedThree ? 'embedded' : 'cdn', json: JSON.stringify(map), missing, renderer };
}

/** The viewer fragments inside one IIFE; `DF` is the shared namespace they extend. */
export function viewerBundle(viewerDir = join(HERE, 'viewer')) {
  const parts = VIEWER_FILES.map((f) => readCached(join(viewerDir, f)) ?? `/* ${f} missing */`);
  return `(function(){\n'use strict';\nconst DF={};\nDF.scene=JSON.parse(document.getElementById(${JSON.stringify(SCENE_SCRIPT_ID)}).textContent);\nDF.config=JSON.parse(document.querySelector('script[data-df="config"]').textContent);\n${parts.join('\n')}\nDF.boot();\n})();`;
}

/** JSON safe inside a <script> block and round-trippable with JSON.parse. */
export function scriptJson(value) {
  const bs = '\u005c';
  return JSON.stringify(value).replace(/</g, `${bs}u003c`).replace(/[\u2028\u2029]/g, (m) => `${bs}u${m.charCodeAt(0).toString(16)}`);
}

function viewerOf(opts, scene) {
  const v = opts.viewer;
  if (typeof v === 'string') return v === 'self' ? { person_id: 'self', mode: 'self' } : { person_id: v, mode: 'person' };
  if (isObject(v) && typeof v.person_id === 'string') return { person_id: v.person_id, mode: v.mode || (v.person_id === 'self' ? 'self' : 'person') };
  const sv = isObject(scene.viewer) ? scene.viewer : {};
  return { person_id: sv.person_id || 'self', mode: sv.mode || 'self' };
}

const threeBootstrap = (views) => `<script type="module">
const scene = JSON.parse(document.getElementById(${JSON.stringify(SCENE_SCRIPT_ID)}).textContent);
const cfg = JSON.parse(document.querySelector('script[data-df="config"]').textContent);
const hosts = { '3d': document.querySelector('[data-mount="3d"]'), vr: document.querySelector('[data-mount="vr"]') };
try {
  const three = await import(${JSON.stringify(specifierOf(RENDERER_REQUIRED[0]))});
  const xr = ${views.includes('vr') ? `await import(${JSON.stringify(specifierOf(RENDERER_REQUIRED[1]))})` : 'null'};
  const mount = three.mount3d || three.mount || three.default;
  if (typeof mount !== 'function') throw new Error('renderers/three.mjs exports no mount3d()');
  const api = await mount({ scene, hosts, views: cfg.views, theme: cfg.theme, tokenNames: cfg.token_names, shapes: cfg.shapes, xr });
  document.dispatchEvent(new CustomEvent('dotfield:3d', { detail: api }));
} catch (e) {
  document.dispatchEvent(new CustomEvent('dotfield:3d-error', { detail: { message: String(e && e.message || e) } }));
}
</script>`;

/** {kind: {primitive3d}} for the kinds the scene's nodes use, from the render's kinds table (so a pack, center or sketch x- kind keeps its 3D primitive in the browser). */
export function shapes3dOf(scene, shapes) {
  const rows = isObject(shapes) && isObject(shapes.kinds) ? shapes.kinds : (isObject(shapes) ? shapes : {});
  const out = {};
  for (const n of Array.isArray(scene.nodes) ? scene.nodes : []) {
    const row = isObject(n) && typeof n.kind === 'string' ? rows[n.kind] : null;
    if (isObject(row) && typeof row.primitive3d === 'string') out[n.kind] = { primitive3d: row.primitive3d };
  }
  return out;
}

/** Steps of the guide: views.interactive.steps[], else presentation[] (one node each), else a lifecycle's states, each at the playhead of the transition that first enters it, in playhead order. */
export function stepsOf(scene) {
  const s = isObject(scene) ? scene : {};
  const it = isObject(s.views) && isObject(s.views.interactive) ? s.views.interactive : {};
  const nodes = Array.isArray(s.nodes) ? s.nodes.filter(isObject) : [];
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const labelOf = (id) => { const n = nodes.find((x) => x.id === id); return n && typeof n.label === 'string' && n.label ? n.label : id; };
  const point = (v) => (typeof v === 'string' || (Number.isInteger(v) && v >= 0) ? v : null);
  if (Array.isArray(it.steps) && it.steps.some(isObject)) {
    const steps = it.steps.filter((st) => isObject(st) && typeof st.id === 'string').map((st) => ({
      id: st.id, label: typeof st.label === 'string' && st.label ? st.label : st.id, caption: typeof st.caption === 'string' ? st.caption : '',
      nodes: ids(st.nodes), edges: ids(st.edges), playhead: point(st.playhead),
    }));
    return { source: 'steps', steps: steps.slice(0, 64) };
  }
  if (ids(it.presentation).length) {
    return { source: 'presentation', steps: ids(it.presentation).slice(0, 64).map((id, i) => ({ id: `p${i + 1}`, label: labelOf(id), caption: '', nodes: [id], edges: [], playhead: null })) };
  }
  if (s.kind !== 'lifecycle') return { source: null, steps: [] };
  const time = timeOf(s);
  const byId = time ? timeIndex(s).nodesById : null;
  const edges = new Map((Array.isArray(s.edges) ? s.edges : []).filter((e) => isObject(e) && typeof e.id === 'string').map((e) => [e.id, e]));
  const steps = defaultLifecycleSteps(s).slice(0, 64).map((st) => {
    const ats = time ? st.edges.map((id) => (edges.has(id) ? edgeAt(edges.get(id), byId, time) : null)).filter((v) => v !== null) : [];
    const at = ats.length ? ats.reduce((a, b) => (b < a ? b : a)) : (time ? time.from : null);
    const via = st.edges.length ? edges.get(st.edges[0]) : null;
    return { id: st.id, label: st.label, caption: via && typeof via.label === 'string' ? via.label : '', nodes: st.nodes, edges: st.edges, playhead: point(at) };
  });
  const rank = (st) => (st.playhead === null ? Infinity : (typeof st.playhead === 'string' ? dayIndex(st.playhead) : st.playhead));
  return { source: 'lifecycle', steps: steps.map((st, i) => [st, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([st]) => st) };
}

/** The time bar skeleton under the header (viewer/timebar.js draws the tick marks from the DF.ticks mirror); '' without views.time or scrub stops. */
export function timebarHtml(scene) {
  const time = timeOf(scene);
  const stops = time ? ticks(scene) : [];
  if (!time || !stops.length) return '';
  const num = (v) => (time.axis === 'date' ? dayIndex(v) : v);
  const show = (v) => escapeXml(time.axis === 'date' ? String(v) : `beat ${v}`);
  const first = stops[0]; const last = stops[stops.length - 1];
  const at = num(time.playhead); const lo = num(first); const hi = num(last);
  const head = at === null || at === undefined ? hi : Math.min(hi, Math.max(lo, at));
  const headPoint = time.axis === 'date' ? fromDayIndex(head) : head;
  const b = (df, text, label, extra = '') => `<button class="df-btn" type="button" data-df="${df}" aria-label="${label}"${extra}>${text}</button>`;
  return `<div class="df-timebar" data-df="timebar" role="group" aria-label="Time" data-axis="${time.axis}" data-step="${escapeXml(time.step)}" data-motion="${time.motion}" data-stops="${stops.length}">`
    + `${b('t-start', '«', 'Jump to the start')}${b('t-prev', '‹', 'Previous stop')}${b('t-play', 'Play', 'Play', ' aria-pressed="false"')}${b('t-next', '›', 'Next stop')}${b('t-end', '»', 'Jump to the end')}`
    + `<span class="df-tb-label" data-df="t-from">${show(first)}</span>`
    + `<div class="df-tb-track"><input class="df-tb-range" type="range" data-df="t-range" min="${lo}" max="${hi}" step="1" value="${head}" aria-label="Playhead"><div class="df-tb-ticks" data-df="t-ticks" aria-hidden="true"></div></div>`
    + `<span class="df-tb-label" data-df="t-to">${show(last)}</span><output class="df-tb-now" data-df="t-now">${show(headPoint)}</output></div>`;
}

const GUIDE_HTML = '<aside class="df-steps" data-df="steps" hidden aria-live="polite" aria-label="Guide"><div class="df-eyebrow">Guide <span data-df="step-count"></span></div>'
  + '<h2 data-df="step-label"></h2><p data-df="step-caption"></p><div class="df-steps-nav">'
  + '<button class="df-btn" type="button" data-df="step-prev">Back</button><button class="df-btn" type="button" data-df="step-next">Next</button>'
  + '<button class="df-btn" type="button" data-df="step-close" aria-label="Close the guide">Close</button></div></aside>';

function panel(view, overlay) {
  if (view === '2d') return '';
  const label = view === '3d' ? '3D view' : 'VR view';
  return `<section class="df-view" data-view="${view}" hidden aria-label="${label}"><div class="df-mount" data-mount="${view}"></div>`
    + `<p class="df-overlay" role="status" data-overlay="${view}"${overlay ? '' : ' hidden'}>${escapeXml(overlay)}</p></section>`;
}

export function renderHtmlDetailed(scene, opts = {}) {
  const s = isObject(scene) ? scene : {};
  const meta = isObject(s.meta) ? s.meta : {};
  const views = normalizeViews(opts.views);
  const tokensCss = typeof opts.tokensCss === 'string' ? opts.tokensCss : (readCached(join(HERE, 'tokens.css')) || '');
  const parsed = parseThemes(tokensCss);
  const themes = parsed.order.filter((t) => t !== 'auto-light');
  const theme = typeof opts.theme === 'string' ? opts.theme : (typeof meta.theme === 'string' ? meta.theme : 'default');
  const viewer = viewerOf(opts, s);
  const embedThree = opts.embedThree === true;
  const importmap = buildImportmap({ views, embedThree, vendorDir: opts.vendorDir || join(ROOT, 'vendor'), rendererDir: opts.rendererDir || HERE });
  const svg = typeof opts.svg === 'string' ? opts.svg : renderSvg(s, tokensCss, { xmlns: false, shapes: opts.shapes, ownerId: opts.ownerId, theme });
  const title = String(meta.title ?? meta.id ?? 'scene');
  const interactive = isObject(s.views) && isObject(s.views.interactive) ? s.views.interactive : {};
  const timebar = timebarHtml(s);
  const guide = stepsOf(s);
  const config = {
    scene_id: meta.id ?? null, views, theme, themes, viewer, maturity: meta.maturity ?? 'contract_only', quality: opts.quality || meta.quality || 'checked',
    deep_link: interactive.deep_link !== false, token_names: Object.keys(parsed.themes.default || {}).filter((k) => k.startsWith('--df-')),
    center_name: typeof opts.centerName === 'string' ? opts.centerName : null, three: importmap.mode, embed_three: embedThree,
    steps: guide.steps, steps_source: guide.source, shapes: shapes3dOf(s, opts.shapes),
  };
  const overlay = needsThree(views) ? (!importmap.renderer.present ? overlayNoRenderer(importmap.renderer.missing) : (importmap.missing.length ? OVERLAY_NO_VENDOR : '')) : '';
  const tabs = views.map((v) => `<button class="df-btn df-tab" type="button" role="tab" data-view-tab="${v}" aria-selected="${v === views[0] ? 'true' : 'false'}">${v.toUpperCase()}</button>`).join('');
  const btn = (df, text, label) => `<button class="df-btn" type="button" data-df="${df}"${label ? ` aria-label="${label}"` : ''}>${text}</button>`;
  const footer = [
    `<span>maturity: <code data-maturity="${escapeXml(config.maturity)}">${escapeXml(config.maturity)}</code></span>`,
    `<span>viewer: <code data-viewer-id="${escapeXml(viewer.person_id)}">${escapeXml(viewer.person_id)}</code> (${escapeXml(viewer.mode)})</span>`,
    viewer.mode === 'self' ? '<span class="df-self" data-df="self-warning">rendered for self: contains private fields</span>' : '',
    `<span>quality: ${escapeXml(config.quality)}</span>`,
    meta.privacy_mode ? `<span>privacy: ${escapeXml(meta.privacy_mode)}</span>` : '',
    isObject(s.receipt) && s.receipt.receipt_id ? `<span>receipt <code>${escapeXml(s.receipt.receipt_id)}</code></span>` : '',
    isObject(s.projected) && s.projected.by ? `<span>projected by ${escapeXml(s.projected.by)} for ${escapeXml(s.projected.viewer)}</span>` : '',
    `<span>views: ${views.join(' ')}${needsThree(views) ? ` · three ${importmap.mode}` : ''}</span>`,
  ].filter(Boolean).join('');
  const html = `<!doctype html>
<html lang="en"${theme && theme !== 'default' ? ` data-theme="${escapeXml(theme)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="dotfield render">
${opts.now !== undefined && opts.now !== null ? `<meta name="dotfield-generated-at" content="${escapeXml(typeof opts.now === 'number' ? new Date(opts.now).toISOString() : (opts.now instanceof Date ? opts.now.toISOString() : String(opts.now)))}">\n` : ''}<title>${escapeXml(title)} · Dotfield</title>
<style data-df="tokens">${tokensCss}</style>
<style data-df="shell">${SHELL_CSS}${timebar || guide.steps.length ? TIME_CSS : ''}</style>
${importmap.json ? `<script type="importmap">${importmap.json}</script>\n` : ''}</head>
<body data-views="${views.join(' ')}" data-viewer="${escapeXml(viewer.person_id)}" data-viewer-mode="${escapeXml(viewer.mode)}" data-kind="${escapeXml(s.kind)}">
<header class="df-header"><div><div class="df-eyebrow">${escapeXml(s.kind)} · ${escapeXml(theme)} · ${escapeXml(config.maturity)}</div><h1>${escapeXml(title)}</h1></div>
<div class="df-controls"><div class="df-tabs" role="tablist" aria-label="View">${tabs}</div>
<select class="df-select" data-df="lens" aria-label="Lens"></select><select class="df-select" data-df="theme" aria-label="Theme"></select>
${btn('reach', 'Reach', 'Cycle reach')}${btn('legend', 'Map key')}${btn('zoom-out', '−', 'Zoom out')}${btn('zoom-reset', '0', 'Reset zoom')}${btn('zoom-in', '+', 'Zoom in')}
${guide.steps.length ? `<button class="df-btn" type="button" data-df="guide" aria-pressed="false" aria-label="Open the guide">Guide</button>` : ''}${btn('export-svg', 'SVG', 'Save SVG')}${btn('export-png', 'PNG', 'Save PNG')}${btn('export-card', 'Card', 'Save share card')}${btn('help-open', '?', 'Keyboard help')}</div></header>
${timebar ? `${timebar}\n` : ''}<main class="df-main">
<section class="df-view" data-view="2d" aria-label="2D view"><div class="df-stage" data-df="stage">${svg}</div></section>
${views.slice(1).map((v) => panel(v, overlay)).join('\n')}
<aside class="df-card" data-df="card" hidden aria-live="polite"></aside>
<div class="df-help" data-df="help" hidden role="dialog" aria-label="Keyboard help"></div>
${guide.steps.length ? `${GUIDE_HTML}\n` : ''}</main>
<footer class="df-footer">${footer}</footer>
<script type="application/json" id="${SCENE_SCRIPT_ID}" data-df="scene">${scriptJson(s)}</script>
<script type="application/json" data-df="config">${scriptJson(config)}</script>
<script>${viewerBundle()}</script>
${importmap.json ? threeBootstrap(views) : ''}
</body>
</html>
`;
  return { html, views, theme, viewer, importmap: { mode: importmap.mode, missing: importmap.missing, present: importmap.json !== null }, renderer: importmap.renderer, embedThree, time: timebar !== '', steps: guide.steps.length, bytes: Buffer.byteLength(html, 'utf8') };
}

export function renderHtml(scene, opts = {}) {
  return renderHtmlDetailed(scene, opts).html;
}
