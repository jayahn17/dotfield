// A copy of son's spatial-asset-scene.json ({scene, zones, assets}) → kind:
// room scene in metres: zones become zone groups with a metric box, assets
// become asset/file nodes with pose_m and size_m, asset documents become
// evidence rows of kind file; render hints and everything the scene has no
// field for round-trip under ext.spatial.
import {
  clip, dateOf, evidenceMinter, fail, finishScene, hasBlocking, idMinter, importChecks, isObject, label, MAX_SUBLABEL,
  provenanceFor, sceneSkeleton, seriesFor, slug, sourceDescriptor, sourceDigest, tagList, unit, vec3,
} from './common.mjs';

export const id = 'spatial-asset-scene';
const KIND = { physical: 'asset', digital: 'file', document: 'file', file: 'file', place: 'place', person: 'person' };
const ASSET_KEYS = new Set(['asset_id', 'id', 'display_name', 'label', 'name', 'kind', 'asset_type', 'zone_id', 'zone_label', 'tags', 'documents', 'size_xyz_m', 'size_m', 'pose', 'pose_m', 'layouts', 'position_xyz_m', 'rotation_xyz_rad', 'brand', 'model', 'description', 'weight', 'related_asset_ids']);
const ZONE_KEYS = new Set(['zone_id', 'id', 'label', 'name', 'center_xyz_m', 'size_xyz_m']);
const pick = (o, keys) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== '');

export function shapeOk(doc) {
  return isObject(doc) && Array.isArray(doc.zones) && Array.isArray(doc.assets)
    && doc.zones.every((z) => isObject(z) && pick(z, ['zone_id', 'id']) !== undefined) && doc.assets.every((a) => isObject(a) && pick(a, ['asset_id', 'id']) !== undefined);
}

export function detect(input) {
  const d = input && input.doc;
  return isObject(d) && Array.isArray(d.zones) && Array.isArray(d.assets);
}

/** {xyz, rpy} from pose, pose_m, layouts.room or position_xyz_m; null when the asset has no pose. */
export function poseOf(a) {
  const p = isObject(a.pose) ? a.pose : (isObject(a.pose_m) ? a.pose_m : null);
  if (p && Array.isArray(p.xyz)) return { xyz: vec3(p.xyz), rpy: vec3(p.rpy) };
  const room = isObject(a.layouts) && isObject(a.layouts.room) ? a.layouts.room : null;
  if (room && Array.isArray(room.position_xyz_m)) return { xyz: vec3(room.position_xyz_m), rpy: vec3(room.rotation_xyz_rad) };
  if (Array.isArray(a.position_xyz_m)) return { xyz: vec3(a.position_xyz_m), rpy: vec3(a.rotation_xyz_rad) };
  return null;
}

export function sizeOf(a) {
  const s = [a.size_xyz_m, a.size_m, isObject(a.render) ? a.render.size_xyz_m : undefined].find((v) => Array.isArray(v) && v.length === 3);
  return s ? vec3(s) : null;
}

export function run(input, opts = {}) {
  const doc = input && input.doc;
  const fails = [];
  if (!isObject(doc)) fails.push(fail('DF_IMPORT_FILE_UNREADABLE', { path: '$', detail: `${input ? input.name : 'input'} is not a JSON object` }));
  else if (!shapeOk(doc)) fails.push(fail('DF_IMPORT_SOURCE_UNKNOWN', { path: '$', detail: 'expected {zones: [{zone_id, center_xyz_m, size_xyz_m}], assets: [{asset_id, …}]}' }));
  else if (!doc.assets.length) fails.push(fail('DF_IMPORT_EMPTY', { path: '$.assets', detail: 'no assets' }));
  const checks = importChecks(fails);
  if (hasBlocking(checks)) return { kind: 'scene', importer: id, scene: null, checks, ok: false, source: sourceDescriptor(id, input) };

  const capturedOn = dateOf(opts.now);
  const digest = sourceDigest(input);
  const head = isObject(doc.scene) ? doc.scene : {};
  const title = opts.title ?? pick(head, ['title', 'name']) ?? (isObject(head.room) ? head.room.name : null) ?? 'Asset room';
  const sceneId = slug(opts.id ?? pick(head, ['scene_id', 'id']) ?? input.name.replace(/\.json$/i, ''), 'asset-room');
  const scene = sceneSkeleton({ kind: 'room', id: sceneId, title, layout: 'metric', importer: id, name: input.name, digest, opts });
  const ext = { source: input.name, ids: {}, zones: {}, assets: {} };
  for (const k of Object.keys(head)) if (!['title', 'name', 'scene_id', 'id'].includes(k)) ext[k] = head[k];
  for (const k of ['agent_suggestions', 'generated_at']) if (doc[k] !== undefined) ext[k] = doc[k];
  scene.ext.spatial = ext;

  const zoneIds = idMinter();
  const zones = new Map();
  for (const z of doc.zones) {
    const key = String(pick(z, ['zone_id', 'id']));
    const gid = zoneIds.mint(key, 'zone');
    const box = { center: vec3(z.center_xyz_m, null), size: vec3(z.size_xyz_m, null) };
    zones.set(gid, { id: gid, label: label(pick(z, ['label', 'name']) ?? key), kind: 'zone', center_xyz_m: box.center ?? [0, 0, 0], size_xyz_m: box.size ?? [1, 1, 1], color_token: seriesFor(gid) });
    const leftovers = Object.fromEntries(Object.entries(z).filter(([k]) => !ZONE_KEYS.has(k)));
    if (!box.center || !box.size) leftovers.box_assumed = true;
    if (Object.keys(leftovers).length) ext.zones[gid] = leftovers;
  }
  scene.groups = [...zones.values()];

  const ids = idMinter();
  const evidence = evidenceMinter(scene);
  for (const a of doc.assets) {
    const key = String(pick(a, ['asset_id', 'id']));
    const nid = ids.mint(key, 'asset');
    ext.ids[nid] = key;
    const gid = a.zone_id !== undefined && a.zone_id !== null ? zoneIds.get(String(a.zone_id)) : undefined;
    const evidenceIds = ['ev-1'];
    for (const d of Array.isArray(a.documents) ? a.documents : []) {
      if (!isObject(d)) continue;
      const ref = pick(d, ['uri', 'path', 'title', 'document_id']);
      if (ref) evidenceIds.push(evidence('file', ref, d.checksum ?? d.digest ?? null));
    }
    const kindKey = String(a.kind ?? 'physical').toLowerCase();
    const node = {
      id: nid, kind: KIND[kindKey] ?? 'asset', label: label(pick(a, ['display_name', 'label', 'name']) ?? key),
      weight: unit(a.weight, 0.5), tags: tagList([...(Array.isArray(a.tags) ? a.tags : []), ...(a.asset_type ? [a.asset_type] : [])]),
      color_token: gid ? zones.get(gid).color_token : 'muted', status: 'accepted',
      provenance: provenanceFor({ importer: id, name: input.name, digest, owner: opts.owner, capturedOn }),
      audience: { privacy_level: opts.privacy_level ?? 'private', share_rule_ids: [] }, evidence_ids: evidenceIds,
    };
    const sub = pick(a, ['description']) ?? [a.brand, a.model].filter(Boolean).join(' ');
    if (sub) node.sublabel = clip(sub, MAX_SUBLABEL);
    if (gid) node.group = gid;
    const pose = poseOf(a);
    const extra = {};
    if (pose) node.pose_m = pose;
    else if (gid) { node.pose_m = { xyz: zones.get(gid).center_xyz_m, rpy: [0, 0, 0] }; extra.pose_assumed = 'zone centre'; }
    const size = sizeOf(a);
    if (size) node.size_m = size;
    scene.nodes.push(node);
    const leftovers = Object.fromEntries(Object.entries(a).filter(([k]) => !ASSET_KEYS.has(k)));
    if (isObject(leftovers.render)) leftovers.render = Object.fromEntries(Object.entries(leftovers.render).filter(([k]) => k !== 'accent_color' && k !== 'size_xyz_m'));
    if (gid === undefined && a.zone_id !== undefined) extra.zone_unknown = String(a.zone_id);
    for (const k of ['brand', 'model', 'kind', 'asset_type', 'zone_label']) if (a[k] !== undefined) leftovers[k] = a[k];
    if (isObject(a.layouts)) leftovers.layouts = Object.fromEntries(Object.entries(a.layouts).filter(([k]) => k !== 'room'));
    ext.assets[nid] = { ...leftovers, ...extra };
  }
  const seen = new Set();
  for (const a of doc.assets) {
    const from = ids.get(String(pick(a, ['asset_id', 'id'])));
    for (const r of Array.isArray(a.related_asset_ids) ? a.related_asset_ids : []) {
      const to = ids.get(String(r));
      if (!to || to === from) continue;
      const key = [from, to].sort().join('~');
      if (seen.has(key)) continue;
      seen.add(key);
      scene.edges.push({ id: `e${scene.edges.length + 1}`, from, to, kind: 'relates', directed: false, variant: 'dashed', route: 'auto' });
    }
  }
  const out = finishScene(scene);
  return { kind: 'scene', importer: id, scene: out, checks, ok: true, dropped: [], source: sourceDescriptor(id, input) };
}
