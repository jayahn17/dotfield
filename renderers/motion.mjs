// renderers/motion.mjs — time in the 3D view. The 3D scene shows the frame
// the 2D viewer computes (DF.visibleAt at t, renderers/viewer/timebar.js) and
// never a clock of its own: the viewer pushes every frame through
// api.setTime(detail) and the 'dotfield:time' event, and this module draws it:
//   ghosts      an unborn node is drawn in a ghost material (its own colour at
//               --df-ghost-opacity, depthWrite off) instead of its solid
//               instance — the 3D twin of the 2D df-unborn class
//   beads       views.time.trace.beads beads along each edge whose phase is in
//               (0, 1), the head at the phase and the rest spaced back over
//               views.time.trace.trail, on the lifted route (three-edges.mjs)
//   now plane   a translucent marker at the ruler's x for t (date axis, lift
//               or tier wall): the 2D ruler's playhead in 3D, standing below
//               the node volume as the 2D ruler runs below the frame. It never
//               cuts through the nodes: no 2D layout's x is linear in time
//               (timeline is ordinal, force and cluster-disc ignore time), so
//               a plane among them would split present from unborn falsely
//   rings       an accent ring per fresh node (--df-fresh), one ring on the
//               active node (--df-active)
// Nothing here loops: a still frame stays still, and the viewer owns tweens,
// playback and prefers-reduced-motion. Embedded by html.mjs under the
// specifier dotfield/motion.
//   timeBlockOf(scene) -> {axis, field, trail, beads, from, to} | null     dayIndex(iso) -> int | null
//   normalizeFrame(detail | visibleAt result) -> {t, tNum, present, fresh, active, taken, phases} | null
//   nowX(time, tNum, frame) -> three.js X | null
//   createMotion(THREE, ctx) -> null without views.time, else {group, time, ghosts, beads, fresh, active, plane, apply(state), recolor(col, tokens), dispose()}
import { pointAlong } from './three-edges.mjs';
import { tokenValue } from './three-labels.mjs';

export const MOTION = Object.freeze({ ghost_opacity: 0.12, bead_scale: 0.32, bead_shrink: 0.16, beads_max: 8, fresh_ring: 1.6, active_ring: 2.15, plane_opacity: 0.12, plane_margin: 0.08 });
/** Mirror of lib/time/playhead.mjs TRACE_DEFAULTS and the schema's trace bounds. */
export const TRACE = Object.freeze({ trail: 0.25, beads: 3, trail_min: 0.05, trail_max: 1, beads_min: 1 });
const ISO_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const daysIn = (y, m) => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : (m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31));

/** Mirror of lib/time/ticks.mjs dayIndex: days since 1970-01-01 for a real ISO date, else null. */
export function dayIndex(iso) {
  const m = typeof iso === 'string' ? ISO_RE.exec(iso) : null; if (!m) return null;
  const y0 = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y0, mo)) return null;
  const y = mo <= 2 ? y0 - 1 : y0; const era = Math.floor(y / 400); const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1; const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** What the 3D view needs of views.time, defaults filled as lib/time timeOf fills them; on a date axis from/to are day indices (min/max over node births and edge times unless authored). */
export function timeBlockOf(scene) {
  const raw = isObject(scene) && isObject(scene.views) && isObject(scene.views.time) ? scene.views.time : null;
  if (!raw || (raw.axis !== 'date' && raw.axis !== 'order')) return null;
  const tr = isObject(raw.trace) ? raw.trace : {};
  const time = { axis: raw.axis, field: typeof raw.field === 'string' ? raw.field : 'happened_on', from: null, to: null,
    trail: clamp(typeof tr.trail === 'number' ? tr.trail : TRACE.trail, TRACE.trail_min, TRACE.trail_max), beads: clamp(Number.isInteger(tr.beads) ? tr.beads : TRACE.beads, TRACE.beads_min, MOTION.beads_max) };
  if (time.axis !== 'date') return time;
  const born = (n) => { const p = isObject(n) && isObject(n.provenance) ? n.provenance : {}; const v = dayIndex(p[time.field]); return v !== null ? v : dayIndex(p.captured_on); };
  const byId = new Map(objects(scene.nodes).map((n) => [n.id, n])); const pts = [];
  for (const n of byId.values()) { const v = born(n); if (v !== null) pts.push(v); }
  for (const e of objects(scene.edges)) {
    const at = dayIndex(e.at); if (at !== null) { pts.push(at); continue; }
    const a = byId.has(e.from) ? born(byId.get(e.from)) : null; const b = byId.has(e.to) ? born(byId.get(e.to)) : null;
    const v = a === null ? b : (b === null ? a : Math.max(a, b)); if (v !== null) pts.push(v);
  }
  const lo = pts.length ? pts.reduce((a, b) => (b < a ? b : a)) : null; const hi = pts.length ? pts.reduce((a, b) => (b > a ? b : a)) : null;
  time.from = dayIndex(raw.from) ?? lo; time.to = dayIndex(raw.to) ?? hi;
  return time;
}

/** A viewer frame detail ({t, t_num, present[], fresh[], active, taken, phases{}}) or a lib/time visibleAt result (Sets, edgePhase Map) as one shape. */
export function normalizeFrame(frame) {
  if (!isObject(frame)) return null;
  const set = (v) => (v instanceof Set ? new Set(v) : (Array.isArray(v) ? new Set(v.filter((x) => typeof x === 'string')) : null));
  const src = frame.edgePhase instanceof Map ? frame.edgePhase : (frame.phases instanceof Map ? frame.phases : (isObject(frame.phases) ? Object.entries(frame.phases) : []));
  const phases = new Map(); for (const [k, v] of src) if (typeof v === 'number' && Number.isFinite(v)) phases.set(String(k), clamp(v, 0, 1));
  const raw = frame.t_num !== undefined ? frame.t_num : frame.tNum; const t = frame.t === undefined ? null : frame.t;
  const tNum = typeof raw === 'number' && Number.isFinite(raw) ? raw : (typeof t === 'number' && Number.isFinite(t) ? t : (typeof t === 'string' ? dayIndex(t) : null));
  return { t, tNum, present: set(frame.present), fresh: set(frame.fresh) || new Set(), active: typeof frame.active === 'string' ? frame.active : null, taken: typeof frame.taken === 'string' ? frame.taken : null, phases };
}

/** The ruler's x for t (svg-chrome rulerSvg / DF.moveRuler: from..to across the frame inside its padding, clamped) in three.js metres; null without a window. */
export function nowX(time, tNum, frame) {
  if (!time || time.from === null || time.to === null || typeof tNum !== 'number' || !Number.isFinite(tNum)) return null;
  const xL = frame.x0 + frame.padding; const xR = frame.x0 + frame.w - frame.padding;
  const x = time.to > time.from ? xL + ((tNum - time.from) / (time.to - time.from)) * (xR - xL) : (xL + xR) / 2;
  return (clamp(x, xL, xR) - frame.cx) * frame.metres_per_px;
}

const ghostOpacity = (tokens) => { const v = parseFloat(tokenValue(tokens, 'ghost-opacity')); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : MOTION.ghost_opacity; };

/**
 * The time layer of one built scene. ctx = {scene, slots, edges (three-edges
 * list), index, frame, mode3d, glyphM, geomOf, col, place, ZERO, tokens}.
 * apply({visible, frame, nodes}) draws the frame under the lens (nodes false:
 * the ghost instances are already current) and returns what it
 * drew: {ghosts, beads, bead_edges, fresh, active, now_x}.
 */
export function createMotion(THREE, ctx) {
  const time = timeBlockOf(ctx.scene); if (!time) return null;
  const { slots, edges, index, frame, col, place, ZERO } = ctx;
  const group = new THREE.Group(); group.name = 'motion';
  const M = new THREE.Matrix4(); const Q = new THREE.Quaternion(); const V = new THREE.Vector3(); const S = new THREE.Vector3();
  const ghostMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1), transparent: true, opacity: ghostOpacity(ctx.tokens), depthWrite: false });
  const ghosts = new Map(); const perPrim = new Map();
  for (const s of slots) perPrim.set(s.prim, (perPrim.get(s.prim) || 0) + 1);
  for (const [prim, count] of perPrim) { const im = new THREE.InstancedMesh(ctx.geomOf(prim), ghostMat, count); im.count = 0; im.name = `nodes-ghost-${prim}`; im.frustumCulled = false; im.userData = { status: 'ghost', prim, ids: [] }; ghosts.set(prim, im); group.add(im); }
  for (const s of slots) { const im = ghosts.get(s.prim); s.ghost = im; s.ghostIndex = im.count; im.count += 1; im.userData.ids.push(s.id); im.setMatrixAt(s.ghostIndex, ZERO); im.setColorAt(s.ghostIndex, col(s.token).color); }
  const perEdge = time.beads; const beadR = MOTION.bead_scale * ctx.glyphM;
  const beadGeom = new THREE.SphereGeometry(1, 12, 8);
  const beadMat = new THREE.MeshBasicMaterial({ color: col('trace', 'accent').color, transparent: true, opacity: 0.95, depthWrite: false });
  const beads = new THREE.InstancedMesh(beadGeom, beadMat, Math.max(1, edges.length * perEdge)); beads.count = 0; beads.name = 'beads'; beads.frustumCulled = false; group.add(beads);
  const ringGeom = new THREE.TorusGeometry(1, 0.06, 8, 40);
  const freshMat = new THREE.MeshBasicMaterial({ color: col('fresh', 'accent').color, transparent: true, opacity: 0.95, depthWrite: false });
  const fresh = new THREE.InstancedMesh(ringGeom, freshMat, Math.max(1, slots.length)); fresh.count = 0; fresh.name = 'fresh-rings'; fresh.frustumCulled = false; group.add(fresh);
  const active = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: col('active', 'accent-2').color, transparent: true, opacity: 0.9, depthWrite: false })); active.name = 'active-ring'; active.visible = false; group.add(active);
  let plane = null;
  if (time.axis === 'date' && ctx.mode3d !== 'metric' && time.from !== null && time.to !== null && time.from <= time.to && slots.length) {
    const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
    for (const s of slots) for (let k = 0; k < 3; k += 1) { lo[k] = Math.min(lo[k], s.pos[k] - s.radius); hi[k] = Math.max(hi[k], s.pos[k] + s.radius); }
    const m = MOTION.plane_margin * frame.scale_m; const unit = new THREE.PlaneGeometry(1, 1);
    plane = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ color: col('active', 'accent-2').color, transparent: true, opacity: MOTION.plane_opacity, depthWrite: false, side: THREE.DoubleSide }));
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(unit), new THREE.LineBasicMaterial({ color: col('active', 'accent-2').color, transparent: true, opacity: 0.5 })); rim.name = 'now-plane-rim'; plane.add(rim);
    // A ruler slab under the volume: from one margin below the lowest node down by two more, as deep as the volume.
    plane.name = 'now-plane'; plane.rotation.y = Math.PI / 2; plane.scale.set(hi[2] - lo[2] + 2 * m, 2 * m, 1); plane.position.set(0, lo[1] - 2 * m, (lo[2] + hi[2]) / 2);
    plane.visible = false; plane.renderOrder = -1; plane.userData = { rim }; group.add(plane);
  }
  const ring = (s, k) => { V.set(s.pos[0], s.pos[1], s.pos[2]); S.setScalar(s.radius * k); return M.compose(V, Q, S); };
  return {
    group, time, ghosts, ghostMaterial: ghostMat, beads, beadsPerEdge: perEdge, fresh, active, plane,
    apply({ visible = null, frame: f = null, nodes = true } = {}) {
      const lensOk = (id) => !visible || visible.has(id); const present = f ? f.present : null;
      const shown = (s) => lensOk(s.id) && (!present || present.has(s.id));
      let ghostCount = 0;
      for (const s of slots) { const g = Boolean(present) && lensOk(s.id) && !present.has(s.id); if (g) ghostCount += 1; if (nodes) s.ghost.setMatrixAt(s.ghostIndex, g ? place(s) : ZERO); }
      if (nodes) for (const im of ghosts.values()) im.instanceMatrix.needsUpdate = true;
      let k = 0; const inFlight = [];
      if (f) {
        for (const x of edges) {
          if (!lensOk(slots[x.a].id) || !lensOk(slots[x.b].id)) continue;
          const p = f.phases.has(x.key) ? f.phases.get(x.key) : 1; if (!(p > 0 && p < 1)) continue;
          inFlight.push(x.key);
          for (let j = 0; j < perEdge; j += 1) { const q = pointAlong(x.points, x.fracs, Math.max(0, p - (time.trail * j) / perEdge)); V.set(q[0], q[1], q[2]); S.setScalar(beadR * (1 - MOTION.bead_shrink * j)); M.compose(V, Q, S); beads.setMatrixAt(k, M); k += 1; }
        }
      }
      beads.count = k; beads.instanceMatrix.needsUpdate = true;
      let n = 0; if (f) for (const s of slots) if (f.fresh.has(s.id) && shown(s)) { fresh.setMatrixAt(n, ring(s, MOTION.fresh_ring)); n += 1; }
      fresh.count = n; fresh.instanceMatrix.needsUpdate = true;
      const a = f && f.active && index.has(f.active) ? slots[index.get(f.active)] : null; active.visible = Boolean(a && shown(a));
      if (active.visible) { active.position.set(a.pos[0], a.pos[1], a.pos[2]); active.scale.setScalar(a.radius * MOTION.active_ring); }
      const x = plane && f ? nowX(time, f.tNum, frame) : null; if (plane) { plane.visible = x !== null; if (x !== null) plane.position.x = x; }
      return { ghosts: ghostCount, beads: k, bead_edges: inFlight, fresh: n, active: active.visible ? a.id : null, now_x: x };
    },
    recolor(c, tokens) {
      for (const s of slots) s.ghost.setColorAt(s.ghostIndex, c(s.token).color);
      for (const im of ghosts.values()) if (im.instanceColor) im.instanceColor.needsUpdate = true;
      ghostMat.opacity = ghostOpacity(tokens); beadMat.color.copy(c('trace', 'accent').color); freshMat.color.copy(c('fresh', 'accent').color); active.material.color.copy(c('active', 'accent-2').color);
      if (plane) { plane.material.color.copy(c('active', 'accent-2').color); plane.userData.rim.material.color.copy(c('active', 'accent-2').color); }
    },
    dispose() {
      beadGeom.dispose(); ringGeom.dispose(); ghostMat.dispose(); beadMat.dispose(); freshMat.dispose(); active.material.dispose();
      if (plane) { plane.geometry.dispose(); plane.material.dispose(); plane.userData.rim.geometry.dispose(); plane.userData.rim.material.dispose(); }
    },
  };
}
