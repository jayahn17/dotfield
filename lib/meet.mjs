// The meeting layer (VISION §7.4): meet() builds a scene of kind "meet" from
// two sides — two of the owner's rooms (`connect --between a,b`) or the owner
// and one person's boundary stubs (`connect --with <person>`) — with a
// region per side and dashed `candidate` edges between pairs whose tags,
// discipline labels and the packs' boundary_vocab overlap at or above
// center.config.json connect.threshold. Candidates are never persisted:
// meet() touches no file; accepting one is a proposal of kind "pair" that
// `approve` decides and applyPairDecision() then records in
// data/boundaries.json. Both sides produce one scene shape.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256Hex } from './digest.mjs';
import { liveOverlayNodes } from './overlay.mjs';
import { writeJsonAtomic } from './rooms.mjs';
import { today } from './share.mjs';

export const BOUNDARIES_SCHEMA_VERSION = 'dotfield.boundaries/1';
export const DEFAULT_THRESHOLD = 0.35;
export const MAX_CANDIDATES = 200;
export const SIDE_IDS = Object.freeze({ left: 'meet-left', right: 'meet-right' });
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => { const cs = [...String(s)]; return cs.length > n ? cs.slice(0, n).join('') : cs.join(''); };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'x';
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** A side from a projected scene: {id, label, kind: 'room', nodes, evidence}; `roomId` keeps that room's own nodes only. */
export function sideFromScene(scene, { id, label = null, roomId = null } = {}) {
  const nodes = list(scene && scene.nodes).filter((n) => isObject(n) && (!roomId || n.room === roomId));
  return { id: id ?? roomId ?? (scene && scene.meta ? scene.meta.id : 'left'), label: label ?? (roomId ?? (scene && scene.meta ? scene.meta.title : id)), kind: 'room', nodes, evidence: list(scene && scene.evidence) };
}
/** A side from one person's overlay: their live boundary stubs ({id: grantor, kind: 'person'}). */
export function sideFromOverlay(overlay, { now, label = null } = {}) {
  const live = liveOverlayNodes(overlay, now);
  const nodes = live.nodes.map((n) => ({ ...n, weight: typeof n.weight === 'number' ? n.weight : 0.3, color_token: 'foreign', status: 'accepted', evidence_ids: [] }));
  return { id: overlay.grantor_person_id, label: label ?? overlay.grantor_person_id, kind: 'person', nodes, evidence: [] };
}

/** The comparable tokens of a node: its tags, the discipline labels its tags or label words match, and vocab terms it mentions. */
export function tokensOf(node, { disciplines = [], vocab = [] } = {}) {
  const tags = list(node.tags).map((t) => String(t).toLowerCase());
  const bag = new Set([...tags, ...words(node.label)]);
  const out = new Set(tags);
  for (const d of list(disciplines)) {
    if (!d || typeof d.label !== 'string') continue;
    if (list(d.patterns).some((p) => typeof p === 'string' && [...bag].some((w) => w.includes(p.toLowerCase())))) out.add(`discipline:${d.label.toLowerCase()}`);
  }
  for (const v of list(vocab)) { const term = String(v).toLowerCase(); if ([...bag].some((w) => w === term || w.includes(term))) out.add(term); }
  return out;
}

/** score(a, b) -> 0..1: shared tokens over the union, shared vocab terms counted twice. */
export function score(a, b, opts = {}) {
  const A = tokensOf(a, opts); const B = tokensOf(b, opts);
  const shared = [...A].filter((t) => B.has(t)).sort();
  if (!shared.length) return { score: 0, shared };
  const vocab = new Set(list(opts.vocab).map((v) => String(v).toLowerCase()));
  const bonus = shared.filter((t) => vocab.has(t)).length;
  const union = new Set([...A, ...B]).size;
  return { score: Math.min(1, Math.round(((shared.length + bonus) / union) * 1000) / 1000), shared };
}

/** Scored pairs at or above the threshold, best first, deterministic, capped. */
export function candidates(left, right, { disciplines = [], vocab = [], threshold = DEFAULT_THRESHOLD, maxCandidates = MAX_CANDIDATES } = {}) {
  const out = [];
  for (const a of list(left.nodes)) for (const b of list(right.nodes)) {
    if (a.id === b.id) continue;
    const s = score(a, b, { disciplines, vocab });
    if (s.score >= threshold && s.score > 0) out.push({ from: a.id, to: b.id, score: s.score, shared: s.shared });
  }
  out.sort((x, y) => (y.score - x.score) || (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1));
  return out.slice(0, maxCandidates);
}

/**
 * meet({left, right, disciplines, vocab, threshold, viewer, now, meta}) -> scene (kind meet, unstamped)
 * Pass the result through project({authored}) to stamp it for a viewer. No file is written.
 */
export function meet({ left, right, disciplines = [], vocab = [], threshold = DEFAULT_THRESHOLD, viewer = 'self', owner = 'self', now, meta = {}, maxCandidates = MAX_CANDIDATES } = {}) {
  if (!isObject(left) || !isObject(right)) throw new TypeError('meet needs {left, right} sides ({id, label, nodes[]})');
  if (now === undefined || now === null) throw new TypeError('meet needs now (ctx.now)');
  const leftIds = new Set(list(left.nodes).map((n) => n.id));
  const rightNodes = list(right.nodes).filter((n) => !leftIds.has(n.id));
  const nodes = [...list(left.nodes).map((n) => ({ ...n, group: SIDE_IDS.left })), ...rightNodes.map((n) => ({ ...n, group: SIDE_IDS.right }))];
  const evidenceIds = new Set([...list(left.evidence), ...list(right.evidence)].map((e) => e.id));
  for (const n of nodes) n.evidence_ids = list(n.evidence_ids).filter((id) => evidenceIds.has(id));
  const cited = new Set(nodes.flatMap((n) => n.evidence_ids));
  const evidence = []; const seenEv = new Set();
  for (const e of [...list(left.evidence), ...list(right.evidence)]) if (cited.has(e.id) && !seenEv.has(e.id)) { seenEv.add(e.id); evidence.push(e); }
  const pairs = candidates(left, { nodes: rightNodes }, { disciplines, vocab, threshold, maxCandidates });
  const edges = pairs.map((p, i) => ({ id: `cand-${i + 1}`, from: p.from, to: p.to, kind: 'candidate', directed: false, label: clip(p.shared.join(', '), 120), weight: p.score, variant: 'dashed', route: 'auto' }));
  const v = isObject(viewer) ? viewer : { person_id: viewer };
  const person = typeof v.person_id === 'string' && v.person_id ? v.person_id : 'self';
  const groups = [
    { id: SIDE_IDS.left, label: clip(left.label ?? left.id, 120), kind: left.kind === 'person' ? 'person' : 'region', wraps: list(left.nodes).map((n) => n.id), color_token: 'series-1' },
    { id: SIDE_IDS.right, label: clip(right.label ?? right.id, 120), kind: right.kind === 'person' ? 'person' : 'region', wraps: rightNodes.map((n) => n.id), color_token: right.kind === 'person' ? 'foreign' : 'series-2' },
  ];
  return {
    schema_version: 'dotfield.scene/1', kind: 'meet',
    meta: { id: `meet-${slug(left.id)}-${slug(right.id)}`, title: clip(meta.title ?? `Meet — ${left.label ?? left.id} × ${right.label ?? right.id}`, 120), theme: meta.theme ?? 'default', quality: 'checked', privacy_mode: meta.privacy_mode ?? 'private_live', maturity: meta.maturity ?? 'local_beta', legend: true },
    viewer: { person_id: person === owner ? 'self' : person, mode: person === 'self' || person === owner ? 'self' : v.mode === 'public' ? 'public' : 'person', rule_refs: list(v.rule_refs) },
    groups, nodes, edges,
    views: {
      '2d': { layout: 'lanes', seed: 1 },
      '3d': { layout: 'lift', scale_m: 6, lift: { mode: 'group-weight', amplitude_m: 1.5 } },
      vr: { enabled: true, scale_m: 4 },
      interactive: { focus: null, reach: 'both', lenses: [{ id: 'left', label: clip(left.label ?? left.id, 120), match: { groups: [SIDE_IDS.left] } }, { id: 'right', label: clip(right.label ?? right.id, 120), match: { groups: [SIDE_IDS.right] } }], default_lens: null, deep_link: true },
    },
    evidence,
  };
}

/** pair_id: pair-<12 hex of sha256(canonical([local, other]))>. */
export function pairId(localNode, otherNode) { return `pair-${sha256Hex(canonical([localNode, otherNode])).slice(0, 12)}`; }

/** The rows of a kind "pair" proposal for the chosen candidate edges of a meet scene (all of them by default). */
export function pairRows(scene, edgeIds = null) {
  const byId = new Map(list(scene.nodes).map((n) => [n.id, n]));
  return list(scene.edges).filter((e) => e.kind === 'candidate' && (!edgeIds || edgeIds.includes(e.id))).map((e) => {
    const other = byId.get(e.to);
    return { pair_id: pairId(e.from, e.to), local_node: e.from, other_node: e.to, rule_ref: other && isObject(other.boundary) ? other.boundary.rule_ref : null, score: typeof e.weight === 'number' ? e.weight : 0 };
  });
}

export function boundariesPath(dataDir) { return join(dataDir, 'boundaries.json'); }
export function readBoundaries(dataDir) {
  const file = boundariesPath(dataDir);
  if (!existsSync(file)) return { schema_version: BOUNDARIES_SCHEMA_VERSION, pairs: [] };
  try { const doc = JSON.parse(readFileSync(file, 'utf8')); return isObject(doc) && Array.isArray(doc.pairs) ? doc : { schema_version: BOUNDARIES_SCHEMA_VERSION, pairs: [] }; } catch { return { schema_version: BOUNDARIES_SCHEMA_VERSION, pairs: [] }; }
}

/**
 * applyPairDecision({proposal, dataDir, now}) -> {applied, added, pairs, path}
 * After proposals.decide() returned a kind "pair" proposal in status approved
 * or edited, append its rows to data/boundaries.json (idempotent by pair_id).
 * Any other kind or status applies nothing.
 */
export function applyPairDecision({ proposal, dataDir, now } = {}) {
  if (now === undefined || now === null) throw new TypeError('applyPairDecision needs now (ctx.now)');
  if (!isObject(proposal) || proposal.kind !== 'pair') return { applied: false, added: 0, pairs: [], path: null, reason: 'not a pair proposal' };
  if (!['approved', 'edited'].includes(proposal.status)) return { applied: false, added: 0, pairs: [], path: null, reason: `status is ${String(proposal.status)}` };
  const doc = readBoundaries(dataDir);
  const have = new Set(doc.pairs.map((p) => p.pair_id));
  const added = [];
  for (const r of list(proposal.records)) {
    if (!isObject(r) || typeof r.pair_id !== 'string' || have.has(r.pair_id)) continue;
    have.add(r.pair_id);
    added.push({ pair_id: r.pair_id, local_node: r.local_node, other_node: r.other_node, rule_ref: r.rule_ref ?? null, accepted_on: today(now), proposal_id: proposal.proposal_id });
  }
  const pairs = [...doc.pairs, ...added];
  const path = writeJsonAtomic(boundariesPath(dataDir), { schema_version: BOUNDARIES_SCHEMA_VERSION, pairs });
  return { applied: true, added: added.length, pairs, path };
}
