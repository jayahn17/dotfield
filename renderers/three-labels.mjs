// renderers/three-labels.mjs — the 3D labels: one shared 2048² canvas atlas
// (one 256×32 slot per label, drawn in the theme's ink on its panel colour),
// one instanced plane mesh whose per-instance UV rect picks a slot, and the
// plan that decides which labels are drawn: focus, hover, the focus's reach,
// then the rest by weight, never more than the budget, never a hidden node.
// Headless (no document that can make a canvas) the plan still runs and the
// mesh draws nothing. Split out of three.mjs (V2_PLAN §11 three-4d); embedded
// by html.mjs under the importmap specifier dotfield/three-labels.
//   tokenValue(tokens, name) -> string | null
//   new LabelAtlas(THREE, doc, tokens)  .slot(id, text) .release(id) .uvRect(slot) .setTokens(tokens)
//   createLabels(THREE, {slots, index, budget, scaleM, tokens, doc, reachOf, weightOf}) -> {mesh, atlas, budget, width_m, plan, apply, setTokens, dispose}

export const ATLAS = Object.freeze({ size: 2048, slot_w: 256, slot_h: 32, font_px: 22, pad: 10 });
export const ATLAS_SLOTS = (ATLAS.size / ATLAS.slot_w) * (ATLAS.size / ATLAS.slot_h);

/** The resolved value of a --df-* token ('ink', 'df-ink' or '--df-ink'), trimmed; null when absent. */
export function tokenValue(tokens, name) {
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const k = name.startsWith('--') ? name : `--df-${name}`;
  const v = tokens[k] !== undefined ? tokens[k] : tokens[k.slice(5)];
  return typeof v === 'string' ? v.trim() : null;
}

/** The label atlas (browser only: needs a canvas). */
export class LabelAtlas {
  constructor(THREE, doc, tokens) {
    this.THREE = THREE; this.canvas = doc.createElement('canvas'); this.canvas.width = ATLAS.size; this.canvas.height = ATLAS.size;
    this.ctx = this.canvas.getContext('2d'); this.cols = ATLAS.size / ATLAS.slot_w; this.slots = new Map(); this.free = [];
    for (let i = ATLAS_SLOTS - 1; i >= 0; i -= 1) this.free.push(i);
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.anisotropy = 4;
    this.setTokens(tokens);
  }
  setTokens(tokens) {
    this.ink = tokenValue(tokens, 'ink') || 'white'; this.panel = tokenValue(tokens, 'panel') || 'black'; this.font = tokenValue(tokens, 'font-text') || 'sans-serif';
    for (const s of this.slots.values()) this.draw(s);
  }
  /** The slot an id's label occupies (allocated or redrawn on a text change); null when the atlas is full. */
  slot(id, text) {
    let s = this.slots.get(id);
    if (s && s.text === text) return s;
    if (!s) { if (!this.free.length) return null; s = { slot: this.free.pop(), text: '' }; this.slots.set(id, s); }
    s.text = text; this.draw(s); return s;
  }
  release(id) { const s = this.slots.get(id); if (s) { this.slots.delete(id); this.free.push(s.slot); } }
  draw(s) {
    const c = this.ctx; if (!c) return;
    const x = (s.slot % this.cols) * ATLAS.slot_w; const y = Math.floor(s.slot / this.cols) * ATLAS.slot_h; const { slot_w: w, slot_h: h, pad } = ATLAS;
    c.clearRect(x, y, w, h); c.font = `600 ${ATLAS.font_px}px ${this.font}`; c.textBaseline = 'middle';
    let text = String(s.text); while (text.length > 1 && c.measureText(text).width > w - 2 * pad) text = `${text.slice(0, -2)}…`;
    const tw = Math.min(w, Math.ceil(c.measureText(text).width) + 2 * pad); const left = x + (w - tw) / 2;
    c.globalAlpha = 0.86; c.fillStyle = this.panel; c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(left, y + 2, tw, h - 4, 6); else c.rect(left, y + 2, tw, h - 4);
    c.fill(); c.globalAlpha = 1; c.fillStyle = this.ink; c.textAlign = 'center'; c.fillText(text, x + w / 2, y + h / 2 + 1);
    this.texture.needsUpdate = true;
  }
  uvRect(s) { const col = s.slot % this.cols; const row = Math.floor(s.slot / this.cols); const z = ATLAS.size; return [(col * ATLAS.slot_w) / z, 1 - ((row + 1) * ATLAS.slot_h) / z, ATLAS.slot_w / z, ATLAS.slot_h / z]; }
}

/** Screen-facing quads: the instance matrix gives the centre and the size, the uvRect attribute the atlas slot. */
export function labelMaterial(THREE, texture) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, opacity: { value: 1 } }, transparent: true, depthWrite: false,
    vertexShader: 'attribute vec4 uvRect; varying vec2 vUv2;\nvoid main(){ vUv2 = uvRect.xy + uv * uvRect.zw; vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0); float s = length(vec3(instanceMatrix[0])); gl_Position = projectionMatrix * (c + vec4(position.xy * s, 0.0, 0.0)); }',
    fragmentShader: 'uniform sampler2D map; uniform float opacity; varying vec2 vUv2;\nvoid main(){ vec4 t = texture2D(map, vUv2); if (t.a < 0.02) discard; gl_FragColor = vec4(t.rgb, t.a * opacity);\n#include <colorspace_fragment>\n}',
  });
}

/**
 * The label layer of one built scene. `slots` are buildScene's node slots
 * ({id, node, pos, radius}), `index` id -> slot index, `reachOf(id)` the
 * one-hop reach. plan({focus, reach, hover, visible}) -> ids; apply(ids)
 * draws them (headless: draws nothing and returns the ids it would draw).
 */
export function createLabels(THREE, { slots, index, budget, scaleM, tokens, doc, reachOf, weightOf }) {
  let atlas = null;
  if (doc && typeof doc.createElement === 'function') { try { const a = new LabelAtlas(THREE, doc, tokens); if (a.ctx) atlas = a; } catch { atlas = null; } }
  const widthM = Math.max(0.12, 0.07 * scaleM); const geom = new THREE.PlaneGeometry(1, ATLAS.slot_h / ATLAS.slot_w);
  geom.setAttribute('uvRect', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, budget) * 4), 4));
  const mesh = new THREE.InstancedMesh(geom, labelMaterial(THREE, atlas ? atlas.texture : null), Math.max(1, budget));
  mesh.count = 0; mesh.name = 'labels'; mesh.frustumCulled = false; mesh.renderOrder = 2;
  const byWeight = slots.slice().sort((a, b) => weightOf(b.node) - weightOf(a.node) || a.i - b.i);
  const M = new THREE.Matrix4(); const Q = new THREE.Quaternion(); const V = new THREE.Vector3(); const S = new THREE.Vector3(widthM, widthM, 1);
  const plan = ({ focus = null, reach = null, hover = null, visible = null } = {}) => {
    const ok = (id) => id && index.has(id) && (!visible || visible.has(id)); const out = []; const seen = new Set();
    const push = (id) => { if (out.length < budget && ok(id) && !seen.has(id)) { seen.add(id); out.push(id); } };
    push(focus); push(hover);
    const r = reach instanceof Set ? reach : reachOf(focus); for (const s of byWeight) if (r.has(s.id)) push(s.id);
    for (const s of byWeight) push(s.id);
    return out;
  };
  const apply = (ids) => {
    const list = ids.filter((id) => index.has(id)).slice(0, budget);
    if (!atlas) { mesh.count = 0; return list; }
    const keep = new Set(list); for (const id of Array.from(atlas.slots.keys())) if (!keep.has(id)) atlas.release(id);
    const uv = geom.attributes.uvRect; let k = 0;
    for (const id of list) {
      const s = slots[index.get(id)]; const slot = atlas.slot(id, String(s.node.label ?? id)); if (!slot) continue;
      uv.array.set(atlas.uvRect(slot), k * 4); V.set(s.pos[0], s.pos[1] + s.radius * 1.3 + widthM / 16, s.pos[2]); M.compose(V, Q, S); mesh.setMatrixAt(k, M); k += 1;
    }
    mesh.count = k; uv.needsUpdate = true; mesh.instanceMatrix.needsUpdate = true; return list;
  };
  return {
    mesh, atlas, budget, width_m: widthM, plan, apply,
    setTokens(next) { if (atlas) atlas.setTokens(next); },
    dispose() { geom.dispose(); mesh.material.dispose(); if (atlas) atlas.texture.dispose(); },
  };
}
