// One self-contained HTML per render: no external URL except the pinned
// three.js importmap (and none at all without 3D/VR or with --embed-three),
// the scene round-trips from its data block, every node <g> is focusable,
// the size budget holds, the footer tells the truth about the viewer, the
// 3D/VR panels say honestly when the renderer or the vendor files are not
// installed, and lib/gates/render.mjs raises every DF_RENDER_* code from one
// fixture. node:test, zero network; vendor and renderer stubs live in temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { withTmp } from './helpers/tmp.mjs';
import { renderHtml, renderHtmlDetailed, normalizeViews, toIntegrity, readVendorManifest, viewerBundle, scriptJson, CDN_BASE, THREE_SPECIFIERS, VIEWER_FILES } from '../renderers/html.mjs';
import { renderSvg } from '../renderers/svg.mjs';
import * as gate from '../lib/gates/render.mjs';
import { codesForFamily, RULES } from '../lib/rules.mjs';
import { EXAMPLE_SESSION_KEY } from './fixtures/ir/examples.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = ['scene-graph', 'scene-room', 'scene-timeline', 'scene-workflow'];
const TOKENS = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'examples', `${name}.json`), 'utf8'));
const scenes = Object.fromEntries(EXAMPLES.map((n) => [n, load(n)]));
const RENDER_CODES = codesForFamily('render');
const SCENE_RE = /<script type="application\/json" id="dotfield-scene" data-df="scene">([\s\S]*?)<\/script>/;
const CONFIG_RE = /<script type="application\/json" data-df="config">([\s\S]*?)<\/script>/;
const IMPORTMAP_RE = /<script type="importmap">([\s\S]*?)<\/script>/;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const codes = (checks) => [...new Set(fails(checks).map((c) => c.code))];
/** Module text without a literal import statement in this file (the no-son-imports scan reads test sources too). */
const imp = (what, from) => ['import', what, 'from', JSON.stringify(from)].join(' ') + ';\n';
const STUBS = {
  'three.module.js': "export * from './three.core.js';\nexport const REVISION = '180';\n",
  'three.core.js': 'export const CORE = true;\n',
  'OrbitControls.js': `${imp('{ REVISION }', 'three')}export class OrbitControls { constructor() { this.rev = REVISION; } }\n`,
  'XRButton.js': 'export const XRButton = { createButton() { return null; } };\n',
};

/** A vendor dir with the four stub files and, unless told otherwise, a manifest carrying pre-rewrite digests and jsdelivr URLs. */
function stubVendor(dir, { manifest = true } = {}) {
  mkdirSync(join(dir, 'three'), { recursive: true });
  for (const [f, text] of Object.entries(STUBS)) writeFileSync(join(dir, 'three', f), text);
  if (manifest) {
    const files = THREE_SPECIFIERS.map((s) => ({ specifier: s.specifier, file: `three/${s.file}`, url: `${CDN_BASE}${s.cdn}`, sha256_pre: `sha256:${sha(STUBS[s.file])}`, sha256_post: `sha256:${sha(STUBS[s.file].replace('./three.core.js', 'three/core'))}` }));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema_version: 'dotfield.vendor/1', three_version: '0.180.0', files }, null, 2));
  }
  return dir;
}
function stubRenderers(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'three.mjs'), `${imp('* as THREE', 'three')}export function mount3d({ hosts }) { return { setView() {}, setTheme() {}, focus() {}, three: THREE, hosts }; }\n`);
  writeFileSync(join(dir, 'xr.mjs'), `${imp('{ XRButton }', 'three/addons/webxr/XRButton.js')}export function enableXr() { return XRButton; }\n`);
  return dir;
}
const nodeTags = (html) => [...html.matchAll(/<g ([^>]*data-node-id="([^"]+)"[^>]*)>/g)];

test('every example renders to one self-contained 2D HTML: no http, the scene round-trips, every node is focusable, under budget, gate-clean', () => {
  for (const [name, s] of Object.entries(scenes)) {
    const r = renderHtmlDetailed(s, { tokensCss: TOKENS, views: '2d' });
    assert.ok(!r.html.includes('http'), `${name}: no http string at all without 3D/VR`);
    assert.deepEqual(JSON.parse(SCENE_RE.exec(r.html)[1]), s, `${name} round-trips`);
    const tags = nodeTags(r.html);
    assert.equal(tags.length, s.nodes.length, name);
    for (const t of tags) assert.match(t[1], /tabindex="0"[^>]*role="button"[^>]*aria-label="/);
    assert.ok(r.bytes < gate.PLAIN_BUDGET_BYTES, `${name} ${r.bytes} bytes`);
    assert.ok(r.html.startsWith('<!doctype html>\n<html lang="en"'));
    assert.match(r.html, /<style data-df="tokens">/);
    assert.match(r.html, /<section class="df-view" data-view="2d"[^>]*><div class="df-stage" data-df="stage"><svg viewBox=/);
    assert.ok(!IMPORTMAP_RE.test(r.html), `${name}: no importmap for a 2D render`);
    assert.match(r.html, new RegExp(`data-maturity="${s.meta.maturity}"`));
    assert.match(r.html, /data-viewer-id="self"/);
    assert.match(r.html, /data-df="self-warning">rendered for self: contains private fields</);
    assert.match(r.html, s.meta.theme === 'default' ? /<html lang="en">/ : new RegExp(`<html lang="en" data-theme="${s.meta.theme}">`));
    const checks = gate.check(s, { html: r.html, svg: renderSvg(s, TOKENS), views: '2d', tokensCss: TOKENS });
    assert.deepEqual(codes(checks), [], `${name}: ${JSON.stringify(fails(checks))}`);
  }
});

test('--for <person>: the footer names the viewer and drops the private-fields warning; config and svg carry the viewer', () => {
  const s = scenes['scene-graph'];
  const html = renderHtml(s, { tokensCss: TOKENS, viewer: 'ada' });
  assert.match(html, /data-viewer-id="ada"[^<]*<\/code> \(person\)/);
  assert.ok(!html.includes('rendered for self'));
  assert.equal(JSON.parse(CONFIG_RE.exec(html)[1]).viewer.mode, 'person');
  const self = renderHtml(s, { tokensCss: TOKENS, viewer: { person_id: 'self', mode: 'self' } });
  assert.match(self, /rendered for self: contains private fields/);
});

test('byte-reproducible: two renders are identical and opts.now is the only clock', () => {
  const s = scenes['scene-workflow'];
  const a = renderHtml(s, { tokensCss: TOKENS, views: 'all' });
  const b = renderHtml(s, { tokensCss: TOKENS, views: 'all' });
  assert.equal(a, b);
  assert.ok(!a.includes('dotfield-generated-at'));
  const c = renderHtml(s, { tokensCss: TOKENS, views: 'all', now: '2026-10-01T10:14:58Z' });
  assert.match(c, /<meta name="dotfield-generated-at" content="2026-10-01T10:14:58Z">/);
  assert.equal(c.replace(/<meta name="dotfield-generated-at"[^>]*>\n/, ''), a);
  assert.match(renderHtml(s, { tokensCss: TOKENS, now: 0 }), /content="1970-01-01T00:00:00.000Z"/);
});

test('--embed-three: data: URLs for three, three/core, OrbitControls, XRButton and the two renderers; no ./three.core.js, no http', async () => {
  await withTmp(async (dir) => {
    const vendorDir = stubVendor(join(dir, 'vendor'));
    const rendererDir = stubRenderers(join(dir, 'renderers'));
    const s = scenes['scene-graph'];
    const r = renderHtmlDetailed(s, { tokensCss: TOKENS, views: 'all', embedThree: true, vendorDir, rendererDir });
    assert.equal(r.importmap.mode, 'embedded');
    assert.ok(r.importmap.present && r.renderer.present);
    assert.ok(!r.html.includes('http'), 'an embedded render contains no http string');
    assert.ok(!r.html.includes('./three.core.js'));
    const map = JSON.parse(IMPORTMAP_RE.exec(r.html)[1]);
    assert.deepEqual(Object.keys(map.imports), [...THREE_SPECIFIERS.map((x) => x.specifier), 'dotfield/three', 'dotfield/xr']);
    for (const v of Object.values(map.imports)) assert.match(v, /^data:text\/javascript;base64,/);
    const three = Buffer.from(map.imports.three.split(',')[1], 'base64').toString('utf8');
    assert.match(three, /from 'three\/core'/, 'the one specifier is rewritten at embed time too');
    assert.ok(!map.integrity, 'data: entries need no integrity');
    assert.match(r.html, /<script type="module">[\s\S]*await import\("dotfield\/three"\)[\s\S]*await import\("dotfield\/xr"\)/);
    assert.match(r.html, /<section class="df-view" data-view="3d" hidden[^>]*><div class="df-mount" data-mount="3d"><\/div><p class="df-overlay" role="status" data-overlay="3d" hidden><\/p>/);
    assert.match(r.html, /data-view="vr" hidden/);
    assert.deepEqual(JSON.parse(CONFIG_RE.exec(r.html)[1]).views, ['2d', '3d', 'vr']);
    const checks = gate.check(s, { html: r.html, views: 'all', embedThree: true, vendorDir, tokensCss: TOKENS });
    assert.deepEqual(codes(checks), [], JSON.stringify(fails(checks)));
    assert.ok(r.bytes < gate.EMBED_BUDGET_BYTES);
    const threeOnly = renderHtmlDetailed(s, { tokensCss: TOKENS, views: ['3d'], embedThree: true, vendorDir, rendererDir });
    assert.deepEqual(Object.keys(JSON.parse(IMPORTMAP_RE.exec(threeOnly.html)[1]).imports).slice(-2), ['dotfield/three', 'dotfield/xr']);
    assert.match(threeOnly.html, /const xr = null;/);
    assert.ok(!threeOnly.html.includes('<section class="df-view" data-view="vr"'));
  });
});

test('CDN mode: the pinned jsdelivr importmap with integrity from vendor/manifest.json is the one allowed external reference', async () => {
  await withTmp(async (dir) => {
    const rendererDir = stubRenderers(join(dir, 'renderers'));
    const s = scenes['scene-room'];
    const withManifest = stubVendor(join(dir, 'v1'));
    const r = renderHtmlDetailed(s, { tokensCss: TOKENS, views: '2d,3d', vendorDir: withManifest, rendererDir });
    assert.equal(r.importmap.mode, 'cdn');
    const map = JSON.parse(IMPORTMAP_RE.exec(r.html)[1]);
    for (const spec of THREE_SPECIFIERS) {
      const url = map.imports[spec.specifier];
      assert.equal(url, `${CDN_BASE}${spec.cdn}`);
      assert.equal(map.integrity[url], toIntegrity(`sha256:${sha(STUBS[spec.file])}`));
      assert.match(map.integrity[url], /^sha256-[A-Za-z0-9+/=]+$/);
    }
    const urls = r.html.match(/https?:\/\/[^\s"'<>)]+/g);
    assert.equal(urls.length, 8, 'four import URLs + four integrity keys, nothing else');
    assert.ok(urls.every((u) => u.startsWith(CDN_BASE)));
    assert.deepEqual(codes(gate.check(s, { html: r.html, views: '2d,3d', vendorDir: withManifest, tokensCss: TOKENS })), []);
    const noManifest = stubVendor(join(dir, 'v2'), { manifest: false });
    const bare = renderHtml(s, { tokensCss: TOKENS, views: '3d', vendorDir: noManifest, rendererDir });
    const sri = gate.check(s, { html: bare, views: '3d', vendorDir: noManifest, tokensCss: TOKENS });
    assert.deepEqual(codes(sri), ['DF_RENDER_SRI_MISSING']);
    assert.equal(fails(sri).length, 4);
    assert.equal(RULES.DF_RENDER_SRI_MISSING.blocking, true);
    const foreign = r.html.replace(`${CDN_BASE}build/three.core.js`, 'https://mirror.example/three.core.js');
    assert.deepEqual(codes(gate.check(s, { html: foreign, views: '3d', tokensCss: TOKENS })), ['DF_RENDER_EXTERNAL_REF', 'DF_RENDER_SRI_MISSING']);
    assert.deepEqual(gate.sriMissing(r.html), []);
  });
});

test('renderer not installed: an honest overlay, no importmap, no three loaded for nothing', async () => {
  await withTmp(async (dir) => {
    const vendorDir = stubVendor(join(dir, 'vendor'));
    const empty = join(dir, 'no-renderers'); mkdirSync(empty);
    const s = scenes['scene-graph'];
    const r = renderHtmlDetailed(s, { tokensCss: TOKENS, views: 'all', embedThree: true, vendorDir, rendererDir: empty });
    assert.equal(r.renderer.present, false);
    assert.deepEqual(r.renderer.missing, ['three.mjs', 'xr.mjs']);
    assert.equal(r.importmap.present, false);
    assert.ok(!IMPORTMAP_RE.test(r.html) && !r.html.includes('<script type="module">'));
    assert.match(r.html, /<p class="df-overlay" role="status" data-overlay="3d">3D\/VR renderer not installed: this build has no renderers\/three\.mjs and renderers\/xr\.mjs/);
    assert.match(r.html, /data-overlay="vr">3D\/VR renderer not installed/);
    assert.ok(!r.html.includes('http'));
    assert.deepEqual(codes(gate.check(s, { html: r.html, views: 'all', embedThree: true, vendorDir, tokensCss: TOKENS })), [], 'the overlay is honest, not a gate failure');
    const shipped = renderHtmlDetailed(s, { tokensCss: TOKENS, views: '3d', vendorDir });
    assert.equal(shipped.renderer.present, shipped.importmap.present, 'the default renderers/ dir decides both together');
    const split = join(dir, 'split'); mkdirSync(split);
    for (const f of ['three.mjs', 'xr.mjs', 'three-edges.mjs', 'three-labels.mjs', 'three-mount.mjs']) writeFileSync(join(split, f), readFileSync(join(ROOT, 'renderers', f)));
    const part = renderHtmlDetailed(s, { tokensCss: TOKENS, views: '3d', embedThree: true, vendorDir, rendererDir: split });
    assert.deepEqual([part.renderer.present, part.renderer.missing], [false, ['motion.mjs']], 'a split sibling three.mjs imports but the build lacks');
    assert.match(part.html, /data-overlay="3d">3D\/VR renderer incomplete: this build is missing renderers\/motion\.mjs/);
  });
});

test('vendor files missing under --embed-three: the overlay says so and DF_RENDER_VENDOR_MISSING names each file', async () => {
  await withTmp(async (dir) => {
    const rendererDir = stubRenderers(join(dir, 'renderers'));
    const vendorDir = join(dir, 'vendor'); mkdirSync(vendorDir);
    const s = scenes['scene-workflow'];
    const r = renderHtmlDetailed(s, { tokensCss: TOKENS, views: '3d', embedThree: true, vendorDir, rendererDir });
    assert.equal(r.importmap.present, false);
    assert.deepEqual(r.importmap.missing, THREE_SPECIFIERS.map((x) => `three/${x.file}`));
    assert.match(r.html, /data-overlay="3d">three\.js vendor files are missing from vendor\/three\//);
    const checks = gate.check(s, { html: r.html, views: '3d', embedThree: true, vendorDir, tokensCss: TOKENS });
    assert.deepEqual(codes(checks), ['DF_RENDER_VENDOR_MISSING']);
    assert.equal(fails(checks).length, 4);
    assert.deepEqual(gate.vendorStatus(vendorDir).missing.length, 4);
  });
});

test('gate: one entry per DF_RENDER_* code in catalog order; HEX_LITERAL, SIZE_BUDGET, VIEW_DISABLED, SHAPE_UNKNOWN, TOKEN_UNKNOWN, UNPROJECTED each fail from one fixture', () => {
  const s = scenes['scene-graph'];
  const html = renderHtml(s, { tokensCss: TOKENS });
  const clean = gate.check(s, { html, tokensCss: TOKENS });
  assert.deepEqual(clean.map((c) => c.code), RENDER_CODES);
  assert.ok(clean.every((c) => c.status === 'pass' && c.gate === 'render' && typeof c.blocking === 'boolean'));
  const hex = html.replace('</head>', '<style>.x{color:#ff0000;background:#abc}</style></head>');
  const hexChecks = fails(gate.check(s, { html: hex, tokensCss: TOKENS }));
  assert.deepEqual(hexChecks.map((c) => c.code), ['DF_RENDER_HEX_LITERAL', 'DF_RENDER_HEX_LITERAL']);
  assert.match(hexChecks[0].message, /#ff0000 at line \d+/);
  assert.equal(hexChecks[0].repair, RULES.DF_RENDER_HEX_LITERAL.repair);
  assert.deepEqual(codes(gate.check(s, { svg: renderSvg(s, TOKENS).replace('var(--df-accent)', '#6fd3e8'), tokensCss: TOKENS })), ['DF_RENDER_HEX_LITERAL']);
  assert.deepEqual(codes(gate.check(s, { svg: renderSvg(s, TOKENS, { inlineTokens: true }), tokensCss: TOKENS })), [], 'inlined tokens are the exemption');
  const big = html.replace('</body>', `<!--${'x'.repeat(gate.PLAIN_BUDGET_BYTES)}--></body>`);
  const size = fails(gate.check(s, { html: big, tokensCss: TOKENS }));
  assert.deepEqual(size.map((c) => c.code), ['DF_RENDER_SIZE_BUDGET']);
  assert.match(size[0].message, /bytes > 4194304 \(plain\)/);
  assert.deepEqual(codes(gate.check(s, { html: big, embedThree: true, tokensCss: TOKENS })), [], 'the embedded budget is 8 MB');
  const tl = scenes['scene-timeline'];
  const disabled = fails(gate.check(tl, { views: 'all', tokensCss: TOKENS }));
  assert.deepEqual(disabled.map((c) => [c.code, c.path]), [['DF_RENDER_VIEW_DISABLED', '$.views.vr']]);
  assert.deepEqual(fails(gate.check(s, { views: ['3d'], viewsOff: ['3d'], tokensCss: TOKENS })).map((c) => c.message), ['A requested view is disabled for this scene or pack (views_off or vr.enabled false): \'3d\' is listed in views_off']);
  const no3d = { ...s, views: { '2d': s.views['2d'] } };
  assert.deepEqual(fails(gate.check(no3d, { views: '3d', tokensCss: TOKENS })).map((c) => c.path), ['$.views.3d']);
  const odd = { ...s, nodes: [...s.nodes, { ...s.nodes[0], id: 'x-1', kind: 'x-sensor' }, { ...s.nodes[1], id: 'x-2', shape: 'blob', color_token: 'series-9' }] };
  const shape = fails(gate.check(odd, { tokensCss: TOKENS }));
  assert.deepEqual(shape.map((c) => [c.code, c.path]), [['DF_RENDER_SHAPE_UNKNOWN', '$.nodes[6].kind'], ['DF_RENDER_SHAPE_UNKNOWN', '$.nodes[7].shape'], ['DF_RENDER_TOKEN_UNKNOWN', '$.nodes[7].color_token']]);
  const withRow = { shapes: { 'x-sensor': { glyph2d: 'diamond', primitive3d: 'octahedron', size_mult: 1, label_anchor: 'below' } } };
  assert.ok(!codes(gate.check({ ...s, nodes: [odd.nodes[6]] }, { tokensCss: TOKENS, ...withRow })).includes('DF_RENDER_SHAPE_UNKNOWN'));
  assert.deepEqual(codes(gate.check({ ...s, groups: [{ ...s.groups[0], color_token: 'series-7' }] }, { tokensCss: TOKENS })), ['DF_RENDER_TOKEN_UNKNOWN']);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, requireProjected: true, sessionKey: EXAMPLE_SESSION_KEY })), []);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, requireProjected: true, sessionKey: 'wrong-key' })), ['DF_RENDER_UNPROJECTED']);
  assert.deepEqual(codes(gate.check({ ...s, projected: undefined }, { tokensCss: TOKENS, requireProjected: true, sessionKey: EXAMPLE_SESSION_KEY })), ['DF_RENDER_UNPROJECTED']);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, requireProjected: false, sessionKey: 'wrong-key' })), [], 'an authored scene is not required to be projected');
  for (const garbage of [null, 7, 'scene', [], { nodes: 'no', views: 3 }]) assert.doesNotThrow(() => gate.check(garbage, { html: 42, views: 9, svg: {} }));
  assert.equal(gate.check(null, {}).length, RENDER_CODES.length);
});

test('gate: DF_RENDER_SELF_VIEW_EXPORTED is non-blocking and fires only for a self render written outside .dotfield/ without --i-know', () => {
  const s = scenes['scene-graph'];
  const root = join(ROOT, 'test', 'fixtures');
  const outside = fails(gate.check(s, { tokensCss: TOKENS, outputPath: 'out.html', root }));
  assert.deepEqual(outside.map((c) => [c.code, c.blocking, c.path]), [['DF_RENDER_SELF_VIEW_EXPORTED', false, '$.meta.output']]);
  assert.match(outside[0].message, /out\.html is outside \.dotfield/);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, outputPath: join(root, '.dotfield', 'renders', 'x', 'out.html'), root })), []);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, outputPath: '.dotfield/out.html', root })), []);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, outputPath: 'out.html', root, iKnow: true })), []);
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, outputPath: 'out.html', root, viewer: 'ada' })), [], 'a person render may leave');
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, outputPath: '/elsewhere/out.html', root, dotDir: '/elsewhere' })), [], 'dotDir override');
  assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, root })), [], 'no output path, nothing exported');
});

test('viewer bundle: the fragments concatenate in order inside one IIFE, parse as a classic script, and never fetch or store', () => {
  const bundle = viewerBundle();
  assert.ok(bundle.startsWith("(function(){\n'use strict';\nconst DF={};"));
  assert.ok(bundle.trimEnd().endsWith('DF.boot();\n})();'));
  assert.doesNotThrow(() => new Script(bundle));
  let last = -1;
  for (const f of VIEWER_FILES) {
    const head = readFileSync(join(ROOT, 'renderers', 'viewer', f), 'utf8').split('\n')[0];
    const at = bundle.indexOf(head);
    assert.ok(at > last, `${f} in order`);
    last = at;
    assert.ok(!/missing \*\//.test(bundle), `${f} present`);
  }
  assert.doesNotMatch(bundle, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket/);
  assert.deepEqual(bundle.match(gate.HEX_RE) || [], []);
  assert.ok(!bundle.includes('http'));
  for (const fn of ['DF.setState', 'DF.reachSet', 'DF.lensMatches', 'DF.showCard', 'DF.materialize', 'DF.exportSvg', 'DF.exportPng', 'DF.exportCard', 'DF.onKey', 'DF.zoomBy', 'DF.boot']) assert.match(bundle, new RegExp(`${fn.replace('.', '\\.')} = (?:async )?function`), fn);
  assert.match(bundle, /derived from \$\{d\.person_id\} under \$\{d\.rule_ref\}/);
  assert.match(bundle, /shared by \$\{b\.shared_by\} under \$\{b\.rule_ref\} on \$\{b\.released_on\}, receipt/);
  for (const key of ["'?'", "'r'", "'l'", "'m'", "'f'", "'s'", "'t'", "'e'", "'+'", "'-'", "'0'", "'2'", "'3'", "'v'"]) assert.ok(bundle.includes(`case ${key}:`), key);
});

test('config block and helpers: themes from the tokens, token names for materialize, view normalisation, manifest tolerance, script-safe JSON', async () => {
  const html = renderHtml(scenes['scene-graph'], { tokensCss: TOKENS, centerName: 'Hall Lab' });
  const cfg = JSON.parse(CONFIG_RE.exec(html)[1]);
  assert.deepEqual(cfg.themes, ['default', 'light', 'paper', 'studio', 'field', 'story', 'editorial', 'blueprint']);
  assert.ok(cfg.token_names.includes('--df-bg') && cfg.token_names.includes('--df-series-6') && cfg.token_names.every((t) => t.startsWith('--df-')));
  assert.equal(cfg.center_name, 'Hall Lab');
  assert.equal(cfg.deep_link, true);
  assert.deepEqual(normalizeViews('all'), ['2d', '3d', 'vr']);
  assert.deepEqual(normalizeViews('vr,2d,nonsense'), ['2d', 'vr']);
  assert.deepEqual(normalizeViews(undefined), ['2d']);
  assert.deepEqual(normalizeViews(['3d', '3d']), ['2d', '3d']);
  assert.equal(toIntegrity(`sha256:${'00'.repeat(32)}`), `sha256-${Buffer.alloc(32).toString('base64')}`);
  assert.equal(toIntegrity('sha384-abc='), 'sha384-abc=');
  assert.equal(toIntegrity('nope'), null);
  assert.equal(scriptJson({ a: '</script><!--' }), '{"a":"\\u003c/script>\\u003c!--"}');
  assert.deepEqual(JSON.parse(scriptJson({ a: '</script>' })), { a: '</script>' });
  await withTmp(async (dir) => {
    assert.deepEqual(readVendorManifest(dir), {});
    writeFileSync(join(dir, 'manifest.json'), '{not json');
    assert.deepEqual(readVendorManifest(dir), {});
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: { three: { path: 'three/three.module.js', cdn: 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js', integrity: 'sha384-xyz=' } } }));
    assert.deepEqual(readVendorManifest(dir), { three: { file: 'three/three.module.js', url: 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js', integrity: 'sha384-xyz=' } });
  });
});

test('gate: a scene whose privacy_mode was hand-edited to synthetic_data, rendered for self outside .dotfield/, still warns (no author-declared exemption)', () => {
  const root = join(ROOT, 'test', 'fixtures');
  for (const s of [scenes['scene-graph'], { ...scenes['scene-graph'], meta: { ...scenes['scene-graph'].meta, privacy_mode: 'synthetic_data', maturity: 'prototype' } }]) {
    const out = fails(gate.check(s, { tokensCss: TOKENS, outputPath: 'out.html', root }));
    assert.deepEqual(out.map((c) => [c.code, c.blocking]), [['DF_RENDER_SELF_VIEW_EXPORTED', false]], `privacy_mode ${s.meta.privacy_mode}`);
    assert.deepEqual(codes(gate.check(s, { tokensCss: TOKENS, outputPath: join(root, '.dotfield', 'renders', 'x', 'out.html'), root })), [], 'inside .dotfield/ nothing is exported');
  }
});

test('gate: DF_RENDER_MOTION_INFINITE reads style blocks, style attributes, SMIL and embedded modules only; a label or caption saying infinite never trips it', () => {
  const base = scenes['scene-graph'];
  const worded = { ...base, nodes: base.nodes.map((n, i) => (i === 0 ? { ...n, label: 'infinite loop', sublabel: 'an infinite regress' } : n)), views: { ...base.views, interactive: { ...base.views.interactive, steps: [{ id: 's1', label: 'Loop', caption: 'the infinite case', nodes: [base.nodes[0].id] }] } } };
  const html = renderHtml(worded, { tokensCss: TOKENS, views: '2d' });
  const svg = renderSvg(worded, TOKENS);
  assert.ok(html.includes('infinite loop') && svg.includes('infinite loop'), 'the word reaches the page as text');
  assert.deepEqual(gate.motionLoops(html, svg), []);
  assert.ok(!codes(gate.check(worded, { html, svg, tokensCss: TOKENS })).includes('DF_RENDER_MOTION_INFINITE'));
  const shellCss = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('');
  assert.ok(shellCss.length > 0);
  assert.doesNotMatch(shellCss, /animation\s*:/, 'the shell carries no CSS animation at all');
  const motion = (h, s2 = null) => fails(gate.check(base, { html: h, svg: s2, tokensCss: TOKENS })).filter((c) => c.code === 'DF_RENDER_MOTION_INFINITE');
  const keyframe = html.replace('</head>', '<style>.df-x{animation:df-spin 2s linear infinite}@keyframes df-spin{to{opacity:0}}</style></head>');
  assert.deepEqual(motion(keyframe).map((c) => [c.path, c.blocking]), [['$.html', true]]);
  assert.match(motion(keyframe)[0].message, /style block/);
  assert.deepEqual(motion(svg.replace('</svg>', '<circle r="1"><animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/></circle></svg>')).map((c) => c.path), ['$.html'], 'markup handed over as html is scanned as html');
  const smil = motion(html, svg.replace('</svg>', '<circle r="1"><animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/></circle></svg>'));
  assert.deepEqual(smil.map((c) => c.path), ['$.svg']);
  assert.match(smil[0].message, /SMIL/);
  assert.equal(motion(html.replace('<body', '<body style="animation: df-pulse 1s 3"')).length, 1, 'an iteration count of 3 is refused');
  assert.equal(motion(html.replace('<body', '<body style="animation: df-pulse 300ms cubic-bezier(0.2, 0, 0, 1) 1 forwards"')).length, 0, 'count 1 passes; function arguments are not counts');
  assert.equal(motion(html.replace('<body', '<body style="animation-iteration-count: var(--n)"')).length, 1, 'a var() count cannot be proven 1');
  const module = `data:text/javascript;base64,${Buffer.from("export const css = '.df-y{animation:df-y 1s infinite}';").toString('base64')}`;
  const embedded = html.replace('</head>', `<script type="importmap">{"imports":{"x":"${module}"}}</script></head>`);
  assert.match(motion(embedded)[0].message, /embedded module/);
  assert.match(gate.decodeDataUrls(embedded), /data:text\/javascript;decoded,export const css/);
  assert.deepEqual(motion(html.replace('<style data-df="tokens">', '<style data-df="tokens">.df-z{animation:df-z 1s infinite}')), [], 'the tokens block is exempt');
});

test('gate: DF_RENDER_MOTION_WITHOUT_STILL — a trace or playback scene must carry data-phase in its SVG', () => {
  const s = scenes['scene-workflow'];
  const moving = { ...s, views: { ...s.views, time: { axis: 'order', step: 'beat', motion: 'trace' } } };
  const svg = renderSvg(moving, TOKENS);
  assert.match(svg, /\sdata-phase="/);
  assert.equal(gate.motionWithoutStill(moving, svg), false);
  assert.ok(!codes(gate.check(moving, { svg, tokensCss: TOKENS })).includes('DF_RENDER_MOTION_WITHOUT_STILL'));
  const bare = svg.replace(/\sdata-phase="[^"]*"/g, '');
  const still = fails(gate.check(moving, { svg: bare, tokensCss: TOKENS })).filter((c) => c.code === 'DF_RENDER_MOTION_WITHOUT_STILL');
  assert.deepEqual(still.map((c) => [c.path, c.blocking]), [['$.views.time.motion', true]]);
  assert.equal(gate.motionWithoutStill({ ...moving, views: { ...moving.views, time: { axis: 'order', motion: 'still' } } }, bare), false, 'still needs no phase');
  assert.equal(gate.motionWithoutStill({ ...moving, edges: [] }, bare), false, 'nothing moves without edges');
  const plain = { ...s, views: { ...s.views } }; delete plain.views.time;
  assert.equal(gate.motionWithoutStill(plain, bare), false, 'no time block, no motion');
});
