// archify sequence → kind sequence (references/IR.md §9). Participants become
// nodes in archify order (the sequence lanes; kind by archify type, see
// PARTICIPANT_KINDS), messages become message edges whose order is the dense
// rank of archify's y (equal y = one beat), else the file's own integer
// order, else the document order (then listed by a non-blocking
// DF_IMPORT_ORDER_FILLED). Return and dashed variants draw dashed, a self
// message stays (the layout loops it), activations round-trip under
// ext.archify.activations with the beats their y range spans, and segments
// become views.interactive.steps (the messages a segment's range covers, the
// participants they touch, the playhead at its last beat). A second message on
// one ordered pair is kept only where the topology gate allows it
// (repeatsAllowed: DF_IR_DUP_EDGE); otherwise its label merges into the first
// and it is listed in `dropped`. views.2d carries no viewBox (the layout sizes
// it from the beats), views.3d lifts flat, views.time is an order axis
// stepping by beat, motion trace when archify animates, else still.
import { clip, idMinter, isObject, seriesFor, unit } from './common.mjs';
import { edgeIds, firstArray, intOf, makeNode, orderFilled, orderTime, pick, repeatsAllowed, rest, textOf } from './archify.mjs';

/** Archify participant type → node kind (the glyph): actors are people, services desks, stores records, transports and guards assets. */
export const PARTICIPANT_KINDS = Object.freeze({
  external: 'person', actor: 'person', user: 'person', person: 'person',
  frontend: 'desk', backend: 'desk', service: 'desk', agent: 'desk', worker: 'desk',
  database: 'record', datastore: 'record', store: 'record', cache: 'record', storage: 'record',
  messagebus: 'asset', queue: 'asset', stream: 'asset', security: 'asset', cloud: 'asset',
});
/** Archify message variants drawn dashed; every other variant is solid. */
export const DASHED_VARIANTS = Object.freeze(['return', 'dashed', 'async', 'reply']);
const PARTICIPANT_KEYS = new Set(['id', 'label', 'name', 'title', 'sublabel', 'description', 'tags', 'weight', 'sources']);
const MESSAGE_KEYS = new Set(['id', 'from', 'to', 'source', 'target', 'label', 'order', 'weight']);

export const participantKind = (type) => PARTICIPANT_KINDS[type] ?? 'asset';

/** Dense 1-based rank of each key (equal keys share a rank). */
function ranks(keys) {
  const at = new Map([...new Set(keys)].sort((a, b) => a - b).map((v, k) => [v, k + 1]));
  return keys.map((v) => at.get(v));
}

/** The message index of every key inside [from, to] (the segment or activation range on the message axis). */
function within(keys, raw) {
  const lo = Number(raw.from); const hi = Number(raw.to);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  return keys.map((v, k) => (v >= lo && v <= hi ? k : -1)).filter((k) => k >= 0);
}

export function runSequence(base, items) {
  const { doc, scene, ext } = base;
  scene.views['2d'] = { layout: 'sequence', seed: 0 };
  scene.views['3d'].lift = { mode: 'flat', amplitude_m: 0 };
  Object.assign(ext, { participants: {}, messages: {} });
  const ids = idMinter(); const dropped = [];
  items.forEach((raw, i) => {
    const p = typeof raw === 'string' ? { id: raw } : raw;
    const sourceId = String(pick(p, ['id', 'label', 'name', 'title']) ?? `participant-${i + 1}`);
    if (ids.has(sourceId)) { dropped.push({ participant: sourceId, why: 'duplicate participant' }); return; }
    const nid = ids.mint(sourceId, 'participant');
    const type = String(p.type ?? p.kind ?? 'participant').toLowerCase();
    scene.nodes.push(makeNode(base, p, { nid, kind: participantKind(type), text: pick(p, ['label', 'name', 'title']) ?? sourceId, tags: [type, ...(Array.isArray(p.tags) ? p.tags : [])], colorToken: seriesFor(type) }));
    ext.participants[nid] = { ...rest(p, PARTICIPANT_KEYS), source_id: sourceId };
  });

  const msgs = firstArray(doc, ['messages', 'edges']).filter(isObject);
  const ys = msgs.map((m) => (m.y === null || m.y === '' ? NaN : Number(m.y)));
  const byY = msgs.length > 0 && ys.every(Number.isFinite);
  const byOrder = !byY && msgs.length > 0 && msgs.every((m) => intOf(m.order) !== null);
  const keys = byY ? ys : (byOrder ? msgs.map((m) => intOf(m.order)) : msgs.map((_, k) => k + 1));
  const orders = byY ? ranks(keys) : keys;
  if (msgs.length && !byY && !byOrder) orderFilled(base, '$.messages', 'numbered in document order (no message carries both a y and an order everywhere)', msgs.length, msgs.length);
  const keep = repeatsAllowed('sequence', 'message');
  const mint = edgeIds(); const pairs = new Map(); const edgeOf = msgs.map(() => null);
  msgs.forEach((m, k) => {
    const fromRaw = pick(m, ['from', 'source']); const toRaw = pick(m, ['to', 'target']);
    const from = ids.get(fromRaw); const to = ids.get(toRaw);
    const eid = mint(m.id, k); const text = textOf(m.label);
    if (!from || !to) { dropped.push({ id: eid, from: fromRaw, to: toRaw, label: text, why: 'unknown participant' }); return; }
    const pair = `${from}>${to}`;
    if (!keep && pairs.has(pair)) {
      const first = pairs.get(pair);
      if (text && first.label !== text) first.label = clip(first.label ? `${first.label}; ${text}` : text, 120);
      dropped.push({ id: eid, from, to, label: text, order: orders[k], why: `repeated message, merged into ${first.id} (DF_IR_DUP_EDGE: one message per from and to)` });
      edgeOf[k] = first.id;
      return;
    }
    const edge = { id: eid, from, to, kind: 'message', directed: true };
    if (text) edge.label = text;
    edge.order = orders[k];
    edge.variant = DASHED_VARIANTS.includes(String(m.variant ?? '').toLowerCase()) ? 'dashed' : 'solid';
    edge.route = 'straight';
    if (m.weight !== undefined) edge.weight = unit(m.weight, 0.5);
    pairs.set(pair, edge); scene.edges.push(edge); edgeOf[k] = eid;
    const leftovers = rest(m, MESSAGE_KEYS);
    if (Object.keys(leftovers).length) ext.messages[eid] = leftovers;
  });
  if (dropped.length) ext.dropped_messages = dropped;

  const ranged = byY || byOrder;
  const acts = (Array.isArray(doc.activations) ? doc.activations : []).filter(isObject).map((a) => {
    const nid = ids.get(pick(a, ['participant', 'lifeline']));
    const out = { ...a, participant: nid ?? a.participant };
    if (!nid) out.unknown_participant = true;
    const inside = ranged ? within(keys, a).map((k) => orders[k]) : [];
    if (inside.length) out.beats = [Math.min(...inside), Math.max(...inside)];
    return out;
  });
  if (acts.length) ext.activations = acts;
  const segments = (Array.isArray(doc.segments) ? doc.segments : []).filter(isObject);
  if (segments.length) ext.segments = segments;
  const order = new Map(scene.nodes.map((n, i) => [n.id, i]));
  const byId = new Map(scene.edges.map((e) => [e.id, e]));
  const steps = [];
  if (ranged) {
    segments.forEach((sg, s) => {
      const covered = within(keys, sg).filter((k) => edgeOf[k]);
      if (!covered.length || steps.length >= 64) return;
      const edges = [...new Set(covered.map((k) => edgeOf[k]))];
      const touched = new Set(edges.flatMap((eid) => [byId.get(eid).from, byId.get(eid).to]));
      steps.push({ id: `segment-${s + 1}`, label: textOf(sg.label) ?? `Segment ${s + 1}`, nodes: [...touched].sort((a, b) => order.get(a) - order.get(b)), edges, playhead: Math.max(...covered.map((k) => orders[k])) });
    });
  }
  scene.views.time = orderTime(base, 'still');
  return { steps: steps.length ? steps : null, dropped };
}
