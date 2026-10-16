// The merged roster (VISION 1, 5, 14): the conductor from center.config.json
// plus every desk of every valid room, lifted unchanged. The roster is the
// one desk universe plan, run and the MCP enum share: router.mjs routes over
// it, loop.mjs prompts from it. Pure: no clock, no disk, no randomness.
import { canonical, sha256 } from '../digest.mjs';
import { fail, pass } from '../rules.mjs';
import { loadSchema, validate } from '../validate.mjs';

export const SCHEMA_VERSION = 'dotfield.roster/1';
export const CONDUCTOR_ID = 'conductor';
export const DESK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const DEFAULT_CONDUCTOR = Object.freeze({
  id: CONDUCTOR_ID,
  display: 'Conductor',
  lens: 'turn one question into a mission brief, route it to at most five desks and one challenger, and stop at awaiting_owner',
});
/** The desk keys room.schema.json#/$defs/desk admits, plus the two the roster adds. */
export const DESK_KEYS = Object.freeze(['id', 'display', 'tier', 'parent', 'room', 'domain', 'primary_field', 'adjacent_fields', 'lens', 'keywords', 'challenger_for', 'influences', 'constraint', 'prompt']);

function manifestOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.manifest && typeof entry.manifest === 'object') return entry.ok === false ? null : entry.manifest;
  return typeof entry.id === 'string' && Array.isArray(entry.desks) ? entry : null;
}

/** A desk lifted into roster shape: the room's keys unchanged, room and parent filled, arrays defaulted. */
export function liftDesk(desk, roomId = null) {
  const out = {};
  for (const k of DESK_KEYS) if (desk[k] !== undefined) out[k] = Array.isArray(desk[k]) ? [...desk[k]] : desk[k];
  out.room = roomId;
  if (out.parent === undefined) out.parent = null;
  for (const k of ['adjacent_fields', 'challenger_for', 'influences']) if (!Array.isArray(out[k])) out[k] = [];
  if (out.prompt === undefined) out.prompt = null;
  return out;
}

export function conductorOf(config) {
  const c = config && config.conductor && typeof config.conductor === 'object' ? config.conductor : {};
  return {
    id: CONDUCTOR_ID,
    display: typeof c.display === 'string' && c.display ? c.display : DEFAULT_CONDUCTOR.display,
    lens: typeof c.lens === 'string' && c.lens ? c.lens : DEFAULT_CONDUCTOR.lens,
  };
}

/**
 * buildRoster(rooms, config) -> {roster, checks, ok}
 * rooms: discoverRooms().rooms entries (invalid rooms contribute nothing) or
 * bare manifests. Desks are sorted by id; a duplicate id across rooms keeps
 * the first room (sorted by room id) and drops the rest; an unknown
 * challenger_for or influences target is a DF_RUN_DESK_UNKNOWN failure on
 * that desk's path. roster.digest = sha256(canonical(roster minus digest)).
 */
export function buildRoster(rooms, config = null) {
  const checks = [];
  const manifests = (Array.isArray(rooms) ? rooms : []).map(manifestOf).filter(Boolean)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map();
  const sources = [];
  let duplicates = 0;
  for (const m of manifests) {
    const ids = [];
    (Array.isArray(m.desks) ? m.desks : []).forEach((d, i) => {
      if (!d || typeof d !== 'object' || !DESK_ID_RE.test(String(d.id))) return;
      if (d.id === CONDUCTOR_ID || byId.has(d.id)) {
        duplicates += 1;
        const where = d.id === CONDUCTOR_ID ? 'the conductor id is reserved' : `already declared by room ${byId.get(d.id).room}`;
        checks.push(fail('DF_RUN_DESK_UNKNOWN', { path: `center/rooms/${m.id}/room.json#$.desks[${i}].id`, detail: `duplicate desk id '${d.id}' (${where}); this copy is dropped from the roster` }));
        return;
      }
      byId.set(d.id, liftDesk(d, m.id));
      ids.push(d.id);
    });
    sources.push({ room: m.id, desk_ids: ids });
  }
  const desks = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  let unknown = 0;
  for (const d of desks) {
    for (const key of ['challenger_for', 'influences']) {
      d[key].forEach((target, i) => {
        if (byId.has(target)) return;
        unknown += 1;
        checks.push(fail('DF_RUN_DESK_UNKNOWN', { path: `center/rooms/${d.room}/room.json#$.desks[${d.id}].${key}[${i}]`, detail: `'${target}' is not a desk in the merged roster` }));
      });
    }
  }
  if (!duplicates && !unknown) checks.push(pass('DF_RUN_DESK_UNKNOWN'));
  const roster = { schema_version: SCHEMA_VERSION, conductor: conductorOf(config), desks, sources, digest: null };
  roster.digest = sha256(canonical({ ...roster, digest: undefined }));
  const v = validate(loadSchema('roster'), roster);
  for (const e of v.errors) checks.push(fail(e.code, { path: `roster#${e.path}`, detail: e.message }));
  return { roster, checks, ok: !checks.some((c) => c.status === 'fail' && c.blocking) };
}

/** The desk ids of a roster, sorted: the enum plan, run and the MCP tool share. */
export function deskIds(roster) {
  return (roster && Array.isArray(roster.desks) ? roster.desks : []).map((d) => d.id).sort();
}

export function deskById(roster, id) {
  return (roster && Array.isArray(roster.desks) ? roster.desks : []).find((d) => d.id === id) || null;
}

/** Desks of the given rooms (null or empty = every desk). */
export function desksForRooms(roster, roomIds = null) {
  const desks = roster && Array.isArray(roster.desks) ? roster.desks : [];
  if (!Array.isArray(roomIds) || !roomIds.length) return [...desks];
  const set = new Set(roomIds);
  return desks.filter((d) => set.has(d.room));
}
