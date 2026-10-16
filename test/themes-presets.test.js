// The two named presets (V2_PLAN §11 themes-presets): `editorial` (warm paper,
// ink-blue accents, serif display and text, generous spacing) and `blueprint`
// (deep blue, cyan linework, mono text, a grid texture from tokens alone).
// A preset only re-points --df-* tokens — including --df-font-metrics-* and
// --df-label-size — so the layout gate measures exactly what svg.mjs draws.
// `dotfield render --theme <name>` overrides meta.theme for one render, and
// DF_RENDER_TOKEN_UNKNOWN resolves color_token against the chosen theme.
// node:test, zero network, temp dirs only. Refresh the preset goldens after an
// intended change:  DOTFIELD_UPDATE_GOLDEN=1 node --test test/themes-presets.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, parseThemes, resolveColor, resolveToken, contrastRatio, FONT_METRICS, MIN_CONTRAST, SURFACE_TOKENS, TEXT_TOKENS } from '../lib/theme.mjs';
import { runContrast } from '../scripts/contrast.mjs';
import { renderSvg, fmt } from '../renderers/svg.mjs';
import { TITLE_SIZE } from '../renderers/svg-chrome.mjs';
import { fontStackFor, labelStyle, labelWidth, parsedTokens } from '../lib/layout/metrics.mjs';
import { layoutScene } from '../lib/layout/index.mjs';
import * as layoutGate from '../lib/gates/layout.mjs';
import * as renderGate from '../lib/gates/render.mjs';
import { validate } from '../lib/validate.mjs';
import { themesOf } from '../lib/commands/render.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { runCli } from './helpers/cli.mjs';
import { EPOCH_ENV, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { shared } from './fixtures/ir/build-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'golden');
const UPDATE = process.env.DOTFIELD_UPDATE_GOLDEN === '1' || process.argv.includes('--update-golden');
const TOKENS_FILE = join(ROOT, 'renderers', 'tokens.css');
const TOKENS = readFileSync(TOKENS_FILE, 'utf8');
const PRESETS = ['editorial', 'blueprint'];
const EXAMPLES = ['scene-graph', 'scene-room', 'scene-timeline', 'scene-workflow'];
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'examples', `${name}.json`), 'utf8'));
const themed = (s, theme) => ({ ...s, meta: { ...s.meta, theme } });
const textTags = (svg) => [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
const attr = (attrs, name) => { const m = new RegExp(`(?:^| )${name}="([^"]*)"`).exec(attrs); return m ? m[1] : null; };
/** The preset golden's scene: build-fixtures shared() (groups, a foreign boundary stub, a proposal, a share edge), frozen positions, one edge label. */
function presetFixture(theme) {
  const s = shared();
  s.meta = { ...s.meta, id: 'preset-fixture', title: 'Preset fixture — method web', theme };
  s.nodes = s.nodes.map((n) => ({ ...n, label: { 'n-1': 'Calibration run', 'n-2': 'Orbit paper', 'n-3': 'Field notes' }[n.id] ?? n.label }));
  s.edges = s.edges.map((e) => (e.id === 'e1' ? { ...e, label: 'cites' } : e));
  return s;
}
const nodeLabels = (svg) => textTags(svg).filter((t) => /(?:^| )class="df-label(?: df-label--budget)?"/.test(t.attrs));
const fails = (checks, code) => checks.filter((c) => c.status === 'fail' && (!code || c.code === code));
/** The scene with its geometry tables dropped, so layoutScene() lays it out cold under the given theme. */
function cold(s, theme, quality = 'showcase') {
  const out = { ...s, meta: { ...s.meta, theme, quality }, laid_out: false };
  delete out.positions; delete out.routes; delete out.labels;
  if (out.views && out.views['2d']) { out.views = { ...out.views, '2d': { ...out.views['2d'] } }; delete out.views['2d'].plan; }
  return out;
}

test('tokens.css declares editorial and blueprint after the room themes; each re-points the fonts it draws', () => {
  const parsed = parseThemes(TOKENS);
  assert.deepEqual(parsed.order.slice(-2), PRESETS, 'the presets close the theme list');
  assert.deepEqual(themesOf(TOKENS), ['default', 'light', 'paper', 'studio', 'field', 'story', 'editorial', 'blueprint']);
  const ed = parsed.themes.editorial; const bp = parsed.themes.blueprint;
  assert.equal(ed['color-scheme'], 'light');
  assert.equal(bp['color-scheme'], 'dark');
  assert.equal(resolveToken(parsed, 'font-metrics-display', 'editorial'), 'serif');
  assert.equal(resolveToken(parsed, 'font-metrics-text', 'editorial'), 'serif');
  assert.equal(resolveToken(parsed, 'font-metrics-text', 'blueprint'), 'mono');
  assert.equal(resolveToken(parsed, 'font-metrics-display', 'blueprint'), 'condensed');
  for (const theme of PRESETS) {
    for (const role of ['display', 'text', 'mono']) {
      const id = resolveToken(parsed, `font-metrics-${role}`, theme);
      assert.equal(resolveToken(parsed, `font-${role}`, theme), FONT_METRICS.stacks[id].families, `${theme}: --df-font-${role} is the ${id} stack the gate measures`);
    }
  }
  assert.equal(resolveToken(parsed, 'label-size', 'editorial'), '13px', 'editorial sets labels a step larger');
  assert.equal(resolveToken(parsed, 'label-size', 'blueprint'), '12px');
  const px = (theme, n) => Number.parseFloat(resolveToken(parsed, `space-${n}`, theme));
  for (let n = 1; n <= 7; n += 1) assert.ok(px('editorial', n) > px('default', n), `editorial space-${n} is more generous than the default`);
  assert.equal(resolveToken(parsed, 'texture', 'default'), 'none', 'no texture unless a theme re-points it');
  const grid = resolveToken(parsed, 'texture', 'blueprint');
  assert.equal((grid.match(/linear-gradient\(/g) || []).length, 2, 'blueprint draws a two-axis grid');
  assert.ok(grid.includes(resolveToken(parsed, 'line-quiet', 'blueprint')), 'the grid is drawn in the theme line token');
  assert.equal(resolveToken(parsed, 'texture-size', 'blueprint'), '24px 24px');
  assert.match(TOKENS, /:root > body \{\s*background-image: var\(--df-texture\);\s*background-size: var\(--df-texture-size\);/);
  assert.notEqual(resolveToken(parsed, 'bg', 'editorial'), resolveToken(parsed, 'bg', 'paper'), 'editorial is its own surface, not a copy of paper');
});

test('every contrast-ledger pair of both presets clears 4.5:1, series clear 3:1, and the committed ledger is current', () => {
  const ledger = buildLedger(TOKENS);
  assert.deepEqual(ledger.errors, []);
  for (const theme of PRESETS) {
    const pairs = ledger.pairs.filter((p) => p.theme === theme);
    assert.equal(pairs.length, TEXT_TOKENS.length * SURFACE_TOKENS.length + 1, `${theme}: every text/surface pair plus ink-invert on accent`);
    for (const p of pairs) assert.ok(p.ratio >= MIN_CONTRAST, `${theme}: --df-${p.text} on --df-${p.surface} is ${p.ratio}`);
    assert.ok(TOKENS.includes(`── ${theme} (`), `the ledger lists ${theme}`);
    const parsed = parseThemes(TOKENS); const bg = resolveColor(parsed, theme, 'bg');
    for (let i = 1; i <= 6; i += 1) assert.ok(contrastRatio(resolveColor(parsed, theme, `series-${i}`), bg) >= 3, `${theme}: series-${i} graphic contrast`);
  }
  const r = runContrast({ file: TOKENS_FILE, check: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.drift, false);
});

test('labelStyle and the display stack follow the preset', () => {
  assert.deepEqual(labelStyle({ tokensCss: TOKENS, theme: 'blueprint' }), { stack: 'mono', size: 12, source: 'font-metrics.json', theme: 'blueprint' });
  assert.deepEqual(labelStyle({ tokensCss: TOKENS, theme: 'editorial' }), { stack: 'serif', size: 13, source: 'font-metrics.json', theme: 'editorial' });
  const parsed = parsedTokens(TOKENS);
  assert.equal(fontStackFor(parsed, 'display', 'blueprint'), 'condensed');
  assert.equal(fontStackFor(parsed, 'display', 'editorial'), 'serif');
});

for (const preset of PRESETS) {
  test(`golden: the preset fixture drawn in ${preset} renders byte-identical SVG carrying data-theme="${preset}"`, () => {
    const s = presetFixture(preset);
    const svg = renderSvg(s, TOKENS);
    assert.match(svg, new RegExp(`^<svg [^>]*data-theme="${preset}"`));
    const eyebrow = textTags(svg).find((t) => / class="df-eyebrow"/.test(` ${t.attrs}`));
    assert.equal(eyebrow.text, `GRAPH · ${preset.toUpperCase()} · PROTOTYPE`);
    assert.equal(renderSvg(presetFixture(preset), TOKENS), svg, 'deterministic');
    assert.equal(renderSvg(presetFixture('studio'), TOKENS, { theme: preset }), svg, 'opts.theme overrides meta.theme and draws the same SVG');
    assert.deepEqual(fails(layoutGate.check(s, { tokensCss: TOKENS, quality: 'showcase' })), [], 'the frozen fixture is showcase-clean in the preset font');
    const file = join(GOLDEN, `preset-${preset}.svg`);
    if (UPDATE || !existsSync(file)) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, svg);
      assert.ok(UPDATE, `preset-${preset}.svg was missing and has been written; run again (or set DOTFIELD_UPDATE_GOLDEN=1 to refresh deliberately)`);
    }
    assert.equal(svg, readFileSync(file, 'utf8'), `preset-${preset}.svg drifted; if intended: DOTFIELD_UPDATE_GOLDEN=1 node --test test/themes-presets.test.js`);
  });
}

test("blueprint labels measure textLength == labelWidth(label, {stack: 'mono'}); editorial labels are serif 13; titles use the display stack", () => {
  const s = load('scene-graph');
  const expect = { blueprint: { stack: 'mono', size: 12, display: 'condensed' }, editorial: { stack: 'serif', size: 13, display: 'serif' } };
  const sans = nodeLabels(renderSvg(s, TOKENS, { theme: 'default' }));
  for (const preset of PRESETS) {
    const svg = renderSvg(themed(s, preset), TOKENS);
    const labels = nodeLabels(svg);
    assert.equal(labels.length, s.nodes.length, `${preset}: one label per node`);
    for (const n of s.nodes) {
      const t = labels.find((x) => x.text === n.label.replace(/&/g, '&amp;'));
      assert.ok(t, `${preset}: label for ${n.id}`);
      const want = preset === 'blueprint' ? labelWidth(n.label, { stack: 'mono' }) : labelWidth(n.label, { stack: 'serif', size: 13 });
      assert.equal(attr(t.attrs, 'textLength'), fmt(want), `${preset}: ${n.id}`);
      assert.equal(attr(t.attrs, 'font-size'), fmt(expect[preset].size));
    }
    const changed = labels.filter((t, i) => attr(t.attrs, 'textLength') !== attr(sans[i].attrs, 'textLength'));
    assert.equal(changed.length, labels.length, `${preset}: every label is re-measured, none keeps the sans width`);
    const title = textTags(svg).find((t) => / class="df-title"/.test(` ${t.attrs}`));
    assert.equal(attr(title.attrs, 'textLength'), fmt(labelWidth(s.meta.title, { stack: expect[preset].display, size: TITLE_SIZE })));
  }
});

test('the standalone SVG inlines the preset tokens, so a still keeps its font and colours', () => {
  const svg = renderSvg(load('scene-graph'), TOKENS, { theme: 'blueprint', inlineTokens: true });
  const style = /<style data-df="tokens">([^<]*)<\/style>/.exec(svg) ?? /<style [^>]*>(:root\{[^<]*)<\/style>/.exec(svg);
  assert.ok(style, 'inlined token block');
  assert.ok(style[1].includes(`--df-bg:${resolveToken(TOKENS, 'bg', 'blueprint')}`));
  assert.ok(style[1].includes('--df-font-metrics-text:mono'));
  assert.ok(style[1].includes(`--df-font-text:${FONT_METRICS.stacks.mono.families}`));
});

test('the gate measures what is drawn: a cold layout under each preset is showcase-clean, and mono labels that clear in sans overlap', () => {
  for (const preset of PRESETS) {
    for (const name of EXAMPLES) {
      const laid = layoutScene(cold(load(name), preset), { tokensCss: TOKENS, theme: preset });
      assert.equal(laid.laid_out, true, `${name}/${preset} laid out`);
      const out = layoutGate.check(laid, { tokensCss: TOKENS, quality: 'showcase' });
      assert.deepEqual(fails(out).map((c) => `${c.code} ${c.path}`), [], `${name} laid out cold in ${preset} is clean at showcase (meta.theme read by the gate)`);
    }
  }
  const label = 'Operator handoff';
  const wSans = labelWidth(label, { stack: 'sans', size: 12 }); const wMono = labelWidth(label, { stack: 'mono', size: 12 });
  const gap = (wSans + wMono) / 2 + 4;
  const s = cold(load('scene-graph'), 'default', 'checked');
  const pair = { ...s, nodes: s.nodes.slice(0, 2).map((n) => ({ ...n, kind: 'record', label })), edges: [], groups: undefined, laid_out: true };
  delete pair.groups;
  pair.positions = { [pair.nodes[0].id]: [600, 400], [pair.nodes[1].id]: [600 + gap, 400] };
  assert.deepEqual(fails(layoutGate.check(pair, { tokensCss: TOKENS }), 'DF_LAYOUT_LABEL_CLEARANCE'), [], `sans labels (${wSans.toFixed(1)} px) clear at ${gap.toFixed(1)} px`);
  for (const ctx of [{ tokensCss: TOKENS, theme: 'blueprint' }, { tokensCss: TOKENS }]) {
    const scene = ctx.theme ? pair : themed(pair, 'blueprint');
    const f = fails(layoutGate.check(scene, ctx), 'DF_LAYOUT_LABEL_CLEARANCE');
    assert.ok(f.length > 0, `mono labels (${wMono.toFixed(1)} px) overlap at ${gap.toFixed(1)} px (${ctx.theme ? 'ctx.theme' : 'meta.theme'})`);
    assert.ok(f.some((c) => c.message.includes(`${Math.round(wMono * 10) / 10} px wide`)), f.map((c) => c.message).join(' | '));
  }
});

test('DF_RENDER_TOKEN_UNKNOWN resolves color_token against the theme it is given', () => {
  const css = `${TOKENS.replace(/--df-foreign:\s*[^;]+;/g, '')}\n:root[data-theme="blueprint"] { --df-foreign: ${resolveToken(TOKENS, 'foreign', 'blueprint')}; }\n`;
  const s = load('scene-graph');
  const at = s.nodes.findIndex((n) => n.color_token === 'foreign');
  assert.ok(at >= 0, 'scene-graph has a foreign node');
  const under = (theme) => fails(renderGate.check(s, { tokensCss: css, theme }), 'DF_RENDER_TOKEN_UNKNOWN');
  assert.deepEqual(under('studio').map((c) => c.path), [`$.nodes[${at}].color_token`]);
  assert.ok(under('studio')[0].message.includes('theme studio'));
  assert.deepEqual(under('blueprint'), []);
  assert.deepEqual(fails(renderGate.check(themed(s, 'blueprint'), { tokensCss: css }), 'DF_RENDER_TOKEN_UNKNOWN'), [], 'meta.theme is the fallback');
});

test('scene and brand schemas accept the presets and nothing else new', () => {
  const sceneSchema = readJson(join(ROOT, 'schemas', 'scene.schema.json'));
  const brandSchema = readJson(join(ROOT, 'schemas', 'brand.schema.json'));
  const themes = themesOf(TOKENS);
  assert.deepEqual(sceneSchema.$defs.meta.properties.theme.enum, themes, 'meta.theme is exactly the themes tokens.css declares');
  assert.deepEqual(brandSchema.properties.room_preset.enum, themes, 'room_preset is exactly the themes tokens.css declares');
  const s = load('scene-graph');
  for (const preset of PRESETS) assert.equal(validate(sceneSchema, themed(s, preset)).ok, true, `meta.theme ${preset} validates`);
  assert.deepEqual(validate(sceneSchema, themed(s, 'neon')).errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_ENUM $.meta.theme']);
});

test('render --theme <name> overrides meta.theme for the SVG, the HTML and the gates; an unknown theme is refused', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const cli = (args) => runCli(args, { cwd: c.root, env: EPOCH_ENV });
    const scene = load('scene-graph');
    writeJson(join(c.root, 'graph.json'), scene);
    const r = cli(['render', 'graph.json', '--view', '2d', '--theme', 'blueprint', '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.exit_code, 0);
    assert.equal(r.json.status, 'written');
    const ref = (kind) => join(c.root, r.json.outputs.find((o) => o.kind === kind).ref);
    const svg = readFileSync(ref('svg'), 'utf8'); const html = readFileSync(ref('html'), 'utf8');
    assert.match(svg, /^<svg [^>]*data-theme="blueprint"/);
    assert.match(html, /<html lang="en" data-theme="blueprint">/);
    assert.ok(svg.includes('--df-font-metrics-text:mono'), 'the still carries the blueprint tokens');
    assert.equal(readJson(ref('scene')).meta.theme, scene.meta.theme, 'the scene is not rewritten; the receipt argv records the flag');
    assert.ok(r.json.argv.includes('--theme'));

    const bad = cli(['render', 'graph.json', '--theme', 'neon', '--json']);
    assert.notEqual(bad.code, 0);
    assert.equal(bad.json.status, 'blocked');
    const f = fails(bad.json.checks, 'DF_SCHEMA_ENUM');
    assert.deepEqual(f.map((x) => x.path), ['--theme']);
    assert.ok(f[0].message.includes('editorial|blueprint'), f[0].message);

    // A brand css where only blueprint defines --df-foreign: the default render (meta.theme studio) is refused, --theme blueprint is not.
    const css = `${TOKENS.replace(/--df-foreign:\s*[^;]+;/g, '')}\n:root[data-theme="blueprint"] { --df-foreign: ${resolveToken(TOKENS, 'foreign', 'blueprint')}; }\n`;
    mkdirSync(join(c.centerDir, 'brand'), { recursive: true });
    writeFileSync(join(c.centerDir, 'brand', 'tokens.generated.css'), css);
    const studio = cli(['render', 'graph.json', '--view', '2d', '--json']);
    assert.equal(studio.json.status, 'blocked');
    assert.ok(fails(studio.json.checks, 'DF_RENDER_TOKEN_UNKNOWN').some((x) => x.message.includes('theme studio')));
    const blue = cli(['render', 'graph.json', '--view', '2d', '--theme', 'blueprint', '--json']);
    assert.equal(blue.json.status, 'written', JSON.stringify(fails(blue.json.checks)));
    assert.deepEqual(fails(blue.json.checks, 'DF_RENDER_TOKEN_UNKNOWN'), []);
  });
});

test('owned files stay under 400 lines', () => {
  for (const rel of ['renderers/tokens.css', 'lib/commands/render.mjs', 'test/themes-presets.test.js', 'schemas/brand.schema.json']) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n').length;
    assert.ok(lines < 400, `${rel} has ${lines} lines`);
  }
});
