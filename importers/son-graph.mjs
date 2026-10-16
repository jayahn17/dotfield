// A saved copy of son's /api/graph JSON ({nodes, links, groups, stats}) →
// kind: graph scene. Reads a file the caller already loaded; never imports
// son. Notes, tags and agents become note/tag/desk nodes, son groups become
// region/discipline/person groups, links become link/member/relates/influences
// edges; degree drives weight; everything else round-trips under ext.son_graph.
import {
  clip, dateOf, fail, finishScene, hasBlocking, idMinter, importChecks, isObject, label, MAX_SUBLABEL,
  provenanceFor, sceneSkeleton, seriesFor, slug, sourceDescriptor, sourceDigest, tagList,
} from './common.mjs';

export const id = 'son-graph';
const NODE_KIND = { note: 'note', ghost: 'note', tag: 'tag', agent: 'desk', file: 'file', asset: 'asset', person: 'person', event: 'event', place: 'place' };
const GROUP_KIND = { tag: 'discipline', agent: 'person' };
const LINK = {
  wiki: ['link', true, 'solid'], md: ['link', true, 'solid'], tag: ['member', true, 'dashed'], mention: ['relates', false, 'dashed'],
  workflow: ['influences', true, 'flow'], agent: ['influences', true, 'solid'], link: ['link', true, 'solid'], relates: ['relates', false, 'dashed'],
};
const NODE_KEYS = new Set(['id', 'label', 'group', 'kind', 'description', 'tags', 'degree', 'discipline', 'color']);

export function shapeOk(doc) {
  return isObject(doc) && Array.isArray(doc.nodes) && Array.isArray(doc.links)
    && doc.nodes.every((n) => isObject(n) && n.id !== undefined) && doc.links.every((l) => isObject(l) && l.source !== undefined && l.target !== undefined);
}

export function detect(input) {
  const d = input && input.doc;
  return isObject(d) && Array.isArray(d.nodes) && Array.isArray(d.links) && !Array.isArray(d.components);
}

export function run(input, opts = {}) {
  const doc = input && input.doc;
  const fails = [];
  if (!isObject(doc)) fails.push(fail('DF_IMPORT_FILE_UNREADABLE', { path: '$', detail: `${input ? input.name : 'input'} is not a JSON object` }));
  else if (!shapeOk(doc)) fails.push(fail('DF_IMPORT_SOURCE_UNKNOWN', { path: '$', detail: 'expected {nodes: [{id, label, …}], links: [{source, target, …}]}' }));
  else if (!doc.nodes.length) fails.push(fail('DF_IMPORT_EMPTY', { path: '$.nodes', detail: 'no nodes' }));
  const checks = importChecks(fails);
  if (hasBlocking(checks)) return { kind: 'scene', importer: id, scene: null, checks, ok: false, source: sourceDescriptor(id, input) };

  const capturedOn = dateOf(opts.now);
  const digest = sourceDigest(input);
  const title = opts.title ?? doc.title ?? doc.root ?? 'Knowledge graph';
  const sceneId = slug(opts.id ?? (doc.root ? `${doc.root}-graph` : input.name.replace(/\.json$/i, '')), 'son-graph');
  const scene = sceneSkeleton({ kind: 'graph', id: sceneId, title, layout: 'force', importer: id, name: input.name, digest, opts });
  const ext = { source: input.name, ids: {}, nodes: {}, links: [] };
  for (const k of ['generated_at', 'stats', 'groups', 'disciplines', 'root', 'atlas']) if (doc[k] !== undefined) ext[k] = doc[k];
  scene.ext.son_graph = ext;

  const ids = idMinter();
  const groupIds = idMinter();
  const groups = new Map();
  const groupFor = (name) => {
    const key = String(name ?? 'ungrouped');
    const gid = groupIds.mint(key, 'group');
    if (!groups.has(gid)) groups.set(gid, { id: gid, label: label(key), kind: GROUP_KIND[key] ?? 'region', wraps: [], color_token: seriesFor(gid) });
    return gid;
  };
  for (const g of isObject(doc.groups) ? Object.keys(doc.groups) : []) groupFor(g);
  const maxDegree = Math.max(1, ...doc.nodes.map((n) => Number(n.degree) || 0));
  for (const n of doc.nodes) {
    const nid = ids.mint(n.id, 'node');
    ext.ids[nid] = String(n.id);
    const sonKind = String(n.kind ?? 'note').toLowerCase();
    const gid = groupFor(n.group);
    const tags = tagList([...(Array.isArray(n.tags) ? n.tags : []), ...(typeof n.discipline === 'string' ? [n.discipline] : []), ...(sonKind === 'ghost' ? ['unresolved'] : [])]);
    const node = {
      id: nid, kind: NODE_KIND[sonKind] ?? 'note', label: label(n.label ?? n.id), group: gid,
      weight: sonKind === 'ghost' ? 0.1 : Math.min(1, (Number(n.degree) || 0) / maxDegree), tags,
      color_token: groups.get(gid).color_token, status: 'accepted',
      provenance: provenanceFor({ importer: id, name: input.name, digest, owner: opts.owner, capturedOn }),
      audience: { privacy_level: opts.privacy_level ?? 'private', share_rule_ids: [] }, evidence_ids: ['ev-1'],
    };
    if (typeof n.description === 'string' && n.description.trim()) node.sublabel = clip(n.description, MAX_SUBLABEL);
    groups.get(gid).wraps.push(nid);
    scene.nodes.push(node);
    const leftovers = Object.fromEntries(Object.entries(n).filter(([k]) => !NODE_KEYS.has(k)));
    if (n.degree !== undefined) leftovers.degree = n.degree;
    if (n.discipline !== undefined) leftovers.discipline = n.discipline;
    if (Object.keys(leftovers).length) ext.nodes[nid] = leftovers;
  }
  scene.groups = [...groups.values()];

  const dropped = [];
  const seen = new Set();
  doc.links.forEach((l, i) => {
    const from = ids.get(l.source); const to = ids.get(l.target);
    const sonKind = String(l.kind ?? 'link').toLowerCase();
    const [kind, directedDefault, variant] = LINK[sonKind] ?? ['relates', false, 'dashed'];
    const directed = typeof l.directed === 'boolean' ? l.directed : directedDefault;
    if (!from || !to || from === to) { dropped.push({ source: l.source, target: l.target, kind: sonKind, why: !from || !to ? 'unknown node' : 'self link' }); return; }
    const key = directed ? `${from}>${to}|${kind}` : `${[from, to].sort().join('~')}|${kind}`;
    if (seen.has(key)) { dropped.push({ source: l.source, target: l.target, kind: sonKind, why: 'duplicate' }); return; }
    seen.add(key);
    const edge = { id: `e${scene.edges.length + 1}`, from, to, kind, directed, variant, route: 'auto' };
    if (typeof l.label === 'string' && l.label.trim()) edge.label = clip(l.label, 120);
    scene.edges.push(edge);
    ext.links.push({ id: edge.id, kind: sonKind, index: i });
  });
  if (dropped.length) ext.dropped_links = dropped;
  const out = finishScene(scene);
  return { kind: 'scene', importer: id, scene: out, checks, ok: true, dropped, source: sourceDescriptor(id, input) };
}
