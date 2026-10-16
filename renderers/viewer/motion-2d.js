// renderers/viewer/motion-2d.js — browser fragment (see state.js). Motion in
// the 2D view is a finite tween between two stills, never a loop:
//   DF.animate({duration, frame(p, h), done(h), ease, onPause, pauseOnPointer})
//     one requestAnimationFrame chain that ends when p reaches 1 (duration is
//     capped at DF.MOTION_MAX_MS and the frame count at DF.maxFrames(), so it
//     always ends); it pauses while document.hidden and resumes when the tab
//     returns, pauses on pointerdown over `pauseOnPointer` (then onPause(h)),
//     and under prefers-reduced-motion it draws frame(1) and calls done()
//     synchronously: one tick, no tween, an instant frame.
//   DF.dashWindow(pattern, length, phase)  the exact mirror of
//     renderers/svg-edges.mjs dashWindow(): stroke-dasharray/-dashoffset in
//     pathLength units (pathLength="100"), so a scrubbed frame at the authored
//     playhead writes the attributes the committed still already carries.
//   DF.traceWindow(phase, trail)  the trace head: the last `trail` of the drawn
//     part of an edge in flight, as a dash window over the same 100 units.
//   DF.setEdgePhase(row, phase, trail)  applies a phase to one edge row.
// CSS carries no keyframes: every moving value is written here, per frame.
// DF.env holds the browser hooks (rAF, matchMedia, visibility, listeners) so
// test/viewer-4d.test.js can drive the tween in Node with a stub clock.
DF.PATH_LENGTH = 100;
DF.MOTION_MAX_MS = 20000;
DF.PATTERNS = { dashed: [6, 4], flow: [10, 6] };
DF.MAX_DASH_ENTRIES = 400;

DF.env = {
  raf: (fn) => window.requestAnimationFrame(fn),
  caf: (id) => window.cancelAnimationFrame(id),
  reduced: () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  hidden: () => typeof document !== 'undefined' && document.hidden === true,
  doc: () => (typeof document !== 'undefined' ? document : null),
  listen(target, type, fn) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    target.addEventListener(type, fn);
    return () => target.removeEventListener(type, fn);
  },
};

DF.ease = {
  linear: (p) => p,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
};

/**
 * The frame budget of a tween, a safety net only: elapsed time ends a tween
 * (p >= 1). One frame per millisecond for the whole duration plus slack, so
 * no display rate (a 360 Hz panel is 2.8 frames per 10 ms) reaches it before
 * the clock does; it only stops a chain whose clock never advances.
 */
DF.maxFrames = (duration) => Math.ceil(duration) + 600;

DF.animate = function animate(opts) {
  const o = opts || {};
  const frame = typeof o.frame === 'function' ? o.frame : () => {};
  const ease = typeof o.ease === 'function' ? o.ease : DF.ease.inOut;
  const duration = Math.min(DF.MOTION_MAX_MS, Math.max(0, Number(o.duration) || 0));
  const env = DF.env;
  const offs = [];
  let id = null; let start = null;
  const h = { running: true, paused: false, pausedBy: null, finished: false, elapsed: 0, frames: 0, duration };
  const end = (completed) => {
    if (!h.running) return;
    if (id !== null) { env.caf(id); id = null; }
    h.running = false; h.paused = false;
    for (const off of offs.splice(0)) off();
    if (completed) { h.finished = true; if (typeof o.done === 'function') o.done(h); }
  };
  const tick = (ts) => {
    id = null;
    if (!h.running || h.paused) return;
    if (env.hidden()) { h.pause('hidden'); return; }
    if (start === null) start = ts - h.elapsed;
    h.elapsed = Math.min(duration, Math.max(0, ts - start));
    h.frames += 1;
    const p = h.elapsed / duration;
    frame(ease(p), h);
    if (p >= 1 || h.frames >= DF.maxFrames(duration)) { if (p < 1) frame(1, h); end(true); return; }
    id = env.raf(tick);
  };
  h.pause = (by) => {
    if (!h.running || h.paused) return;
    h.paused = true; h.pausedBy = by || 'user'; start = null;
    if (id !== null) { env.caf(id); id = null; }
    if (h.pausedBy !== 'hidden' && typeof o.onPause === 'function') o.onPause(h);
  };
  h.resume = () => {
    if (!h.running || !h.paused) return;
    h.paused = false; h.pausedBy = null;
    id = env.raf(tick);
  };
  h.cancel = () => end(false);
  h.finish = () => { if (!h.running) return; h.frames += 1; frame(1, h); end(true); };
  if (duration <= 0 || env.reduced()) { h.frames = 1; frame(1, h); end(true); return h; }
  offs.push(env.listen(env.doc(), 'visibilitychange', () => {
    if (env.hidden()) h.pause('hidden'); else if (h.paused && h.pausedBy === 'hidden') h.resume();
  }));
  if (o.pauseOnPointer) offs.push(env.listen(o.pauseOnPointer, 'pointerdown', () => h.pause('pointer')));
  id = env.raf(tick);
  return h;
};

/** fmt at 2 and 3 decimals, as renderers/svg.mjs writes numbers (never "-0", never exponent form for scene sizes). */
DF.fmt = function fmt(n) { const r = Math.round(n * 100) / 100; return (Object.is(r, -0) ? 0 : r).toString(); };
DF.fmt3 = function fmt3(n) { const r = Math.round(n * 1000) / 1000; return (Object.is(r, -0) ? 0 : r).toString(); };

/** The dash pattern svg-edges.mjs gives an edge: dashed (or a candidate), flow, or none (solid). */
DF.patternOf = function patternOf(edge) {
  const e = edge || {};
  if (e.variant === 'dashed' || e.kind === 'candidate') return DF.PATTERNS.dashed;
  return e.variant === 'flow' ? DF.PATTERNS.flow : null;
};

/** The points of an M/L path as svg.mjs writes it ("M12 30L40 50"); [] for anything else. */
DF.pathPoints = function pathPoints(d) {
  const out = [];
  for (const m of String(d || '').matchAll(/[ML]\s*(-?[0-9.]+)[\s,]+(-?[0-9.]+)/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
};

DF.polyLength = function polyLength(d) {
  const pts = Array.isArray(d) ? d : DF.pathPoints(d);
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) { const dx = pts[i][0] - pts[i - 1][0]; const dy = pts[i][1] - pts[i - 1][1]; total += Math.sqrt(dx * dx + dy * dy); }
  return total;
};

/** Mirror of svg-edges.mjs dashWindow(): phase null/0/1 -> the variant pattern only (nothing for solid); 0 < phase < 1 -> the finite window. */
DF.dashWindow = function dashWindow(pattern, length, phase) {
  const L = DF.PATH_LENGTH; const f3 = DF.fmt3;
  if (!(length > 0)) return { dasharray: pattern ? pattern.join(' ') : null, dashoffset: null };
  const units = pattern ? pattern.map((v) => (v * L) / length) : null;
  if (phase === null || phase === undefined) return { dasharray: units ? units.map(f3).join(' ') : null, dashoffset: null };
  const p = phase < 0 ? 0 : (phase > 1 ? 1 : phase);
  if (!(p > 0 && p < 1)) return { dasharray: units ? units.map(f3).join(' ') : null, dashoffset: null };
  const dashoffset = f3(L * (1 - p));
  if (!units) return { dasharray: `${L} ${L}`, dashoffset };
  const out = []; let pos = 0;
  while (pos < L && out.length < DF.MAX_DASH_ENTRIES) {
    const d = Math.min(units[0], L - pos); out.push(d); pos += d;
    if (pos >= L) break;
    const gap = Math.min(units[1], L - pos); out.push(gap); pos += gap;
  }
  if (pos < L) return { dasharray: `${L} ${L}`, dashoffset };
  if (out.length % 2) out.push(L); else out[out.length - 1] += L;
  return { dasharray: out.map(f3).join(' '), dashoffset };
};

/** The trace head of an edge in flight: the segment [max(0, phase - trail), phase] of the route; null when not in flight. */
DF.traceWindow = function traceWindow(phase, trail) {
  if (!(phase > 0 && phase < 1)) return null;
  const tr = typeof trail === 'number' && trail > 0 ? Math.min(1, trail) : 0.25;
  const a = Math.max(0, phase - tr) * DF.PATH_LENGTH; const b = phase * DF.PATH_LENGTH;
  return { dasharray: `${DF.fmt3(b - a)} ${2 * DF.PATH_LENGTH}`, dashoffset: DF.fmt3(-a) };
};

DF.setAttr = function setAttr(el, name, value) {
  if (!el) return;
  if (value === null || value === undefined) el.removeAttribute(name); else el.setAttribute(name, String(value));
};

/**
 * Apply a phase to one edge row {group, path, pattern, length, head}: the dash
 * window, data-phase, the ghost class at 0, and, when `trail` is a number and
 * the edge is in flight, a trace head drawn over the route (removed otherwise).
 */
DF.setEdgePhase = function setEdgePhase(row, phase, trail) {
  if (!row || !row.path) return;
  const w = DF.dashWindow(row.pattern, row.length, phase);
  DF.setAttr(row.path, 'stroke-dasharray', w.dasharray);
  DF.setAttr(row.path, 'stroke-dashoffset', w.dashoffset);
  DF.setAttr(row.path, 'data-phase', DF.fmt(phase));
  if (row.group) row.group.classList.toggle('df-unborn', phase === 0);
  const head = typeof trail === 'number' ? DF.traceWindow(phase, trail) : null;
  if (!head) { if (row.head) { row.head.remove(); row.head = null; } return; }
  if (!row.head) {
    row.head = document.createElementNS(row.path.namespaceURI, 'path');
    row.head.setAttribute('class', 'df-trace-head');
    row.head.setAttribute('d', row.path.getAttribute('d'));
    row.head.setAttribute('pathLength', String(DF.PATH_LENGTH));
    row.head.setAttribute('aria-hidden', 'true');
    row.path.after(row.head);
  }
  row.head.setAttribute('stroke-dasharray', head.dasharray);
  row.head.setAttribute('stroke-dashoffset', head.dashoffset);
};
