// renderers/xr.mjs — VR is the 3D scene of renderers/three.mjs with renderer.xr
// enabled: the same built group, scaled by views.vr.scale_m / views.3d.scale_m and
// raised onto the floor (frame.vrFrame's transform, applied to the whole group), a
// floor disc at views.vr.floor_y, two controller rays (select -> focus, squeeze ->
// grab the scene, select on the floor -> teleport), snap turn on either thumbstick
// by views.vr.snap_turn_deg (0 disables; one turn per push, about the head), a
// comfort fade on every teleport and turn (instant under reduced motion), and an
// honest overlay when this browser cannot start an immersive-vr session. Embedded
// by html.mjs as a data: URL: its only import is the vendored XRButton addon, which
// a fork may choose with {button: 'addon'} (that button prefers immersive-ar when a
// device offers both; the default button is VR-only and testable without a DOM).
//   xrSupport(nav, {secure}) -> 'supported' | 'unsupported' | 'blocked' | 'insecure'
//   createVrSession({renderer, nav, doc, ...}) -> machine {state, button, ready, enter, exit, on, dispose}
//   createSnapTurn({deg, press, release}) -> {deg, sample(x) -> -1 | 0 | 1}    snapRig(rig, head, radians)    stickX(gamepad)
//   enableXr({THREE, renderer, world, camera, rig, controls, built, host, ...}) -> api {place, leave, teleport, snapTurn, setTokens, update, dispose}
import { XRButton } from 'three/addons/webxr/XRButton.js';

export { XRButton };
export const MODE = 'immersive-vr';
export const SESSION_INIT = Object.freeze({ optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] });
export const STATES = Object.freeze(['checking', 'ready', 'starting', 'presenting', 'unsupported', 'blocked', 'insecure', 'error']);
export const BUTTON_TEXT = Object.freeze({ checking: 'CHECKING VR…', ready: 'ENTER VR', starting: 'STARTING VR…', presenting: 'EXIT VR', unsupported: 'VR NOT SUPPORTED', blocked: 'VR NOT ALLOWED', insecure: 'VR NEEDS A SECURE PAGE', error: 'VR ERROR — RETRY' });
export const SNAP = Object.freeze({ press: 0.75, release: 0.25, fade_ms: 140, allowed: Object.freeze([0, 30, 45, 90]), default_deg: 45 });
const TAIL = ' The 2D and 3D views are complete without it.';
export const OVERLAY = Object.freeze({
  checking: 'Checking whether this browser can start WebXR immersive-vr…',
  ready: '', starting: '', presenting: '',
  unsupported: `WebXR immersive-vr is not available in this browser. Open this file on a headset browser (Quest) or a WebXR-enabled desktop browser.${TAIL}`,
  blocked: `WebXR is present but this page is not allowed to start an immersive session (a permission or policy refused it).${TAIL}`,
  insecure: `WebXR needs a secure context: open this page over https or from 127.0.0.1, not from an insecure origin.${TAIL}`,
  error: (detail) => `The VR session could not start${detail ? `: ${detail}` : ''}. Try again from the headset browser.${TAIL}`,
});
/** The overlay sentence for a session state ('' when nothing needs saying). */
export function overlayText(state, detail) { const v = OVERLAY[state]; return typeof v === 'function' ? v(detail) : (v || ''); }
export const buttonText = (state) => BUTTON_TEXT[state] || BUTTON_TEXT.unsupported;

/** What navigator.xr says about immersive-vr, as one of four honest words. */
export async function xrSupport(nav, { secure = true } = {}) {
  if (secure === false) return 'insecure';
  if (!nav || !nav.xr || typeof nav.xr.isSessionSupported !== 'function') return 'unsupported';
  try { return (await nav.xr.isSessionSupported(MODE)) ? 'supported' : 'unsupported'; } catch { return 'blocked'; }
}

/**
 * The VR-only session machine behind the button and the overlay:
 * checking -> ready | unsupported | blocked | insecure; ready -> starting ->
 * presenting -> ready (on end); a failed start -> error -> (retry) starting.
 * Pure given (renderer.xr.setSession, nav, doc): tests drive it with stubs.
 */
export function createVrSession({ renderer, nav, doc, secure = true, sessionInit = SESSION_INIT, button = 'own', onState = null } = {}) {
  const listeners = new Set(); if (typeof onState === 'function') listeners.add(onState);
  const m = { state: 'checking', detail: null, session: null, button: null, listeners };
  m.on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  m.set = (state, detail = null) => {
    m.state = state; m.detail = detail;
    if (m.button && button === 'own') { m.button.textContent = buttonText(state); m.button.disabled = state === 'checking' || state === 'starting'; m.button.hidden = !['ready', 'starting', 'presenting', 'error'].includes(state); m.button.setAttribute('data-xr-state', state); }
    for (const fn of Array.from(listeners)) { try { fn(state, detail, m); } catch { /* a listener must not break the machine */ } }
    return state;
  };
  const onEnd = () => { if (m.session) { try { m.session.removeEventListener('end', onEnd); } catch { /* stub sessions */ } } m.session = null; m.set('ready'); };
  m.enter = async () => {
    if (m.state !== 'ready' && m.state !== 'error') return m.state;
    m.set('starting');
    try {
      const session = await nav.xr.requestSession(MODE, sessionInit);
      session.addEventListener('end', onEnd); m.session = session;
      await renderer.xr.setSession(session);
      return m.set('presenting');
    } catch (e) { m.session = null; return m.set('error', e && e.message ? e.message : String(e)); }
  };
  m.exit = async () => { if (m.session) { try { await m.session.end(); } catch { onEnd(); } } return m.state; };
  if (button === 'addon') {
    m.button = XRButton.createButton(renderer, { ...sessionInit }); m.button.classList.add('df-btn', 'df-xr');
    if (renderer.xr && typeof renderer.xr.addEventListener === 'function') { renderer.xr.addEventListener('sessionstart', () => m.set('presenting')); renderer.xr.addEventListener('sessionend', () => m.set('ready')); }
  } else if (doc && typeof doc.createElement === 'function') {
    m.button = doc.createElement('button'); m.button.type = 'button'; m.button.className = 'df-btn df-xr'; m.button.setAttribute('data-df', 'xr-enter');
    m.button.addEventListener('click', () => { if (m.state === 'presenting') m.exit(); else m.enter(); });
  }
  m.set('checking');
  m.ready = xrSupport(nav, { secure }).then((s) => m.set(s === 'supported' ? 'ready' : s));
  m.dispose = () => { listeners.clear(); if (m.session) m.exit(); if (m.button && m.button.remove) m.button.remove(); };
  return m;
}

/** One turn per thumbstick push: past `press` it fires once (-1 left, 1 right) and stays latched until the stick falls back under `release`; deg 0 never fires. */
export function createSnapTurn({ deg = SNAP.default_deg, press = SNAP.press, release = SNAP.release } = {}) {
  const st = { deg: SNAP.allowed.includes(deg) ? deg : SNAP.default_deg, latched: false };
  st.sample = (x) => {
    const v = typeof x === 'number' && Number.isFinite(x) ? x : 0;
    if (st.latched) { if (Math.abs(v) <= release) st.latched = false; return 0; }
    if (st.deg === 0 || Math.abs(v) < press) return 0;
    st.latched = true; return v > 0 ? 1 : -1;
  };
  return st;
}
/** The thumbstick x of an xr-standard gamepad (axes[2]; axes[0] on a two-axis pad), else 0. */
export const stickX = (gamepad) => { const a = gamepad && Array.isArray(gamepad.axes) ? gamepad.axes : (gamepad && gamepad.axes ? Array.from(gamepad.axes) : []); const v = a.length >= 4 ? a[2] : a[0]; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
/** Yaw the rig by `radians` about the vertical line through `head` (world x/z), so the viewer turns in place. */
export function snapRig(rig, head, radians) {
  const c = Math.cos(radians); const s = Math.sin(radians); const dx = rig.position.x - head.x; const dz = rig.position.z - head.z;
  rig.position.x = head.x + dx * c + dz * s; rig.position.z = head.z - dx * s + dz * c; rig.rotation.y += radians;
  return rig;
}

/** The floor: a disc at floor_y with metre rings, plus the teleport marker; all colours from tokens. */
export function buildFloor(THREE, placement, color) {
  const g = new THREE.Group(); g.name = 'floor';
  const R = Math.max(2.5, placement.scale_m * 0.9);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ color: color('panel').color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2; disc.name = 'floor-disc'; disc.userData.teleportable = true; disc.renderOrder = -2; g.add(disc);
  const pts = []; for (let r = 1; r <= R; r += 1) for (let i = 0; i < 64; i += 1) { const a = (i / 64) * Math.PI * 2; const b = ((i + 1) / 64) * Math.PI * 2; pts.push(r * Math.cos(a), 0.002, r * Math.sin(a), r * Math.cos(b), 0.002, r * Math.sin(b)); }
  const rings = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.LineBasicMaterial({ color: color('line-strong').color, transparent: true, opacity: 0.6 }));
  rings.name = 'floor-rings'; g.add(rings);
  const marker = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.025, 8, 32), new THREE.MeshBasicMaterial({ color: color('accent').color, transparent: true, opacity: 0.9, depthWrite: false }));
  marker.rotation.x = -Math.PI / 2; marker.visible = false; marker.name = 'teleport-marker'; g.add(marker);
  g.position.y = placement.floor_y;
  g.userData = { disc, rings, marker, recolor: (c) => { disc.material.color.copy(c('panel').color); rings.material.color.copy(c('line-strong').color); marker.material.color.copy(c('accent').color); } };
  return g;
}

/**
 * Turn a mounted 3D view into the VR view. Called once by three.mjs when the
 * VR tab is first shown; place()/leave() follow the tab, enter()/exit() the
 * session. Nothing here fetches, stores or reaches outside the host element.
 */
export function enableXr({ THREE, renderer, world, camera, rig, controls, built, host, document: doc = globalThis.document, navigator: nav = globalThis.navigator, window: win = globalThis.window, reduced = false, color, onSelect = null, button = 'own', sessionInit = SESSION_INIT } = {}) {
  if (!THREE || !renderer || !world || !built) throw new Error('enableXr needs THREE, renderer, world and the built scene');
  const placement = built.placement; const col = typeof color === 'function' ? color : () => ({ color: new THREE.Color(0.5, 0.5, 0.5), alpha: 1 });
  renderer.xr.enabled = true; if (typeof renderer.xr.setReferenceSpaceType === 'function') renderer.xr.setReferenceSpaceType('local-floor');
  const floor = buildFloor(THREE, placement, col); floor.visible = false; world.add(floor);
  const overlay = host && typeof host.querySelector === 'function' ? host.querySelector('[data-overlay]') : null;
  const secure = !win || win.isSecureContext !== false;
  const machine = createVrSession({ renderer, nav, doc, secure, sessionInit, button });
  if (machine.button && host && typeof host.append === 'function') host.append(machine.button);
  machine.on((state, detail) => { if (overlay) { const t = overlayText(state, detail); overlay.textContent = t; overlay.hidden = !t; } if (state === 'presenting' || (state === 'ready' && floor.visible)) api.place(); });
  // controllers: a ray each; select picks a node (focus) or the floor (teleport); squeeze grabs the whole scene
  const raycaster = new THREE.Raycaster(); const tmp = new THREE.Matrix4(); const pickables = [...built.solid.values(), ...built.proposal.values()];
  const rayGeom = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
  const controllers = [0, 1].map((i) => {
    const c = renderer.xr.getController(i); c.name = `controller-${i}`;
    const ray = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ color: col('accent').color, transparent: true, opacity: 0.8 })); ray.name = 'ray'; ray.scale.z = 4; c.add(ray);
    c.userData = { ray, hit: null, grabbing: false, source: null, snap: createSnapTurn({ deg: placement.snap_turn_deg }) };
    c.addEventListener('connected', (ev) => { c.userData.source = ev && ev.data ? ev.data : null; });
    c.addEventListener('disconnected', () => { c.userData.source = null; });
    c.addEventListener('selectstart', () => { const hit = cast(c); if (hit.id) { if (typeof onSelect === 'function') onSelect(hit.id); } else if (hit.floor) api.teleport(hit.floor); });
    c.addEventListener('squeezestart', () => { if (controllers.some((o) => o.userData.grabbing)) return; c.userData.grabbing = true; c.attach(built.group); });
    c.addEventListener('squeezeend', () => { if (!c.userData.grabbing) return; c.userData.grabbing = false; world.attach(built.group); });
    rig.add(c); return c;
  });
  const cast = (c) => {
    tmp.identity().extractRotation(c.matrixWorld); raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld); raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmp);
    const node = raycaster.intersectObjects(pickables, false)[0];
    if (node && node.object.userData.ids) return { id: node.object.userData.ids[node.instanceId], floor: null, distance: node.distance };
    const f = floor.visible ? raycaster.intersectObject(floor.userData.disc, false)[0] : null;
    return { id: null, floor: f ? f.point : null, distance: f ? f.distance : 4 };
  };
  // a brief blink softens a teleport; reduced motion keeps the cut instant
  const blink = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshBasicMaterial({ color: col('bg').color, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  blink.name = 'blink'; blink.renderOrder = 99; blink.visible = false; camera.add(blink);
  const saved = { target: controls && controls.target ? controls.target.clone() : null, position: camera.position.clone(), placed: false, blinkUntil: 0 };
  const now = () => (win && win.performance && typeof win.performance.now === 'function' ? win.performance.now() : 0);
  const fade = () => { if (!reduced) { blink.visible = true; blink.material.opacity = 1; saved.blinkUntil = now() + SNAP.fade_ms; } };
  const head = new THREE.Vector3();
  const entryPoint = () => { const id = placement.entry_node && built.index.has(placement.entry_node) ? placement.entry_node : built.ids[0]; const p = id ? built.positions[id] : [0, 0, 0]; return [p[0] * placement.k, p[1] * placement.k + placement.y0, p[2] * placement.k]; };
  const api = {
    machine, placement, floor, controllers, rig, blink, state: () => machine.state, enter: () => machine.enter(), exit: () => machine.exit(),
    /**
     * Apply the VR transform: scale the group by k, lift it to y0, show the
     * floor, stand the viewer in front of the entry node. While a session is
     * presenting the rig carries the headset there; on the desktop preview
     * the rig stays at the origin (OrbitControls works in world space) and
     * the camera is framed on the entry node at eye height instead.
     */
    place() {
      built.group.scale.setScalar(placement.k); built.group.position.set(0, placement.y0, 0); floor.visible = true; built.group.updateMatrixWorld(true);
      const e = entryPoint(); const back = Math.max(1.5, placement.scale_m * 0.35); rig.rotation.set(0, 0, 0);
      if (!saved.placed) { saved.target = controls && controls.target ? controls.target.clone() : saved.target; saved.position = camera.position.clone(); saved.placed = true; }
      if (renderer.xr.isPresenting) { rig.position.set(e[0], placement.floor_y, e[2] + back); return placement; }
      rig.position.set(0, 0, 0); camera.position.set(e[0], placement.floor_y + placement.eye_height_m, e[2] + back);
      if (controls && controls.target) { controls.target.set(e[0], e[1], e[2]); if (typeof controls.update === 'function') controls.update(); }
      return placement;
    },
    /** Back to the 3D framing: identity transform, floor hidden, the session ended if one is running. */
    leave() {
      if (machine.state === 'presenting') machine.exit();
      for (const c of controllers) if (c.userData.grabbing) { c.userData.grabbing = false; world.attach(built.group); }
      built.group.scale.setScalar(1); built.group.position.set(0, 0, 0); built.group.rotation.set(0, 0, 0); floor.visible = false; floor.userData.marker.visible = false; rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
      if (saved.placed) { if (controls && controls.target && saved.target) controls.target.copy(saved.target); camera.position.copy(saved.position); if (controls && typeof controls.update === 'function') controls.update(); saved.placed = false; }
      built.group.updateMatrixWorld(true);
    },
    /** Move the rig so the viewer stands on `point` (world x/z; y stays the floor). */
    teleport(point) {
      const x = typeof point.x === 'number' ? point.x : 0; const z = typeof point.z === 'number' ? point.z : 0;
      rig.position.set(x, placement.floor_y, z); fade();
      return rig.position;
    },
    /** Turn in place by one snap (dir 1 = right, -1 = left) about the head; returns the yaw applied in radians (0 when snap turn is off). */
    snapTurn(dir) {
      const deg = SNAP.allowed.includes(placement.snap_turn_deg) ? placement.snap_turn_deg : SNAP.default_deg;
      if (!deg || !dir) return 0;
      camera.updateMatrixWorld(true); camera.getWorldPosition(head); const r = (dir > 0 ? -1 : 1) * (deg * Math.PI) / 180;
      snapRig(rig, head, r); fade(); return r;
    },
    setTokens() { floor.userData.recolor(col); for (const c of controllers) c.userData.ray.material.color.copy(col('accent').color); blink.material.color.copy(col('bg').color); },
    /** Per frame from three-mount.mjs: snap turn from the thumbsticks, the teleport marker under a floor hit, the comfort fade. */
    update(time = now()) {
      const marker = floor.userData.marker; let shown = false;
      if (renderer.xr.isPresenting) for (const c of controllers) { const s = c.userData.source; const d = c.userData.snap.sample(stickX(s && s.gamepad)); if (d) api.snapTurn(d); }
      if (floor.visible && renderer.xr.isPresenting) for (const c of controllers) { const hit = cast(c); c.userData.ray.scale.z = Math.max(0.2, Math.min(hit.distance, 8)); if (hit.floor && !shown) { marker.position.set(hit.floor.x, 0.01, hit.floor.z); shown = true; } }
      marker.visible = shown;
      if (blink.visible) { const left = saved.blinkUntil - time; blink.material.opacity = Math.max(0, Math.min(1, left / SNAP.fade_ms)); if (left <= 0) blink.visible = false; }
    },
    dispose() { api.leave(); machine.dispose(); for (const c of controllers) rig.remove(c); world.remove(floor); camera.remove(blink); rayGeom.dispose(); for (const o of floor.children) { o.geometry.dispose(); o.material.dispose(); } blink.geometry.dispose(); blink.material.dispose(); renderer.xr.enabled = false; },
  };
  return api;
}
export default enableXr;
