// The first impression of a rendered scene: the 2D viewer fits the drawing to
// the view, the node card never prints "null", the viewer opens unfocused (the
// authored focus is the F key's entry node), and the 3D camera fits the node box
// to both fields of view. Found by a browser review of v2 renders on 2026-10-08.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// three-mount.mjs imports the bare 'three' specifier (resolved by the page's importmap), so the pure helper is lifted from its source.
const MOUNT = readFileSync(new URL('../renderers/three-mount.mjs', import.meta.url), 'utf8');
const FD = MOUNT.match(/export function frameDistance\(half, margin, fovDeg, aspect\) \{[\s\S]*?\n\}/);
const frameDistance = FD ? new Function(`${FD[0].replace('export ', '')}; return frameDistance;`)() : null;

const read = (f) => readFileSync(new URL(`../renderers/viewer/${f}`, import.meta.url), 'utf8');
const load = (DF, files) => { for (const f of files) new Function('DF', read(f))(DF); return DF; };

test('fitZoom fills the view, keeps the centre, never shrinks below the whole-viewBox fit and caps the zoom', () => {
  const DF = load({}, ['shell.js']);
  const view = { w: 1000, h: 500 }; const origin = { x: 0, y: 0 };
  const z = DF.fitZoom({ x: 400, y: 150, w: 200, h: 100 }, view, origin, { pad: 0, maxK: 10 });
  assert.equal(z.k, 5);
  assert.equal(z.x + z.k * 500, 500, 'the box centre maps to the view centre (x)');
  assert.equal(z.y + z.k * 200, 250, 'the box centre maps to the view centre (y)');
  assert.equal(DF.fitZoom({ x: 0, y: 0, w: 2000, h: 900 }, view, origin).k, 1, 'a box larger than the view is never shrunk below k = 1');
  assert.equal(DF.fitZoom({ x: 490, y: 240, w: 20, h: 20 }, view, origin, { maxK: 2 }).k, 2, 'text never grows past the cap');
  assert.deepEqual(DF.fitZoom(null, view, origin), { k: 1, x: 0, y: 0 }, 'nothing measurable means identity');
});

test('the viewer opens unfocused; the authored focus is the entry node F uses', () => {
  const scene = { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [], groups: [], views: { interactive: { focus: 'b', reach: 'both' } } };
  const DF = { scene, config: { theme: 'default', views: ['2d'], themes: ['default'] }, REACHES: ['both', 'in', 'out'] };
  load(DF, ['state.js']);
  DF.buildIndex();
  assert.equal(DF.defaultState().focus, null, 'no card and no dimming on load');
  assert.equal(DF.entryFocus(), 'b');
  scene.views.interactive.focus = 'ghost';
  assert.equal(DF.entryFocus(), null, 'an unknown id is never focused');
});

test('the node card never inserts the text "null" for an absent sublabel, fields or pins', () => {
  let captured = null;
  const card = { hidden: true, replaceChildren: (...parts) => { captured = parts; }, querySelector: () => ({ addEventListener() {} }) };
  const DF = {
    index: { byId: new Map([['a', { id: 'a', kind: 'record', label: 'A', status: 'accepted' }]]), evidence: new Map(), groupOf: new Map(), groups: [], inbound: new Map(), outbound: new Map() },
    q: (sel) => (sel === '[data-df="card"]' ? card : { addEventListener() {} }),
    el: (tag, attrs = {}, kids) => ({ tag, attrs, kids, append() {} }),
    setState() {},
  };
  load(DF, ['evidence.js']);
  DF.showCard('a');
  assert.ok(Array.isArray(captured) && captured.length > 0);
  assert.ok(captured.every((part) => part !== null && part !== undefined), 'replaceChildren receives no null or undefined');
  assert.equal(card.hidden, false);
});

test('frameDistance (lifted from three-mount.mjs) fits a wide flat box to the horizontal field of view at the real aspect', () => {
  assert.equal(typeof frameDistance, 'function', 'three-mount.mjs exports frameDistance');
  const half = [4, 1, 0]; const fov = 50;
  const square = frameDistance(half, 0, fov, 1); const wide = frameDistance(half, 0, fov, 2.4);
  assert.ok(wide < square, 'a wider view brings the camera closer');
  const tv = Math.tan((fov * Math.PI) / 360);
  assert.ok(Math.abs(wide - (4 / (tv * 2.4)) * 1.1) < 1e-9, 'width-limited: the horizontal fit decides');
  assert.ok(Math.abs(frameDistance([1, 4, 0], 0, fov, 2.4) - (4 / tv) * 1.1) < 1e-9, 'height-limited: the vertical fit decides');
  assert.ok(frameDistance([0, 0, 0], 0, fov, 1) >= 0.5, 'never closer than 0.5 m');
});
