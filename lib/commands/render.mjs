// dotfield render <scene.json|room:<id>/<view>> [out.html] --view 2d|3d|vr|all
//   [--quality draft|checked|showcase] [--embed-three|--no-embed-three]
//   [--theme <name>] [--ir-only] [--for <person>] [--i-know]
// Gates → layout → one self-contained HTML, written into a new folder
// .dotfield/renders/<kind>-<slug>-<ts>/ as out.html, out.svg, scene.json and
// receipt.json (and copied to <out.html> when given). Embedding three.js is
// the default unless the render is --for self; a self render written outside
// .dotfield/ without --i-know carries DF_RENDER_SELF_VIEW_EXPORTED.
// --theme <name> (any theme the tokens css declares) overrides meta.theme for
// this render only: the layout gate measures labels in that theme's font, the
// SVG/HTML draw it and the render gate resolves color_token against it. The
// scene itself is not rewritten (a projected scene's stamp stays valid); the
// receipt's argv records the flag.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseThemes } from '../theme.mjs';
import { buildReceipt, compactStamp } from '../receipt.mjs';
import { fail } from '../rules.mjs';
import { IR_ORDER, gateContext, isBlockingFail, loadScene, renderScene, sceneReceiptBlock, slugOf, viewerFor, viewsOffOf, runGates, RELEASE_V1 } from '../pipeline.mjs';

export const verb = 'render';
export const leaves = ['render'];
export const usage = 'render <scene.json|room:<id>/<view>> [out.html] [--view 2d|3d|vr|all] [--quality draft|checked|showcase] [--embed-three|--no-embed-three] [--theme <name>] [--ir-only] [--for <person>] [--i-know] [--json]';
export const QUALITIES = Object.freeze(['draft', 'checked', 'showcase']);
export const NEXT_ACTION = 'Open the HTML in a browser (or on the headset via adb reverse) and record the screenshot path to move this render from provisional to reviewed.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The themes a tokens css declares, in file order (the prefers-color-scheme mirror is not a theme). */
export function themesOf(tokensCss) {
  return parseThemes(typeof tokensCss === 'string' ? tokensCss : '').order.filter((t) => t !== 'auto-light');
}

function writeOut(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Flags → the render plan; a bad --quality or --view is a schema check, not a crash. */
export function planOf(args, ctx) {
  const checks = [];
  const quality = typeof args.flags.quality === 'string' ? args.flags.quality : null;
  if (quality !== null && !QUALITIES.includes(quality)) checks.push(fail('DF_SCHEMA_ENUM', { path: '--quality', detail: `'${quality}' is not ${QUALITIES.join('|')}` }));
  const viewFlag = args.flags.view === undefined || args.flags.view === true ? '2d' : String(args.flags.view);
  if (!/^(all|(2d|3d|vr)(,(2d|3d|vr))*)$/.test(viewFlag)) checks.push(fail('DF_SCHEMA_ENUM', { path: '--view', detail: `'${viewFlag}' is not 2d|3d|vr|all (comma-separated)` }));
  const viewer = viewerFor(ctx, args.flags.for);
  const embed = args.flags['embed-three'];
  const embedThree = embed === true ? true : embed === false ? false : (viewer !== 'self' || quality === 'showcase');
  let theme = null;
  if (args.flags.theme !== undefined) {
    const known = themesOf(ctx.tokens().css);
    theme = typeof args.flags.theme === 'string' ? args.flags.theme : '';
    if (!known.includes(theme)) checks.push(fail('DF_SCHEMA_ENUM', { path: '--theme', detail: `'${theme || String(args.flags.theme)}' is not a theme of ${ctx.tokens().ref} (${known.join('|')})` }));
  }
  return { checks, quality, views: viewFlag, viewer, embedThree, theme, irOnly: args.flags['ir-only'] === true, iKnow: args.flags['i-know'] === true };
}

export async function run(args, ctx) {
  const target = args._[0];
  const outArg = args._[1] ?? null;
  // No nextAction here: a blocked or refused render takes the catalog repair sentence; only a written one says "open the HTML".
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', root: ctx.packageRoot };
  if (!target) return buildReceipt({ ...base, viewer: ctx.viewer, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const plan = planOf(args, ctx);
  if (plan.checks.length) return buildReceipt({ ...base, viewer: plan.viewer, checks: plan.checks, status: 'blocked' });
  const loaded = await loadScene(target, ctx, { viewer: plan.viewer });
  const common = { ...base, viewer: plan.viewer, inputs: loaded.inputs, mode: loaded.mode, store: loaded.store };
  if (!loaded.ok) return buildReceipt({ ...common, checks: loaded.checks, status: 'blocked' });
  const meta = isObject(loaded.scene.meta) ? loaded.scene.meta : {};
  const maturity = meta.maturity ?? (loaded.room && loaded.room.manifest ? loaded.room.manifest.maturity : null) ?? null;
  const themeOver = plan.theme ? { theme: plan.theme } : {};
  const gateCtx = gateContext(ctx, { viewer: plan.viewer, requireProjected: loaded.requireProjected, quality: plan.quality ?? undefined, ...themeOver });
  const ir = runGates(loaded.scene, gateCtx, IR_ORDER);
  const checks = [...loaded.checks, ...ir.checks];
  const kind = typeof loaded.scene.kind === 'string' ? loaded.scene.kind : 'scene';
  const dir = join(ctx.dotDir, 'renders', `${slugOf(kind)}-${slugOf(meta.id ?? loaded.label)}-${compactStamp(ctx.now)}`);
  const folderHtml = join(dir, 'out.html');
  const userOut = outArg ? ctx.absPath(outArg) : null;
  const persist = (receipt) => { try { ctx.persistReceipt(receipt, { dir, index: false }); } catch { /* the index copy is written by bin */ } return receipt; };
  if (ir.blocked) return persist(buildReceipt({ ...common, checks, maturity, status: 'blocked', releaseTag: RELEASE_V1 }));
  const scene = { ...ir.scene, receipt: sceneReceiptBlock({ inputs: loaded.inputs, argv: args.argv, now: ctx.now, tokensCss: ctx.tokens().css, checks }) };
  const rendered = renderScene(scene, ctx, {
    views: plan.views, embedThree: plan.embedThree, quality: plan.quality, viewer: plan.viewer, irOnly: plan.irOnly,
    outputPath: userOut ?? folderHtml, iKnow: plan.iKnow, requireProjected: loaded.requireProjected, viewsOff: viewsOffOf(loaded.viewSpec), ...themeOver,
  });
  checks.push(...rendered.checks);
  if (checks.some(isBlockingFail)) return persist(buildReceipt({ ...common, checks, maturity, status: 'blocked', releaseTag: rendered.releaseTag }));
  const outputs = [];
  const sceneFile = join(dir, 'scene.json');
  writeOut(sceneFile, `${JSON.stringify(scene, null, 2)}\n`);
  if (!plan.irOnly) {
    writeOut(folderHtml, rendered.html);
    writeOut(join(dir, 'out.svg'), rendered.svgStandalone);
    outputs.push({ ...ctx.inputRef(folderHtml), kind: 'html', embedded_three: rendered.embedThree }, { ...ctx.inputRef(join(dir, 'out.svg')), kind: 'svg' });
  }
  outputs.push({ ...ctx.inputRef(sceneFile), kind: 'scene' });
  if (!plan.irOnly && userOut && userOut !== folderHtml) {
    writeOut(userOut, rendered.html);
    outputs.push({ ...ctx.inputRef(userOut), kind: 'html', embedded_three: rendered.embedThree });
  }
  const receipt = buildReceipt({ ...common, checks, outputs, maturity, status: 'written', releaseTag: rendered.releaseTag, nextAction: NEXT_ACTION });
  return persist(receipt);
}
