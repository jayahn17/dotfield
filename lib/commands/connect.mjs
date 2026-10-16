// dotfield connect --between <a>,<b> | --with <person> [-o scene.json]
//   [--accept <edge ids|all>] (VISION §7.4): the meeting layer as a scene of
// kind "meet" — two groups side by side, candidate edges (dashed) between
// pairs whose tags, disciplines and the installed packs' boundary_vocab
// overlap above center.config.json connect.threshold. Both sides come through
// the exit door (lib/project.mjs) and the scene is stamped for the viewer.
// Candidates are never persisted; --accept turns the chosen edges into a
// proposal of kind "pair" that dotfield approve records in data/boundaries.json.
// buildMeet() is shared with `run --between` / `run --with`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { meet, pairRows, sideFromOverlay, sideFromScene } from '../meet.mjs';
import { findPerson, loadPeopleDir, readOverlay } from '../overlay.mjs';
import { IR_ORDER, gateContext, isBlockingFail, readJsonFile, runGates, slugOf } from '../pipeline.mjs';
import { projectDetailed } from '../project.mjs';
import { propose } from '../proposals.mjs';
import { buildReceipt, compactStamp } from '../receipt.mjs';
import { writeJsonAtomic } from '../rooms.mjs';
import { fail } from '../rules.mjs';
import { ownerPersonId } from '../scope.mjs';
import { findRoom } from '../share.mjs';
import { pairRoom } from './add.mjs';

export const verb = 'connect';
export const leaves = ['connect'];
export const usage = 'connect --between <a>,<b> | --with <person> [-o scene.json] [--accept <edge ids|all>] [--json]';
const splitList = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const graphView = (room) => (Array.isArray(room.views) ? room.views.find((v) => v.kind === 'graph') ?? room.views[0] : null);

/** The union of boundary_vocab over the installed packs (packs/<id>/pack.json), when they ship. */
export function packVocab(ctx) {
  const packsDir = ctx.env.DOTFIELD_PACKS_DIR || join(ctx.packageRoot, 'packs');
  const out = new Set();
  for (const p of Array.isArray(ctx.config && ctx.config.installed_packs) ? ctx.config.installed_packs : []) {
    const read = readJsonFile(join(packsDir, p.id, 'pack.json'));
    for (const v of read.ok && Array.isArray(read.doc.boundary_vocab) ? read.doc.boundary_vocab : []) if (typeof v === 'string') out.add(v);
  }
  return [...out].sort();
}

/**
 * buildMeet({ctx, between, withPerson, viewer, roomIds}) ->
 *   {ok, scene (stamped), raw, checks, inputs, left, right, pd, personTerms}
 * between: both rooms' graph views projected for the viewer; with: the owner's
 * rooms (all, or roomIds) on the left and the person's live overlay stubs on
 * the right. Every failure is a check (missing key, room or person).
 */
export async function buildMeet({ ctx, between = null, withPerson = null, viewer = 'self', roomIds = null }) {
  const checks = [];
  const inputs = [];
  const out = { ok: false, scene: null, raw: null, checks, inputs, left: null, right: null, pd: null, personTerms: [] };
  const sessionKey = ctx.sessionKey();
  if (!sessionKey) { checks.push(fail('DF_RENDER_UNPROJECTED', { path: 'data/keys/session.key', detail: 'absent, so no side can be projected; run dotfield init' })); return out; }
  const d = ctx.rooms();
  const pd = existsSync(join(ctx.centerDir, 'people')) ? loadPeopleDir(ctx.centerDir) : { people: [], circles: [], rules: [], disciplines: [] };
  out.pd = pd;
  const owner = ownerPersonId(ctx.config);
  const common = { rooms: d.rooms, viewer, rules: pd.rules, circles: pd.circles, now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, root: ctx.root, sessionKey, includeOverlays: false };
  const side = async (id) => {
    const room = findRoom(d.rooms, id);
    if (!room || !room.manifest) { checks.push(fail('DF_ROOM_FILE_MISSING', { path: `center/rooms/${id}`, detail: room ? 'the room does not validate' : 'no such room' })); return null; }
    for (const f of Object.values(room.files)) if (f) inputs.push(ctx.inputRef(f));
    const view = graphView(room);
    const r = await projectDetailed({ ...common, view: `${room.id}/${view ? view.id : ''}`.replace(/\/$/, '') });
    checks.push(...r.checks);
    return sideFromScene(r.scene, { id: room.id, label: room.manifest.label, roomId: room.id });
  };
  let left; let right;
  if (Array.isArray(between) && between.length === 2 && between[0] !== between[1]) {
    left = await side(between[0]); right = await side(between[1]);
  } else if (typeof withPerson === 'string' && withPerson) {
    const person = findPerson(pd.people, withPerson);
    if (!person) { checks.push(fail('DF_SHARE_RECEIVER_UNKNOWN', { path: '--with', detail: `'${withPerson}' is not in center/people/people.json; pin them with dotfield add person` })); return out; }
    out.personTerms = (Array.isArray(person.disciplines) ? person.disciplines : []).map((x) => x.label).filter((x) => typeof x === 'string');
    const sides = [];
    for (const room of d.rooms.filter((r) => r.manifest && (!roomIds || roomIds.includes(r.id)))) { const s = await side(room.id); if (s) sides.push(s); }
    left = { id: owner, label: ctx.config && ctx.config.center ? ctx.config.center.name : owner, kind: 'room', nodes: sides.flatMap((s) => s.nodes), evidence: sides.flatMap((s) => s.evidence) };
    right = sideFromOverlay(readOverlay(ctx.dataDir, withPerson), { now: ctx.now, label: person.display_name });
  } else { checks.push(fail('DF_RUN_SCOPE_REQUIRED', { path: '$.scope', detail: 'connect needs --between <a>,<b> (two different rooms) or --with <person>' })); return out; }
  if (!left || !right || checks.some(isBlockingFail)) return out;
  out.left = left; out.right = right;
  const threshold = ctx.config && ctx.config.connect && typeof ctx.config.connect.threshold === 'number' ? ctx.config.connect.threshold : undefined;
  out.raw = meet({ left, right, disciplines: pd.disciplines, vocab: packVocab(ctx), threshold, viewer, owner, now: ctx.now, meta: { privacy_mode: 'private_live' } });
  const stamped = await projectDetailed({ ...common, authored: out.raw });
  checks.push(...stamped.checks);
  out.scene = stamped.scene;
  out.ok = !checks.some(isBlockingFail);
  return out;
}

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  const between = typeof args.flags.between === 'string' ? splitList(args.flags.between) : null;
  const withPerson = typeof args.flags.with === 'string' && args.flags.with ? args.flags.with : null;
  const releaseTag = withPerson ? 'v1.1-provisional' : 'v1.0';
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  const built = await buildMeet({ ctx, between, withPerson, viewer: ctx.viewer, roomIds: splitList(args.flags.rooms).length ? splitList(args.flags.rooms) : null });
  const inputs = built.inputs.filter(Boolean);
  if (!built.ok) return buildReceipt({ ...base, status: 'blocked', inputs, checks: built.checks, releaseTag });
  const ir = runGates(built.scene, gateContext(ctx, { viewer: ctx.viewer, requireProjected: true }), IR_ORDER);
  const checks = [...built.checks, ...ir.checks];
  if (ir.blocked) return buildReceipt({ ...base, status: 'blocked', inputs, checks, releaseTag });
  const scene = ir.scene;
  const dir = join(ctx.dotDir, 'connect', `${slugOf(scene.meta.id)}-${compactStamp(ctx.now)}`);
  const outPath = typeof args.flags.o === 'string' && args.flags.o ? ctx.absPath(args.flags.o) : join(dir, 'scene.json');
  writeJsonAtomic(outPath, scene);
  const outputs = [{ ...ctx.inputRef(outPath), kind: 'scene', action: 'written' }];
  const candidates = scene.edges.filter((e) => e.kind === 'candidate');
  const acceptFlag = typeof args.flags.accept === 'string' && args.flags.accept ? args.flags.accept : null;
  let status = 'written'; let ownerDecision; let store = null;
  let next = `${candidates.length} candidate pair(s) between ${built.left.label} and ${built.right.label} (threshold ${ctx.config.connect.threshold}); render with dotfield render ${ctx.relRef(outPath)} out.html --view 2d, accept with --accept ${candidates.slice(0, 2).map((e) => e.id).join(',') || 'all'}. Nothing was persisted.`;
  if (acceptFlag) {
    const ids = acceptFlag === 'all' ? null : splitList(acceptFlag);
    const rows = pairRows(scene, ids);
    if (!rows.length) { checks.push(fail('DF_SCHEMA_ENUM', { path: '--accept', detail: `no candidate edge named ${acceptFlag}; the scene has ${candidates.map((e) => e.id).join(', ') || 'none'}` })); return buildReceipt({ ...base, status: 'blocked', inputs, checks, outputs, releaseTag }); }
    const p = await propose({ room: pairRoom(), records: rows, by: 'connect', scope: 'owner', kind: 'pair', now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, argv: args.argv, root: ctx.root });
    checks.push(...p.checks);
    outputs.push(...p.receipt.outputs);
    status = p.receipt.status; ownerDecision = p.receipt.owner_decision; store = p.receipt.store;
    next = p.ok ? `${rows.length} pair(s) proposed as ${p.proposal.proposal_id}; dotfield approve ${p.proposal.proposal_id} --decision approve records them in data/boundaries.json.` : p.receipt.next_action;
  }
  return buildReceipt({ ...base, inputs, checks, outputs, status, ownerDecision, store, maturity: scene.meta.maturity ?? null, releaseTag, nextAction: next });
}
