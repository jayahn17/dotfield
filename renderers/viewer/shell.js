// renderers/viewer/shell.js — browser fragment (see state.js), concatenated
// last. CSS-transform pan/zoom over the inline SVG, the header controls,
// node activation, the honest VR overlay, the bridge to the optional 3D
// module (renderers/three.mjs announces itself with a 'dotfield:3d' event;
// it gets the current time frame through setTime and every later frame as a
// 'dotfield:time' event), and boot(), which builds the time model and the
// guide's steps before the defaults so t and step restore from the hash, then
// mounts the time bar (timebar.js) and the guide (steps.js). No fetch, no
// storage, no DOM ids beyond the two data blocks.
DF.zoom = { k: 1, x: 0, y: 0 };

DF.applyZoom = function applyZoom() {
  const stage = DF.q('[data-df="stage"]');
  if (stage) stage.style.transform = `translate(${DF.zoom.x}px, ${DF.zoom.y}px) scale(${DF.zoom.k})`;
};

DF.zoomBy = function zoomBy(factor, cx, cy) {
  const stage = DF.q('[data-df="stage"]');
  const rect = stage ? stage.parentElement.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const px = typeof cx === 'number' ? cx - rect.left : rect.width / 2;
  const py = typeof cy === 'number' ? cy - rect.top : rect.height / 2;
  const next = Math.min(8, Math.max(0.2, DF.zoom.k * factor));
  const f = next / DF.zoom.k;
  DF.zoom = { k: next, x: px - (px - DF.zoom.x) * f, y: py - (py - DF.zoom.y) * f };
  DF.userZoomed = true;
  DF.applyZoom();
};

/**
 * The pan/zoom that fits a box (screen px, measured at identity) into a view of
 * size w x h with a padding, never shrinking below the whole-viewBox fit (k >= 1)
 * and never enlarging text past maxK. `origin` is the stage's top-left inside the
 * view at identity. Pure, so test/viewer-fit.test.js pins it.
 */
DF.fitZoom = function fitZoom(box, view, origin, { pad = 28, maxK = 4 } = {}) {
  if (!box || !(box.w > 0) || !(box.h > 0) || !(view.w > 0) || !(view.h > 0)) return { k: 1, x: 0, y: 0 };
  const k = Math.min(maxK, Math.max(1, Math.min((view.w - 2 * pad) / box.w, (view.h - 2 * pad) / box.h)));
  const cx = box.x + box.w / 2 - origin.x; const cy = box.y + box.h / 2 - origin.y;
  return { k, x: view.w / 2 - origin.x - k * cx, y: view.h / 2 - origin.y - k * cy };
};

/** Fit the drawn scene (nodes, edges, regions and their labels; not the title, legend or ruler) to the 2D view. */
DF.fitView = function fitView() {
  const stage = DF.q('[data-df="stage"]'); const view = stage && stage.parentElement;
  if (!stage || !view || typeof view.getBoundingClientRect !== 'function') return false;
  const vr = view.getBoundingClientRect(); if (!vr.width || !vr.height) return false;
  DF.zoom = { k: 1, x: 0, y: 0 }; DF.applyZoom();
  const sr = stage.getBoundingClientRect();
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const el of DF.qa('.df-layer--nodes, .df-layer--edges, .df-layer--regions')) {
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  if (!(x1 > x0) || !(y1 > y0)) return false;
  // Text never grows past twice its drawn size: the SVG already scales the viewBox to the view.
  const svg = DF.q('svg', stage); const vb = svg && svg.viewBox && svg.viewBox.baseVal;
  const svgScale = vb && vb.width ? svg.getBoundingClientRect().width / vb.width : 1;
  const maxK = Math.max(1, Math.min(4, 2 / Math.max(svgScale, 0.01)));
  DF.zoom = DF.fitZoom({ x: x0 - vr.left, y: y0 - vr.top, w: x1 - x0, h: y1 - y0 }, { w: vr.width, h: vr.height }, { x: sr.left - vr.left, y: sr.top - vr.top }, { maxK });
  DF.applyZoom(); DF.fitted = true;
  return true;
};

/** 0 and the reset button fit the scene again (the identity view when nothing can be measured). */
DF.zoomReset = function zoomReset() {
  if (DF.fitView()) return;
  DF.zoom = { k: 1, x: 0, y: 0 };
  DF.applyZoom();
};

DF.mountPanZoom = function mountPanZoom() {
  const view = DF.q('[data-view="2d"]');
  if (!view) return;
  view.addEventListener('wheel', (ev) => { ev.preventDefault(); DF.zoomBy(ev.deltaY < 0 ? 1.1 : 0.9, ev.clientX, ev.clientY); }, { passive: false });
  let drag = null;
  view.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || DF.nodeIdOf(ev.target)) return;
    drag = { x: ev.clientX, y: ev.clientY, ox: DF.zoom.x, oy: DF.zoom.y, moved: false };
    view.setPointerCapture(ev.pointerId);
  });
  view.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x; const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; DF.userZoomed = true; }
    DF.zoom.x = drag.ox + dx; DF.zoom.y = drag.oy + dy; DF.applyZoom();
  });
  const stop = () => { drag = null; };
  view.addEventListener('pointerup', stop);
  view.addEventListener('pointercancel', stop);
  view.addEventListener('click', (ev) => {
    const id = DF.nodeIdOf(ev.target);
    if (id) DF.toggleFocus(id);
  });
};

DF.mountControls = function mountControls() {
  for (const tab of DF.qa('[data-view-tab]')) tab.addEventListener('click', () => DF.setState({ view: tab.getAttribute('data-view-tab') }));
  const themeSel = DF.q('[data-df="theme"]');
  if (themeSel) {
    themeSel.replaceChildren(...DF.config.themes.map((t) => DF.el('option', { value: t, text: t })));
    themeSel.addEventListener('change', () => DF.setState({ theme: themeSel.value }));
  }
  const on = (sel, fn) => { const b = DF.q(sel); if (b) b.addEventListener('click', fn); };
  on('[data-df="reach"]', () => DF.setState({ reach: DF.cycle(DF.REACHES, DF.state.reach) }));
  on('[data-df="help-open"]', () => DF.toggleHelp());
  on('[data-df="legend"]', () => DF.toggleLegend());
  on('[data-df="export-svg"]', () => DF.exportSvg());
  on('[data-df="export-png"]', () => DF.exportPng(2));
  on('[data-df="export-card"]', () => DF.exportCard());
  on('[data-df="zoom-in"]', () => DF.zoomBy(1.25));
  on('[data-df="zoom-out"]', () => DF.zoomBy(0.8));
  on('[data-df="zoom-reset"]', () => DF.zoomReset());
};

/** The 3D module (renderers/three.mjs) hands its controller over an event; absent, the panels keep their overlay. */
DF.three = null;
DF.callThree = function callThree(method, arg) {
  const api = DF.three;
  if (api && typeof api[method] === 'function') {
    try { api[method](arg); } catch (e) { DF.overlay('3d', `3D renderer error: ${e && e.message ? e.message : String(e)}`); }
  }
};

DF.overlay = function overlay(view, message) {
  const el = DF.q(`[data-view="${view}"] [data-overlay]`);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
};

DF.mountThreeBridge = function mountThreeBridge() {
  document.addEventListener('dotfield:3d', (ev) => {
    DF.three = ev.detail || null;
    DF.overlay('3d', '');
    DF.callThree('setTheme', DF.state.theme);
    DF.callThree('setView', DF.state.view);
    DF.callThree('focus', DF.state.focus);
    if (DF.lastFrame) DF.callThree('setTime', DF.frameDetail(DF.lastFrame));
  });
  // A 3D pick toggles focus and nothing else: t, playback, view and lens stay as they are.
  document.addEventListener('dotfield:3d-select', (ev) => {
    const id = ev.detail && typeof ev.detail.id === 'string' ? ev.detail.id : null;
    if (id) DF.setState({ focus: DF.state.focus === id ? null : id });
  });
  document.addEventListener('dotfield:3d-error', (ev) => {
    const d = ev.detail || {};
    DF.overlay('3d', d.message || '3D renderer could not start');
  });
};

/** VR is the 3D scene with renderer.xr: say honestly when this browser has no immersive-vr. */
DF.checkWebXr = function checkWebXr() {
  const vr = DF.q('[data-view="vr"]');
  if (!vr || !DF.config.views.includes('vr')) return;
  const unsupported = 'WebXR immersive-vr is not available in this browser. Open this file on a headset browser (Quest) or a WebXR-enabled desktop browser; the 2D and 3D views are complete without it.';
  if (!navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') { DF.overlay('vr', unsupported); return; }
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => { if (!ok) DF.overlay('vr', unsupported); else if (DF.three) DF.overlay('vr', ''); }).catch(() => DF.overlay('vr', unsupported));
};

DF.boot = function boot() {
  DF.buildIndex();
  DF.TB = DF.timeModel();
  DF.STEPS = DF.stepList();
  DF.defaults = DF.defaultState();
  DF.state = DF.defaults;
  DF.mountLensSelect();
  DF.mountControls();
  DF.mountHelp();
  DF.mountPanZoom();
  DF.mountTimebar();
  DF.mountSteps();
  DF.mountThreeBridge();
  document.addEventListener('keydown', DF.onKey);
  // A deep link carries every key that differs from the defaults; without deep_link nothing else is in the hash, so a hand-edited one patches the current state.
  window.addEventListener('hashchange', () => DF.setState(DF.config.deep_link ? { ...DF.defaults, ...DF.parseHash() } : DF.parseHash()));
  DF.setState(DF.config.deep_link ? DF.parseHash() : {});
  DF.checkWebXr();
  const refit = () => { if (!DF.userZoomed && DF.state.view === '2d') DF.fitView(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(refit)); else refit();
  window.addEventListener('resize', refit);
  document.documentElement.setAttribute('data-df-ready', 'true');
};
