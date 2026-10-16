// renderers/viewer/steps.js — browser fragment (see state.js). The guide: a
// stepper over the steps html.mjs normalised into DF.config.steps —
// views.interactive.steps[] when authored, else the presentation[] shorthand
// (one node per step), else, for a lifecycle scene, one step per state in the
// order its transitions are first taken (lib/layout/lifecycle.mjs), each with
// the playhead of the transition that enters it. A step sets focus, brings
// its nodes and edges forward (the rest dims) and moves the playhead when it
// names one; its caption reads in the guide panel. N/B step, G opens and
// closes the guide, P plays through the steps (with no time bar: a finite
// tween over the list). Steps reuse authored ids only; ids that the viewer's
// projection removed are dropped, and a step left empty is skipped.
DF.STEPS = [];
DF.STEP_DWELL_MS = 1400;

/** DF.config.steps sanitised against the index: unknown node and edge ids dropped, playheads clamped to the window. */
DF.stepList = function stepList() {
  const raw = Array.isArray(DF.config.steps) ? DF.config.steps : [];
  const edgeIds = new Set(DF.index.edges.filter((e) => e && typeof e.id === 'string').map((e) => e.id));
  const ids = (v, ok) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && ok(x)) : []);
  const out = [];
  for (const st of raw) {
    if (!st || typeof st.id !== 'string' || out.some((o) => o.id === st.id)) continue;
    const nodes = ids(st.nodes, (x) => DF.index.byId.has(x));
    const edges = ids(st.edges, (x) => edgeIds.has(x));
    if (!nodes.length && !edges.length) continue;
    const ph = st.playhead === null || st.playhead === undefined ? undefined : DF.coerceT(st.playhead);
    out.push({
      id: st.id, label: typeof st.label === 'string' && st.label ? st.label : st.id, caption: typeof st.caption === 'string' ? st.caption : '',
      nodes, edges, playhead: ph === undefined ? null : ph, nodeSet: new Set(nodes), edgeSet: new Set(edges),
    });
  }
  return out;
};

DF.stepById = function stepById(id) {
  return typeof id === 'string' ? (DF.STEPS || []).find((s) => s.id === id) || null : null;
};

/** Go to a step (null closes the guide): focus its first node, move the playhead when it names one, pause playback unless asked to keep it. */
DF.goStep = function goStep(id, keepLive) {
  const st = DF.stepById(id);
  const patch = { step: st ? st.id : null };
  if (!keepLive) patch.live = false;
  if (st) {
    patch.focus = st.nodes[0] || null;
    if (st.playhead !== null && DF.TB) patch.t = st.playhead;
  }
  DF.setState(patch);
  return Boolean(st);
};

/** Next (dir 1) or previous (dir -1) step; from a closed guide, n opens the first step and b the last. */
DF.nextStep = function nextStep(dir) {
  const list = DF.STEPS || [];
  if (!list.length) return false;
  if (DF.playing) DF.pause();
  const i = list.findIndex((s) => s.id === DF.state.step);
  const j = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir));
  return DF.goStep(list[j].id);
};

DF.toggleGuide = function toggleGuide() {
  const list = DF.STEPS || [];
  if (!list.length) return false;
  if (DF.playing) DF.pause();
  return DF.state.step ? (DF.goStep(null), true) : DF.goStep(list[0].id);
};

/** With no time bar, P walks the steps: one finite tween over the list, a step per equal share of it. */
DF.startStepPlayback = function startStepPlayback() {
  const list = DF.STEPS || [];
  if (!list.length) { DF.setState({ live: false }); return; }
  const i0 = Math.max(0, list.findIndex((s) => s.id === DF.state.step));
  const start = i0 >= list.length - 1 ? 0 : i0;
  const count = list.length - start;
  const token = { cancel() {} };
  DF.playing = token;
  let shown = -1;
  const show = (k) => { if (k !== shown) { shown = k; DF.goStep(list[start + k].id, true); } };
  const h = DF.animate({
    duration: DF.STEP_DWELL_MS * count,
    ease: DF.ease.linear,
    pauseOnPointer: DF.q('.df-main'),
    frame: (p) => show(Math.min(count - 1, Math.floor(p * count))),
    done: () => { if (DF.playing === token || DF.playing === h) DF.playing = null; show(count - 1); DF.setState({ live: false }); },
    onPause: () => DF.pause(),
  });
  if (DF.playing === token) DF.playing = h;
};

/** Called by DF.render: the guide panel and the step overlay (step nodes and edges forward, the rest dimmed). */
DF.renderStep = function renderStep() {
  const st = DF.state;
  const step = DF.stepById(st.step);
  const list = DF.STEPS || [];
  const panel = DF.q('[data-df="steps"]');
  if (panel) {
    panel.hidden = !step;
    const i = step ? list.indexOf(step) : -1;
    const set = (df, text) => { const el = DF.q(`[data-df="${df}"]`, panel); if (el) el.textContent = text; };
    set('step-count', step ? `${i + 1} / ${list.length}` : '');
    set('step-label', step ? step.label : '');
    set('step-caption', step ? step.caption : '');
    const prev = DF.q('[data-df="step-prev"]', panel); if (prev) prev.disabled = i <= 0;
    const next = DF.q('[data-df="step-next"]', panel); if (next) next.disabled = i < 0 || i >= list.length - 1;
  }
  const guide = DF.q('[data-df="guide"]');
  if (guide) guide.setAttribute('aria-pressed', step ? 'true' : 'false');
  for (const g of DF.qa('svg.df-scene [data-node-id]')) {
    const id = g.getAttribute('data-node-id');
    const inStep = Boolean(step && step.nodeSet.has(id));
    g.classList.toggle('df-step', inStep);
    if (!step) continue;
    g.classList.toggle('df-reach', inStep && id !== st.focus);
    g.classList.toggle('df-dim', !inStep && id !== st.focus);
  }
  for (const eg of DF.qa('svg.df-scene .df-edge-group')) {
    const id = eg.getAttribute('data-edge-id');
    const ends = step && step.nodeSet.has(eg.getAttribute('data-from')) && step.nodeSet.has(eg.getAttribute('data-to'));
    const inStep = Boolean(step && ((id && step.edgeSet.has(id)) || ends));
    eg.classList.toggle('df-step', inStep);
    if (step) eg.classList.toggle('df-dim', !inStep);
  }
};

DF.mountSteps = function mountSteps() {
  const panel = DF.q('[data-df="steps"]');
  const guide = DF.q('[data-df="guide"]');
  if (!(DF.STEPS || []).length) {
    if (panel) panel.hidden = true;
    if (guide) guide.hidden = true;
    return;
  }
  if (guide) guide.addEventListener('click', () => DF.toggleGuide());
  if (!panel) return;
  const on = (df, fn) => { const b = DF.q(`[data-df="${df}"]`, panel); if (b) b.addEventListener('click', fn); };
  on('step-prev', () => DF.nextStep(-1));
  on('step-next', () => DF.nextStep(1));
  on('step-close', () => DF.goStep(null));
};
