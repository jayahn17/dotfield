// renderers/viewer/time.js — browser fragment (see state.js), the classic-script
// mirror of lib/time/ticks.mjs + lib/time/playhead.mjs: DF.timeOf, DF.bornAt,
// DF.edgeAt, DF.ticks, DF.visibleAt, DF.phaseOf, DF.stepIndexOf and the day
// arithmetic they rest on. Pure functions of (scene, t): no fetch, no storage,
// no clock, no animation — motion is a tween the viewer runs between two stills.
// test/time.test.js evaluates this file in Node and deep-equals every function
// against lib/time over every example scene; keep the two in step by hand.
// Present and tested in v2.0, mounted into VIEWER_FILES by the viewer-4d ticket.
DF.time = {};
DF.CALENDAR_STEPS = ['day', 'week', 'month', 'year'];
DF.DEFAULT_TIME_FIELD = 'happened_on';
DF.DATE_STEPS = ['day', 'week', 'month', 'year', 'event'];
DF.ORDER_STEPS = ['beat'];
DF.STEP_LEN = { day: 1, week: 7, month: 30, year: 365, event: 1, beat: 1 };
DF.time.TRACE_DEFAULTS = { trail: 0.25, beads: 3, duration_ms: 4000 };
DF.time.ISO_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
DF.time.pad = (n, w) => String(n).padStart(w, '0');
DF.time.isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
DF.time.list = (v) => (Array.isArray(v) ? v.filter(DF.time.isObject) : []);
DF.time.lookup = (index, key) => (index instanceof Map ? index.get(key) : DF.time.isObject(index) ? index[key] : undefined);
DF.time.edgeKey = (e, i) => (typeof e.id === 'string' && e.id ? e.id : `#${i}`);

DF.daysInMonth = function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
};

DF.parseIso = function parseIso(v) {
  const m = typeof v === 'string' ? DF.time.ISO_RE.exec(v) : null;
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > DF.daysInMonth(y, mo)) return null;
  return [y, mo, d];
};

DF.isIsoDate = function isIsoDate(v) { return DF.parseIso(v) !== null; };

DF.formatIso = function formatIso(y, m, d) { return `${DF.time.pad(y, 4)}-${DF.time.pad(m, 2)}-${DF.time.pad(d, 2)}`; };

DF.dayIndex = function dayIndex(isoDate) {
  const p = DF.parseIso(isoDate);
  if (!p) return null;
  const floor = Math.floor;
  const y = p[1] <= 2 ? p[0] - 1 : p[0]; const m = p[1]; const d = p[2];
  const era = floor(y / 400);
  const yoe = y - era * 400;
  const doy = floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

DF.fromDayIndex = function fromDayIndex(n) {
  if (!Number.isInteger(n)) return null;
  const floor = Math.floor;
  const z = n + 719468;
  const era = floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = floor((doe - floor(doe / 1460) + floor(doe / 36524) - floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + floor(yoe / 4) - floor(yoe / 100));
  const mp = floor((5 * doy + 2) / 153);
  const d = doy - floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return DF.formatIso(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
};

DF.time.addMonths = function addMonths(y, m, d, k) {
  const total = y * 12 + (m - 1) + k;
  const y2 = Math.floor(total / 12); const m2 = total - y2 * 12 + 1;
  return [y2, m2, Math.min(d, DF.daysInMonth(y2, m2))];
};

DF.addStep = function addStep(isoDate, step, k) {
  if (k === undefined) k = 1;
  const p = DF.parseIso(isoDate);
  if (!p || !Number.isInteger(k)) return p ? isoDate : null;
  if (step === 'day') return DF.fromDayIndex(DF.dayIndex(isoDate) + k);
  if (step === 'week') return DF.fromDayIndex(DF.dayIndex(isoDate) + 7 * k);
  if (step === 'month') return DF.formatIso(...DF.time.addMonths(p[0], p[1], p[2], k));
  if (step === 'year') return DF.formatIso(...DF.time.addMonths(p[0], p[1], p[2], 12 * k));
  return isoDate;
};

DF.floorToStep = function floorToStep(isoDate, step) {
  const p = DF.parseIso(isoDate);
  if (!p) return null;
  if (step === 'week') { const n = DF.dayIndex(isoDate); return DF.fromDayIndex(n - (((n + 3) % 7) + 7) % 7); }
  if (step === 'month') return DF.formatIso(p[0], p[1], 1);
  if (step === 'year') return DF.formatIso(p[0], 1, 1);
  return isoDate;
};

DF.time.toNum = function toNum(v, axis) {
  if (axis === 'date') return typeof v === 'string' ? DF.dayIndex(v) : Number.isInteger(v) ? v : null;
  return Number.isInteger(v) && v >= 0 ? v : null;
};
DF.time.onAxis = (v, axis) => (axis === 'date' ? DF.isIsoDate(v) : Number.isInteger(v) && v >= 0);
DF.time.toIso = (n) => DF.addStep('1970-01-01', 'day', n);
DF.time.asPoint = (n, axis) => (axis === 'date' ? DF.time.toIso(n) : n);
DF.time.bucketOf = function bucketOf(v, time) {
  const n = DF.time.toNum(v, time.axis);
  if (n === null) return null;
  if (time.axis === 'date' && DF.CALENDAR_STEPS.includes(time.step)) return DF.dayIndex(DF.floorToStep(DF.time.toIso(n), time.step));
  return n;
};

DF.enteringOrders = function enteringOrders(scene) {
  const adj = new Map();
  if (DF.time.isObject(scene) && scene.kind === 'sequence') return adj;
  DF.time.list(scene && scene.edges).forEach((e) => {
    if (!Number.isInteger(e.order)) return;
    const ends = e.directed === false ? [e.from, e.to] : [e.to];
    for (const id of ends) if (typeof id === 'string' && (!adj.has(id) || e.order < adj.get(id))) adj.set(id, e.order);
  });
  return adj;
};

DF.timeIndex = function timeIndex(scene) {
  return { nodesById: new Map(DF.time.list(scene && scene.nodes).map((n) => [n.id, n])), adjacency: DF.enteringOrders(scene) };
};

DF.bornAt = function bornAt(node, time, adjacency) {
  const T = DF.time;
  if (!T.isObject(node) || !T.isObject(time)) return null;
  if (time.axis === 'order') {
    if (Array.isArray(node.tags) && node.tags.includes('initial')) return 0;
    const o = T.lookup(adjacency, node.id); return Number.isInteger(o) && o >= 0 ? o : 0;
  }
  const prov = T.isObject(node.provenance) ? node.provenance : {};
  const field = typeof time.field === 'string' ? time.field : DF.DEFAULT_TIME_FIELD;
  if (DF.isIsoDate(prov[field])) return prov[field];
  return DF.isIsoDate(prov.captured_on) ? prov.captured_on : null;
};

DF.edgeAt = function edgeAt(edge, nodesById, time) {
  const T = DF.time;
  if (!T.isObject(edge) || !T.isObject(time)) return null;
  if (time.axis === 'order') return Number.isInteger(edge.order) && edge.order >= 0 ? edge.order : null;
  if (DF.isIsoDate(edge.at)) return edge.at;
  const a = DF.bornAt(T.lookup(nodesById, edge.from), time, null); const b = DF.bornAt(T.lookup(nodesById, edge.to), time, null);
  if (a === null) return b; if (b === null) return a;
  return a > b ? a : b;
};

DF.time.pointsOf = function pointsOf(scene, time, idx) {
  const T = DF.time; const out = new Set();
  for (const n of idx.nodesById.values()) { const v = T.toNum(DF.bornAt(n, time, idx.adjacency), time.axis); if (v !== null) out.add(v); }
  for (const e of T.list(scene.edges)) { const v = T.toNum(DF.edgeAt(e, idx.nodesById, time), time.axis); if (v !== null) out.add(v); }
  return [...out].sort((x, y) => x - y);
};

DF.timeOf = function timeOf(scene) {
  const T = DF.time;
  const raw = T.isObject(scene) && T.isObject(scene.views) && T.isObject(scene.views.time) ? scene.views.time : null;
  if (!raw || (raw.axis !== 'date' && raw.axis !== 'order')) return null;
  const axis = raw.axis;
  const steps = axis === 'date' ? DF.DATE_STEPS : DF.ORDER_STEPS;
  const time = { axis, field: typeof raw.field === 'string' ? raw.field : DF.DEFAULT_TIME_FIELD, step: steps.includes(raw.step) ? raw.step : steps[steps.length - 1] };
  const points = T.pointsOf(scene, time, DF.timeIndex(scene));
  const lo = points.length ? T.asPoint(points[0], axis) : null; const hi = points.length ? T.asPoint(points[points.length - 1], axis) : null;
  time.from = T.onAxis(raw.from, axis) ? raw.from : lo;
  time.to = T.onAxis(raw.to, axis) ? raw.to : hi;
  time.playhead = T.onAxis(raw.playhead, axis) ? raw.playhead : time.to;
  time.cumulative = typeof raw.cumulative === 'boolean' ? raw.cumulative : true;
  time.motion = raw.motion === 'trace' || raw.motion === 'playback' ? raw.motion : 'still';
  const tr = T.isObject(raw.trace) ? raw.trace : {}; const D = T.TRACE_DEFAULTS;
  time.trace = { trail: typeof tr.trail === 'number' ? tr.trail : D.trail, beads: Number.isInteger(tr.beads) ? tr.beads : D.beads, duration_ms: Number.isInteger(tr.duration_ms) ? tr.duration_ms : D.duration_ms };
  return time;
};

DF.ticks = function ticks(scene) {
  const T = DF.time; const time = DF.timeOf(scene);
  if (!time) return [];
  const from = T.toNum(time.from, time.axis); const to = T.toNum(time.to, time.axis);
  if (from === null || to === null || from > to) return [];
  const stops = new Set([from, to]);
  if (time.axis === 'date' && DF.CALENDAR_STEPS.includes(time.step)) {
    let cur = DF.floorToStep(T.toIso(from), time.step);
    for (let n = DF.dayIndex(cur); n < to; n = DF.dayIndex(cur)) { if (n > from) stops.add(n); cur = DF.addStep(cur, time.step, 1); }
  } else {
    for (const p of T.pointsOf(scene, time, DF.timeIndex(scene))) if (p > from && p < to) stops.add(p);
  }
  return [...stops].sort((x, y) => x - y).map((n) => T.asPoint(n, time.axis));
};

DF.phaseOf = function phaseOf(edge, t, stepLen) {
  const at = DF.time.isObject(edge) ? edge.at : edge;
  const a = typeof at === 'string' ? DF.dayIndex(at) : Number.isInteger(at) ? at : null;
  const tn = typeof t === 'string' ? DF.dayIndex(t) : Number.isInteger(t) ? t : null;
  if (a === null || tn === null) return 1;
  const len = typeof stepLen === 'number' && stepLen > 0 ? stepLen : 1;
  return Math.min(1, Math.max(0, (tn - a + len) / len));
};

DF.stepIndexOf = function stepIndexOf(scene, t) {
  const T = DF.time; const time = DF.timeOf(scene);
  if (!time) return -1;
  const tn = T.toNum(t === null || t === undefined ? time.playhead : t, time.axis);
  if (tn === null) return -1;
  let i = -1;
  for (const s of DF.ticks(scene)) { if (T.toNum(s, time.axis) <= tn) i += 1; else break; }
  return i;
};

DF.time.activeAt = function activeAt(scene, time, idx, tn, present) {
  const T = DF.time; let best = null; let bestAt = null;
  for (const e of T.list(scene.edges)) {
    const n = T.toNum(DF.edgeAt(e, idx.nodesById, time), time.axis);
    if (n === null || n > tn || (bestAt !== null && n <= bestAt)) continue;
    bestAt = n; best = typeof e.to === 'string' && idx.nodesById.has(e.to) ? e.to : null;
  }
  if (best !== null) return best;
  for (const n of idx.nodesById.values()) if (Array.isArray(n.tags) && n.tags.includes('initial') && present.has(n.id)) return n.id;
  let born = null;
  for (const n of idx.nodesById.values()) {
    const b = T.toNum(DF.bornAt(n, time, idx.adjacency), time.axis);
    if (b !== null && b <= tn && (born === null || b > born)) { born = b; best = n.id; }
  }
  return best;
};

DF.visibleAt = function visibleAt(scene, t) {
  const T = DF.time;
  const s = T.isObject(scene) ? scene : {};
  const time = DF.timeOf(s);
  const idx = DF.timeIndex(s);
  const tn = time ? T.toNum(t === null || t === undefined ? time.playhead : t, time.axis) : null;
  const present = new Set(); const fresh = new Set(); const edgePhase = new Map();
  if (tn === null) {
    for (const id of idx.nodesById.keys()) present.add(id);
    T.list(s.edges).forEach((e, i) => edgePhase.set(T.edgeKey(e, i), 1));
    return { present, fresh, edgePhase, active: null };
  }
  const tb = T.bucketOf(tn, time); const len = DF.STEP_LEN[time.step] || 1;
  for (const n of idx.nodesById.values()) {
    const born = T.toNum(DF.bornAt(n, time, idx.adjacency), time.axis);
    if (born === null) { present.add(n.id); continue; }
    const same = T.bucketOf(born, time) === tb;
    if (time.cumulative ? born <= tn : same) { present.add(n.id); if (same) fresh.add(n.id); }
  }
  T.list(s.edges).forEach((e, i) => {
    const at = T.toNum(DF.edgeAt(e, idx.nodesById, time), time.axis);
    if (at === null) edgePhase.set(T.edgeKey(e, i), 1);
    else if (!time.cumulative && T.bucketOf(at, time) !== tb) edgePhase.set(T.edgeKey(e, i), 0);
    else edgePhase.set(T.edgeKey(e, i), DF.phaseOf(at, tn, len));
  });
  return { present, fresh, edgePhase, active: T.activeAt(s, time, idx, tn, present) };
};
