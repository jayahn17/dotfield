// renderers/viewer/state.js — browser fragment, concatenated by html.mjs
// inside one IIFE after a prologue that declares `DF` with DF.scene and
// DF.config. One state {focus, reach, lens, theme, view, t, step, live},
// serialised to the URL hash (#focus=…&reach=…&lens=…&theme=…&view=…&t=…
// &step=…&live=…) when the scene allows deep links, and restored on load:
// t is the playhead (a date or a beat of views.time, clamped to its window),
// step the guide step, live whether a finite playback is running. Focus,
// reach, lenses and steps reuse authored nodes, edges and matchers only: the
// viewer never invents topology.
DF.KEYS = ['focus', 'reach', 'lens', 'theme', 'view', 't', 'step', 'live'];
DF.REACHES = ['none', 'in', 'out', 'both'];
DF.q = (sel, root) => (root || document).querySelector(sel);
DF.qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** Create an element with attributes and text/element children; text is always textContent (imported data stays data). */
DF.el = function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

DF.buildIndex = function buildIndex() {
  const nodes = Array.isArray(DF.scene.nodes) ? DF.scene.nodes : [];
  const edges = Array.isArray(DF.scene.edges) ? DF.scene.edges : [];
  const groups = Array.isArray(DF.scene.groups) ? DF.scene.groups : [];
  const byId = new Map(); const inbound = new Map(); const outbound = new Map(); const groupOf = new Map();
  for (const n of nodes) { byId.set(n.id, n); inbound.set(n.id, []); outbound.set(n.id, []); }
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    outbound.get(e.from).push(e.to); inbound.get(e.to).push(e.from);
    if (e.directed === false) { outbound.get(e.to).push(e.from); inbound.get(e.from).push(e.to); }
  }
  for (const g of groups) for (const id of Array.isArray(g.wraps) ? g.wraps : []) if (!groupOf.has(id)) groupOf.set(id, g.id);
  for (const n of nodes) if (typeof n.group === 'string') groupOf.set(n.id, n.group);
  const evidence = new Map((Array.isArray(DF.scene.evidence) ? DF.scene.evidence : []).map((e) => [e.id, e]));
  DF.index = { nodes, edges, groups, byId, inbound, outbound, groupOf, evidence };
  return DF.index;
};

/** The authored focus (views.interactive.focus) when it names a node, else null. */
DF.entryFocus = function entryFocus() {
  const it = (DF.scene.views && DF.scene.views.interactive) || {};
  return typeof it.focus === 'string' && DF.index.byId.has(it.focus) ? it.focus : null;
};

DF.defaultState = function defaultState() {
  const it = (DF.scene.views && DF.scene.views.interactive) || {};
  return {
    // The viewer opens unfocused so the whole scene reads first; views.interactive.focus is the node F focuses when nothing is hovered (DF.entryFocus).
    focus: null,
    reach: DF.REACHES.includes(it.reach) ? it.reach : 'both',
    lens: typeof it.default_lens === 'string' ? it.default_lens : null,
    theme: DF.config.theme || 'default',
    view: DF.config.views[0] || '2d',
    t: DF.TB ? DF.TB.playhead : null,
    step: null,
    live: false,
  };
};

DF.parseHash = function parseHash(hash) {
  const out = {};
  const raw = String(hash || location.hash || '').replace(/^#/, '');
  for (const part of raw.split('&')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = decodeURIComponent(part.slice(0, i)); const v = decodeURIComponent(part.slice(i + 1));
    if (DF.KEYS.includes(k)) out[k] = v === '' ? null : v;
  }
  return out;
};

/** Only what differs from the scene's defaults; a cleared value is written as an empty `key=` so a cleared focus survives the link. */
DF.serializeState = function serializeState(st) {
  const d = DF.defaults;
  return DF.KEYS.filter((k) => st[k] !== d[k] && st[k] !== undefined)
    .map((k) => `${k}=${st[k] === null ? '' : encodeURIComponent(st[k])}`).join('&');
};

/** Replace the hash in place (never a history entry); a document that refuses the clean URL (a data: page) gets a bare '#'. */
DF.writeHash = function writeHash() {
  if (!DF.config.deep_link || !window.history || typeof history.replaceState !== 'function') return;
  const h = DF.serializeState(DF.state);
  if (location.hash === (h ? `#${h}` : '')) return;
  try { history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search); } catch (e) {
    try { history.replaceState(null, '', `#${h}`); } catch (e2) { /* the URL stays as it was; the state is already drawn */ }
  }
};

/** Validate a patch against the scene: unknown focus, lens, view or theme falls back to the default. */
DF.sanitize = function sanitize(st) {
  const d = DF.defaults; const out = { ...st };
  if (out.focus !== null && !DF.index.byId.has(out.focus)) out.focus = null;
  if (!DF.REACHES.includes(out.reach)) out.reach = d.reach;
  if (out.lens !== null && !DF.lensById(out.lens)) out.lens = null;
  if (!DF.config.views.includes(out.view)) out.view = d.view;
  if (!DF.config.themes.includes(out.theme)) out.theme = d.theme;
  const t = DF.TB ? DF.coerceT(out.t) : undefined;
  out.t = t === undefined ? d.t : t;
  out.step = DF.stepById && DF.stepById(out.step) ? out.step : null;
  const canPlay = Boolean(DF.TB) || Boolean(DF.STEPS && DF.STEPS.length);
  out.live = canPlay && (out.live === true || out.live === 'true' || out.live === '1');
  return out;
};

DF.setState = function setState(patch) {
  const prev = DF.state;
  DF.state = DF.sanitize({ ...prev, ...patch });
  DF.render(prev);
  DF.writeHash();
  return DF.state;
};

DF.cycle = function cycle(list, current) {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
};

/** The ids a focus reaches one hop away in the chosen direction (the focus itself included). */
DF.reachSet = function reachSet(focus, reach) {
  const set = new Set();
  if (!focus || !DF.index.byId.has(focus)) return set;
  set.add(focus);
  if (reach === 'in' || reach === 'both') for (const id of DF.index.inbound.get(focus)) set.add(id);
  if (reach === 'out' || reach === 'both') for (const id of DF.index.outbound.get(focus)) set.add(id);
  return set;
};

/** Apply the state to the DOM: classes on nodes and edges, theme on <html>, the active view, the card, then the frame at t (timebar.js) and the guide (steps.js). */
DF.render = function render(prev) {
  const st = DF.state;
  const visible = DF.lensVisible(st.lens);
  const reach = DF.reachSet(st.focus, st.reach);
  for (const g of DF.qa('[data-node-id]')) {
    const id = g.getAttribute('data-node-id');
    const shown = visible === null || visible.has(id);
    g.classList.toggle('df-hidden', !shown);
    g.classList.toggle('df-focus', id === st.focus);
    g.classList.toggle('df-reach', id !== st.focus && reach.has(id));
    g.classList.toggle('df-dim', st.focus !== null && !reach.has(id));
    g.setAttribute('aria-pressed', id === st.focus ? 'true' : 'false');
  }
  for (const eg of DF.qa('[data-edge-id], .df-edge-group')) {
    const a = eg.getAttribute('data-from'); const b = eg.getAttribute('data-to');
    const shown = visible === null || (visible.has(a) && visible.has(b));
    eg.classList.toggle('df-hidden', !shown);
    eg.classList.toggle('df-dim', st.focus !== null && !(reach.has(a) && reach.has(b)));
  }
  if (st.theme === 'default') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', st.theme);
  for (const sec of DF.qa('[data-view]')) sec.hidden = sec.getAttribute('data-view') !== st.view;
  // A 2D view that was hidden at boot (a #view=3d link) is fitted the first time it shows.
  if (prev && prev.view !== '2d' && st.view === '2d' && !DF.fitted && !DF.userZoomed && typeof DF.fitView === 'function' && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => DF.fitView());
  for (const tab of DF.qa('[data-view-tab]')) tab.setAttribute('aria-selected', tab.getAttribute('data-view-tab') === st.view ? 'true' : 'false');
  const lensSel = DF.q('[data-df="lens"]'); if (lensSel) lensSel.value = st.lens || '';
  const themeSel = DF.q('[data-df="theme"]'); if (themeSel) themeSel.value = st.theme;
  const reachBtn = DF.q('[data-df="reach"]'); if (reachBtn) reachBtn.textContent = `Reach: ${st.reach}`;
  if (st.focus) DF.showCard(st.focus); else if (!prev || prev.focus) DF.hideCard();
  if (DF.three) {
    if (!prev || prev.view !== st.view) DF.callThree('setView', st.view);
    if (!prev || prev.theme !== st.theme) DF.callThree('setTheme', st.theme);
    if (!prev || prev.focus !== st.focus) DF.callThree('focus', st.focus);
    if (!prev || prev.lens !== st.lens) DF.callThree('setVisible', visible ? Array.from(visible) : null);
  }
  if (typeof DF.renderTime === 'function') DF.renderTime(prev);
  if (typeof DF.renderStep === 'function') DF.renderStep(prev);
};
