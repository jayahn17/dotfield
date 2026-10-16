// Gate "privacy": the DF_PRIVACY_* family plus DF_RENDER_UNPROJECTED (the
// HMAC stamp). Pure over (scene, ctx); never throws. The stamp formula lives
// here once so lib/project.mjs writes exactly what this gate verifies:
//
//   stampInput(scene) = canonical(scene minus projected and receipt)
//   stamp(scene, key) = hmac-sha256(key, stampInput(scene))
//
//   check(scene, ctx) -> check[]
//   ctx.viewer            who receives the render: 'self' | '<person_id>' |
//                         {person_id, mode?, rule_refs?}; defaults to scene.viewer
//   ctx.config            center.config.json; center.owner_person_id names the owner
//                         ('self' is always the owner)
//   ctx.rooms             discovered rooms (array, map or Map of manifests); when
//                         given, node.fields is checked against record.public_fields
//   ctx.sessionKey        data/keys/session.key content (string or bytes)
//   ctx.requireProjected  true -> DF_RENDER_UNPROJECTED is evaluated
import { HMAC_RE, canonical, hmac } from '../digest.mjs';
import { ABSOLUTE_PATH_RE, codesForFamily, fail, pass } from '../rules.mjs';
import { NEVER_LEAVES_SET } from '../privacy-levels.mjs';

export const id = 'privacy';
export const STAMP_EXCLUDED = Object.freeze(['projected', 'receipt']);
export const KEY_MATERIAL_KEYS = Object.freeze(['private_key', 'secret_key', 'session_key', 'owner_token', 'salt', 'handle_salt', 'seed_phrase', 'passphrase', 'api_key']);
export const HANDLE_KEYS = Object.freeze(['handle', 'handles']);
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEYS_DIR_RE = /(^|\/)data\/keys\//;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function list(v) { return Array.isArray(v) ? v : []; }
function child(path, key) { return IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`; }

/** canonical(scene minus projected and receipt): what the stamp signs. */
export function stampInput(scene) {
  const copy = {};
  for (const [k, v] of Object.entries(isObject(scene) ? scene : {})) if (!STAMP_EXCLUDED.includes(k)) copy[k] = v;
  return canonical(copy);
}

/** The projected stamp for `scene` under the session key. */
export function stamp(scene, key) {
  return hmac(key, stampInput(scene));
}

/** Does scene.projected.mac verify under `key`? false when either is missing. */
export function verifyStamp(scene, key) {
  if (!keyUsable(key) || !isObject(scene) || !isObject(scene.projected) || typeof scene.projected.mac !== 'string') return false;
  return scene.projected.mac === stamp(scene, key);
}

function keyUsable(key) {
  return (typeof key === 'string' && key.length > 0) || (key instanceof Uint8Array && key.length > 0);
}

/** Owner id from the config; 'self' is always the owner. */
export function ownerIdOf(ctx) {
  const c = ctx && isObject(ctx.config) && isObject(ctx.config.center) ? ctx.config.center.owner_person_id : undefined;
  return typeof c === 'string' && c ? c : 'self';
}

/** {person_id, mode, rule_refs} for whoever receives the render. */
export function resolveViewer(scene, ctx = {}) {
  const ownerId = ownerIdOf(ctx);
  const own = (pid) => pid === 'self' || pid === ownerId;
  const fromScene = isObject(scene) && isObject(scene.viewer) ? scene.viewer : null;
  const raw = ctx ? ctx.viewer : undefined;
  let v = null;
  if (typeof raw === 'string' && raw) v = { person_id: raw };
  else if (isObject(raw)) v = { ...raw };
  else if (fromScene) v = { ...fromScene };
  else v = { person_id: 'self' };
  if (typeof v.person_id !== 'string' || !v.person_id) v.person_id = 'self';
  if (!['self', 'person', 'public'].includes(v.mode)) v.mode = own(v.person_id) ? 'self' : 'person';
  if (v.mode === 'self' && !own(v.person_id)) v.mode = 'person';
  v.rule_refs = list(v.rule_refs).filter((r) => typeof r === 'string');
  if (fromScene && v.person_id === fromScene.person_id && !v.rule_refs.length) v.rule_refs = list(fromScene.rule_refs).filter((r) => typeof r === 'string');
  return v;
}

/** May `viewer` see `node`? {ok, reason}. The owner (mode self) sees everything. */
export function visibleTo(node, viewer, ownerId = 'self') {
  if (viewer.mode === 'self') return { ok: true, reason: 'self' };
  const level = isObject(node.audience) ? node.audience.privacy_level : undefined;
  if (NEVER_LEAVES_SET.has(level)) return { ok: false, reason: 'privacy_level blocked never leaves' };
  if (level === 'public') return { ok: true, reason: 'public' };
  if (viewer.mode === 'public') return { ok: false, reason: `privacy_level ${String(level)} with no session` };
  const owner = isObject(node.provenance) ? node.provenance.owner_person_id : undefined;
  if (owner === viewer.person_id) return { ok: true, reason: 'own node' };
  const own = (pid) => pid === 'self' || pid === ownerId;
  const ruleIds = new Set(list(isObject(node.audience) ? node.audience.share_rule_ids : []));
  for (const ref of viewer.rule_refs) {
    const slash = ref.indexOf('/');
    if (slash < 1) continue;
    const grantor = ref.slice(0, slash);
    const ruleId = ref.slice(slash + 1);
    if (ruleIds.has(ruleId) && (grantor === owner || (own(grantor) && own(owner)))) return { ok: true, reason: `rule ${ref}` };
  }
  return { ok: false, reason: `privacy_level ${String(level)} and no rule in viewer.rule_refs grants it` };
}

/** Public-field ceilings per room id from ctx.rooms (array, object map or Map). */
export function publicFieldsIndex(rooms) {
  const out = new Map();
  const add = (key, room) => {
    if (!isObject(room)) return;
    const rid = typeof room.id === 'string' ? room.id : key;
    const rec = isObject(room.record) ? room.record : room;
    if (typeof rid === 'string' && Array.isArray(rec.public_fields)) out.set(rid, new Set(rec.public_fields.filter((f) => typeof f === 'string')));
  };
  if (rooms instanceof Map) for (const [k, r] of rooms) add(k, r);
  else if (Array.isArray(rooms)) for (const r of rooms) add(undefined, r);
  else if (isObject(rooms)) {
    if (Array.isArray(rooms.rooms)) return publicFieldsIndex(rooms.rooms);
    for (const [k, r] of Object.entries(rooms)) add(k, r);
  }
  return out;
}

/** Walk every key and string value: fn(path, key, value). */
function walkStrings(value, fn, path = '$') {
  if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, fn, `${path}[${i}]`));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = child(path, k);
      fn(p, k, v);
      walkStrings(v, fn, p);
    }
  }
}

function checkStrings(scene, F) {
  walkStrings(scene, (path, key, value) => {
    const lower = key.toLowerCase();
    if (KEY_MATERIAL_KEYS.includes(lower)) F('DF_PRIVACY_KEY_MATERIAL', path, `a key named '${key}'`);
    if (HANDLE_KEYS.includes(lower)) F('DF_PRIVACY_HANDLE_PRESENT', path, `a key named '${key}'`);
    if (ABSOLUTE_PATH_RE.test(key)) F('DF_PRIVACY_ABSOLUTE_PATH', path, `key ${JSON.stringify(key.slice(0, 60))}`);
    if (typeof value !== 'string') return;
    if (ABSOLUTE_PATH_RE.test(value)) F('DF_PRIVACY_ABSOLUTE_PATH', path, JSON.stringify(value.slice(0, 60)));
    if (PEM_RE.test(value)) F('DF_PRIVACY_KEY_MATERIAL', path, 'a PEM private key block');
    if (KEYS_DIR_RE.test(value)) F('DF_PRIVACY_KEY_MATERIAL', path, `a reference into data/keys/ (${JSON.stringify(value.slice(0, 60))})`);
    if (HMAC_RE.test(value) && path !== '$.projected.mac') F('DF_PRIVACY_HANDLE_PRESENT', path, 'an hmac-sha256 value outside projected.mac (handles are HMACs and never leave)');
  });
}

function checkNodes(scene, ctx, F, viewer, ownerId) {
  const own = (pid) => pid === 'self' || pid === ownerId;
  const ceilings = ctx && ctx.rooms !== undefined && ctx.rooms !== null ? publicFieldsIndex(ctx.rooms) : null;
  if (isObject(scene.projected) && typeof scene.projected.viewer === 'string' && scene.projected.viewer !== viewer.person_id) {
    F('DF_PRIVACY_VIEWER_EXCLUDED', '$.projected.viewer', `the stamp names '${scene.projected.viewer}' but the render is for '${viewer.person_id}'`);
  }
  if (isObject(scene.viewer) && typeof scene.viewer.person_id === 'string' && scene.viewer.person_id !== viewer.person_id) {
    F('DF_PRIVACY_VIEWER_EXCLUDED', '$.viewer', `the scene was projected for '${scene.viewer.person_id}' but the render is for '${viewer.person_id}'`);
  }
  list(scene.nodes).forEach((n, i) => {
    if (!isObject(n)) return;
    const p = `$.nodes[${i}]`;
    const seen = visibleTo(n, viewer, ownerId);
    if (!seen.ok) F('DF_PRIVACY_VIEWER_EXCLUDED', p, `'${String(n.id)}': ${seen.reason}`);
    const prov = isObject(n.provenance) ? n.provenance : {};
    const foreign = typeof prov.owner_person_id === 'string' && !own(prov.owner_person_id);
    const hasFields = isObject(n.fields) && Object.keys(n.fields).length > 0;
    if (foreign && hasFields && typeof prov.imported_via_rule_ref !== 'string') {
      F('DF_PRIVACY_FOREIGN_BODY_WITHOUT_RULE', `${p}.fields`, `'${String(n.id)}' is owned by '${prov.owner_person_id}' and carries fields without provenance.imported_via_rule_ref`);
    }
    if (ceilings && !foreign && hasFields && typeof n.room === 'string' && ceilings.has(n.room)) {
      const allowed = ceilings.get(n.room);
      for (const k of Object.keys(n.fields)) if (!allowed.has(k)) F('DF_PRIVACY_FIELD_NOT_PUBLIC', child(`${p}.fields`, k), `'${k}' is not in room '${n.room}' public_fields (${[...allowed].join(', ') || 'none'})`);
    }
  });
}

/** Taint: a local node that reaches a boundary stub must list every origin rule in derived_from. */
function checkTaint(scene, F, ownerId) {
  const own = (pid) => pid === 'self' || pid === ownerId;
  const nodes = list(scene.nodes).filter(isObject);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stubs = nodes.filter((n) => n.kind === 'boundary' && isObject(n.provenance) && !own(n.provenance.owner_person_id));
  if (!stubs.length) return;
  const stubIds = new Set(stubs.map((s) => s.id));
  const originOf = (s) => {
    const b = isObject(s.boundary) ? s.boundary : {};
    return { person_id: b.shared_by ?? s.provenance.owner_person_id, rule_ref: b.rule_ref ?? s.provenance.imported_via_rule_ref ?? null, stub: s.id };
  };
  const evidenceOrigins = new Map();
  for (const s of stubs) for (const ev of list(s.evidence_ids)) {
    if (!evidenceOrigins.has(ev)) evidenceOrigins.set(ev, []);
    evidenceOrigins.get(ev).push(originOf(s));
  }
  const edgeOrigins = new Map();
  for (const e of list(scene.edges).filter(isObject)) {
    for (const [me, other] of [[e.from, e.to], [e.to, e.from]]) {
      const s = stubIds.has(other) ? byId.get(other) : undefined;
      if (!s) continue;
      const n = byId.get(me);
      if (!n) continue;
      const viaRun = isObject(n.provenance) && isObject(n.provenance.source) && n.provenance.source.kind === 'run';
      const viaAnnotation = e.kind === 'annotates' && e.from === me;
      if (!viaRun && !viaAnnotation) continue;
      if (!edgeOrigins.has(me)) edgeOrigins.set(me, []);
      edgeOrigins.get(me).push(originOf(s));
    }
  }
  nodes.forEach((n, i) => {
    if (stubIds.has(n.id) || !isObject(n.provenance) || !own(n.provenance.owner_person_id)) return;
    const origins = [...(edgeOrigins.get(n.id) ?? [])];
    for (const ev of list(n.evidence_ids)) origins.push(...(evidenceOrigins.get(ev) ?? []));
    if (!origins.length) return;
    const derived = list(n.provenance.derived_from).filter(isObject);
    const p = `$.nodes[${i}].provenance.derived_from`;
    if (!derived.length) { F('DF_PRIVACY_DERIVED_UNTAINTED', p, `'${String(n.id)}' reaches boundary stub '${origins[0].stub}' (rule ${origins[0].rule_ref}) and lists no origin`); return; }
    const missing = [...new Set(origins.map((o) => o.rule_ref).filter((r) => typeof r === 'string'))].filter((r) => !derived.some((d) => d.rule_ref === r));
    if (missing.length) F('DF_PRIVACY_DERIVED_UNTAINTED', p, `'${String(n.id)}' omits origin rule${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
  });
}

function checkStamp(scene, ctx, F) {
  if (!isObject(scene.projected)) { F('DF_RENDER_UNPROJECTED', '$.projected', 'no projected block'); return; }
  if (!keyUsable(ctx.sessionKey)) { F('DF_RENDER_UNPROJECTED', '$.projected.mac', 'no session key to verify the stamp against (ctx.sessionKey)'); return; }
  if (typeof scene.projected.mac !== 'string') { F('DF_RENDER_UNPROJECTED', '$.projected.mac', 'no mac'); return; }
  if (!verifyStamp(scene, ctx.sessionKey)) F('DF_RENDER_UNPROJECTED', '$.projected.mac', 'the HMAC does not verify against canonical(scene minus projected and receipt)');
}

/** Gate entry. */
export function check(scene, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  const fails = new Map();
  const F = (code, path, detail) => {
    if (!fails.has(code)) fails.set(code, []);
    fails.get(code).push(fail(code, { path, detail }));
  };
  const codes = [...codesForFamily('privacy')];
  if (c.requireProjected) codes.push('DF_RENDER_UNPROJECTED');
  try {
    const s = isObject(scene) ? scene : {};
    const ownerId = ownerIdOf(c);
    const viewer = resolveViewer(s, c);
    checkStrings(s, F);
    checkNodes(s, c, F, viewer, ownerId);
    checkTaint(s, F, ownerId);
    if (c.requireProjected) checkStamp(s, c, F);
  } catch (e) {
    // Unreachable by design (every input shape is guarded); reported, never thrown.
    F('DF_PRIVACY_VIEWER_EXCLUDED', '$', `privacy gate stopped: ${e && e.message ? e.message : String(e)}`);
  }
  const out = [];
  for (const code of codes) {
    if (fails.has(code)) out.push(...fails.get(code));
    else out.push(pass(code));
  }
  return out;
}
