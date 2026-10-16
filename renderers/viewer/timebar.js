// renderers/viewer/timebar.js — browser fragment (see state.js). The time bar
// under the header when the scene has views.time: scrub stops from the
// DF.ticks mirror (renderers/viewer/time.js), a playhead marker, from/to
// labels, step buttons and a finite play/pause (views.time.trace.duration_ms
// for the whole window). Every frame is DF.visibleAt applied as a pure
// function of t: node classes df-unborn / df-fresh / df-active, and each
// edge's data-phase written as a dash window over pathLength="100", so flow
// traces run along the authored routes. Motion is opt-in (views.time.motion
// trace|playback); with motion still, or under prefers-reduced-motion, every
// change of t is an instant frame. State t and live live in DF.state (hash).
DF.TB = null;
DF.shown = null;
DF.tween = null;
DF.tweenTo = null;
DF.playing = null;
DF.scrubbing = false;
DF.edgeRowsCache = null;
DF.TICK_MARKS_MAX = 120;

/** The time model of the scene, or null without views.time or without scrub stops. */
DF.timeModel = function timeModel() {
  const time = DF.timeOf(DF.scene);
  const ticks = time ? DF.ticks(DF.scene) : [];
  if (!time || !ticks.length) return null;
  const idx = DF.timeIndex(DF.scene);
  const num = (v) => DF.time.toNum(v, time.axis);
  const edges = DF.time.list(DF.scene.edges).map((e, i) => ({ edge: e, key: DF.time.edgeKey(e, i), at: num(DF.edgeAt(e, idx.nodesById, time)) }));
  const nums = ticks.map(num);
  const M = { time, ticks, nums, from: nums[0], to: nums[nums.length - 1], len: DF.STEP_LEN[time.step] || 1, edges };
  const ph = num(time.playhead);
  M.playhead = DF.time.asPoint(ph === null ? M.to : Math.min(M.to, Math.max(M.from, ph)), time.axis);
  return M;
};

DF.pointOf = function pointOf(n) {
  return DF.TB ? DF.time.asPoint(Math.floor(n + 1e-9), DF.TB.time.axis) : null;
};

/** A hash or step value as a point of the axis, clamped into the window; undefined when it is not a point. */
DF.coerceT = function coerceT(v) {
  const M = DF.TB;
  if (!M) return undefined;
  const x = M.time.axis === 'order' && typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : v;
  if (M.time.axis === 'date' && typeof x !== 'string') return undefined;
  const n = DF.time.toNum(x, M.time.axis);
  return n === null ? undefined : DF.pointOf(Math.min(M.to, Math.max(M.from, n)));
};

DF.showT = function showT(point) {
  return DF.TB && DF.TB.time.axis === 'order' ? `beat ${point}` : String(point);
};

/** The frame at t (a number of the axis, fractional while moving): visibleAt at floor(t) for nodes, phases at t itself for edges. */
DF.frameAt = function frameAt(tNum) {
  const M = DF.TB;
  const base = Math.floor(tNum + 1e-9);
  const point = DF.time.asPoint(base, M.time.axis);
  const vis = DF.visibleAt(DF.scene, point);
  const tb = DF.time.bucketOf(base, M.time);
  const edgePhase = new Map();
  let taken = null; let takenAt = null;
  for (const e of M.edges) {
    if (e.at === null) { edgePhase.set(e.key, 1); continue; }
    if (e.at <= base && (takenAt === null || e.at > takenAt)) { takenAt = e.at; taken = e.key; }
    if (!M.time.cumulative && DF.time.bucketOf(e.at, M.time) !== tb) edgePhase.set(e.key, 0);
    else edgePhase.set(e.key, Math.min(1, Math.max(0, (tNum - e.at + M.len) / M.len)));
  }
  return { t: point, tNum, present: vis.present, fresh: vis.fresh, active: vis.active, taken: M.time.axis === 'order' ? taken : null, edgePhase };
};

/** One row per drawn edge: the group, its path, its key (id, or '#<index>' for an id-less edge, matched by ends and kind in scene order). */
DF.edgeRows = function edgeRows() {
  if (DF.edgeRowsCache) return DF.edgeRowsCache;
  const list = DF.time.list(DF.scene.edges);
  const used = new Set();
  const rows = [];
  for (const group of DF.qa('svg.df-scene .df-edge-group')) {
    const id = group.getAttribute('data-edge-id');
    let i = id ? list.findIndex((e) => e.id === id) : -1;
    if (!id) {
      const a = group.getAttribute('data-from'); const b = group.getAttribute('data-to'); const k = group.getAttribute('data-kind');
      i = list.findIndex((e, j) => !used.has(j) && !(typeof e.id === 'string' && e.id) && e.from === a && e.to === b && String(e.kind) === String(k));
    }
    if (i < 0) continue;
    used.add(i);
    const path = DF.q('path.df-edge', group);
    rows.push({ group, path, key: DF.time.edgeKey(list[i], i), pattern: DF.patternOf(list[i]), length: path ? DF.polyLength(path.getAttribute('d')) : 0, head: null });
  }
  DF.edgeRowsCache = rows;
  return rows;
};

DF.frameDetail = function frameDetail(f) {
  return { t: f.t, t_num: f.tNum, present: Array.from(f.present), fresh: Array.from(f.fresh), active: f.active, taken: f.taken, phases: Object.fromEntries(f.edgePhase) };
};

DF.motionOn = function motionOn() {
  return Boolean(DF.TB) && DF.TB.time.motion !== 'still' && !DF.env.reduced();
};

/** Draw the frame at t: nodes, edges (with trace heads while moving), the SVG ruler, the time bar, and the 3D bridge. */
DF.showAt = function showAt(tNum, moving) {
  const M = DF.TB;
  if (!M) return;
  DF.shown = tNum;
  const f = DF.frameAt(tNum);
  DF.lastFrame = f;
  for (const g of DF.qa('svg.df-scene [data-node-id]')) {
    const id = g.getAttribute('data-node-id');
    g.classList.toggle('df-unborn', !f.present.has(id));
    g.classList.toggle('df-fresh', f.fresh.has(id));
    g.classList.toggle('df-active', f.active === id);
  }
  const trail = moving && DF.motionOn() ? M.time.trace.trail : null;
  for (const row of DF.edgeRows()) {
    DF.setEdgePhase(row, f.edgePhase.has(row.key) ? f.edgePhase.get(row.key) : 1, trail);
    row.group.classList.toggle('df-taken', f.taken !== null && f.taken === row.key);
  }
  DF.moveRuler(f);
  DF.moveTimebar(f);
  const detail = DF.frameDetail(f);
  DF.callThree('setTime', detail);
  document.dispatchEvent(new CustomEvent('dotfield:time', { detail }));
};

/** Move the SVG ruler's playhead (svg-chrome.mjs: track, playhead line, dot and label) to t. */
DF.moveRuler = function moveRuler(f) {
  const r = DF.q('svg.df-scene .df-ruler');
  const line = r ? DF.q('.df-playhead', r) : null;
  if (!line) return;
  const track = DF.pathPoints(DF.q('.df-track', r) ? DF.q('.df-track', r).getAttribute('d') : '');
  const ends = DF.pathPoints(line.getAttribute('d'));
  if (track.length < 2 || ends.length < 2) return;
  const M = DF.TB; const xL = track[0][0]; const xR = track[track.length - 1][0];
  const raw = M.to > M.from ? xL + ((f.tNum - M.from) / (M.to - M.from)) * (xR - xL) : (xL + xR) / 2;
  const x = Math.min(xR, Math.max(xL, raw));
  line.setAttribute('d', `M${DF.fmt(x)} ${DF.fmt(ends[0][1])}L${DF.fmt(x)} ${DF.fmt(ends[1][1])}`);
  const dot = line.nextElementSibling;
  if (dot && dot.tagName.toLowerCase() === 'circle') dot.setAttribute('cx', DF.fmt(x));
  const label = DF.q('.df-ruler-playhead', r);
  if (label) {
    const text = DF.showT(f.t);
    if (label.textContent !== text) { label.textContent = text; label.removeAttribute('textLength'); label.removeAttribute('lengthAdjust'); }
    const w = typeof label.getComputedTextLength === 'function' ? label.getComputedTextLength() : 0;
    label.setAttribute('x', DF.fmt(Math.min(xR - w / 2, Math.max(xL + w / 2, x))));
  }
  r.setAttribute('data-playhead', String(f.t));
};

DF.moveTimebar = function moveTimebar(f) {
  const bar = DF.q('[data-df="timebar"]');
  if (!bar) return;
  const range = DF.q('[data-df="t-range"]', bar);
  if (range && !DF.scrubbing) range.value = String(Math.round(f.tNum));
  if (range) range.setAttribute('aria-valuetext', DF.showT(f.t));
  const now = DF.q('[data-df="t-now"]', bar);
  if (now) now.textContent = DF.showT(f.t);
  for (const tick of DF.qa('.df-tb-tick', bar)) tick.classList.toggle('df-tb-tick--on', Number(tick.getAttribute('data-n')) <= f.tNum + 1e-9);
  const play = DF.q('[data-df="t-play"]', bar);
  if (play) { const on = Boolean(DF.state && DF.state.live); play.setAttribute('aria-pressed', on ? 'true' : 'false'); play.textContent = on ? 'Pause' : 'Play'; play.setAttribute('aria-label', on ? 'Pause' : 'Play'); }
};

/** Tween length for a jump from a to b: the trace duration scaled by the share of the window, between 120 and 1200 ms. */
DF.tweenMs = function tweenMs(a, b) {
  const M = DF.TB;
  const span = Math.max(1, M.to - M.from);
  return Math.min(1200, Math.max(120, (M.time.trace.duration_ms * Math.abs(b - a)) / span));
};

/** The step whose playhead is the point t (first in order), or null. */
DF.stepAtT = function stepAtT(point) {
  const list = DF.STEPS || [];
  for (const st of list) if (st.playhead !== null && st.playhead !== undefined && st.playhead === point) return st;
  return null;
};

/** Called by DF.render on every state change: start/stop playback with `live`, then show t (tweened when motion is on). */
DF.renderTime = function renderTime(prev) {
  const st = DF.state;
  if (st.live && !DF.playing) DF.startPlayback();
  else if (!st.live && DF.playing) { const h = DF.playing; DF.playing = null; if (h.cancel) h.cancel(); }
  const M = DF.TB;
  if (!M || DF.playing) { if (M) DF.moveTimebar(DF.lastFrame || DF.frameAt(DF.shown ?? M.to)); return; }
  const next = DF.time.toNum(st.t, M.time.axis);
  if (next === null) return;
  const before = DF.shown;
  if (before === null || !prev) { DF.showAt(next, false); return; }
  if ((before === next && !DF.tween) || (DF.tween && DF.tweenTo === next)) { DF.moveTimebar(DF.lastFrame); return; }
  if (DF.tween) { const tw = DF.tween; DF.tween = null; tw.cancel(); }
  if (!DF.motionOn() || DF.scrubbing) { DF.showAt(next, false); return; }
  const from = DF.shown;
  DF.tweenTo = next;
  DF.tween = DF.animate({
    duration: DF.tweenMs(from, next),
    frame: (p) => DF.showAt(from + (next - from) * p, true),
    done: () => { DF.tween = null; DF.showAt(next, false); },
  });
};

/** The last scrub stop at or before t: with motion still, playback shows stops only (no edge in flight). */
DF.stopAtOrBefore = function stopAtOrBefore(tn) {
  let best = DF.TB.from;
  for (const n of DF.TB.nums) if (n <= tn + 1e-9) best = n;
  return best;
};

/** Finite playback from t (or from the start when t is at the end) to the end of the window; stops cross into DF.state.t. With motion still it steps stop to stop. */
DF.startPlayback = function startPlayback() {
  const M = DF.TB;
  if (!M) { if (typeof DF.startStepPlayback === 'function') DF.startStepPlayback(); return; }
  if (DF.tween) { const tw = DF.tween; DF.tween = null; tw.cancel(); }
  let t0 = DF.time.toNum(DF.state.t, M.time.axis);
  if (t0 === null || t0 >= M.to) t0 = M.from;
  const span = M.to - t0;
  const token = { cancel() {} };
  DF.playing = token;
  let reported = t0;
  const report = (n, live) => {
    const point = DF.pointOf(n);
    const step = DF.stepAtT(point);
    DF.setState({ t: point, live, ...(step ? { step: step.id, focus: step.nodes[0] || null } : {}) });
  };
  if (t0 !== DF.time.toNum(DF.state.t, M.time.axis)) report(t0, true);
  const h = DF.animate({
    duration: (M.time.trace.duration_ms * span) / Math.max(1, M.to - M.from),
    ease: DF.ease.linear,
    pauseOnPointer: DF.q('.df-main'),
    frame: (p) => {
      const tn = t0 + span * p;
      if (DF.motionOn()) DF.showAt(tn, true); else DF.showAt(DF.stopAtOrBefore(tn), false);
      let crossed = null;
      for (const n of M.nums) if (n > reported && n <= tn + 1e-9 && n < M.to) crossed = n;
      if (crossed !== null) { reported = crossed; report(crossed, true); }
    },
    done: () => { if (DF.playing === token || DF.playing === h) DF.playing = null; DF.showAt(M.to, false); report(M.to, false); },
    onPause: () => DF.pause(),
  });
  if (DF.playing === token) DF.playing = h;
};

DF.pause = function pause() {
  const h = DF.playing;
  DF.playing = null;
  if (h && h.cancel) h.cancel();
  const patch = { live: false };
  if (DF.TB && DF.shown !== null) { patch.t = DF.pointOf(DF.shown); DF.shown = null; }
  DF.setState(patch);
};

DF.togglePlay = function togglePlay() {
  if (!DF.TB && !(DF.STEPS && DF.STEPS.length)) return false;
  if (DF.state.live) DF.pause(); else DF.setState({ live: true });
  return true;
};

/** The next (dir 1) or previous (dir -1) scrub stop from the state's t; stepping pauses playback. */
DF.stepTime = function stepTime(dir) {
  const M = DF.TB;
  if (!M) return false;
  const cur = DF.time.toNum(DF.state.t, M.time.axis);
  const nums = dir > 0 ? M.nums.filter((n) => n > cur) : M.nums.filter((n) => n < cur);
  const n = nums.length ? (dir > 0 ? nums[0] : nums[nums.length - 1]) : cur;
  if (DF.playing) DF.pause();
  DF.setState({ t: DF.pointOf(n), live: false });
  return true;
};

DF.jumpTime = function jumpTime(where) {
  const M = DF.TB;
  if (!M) return false;
  if (DF.playing) DF.pause();
  DF.setState({ t: DF.pointOf(where === 'start' ? M.from : M.to), live: false });
  return true;
};

DF.scrubTo = function scrubTo(n) {
  if (!DF.TB || !Number.isFinite(n)) return;
  if (DF.playing) DF.pause();
  DF.scrubbing = true;
  DF.setState({ t: DF.pointOf(n), live: false });
};

/** Wire the time bar html.mjs wrote: range bounds, tick marks from the mirror, labels, buttons (pointerdown on the scene pauses playback inside DF.animate). */
DF.mountTimebar = function mountTimebar() {
  const bar = DF.q('[data-df="timebar"]');
  if (!bar) return;
  const M = DF.TB;
  if (!M) { bar.hidden = true; return; }
  const range = DF.q('[data-df="t-range"]', bar);
  if (range) {
    range.min = String(M.from); range.max = String(M.to); range.step = '1';
    range.addEventListener('pointerdown', () => { DF.scrubbing = true; if (DF.playing) DF.pause(); });
    range.addEventListener('input', () => DF.scrubTo(Number(range.value)));
    range.addEventListener('change', () => { DF.scrubbing = false; DF.writeHash(); });
    range.addEventListener('pointerup', () => { DF.scrubbing = false; });
  }
  const box = DF.q('[data-df="t-ticks"]', bar);
  if (box) {
    const stride = Math.max(1, Math.ceil(M.nums.length / DF.TICK_MARKS_MAX));
    const span = Math.max(1, M.to - M.from);
    const marks = M.nums.map((n, i) => [n, i]).filter(([, i]) => i % stride === 0 || i === M.nums.length - 1);
    box.replaceChildren(...marks.map(([n, i]) => DF.el('span', { class: 'df-tb-tick', 'data-t': M.ticks[i], 'data-n': n, style: `left:${DF.fmt(((n - M.from) / span) * 100)}%` })));
  }
  const from = DF.q('[data-df="t-from"]', bar); if (from) from.textContent = DF.showT(M.ticks[0]);
  const to = DF.q('[data-df="t-to"]', bar); if (to) to.textContent = DF.showT(M.ticks[M.ticks.length - 1]);
  const on = (df, fn) => { const b = DF.q(`[data-df="${df}"]`, bar); if (b) b.addEventListener('click', fn); };
  on('t-start', () => DF.jumpTime('start'));
  on('t-prev', () => DF.stepTime(-1));
  on('t-play', () => DF.togglePlay());
  on('t-next', () => DF.stepTime(1));
  on('t-end', () => DF.jumpTime('end'));
  bar.hidden = false;
};
