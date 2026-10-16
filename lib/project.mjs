// THE exit door (VISION §2.6, §4, §5, §7.3): the only module that reads a
// store and serialises nodes. readRecords() filters records by viewer
// (public_fields only unless self, fields_allowed under a grant); project()
// turns them through views.json (the JSONPath subset of lib/rooms.mjs) into
// one scene with provenance, audience, the three dates, link-field edges,
// group_by groups with hashed series tokens, imported overlays merged as
// foreign boundary nodes (expired ones dropped), transitive taint, a bounded
// subgraph with projected.dropped, and the HMAC stamp under the session key.
// The owner is a receiver too: `--for self` goes through the same door.
import { canonical, sha256, sha256Hex } from './digest.mjs';
import { stamp, visibleTo } from './gates/privacy.mjs';
import { computeTaint, liveOverlayNodes, originGrants, readOverlays } from './overlay.mjs';
import { engineVersion, isoSeconds } from './receipt.mjs';
import { evalPath } from './rooms.mjs';
import { fail } from './rules.mjs';
import { ownerPersonId, sanitizeId } from './scope.mjs';
import { evaluate, findRoom, isActive, manifestOf, receives, redactFields, ruleRef, selects, stubLabel, today } from './share.mjs';
import { createStore, isStoreError } from './store.mjs';
import { isDate } from './validate.mjs';

export const ENGINE = 'lib/project.mjs';
export const DEFAULT_MAX_NODES = 2000;
export const LAYOUT_2D = Object.freeze({ graph: 'force', room: 'metric', timeline: 'timeline', board: 'lanes', workflow: 'grid', meet: 'lanes' });
export const LAYOUT_3D = Object.freeze({ room: 'metric', timeline: 'tier-wall' });
const OVERLAY_KINDS = new Set(['graph', 'meet']);
const NODE_KIND_RE = /^(record|note|person|desk|tag|file|asset|event|place|boundary|annotation|idea|x-[a-z0-9][a-z0-9-]{0,30})$/;
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => { const cs = [...String(s)]; return cs.length > n ? cs.slice(0, n).join('') : cs.join(''); };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

export function nodeIdFor(roomId, recordId, fallback = 'r') { return `${roomId}-${sanitizeId(recordId) || fallback}`.slice(0, 80); }
/** A deterministic series token for a group id: sha256 over series-1..6. */
export function seriesToken(id) { return `series-${(parseInt(sha256Hex(String(id)).slice(0, 2), 16) % 6) + 1}`; }
/** {person_id, mode}: the owner id or 'self' -> self; 'public' -> public; anything else -> person. */
export function viewerSpec(viewer, config = null) {
  const owner = ownerPersonId(config);
  const raw = isObject(viewer) ? viewer.person_id : viewer;
  const id = typeof raw === 'string' && raw ? raw : 'self';
  if (id === 'self' || id === owner) return { person_id: 'self', mode: 'self' };
  return id === 'public' ? { person_id: 'public', mode: 'public' } : { person_id: id, mode: 'person' };
}
export function recordLevel(manifest, record) {
  const own = record && typeof record.privacy_level === 'string' ? record.privacy_level : null;
  return ['public', 'private', 'sensitive', 'blocked'].includes(own) ? own : (manifest.record && manifest.record.default_privacy_level) || 'private';
}
function scalar(v) { if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return typeof v === 'string' ? clip(v, 1024) : v; return clip(canonical(v), 1024); }
function fieldValue(v) { return Array.isArray(v) ? v.slice(0, 64).map((x) => scalar(x)) : scalar(v); }
function asTags(v) { return list(Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((t) => typeof t === 'string' && t.length).map((t) => clip(t, 40)).slice(0, 32); }
function pickFields(record, keys) { const out = {}; for (const k of list(keys)) if (Object.hasOwn(record, k) && record[k] !== undefined) out[k] = fieldValue(record[k]); return out; }
function text(v) { if (Array.isArray(v)) v = v.find((x) => x !== undefined && x !== null); return v === undefined || v === null || isObject(v) ? null : String(v); }

/**
 * readRecords({room, viewer, rules, circles, grants, dataDir, config, env, root, now, kind})
 *   -> {ok, viewer, records, visible: [{record, level, rule_ids, rule_refs, fields}], store, checks}
 * self: every record, every field. A person: records that are public or
 * granted by an active rule addressed to them, restricted to public_fields
 * (public) or fields_allowed (granted; operators applied to sensitive ones).
 * The public viewer: public records, public_fields only. Never throws on a
 * store fault: the DF_STORE_* check is returned and records is [].
 */
export async function readRecords({ room, viewer = 'self', rules = [], circles = [], grants = null, dataDir, config = null, env = process.env, root = null, now, kind = 'record' } = {}) {
  const m = manifestOf(room);
  const owner = ownerPersonId(config);
  const spec = viewerSpec(viewer, config);
  const scope = m.store && m.store.scope === 'person' && spec.mode === 'person' ? `person_${spec.person_id}` : 'owner';
  const checks = [];
  let store = null;
  let all = [];
  try { store = createStore({ room, dataDir, scope, config, env, root }); checks.push(...store.checks); all = await store.read(); } catch (e) { if (!isStoreError(e)) throw e; checks.push(e.check); }
  const rec = m.record || {};
  const active = list(rules).filter((r) => isObject(r) && isActive(r, now) && (r.grantor_person_id === owner || r.grantor_person_id === 'self'));
  const visible = [];
  all.forEach((record, i) => {
    const level = recordLevel(m, record);
    const probe = { id: nodeIdFor(m.id, record[rec.id_field], `r${i}`), kind, room: m.id, tags: asTags(record[rec.tag_field]), audience: { privacy_level: level, share_rule_ids: [] }, provenance: { owner_person_id: owner } };
    const selecting = active.filter((r) => selects(r, probe));
    const ruleIds = selecting.map((r) => r.rule_id);
    const id = record[rec.id_field] === undefined || record[rec.id_field] === null ? `r${i}` : record[rec.id_field];
    if (spec.mode === 'self') { visible.push({ id, record, level, rule_ids: ruleIds, rule_refs: [], fields: null }); return; }
    const granted = spec.mode === 'person' ? selecting.filter((r) => evaluate(r, spec.person_id, probe, { now, circles, grants }).allow) : [];
    if (level !== 'public' && !granted.length) return;
    let subset = level === 'public' ? pickFields(record, rec.public_fields) : {};
    for (const r of granted) subset = { ...subset, ...redactFields(pickFields(record, rec.public_fields), r, level) };
    visible.push({ id, record: subset, level, rule_ids: ruleIds, rule_refs: granted.map(ruleRef), fields: Object.keys(subset) });
  });
  return { ok: !checks.some((c) => c.status === 'fail' && c.blocking), viewer: spec, records: visible.map((v) => v.record), visible, store, checks };
}

function defaultView(m) {
  const r = m.record || {};
  const node = { kind: 'record', label: `$.${r.label_field}` };
  if (r.sublabel_field) node.sublabel = `$.${r.sublabel_field}`;
  if (r.tag_field) node.tags = `$.${r.tag_field}`;
  return { id: 'graph', label: m.label || m.id, kind: 'graph', node, limit: { max_nodes: DEFAULT_MAX_NODES, default_lens: null }, lenses: [] };
}
function parseView(view) {
  if (isObject(view)) return { room: view.room, view: view.view ?? null };
  const s = String(view ?? '').replace(/^room:/, '');
  const slash = s.indexOf('/');
  return slash < 0 ? { room: s, view: null } : { room: s.slice(0, slash), view: s.slice(slash + 1) };
}

/** One record -> one node under a view spec; `vis` is the readRecords visibility entry. */
function mapRecord({ view, m, vis, spec, owner, index, now }) {
  const r = m.record || {};
  const rec = vis.record;
  const fullLabel = text(evalPath(rec, view.node.label));
  const id = nodeIdFor(m.id, vis.id, `r${index}`);
  const fields = spec.mode === 'self' ? pickFields(rec, r.public_fields) : pickFields(rec, vis.fields);
  const digest = spec.mode === 'self' ? sha256(canonical(rec)) : sha256(canonical(fields));
  const node = { id, kind: view.node.kind, label: fullLabel && fullLabel.length ? clip(fullLabel, 120) : stubLabel(m.id, digest), room: m.id, record_id: clip(String(vis.id), 120) };
  const sub = view.node.sublabel ? text(evalPath(rec, view.node.sublabel)) : null;
  if (sub !== null && sub.length) node.sublabel = clip(sub, 200);
  const w = view.node.weight ? evalPath(rec, view.node.weight) : undefined;
  node.weight = typeof w === 'number' && Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
  node.tags = view.node.tags ? asTags(evalPath(rec, view.node.tags)) : [];
  if (view.node.color_token_by) { const v = text(evalPath(rec, view.node.color_token_by.field)); if (v !== null && Object.hasOwn(view.node.color_token_by.map, v)) node.color_token = view.node.color_token_by.map[v]; }
  if (!node.color_token) node.color_token = view.node.color_token || null;
  node.status = 'accepted';
  if (view.pose) { const p = evalPath(rec, view.pose); if (isObject(p) && [p.xyz, p.rpy].every((a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite))) { node.pose_m = { xyz: p.xyz, rpy: p.rpy }; if (Array.isArray(p.size_m) && p.size_m.length === 3 && p.size_m.every(Number.isFinite)) node.size_m = p.size_m; } }
  node.fields = fields;
  const dates = r.dates || {};
  const dateOf = (f) => (typeof f === 'string' && isDate(rec[f]) ? rec[f] : null);
  const happened = view.date && isDate(evalPath(rec, view.date)) ? evalPath(rec, view.date) : dateOf(dates.happened_on);
  const remembered = dateOf(dates.remembered_on);
  node.provenance = { owner_person_id: owner, source: { kind: 'record', ref: `${m.id}/${node.record_id}`, digest }, captured_on: remembered ?? happened ?? today(now) };
  if (happened) node.provenance.happened_on = happened;
  if (remembered) node.provenance.remembered_on = remembered;
  if (dateOf(dates.released_on)) node.provenance.released_on = dateOf(dates.released_on);
  node.audience = { privacy_level: vis.level, share_rule_ids: vis.rule_ids };
  node.evidence_ids = [];
  return node;
}

function groupFor(groups, key, label, kind) {
  const id = `g-${slug(key)}`;
  if (!groups.has(id)) groups.set(id, { id, label: clip(label, 120), kind, wraps: [], color_token: seriesToken(id) });
  return groups.get(id);
}
function lensFor(l) {
  const match = {};
  for (const k of ['owner', 'groups', 'rooms', 'tags', 'status']) if (Array.isArray(l.match[k])) match[k] = l.match[k];
  if (Array.isArray(l.match.kinds)) match.kinds = l.match.kinds.filter((k) => NODE_KIND_RE.test(k));
  return { id: l.id, label: clip(l.label, 120), match };
}
function viewsFor(view, kind, limit) {
  const v = isObject(view.views) ? view.views : {};
  const d2 = isObject(v['2d']) ? v['2d'] : {};
  const out = { '2d': { layout: LAYOUT_2D[kind] } };
  if (['force', 'cluster-disc', 'grid', 'timeline', 'lanes', 'metric'].includes(d2.layout)) out['2d'].layout = d2.layout;
  for (const k of ['seed', 'viewBox', 'spacing']) if (d2[k] !== undefined) out['2d'][k] = d2[k];
  if (isObject(v['3d'])) { const d3 = v['3d']; out['3d'] = { layout: ['lift', 'tier-wall', 'metric'].includes(d3.layout) ? d3.layout : LAYOUT_3D[kind] || 'lift', scale_m: d3.scale_m ?? 6 }; if (isObject(d3.camera) && d3.camera.position && d3.camera.target) out['3d'].camera = d3.camera; if (isObject(d3.lift) && ['group-weight', 'weight', 'flat'].includes(d3.lift.mode)) out['3d'].lift = { mode: d3.lift.mode, amplitude_m: d3.lift.amplitude_m ?? 1 }; }
  if (isObject(v.vr)) { out.vr = { enabled: v.vr.enabled === true }; for (const k of ['scale_m', 'floor_y', 'eye_height_m']) if (typeof v.vr[k] === 'number') out.vr[k] = v.vr[k]; if (typeof v.vr.label_budget === 'number') out.vr.label_budget = Math.min(512, v.vr.label_budget); }
  out.interactive = { focus: limit.focus ?? null, reach: limit.reach ?? 'both', lenses: list(view.lenses).map(lensFor), default_lens: view.limit && typeof view.limit.default_lens === 'string' ? view.limit.default_lens : null, deep_link: true };
  return out;
}

function lensMatches(match, n) {
  if (Array.isArray(match.owner) && !match.owner.includes(n.provenance && n.provenance.owner_person_id)) return false;
  if (Array.isArray(match.groups) && !match.groups.includes(n.group)) return false;
  if (Array.isArray(match.rooms) && !match.rooms.includes(n.room)) return false;
  if (Array.isArray(match.kinds) && !match.kinds.includes(n.kind)) return false;
  if (Array.isArray(match.status) && !match.status.includes(n.status)) return false;
  if (Array.isArray(match.tags) && !list(n.tags).some((t) => match.tags.includes(t))) return false;
  return true;
}
const byWeight = (a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : 1);

/** A guide step with only the kept node and edge ids; null when nothing of it is left. */
function keptStep(step, ids, edgeIds) {
  const out = { ...step, nodes: list(step.nodes).filter((id) => ids.has(id)) };
  if (Array.isArray(step.edges)) out.edges = step.edges.filter((id) => edgeIds.has(id));
  if (!out.nodes.length && !(out.edges ?? []).length) return null;
  if (Array.isArray(out.edges) && !out.edges.length) delete out.edges;
  return out;
}

/** The size rule: a lens (given, or the view default when over budget), then a focus/reach subgraph; never refuses. */
export function applyLimit(scene, lim = {}, view = null) {
  const max = Number.isInteger(lim.max_nodes) && lim.max_nodes > 0 ? lim.max_nodes : (view && view.limit && Number.isInteger(view.limit.max_nodes) ? view.limit.max_nodes : DEFAULT_MAX_NODES);
  const inter = isObject(scene.views) && isObject(scene.views.interactive) ? scene.views.interactive : {};
  let nodes = list(scene.nodes);
  const before = nodes.length;
  const lensId = lim.lens ?? (before > max ? (view && view.limit ? view.limit.default_lens : inter.default_lens) ?? null : null);
  const lens = lensId ? list(inter.lenses).find((l) => l.id === lensId) : null;
  if (lens) nodes = nodes.filter((n) => lensMatches(lens.match, n));
  let focus = typeof lim.focus === 'string' && nodes.some((n) => n.id === lim.focus) ? lim.focus : null;
  let reach = ['in', 'out', 'both', 'none'].includes(lim.reach) ? lim.reach : null;
  if (nodes.length > max || focus) {
    const present = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    if (!focus) focus = [...nodes].sort(byWeight)[0].id;
    reach = reach ?? 'both';
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of list(scene.edges)) {
      if (!present.has(e.from) || !present.has(e.to) || reach === 'none') continue;
      if (reach !== 'in' || e.directed === false) adj.get(e.from).push(e.to);
      if (reach !== 'out' || e.directed === false) adj.get(e.to).push(e.from);
    }
    const kept = new Set([focus]);
    const queue = [focus];
    while (queue.length && kept.size < max) {
      const next = adj.get(queue.shift()).map((id) => byId.get(id)).sort(byWeight);
      for (const n of next) { if (kept.size >= max) break; if (!kept.has(n.id)) { kept.add(n.id); queue.push(n.id); } }
    }
    if (before > max && !lim.focus) for (const n of [...nodes].sort(byWeight)) { if (kept.size >= max) break; kept.add(n.id); }
    nodes = nodes.filter((n) => kept.has(n.id));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = list(scene.edges).filter((e) => ids.has(e.from) && ids.has(e.to));
  const cited = new Set([...nodes, ...edges].flatMap((x) => list(x.evidence_ids)));
  const out = { ...scene, nodes, edges };
  if (Array.isArray(scene.groups)) out.groups = scene.groups.map((g) => (Array.isArray(g.wraps) ? { ...g, wraps: g.wraps.filter((w) => ids.has(w)) } : g));
  if (Array.isArray(scene.evidence)) out.evidence = scene.evidence.filter((ev) => cited.has(ev.id));
  const edgeIds = new Set(edges.map((e) => e.id).filter((id) => typeof id === 'string'));
  const dropped = nodes.length < before || edges.length < list(scene.edges).length;
  if (isObject(scene.positions)) out.positions = Object.fromEntries(Object.entries(scene.positions).filter(([k]) => ids.has(k)));
  if (isObject(scene.labels)) out.labels = Object.fromEntries(Object.entries(scene.labels).filter(([k]) => ids.has(k)));
  if (isObject(scene.routes)) out.routes = Object.fromEntries(Object.entries(scene.routes).filter(([k]) => edgeIds.has(k)));
  if (isObject(scene.views)) {
    out.views = { ...scene.views };
    if (isObject(scene.views.interactive)) {
      const i = { ...scene.views.interactive };
      if (typeof i.focus === 'string' && !ids.has(i.focus)) i.focus = null;
      if (Array.isArray(i.presentation)) i.presentation = i.presentation.filter((p) => ids.has(p));
      if (Array.isArray(i.steps)) i.steps = i.steps.filter(isObject).map((st) => keptStep(st, ids, edgeIds)).filter(Boolean);
      out.views.interactive = i;
    }
    if (isObject(scene.views.vr) && typeof scene.views.vr.entry_node === 'string' && !ids.has(scene.views.vr.entry_node)) { const { entry_node, ...rest } = scene.views.vr; out.views.vr = rest; }
    // The plan names edges (reversed, skipped) and counts the whole graph (layers, dummies, crossings): a projection that dropped anything carries none.
    if (dropped && isObject(scene.views['2d']) && scene.views['2d'].plan !== undefined) { const { plan, ...rest } = scene.views['2d']; out.views['2d'] = rest; }
  }
  return { scene: out, dropped: before - nodes.length, limit: { focus, reach, lens: lens ? lensId : null, max_nodes: max } };
}

/** Overlay nodes, groups and edges the viewer may see, plus their evidence; expired stubs are reported, not merged. */
function mergeOverlays({ overlays, viewer, owner, now, checks, nextEvidence }) {
  const nodes = []; const groups = []; const edges = []; const evidence = [];
  for (const o of list(overlays)) {
    const live = liveOverlayNodes(o, now);
    if (live.expired.length) checks.push(fail('DF_OVERLAY_EXPIRED', { path: `data/overlays/${o.grantor_person_id}.json`, detail: `${live.expired.length} node(s) past expires_on dropped: ${live.expired.slice(0, 5).join(', ')}` }));
    const seen = new Set();
    for (const n of live.nodes) {
      if (!visibleTo(n, viewer, owner).ok) continue;
      const ev = { id: `ev-${nextEvidence()}`, kind: 'projection', ref: `data/overlays/${o.grantor_person_id}.json#${n.id}`, digest: n.boundary.digest, label: `SRC ${evidence.length + 1}` };
      ev.label = `SRC ${ev.id.slice(3)}`;
      evidence.push(ev);
      nodes.push({ ...n, weight: typeof n.weight === 'number' ? n.weight : 0.3, color_token: 'foreign', status: 'accepted', evidence_ids: [ev.id] });
      seen.add(n.id);
    }
    for (const g of list(o.groups)) { const wraps = nodes.filter((n) => n.group === g.id).map((n) => n.id); if (wraps.length) groups.push({ id: g.id, label: g.label, kind: g.kind, wraps, color_token: 'foreign' }); }
    for (const e of list(o.edges)) if (seen.has(e.from) && seen.has(e.to)) edges.push({ id: e.id, from: e.from, to: e.to, kind: e.kind, directed: e.directed === true, variant: 'dashed', route: 'auto' });
  }
  return { nodes, groups, edges, evidence };
}

/**
 * projectDetailed(opts) -> {scene, checks, dropped, viewer}
 * opts = {rooms, viewer, rules, circles, view | authored, limit, now,
 *         dataDir, config, env, root, sessionKey, overlays, includeOverlays}
 * project(opts) -> the scene alone. Both throw TypeError without now or a
 * session key; everything else is a check in `checks`.
 */
export async function projectDetailed(opts = {}) {
  const { rooms = [], viewer = 'self', rules = [], circles = [], view = null, authored = null, limit = {}, now, dataDir, config = null, env = process.env, root = null, sessionKey, includeOverlays = true } = opts;
  if (now === undefined || now === null) throw new TypeError('project needs now (ctx.now)');
  if (!((typeof sessionKey === 'string' && sessionKey.length) || (sessionKey instanceof Uint8Array && sessionKey.length))) throw new TypeError('project needs sessionKey (the content of data/keys/session.key); a scene without a verifiable stamp never renders');
  const owner = ownerPersonId(config);
  const spec = viewerSpec(viewer, config);
  const activeRules = list(rules).filter((r) => isObject(r) && isActive(r, now));
  const fullViewer = { ...spec, rule_refs: spec.mode === 'person' ? activeRules.filter((r) => receives(r, spec.person_id, circles, now)).map(ruleRef).sort() : [] };
  const overlays = includeOverlays ? (Array.isArray(opts.overlays) ? opts.overlays : (dataDir ? readOverlays(dataDir) : [])) : [];
  const grants = originGrants(overlays);
  const checks = [];
  let scene; let viewSpec = null;
  if (isObject(authored)) {
    const { projected, receipt, ...rest } = authored;
    scene = structuredClone(rest);
    const keep = new Set(list(scene.nodes).filter((n) => visibleTo(n, fullViewer, owner).ok).map((n) => n.id));
    scene.nodes = list(scene.nodes).filter((n) => keep.has(n.id));
    scene = applyLimit(scene, { max_nodes: Number.MAX_SAFE_INTEGER }).scene;
    scene.viewer = fullViewer;
  } else {
    const want = parseView(view);
    const room = findRoom(rooms, want.room);
    if (!room) throw new TypeError(`project: room '${String(want.room)}' is not in the center`);
    const m = manifestOf(room);
    const views = list(room.views).length ? room.views : [defaultView(m)];
    viewSpec = (want.view ? views.find((v) => v.id === want.view) : views[0]) ?? null;
    if (!viewSpec) throw new TypeError(`project: view '${want.view}' is not in center/rooms/${m.id}/views.json`);
    const kind = viewSpec.kind;
    const nodes = []; const groups = new Map(); const evidence = []; const edges = []; const linkRooms = [];
    const base = { viewer, rules, circles, grants, dataDir, config, env, root, now };
    const sources = [[room, viewSpec]];
    for (const rid of list(viewSpec.include_rooms)) { const r = findRoom(rooms, rid); if (r && r !== room) sources.push([r, defaultView(manifestOf(r))]); }
    for (const [src, spec2] of sources) {
      const sm = manifestOf(src);
      const read = await readRecords({ ...base, room: src, kind: spec2.node.kind });
      checks.push(...read.checks);
      read.visible.forEach((vis, i) => {
        const node = mapRecord({ view: spec2, m: sm, vis, spec, owner, index: i, now });
        const groupKey = kind !== 'room' && spec2.group_by ? text(evalPath(vis.record, spec2.group_by.field)) : null;
        const laneKey = kind === 'board' && spec2.lane ? text(evalPath(vis.record, spec2.lane)) : null;
        const g = laneKey !== null && laneKey.length ? groupFor(groups, laneKey, laneKey, 'lane') : groupKey !== null && groupKey.length ? groupFor(groups, groupKey, groupKey, spec2.group_by.kind) : null;
        if (g) { node.group = g.id; g.wraps.push(node.id); }
        if (!node.color_token) node.color_token = g ? g.color_token : 'series-1';
        const ev = { id: `ev-${evidence.length + 1}`, kind: 'record', ref: node.provenance.source.ref, digest: node.provenance.source.digest, label: `SRC ${evidence.length + 1}` };
        evidence.push(ev);
        node.evidence_ids = [ev.id];
        nodes.push(node);
        linkRooms.push([sm, vis, node]);
      });
    }
    const ids = new Set(nodes.map((n) => n.id));
    const seen = new Set();
    let unresolved = 0;
    for (const [sm, vis, node] of linkRooms) {
      for (const lf of list(sm.record.link_fields)) {
        for (const target of list(Array.isArray(vis.record[lf.field]) ? vis.record[lf.field] : vis.record[lf.field] === undefined ? [] : [vis.record[lf.field]])) {
          const to = nodeIdFor(lf.to_room, target);
          const directed = lf.kind !== 'relates';
          const key = `${directed ? [node.id, to].join('>') : [node.id, to].sort().join('~')}:${lf.kind}`;
          if (!ids.has(to)) { unresolved += 1; checks.push(fail('DF_RECORD_LINK_UNRESOLVED', { path: `${sm.id}/${node.record_id}.${lf.field}`, detail: `'${String(target)}' is not a record of room '${lf.to_room}' in this scene` })); continue; }
          if (to === node.id || seen.has(key)) continue;
          seen.add(key);
          edges.push({ id: `e-${edges.length + 1}`, from: node.id, to, kind: lf.kind, directed, variant: 'solid', route: 'auto' });
        }
      }
    }
    if (!unresolved) checks.push({ code: 'DF_RECORD_LINK_UNRESOLVED', gate: 'record', blocking: false, status: 'pass' });
    const groupList = [...groups.values()];
    if (OVERLAY_KINDS.has(kind) && overlays.length) {
      let n = evidence.length;
      const merged = mergeOverlays({ overlays, viewer: fullViewer, owner, now, checks, nextEvidence: () => { n += 1; return n; } });
      nodes.push(...merged.nodes); groupList.push(...merged.groups); edges.push(...merged.edges); evidence.push(...merged.evidence);
    }
    scene = {
      schema_version: 'dotfield.scene/1', kind,
      meta: { id: `${m.id}-${viewSpec.id}`, title: clip(`${m.label || m.id} — ${viewSpec.label || viewSpec.id}`, 120), theme: viewSpec.theme || 'default', quality: 'checked', privacy_mode: m.privacy_mode === 'private_live' ? 'private_live' : 'synthetic_data', maturity: m.maturity || 'contract_only', legend: true, room: m.id, view: viewSpec.id },
      viewer: fullViewer, groups: groupList, nodes, edges, views: viewsFor(viewSpec, kind, limit), evidence,
    };
  }
  scene = computeTaint(scene, { owner });
  const limited = applyLimit(scene, limit, viewSpec);
  scene = limited.scene;
  scene.projected = { by: ENGINE, engine_version: engineVersion(), viewer: spec.person_id, at: isoSeconds(now), dropped: limited.dropped, limit: limited.limit, mac: stamp(scene, sessionKey) };
  return { scene, checks, dropped: limited.dropped, viewer: fullViewer };
}

export async function project(opts = {}) {
  return (await projectDetailed(opts)).scene;
}
