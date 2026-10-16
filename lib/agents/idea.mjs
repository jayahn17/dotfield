// The one record a run proposes: an idea note shaped by the target room's
// manifest (id_field, label_field, sublabel_field, tag_field, dates) and
// trimmed to what its record.schema.json declares. Zero-code rooms get a
// valid record; a room whose schema demands more fails DF_RECORD_* inside
// propose() and the run reports it. Pure.
import { scrub, stripFences, textOf } from './fence.mjs';

export const IDEA_TAGS = Object.freeze(['idea', 'run']);
const DEFAULT_MAX = 1000;

function manifestOf(room) {
  return room && room.manifest && typeof room.manifest === 'object' ? room.manifest : room;
}

function propertyOf(room, field) {
  const schema = room && room.recordSchema && typeof room.recordSchema === 'object' ? room.recordSchema : null;
  if (!schema || !schema.properties || !field) return null;
  return schema.properties[field] || null;
}

function maxLengthOf(room, field, fallback) {
  const p = propertyOf(room, field);
  return p && Number.isInteger(p.maxLength) ? p.maxLength : fallback;
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n).trimEnd() : t;
}

/** Choose the room that receives the idea: targetRoom by id, else a room named notes, else the first proposal_only room. */
export function pickTargetRoom(rooms, targetRoom = null) {
  const list = (Array.isArray(rooms) ? rooms : []).filter((r) => manifestOf(r) && manifestOf(r).id);
  if (targetRoom) return list.find((r) => manifestOf(r).id === targetRoom) || null;
  return list.find((r) => manifestOf(r).id === 'notes') || list.find((r) => manifestOf(r).mode === 'proposal_only') || list[0] || null;
}

/** The synthesis text a record may carry: fences replaced by markers, every raw foreign value scrubbed. */
export function safeText(text, foreignValues = []) {
  return scrub(stripFences(textOf(text)), foreignValues);
}

/**
 * buildIdeaRecord(room, {runId, task, synthesis, date, foreignValues}) -> record
 * Only fields the manifest names and the schema declares are set; the id is
 * run-<digits>-idea so it never collides with an imported record.
 */
export function buildIdeaRecord(room, { runId, task, synthesis, date, foreignValues = [] } = {}) {
  const m = manifestOf(room);
  const rec = m.record || {};
  const record = {};
  const idPart = String(runId).replace(/^run_/, '').replace(/[^a-z0-9]/g, '-');
  if (rec.id_field) record[rec.id_field] = `run-${idPart}-idea`;
  if (rec.label_field) record[rec.label_field] = clip(safeText(task, foreignValues), maxLengthOf(room, rec.label_field, 120)) || 'Run idea';
  if (rec.sublabel_field && rec.sublabel_field !== rec.label_field) {
    record[rec.sublabel_field] = clip(safeText(synthesis, foreignValues), maxLengthOf(room, rec.sublabel_field, DEFAULT_MAX)) || `Synthesis of run ${runId}`;
  }
  if (rec.tag_field && (!propertyOf(room, rec.tag_field) || propertyOf(room, rec.tag_field).type === 'array')) record[rec.tag_field] = [...IDEA_TAGS];
  const dates = rec.dates || {};
  for (const key of ['remembered_on', 'happened_on']) {
    const field = dates[key];
    if (field && record[field] === undefined && date) record[field] = date;
  }
  return record;
}
