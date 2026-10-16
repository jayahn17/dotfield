// Shared record mapping for the row importers (csv, json): --map renames,
// --relax moves unknown columns under ext, --id fills the room id_field from
// a column or a row hash, values are coerced by the room record schema, and
// every row gets the DF_RECORD_* checks of lib/proposals.mjs plus the three
// column codes left to importers (UNKNOWN_COLUMN, MAP_FIELD_UNKNOWN, EXT_MOVED).
import { checkRecords } from '../lib/proposals.mjs';
import { canonical, fail, hasBlocking, importChecks, isObject, pass, sha256, sourceDescriptor } from './common.mjs';

const COLUMN_CODES = ['DF_RECORD_UNKNOWN_COLUMN', 'DF_RECORD_MAP_FIELD_UNKNOWN', 'DF_RECORD_EXT_MOVED'];

/** {manifest, recordSchema} from a discovered room entry, a bare manifest, or nothing. */
export function roomOf(opts = {}) {
  const r = opts.room;
  if (!r || typeof r !== 'object') return { manifest: null, recordSchema: opts.recordSchema ?? null };
  const manifest = isObject(r.manifest) ? r.manifest : r;
  const recordSchema = opts.recordSchema ?? (isObject(r.recordSchema) ? r.recordSchema : null);
  return { manifest, recordSchema };
}

/** --map as "a=B,c=D", ["a=B"], or {a: "B"} → {map, checks} (DF_IMPORT_MAP_INVALID per bad entry). */
export function parseMap(raw) {
  const map = {};
  const checks = [];
  if (raw === undefined || raw === null || raw === '') return { map, checks };
  if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) map[k] = v.trim();
      else checks.push(fail('DF_IMPORT_MAP_INVALID', { path: `--map ${k}`, detail: 'the target is not a field name' }));
    }
    return { map, checks };
  }
  const entries = Array.isArray(raw) ? raw.flatMap((e) => String(e).split(',')) : String(raw).split(',');
  for (const e of entries) {
    const s = e.trim();
    if (!s) continue;
    const m = /^([^=]+)=([^=]+)$/.exec(s);
    if (!m || !m[1].trim() || !m[2].trim()) { checks.push(fail('DF_IMPORT_MAP_INVALID', { path: `--map ${s}`, detail: 'expected <column>=<field>' })); continue; }
    map[m[1].trim()] = m[2].trim();
  }
  return { map, checks };
}

function fieldSchema(recordSchema, field) {
  const p = recordSchema && isObject(recordSchema.properties) ? recordSchema.properties[field] : undefined;
  return isObject(p) ? p : null;
}

function typesOf(schema) {
  if (!schema) return [];
  return Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
}

const DATE_FORMS = [
  [/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`],
  [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`],
  [/^(\d{4})\.(\d{2})\.(\d{2})$/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
];

export function coerceDate(value) {
  const s = String(value).trim();
  for (const [re, fn] of DATE_FORMS) { const m = re.exec(s); if (m) return fn(m); }
  return s;
}

/** One value coerced by its field schema; strings only, typed JSON values pass through. */
export function coerceValue(value, schema) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  const types = typesOf(schema);
  if (schema && schema.format === 'date') return coerceDate(s);
  if (types.includes('number') || types.includes('integer')) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
    return value;
  }
  if (types.includes('boolean')) {
    if (/^(true|yes|y|1)$/i.test(s)) return true;
    if (/^(false|no|n|0)$/i.test(s)) return false;
    return value;
  }
  if (types.includes('array')) {
    if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch { /* fall through to the split form */ } }
    const items = s.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    const itemSchema = schema && isObject(schema.items) ? schema.items : null;
    return items.map((x) => coerceValue(x, itemSchema));
  }
  if (types.includes('null') && s === '') return null;
  return value;
}

/**
 * rows: [{column: value}] → {records, checks, ext_rows, ok}. opts: {room, recordSchema,
 * map, relax, id}. With no room the rows are renamed and returned unchecked.
 */
export function mapRecords(rows, opts = {}) {
  const { manifest, recordSchema } = roomOf(opts);
  const { map, checks } = parseMap(opts.map);
  const declared = recordSchema && isObject(recordSchema.properties) ? recordSchema.properties : null;
  const idField = manifest && manifest.record ? manifest.record.id_field : null;
  const hasExt = !!(declared && isObject(declared.ext));
  const unknown = new Map();
  const moved = new Set();
  const extRows = {};
  if (declared) {
    for (const [col, field] of Object.entries(map)) {
      if (!Object.hasOwn(declared, field)) checks.push(fail('DF_RECORD_MAP_FIELD_UNKNOWN', { path: `--map ${col}=${field}`, detail: `'${field}' is not in record.schema.json properties` }));
    }
  }
  const idMode = opts.id === undefined || opts.id === null || opts.id === '' ? null : String(opts.id);
  const idColumn = idMode && idMode !== 'hash' && idField ? idMode : null;
  const records = rows.map((row, i) => {
    if (!isObject(row)) return row;
    const rec = {};
    for (const [col, raw] of Object.entries(row)) {
      const field = Object.hasOwn(map, col) ? map[col] : (col === idColumn ? idField : col);
      if (raw === undefined || raw === '' || raw === null) continue;
      if (declared && !Object.hasOwn(declared, field)) {
        if (opts.relax) {
          moved.add(col);
          if (hasExt) { rec.ext ??= {}; rec.ext[field] = raw; } else { extRows[i] ??= {}; extRows[i][field] = raw; }
        } else if (!unknown.has(col)) unknown.set(col, `$[${i}].${col}`);
        continue;
      }
      rec[field] = declared ? coerceValue(raw, fieldSchema(recordSchema, field)) : raw;
    }
    if (idField && idMode === 'hash' && rec[idField] === undefined) rec[idField] = `r-${sha256(canonical(row)).slice(7, 23)}`;
    return rec;
  });
  if (idMode && idMode !== 'hash' && rows.length && !rows.some((r) => isObject(r) && Object.hasOwn(r, idMode))) {
    checks.push(fail('DF_RECORD_ID_MISSING', { path: `--id ${idMode}`, detail: `no source column named '${idMode}'` }));
  }
  for (const [col, path] of unknown) checks.push(fail('DF_RECORD_UNKNOWN_COLUMN', { path, detail: `column '${col}' is not a declared record field` }));
  if (moved.size) checks.push(fail('DF_RECORD_EXT_MOVED', { path: '$[*].ext', detail: `${[...moved].sort().join(', ')} kept under ${hasExt ? 'record.ext' : 'result.ext_rows (record.schema.json declares no ext field)'}` }));
  for (const code of COLUMN_CODES) if (!checks.some((c) => c.code === code)) checks.push(pass(code));
  if (manifest && recordSchema) {
    const seen = new Set(checks.map((c) => c.code));
    for (const c of checkRecords({ manifest, recordSchema }, records)) if (c.status === 'fail' || !seen.has(c.code)) checks.push(c);
  }
  return { records, checks, ext_rows: extRows, ok: !hasBlocking(checks) };
}

/** The result envelope shared by csv and json; `source` is the proposal-ready {kind: 'import', ref, digest}. */
export function recordsResult({ importer, input, rows, opts, fails = [] }) {
  const { manifest } = roomOf(opts);
  const source = sourceDescriptor(importer, input);
  const base = importChecks(rows.length || fails.length ? fails : [fail('DF_IMPORT_EMPTY', { path: '$', detail: `${input.name} holds no rows` })]);
  if (hasBlocking(base)) return { kind: 'records', importer, room: manifest ? manifest.id : null, records: [], checks: base, ext_rows: {}, ok: false, source };
  const mapped = mapRecords(rows, opts);
  return { kind: 'records', importer, room: manifest ? manifest.id : null, records: mapped.records, checks: [...base, ...mapped.checks], ext_rows: mapped.ext_rows, ok: mapped.ok, source };
}
