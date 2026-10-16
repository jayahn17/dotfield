// Hand-written JSON Schema 2020-12 subset validator. Never throws: every
// problem is {code, path, message, repair} with a DF_SCHEMA_* code. The
// subset is proven by the vendored official test suite (test/fixtures/jsts).
// Supported assertions: type, enum, const, required, properties,
// patternProperties, additionalProperties (false or schema), items,
// minItems, maxItems, minLength, maxLength, maxProperties, pattern,
// minimum, maximum, oneOf, format date|date-time, $ref to a JSON pointer in
// the same file. Any other keyword is refused (DF_SCHEMA_UNSUPPORTED_KEYWORD).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding } from './rules.mjs';

export const SCHEMAS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
export const SUPPORTED_KEYWORDS = Object.freeze([
  'type', 'enum', 'const', 'required', 'properties', 'patternProperties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'maxProperties', 'pattern',
  'minimum', 'maximum', 'oneOf', 'format', '$ref',
]);
export const SUPPORTED_FORMATS = Object.freeze(['date', 'date-time']);
const ANNOTATIONS = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
const ASSERTIONS = new Set(SUPPORTED_KEYWORDS);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const NUMERIC = ['minItems', 'maxItems', 'minLength', 'maxLength', 'maxProperties', 'minimum', 'maximum'];
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const DATE_TIME_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;
const REGEX_CACHE = new Map();
const INSPECTED = new WeakMap();
const SCHEMA_CACHE = new Map();

function err(code, path, detail) {
  const f = finding(code, { path, detail });
  return { code: f.code, path: f.path, message: f.message, repair: f.repair };
}
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isSchema(s) { return typeof s === 'boolean' || isObject(s); }
function child(path, key) { return IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`; }
function short(v) {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function matchesType(t, v) {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'object') return isObject(v);
  return typeName(v) === t;
}
function regex(pattern) {
  let re = REGEX_CACHE.get(pattern);
  if (re === undefined) {
    try { re = new RegExp(pattern, 'u'); } catch { re = null; }
    REGEX_CACHE.set(pattern, re);
  }
  return re;
}
function codePoints(s) { let n = 0; for (const _ of s) n += 1; return n; }

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** Resolve "#" or "#/a/b" (RFC 6901, percent-decoded) inside root; undefined when absent. */
export function resolvePointer(root, ref) {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    let token;
    try { token = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return undefined; }
    if (Array.isArray(cur)) { if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined; cur = cur[Number(token)]; }
    else if (isObject(cur) && Object.hasOwn(cur, token)) cur = cur[token];
    else return undefined;
  }
  return cur;
}

function leapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function validDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, leapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}
export function isDate(s) {
  const m = DATE_RE.exec(s);
  return !!m && validDay(+m[1], +m[2], +m[3]);
}
/** RFC 3339 date-time; a leap second (:60) is valid only at 23:59 UTC after the offset. */
export function isDateTime(s) {
  const m = DATE_TIME_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  if (!validDay(y, mo, d) || h > 23 || mi > 59 || sec > 60) return false;
  const offset = m[7] ? (m[7] === '+' ? 1 : -1) * (+m[8] * 60 + +m[9]) : 0;
  if (m[7] && (+m[8] > 23 || +m[9] > 59)) return false;
  if (sec === 60) {
    const utc = (((h * 60 + mi - offset) % 1440) + 1440) % 1440;
    if (utc !== 23 * 60 + 59) return false;
  }
  return true;
}
const FORMATS = { date: isDate, 'date-time': isDateTime };

function inspect(s, ptr, root, out, isRoot) {
  if (typeof s === 'boolean') return;
  if (!isObject(s)) { out.push({ code: 'DF_SCHEMA_INVALID_SCHEMA', detail: `schema at ${ptr} is not an object or boolean` }); return; }
  for (const [k, v] of Object.entries(s)) {
    if (ANNOTATIONS.has(k)) {
      if (k === '$id' && !isRoot) out.push({ code: 'DF_SCHEMA_UNSUPPORTED_KEYWORD', detail: `'$id' below the root at ${ptr}` });
      if (k === '$defs' && isObject(v)) for (const [n, sub] of Object.entries(v)) inspect(sub, `${ptr}/$defs/${n}`, root, out, false);
      continue;
    }
    if (!ASSERTIONS.has(k)) { out.push({ code: 'DF_SCHEMA_UNSUPPORTED_KEYWORD', detail: `'${k}' at schema pointer ${ptr}` }); continue; }
    const bad = (detail) => out.push({ code: 'DF_SCHEMA_INVALID_SCHEMA', detail: `${detail} at ${ptr}` });
    if (k === '$ref') {
      if (typeof v !== 'string') bad('$ref is not a string');
      else if (!v.startsWith('#')) out.push({ code: 'DF_SCHEMA_UNSUPPORTED_KEYWORD', detail: `'$ref' to another document ('${v}') at ${ptr}` });
      else if (!v.startsWith('#/') && v !== '#') out.push({ code: 'DF_SCHEMA_UNSUPPORTED_KEYWORD', detail: `'$ref' by anchor ('${v}') at ${ptr}` });
      else if (!isSchema(resolvePointer(root, v))) out.push({ code: 'DF_SCHEMA_REF_UNRESOLVED', detail: `'${v}' at ${ptr}` });
    } else if (k === 'format') {
      if (!SUPPORTED_FORMATS.includes(v)) out.push({ code: 'DF_SCHEMA_UNSUPPORTED_KEYWORD', detail: `format '${String(v)}' at ${ptr}` });
    } else if (k === 'type') {
      const list = Array.isArray(v) ? v : [v];
      if (!list.length || !list.every((t) => TYPES.has(t))) bad(`type ${short(v)} is not a known type`);
    } else if (k === 'pattern') {
      if (typeof v !== 'string' || !regex(v)) bad(`pattern ${short(v)} is not a valid regular expression`);
    } else if (NUMERIC.includes(k)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${k} is not a number`);
    } else if (k === 'required') {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad('required is not an array of strings');
    } else if (k === 'enum') {
      if (!Array.isArray(v)) bad('enum is not an array');
    } else if (k === 'oneOf') {
      if (!Array.isArray(v) || !v.length) bad('oneOf is not a non-empty array');
      else v.forEach((sub, i) => inspect(sub, `${ptr}/oneOf/${i}`, root, out, false));
    } else if (k === 'properties' || k === 'patternProperties') {
      if (!isObject(v)) { bad(`${k} is not an object`); continue; }
      for (const [n, sub] of Object.entries(v)) {
        if (k === 'patternProperties' && !regex(n)) bad(`patternProperties key ${short(n)} is not a valid regular expression`);
        inspect(sub, `${ptr}/${k}/${n}`, root, out, false);
      }
    } else if (k === 'additionalProperties' || k === 'items') {
      inspect(v, `${ptr}/${k}`, root, out, false);
    }
  }
}

/** Problems in the schema itself: [{code, detail}], memoised per schema object. */
export function inspectSchema(schema) {
  if (!isObject(schema)) {
    return typeof schema === 'boolean' ? [] : [{ code: 'DF_SCHEMA_INVALID_SCHEMA', detail: 'schema is not an object or boolean' }];
  }
  let out = INSPECTED.get(schema);
  if (!out) { out = []; inspect(schema, '#', schema, out, true); INSPECTED.set(schema, out); }
  return out;
}

/** Try one oneOf branch at the real instance path (so the cycle key `$ref|path` stays unique per depth and a schema recursing through oneOf validates). */
function probe(s, v, ctx, path) {
  const scratch = { root: ctx.root, errors: [], seen: ctx.seen };
  check(s, v, path, scratch);
  return scratch.errors.length === 0;
}

function checkObject(s, v, path, ctx) {
  const E = ctx.errors;
  for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) E.push(err('DF_SCHEMA_REQUIRED', child(path, k), `'${k}' is absent`));
  const keys = Object.keys(v);
  if (s.maxProperties !== undefined && keys.length > s.maxProperties) E.push(err('DF_SCHEMA_MAX_PROPERTIES', path, `${keys.length} keys > maximum ${s.maxProperties}`));
  const props = s.properties ?? {};
  const patterns = Object.entries(s.patternProperties ?? {});
  for (const k of keys) {
    let covered = false;
    if (Object.hasOwn(props, k)) { covered = true; check(props[k], v[k], child(path, k), ctx); }
    for (const [p, sub] of patterns) if (regex(p).test(k)) { covered = true; check(sub, v[k], child(path, k), ctx); }
    if (covered || s.additionalProperties === undefined || s.additionalProperties === true) continue;
    if (s.additionalProperties === false) {
      const declared = Object.keys(props);
      E.push(err('DF_SCHEMA_UNKNOWN_FIELD', child(path, k), `'${k}' is not declared${declared.length ? `; declared: ${declared.slice(0, 12).join(', ')}` : ''}`));
    } else check(s.additionalProperties, v[k], child(path, k), ctx);
  }
}

function check(s, v, path, ctx) {
  if (s === true) return;
  const E = ctx.errors;
  if (s === false) { E.push(err('DF_SCHEMA_NOT_ALLOWED', path, 'nothing is allowed at this position')); return; }
  if (s.$ref !== undefined) {
    const key = `${s.$ref}|${path}`;
    if (ctx.seen.has(key)) E.push(err('DF_SCHEMA_INVALID_SCHEMA', path, `circular $ref '${s.$ref}' never reaches a value`));
    else { ctx.seen.add(key); check(resolvePointer(ctx.root, s.$ref), v, path, ctx); ctx.seen.delete(key); }
  }
  if (s.type !== undefined) {
    const list = Array.isArray(s.type) ? s.type : [s.type];
    if (!list.some((t) => matchesType(t, v))) E.push(err('DF_SCHEMA_TYPE', path, `expected ${list.join(' | ')}, got ${typeName(v)}`));
  }
  if (s.enum !== undefined && !s.enum.some((e) => deepEqual(e, v))) E.push(err('DF_SCHEMA_ENUM', path, `got ${short(v)}; allowed: ${s.enum.map(short).join(', ')}`));
  if (s.const !== undefined && !deepEqual(s.const, v)) E.push(err('DF_SCHEMA_CONST', path, `expected ${short(s.const)}, got ${short(v)}`));
  if (typeof v === 'string') {
    const n = (s.minLength !== undefined || s.maxLength !== undefined) ? codePoints(v) : 0;
    if (s.minLength !== undefined && n < s.minLength) E.push(err('DF_SCHEMA_MIN_LENGTH', path, `length ${n} < minimum ${s.minLength}`));
    if (s.maxLength !== undefined && n > s.maxLength) E.push(err('DF_SCHEMA_MAX_LENGTH', path, `length ${n} > maximum ${s.maxLength}`));
    if (s.pattern !== undefined && !regex(s.pattern).test(v)) E.push(err('DF_SCHEMA_PATTERN', path, `${short(v)} does not match /${s.pattern}/`));
    if (s.format !== undefined && !FORMATS[s.format](v)) E.push(err('DF_SCHEMA_FORMAT', path, `${short(v)} is not a valid ${s.format}`));
  } else if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) E.push(err('DF_SCHEMA_MINIMUM', path, `${v} < minimum ${s.minimum}`));
    if (s.maximum !== undefined && v > s.maximum) E.push(err('DF_SCHEMA_MAXIMUM', path, `${v} > maximum ${s.maximum}`));
  } else if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) E.push(err('DF_SCHEMA_MIN_ITEMS', path, `${v.length} items < minimum ${s.minItems}`));
    if (s.maxItems !== undefined && v.length > s.maxItems) E.push(err('DF_SCHEMA_MAX_ITEMS', path, `${v.length} items > maximum ${s.maxItems}`));
    if (s.items !== undefined) v.forEach((item, i) => check(s.items, item, `${path}[${i}]`, ctx));
  } else if (isObject(v)) {
    checkObject(s, v, path, ctx);
  }
  if (s.oneOf !== undefined) {
    const matched = s.oneOf.filter((sub) => probe(sub, v, ctx, path)).length;
    if (matched !== 1) E.push(err('DF_SCHEMA_ONE_OF', path, `matched ${matched} of ${s.oneOf.length} alternatives`));
  }
}

/**
 * validate(schema, doc, {path}) -> {ok, errors: [{code, path, message, repair}]}.
 * A malformed or unsupported schema is reported, never thrown; the document
 * is then not examined.
 */
export function validate(schema, doc, { path = '$' } = {}) {
  const errors = [];
  try {
    const problems = inspectSchema(schema);
    if (problems.length) {
      for (const p of problems) errors.push(err(p.code, path, p.detail));
      return { ok: false, errors };
    }
    check(schema, doc, path, { root: schema, errors, seen: new Set() });
  } catch (e) {
    errors.push(err('DF_SCHEMA_INVALID_SCHEMA', path, `validator stopped: ${e && e.message ? e.message : String(e)}`));
  }
  return { ok: errors.length === 0, errors };
}

function isObjectSchema(s) {
  const types = Array.isArray(s.type) ? s.type : (s.type ? [s.type] : []);
  return types.includes('object') || ['properties', 'patternProperties', 'additionalProperties', 'required', 'maxProperties'].some((k) => k in s);
}

/**
 * Every instance path whose object schema admits keys it does not list:
 * additionalProperties absent, true or a schema, or any patternProperties.
 * Paths are "$", "$.a.b", "$.a[*]" (array items), "$.a.*" (open-map values).
 */
export function openPaths(schema) {
  const out = new Set();
  const seen = new Set();
  const walk = (s, path) => {
    if (!isObject(s)) return;
    if (typeof s.$ref === 'string') {
      const key = `${s.$ref}|${path}`;
      if (!seen.has(key)) { seen.add(key); walk(resolvePointer(schema, s.$ref), path); }
    }
    if (isObjectSchema(s) && (s.additionalProperties !== false || s.patternProperties !== undefined)) out.add(path);
    for (const [k, sub] of Object.entries(s.properties ?? {})) walk(sub, child(path, k));
    for (const sub of Object.values(s.patternProperties ?? {})) walk(sub, `${path}.*`);
    if (isObject(s.additionalProperties)) walk(s.additionalProperties, `${path}.*`);
    if (isObject(s.items)) walk(s.items, `${path}[*]`);
    for (const sub of s.oneOf ?? []) walk(sub, path);
  };
  walk(schema, '$');
  return [...out].sort();
}

/** "scene" | "scene.schema.json" | "dotfield.scene/1" -> schemas/scene.schema.json, or null. */
export function schemaPath(name) {
  let base = String(name ?? '').trim();
  const id = /^dotfield\.([a-z][a-z0-9-]*)\/[0-9]+$/.exec(base);
  if (id) base = id[1];
  base = base.replace(/\.schema\.json$/, '').replace(/\.schema$/, '').replace(/\.json$/, '');
  return /^[a-z][a-z0-9-]*$/.test(base) ? join(SCHEMAS_DIR, `${base}.schema.json`) : null;
}

/** {ok: true, schema, path} or {ok: false, error: {code, path, message, repair}}. */
export function tryLoadSchema(name) {
  const file = schemaPath(name);
  if (!file || !existsSync(file)) return { ok: false, error: err('DF_SCHEMA_NOT_FOUND', '$', `no schema named '${String(name)}'`) };
  if (SCHEMA_CACHE.has(file)) return { ok: true, schema: SCHEMA_CACHE.get(file), path: file };
  try {
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    SCHEMA_CACHE.set(file, schema);
    return { ok: true, schema, path: file };
  } catch (e) {
    return { ok: false, error: err('DF_SCHEMA_INVALID_SCHEMA', '$', `${file} is not valid JSON: ${e.message}`) };
  }
}

/** The parsed schema; throws Error{code} only when the engine install is broken (missing/invalid file). */
export function loadSchema(name) {
  const r = tryLoadSchema(name);
  if (r.ok) return r.schema;
  const e = new Error(r.error.message);
  e.code = r.error.code;
  throw e;
}

/** validate(loadSchema(name), doc) without throwing: a missing schema is one error. */
export function validateAgainst(name, doc, opts) {
  const r = tryLoadSchema(name);
  return r.ok ? validate(r.schema, doc, opts) : { ok: false, errors: [r.error] };
}

export function clearSchemaCache() {
  SCHEMA_CACHE.clear();
}
