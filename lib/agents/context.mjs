// What a desk may see (VISION 7.4): in a solo run, the records of the rooms
// in scope (handed in by the caller, who read them through the exit door);
// in a --between / --with run, only the meet scene's nodes, foreign nodes
// restricted to fields_allowed and every foreign value fenced. Pure.
import { fence, fenceBody, textOf } from './fence.mjs';

export const MAX_ITEMS = 40;
export const MAX_FIELD_CHARS = 200;
export const MAX_SUBLABEL_CHARS = 200;
/** A foreign value shorter than this is vocabulary both sides may share (a tag, a unit) and is fenced but not escape-checked. */
export const GUARD_MIN_CHARS = 12;
const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function manifestOf(room) {
  return room && room.manifest && typeof room.manifest === 'object' ? room.manifest : room;
}

/** A record of a room as a context item (local, unfenced): label, sublabel, tags and public_fields. */
export function itemFromRecord(room, record, index = 0) {
  const m = manifestOf(room);
  const rec = m.record || {};
  const rawId = record[rec.id_field];
  const idPart = typeof rawId === 'string' && ID_RE.test(rawId) ? rawId : `row-${index + 1}`;
  const fields = {};
  for (const f of rec.public_fields || []) if (record[f] !== undefined) fields[f] = clip(textOf(record[f]), MAX_FIELD_CHARS);
  return {
    id: `${m.id}:${idPart}`, room: m.id, side: m.id, foreign: false, person: null, rule: null,
    label: clip(textOf(record[rec.label_field]), 120),
    sublabel: rec.sublabel_field ? clip(textOf(record[rec.sublabel_field]), MAX_SUBLABEL_CHARS) : '',
    tags: Array.isArray(record[rec.tag_field]) ? record[rec.tag_field].map((t) => clip(textOf(t), 40)) : [],
    fields,
  };
}

/** Is this scene node owned by someone other than the owner (a boundary stub or an imported node)? */
export function isForeignNode(node, owner = 'self') {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'boundary' || node.boundary) return true;
  const p = node.provenance || {};
  return typeof p.owner_person_id === 'string' && p.owner_person_id !== owner;
}

/**
 * itemFromNode(node, {owner, fieldsAllowed}) -> context item. A foreign node
 * keeps only the fields its rule allows (fieldsAllowed[rule_ref], when given)
 * and is marked foreign with its person and rule_ref, so renderItem fences it.
 */
export function itemFromNode(node, { owner = 'self', fieldsAllowed = {} } = {}) {
  const foreign = isForeignNode(node, owner);
  const p = node.provenance || {};
  const b = node.boundary || {};
  const person = foreign ? (b.shared_by || p.owner_person_id || 'unknown') : null;
  const rule = foreign ? (b.rule_ref || p.imported_via_rule_ref || `${person}/none`) : null;
  const allowed = foreign && rule && Array.isArray(fieldsAllowed[rule]) ? new Set(fieldsAllowed[rule]) : null;
  const fields = {};
  for (const [k, v] of Object.entries(node.fields || {})) {
    if (allowed && !allowed.has(k)) continue;
    fields[k] = clip(textOf(v), MAX_FIELD_CHARS);
  }
  return {
    id: String(node.id), room: node.room ?? null, side: foreign ? person : (node.room ?? 'self'), foreign, person, rule,
    label: clip(textOf(node.label), 120), sublabel: clip(textOf(node.sublabel), MAX_SUBLABEL_CHARS),
    tags: Array.isArray(node.tags) ? node.tags.map((t) => clip(textOf(t), 40)) : [], fields,
  };
}

/**
 * buildContext({rooms, records, scene, owner, fieldsAllowed}) ->
 *   {items, foreignValues, spans, sides}
 * With a scene, only its nodes are context (never the rooms' records).
 * foreignValues: every raw foreign string (for scrubbing synthesis text);
 * guardValues: the foreign phrases (label, sublabel, field values of at least
 * GUARD_MIN_CHARS; never tags, nor a field that carries the tag list, since
 * shared vocabulary is what two centers meet on) whose raw appearance outside
 * a fence is DF_RUN_FOREIGN_UNFENCED; spans: [{person_id, rule_ref, text}] as fenced.
 */
export function buildContext({ rooms = [], records = {}, scene = null, owner = 'self', fieldsAllowed = {} } = {}) {
  let items = [];
  if (scene && Array.isArray(scene.nodes)) {
    items = scene.nodes.map((n) => itemFromNode(n, { owner, fieldsAllowed }));
  } else {
    for (const room of rooms) {
      const m = manifestOf(room);
      if (!m || !m.id) continue;
      const rows = Array.isArray(records[m.id]) ? records[m.id] : [];
      rows.forEach((r, i) => items.push(itemFromRecord(room, r, i)));
    }
  }
  items = items.slice(0, MAX_ITEMS);
  const foreignValues = [];
  const guardValues = [];
  const spans = [];
  for (const it of items) {
    if (!it.foreign) continue;
    for (const v of foreignStrings(it)) {
      foreignValues.push(v);
      spans.push({ person_id: it.person, rule_ref: it.rule, text: fenceBody(v) });
    }
    const tagList = it.tags.join(', ');
    const fieldValues = Object.entries(it.fields).filter(([k, v]) => k !== 'tags' && v !== tagList).map(([, v]) => v);
    for (const v of [it.label, it.sublabel, ...fieldValues]) if (v && v.length >= GUARD_MIN_CHARS) guardValues.push(v);
  }
  const sides = [...new Set(items.map((it) => it.side))].sort();
  return { items, foreignValues, guardValues, spans, sides };
}

/** The raw strings of a foreign item, in render order (label, sublabel, tags, field values). */
export function foreignStrings(item) {
  const out = [];
  if (item.label) out.push(item.label);
  if (item.sublabel) out.push(item.sublabel);
  for (const t of item.tags) if (t) out.push(t);
  for (const v of Object.values(item.fields)) if (v) out.push(v);
  return out;
}

/** One item as prompt lines; every value of a foreign item goes through fence(). */
export function renderItem(item) {
  const wrap = item.foreign ? (v) => fence(v, { person: item.person, rule: item.rule }) : (v) => String(v);
  const head = item.foreign ? `- [${item.id}] foreign node shared by ${item.person} under ${item.rule}` : `- [${item.id}]${item.room ? ` room ${item.room}` : ''}`;
  const lines = [head];
  if (item.label) lines.push(`  label: ${wrap(item.label)}`);
  if (item.sublabel) lines.push(`  sublabel: ${wrap(item.sublabel)}`);
  if (item.tags.length) lines.push(`  tags: ${item.tags.map(wrap).join(', ')}`);
  for (const [k, v] of Object.entries(item.fields)) lines.push(`  ${k}: ${wrap(v)}`);
  return lines.join('\n');
}

export function renderContext(items) {
  return items.length ? items.map(renderItem).join('\n') : '(no records in scope)';
}
