// dotfield theme (VISION §8.2, §9): center/brand.json → center/brand/
// tokens.generated.css with the WCAG contrast ledger re-run and any brand
// font files (center/brand/*.woff2) inlined as data: URIs. A failing colour
// pair is refused with DF_THEME_CONTRAST and the nearest passing value in
// the message; nothing is written unless every check passes.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildReceipt } from '../receipt.mjs';
import { schemaChecks } from '../rooms.mjs';
import { buildTokens } from '../theme.mjs';
import { fail, has, pass } from '../rules.mjs';
import { loadSchema, validate } from '../validate.mjs';
import { readJsonFile, isBlockingFail } from '../pipeline.mjs';
import { GENERATED_TOKENS } from '../context.mjs';

export const verb = 'theme';
export const leaves = ['theme'];
export const usage = 'theme [--out <file>] [--json]';
/** The catalog codes lib/theme.mjs buildTokens() can raise; each is reported pass when it did not fail. */
const EVALUATED = Object.freeze(['DF_THEME_CONTRAST', 'DF_THEME_FONT_FILE_MISSING', 'DF_THEME_PRESET_UNKNOWN', 'DF_THEME_TOKEN_UNKNOWN', 'DF_THEME_BASE_MISSING']);

/** A lib/theme.mjs failure as a receipt check (catalog code, catalog gate; the suggestion rides in the message). */
export function toCheck(f) {
  const code = f.code;
  const detail = [f.message, f.suggestion ? `nearest passing value ${f.suggestion}` : null].filter(Boolean).join('; ');
  if (has(code)) return { ...fail(code, { path: f.path, detail }), repair: f.repair || fail(code, {}).repair };
  return { code: String(f.code), gate: f.gate || 'theme', blocking: f.blocking !== false, status: 'fail', path: f.path, message: f.message, repair: f.repair || '' };
}

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  const brandFile = join(ctx.centerDir, 'brand.json');
  const baseCssFile = join(ctx.packageRoot, 'renderers', 'tokens.css');
  const outFile = typeof args.flags.out === 'string' && args.flags.out ? ctx.absPath(args.flags.out) : join(ctx.root, GENERATED_TOKENS);
  if (!existsSync(brandFile)) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/brand.json', detail: 'absent; run dotfield init or write the six brand fields' })] });
  const read = readJsonFile(brandFile);
  if (!read.ok) return buildReceipt({ ...base, status: 'blocked', inputs: [ctx.inputRef(brandFile)], checks: [fail('DF_SCHEMA_TYPE', { path: 'center/brand.json', detail: `not valid JSON (${read.error})` })] });
  const brand = read.doc;
  const inputs = [ctx.inputRef(brandFile), ctx.inputRef(baseCssFile)].filter(Boolean);
  const checks = schemaChecks(validate(loadSchema('brand'), brand).errors, 'center/brand.json');
  if (checks.length) return buildReceipt({ ...base, status: 'blocked', inputs, checks });
  checks.push(pass('DF_SCHEMA_REQUIRED'));
  const fontFiles = {};
  for (const f of Array.isArray(brand.files) ? brand.files : []) {
    const p = join(ctx.centerDir, 'brand', f.path);
    if (existsSync(p)) { fontFiles[f.path] = readFileSync(p); inputs.push(ctx.inputRef(p)); }
  }
  const built = buildTokens(brand, readFileSync(baseCssFile, 'utf8'), { fontFiles });
  const failures = built.failures.map(toCheck);
  checks.push(...failures);
  for (const code of EVALUATED) if (!failures.some((c) => c.code === code)) checks.push(pass(code));
  const fontNote = built.fonts.length ? `; ${built.fonts.length} font file(s) inlined, ${built.bytes} data-URI bytes toward DF_RENDER_SIZE_BUDGET` : '';
  if (checks.some(isBlockingFail) || !built.ok) return buildReceipt({ ...base, status: 'blocked', inputs, checks });
  writeCss(outFile, built.css);
  const out = { ...ctx.inputRef(outFile), kind: 'css' };
  return buildReceipt({
    ...base, status: 'written', inputs, checks, outputs: [out],
    nextAction: `Tokens written to ${out.ref} with the contrast ledger (${built.ledger.split('\n').length} ledger line(s))${fontNote}; renders use it in place of renderers/tokens.css.`,
  });
}

/** tmp + fsync + rename, the same discipline lib/rooms.mjs uses for JSON. */
function writeCss(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
