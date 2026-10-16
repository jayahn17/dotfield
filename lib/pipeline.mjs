// The ordered gate runner (VISION §10, §14): runGates(scene, ctx, order) ->
// {checks, blocked, scene, stopped_at}. Order schema -> topology -> privacy
// -> layout -> render; the layout stage lays the scene out once (positions +
// laid_out) before measuring it, and the first blocking failure stops the run
// with every check that ran listed. loadScene() is how a command obtains a
// scene (an authored file, or room:<id>/<view> through the one exit door
// lib/project.mjs, or a dotfield.sketch/1 file expanded by importers/
// sketch.mjs) and renderScene() turns a gate-clean scene into the SVG, the
// HTML and the render-gate checks. Every gate context carries the one
// node-kind table (lib/rooms.mjs kindsFor, plus a sketch's inline kinds that
// ride in ext.kinds) and the theme. Used by render, validate and the MCP
// tools so every surface runs the same gates in the same order.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as schemaGate from './gates/schema.mjs';
import * as topologyGate from './gates/topology.mjs';
import * as privacyGate from './gates/privacy.mjs';
import { stamp, verifyStamp } from './gates/privacy.mjs';
import * as layoutGate from './gates/layout.mjs';
import * as renderGate from './gates/render.mjs';
import * as shareGate from './gates/share.mjs';
import { layoutScene } from './layout/index.mjs';
import { needsThree, normalizeViews, renderHtmlDetailed } from '../renderers/html.mjs';
import { renderSvg } from '../renderers/svg.mjs';
import { sha256 } from './digest.mjs';
import { projectDetailed } from './project.mjs';
import { loadPeopleDir } from './overlay.mjs';
import { RULE_CATALOG_VERSION, fail, summarize } from './rules.mjs';
import { ownerPersonId, sanitizeId } from './scope.mjs';
import { findRoom } from './share.mjs';
import { kindsFor, kindsTable } from './rooms.mjs';
import * as sketchImporter from '../importers/sketch.mjs';
import { storeTarget } from './context.mjs';
import { receiptId } from './receipt.mjs';

export const GATES = Object.freeze({ schema: schemaGate, topology: topologyGate, privacy: privacyGate, layout: layoutGate, render: renderGate, share: shareGate });
export const GATE_ORDER = Object.freeze(['schema', 'topology', 'privacy', 'layout', 'render']);
export const IR_ORDER = Object.freeze(['schema', 'topology', 'privacy', 'layout']);
export const SHARE_ORDER = Object.freeze(['schema', 'share']);
export const RELEASE_V1 = 'v1.0';
export const RELEASE_PROVISIONAL = 'v1.1-provisional';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isBlockingFail = (c) => c && c.status === 'fail' && c.blocking === true;
export const failures = (checks) => checks.filter((c) => c.status === 'fail');
export const slugOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scene';

/** Drop a repeated pass entry for a code (two gates may both list DF_RENDER_UNPROJECTED); failures are always kept. */
export function dedupeChecks(checks) {
  const seenPass = new Set();
  const out = [];
  for (const c of checks) {
    if (!c) continue;
    if (c.status === 'pass') { if (seenPass.has(c.code)) continue; seenPass.add(c.code); }
    out.push(c);
  }
  return out;
}

/**
 * runGates(scene, ctx, order) -> {checks, blocked, scene, stopped_at, ran}
 * ctx is the gate context (BUILD_CONTRACT §2): {viewer, rooms, tokensCss,
 * config, sessionKey, quality, requireProjected, shapes, html, svg, views, …}.
 * The layout stage returns the laid-out scene; nothing else mutates it.
 */
export function runGates(scene, ctx = {}, order = GATE_ORDER) {
  let current = scene;
  const ran = [];
  const inline = withSceneKinds(scene, ctx);
  const checks = [...inline.checks];
  if (checks.some(isBlockingFail)) return { checks: dedupeChecks(checks), blocked: true, scene, stopped_at: 'schema', ran };
  ctx = inline.ctx;
  for (const id of order) {
    const gate = GATES[id];
    if (!gate) throw new TypeError(`runGates: no gate named '${String(id)}' (known: ${Object.keys(GATES).join(', ')})`);
    if (id === 'layout' && isObject(current)) current = relayout(current, ctx);
    let out;
    try { out = gate.check(current, ctx); } catch (e) { out = [fail('DF_SCHEMA_INVALID_SCHEMA', { path: '$', detail: `gate ${id} threw: ${e && e.message ? e.message : String(e)}` })]; }
    checks.push(...out);
    ran.push(id);
    if (out.some(isBlockingFail)) return { checks: dedupeChecks(checks), blocked: true, scene: current, stopped_at: id, ran };
  }
  return { checks: dedupeChecks(checks), blocked: false, scene: current, stopped_at: null, ran };
}

/**
 * Lay the scene out once. A projected scene was stamped by lib/project.mjs
 * before it had positions, so the stamp is recomputed over the laid-out
 * scene — only when the incoming stamp verifies under the session key, so a
 * pasted or edited block is never laundered (the privacy gate already
 * blocked it one stage earlier). The shipped scene.json and HTML therefore
 * carry a MAC that verifies against their full content.
 */
export function relayout(scene, ctx) {
  const laid = layoutScene(scene, ctx);
  if (laid === scene || !ctx.requireProjected || !ctx.sessionKey || !isObject(scene.projected) || !verifyStamp(scene, ctx.sessionKey)) return laid;
  return { ...laid, projected: { ...scene.projected, mac: stamp(laid, ctx.sessionKey) } };
}

/**
 * A scene's inline kinds (ext.kinds: a sketch's kinds block) merged over
 * ctx.shapes -> {ctx, checks}. Rows are validated against schemas/
 * kinds.schema.json; a failing block is DF_SCHEMA_* at $.ext.kinds… and
 * merges nothing. A scene without inline kinds returns ctx unchanged.
 */
export function withSceneKinds(scene, ctx = {}) {
  const inline = isObject(scene) && isObject(scene.ext) && isObject(scene.ext.kinds) ? scene.ext.kinds : null;
  if (!inline || !Object.keys(inline).length) return { ctx, checks: [] };
  const table = kindsTable({ packageRoot: isObject(ctx) ? ctx.packageRoot : undefined }, { sketchKinds: inline });
  if (table.checks.length) return { ctx, checks: table.checks };
  const own = isObject(ctx) && isObject(ctx.shapes) ? (isObject(ctx.shapes.kinds) ? ctx.shapes.kinds : ctx.shapes) : null;
  const shapes = { ...(own ?? table.kinds) };
  for (const k of Object.keys(inline)) shapes[k] = table.kinds[k];
  return { ctx: { ...ctx, shapes }, checks: [] };
}

/** The gate context derived from a command context, with per-call overrides: theme (when the context names one) and shapes = kindsFor(ctx). */
export function gateContext(ctx, over = {}) {
  const tokens = ctx.tokens();
  const theme = typeof ctx.theme === 'string' && ctx.theme ? { theme: ctx.theme } : {};
  return {
    viewer: ctx.viewer, rooms: ctx.hasCenter ? ctx.rooms() : { rooms: [] }, config: ctx.config, sessionKey: ctx.sessionKey(),
    tokensCss: tokens.css, root: ctx.root, dotDir: ctx.dotDir, dataDir: ctx.dataDir, requireProjected: false,
    ...theme, shapes: kindsFor(ctx),
    ...over,
  };
}

/** 'room:<id>[/<view>]' -> {room, view} | null for anything else. */
export function parseRoomTarget(target) {
  const m = /^room:([a-z0-9][a-z0-9_-]{0,39})(?:\/([a-z0-9][a-z0-9_-]{0,39}))?$/.exec(String(target ?? ''));
  return m ? { room: m[1], view: m[2] ?? null } : null;
}

export function readJsonFile(path) {
  try { return { ok: true, doc: JSON.parse(readFileSync(path, 'utf8')) }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** The viewer a render is for: 'self' (or the owner id) -> self; anything else a sanitised person id. */
export function viewerFor(ctx, forFlag) {
  const raw = forFlag === undefined || forFlag === null || forFlag === '' ? ctx.viewer : String(forFlag);
  const id = sanitizeId(raw) || 'self';
  return id === ownerPersonId(ctx.config) ? 'self' : id;
}

/**
 * loadScene(target, ctx, {viewer}) ->
 *   {ok, scene, inputs, checks, source: 'file' | 'room' | 'sketch', importer: 'sketch' | null, room, viewSpec, requireProjected, store, mode, label}
 * A file is used as authored for the owner and projected (lib/project.mjs,
 * stamped) for anyone else; room:<id>/<view> is always projected. A file
 * whose schema_version is dotfield.sketch/1 (and only such a file) is
 * expanded by importers/sketch.mjs first: the sketch is the input, the
 * expanded scene continues (render writes it as scene.json beside the HTML).
 * An invalid kinds.json (packs, center) is reported here under DF_SCHEMA_*.
 * Every failure is a check, never a throw: a missing room, a file that is not
 * JSON, a sketch the importer refuses, or an absent session key when a
 * projection is needed.
 */
export async function loadScene(target, ctx, { viewer = 'self' } = {}) {
  const checks = [];
  const roomTarget = parseRoomTarget(target);
  const out = { ok: false, scene: null, inputs: [], checks, source: roomTarget ? 'room' : 'file', importer: null, room: null, viewSpec: null, requireProjected: Boolean(roomTarget) || viewer !== 'self', store: null, mode: null, label: String(target) };
  const kinds = kindsTable(ctx);
  if (kinds.checks.length) { checks.push(...kinds.checks); if (kinds.checks.some(isBlockingFail)) return out; }
  let authored = null;
  if (roomTarget) {
    const discovered = ctx.hasCenter ? ctx.rooms() : { rooms: [] };
    const room = findRoom(discovered.rooms, roomTarget.room);
    if (!room || !room.manifest) { checks.push(fail('DF_ROOM_FILE_MISSING', { path: `center/rooms/${roomTarget.room}`, detail: room ? 'the room does not validate; run dotfield validate ' + roomTarget.room : 'no such room in the center' })); return out; }
    const views = Array.isArray(room.views) ? room.views : [];
    const viewSpec = roomTarget.view ? views.find((v) => v.id === roomTarget.view) : views[0];
    if (roomTarget.view && !viewSpec) { checks.push(fail('DF_ROOM_VIEW_INVALID', { path: `center/rooms/${roomTarget.room}/views.json`, detail: `no view '${roomTarget.view}'` })); return out; }
    out.room = room; out.viewSpec = viewSpec ?? null; out.mode = room.manifest.mode ?? null; out.store = storeTarget(room, ctx);
    out.label = `${roomTarget.room}/${viewSpec ? viewSpec.id : 'graph'}`;
    for (const f of Object.values(room.files)) { const d = f ? ctx.inputRef(f) : null; if (d) out.inputs.push(d); }
    if (out.store.backend === 'file') { const d = ctx.inputRef(out.store.target); if (d) out.inputs.push(d); }
  } else {
    const path = ctx.absPath(target);
    if (!existsSync(path)) { checks.push(fail('DF_SCHEMA_REQUIRED', { path: ctx.relRef(path), detail: 'no such file' })); return out; }
    const read = readJsonFile(path);
    if (!read.ok) { checks.push(fail('DF_SCHEMA_TYPE', { path: ctx.relRef(path), detail: `not valid JSON (${read.error})` })); return out; }
    out.inputs.push(ctx.inputRef(path));
    out.label = basename(path).replace(/\.json$/, '');
    let doc = read.doc;
    if (sketchImporter.detect({ doc })) {
      const r = sketchImporter.run({ path, name: basename(path), doc }, { now: ctx.now, owner: ownerPersonId(ctx.config) });
      checks.push(...r.checks);
      out.source = 'sketch'; out.importer = 'sketch'; out.label = basename(path).replace(/\.sketch\.json$|\.json$/, '');
      if (!r.ok) return out;
      doc = r.scene;
    }
    if (!out.requireProjected) { out.scene = doc; out.ok = true; return out; }
    authored = doc;
  }
  const sessionKey = ctx.sessionKey();
  if (!sessionKey) { checks.push(fail('DF_RENDER_UNPROJECTED', { path: 'data/keys/session.key', detail: 'absent, so nothing can be projected for a viewer; run dotfield init' })); return out; }
  const people = ctx.hasCenter && existsSync(join(ctx.centerDir, 'people')) ? loadPeopleDir(ctx.centerDir) : { rules: [], circles: [] };
  try {
    const r = await projectDetailed({
      rooms: ctx.hasCenter ? ctx.rooms().rooms : [], viewer, rules: people.rules, circles: people.circles,
      view: roomTarget ? `${roomTarget.room}/${out.viewSpec ? out.viewSpec.id : ''}`.replace(/\/$/, '') : null, authored,
      now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, root: ctx.root, sessionKey,
    });
    checks.push(...r.checks);
    out.scene = r.scene; out.ok = !r.checks.some(isBlockingFail);
  } catch (e) {
    const code = e && typeof e.code === 'string' && e.code.startsWith('DF_STORE_') ? e.code : 'DF_RENDER_UNPROJECTED';
    checks.push(fail(code, { path: out.label, detail: e && e.message ? e.message : String(e) }));
  }
  return out;
}

/** The scene.receipt block (schemas/scene.schema.json scene_receipt): computed before the receipt exists, from the same inputs and clock. */
export function sceneReceiptBlock({ inputs, argv, now, tokensCss, checks }) {
  return {
    receipt_id: receiptId({ inputs, command: 'render', argv, now }),
    source_digest: inputs.length ? inputs[0].digest : sha256(''),
    tokens_digest: sha256(tokensCss),
    validator_version: RULE_CATALOG_VERSION,
    checks_passed: summarize(checks).passed,
  };
}

/**
 * renderScene(scene, ctx, {views, embedThree, quality, viewer, outputPath, iKnow, requireProjected, viewsOff, irOnly, theme})
 *   -> {svg, svgStandalone, html, detailed, checks, releaseTag, views, embedThree}
 * svg.mjs draws exactly what the layout gate measured; html.mjs assembles the
 * standalone page; the render gate then reads both. One theme (opts.theme,
 * else ctx.theme, else meta.theme) and one kinds table (kindsFor + ext.kinds)
 * reach the SVG, the HTML and the render gate alike. When 3D or VR is asked
 * for and renderers/three.mjs is not installed the page carries its honest
 * overlay, the receipt says so (a non-blocking DF_RENDER_VIEW_DISABLED) and
 * the release tag is v1.1-provisional; the 2D output still succeeds.
 */
/** Is view `v` one this scene (and the room's views_off) enables? 2d always is. */
function viewEnabled(scene, v, off) {
  if (off.includes(v)) return false;
  const sv = isObject(scene.views) ? scene.views : {};
  if (v === '3d') return isObject(sv['3d']);
  if (v === 'vr') return isObject(sv.vr) && sv.vr.enabled === true;
  return true;
}

export function renderScene(scene, ctx, opts = {}) {
  const requested = normalizeViews(opts.views);
  const viewsOff = Array.isArray(opts.viewsOff) ? opts.viewsOff : [];
  // `--view all` means every view the scene enables: a view the scene turns
  // off is dropped here and reported as a non-blocking DF_RENDER_VIEW_DISABLED.
  // An explicit request for a disabled view (`--view vr`) still blocks in
  // gates/render.mjs, which sees only the views that remain.
  const dropped = opts.views === 'all' ? requested.filter((v) => !viewEnabled(scene, v, viewsOff)) : [];
  const views = requested.filter((v) => !dropped.includes(v));
  const tokens = ctx.tokens();
  const ownerId = ownerPersonId(ctx.config);
  const viewer = opts.viewer ?? 'self';
  const embedThree = opts.embedThree === true;
  const vendorDir = join(ctx.packageRoot, 'vendor');
  const rendererDir = join(ctx.packageRoot, 'renderers');
  const meta = isObject(scene.meta) ? scene.meta : {};
  const quality = opts.quality || meta.quality || 'checked';
  const theme = [opts.theme, ctx.theme, meta.theme].find((t) => typeof t === 'string' && t) ?? 'default';
  const shapes = withSceneKinds(scene, { shapes: kindsFor(ctx), packageRoot: ctx.packageRoot }).ctx.shapes;
  const centerName = ctx.config && ctx.config.center ? ctx.config.center.name : null;
  let svg = null; let svgStandalone = null; let detailed = null;
  if (!opts.irOnly) {
    svg = renderSvg(scene, tokens.css, { xmlns: false, ownerId, shapes, theme });
    svgStandalone = renderSvg(scene, tokens.css, { ownerId, inlineTokens: true, shapes, theme });
    detailed = renderHtmlDetailed(scene, { views, tokensCss: tokens.css, embedThree, vendorDir, rendererDir, viewer, svg, now: ctx.now, centerName, quality, shapes, theme });
  }
  const gateCtx = gateContext(ctx, {
    viewer, quality, theme, shapes, requireProjected: opts.requireProjected === true, views, embedThree, vendorDir,
    html: detailed ? detailed.html : undefined, svg: svgStandalone ?? undefined,
    outputPath: opts.outputPath, iKnow: opts.iKnow === true, viewsOff,
  });
  const checks = renderGate.check(scene, gateCtx);
  for (const v of dropped) checks.push({ ...fail('DF_RENDER_VIEW_DISABLED', { path: `$.views.${v}`, detail: `'${v}' is not enabled by this scene; --view all rendered the enabled views` }), blocking: false });
  let releaseTag = RELEASE_V1;
  if (needsThree(views)) {
    releaseTag = RELEASE_PROVISIONAL;
    if (detailed && !detailed.renderer.present) {
      checks.push({ ...fail('DF_RENDER_VIEW_DISABLED', { path: '$.views.3d', detail: `renderers/${detailed.renderer.missing.join(' and renderers/')} not installed; the 3D/VR panels carry an honest overlay and the 2D view is complete` }), blocking: false });
    }
  }
  return { svg, svgStandalone, html: detailed ? detailed.html : null, detailed, checks, releaseTag, views, embedThree };
}

/** views_off of a room view spec (pack-level disabling), [] when none. */
export function viewsOffOf(viewSpec) {
  if (!isObject(viewSpec)) return [];
  const list = Array.isArray(viewSpec.views_off) ? viewSpec.views_off : (isObject(viewSpec.views) && Array.isArray(viewSpec.views.views_off) ? viewSpec.views.views_off : []);
  return list.filter((v) => typeof v === 'string');
}
