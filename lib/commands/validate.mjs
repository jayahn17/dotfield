// dotfield validate <room|file|all> (VISION §8.2): runs the gates and
// returns the receipt. `all` validates the config, people files, brand and
// every room, then derives .dotfield/registry.json; a room id validates that
// room (cross-room checks included); a file is validated by its
// schema_version — a scene runs the whole pipeline (schema → topology →
// privacy → layout → render), a receipt is verified, anything else meets its
// schema. DF_ROOM_MATURITY_UNPROVEN stays non-blocking here.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildReceipt, verifyReceipt } from '../receipt.mjs';
import { buildRegistry, schemaChecks, writeRegistry } from '../rooms.mjs';
import { loadPeopleDir } from '../overlay.mjs';
import { check as schemaCheck } from '../gates/schema.mjs';
import { loadSchema, tryLoadSchema, validate } from '../validate.mjs';
import { fail } from '../rules.mjs';
import { GATE_ORDER, gateContext, isBlockingFail, readJsonFile, runGates, viewerFor } from '../pipeline.mjs';
import { verifyRoots } from './verify.mjs';

export const verb = 'validate';
export const leaves = ['validate'];
export const usage = 'validate <room|file|all> [--quality draft|checked|showcase] [--for <person>] [--require-projected] [--json] [--as <person_id>]';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 'dotfield.<name>/1' -> name; a scene/brand without the field is recognised by shape. */
export function kindOf(doc) {
  if (!isObject(doc)) return null;
  const m = typeof doc.schema_version === 'string' ? /^dotfield\.([a-z][a-z0-9-]*)\/\d+$/.exec(doc.schema_version) : null;
  if (m) return m[1];
  if (Array.isArray(doc.nodes) && typeof doc.kind === 'string') return 'scene';
  if (typeof doc.accent === 'string' && typeof doc.surface === 'string') return 'brand';
  return null;
}

function validateFile(target, args, ctx) {
  const path = ctx.absPath(target);
  const read = readJsonFile(path);
  const ref = ctx.relRef(path);
  if (!read.ok) return { checks: [fail('DF_SCHEMA_TYPE', { path: ref, detail: `not valid JSON (${read.error})` })], maturity: null, mode: null };
  const kind = kindOf(read.doc);
  if (kind === 'scene') {
    const viewer = viewerFor(ctx, args.flags.for);
    const over = { viewer, requireProjected: args.flags['require-projected'] === true, views: '2d' };
    if (typeof args.flags.quality === 'string') over.quality = args.flags.quality;
    const r = runGates(read.doc, gateContext(ctx, over), GATE_ORDER);
    const meta = isObject(read.doc.meta) ? read.doc.meta : {};
    return { checks: r.checks, maturity: meta.maturity ?? null, mode: null, detail: `scene ${meta.id ?? ref}: ${r.blocked ? `blocked at ${r.stopped_at}` : 'gate-clean'}` };
  }
  if (kind === 'receipt') {
    const v = verifyReceipt(path, verifyRoots(path, ctx));
    return { checks: v.checks, maturity: v.receipt ? v.receipt.maturity ?? null : null, mode: null };
  }
  if (kind && tryLoadSchema(kind).ok) {
    return { checks: schemaCheck(read.doc, { schemaName: kind }), maturity: typeof read.doc.maturity === 'string' ? read.doc.maturity : null, mode: typeof read.doc.mode === 'string' ? read.doc.mode : null };
  }
  const detail = kind ? `no schema named '${kind}' ships under schemas/` : 'the document names no schema_version (dotfield.<kind>/1) and is not a scene or a brand';
  return { checks: [fail(kind ? 'DF_SCHEMA_NOT_FOUND' : 'DF_SCHEMA_REQUIRED', { path: `${ref}#$.schema_version`, detail })], maturity: null, mode: null };
}

function validateRoom(id, ctx) {
  const discovered = ctx.rooms();
  const room = discovered.rooms.find((r) => r.id === id);
  const inputs = Object.values(room.files).filter(Boolean).map((f) => ctx.inputRef(f)).filter(Boolean);
  const m = room.manifest;
  return { checks: room.checks, inputs, maturity: m ? m.maturity : null, mode: m ? m.mode : null, detail: `room ${id}: ${room.ok ? 'valid' : 'invalid'}` };
}

function validateAll(ctx) {
  const checks = [...ctx.configChecks];
  const inputs = [];
  const add = (p) => { const d = ctx.inputRef(p); if (d) inputs.push(d); };
  add(join(ctx.centerDir, 'center.config.json'));
  const brandFile = join(ctx.centerDir, 'brand.json');
  if (existsSync(brandFile)) {
    add(brandFile);
    const b = readJsonFile(brandFile);
    if (b.ok) checks.push(...schemaChecks(validate(loadSchema('brand'), b.doc).errors, 'center/brand.json'));
    else checks.push(fail('DF_SCHEMA_TYPE', { path: 'center/brand.json', detail: `not valid JSON (${b.error})` }));
  }
  if (existsSync(join(ctx.centerDir, 'people'))) {
    const people = loadPeopleDir(ctx.centerDir);
    checks.push(...people.checks);
    for (const p of Object.values(people.paths)) add(p);
  }
  const discovered = ctx.rooms();
  checks.push(...discovered.checks);
  for (const r of discovered.rooms) for (const f of Object.values(r.files)) if (f) add(f);
  const registry = buildRegistry(discovered.rooms, ctx.config);
  const file = writeRegistry(registry, ctx.dotDir);
  const out = ctx.inputRef(file);
  const outputs = out ? [{ ...out, kind: 'registry' }] : [];
  const maturity = discovered.rooms.length ? discovered.rooms.map((r) => (r.manifest ? r.manifest.maturity : null)).filter(Boolean).sort((a, b) => rank(a) - rank(b))[0] ?? null : null;
  return { checks, inputs, outputs, maturity, mode: null, detail: `${registry.rooms.length} valid room(s), ${registry.invalid.length} invalid; registry ${ctx.relRef(file)}` };
}

const rank = (m) => ['contract_only', 'prototype', 'local_beta', 'tested'].indexOf(m);

export async function run(args, ctx) {
  const target = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!target) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  let r;
  if (target === 'all') {
    if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init or cd to a fork root' })] });
    r = validateAll(ctx);
  } else if (existsSync(ctx.absPath(target)) && statSync(ctx.absPath(target)).isFile()) {
    r = { ...validateFile(target, args, ctx), inputs: [ctx.inputRef(target)].filter(Boolean) };
  } else if (ctx.hasCenter && ctx.rooms().rooms.some((x) => x.id === target)) {
    r = validateRoom(target, ctx);
  } else {
    return buildReceipt({ ...base, status: 'error', nextAction: `'${target}' is neither a file, a room under center/rooms/, nor 'all'.` });
  }
  const blocked = r.checks.some(isBlockingFail);
  const outputs = r.outputs ?? [];
  const sum = r.checks.filter((c) => c.status === 'fail').length;
  return buildReceipt({
    ...base, inputs: r.inputs, checks: r.checks, outputs, maturity: r.maturity ?? null, mode: r.mode ?? null,
    status: blocked ? 'blocked' : (outputs.length ? 'written' : 'read'),
    nextAction: blocked ? undefined : `${r.detail ?? target}: ${sum ? `${sum} non-blocking finding(s) to read` : 'no findings'}.`,
  });
}
