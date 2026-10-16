// dotfield compare <before> <after> [out.html] [--view 2d|3d|vr|all]
//   [--quality draft|checked|showcase] [--embed-three|--no-embed-three]
//   [--theme <name>] [--ir-only] [--for <person>] [--i-know]
// (V2_PLAN §11 compare). Two scenes of one kind in — scene files, sketches,
// room:<id>/<view> targets, or any file an importer turns into a scene
// (archify) — one before/after picture out:
//   1. load both (loadScene, or the importer registry for a non-scene file)
//      and refuse two kinds (DF_DELTA_KIND_MISMATCH)
//   2. run each input through its own gates (schema, topology, privacy,
//      layout); a blocked input stops the compare (DF_DELTA_INPUT_BLOCKED). An
//      input with no committed layout is laid out cold, with one seed (its
//      views.2d.seed, default 0), by that layout stage, and the receipt says
//      so (DF_DELTA_LAID_OUT_COLD, non-blocking)
//   3. lib/delta.mjs diffScenes pairs and classifies (DF_DELTA_NO_STABLE_IDS,
//      DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS) and withDelta() attaches the delta
//      to the after scene, its viewBox grown (never shrunk) over every
//      delta.nodes[].from
//   4. that scene runs the gates again (the schema checks the delta block)
//      and renders: removed nodes ghosted at their before positions, added
//      nodes accented, moved nodes with a dashed from -> to connector, a
//      delta legend (renderers/svg-delta.mjs through the svg.mjs hook)
// Written into .dotfield/compares/<slug>-<ts>/ as out.html, out.svg,
// scene.json (the after scene with its delta), delta.json (dotfield.delta/1)
// and receipt.json, copied to <out.html> when given (a self compare written
// outside .dotfield/ carries DF_RENDER_SELF_VIEW_EXPORTED, as render does).
// The receipt's next_action carries the counts; nothing here assesses risk.
// Receipts are v1.1-provisional: the verb is a v2 ticket, not a v1.0 slice.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { importInput, loadInput as readImportInput } from '../../importers/index.mjs';
import { CLAIMS, countsLine, deltaDocument, diffScenes, withDelta } from '../delta.mjs';
import { canonical, sha256 } from '../digest.mjs';
import { stamp, verifyStamp } from '../gates/privacy.mjs';
import { mode2dOf } from '../layout/index.mjs';
import { frameOf } from '../layout/frame.mjs';
import { IR_ORDER, RELEASE_PROVISIONAL, dedupeChecks, gateContext, isBlockingFail, loadScene, parseRoomTarget, readJsonFile, renderScene, runGates, slugOf } from '../pipeline.mjs';
import { buildReceipt, compactStamp, receiptId } from '../receipt.mjs';
import { RULE_CATALOG_VERSION, fail, pass, summarize } from '../rules.mjs';
import { ownerPersonId } from '../scope.mjs';
import { validateAgainst } from '../validate.mjs';
import { planOf } from './render.mjs';

export const verb = 'compare';
export const leaves = ['compare'];
export const usage = 'compare <before> <after> [out.html] [--view 2d|3d|vr|all] [--quality draft|checked|showcase] [--embed-three|--no-embed-three] [--theme <name>] [--ir-only] [--for <person>] [--i-know] [--json]';
export const SIDES = Object.freeze(['before', 'after']);
export const NEXT_ACTION = 'Open the HTML in a browser and record the screenshot path to move this compare from provisional to reviewed.';
/** How many of an input's blocking checks DF_DELTA_INPUT_BLOCKED names before "and n more". */
export const BLOCKED_DETAIL_MAX = 3;
const SCENE_VERSION = 'dotfield.scene/1';
const SKETCH_VERSION = 'dotfield.sketch/1';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function writeOut(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** A receipt-safe ref for an input file: root-relative inside the root, its bare name outside (never an absolute path). */
function refOf(ctx, path) {
  const rel = ctx.relRef(path);
  return isAbsolute(rel) ? basename(path) : rel;
}

/** Was the scene laid out as committed (the same test layoutScene uses to return it as is; an incomplete table is the layout gate's, which blocks the side)? */
export function isLaidOut(scene) {
  return isObject(scene) && scene.laid_out === true;
}

/**
 * Load one side -> {ok, scene, inputs, checks, ref: {ref, digest}, label, requireProjected, source}.
 * A scene, a sketch or room:<id>/<view> goes through loadScene; any other
 * JSON file an importer recognises as a scene (archify, ...) is imported for
 * the owner (another viewer needs it imported to a scene file first).
 */
export async function loadSide(target, ctx, { viewer = 'self' } = {}) {
  const room = parseRoomTarget(target);
  if (!room) {
    const path = ctx.absPath(target);
    const read = existsSync(path) ? readJsonFile(path) : { ok: false };
    const doc = read.ok ? read.doc : null;
    if (isObject(doc) && doc.schema_version !== SCENE_VERSION && doc.schema_version !== SKETCH_VERSION) {
      const result = importInput(readImportInput(path), { now: ctx.now, owner: ownerPersonId(ctx.config) });
      if (result.kind === 'scene') {
        const input = ctx.inputRef(path);
        const out = { ok: false, scene: null, inputs: input ? [input] : [], checks: [...result.checks], ref: { ref: refOf(ctx, path), digest: input ? input.digest : sha256('') }, label: basename(path).replace(/\.json$/, ''), requireProjected: viewer !== 'self', source: result.importer };
        if (!result.ok) return out;
        if (viewer !== 'self') return { ...out, notSelf: true };
        return { ...out, ok: true, scene: result.scene };
      }
    }
  }
  const loaded = await loadScene(target, ctx, { viewer });
  const first = loaded.inputs[0];
  const ref = room
    ? { ref: loaded.label.startsWith('room:') ? loaded.label : `room:${loaded.label}`, digest: sha256(canonical(loaded.scene ?? null)) }
    : { ref: refOf(ctx, ctx.absPath(target)), digest: first ? first.digest : sha256('') };
  return { ok: loaded.ok, scene: loaded.scene, inputs: loaded.inputs, checks: loaded.checks, ref, label: loaded.label, requireProjected: loaded.requireProjected, source: loaded.source };
}

function blockedDetail(side, checks) {
  const fails = checks.filter(isBlockingFail);
  const named = fails.slice(0, BLOCKED_DETAIL_MAX).map((c) => `${c.code}${c.path ? ` at ${c.path}` : ''}`).join(', ');
  return `${side}: ${named || 'it could not be loaded'}${fails.length > BLOCKED_DETAIL_MAX ? ` and ${fails.length - BLOCKED_DETAIL_MAX} more` : ''}`;
}

/** The scene.receipt block for the compare receipt (schemas/scene.schema.json scene_receipt), from the same inputs, argv and clock. */
function sceneReceipt({ inputs, argv, now, tokensCss, checks }) {
  return {
    receipt_id: receiptId({ inputs: inputs.map((x) => ({ ref: String(x.ref), digest: x.digest, ...(Number.isInteger(x.bytes) ? { bytes: x.bytes } : {}) })), command: verb, argv: argv.map(String), now }),
    source_digest: inputs.length ? inputs[0].digest : sha256(''),
    tokens_digest: sha256(tokensCss),
    validator_version: RULE_CATALOG_VERSION,
    checks_passed: summarize(checks).passed,
  };
}

/** Re-stamp the after scene for another viewer only when both projected inputs verified under the session key. */
function restamp(scene, sides, ctx) {
  const key = ctx.sessionKey();
  if (!key || !sides.every((s) => verifyStamp(s, key))) return scene;
  return { ...scene, projected: { ...scene.projected, mac: stamp(scene, key) } };
}

export async function run(args, ctx) {
  const [beforeT, afterT] = args._;
  const outArg = args._[2] ?? null;
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', root: ctx.packageRoot, releaseTag: RELEASE_PROVISIONAL };
  if (!beforeT || !afterT) return buildReceipt({ ...base, viewer: ctx.viewer, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const plan = planOf(args, ctx);
  if (plan.checks.length) return buildReceipt({ ...base, viewer: plan.viewer, checks: plan.checks, status: 'blocked' });
  const sides = [await loadSide(beforeT, ctx, { viewer: plan.viewer }), await loadSide(afterT, ctx, { viewer: plan.viewer })];
  const inputs = [...sides[0].inputs, ...sides[1].inputs];
  const checks = [...sides[0].checks, ...sides[1].checks];
  const afterMeta = sides[1].scene && isObject(sides[1].scene.meta) ? sides[1].scene.meta : {};
  const dir = join(ctx.dotDir, 'compares', `${slugOf(afterMeta.id ?? sides[1].label)}-${compactStamp(ctx.now)}`);
  const common = { ...base, viewer: plan.viewer, inputs, maturity: afterMeta.maturity ?? null };
  const persist = (receipt) => { try { ctx.persistReceipt(receipt, { dir, index: false }); } catch { /* the index copy is written by bin */ } return receipt; };
  const blocked = () => persist(buildReceipt({ ...common, checks: dedupeChecks(checks), status: 'blocked' }));

  sides.forEach((s, k) => {
    if (s.notSelf) checks.push(fail('DF_DELTA_INPUT_BLOCKED', { path: s.ref.ref, detail: `${SIDES[k]}: a scene the ${s.source} importer reads compares for the owner only; import it to a scene file first (dotfield import ${s.source} <file> -o scene.json) and compare that --for ${plan.viewer}` }));
    else if (!s.ok) checks.push(fail('DF_DELTA_INPUT_BLOCKED', { path: s.ref.ref, detail: blockedDetail(SIDES[k], s.checks) }));
  });
  if (checks.some(isBlockingFail)) return blocked();
  const [b, a] = sides;
  if (b.scene.kind !== a.scene.kind) {
    checks.push(fail('DF_DELTA_KIND_MISMATCH', { path: '$.kind', detail: `${b.ref.ref} is ${String(b.scene.kind)}, ${a.ref.ref} is ${String(a.scene.kind)}` }));
    return blocked();
  }

  const themeOver = plan.theme ? { theme: plan.theme } : {};
  const gated = sides.map((s, k) => {
    const cold = !isLaidOut(s.scene);
    const ir = runGates(s.scene, gateContext(ctx, { viewer: plan.viewer, requireProjected: s.requireProjected, ...themeOver }), IR_ORDER);
    if (ir.blocked) checks.push(fail('DF_DELTA_INPUT_BLOCKED', { path: s.ref.ref, detail: blockedDetail(SIDES[k], ir.checks) }));
    return { ...ir, cold, mode: mode2dOf(s.scene), seed: frameOf(s.scene).seed };
  });
  if (checks.some(isBlockingFail)) return blocked();
  checks.push(pass('DF_DELTA_INPUT_BLOCKED'));
  const colds = gated.map((g, k) => (g.cold ? fail('DF_DELTA_LAID_OUT_COLD', { path: sides[k].ref.ref, detail: `${SIDES[k]} laid out cold in mode ${g.mode} with seed ${g.seed}` }) : null)).filter(Boolean);
  checks.push(...(colds.length ? colds : [pass('DF_DELTA_LAID_OUT_COLD')]));

  const tokensCss = ctx.tokens().css;
  const theme = [plan.theme, ctx.theme, afterMeta.theme].find((t) => typeof t === 'string' && t);
  const diff = diffScenes(gated[0].scene, gated[1].scene, { before: b.ref, after: a.ref, tokensCss, theme });
  checks.push(...diff.checks);
  if (!diff.delta || checks.some(isBlockingFail)) return blocked();
  let scene = withDelta(gated[1].scene, diff.delta, { tokensCss, theme });
  if (a.requireProjected) scene = restamp(scene, gated.map((g) => g.scene), ctx);
  const final = runGates(scene, gateContext(ctx, { viewer: plan.viewer, requireProjected: a.requireProjected, quality: plan.quality ?? undefined, ...themeOver }), IR_ORDER);
  checks.push(...final.checks);
  const doc = deltaDocument(final.scene.delta ?? scene.delta);
  const docCheck = validateAgainst('delta', doc);
  if (!docCheck.ok) for (const e of docCheck.errors) checks.push(fail(e.code, { path: `delta.json#${e.path}`, detail: e.message }));
  if (final.blocked || checks.some(isBlockingFail)) return blocked();

  const userOut = outArg ? ctx.absPath(outArg) : null;
  const folderHtml = join(dir, 'out.html');
  const out = { ...final.scene, receipt: sceneReceipt({ inputs, argv: args.argv, now: ctx.now, tokensCss, checks }) };
  const rendered = renderScene(out, ctx, {
    views: plan.views, embedThree: plan.embedThree, quality: plan.quality, viewer: plan.viewer, irOnly: plan.irOnly,
    outputPath: userOut ?? folderHtml, iKnow: plan.iKnow, requireProjected: a.requireProjected, ...themeOver,
  });
  checks.push(...rendered.checks);
  if (checks.some(isBlockingFail)) return blocked();
  const outputs = [];
  const sceneFile = join(dir, 'scene.json');
  const deltaFile = join(dir, 'delta.json');
  writeOut(sceneFile, `${JSON.stringify(out, null, 2)}\n`);
  writeOut(deltaFile, `${JSON.stringify(doc, null, 2)}\n`);
  if (!plan.irOnly) {
    writeOut(folderHtml, rendered.html);
    writeOut(join(dir, 'out.svg'), rendered.svgStandalone);
    outputs.push({ ...ctx.inputRef(folderHtml), kind: 'html', embedded_three: rendered.embedThree }, { ...ctx.inputRef(join(dir, 'out.svg')), kind: 'svg' });
  }
  outputs.push({ ...ctx.inputRef(sceneFile), kind: 'scene' }, { ...ctx.inputRef(deltaFile), kind: 'delta' });
  if (!plan.irOnly && userOut && userOut !== folderHtml) {
    writeOut(userOut, rendered.html);
    outputs.push({ ...ctx.inputRef(userOut), kind: 'html', embedded_three: rendered.embedThree });
  }
  const grown = Array.isArray(doc.viewbox_grown_from) ? ' The after viewBox grew to cover the before positions.' : '';
  const nextAction = `Compared ${countsLine(doc)}; ${CLAIMS}.${grown} ${NEXT_ACTION}`;
  return persist(buildReceipt({ ...common, checks: dedupeChecks(checks), outputs, status: 'written', nextAction }));
}
