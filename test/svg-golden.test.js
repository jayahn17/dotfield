// The 2D truth: every shipped examples/scene-*.json (committed laid_out:
// true, never re-simulated) renders to byte-identical SVG against
// test/fixtures/golden/<name>.svg; every label carries textLength from the
// same width table the clearance gate measured; every node is one natively
// focusable <g>; colours are var(--df-*) only. node:test, zero network.
// Refresh the goldens after an intended change:
//   DOTFIELD_UPDATE_GOLDEN=1 node --test test/svg-golden.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg, glyphPath, glyphOf, isForeign, fmt, GLYPHS, SVG_NS } from '../renderers/svg.mjs';
import { edgeLabelBox, labelStyle, labelWidth, shapesTable, REGION_PAD_PX } from '../lib/layout/metrics.mjs';
import { edgePolyline } from '../lib/layout/geometry.mjs';
import { layoutScene, positionsComplete } from '../lib/layout/index.mjs';
import { timeOf, visibleAt } from '../lib/time/playhead.mjs';
import { lifecycle, sequence } from './fixtures/ir/build-fixtures.mjs';
import { LIFELINE_TAIL_PX, TITLE_SIZE } from '../renderers/svg-chrome.mjs';
import { HEX_RE } from '../lib/gates/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'golden');
// Every committed scene in examples/ (scene-<name>.json; scene-meet.example.json is laid out at gate time, not committed laid out).
const EXAMPLES = readdirSync(join(ROOT, 'examples')).filter((f) => /^scene-[a-z0-9-]+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
const UPDATE = process.env.DOTFIELD_UPDATE_GOLDEN === '1' || process.argv.includes('--update-golden');
const TOKENS = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const SHAPES = JSON.parse(readFileSync(join(ROOT, 'renderers', 'shapes.json'), 'utf8'));
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'examples', `${name}.json`), 'utf8'));
const scenes = Object.fromEntries(EXAMPLES.map((n) => [n, load(n)]));
const nodeTags = (svg) => [...svg.matchAll(/<g ([^>]*data-node-id="([^"]+)"[^>]*)>/g)].map((m) => ({ attrs: m[1], id: m[2] }));
const textTags = (svg) => [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
const attr = (attrs, name) => { const m = new RegExp(`(?:^| )${name}="([^"]*)"`).exec(attrs); return m ? m[1] : null; };
const edgePath = (svg, id) => new RegExp(`data-edge-id="${id}"[^>]*><path ([^>]*)/>`).exec(svg)[1];
const pathLen = (d) => { const p = [...d.matchAll(/[ML](-?[0-9.]+) (-?[0-9.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]); let t = 0; for (let i = 1; i < p.length; i += 1) t += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return t; };
/** A drawn edge's dash pattern converted back from pathLength="100" units to px, rounded. */
const dashPx = (svg, id) => { const a = edgePath(svg, id); assert.equal(attr(a, 'pathLength'), '100'); const L = pathLen(attr(a, 'd')); return attr(a, 'stroke-dasharray').split(' ').map((v) => Math.round((Number(v) * L) / 100)); };

test('shipped examples are laid_out with a complete positions table: goldens never re-simulate', () => {
  for (const [name, s] of Object.entries(scenes)) {
    assert.equal(s.laid_out, true, `${name} laid_out`);
    assert.ok(positionsComplete(s), `${name} positions complete`);
  }
});

for (const name of EXAMPLES) {
  test(`golden: ${name} renders byte-identical SVG`, () => {
    const file = join(GOLDEN, `${name}.svg`);
    const svg = renderSvg(scenes[name], TOKENS);
    if (UPDATE || !existsSync(file)) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, svg);
      assert.ok(UPDATE, `${name}.svg was missing and has been written; run again (or set DOTFIELD_UPDATE_GOLDEN=1 to refresh deliberately)`);
    }
    assert.equal(svg, readFileSync(file, 'utf8'), `${name}.svg drifted; if the change is intended: DOTFIELD_UPDATE_GOLDEN=1 node --test test/svg-golden.test.js`);
  });
}

test('rendering is deterministic and never mutates the scene', () => {
  for (const [name, s] of Object.entries(scenes)) {
    const before = JSON.stringify(s);
    const a = renderSvg(s, TOKENS); const b = renderSvg(JSON.parse(before), TOKENS);
    assert.equal(a, b, name);
    assert.equal(JSON.stringify(s), before, `${name} mutated`);
  }
});

test('every <text> carries textLength + lengthAdjust="spacingAndGlyphs", and node labels measure exactly labelWidth()', () => {
  const style = labelStyle({ tokensCss: TOKENS });
  assert.equal(style.source, 'font-metrics.json');
  for (const [name, s] of Object.entries(scenes)) {
    const svg = renderSvg(s, TOKENS);
    const texts = textTags(svg);
    assert.ok(texts.length >= s.nodes.length, `${name} has a label per node`);
    for (const t of texts) {
      assert.match(t.attrs, /textLength="[0-9.]+"/, `${name}: ${t.text}`);
      assert.match(t.attrs, /lengthAdjust="spacingAndGlyphs"/, `${name}: ${t.text}`);
    }
    for (const n of s.nodes) {
      const label = texts.find((t) => / class="df-label"/.test(` ${t.attrs}`) && t.text === n.label.replace(/&/g, '&amp;'));
      assert.ok(label, `${name}: label for ${n.id}`);
      assert.equal(attr(label.attrs, 'textLength'), fmt(labelWidth(n.label, style)));
      assert.equal(attr(label.attrs, 'font-size'), fmt(style.size));
    }
  }
});

test('every node is one natively focusable <g data-node-id tabindex="0" role="button" aria-label> in authored order', () => {
  for (const [name, s] of Object.entries(scenes)) {
    const tags = nodeTags(renderSvg(s, TOKENS));
    assert.deepEqual(tags.map((t) => t.id), s.nodes.map((n) => n.id), name);
    for (const t of tags) {
      assert.equal(attr(t.attrs, 'tabindex'), '0', `${name}/${t.id}`);
      assert.equal(attr(t.attrs, 'role'), 'button', `${name}/${t.id}`);
      assert.ok(attr(t.attrs, 'aria-label'), `${name}/${t.id} aria-label`);
      assert.match(attr(t.attrs, 'transform'), /^translate\(-?[0-9.]+ -?[0-9.]+\)$/);
    }
    assert.equal((renderSvg(s, TOKENS).match(/<canvas/g) || []).length, 0);
  }
});

test('colours are var(--df-*) tokens: no raw hex, no fetch, no localStorage, and the SVG namespace is the only URL', () => {
  for (const [name, s] of Object.entries(scenes)) {
    const svg = renderSvg(s, TOKENS);
    assert.deepEqual(svg.match(HEX_RE) || [], [], name);
    assert.doesNotMatch(svg, /\bfetch\s*\(|localStorage/);
    const urls = (svg.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter((u) => u !== SVG_NS);
    assert.deepEqual(urls, [], name);
    assert.ok((svg.match(/var\(--df-/g) || []).length > 10, `${name} uses tokens`);
    assert.ok(svg.startsWith(`<svg xmlns="${SVG_NS}"`), name);
    assert.ok(!renderSvg(s, TOKENS, { xmlns: false }).includes('xmlns='), `${name} inline form omits xmlns`);
  }
});

test('proposal nodes are dashed with the proposal-dash token; foreign nodes carry the foreign ring; share edges use the foreign token', () => {
  const svg = renderSvg(scenes['scene-graph'], TOKENS);
  const idea = nodeTags(svg).find((t) => t.id === 'idea-vib-cadence');
  assert.match(idea.attrs, /df-node--proposal/);
  const ideaBlock = svg.slice(svg.indexOf('data-node-id="idea-vib-cadence"'), svg.indexOf('</g>', svg.indexOf('data-node-id="idea-vib-cadence"')));
  assert.match(ideaBlock, /stroke-dasharray="var\(--df-proposal-dash\)"/);
  assert.match(ideaBlock, /df-glyph--star/);
  assert.match(ideaBlock, /aria-label="[^"]*derived from ada/);
  const foreign = nodeTags(svg).find((t) => t.id === 'person-ada-calib-cadence');
  assert.match(foreign.attrs, /df-node--foreign/);
  assert.match(foreign.attrs, /shared by ada under ada\/rule-01/);
  const fBlock = svg.slice(svg.indexOf('data-node-id="person-ada-calib-cadence"'), svg.indexOf('</g>', svg.indexOf('data-node-id="person-ada-calib-cadence"')));
  assert.match(fBlock, /class="df-foreign-ring"[^>]*stroke="var\(--df-foreign\)"/);
  assert.match(svg, /data-edge-id="e3"[^>]*>(?:(?!<\/g>).)*stroke="var\(--df-foreign\)"/s);
  assert.match(svg, /data-edge-id="e3"[^>]*>(?:(?!<\/g>).)*marker-end="url\(#df-arrow-foreign\)"/s);
  assert.deepEqual(dashPx(svg, 'e4'), [6, 4], 'dashed keeps its 6 4 px rhythm in pathLength units');
  assert.ok(isForeign(scenes['scene-graph'].nodes[4]) && !isForeign(scenes['scene-graph'].nodes[0]));
});

test('edges follow lib/layout/geometry routePoints: orthogonal workflow flows run as a Z with labels at label_at; straight timeline edges are chords', () => {
  const W = scenes['scene-workflow'];
  const wf = renderSvg(W, TOKENS);
  let zs = 0;
  for (const e of W.edges) {
    const a = W.positions[e.from]; const b = W.positions[e.to];
    const d = new RegExp(`data-edge-id="${e.id}"[^>]*>(?:(?!</g>).)*? d="([^"]+)"`, 's').exec(wf)[1];
    const z = a[0] !== b[0] && a[1] !== b[1]; zs += z ? 1 : 0;
    assert.equal((d.match(/L/g) || []).length, z ? 3 : 1, `${e.id}: ${z ? 'a different row and column is a 4-point Z' : 'one row or one column is a straight run'}`);
  }
  assert.ok(zs > 0, 'the shipped workflow has a Z flow');
  assert.equal((wf.match(/class="df-edge-label"/g) || []).length, 5);
  assert.match(wf, /marker-end="url\(#df-arrow\)"/);
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) assert.deepEqual(dashPx(wf, id), [10, 6], `${id} flow dash 10 6 px`);
  const tl = renderSvg(scenes['scene-timeline'], TOKENS);
  for (const m of tl.matchAll(/class="df-edge df-edge--[^"]+" d="([^"]+)"/g)) assert.equal((m[1].match(/L/g) || []).length, 1, 'chord');
});

test('group regions: a padded convex hull per graph-like group (REGION_PAD_PX beyond the largest glyph), a box per grid group that holds no other node (else the hull), a box per metric room group', () => {
  const g = renderSvg(scenes['scene-graph'], TOKENS);
  assert.equal((g.match(/class="df-region /g) || []).length, 2);
  const slam = /data-group-id="g-slam"[^>]*><path d="M[^"]+L[^"]+" fill="none"[^>]*stroke="var\(--df-series-2\)"[^>]*stroke-width="([0-9.]+)"/.exec(g);
  assert.ok(slam, 'two-member group is a stroked chord');
  const rMax = Math.max(...scenes['scene-graph'].nodes.filter((n) => n.group === 'g-slam').map((n) => 10 * (0.7 + 0.6 * n.weight)));
  assert.equal(Number(slam[1]), Number(fmt(2 * (rMax + REGION_PAD_PX))));
  const room = renderSvg(scenes['scene-room'], TOKENS);
  assert.equal((room.match(/class="df-region df-region--zone" [^>]*><rect /g) || []).length, 2);
  assert.equal((room.match(/class="df-footprint"/g) || []).length, 4, 'four sized assets draw a ground footprint');
  const T = scenes['scene-timeline']; const tl = renderSvg(T, TOKENS);
  const sept = T.groups.find((x) => x.id === 'g-sept').wraps.map((id) => T.positions[id]).sort((p, q) => p[0] - q[0]);
  assert.ok(sept.length === 5 && sept.every((p) => p[1] === sept[0][1]), 'the cold timeline puts the five September runs on one row');
  assert.match(tl, new RegExp(`data-group-id="g-sept"[^>]*><path d="M${fmt(sept[0][0])} ${fmt(sept[0][1])}L${fmt(sept[4][0])} ${fmt(sept[4][1])}" fill="none"`), 'five collinear members: the hull is a chord, as the gate measures it');
  const W = scenes['scene-workflow'];
  // A grid group is drawn as archify draws a boundary, a rectangle around its members, whenever that rectangle holds no other node.
  assert.equal((renderSvg(W, TOKENS).match(/class="df-region df-region--zone" [^>]*><rect /g) || []).length, (W.groups || []).length, 'every grid group of the workflow example is a box');
  const tri = { ...W, positions: { ...W.positions, 'svc-sync': [1300, 250], 'store-parquet': [300, 650], 'svc-eval': [800, 650] } };
  assert.match(renderSvg(tri, TOKENS), /data-group-id="z-core"[^>]*><rect /, 'three spread members whose box holds no other node: a box');
  // A non-member inside that box would be misread as a member, so the group falls back to its hull (and the gate measures the hull).
  const crowded = { ...tri, positions: { ...tri.positions, 'out-report': [800, 450] } };
  assert.match(renderSvg(crowded, TOKENS), /data-group-id="z-core"[^>]*><path d="M300 650L1300 250L800 650Z" fill="var\(--df-series-3\)"/, 'a non-member inside the box: the closed hull instead');
});

test('region labels sit on their own region and never on each other: the hull triangle that drew Edge and Core at one point now labels each clear of the other (F4)', () => {
  const boxesOf = (svg) => [...svg.matchAll(/class="df-region-label" x="([-0-9.]+)" y="([-0-9.]+)" font-size="([0-9.]+)" textLength="([0-9.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) - Number(m[3]), w: Number(m[4]), h: Number(m[3]) * 1.25 }));
  const W = scenes['scene-workflow'];
  const hand = { ...W, positions: { 'src-rosbag': [300, 250], 'svc-ingest': [800, 250], 'svc-sync': [1300, 250], 'store-parquet': [300, 650], 'svc-eval': [800, 650], 'out-report': [1300, 650] } };
  for (const [name, s] of [...Object.entries(scenes), ['workflow with the old hand grid', hand]]) {
    const b = boxesOf(renderSvg(s, TOKENS));
    assert.equal(b.length, (s.groups ?? []).length, `${name}: one label per drawn region`);
    for (let i = 0; i < b.length; i += 1) for (let j = i + 1; j < b.length; j += 1) assert.ok(!(b[i].x < b[j].x + b[j].w && b[j].x < b[i].x + b[i].w && b[i].y < b[j].y + b[j].h && b[j].y < b[i].y + b[i].h), `${name}: region labels ${i} and ${j} do not overlap`);
  }
  const hb = boxesOf(renderSvg(hand, TOKENS));
  assert.ok(hb[1].y + hb[1].h <= 250 - 28 && hb[1].x < 1300 && hb[1].x + hb[1].w > 1300, 'Core sits just above its topmost member, svc-sync at (1300, 250), outside the padded outline');
});

test('SRC pins, legend and title: one pin per evidence id, the legend only when meta.legend, the title from meta.title', () => {
  for (const [name, s] of Object.entries(scenes)) {
    const svg = renderSvg(s, TOKENS);
    const pins = s.nodes.reduce((n, x) => n + x.evidence_ids.length, 0);
    assert.equal((svg.match(/class="df-pin"/g) || []).length, pins, `${name} pins`);
    assert.match(svg, /class="df-pin"[^>]*>SRC 1</);
    assert.equal(svg.includes('class="df-legend"'), s.meta.legend === true, `${name} legend`);
    assert.match(svg, new RegExp(`<title>${s.meta.title.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/&/g, '&amp;')}</title>`));
  }
  const noLegend = renderSvg({ ...scenes['scene-graph'], meta: { ...scenes['scene-graph'].meta, legend: false } }, TOKENS);
  assert.ok(!noLegend.includes('class="df-legend"'));
  assert.match(renderSvg(scenes['scene-graph'], TOKENS), /df-legend[\s\S]*proposal \(awaiting approval\)[\s\S]*shared in from another center/);
});

test('glyphs: every shapes.json row names a glyph svg.mjs draws, each glyph is a closed path, node.shape overrides the kind, unknown falls back to circle', () => {
  const shapes = shapesTable({ shapes: SHAPES });
  for (const [kind, row] of Object.entries(SHAPES.kinds)) {
    assert.ok(GLYPHS.includes(row.glyph2d), `${kind} glyph ${row.glyph2d}`);
    assert.equal(row.size_mult, 1, `${kind} size_mult stays 1 (layout fixtures pin radii)`);
    assert.equal(glyphOf({ kind }, shapes), row.glyph2d);
  }
  for (const g of GLYPHS) { const d = glyphPath(g, 10); assert.ok(d.startsWith('M') && d.endsWith('Z'), g); assert.doesNotMatch(d, /NaN|e[+-]/); }
  assert.equal(glyphPath('nonsense', 10), glyphPath('circle', 10));
  assert.equal(glyphOf({ kind: 'record', shape: 'star' }, shapes), 'star');
  assert.equal(glyphOf({ kind: 'x-unknown' }, shapes), 'circle');
  assert.equal(fmt(-0.0001), '0'); assert.equal(fmt(1 / 3), '0.33');
});

test('inlineTokens writes the scene theme into the data-df="tokens" style; an unlaid scene is drawn at the centre, never simulated', () => {
  const inline = renderSvg(scenes['scene-room'], TOKENS, { inlineTokens: true });
  assert.match(inline, /<style data-df="tokens">:root\{[^<]*--df-ink:[^<]*\}<\/style>/);
  const plain = renderSvg(scenes['scene-room'], TOKENS);
  assert.match(plain, /<style data-df="tokens"><\/style>/);
  const unlaid = { ...scenes['scene-graph'] }; delete unlaid.positions; delete unlaid.laid_out;
  const svg = renderSvg(unlaid, TOKENS);
  assert.equal((svg.match(/data-unplaced="true"/g) || []).length, unlaid.nodes.length);
  assert.equal(new Set([...svg.matchAll(/transform="translate\(([^)]+)\)"/g)].map((m) => m[1]).filter((t) => t === '800 500')).size, 1);
  assert.doesNotThrow(() => renderSvg(null, TOKENS));
  assert.doesNotThrow(() => renderSvg({ nodes: 'no' }, ''));
});

// --- v2: the still at the authored playhead, the edge language and the chrome ---------------------------

/** A fixture with its committed tables removed, laid out cold through lib/layout (no hand-written geometry). */
function laidCold(make) {
  const s = make(); delete s.positions; delete s.routes; delete s.laid_out; delete s.views['2d'].plan;
  return layoutScene(s, { tokensCss: TOKENS });
}
const timed = (s, time) => ({ ...s, views: { ...s.views, time } });
/** The scene without its time block (the shipped graph and workflow carry one since examples-recipes). */
const untime = (s) => { const views = { ...s.views }; delete views.time; return { ...s, views }; };

test('every edge-label textLength equals the edgeLabelBox() width the gate measures, at the box centre', () => {
  const style = labelStyle({ tokensCss: TOKENS });
  const all = [...Object.values(scenes), laidCold(sequence), laidCold(lifecycle)];
  let seen = 0;
  for (const s of all) {
    const svg = renderSvg(s, TOKENS); const pos = s.positions;
    for (const e of s.edges.filter((x) => typeof x.label === 'string' && x.label)) {
      const box = edgeLabelBox(e, edgePolyline(s, e, pos[e.from], pos[e.to]), style);
      const start = svg.indexOf(`data-edge-id="${e.id}"`); const end = svg.indexOf('class="df-edge-group', start + 1);
      const block = /<text ([^>]*class="df-edge-label[^"]*"[^>]*)>/.exec(svg.slice(start, end < 0 ? svg.length : end));
      assert.ok(block, `${s.meta.id}/${e.id} label drawn`);
      assert.equal(attr(block[1], 'textLength'), fmt(box.w), `${s.meta.id}/${e.id}`);
      assert.equal(attr(block[1], 'x'), fmt(box.x + box.w / 2), `${s.meta.id}/${e.id} x`);
      seen += 1;
    }
  }
  assert.ok(seen >= 11, `measured ${seen} edge labels`);
});

test('the title is measured in the theme display font: paper draws a serif title of labelWidth(title, serif 16)', () => {
  const s = scenes['scene-graph'];
  const paper = renderSvg({ ...s, meta: { ...s.meta, theme: 'paper' } }, TOKENS);
  const title = textTags(paper).find((t) => / class="df-title"/.test(` ${t.attrs}`));
  assert.equal(attr(title.attrs, 'textLength'), fmt(labelWidth(s.meta.title, { stack: 'serif', size: TITLE_SIZE })));
  assert.match(paper, /data-theme="paper"/);
  const eyebrow = textTags(paper).find((t) => / class="df-eyebrow"/.test(` ${t.attrs}`));
  assert.equal(eyebrow.text, `GRAPH · PAPER · ${s.meta.maturity.toUpperCase()}`);
});

test('with a time block every flow, message and transition edge carries data-phase, and the still is visibleAt(playhead)', () => {
  const wf = timed(scenes['scene-workflow'], { axis: 'order', step: 'beat', playhead: 2 });
  const lc = laidCold(lifecycle); const sq = laidCold(sequence);
  for (const s of [wf, lc, sq]) {
    const svg = renderSvg(s, TOKENS); const v = visibleAt(s, timeOf(s).playhead);
    for (const e of s.edges.filter((x) => ['flow', 'message', 'transition'].includes(x.kind))) {
      const a = edgePath(svg, e.id);
      assert.equal(attr(a, 'data-phase'), fmt(v.edgePhase.get(e.id)), `${s.meta.id}/${e.id}`);
      assert.equal(attr(a, 'data-order'), String(e.order));
    }
    for (const n of s.nodes) {
      const tag = nodeTags(svg).find((t) => t.id === n.id).attrs;
      assert.equal(/df-unborn/.test(tag), !v.present.has(n.id), `${s.meta.id}/${n.id} unborn`);
      assert.equal(/df-active/.test(tag), v.active === n.id, `${s.meta.id}/${n.id} active`);
    }
  }
  const untimed = renderSvg(untime(scenes['scene-workflow']), TOKENS);
  assert.doesNotMatch(untimed.replace(/<style>[^<]*<\/style>/, ''), /data-phase|class="df-badge"|class="df-ruler"/, 'no time block: no phase, badge or ruler');
});

test('a date axis still: unborn ghosts, fresh outlines, an edge in flight is a finite partly drawn window, the ruler marks the playhead', () => {
  const s = timed(scenes['scene-graph'], { axis: 'date', field: 'happened_on', step: 'week', playhead: '2026-09-16' });
  const svg = renderSvg(s, TOKENS); const v = visibleAt(s, '2026-09-16');
  const e1 = edgePath(svg, 'e1'); const phase = v.edgePhase.get('e1');
  assert.ok(phase > 0 && phase < 1, `e1 in flight (${phase})`);
  assert.equal(attr(e1, 'stroke-dasharray'), '100 100');
  assert.equal(attr(e1, 'stroke-dashoffset'), String(Math.round(100 * (1 - phase) * 1000) / 1000));
  assert.equal(attr(e1, 'data-at'), '2026-09-18');
  assert.match(nodeTags(svg).find((t) => t.id === 'exp-0412').attrs, /df-unborn/);
  assert.match(svg, /<g class="df-ruler" data-axis="date" data-step="week" data-from="[^"]+" data-to="[^"]+" data-playhead="2026-09-16"/);
  assert.match(svg, /df-legend[\s\S]*not yet at the playhead/);
  assert.match(svg, /@media print\{\.df-edge\[data-phase\]\{stroke-dashoffset:0\}\}/);
  const solid = renderSvg(timed(scenes['scene-graph'], { axis: 'date', field: 'happened_on', step: 'week' }), TOKENS);
  assert.equal(attr(edgePath(solid, 'e1'), 'stroke-dasharray'), null, 'a drawn solid edge carries no window');
  const [, , , h0] = renderSvg(untime(scenes['scene-graph']), TOKENS).match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  const [, , , h1] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.ok(h1 > h0, 'the ruler grows the SVG viewBox below the frame');
});

test('order axis: a sequence laid out through lib/layout draws one numbered badge per beat, open arrows, and lifelines to max route y + 40', () => {
  const s = laidCold(sequence);
  const svg = renderSvg(s, TOKENS);
  const beats = s.views['2d'].plan.beats;
  const badges = [...svg.matchAll(/<g class="df-badge" data-order="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(badges.length, beats);
  assert.deepEqual(badges, s.edges.map((e) => e.order));
  assert.equal((svg.match(/marker-end="url\(#df-arrow-open\)"/g) || []).length, s.edges.length);
  const deepest = Math.max(...Object.values(s.routes).flat().map((p) => p[1]));
  const lines = [...svg.matchAll(/<path class="df-lifeline" d="M(-?[0-9.]+) (-?[0-9.]+)L(-?[0-9.]+) (-?[0-9.]+)"[^>]*data-lifeline-of="([^"]+)"/g)];
  assert.equal(lines.length, s.nodes.length);
  for (const m of lines) {
    assert.equal(m[4], fmt(deepest + LIFELINE_TAIL_PX), `${m[5]} lifeline end`);
    assert.equal(m[1], fmt(s.positions[m[5]][0]));
    assert.ok(Number(m[2]) > s.positions[m[5]][1], 'starts below the glyph');
  }
  const lc = renderSvg(laidCold(lifecycle), TOKENS);
  assert.equal((lc.match(/class="df-edge-pill"/g) || []).length, 3, 'a transition label sits on a pill');
  assert.equal((lc.match(/class="df-lifeline"/g) || []).length, 0);
  assert.match(lc, /df-legend[\s\S]*df-glyph--pill|M-?[0-9.]+ -?[0-9.]+H[^"]*a[^"]*Z" fill="var\(--df-muted\)"/, 'the legend shows the pill the states draw');
});

test('the legend rail is capped at 8 rows with "+n more"; states are never cut', () => {
  const s = scenes['scene-graph'];
  const svg = renderSvg(s, TOKENS);
  assert.equal((svg.match(/class="df-legend-item[" ]/g) || []).length, 8);
  assert.match(svg, /class="df-legend-item df-legend-more"[^>]*>\+\d+ more</);
  assert.match(svg, /proposal \(awaiting approval\)[\s\S]*shared in from another center/);
});

test('renderers/svg.mjs stays under 300 lines after the svg-edges / svg-chrome split', () => {
  for (const [f, max] of [['svg.mjs', 300], ['svg-edges.mjs', 400], ['svg-chrome.mjs', 400]]) {
    const lines = readFileSync(join(ROOT, 'renderers', f), 'utf8').split('\n').length - 1;
    assert.ok(lines < max, `${f} ${lines} lines`);
  }
});
