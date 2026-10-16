// Gate "schema": the scene document against schemas/scene.schema.json.
// One check per DF_SCHEMA_* code the validator can report: a pass when the
// document raised nothing under that code, one fail per error otherwise
// (path, the validator's message, the catalog repair). Never throws: a
// missing or malformed schema file is itself a failing check.
//
//   check(scene, ctx) -> check[]
//   ctx.schema      (optional) a parsed schema object to use instead of the shipped one
//   ctx.schemaName  (optional) a shipped schema name ('scene' by default)
import { tryLoadSchema, validate } from '../validate.mjs';
import { codesForFamily, fail, pass } from '../rules.mjs';

export const id = 'schema';
export const SCHEMA_NAME = 'scene';

/** The DF_SCHEMA_* errors for `scene`: [{code, path, message, repair}]. */
export function errors(scene, ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  if (c.schema && typeof c.schema === 'object') return validate(c.schema, scene).errors;
  const loaded = tryLoadSchema(typeof c.schemaName === 'string' && c.schemaName ? c.schemaName : SCHEMA_NAME);
  return loaded.ok ? validate(loaded.schema, scene).errors : [loaded.error];
}

/** Gate entry: every schema-family code reported once as pass, or once per error as fail. */
export function check(scene, ctx = {}) {
  let found;
  try {
    found = errors(scene, ctx);
  } catch (e) {
    const f = fail('DF_SCHEMA_INVALID_SCHEMA', { path: '$', detail: `validator stopped: ${e && e.message ? e.message : String(e)}` });
    found = [{ code: f.code, path: f.path, message: f.message, repair: f.repair }];
  }
  const byCode = new Map();
  for (const e of found) {
    if (!byCode.has(e.code)) byCode.set(e.code, []);
    const f = fail(e.code, { path: e.path });
    f.message = e.message;
    byCode.get(e.code).push(f);
  }
  const out = [];
  for (const code of codesForFamily('schema')) {
    if (byCode.has(code)) out.push(...byCode.get(code));
    else out.push(pass(code));
  }
  return out;
}
