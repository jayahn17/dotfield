// Rooms (VISION §2.2, §5): one folder center/rooms/<id>/ is one room,
// discovered at boot. discoverRooms() reads the four files, validates them
// (room.schema.json, record-meta.schema.json, the views grammar in
// room.schema.json#/$defs/views_file), cross-checks the manifest against the
// record schema and the other rooms, reads the prove state, and returns one
// check list; buildRegistry() derives .dotfield/registry.json from it.
// kindsFor() is the one node-kind table (renderers/shapes.json under the
// installed packs' kinds.json, center/kinds.json and a sketch's kinds). This
// file never imports lib/store.mjs: it describes rooms, it does not open them.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha256, sha256File } from './digest.mjs';
import { RULES, fail, pass } from './rules.mjs';
import { loadSchema, validate } from './validate.mjs';

export const ROOM_FILES = Object.freeze(['room.json', 'record.schema.json', 'views.json', 'examples.json']);
export const OPTIONAL_FILES = Object.freeze(['test.mjs', 'actions.mjs']);
export const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const REGISTRY_SCHEMA_VERSION = 'dotfield.registry/1';
export const PROVE_SCHEMA_VERSION = 'dotfield.prove/1';
export const DEPRECATED_MODE = 'write_after_approval';
const PATH_RE = /^\$((?:\.[a-z][a-z0-9_]{0,63}(?:\[(?:\*|0|[1-9][0-9]{0,3})\])?){1,6})(?:\/([1-9][0-9]{0,5}))?$/;
const EXPR_KEYS = ['date', 'lane', 'pose'];
let VIEWS_SCHEMA = null;

function readJson(file) {
  try { return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** DF_SCHEMA_* validator errors as checks, paths prefixed with the file they concern. */
export function schemaChecks(errors, prefix) {
  return errors.map((e) => ({ code: e.code, gate: RULES[e.code].gate, blocking: RULES[e.code].blocking, status: 'fail', path: `${prefix}#${e.path}`, message: e.message, repair: e.repair }));
}

/** tmp + fsync + rename of a JSON document (2-space, trailing newline); returns the path. */
export function writeJsonAtomic(file, doc) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return file;
}

/** parsePath('$.a.b[0]/10') -> {ok, segments: [{key, index: null | '*' | n}], divide: n | null}. */
export function parsePath(expr) {
  const m = typeof expr === 'string' ? PATH_RE.exec(expr) : null;
  if (!m) return { ok: false, segments: [], divide: null };
  const segments = [];
  for (const part of m[1].slice(1).split('.')) {
    const s = /^([a-z][a-z0-9_]*)(?:\[(\*|[0-9]+)\])?$/.exec(part);
    segments.push({ key: s[1], index: s[2] === undefined ? null : (s[2] === '*' ? '*' : Number(s[2])) });
  }
  return { ok: true, segments, divide: m[2] ? Number(m[2]) : null };
}

/** Evaluate a views.json path against one record; [*] maps over an array; /n divides numbers; undefined when absent. */
export function evalPath(record, expr) {
  const p = parsePath(expr);
  if (!p.ok) return undefined;
  const step = (value, i) => {
    if (i === p.segments.length) return value;
    const { key, index } = p.segments[i];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const next = value[key];
    if (index === null) return step(next, i + 1);
    if (!Array.isArray(next)) return undefined;
    if (index === '*') return next.map((item) => step(item, i + 1)).filter((v) => v !== undefined);
    return step(next[index], i + 1);
  };
  const out = step(record, 0);
  if (p.divide === null) return out;
  if (typeof out === 'number') return out / p.divide;
  if (Array.isArray(out)) return out.map((v) => (typeof v === 'number' ? v / p.divide : v));
  return out;
}

/** Defaults filled in and the removed mode mapped; returns {manifest, checks}. */
export function normalizeManifest(doc) {
  const checks = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { manifest: doc, checks };
  const manifest = structuredClone(doc);
  if (manifest.mode === DEPRECATED_MODE) {
    checks.push(fail('DF_ROOM_MODE_DEPRECATED', { path: 'room.json#$.mode', detail: `${DEPRECATED_MODE} is read as proposal_only` }));
    manifest.mode = 'proposal_only';
  } else checks.push(pass('DF_ROOM_MODE_DEPRECATED'));
  if (manifest.store && typeof manifest.store === 'object') {
    manifest.store.max_records ??= 2000;
    manifest.store.max_record_bytes ??= 16384;
  }
  if (manifest.record && typeof manifest.record === 'object') {
    manifest.record.dates ??= {};
    manifest.record.link_fields ??= [];
  }
  manifest.icon ??= 'room';
  manifest.pack ??= null;
  for (const d of Array.isArray(manifest.desks) ? manifest.desks : []) {
    if (d && typeof d === 'object') { d.adjacent_fields ??= []; d.challenger_for ??= []; d.influences ??= []; d.prompt ??= null; }
  }
  return { manifest, checks };
}

/** Every record field the manifest names (id, label, sublabel, tag, weight, dates, link fields, public_fields). */
export function manifestFields(manifest) {
  const r = manifest && manifest.record ? manifest.record : {};
  const out = [];
  for (const k of ['id_field', 'label_field', 'sublabel_field', 'tag_field', 'weight_field']) if (typeof r[k] === 'string') out.push({ at: `$.record.${k}`, field: r[k] });
  for (const [k, v] of Object.entries(r.dates || {})) if (typeof v === 'string') out.push({ at: `$.record.dates.${k}`, field: v });
  (Array.isArray(r.link_fields) ? r.link_fields : []).forEach((l, i) => { if (l && typeof l.field === 'string') out.push({ at: `$.record.link_fields[${i}].field`, field: l.field }); });
  (Array.isArray(r.public_fields) ? r.public_fields : []).forEach((f, i) => { if (typeof f === 'string') out.push({ at: `$.record.public_fields[${i}]`, field: f }); });
  return out;
}

function checkFields(manifest, recordSchema) {
  const declared = recordSchema && recordSchema.properties && typeof recordSchema.properties === 'object' ? recordSchema.properties : {};
  const out = [];
  for (const { at, field } of manifestFields(manifest)) {
    if (!Object.hasOwn(declared, field)) out.push(fail('DF_ROOM_FIELD_MISSING', { path: `room.json#${at}`, detail: `'${field}' is not in record.schema.json properties` }));
  }
  if (!out.length) out.push(pass('DF_ROOM_FIELD_MISSING'));
  return out;
}

function viewsSchema() {
  if (!VIEWS_SCHEMA) VIEWS_SCHEMA = { $ref: '#/$defs/views_file', $defs: loadSchema('room').$defs };
  return VIEWS_SCHEMA;
}

function exprsOf(view) {
  const out = [];
  const node = view.node && typeof view.node === 'object' ? view.node : {};
  for (const k of ['label', 'sublabel', 'tags', 'weight']) if (typeof node[k] === 'string') out.push({ at: `node.${k}`, expr: node[k] });
  if (node.color_token_by && typeof node.color_token_by.field === 'string') out.push({ at: 'node.color_token_by.field', expr: node.color_token_by.field });
  for (const k of EXPR_KEYS) if (typeof view[k] === 'string') out.push({ at: k, expr: view[k] });
  if (view.group_by && typeof view.group_by.field === 'string') out.push({ at: 'group_by.field', expr: view.group_by.field });
  return out;
}

/** views.json against the grammar plus the semantic rules (timeline needs date, board needs lane, fields declared, lenses resolve). */
export function checkViews(views, recordSchema, roomIds = []) {
  const out = schemaChecks(validate(viewsSchema(), views).errors, 'views.json').map((c) => fail('DF_ROOM_VIEW_INVALID', { path: c.path, detail: c.message }));
  const declared = recordSchema && recordSchema.properties ? recordSchema.properties : {};
  const ids = new Set();
  let unknownRooms = 0;
  (Array.isArray(views) ? views : []).forEach((view, i) => {
    if (!view || typeof view !== 'object') return;
    const at = `views.json#$[${i}]`;
    if (ids.has(view.id)) out.push(fail('DF_ROOM_VIEW_INVALID', { path: `${at}.id`, detail: `view id '${view.id}' is used twice` }));
    ids.add(view.id);
    if (view.kind === 'timeline' && typeof view.date !== 'string') out.push(fail('DF_ROOM_VIEW_INVALID', { path: `${at}.date`, detail: 'a timeline view needs date: "$.<field>"' }));
    if (view.kind === 'board' && typeof view.lane !== 'string') out.push(fail('DF_ROOM_VIEW_INVALID', { path: `${at}.lane`, detail: 'a board view needs lane: "$.<field>"' }));
    for (const { at: key, expr } of exprsOf(view)) {
      const p = parsePath(expr);
      if (p.ok && !Object.hasOwn(declared, p.segments[0].key)) out.push(fail('DF_ROOM_VIEW_INVALID', { path: `${at}.${key}`, detail: `'${expr}' names field '${p.segments[0].key}', which record.schema.json does not declare` }));
    }
    const lenses = new Set((Array.isArray(view.lenses) ? view.lenses : []).map((l) => l && l.id));
    if (view.limit && typeof view.limit.default_lens === 'string' && !lenses.has(view.limit.default_lens)) out.push(fail('DF_ROOM_VIEW_INVALID', { path: `${at}.limit.default_lens`, detail: `lens '${view.limit.default_lens}' is not declared in lenses[]` }));
    for (const r of Array.isArray(view.include_rooms) ? view.include_rooms : []) {
      if (!roomIds.includes(r)) { unknownRooms += 1; out.push(fail('DF_ROOM_LINK_ROOM_UNKNOWN', { path: `${at}.include_rooms`, detail: `room '${r}' is not in the center` })); }
    }
  });
  if (!out.some((c) => c.code === 'DF_ROOM_VIEW_INVALID')) out.unshift(pass('DF_ROOM_VIEW_INVALID'));
  if (!unknownRooms) out.push(pass('DF_ROOM_LINK_ROOM_UNKNOWN'));
  return out;
}

/** examples.json: 3 to 20 records, each valid for record.schema.json. */
export function checkExamples(examples, recordSchema) {
  const out = [];
  if (!Array.isArray(examples)) return [fail('DF_ROOM_EXAMPLES_INVALID', { path: 'examples.json#$', detail: 'not an array' })];
  if (examples.length < 3 || examples.length > 20) out.push(fail('DF_ROOM_EXAMPLES_INVALID', { path: 'examples.json#$', detail: `${examples.length} records; 3 to 20 are required` }));
  examples.forEach((ex, i) => {
    const r = validate(recordSchema, ex);
    if (!r.ok) out.push(fail('DF_ROOM_EXAMPLES_INVALID', { path: `examples.json#$[${i}]`, detail: `${r.errors[0].code} at ${r.errors[0].path}: ${r.errors[0].message}` }));
  });
  if (!out.length) out.push(pass('DF_ROOM_EXAMPLES_INVALID'));
  return out;
}

/** The prove record under .dotfield/prove/<id>.json, compared to the manifest digest it was taken for. */
export function proveState(dotDir, roomId, manifestDigest) {
  const file = dotDir ? join(dotDir, 'prove', `${roomId}.json`) : null;
  if (!file || !existsSync(file)) return { present: false, ok: null, current: false, maturity_reached: null, path: file };
  const r = readJson(file);
  if (!r.ok || !r.doc || typeof r.doc !== 'object') return { present: true, ok: false, current: false, maturity_reached: null, path: file };
  return { present: true, ok: r.doc.ok === true, current: r.doc.manifest_digest === manifestDigest, maturity_reached: r.doc.maturity_reached ?? null, path: file };
}

function maturityChecks(manifest, files, prove) {
  const out = [];
  if (manifest.maturity === 'tested' && !files['test.mjs']) out.push(fail('DF_ROOM_MATURITY_OVERCLAIM', { path: 'room.json#$.maturity', detail: 'tested needs a test.mjs the sandbox can run' }));
  else out.push(pass('DF_ROOM_MATURITY_OVERCLAIM'));
  if (!prove.present) out.push(fail('DF_ROOM_MATURITY_UNPROVEN', { path: 'room.json#$.maturity', detail: 'no prove record under .dotfield/prove/' }));
  else if (!prove.current) out.push(fail('DF_ROOM_MATURITY_UNPROVEN', { path: 'room.json#$.maturity', detail: 'the prove record predates this room.json; run dotfield prove again' }));
  else if (!prove.ok) out.push({ ...fail('DF_ROOM_MATURITY_UNPROVEN', { path: 'room.json#$.maturity', detail: 'the last prove of this exact manifest failed' }), blocking: true });
  else out.push(pass('DF_ROOM_MATURITY_UNPROVEN'));
  return out;
}

/**
 * loadRoom(centerDir, id, {dotDir, roomIds}) -> one discovered room:
 * {id, dir, ok, manifest, recordSchema, views, examples, files, prove, manifest_digest, checks}.
 * Cross-room checks (link targets, shared namespaces) need roomIds and are
 * completed by discoverRooms().
 */
export function loadRoom(centerDir, id, { dotDir = null, roomIds = null } = {}) {
  const dir = join(centerDir, 'rooms', id);
  const checks = [];
  const files = {};
  const prefix = (f) => `center/rooms/${id}/${f}`;
  for (const f of [...ROOM_FILES, ...OPTIONAL_FILES]) {
    const p = join(dir, f);
    files[f] = existsSync(p) && statSync(p).isFile() ? p : null;
  }
  const room = { id, dir, ok: false, manifest: null, recordSchema: null, views: null, examples: null, files, prove: null, manifest_digest: null, checks };
  const docs = {};
  for (const f of ROOM_FILES) {
    if (!files[f]) { checks.push(fail('DF_ROOM_FILE_MISSING', { path: prefix(f), detail: `${f} is absent` })); continue; }
    const r = readJson(files[f]);
    if (!r.ok) checks.push(fail('DF_ROOM_FILE_MISSING', { path: prefix(f), detail: `${f} is not valid JSON (${r.error})` }));
    else docs[f] = r.doc;
  }
  if (!checks.some((c) => c.code === 'DF_ROOM_FILE_MISSING')) checks.push(pass('DF_ROOM_FILE_MISSING'));
  if (!docs['room.json']) return room;
  const raw = docs['room.json'];
  room.manifest_digest = sha256File(files['room.json']);
  if (raw && typeof raw === 'object' && raw.proof && typeof raw.proof === 'object' && Object.hasOwn(raw.proof, 'command')) {
    checks.push(fail('DF_ROOM_PROOF_COMMAND_FORBIDDEN', { path: `${prefix('room.json')}#$.proof.command`, detail: 'a shell string is never a proof' }));
    delete raw.proof.command;
  } else checks.push(pass('DF_ROOM_PROOF_COMMAND_FORBIDDEN'));
  const norm = normalizeManifest(raw);
  checks.push(...norm.checks);
  const v = validate(loadSchema('room'), norm.manifest);
  checks.push(...schemaChecks(v.errors, prefix('room.json')));
  if (!v.ok) return room;
  room.manifest = norm.manifest;
  if (norm.manifest.id === id) checks.push(pass('DF_ROOM_ID_MISMATCH'));
  else checks.push(fail('DF_ROOM_ID_MISMATCH', { path: `${prefix('room.json')}#$.id`, detail: `id '${norm.manifest.id}' in folder '${id}'` }));
  if (docs['record.schema.json']) {
    const rs = validate(loadSchema('record-meta'), docs['record.schema.json']);
    checks.push(...schemaChecks(rs.errors, prefix('record.schema.json')));
    if (rs.ok) {
      room.recordSchema = docs['record.schema.json'];
      checks.push(...checkFields(norm.manifest, room.recordSchema));
      if (docs['views.json']) { room.views = docs['views.json']; checks.push(...checkViews(room.views, room.recordSchema, roomIds ?? [id])); }
      if (docs['examples.json']) { room.examples = docs['examples.json']; checks.push(...checkExamples(room.examples, room.recordSchema)); }
    }
  }
  room.prove = proveState(dotDir, id, room.manifest_digest);
  checks.push(...maturityChecks(norm.manifest, files, room.prove));
  room.ok = !checks.some((c) => c.status === 'fail' && c.blocking);
  return room;
}

/** Folder names under center/rooms/ that are valid room ids, sorted. */
export function listRoomIds(centerDir) {
  const dir = join(centerDir, 'rooms');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && ROOM_ID_RE.test(e.name)).map((e) => e.name).sort();
}

/**
 * discoverRooms(centerDir, {dotDir}) -> {rooms, checks, ok}. Every folder
 * under center/rooms/ with a valid id is a room; checks carry every room's
 * findings (paths prefixed center/rooms/<id>/…) plus the cross-room ones:
 * DF_ROOM_NAMESPACE_SHARED and DF_ROOM_LINK_ROOM_UNKNOWN for link_fields.
 */
export function discoverRooms(centerDir, { dotDir = null } = {}) {
  const ids = listRoomIds(centerDir);
  const rooms = ids.map((id) => loadRoom(centerDir, id, { dotDir, roomIds: ids }));
  const checks = rooms.flatMap((r) => r.checks);
  const byNamespace = new Map();
  for (const r of rooms) {
    if (!r.manifest) continue;
    const ns = r.manifest.store.namespace;
    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns).push(r.id);
  }
  let shared = 0;
  for (const [ns, owners] of byNamespace) {
    if (owners.length < 2) continue;
    shared += 1;
    for (const id of owners) {
      const c = fail('DF_ROOM_NAMESPACE_SHARED', { path: `center/rooms/${id}/room.json#$.store.namespace`, detail: `'${ns}' is also used by ${owners.filter((o) => o !== id).join(', ')}` });
      checks.push(c);
      rooms.find((r) => r.id === id).checks.push(c);
    }
  }
  if (!shared) checks.push(pass('DF_ROOM_NAMESPACE_SHARED'));
  let unknown = 0;
  for (const r of rooms) {
    if (!r.manifest) continue;
    r.manifest.record.link_fields.forEach((l, i) => {
      if (ids.includes(l.to_room)) return;
      unknown += 1;
      const c = fail('DF_ROOM_LINK_ROOM_UNKNOWN', { path: `center/rooms/${r.id}/room.json#$.record.link_fields[${i}].to_room`, detail: `'${l.to_room}' is not in the center` });
      checks.push(c);
      r.checks.push(c);
    });
  }
  if (!unknown && !checks.some((c) => c.code === 'DF_ROOM_LINK_ROOM_UNKNOWN')) checks.push(pass('DF_ROOM_LINK_ROOM_UNKNOWN'));
  for (const r of rooms) r.ok = Boolean(r.manifest) && !r.checks.some((c) => c.status === 'fail' && c.blocking);
  return { rooms, checks, ok: !checks.some((c) => c.status === 'fail' && c.blocking) };
}

/** center/center.config.json validated against center-config.schema.json -> {ok, config, checks, path}. */
export function loadConfig(centerDir) {
  const file = join(centerDir, 'center.config.json');
  const rel = 'center/center.config.json';
  if (!existsSync(file)) return { ok: false, config: null, path: file, checks: [fail('DF_SCHEMA_REQUIRED', { path: rel, detail: 'center.config.json is absent; run dotfield init' })] };
  const r = readJson(file);
  if (!r.ok) return { ok: false, config: null, path: file, checks: [fail('DF_SCHEMA_TYPE', { path: rel, detail: `not valid JSON (${r.error})` })] };
  const v = validate(loadSchema('center-config'), r.doc);
  return { ok: v.ok, config: v.ok ? r.doc : null, path: file, checks: v.ok ? [pass('DF_SCHEMA_REQUIRED')] : schemaChecks(v.errors, rel) };
}

/** The derived registry (.dotfield/registry.json): valid rooms only, invalid ones listed by id and failing codes. Pure; no clock. */
export function buildRegistry(rooms, config = null) {
  const entries = rooms.filter((r) => r.ok && r.manifest).map((r) => {
    const m = r.manifest;
    return {
      id: r.id, label: m.label, icon: m.icon, pack: m.pack, purpose: m.purpose, mode: m.mode, privacy_mode: m.privacy_mode, maturity: m.maturity,
      store: { ...m.store }, record: { ...m.record }, owner_gates: { ...m.owner_gates }, blocked_actions: [...m.blocked_actions], proof: { ...m.proof },
      views: (Array.isArray(r.views) ? r.views : []).map((v) => ({ id: v.id, label: v.label, kind: v.kind })),
      desks: (m.desks || []).map((d) => ({ id: d.id, display: d.display, tier: d.tier })),
      files: { test: Boolean(r.files['test.mjs']), actions: Boolean(r.files['actions.mjs']) },
      prove: { present: r.prove.present, ok: r.prove.ok, current: r.prove.current, maturity_reached: r.prove.maturity_reached },
      manifest_digest: r.manifest_digest,
    };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const invalid = rooms.filter((r) => !r.ok).map((r) => ({ id: r.id, codes: [...new Set(r.checks.filter((c) => c.status === 'fail' && c.blocking).map((c) => c.code))].sort() }));
  const registry = {
    schema_version: REGISTRY_SCHEMA_VERSION,
    center: { name: config && config.center ? config.center.name : null, owner_person_id: config && config.center ? config.center.owner_person_id : 'self' },
    rooms: entries, invalid, digest: null,
  };
  registry.digest = sha256(canonical({ ...registry, digest: undefined }));
  return registry;
}

export function writeRegistry(registry, dotDir) {
  return writeJsonAtomic(join(dotDir, 'registry.json'), registry);
}

export function roomIdOf(dir) {
  return basename(dir);
}

// ── x- kinds (V2_PLAN §7.2) ────────────────────────────────────────────────
export const KINDS_VERSION = 'dotfield.kinds/1';
const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kindsMemo = new WeakMap();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * kindsTable(ctx, {sketchKinds, inlinePath}) -> {kinds, checks, sources}: renderers/shapes.json
 * <- every installed pack's kinds.json (installed_packs order) <- center/kinds.json <- the inline
 * sketch kinds; later wins, whole rows. Each source is validated against schemas/kinds.schema.json;
 * one that fails is reported under DF_SCHEMA_* (<file>#$… or <inlinePath>…) and adds no row.
 */
export function kindsTable(ctx = {}, { sketchKinds = null, inlinePath = '$.ext.kinds' } = {}) {
  const c = isObj(ctx) ? ctx : {};
  const root = typeof c.packageRoot === 'string' && c.packageRoot ? c.packageRoot : ENGINE_ROOT;
  const shapes = readJson(join(root, 'renderers', 'shapes.json'));
  const kinds = shapes.ok && isObj(shapes.doc) && isObj(shapes.doc.kinds) ? { ...shapes.doc.kinds } : {};
  const checks = []; const sources = ['renderers/shapes.json'];
  const merge = (doc, ref, inline) => {
    const v = validate(loadSchema('kinds'), doc);
    if (!v.ok) return checks.push(...(inline ? v.errors.map((e) => fail(e.code, { path: `${inlinePath}${e.path.slice(1)}`, detail: e.message })) : schemaChecks(v.errors, ref)));
    for (const [k, row] of Object.entries(doc)) if (k.startsWith('x-')) kinds[k] = row;
    return sources.push(ref);
  };
  const fromFile = (file, ref) => {
    if (!existsSync(file)) return;
    const r = readJson(file);
    if (r.ok) merge(r.doc, ref, false); else checks.push(fail('DF_SCHEMA_TYPE', { path: ref, detail: `not valid JSON (${r.error})` }));
  };
  const packsDir = isObj(c.env) && typeof c.env.DOTFIELD_PACKS_DIR === 'string' && c.env.DOTFIELD_PACKS_DIR ? c.env.DOTFIELD_PACKS_DIR : join(root, 'packs');
  for (const p of isObj(c.config) && Array.isArray(c.config.installed_packs) ? c.config.installed_packs : []) {
    if (isObj(p) && typeof p.id === 'string' && ROOM_ID_RE.test(p.id)) fromFile(join(packsDir, p.id, 'kinds.json'), `packs/${p.id}/kinds.json`);
  }
  if (typeof c.centerDir === 'string' && c.centerDir) fromFile(join(c.centerDir, 'kinds.json'), 'center/kinds.json');
  if (isObj(sketchKinds) && Object.keys(sketchKinds).length) merge({ schema_version: KINDS_VERSION, ...sketchKinds }, inlinePath, true);
  return { kinds, checks, sources };
}

/** kind -> {glyph2d, primitive3d, size_mult, label_anchor, legend?, layout_hint?}: kindsTable(ctx).kinds, memoised per context. */
export function kindsFor(ctx = {}, { sketchKinds = null } = {}) {
  if ((isObj(sketchKinds) && Object.keys(sketchKinds).length) || !isObj(ctx)) return kindsTable(isObj(ctx) ? ctx : {}, { sketchKinds }).kinds;
  if (!kindsMemo.has(ctx)) kindsMemo.set(ctx, kindsTable(ctx));
  return kindsMemo.get(ctx).kinds;
}
