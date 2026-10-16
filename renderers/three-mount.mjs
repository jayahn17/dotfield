// renderers/three-mount.mjs — mount3d, the browser entry html.mjs's bootstrap
// calls through renderers/three.mjs: one WebGLRenderer, an orbit camera fitted
// to the node positions, hover labels and click-to-focus (handed back to the
// shell through the deep link), the VR hand-off to renderers/xr.mjs, and the
// time bridge: the 2D viewer pushes every frame of its DF time state through
// api.setTime(detail) and the 'dotfield:time' event (one frame, applied once),
// so scrubbing the time bar moves the 3D scene. Adaptive DPR: the pixel ratio
// drops to 1 when frames take longer than 24 ms for 30 frames in a row.
// three.mjs builds the scene; this module receives buildScene by argument
// (createMount), so the two never import each other. Embedded by html.mjs
// under the specifier dotfield/three-mount.
//   createDprGovernor({start, floor, budgetMs, frames, gapMs}) -> {ratio, dropped, frame(time), sample(dt), reset()}
//   createMount({buildScene, colorOf, tokensFromComputed}) -> mount3d({scene, hosts, views, theme, tokenNames, shapes, xr}) -> api
import * as THREE_NS from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Camera distance that fits a box of half-extents [hx, hy, hz] (plus a margin) into a perspective camera of
 * vertical field of view fovDeg at aspect w/h: the larger of the vertical and horizontal fits, 10 % breathing room,
 * plus the box half-depth. Pure, so test/viewer-fit.test.js pins it without a GPU.
 */
export function frameDistance(half, margin, fovDeg, aspect) {
  const tv = Math.tan((fovDeg * Math.PI) / 360); const th = tv * Math.max(0.2, aspect || 1);
  return Math.max(0.5, Math.max((half[1] + margin) / tv, (half[0] + margin) / th) * 1.1 + half[2]);
}

export const DPR = Object.freeze({ max: 2, floor: 1, budget_ms: 24, frames: 30, gap_ms: 1000 });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const vec3 = (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null);
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/** Adaptive pixel ratio: `frames` consecutive frames slower than `budgetMs` drop the ratio to `floor`, once. A gap longer than `gapMs` (a hidden tab) is no sample. */
export function createDprGovernor({ start = 1, floor = DPR.floor, budgetMs = DPR.budget_ms, frames = DPR.frames, gapMs = DPR.gap_ms } = {}) {
  const g = { ratio: start, slow: 0, dropped: false, last: null };
  g.reset = () => { g.last = null; g.slow = 0; };
  g.sample = (dt) => {
    if (g.dropped || typeof dt !== 'number' || !(dt >= 0) || dt > gapMs) return null;
    g.slow = dt > budgetMs ? g.slow + 1 : 0;
    if (g.slow >= frames && g.ratio > floor) { g.ratio = floor; g.dropped = true; return floor; }
    return null;
  };
  g.frame = (time) => { if (typeof time !== 'number' || !Number.isFinite(time)) return null; const prev = g.last; g.last = time; return prev === null ? null : g.sample(time - prev); };
  return g;
}

export function createMount({ buildScene, colorOf, tokensFromComputed }) {
  return async function mount3d({ scene, hosts, views = [], theme = 'default', tokenNames = [], shapes = null, xr = null, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
    const THREE = THREE_NS; const host3d = hosts && hosts['3d']; const hostVr = hosts && hosts.vr;
    if (!host3d && !hostVr) throw new Error('no [data-mount] host for the 3D view');
    const reduced = !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let tokens = tokensFromComputed(tokenNames, doc.documentElement);
    const built = buildScene(scene, THREE, tokens, { document: doc, shapes });
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    const dpr = createDprGovernor({ start: Math.min(DPR.max, (win && win.devicePixelRatio) || 1) });
    renderer.setPixelRatio(dpr.ratio); renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement; canvas.className = 'df-three'; canvas.setAttribute('aria-label', '3D view of the scene; drag to orbit, wheel to zoom, click a node to focus it');
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block', touchAction: 'none' });
    const world = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500); const rig = new THREE.Group(); rig.name = 'rig'; rig.add(camera); world.add(rig, built.group);
    const v3 = isObject(scene) && isObject(scene.views) && isObject(scene.views['3d']) ? scene.views['3d'] : {}; const cam = isObject(v3.camera) ? v3.camera : {};
    const bb = Object.values(built.positions).reduce((b, q) => b.expandByPoint(new THREE.Vector3(q[0], q[1], q[2])), new THREE.Box3()); const bs = bb.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : bb.getBoundingSphere(new THREE.Sphere());
    bs.radius = Math.max(bs.radius, 0.1) + built.frame.scale_m * 0.08; const ct = vec3(cam.target) || [bs.center.x, bs.center.y, bs.center.z]; const cp = vec3(cam.position) || [ct[0], ct[1] + built.frame.scale_m * 0.35, ct[2] + built.frame.scale_m * 1.4];
    // The authored camera gives the viewing direction and the orbit target; the distance is fitted so the sphere around the node positions (plus a margin) fills the frame; whole-group bounds would include regions and the floor and leave a small scene as a dot.
    const dir = new THREE.Vector3(cp[0] - ct[0], cp[1] - ct[1], cp[2] - ct[2]); if (dir.lengthSq() === 0) dir.set(0, 0.35, 1); dir.normalize();
    // Distance from the node box, not a sphere: a wide flat diagram fits the horizontal field of view at the real aspect (a sphere fit is vertical-only and leaves a wide scene a third of the width).
    const half = bb.isEmpty() ? new THREE.Vector3(bs.radius, bs.radius, 0) : bb.getSize(new THREE.Vector3()).multiplyScalar(0.5); const margin = built.frame.scale_m * 0.08;
    const frameBox = () => { camera.position.set(ct[0], ct[1], ct[2]).addScaledVector(dir, frameDistance([half.x, half.y, half.z], margin, camera.fov, camera.aspect)); };
    frameBox();
    const hemi = new THREE.HemisphereLight(colorOf(THREE, tokens, 'ink').color, colorOf(THREE, tokens, 'bg').color, 1.1); const sun = new THREE.DirectionalLight(new THREE.Color(1, 1, 1), 1.4); sun.position.set(3, 5, 6); world.add(hemi, sun);
    const controls = new OrbitControls(camera, canvas); controls.target.set(ct[0], ct[1], ct[2]); controls.enableDamping = !reduced; controls.dampingFactor = 0.08; controls.update(); controls.addEventListener('start', () => { userMoved = true; }); let userMoved = false;
    const paint = () => { renderer.setClearColor(colorOf(THREE, tokens, 'bg').color, 1); hemi.color.copy(colorOf(THREE, tokens, 'ink').color); hemi.groundColor.copy(colorOf(THREE, tokens, 'bg').color); }; paint();
    const st = { view: '2d', focus: null, hover: null, theme, xrApi: null, tween: null, pointer: null, time: null, timeDetail: undefined, dpr };
    const relabel = () => built.labels.apply(built.labels.plan({ focus: st.focus, hover: st.hover, visible: built.state.shown }));
    const fit = () => { const el = canvas.parentElement; if (!el) return; const w = el.clientWidth || 1; const h = el.clientHeight || 1; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); if (!userMoved && w > 1 && h > 1) { frameBox(); controls.update(); } };
    if (typeof globalThis.ResizeObserver === 'function') { const ro = new globalThis.ResizeObserver(fit); for (const h of [host3d, hostVr]) if (h) ro.observe(h); st.ro = ro; }
    const tick = (time) => {
      const drop = dpr.frame(time); if (drop !== null) { renderer.setPixelRatio(drop); fit(); }
      if (st.tween) { const t = clamp((time - st.tween.t0) / st.tween.dur, 0, 1); const e = 1 - (1 - t) * (1 - t); controls.target.lerpVectors(st.tween.from, st.tween.to, e); if (t >= 1) st.tween = null; }
      controls.update(); if (st.xrApi) st.xrApi.update(time); renderer.render(world, camera);
    };
    const run = (on) => { if (on) dpr.reset(); renderer.setAnimationLoop(on ? tick : null); };
    const raycaster = new THREE.Raycaster(); const ndc = new THREE.Vector2(); const pickables = [...built.solid.values(), ...built.proposal.values()];
    const pick = (ev) => { const r = canvas.getBoundingClientRect(); ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); raycaster.setFromCamera(ndc, camera); const hit = raycaster.intersectObjects(pickables, false)[0]; return hit && hit.object.userData.ids ? hit.object.userData.ids[hit.instanceId] : null; };
    canvas.addEventListener('pointermove', (ev) => { const id = pick(ev); if (id !== st.hover) { st.hover = id; canvas.style.cursor = id ? 'pointer' : ''; relabel(); } });
    canvas.addEventListener('pointerdown', (ev) => { st.pointer = { x: ev.clientX, y: ev.clientY }; });
    canvas.addEventListener('pointerup', (ev) => { const p = st.pointer; st.pointer = null; if (!p || Math.abs(ev.clientX - p.x) + Math.abs(ev.clientY - p.y) > 4) return; const id = pick(ev); if (id) api.select(id); });
    const onTime = (ev) => api.setTime(ev ? ev.detail : null);
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('dotfield:time', onTime);
    const api = {
      built, renderer, camera, controls, world, rig, canvas, reduced, xr: () => st.xrApi, state: st,
      setView(view) {
        const prev = st.view; st.view = view; const host = view === 'vr' ? (hostVr || host3d) : host3d;
        if (view === '2d') { run(false); if (st.xrApi && prev === 'vr') st.xrApi.leave(); return; }
        if (host && canvas.parentElement !== host) host.prepend(canvas);
        if (view === 'vr' && xr && !st.xrApi && typeof xr.enableXr === 'function') st.xrApi = xr.enableXr({ THREE, renderer, world, camera, rig, controls, built, scene, host: hostVr || host3d, document: doc, navigator: win && win.navigator, window: win, reduced, color: (name, fb) => colorOf(THREE, tokens, name, fb), onSelect: (id) => api.select(id) });
        if (st.xrApi) { if (view === 'vr') st.xrApi.place(); else st.xrApi.leave(); }
        fit(); run(true); relabel();
      },
      setTheme(next) { st.theme = next; tokens = tokensFromComputed(tokenNames, doc.documentElement); built.recolor(tokens); paint(); if (st.xrApi) st.xrApi.setTokens(tokens); },
      focus(id) {
        st.focus = built.setFocus(id); relabel();
        if (st.focus) { const p = built.positions[st.focus]; const to = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(built.group.matrixWorld); if (reduced) controls.target.copy(to); else st.tween = { from: controls.target.clone(), to, t0: (win && win.performance ? win.performance.now() : 0), dur: 450 }; }
      },
      setVisible(ids) { built.setVisible(ids); relabel(); },
      /** The viewer's frame at t (DF.frameDetail: {t, t_num, present[], fresh[], active, taken, phases}); the same object arriving by call and by event is applied once. */
      setTime(detail) {
        if (detail === st.timeDetail) return st.time;
        st.timeDetail = detail; st.time = built.setTime(detail); relabel(); return st.time;
      },
      hover(id) { st.hover = id && built.index.has(id) ? id : null; relabel(); },
      /** A 3D pick hands focus back to the shell (which owns state, time and view) by event only: writing the hash here would reset every other key when deep_link is off. */
      select(id) {
        if (doc && typeof doc.dispatchEvent === 'function') doc.dispatchEvent(new CustomEvent('dotfield:3d-select', { detail: { id } }));
      },
      dispose() { run(false); if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('dotfield:time', onTime); if (st.ro) st.ro.disconnect(); controls.dispose(); if (st.xrApi) st.xrApi.dispose(); built.dispose(); renderer.dispose(); canvas.remove(); },
    };
    return api;
  };
}
