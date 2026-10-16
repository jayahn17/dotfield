// dotfield import records <room> <file|folder> [--map a=B,…] [--relax] [--id <col>|hash]
//   · import projection <file> · import archify|son-graph|spatial-scene <file> [-o scene.json]
// (VISION §7.3, §8.2). Records become ONE proposal (split above
// approval.max_records_per_proposal inside propose()) with the per-row
// DF_RECORD_* checks — from a .csv or .json file, or from a folder of
// markdown notes (importers/markdown-dir.mjs, picked by detect()); a
// projection becomes an overlay through lib/overlay.mjs importProjection()
// (pinned key, receiver, signature; local node ids come through the exit door
// so an overlay can never overwrite a local node); the diagram and scene
// importers write an authored scene file after the schema, topology and
// privacy gates. The archify and markdown-dir importers are slice 8 (VISION
// §11), so their receipts carry release_tag v1.1-provisional.
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { importPath } from '../../importers/index.mjs';
import { importProjection, loadPeopleDir } from '../overlay.mjs';
import { RELEASE_PROVISIONAL, RELEASE_V1, gateContext, isBlockingFail, readJsonFile, runGates, slugOf } from '../pipeline.mjs';
import { projectDetailed } from '../project.mjs';
import { propose } from '../proposals.mjs';
import { buildReceipt, compactStamp } from '../receipt.mjs';
import { writeJsonAtomic } from '../rooms.mjs';
import { fail } from '../rules.mjs';
import { ownerPersonId } from '../scope.mjs';
import { findRoom, isActive, receives, selects } from '../share.mjs';

export const verb = 'import';
export const leaves = ['import records', 'import projection', 'import archify', 'import son-graph', 'import spatial-scene'];
export const usage = 'import records <room> <file.csv|file.json|folder-of-markdown> [--map a=B,…] [--relax] [--id <col>|hash] · import projection <file> · import archify|son-graph|spatial-scene <file> [-o scene.json] [--json]';
export const SCENE_IMPORTERS = Object.freeze({ archify: 'archify', 'son-graph': 'son-graph', 'spatial-scene': 'spatial-asset-scene' });
/** Importers of the v1.1 slice (VISION §11 slice 8, §13): their receipts are provisional until that slice's proof exists. */
export const PROVISIONAL_IMPORTERS = Object.freeze(['archify', 'markdown-dir']);
export const importerReleaseTag = (id) => (PROVISIONAL_IMPORTERS.includes(id) ? RELEASE_PROVISIONAL : RELEASE_V1);
const SCENE_GATES = Object.freeze(['schema', 'topology', 'privacy']);

/** The owner's local node ids (every room's graph view, viewer self): {all, boundary, reciprocal(grantor)}. */
export async function localNodes(ctx, pd) {
  const sessionKey = ctx.sessionKey();
  const nodes = [];
  if (!sessionKey) return { nodes, ok: false };
  const rooms = ctx.rooms().rooms.filter((r) => r.manifest);
  for (const room of rooms) {
    const view = Array.isArray(room.views) ? room.views.find((v) => v.kind === 'graph') ?? room.views[0] : null;
    const r = await projectDetailed({ rooms, view: `${room.id}/${view ? view.id : ''}`.replace(/\/$/, ''), viewer: 'self', rules: pd.rules, circles: pd.circles, now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, root: ctx.root, sessionKey, includeOverlays: false });
    nodes.push(...r.scene.nodes.filter((n) => n.room === room.id));
  }
  return { nodes, ok: true };
}

async function importRecords(args, ctx, base) {
  const [, roomId, file] = args._;
  if (!roomId || !file) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const room = findRoom(ctx.rooms().rooms, roomId);
  if (!room || !room.manifest) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_ROOM_FILE_MISSING', { path: `center/rooms/${roomId}`, detail: room ? 'the room does not validate; run dotfield validate ' + roomId : 'no such room' })] });
  const path = ctx.absPath(file);
  const inputs = [ctx.inputRef(path)].filter(Boolean);
  const ext = extname(path).toLowerCase();
  const importer = ext === '.csv' ? 'csv' : ext === '.json' ? 'json' : undefined;
  const result = importPath(path, { importer, room, map: args.flags.map, relax: args.flags.relax === true, id: typeof args.flags.id === 'string' ? args.flags.id : null, now: ctx.now });
  const common = { ...base, inputs, maturity: room.manifest.maturity, mode: room.manifest.mode, releaseTag: importerReleaseTag(result.importer) };
  if (!result.ok) return buildReceipt({ ...common, status: 'blocked', checks: result.checks });
  const p = await propose({ room, records: result.records, by: `import:${result.importer}`, scope: ctx.scope ?? 'owner', kind: 'records', now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, argv: args.argv, root: ctx.root, source: result.source });
  const seen = new Set(result.checks.filter((c) => c.status === 'fail').map((c) => c.code));
  const checks = [...result.checks, ...p.checks.filter((c) => c.status === 'fail' || !seen.has(c.code))];
  const r = p.receipt;
  return buildReceipt({ ...common, checks, outputs: r.outputs, status: r.status, store: r.store, ownerDecision: r.owner_decision, blockedActions: r.blocked_actions,
    nextAction: p.ok ? `${result.records.length} record(s) from ${ctx.relRef(path)} proposed for room ${roomId} as ${p.proposals.map((x) => x.proposal_id).join(', ')}; the store is untouched until dotfield approve <id> --decision approve from a TTY or the inbox page.` : r.next_action });
}

async function importProjectionFile(args, ctx, base) {
  const file = args._[1];
  if (!file) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const path = ctx.absPath(file);
  const pd = existsSync(join(ctx.centerDir, 'people')) ? loadPeopleDir(ctx.centerDir) : { people: [], circles: [], rules: [] };
  const local = await localNodes(ctx, pd);
  if (!local.ok) return buildReceipt({ ...base, status: 'blocked', inputs: [ctx.inputRef(path)].filter(Boolean), checks: [fail('DF_RENDER_UNPROJECTED', { path: 'data/keys/session.key', detail: 'absent, so local node ids cannot be projected to guard the overlay; run dotfield init' })], releaseTag: 'v1.1-provisional' });
  const doc = readJsonFile(path);
  const grantor = doc.ok && doc.doc && typeof doc.doc.grantor_person_id === 'string' ? doc.doc.grantor_person_id : null;
  const active = pd.rules.filter((r) => isActive(r, ctx.now) && grantor && receives(r, grantor, pd.circles, ctx.now));
  const result = importProjection(path, {
    people: pd.people, self: ownerPersonId(ctx.config), dataDir: ctx.dataDir, now: ctx.now, root: ctx.root, argv: args.argv,
    localIds: local.nodes.map((n) => n.id), boundaryIds: local.nodes.filter((n) => n.kind === 'boundary').map((n) => n.id),
    reciprocalIds: local.nodes.filter((n) => active.some((r) => selects(r, n))).map((n) => n.id),
  });
  return result.receipt;
}

async function importScene(leaf, args, ctx, base) {
  const file = args._[1];
  if (!file) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const path = ctx.absPath(file);
  const inputs = [ctx.inputRef(path)].filter(Boolean);
  base = { ...base, releaseTag: importerReleaseTag(SCENE_IMPORTERS[leaf]) };
  const result = importPath(path, { importer: SCENE_IMPORTERS[leaf], now: ctx.now });
  if (!result.ok || !result.scene) return buildReceipt({ ...base, status: 'blocked', inputs, checks: result.checks });
  const ir = runGates(result.scene, gateContext(ctx, { viewer: 'self' }), SCENE_GATES);
  const checks = [...result.checks, ...ir.checks];
  if (ir.blocked) return buildReceipt({ ...base, status: 'blocked', inputs, checks });
  const scene = result.scene;
  const outPath = typeof args.flags.o === 'string' && args.flags.o ? ctx.absPath(args.flags.o) : join(ctx.dotDir, 'imports', `${SCENE_IMPORTERS[leaf]}-${slugOf(scene.meta.id)}-${compactStamp(ctx.now)}`, 'scene.json');
  writeJsonAtomic(outPath, scene);
  return buildReceipt({ ...base, inputs, checks, outputs: [{ ...ctx.inputRef(outPath), kind: 'scene', action: 'written' }], maturity: scene.meta.maturity ?? null, status: 'written',
    nextAction: `${scene.nodes.length} node(s) and ${scene.edges.length} edge(s) imported as a ${scene.kind} scene at ${ctx.relRef(outPath)}; render it with dotfield render ${ctx.relRef(outPath)} out.html --view 2d.` });
}

export async function run(args, ctx) {
  const leaf = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (leaf === 'records' || leaf === 'projection') {
    if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
    return leaf === 'records' ? importRecords(args, ctx, base) : importProjectionFile(args, ctx, base);
  }
  if (SCENE_IMPORTERS[leaf]) return importScene(leaf, args, ctx, base);
  return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
}
