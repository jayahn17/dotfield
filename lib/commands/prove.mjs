// dotfield prove [room|all] (VISION §2.11, §8.2): the proof that moves a room
// up the maturity ladder. A room with test.mjs runs it in the sandbox
// (lib/sandbox.mjs, node --permission, no store handle, reads limited to the
// room folder and the engine's lib/, schemas/ and renderers/ — never the fork
// root, which holds data/keys/); every room also gets
// the generic proof — the manifest, record schema, views and examples
// validate (discovery) and every view projects for self through the exit
// door and passes the IR gates — which lifts it to at most local_beta. The
// result is written to .dotfield/prove/<room>.json with the manifest digest,
// so validate can tell a current proof from a stale one. A room claiming
// `tested` with no test.mjs, zero tests or a failing test is
// DF_ROOM_MATURITY_OVERCLAIM, blocking here.
import { join } from 'node:path';
import { IR_ORDER, dedupeChecks, gateContext, isBlockingFail, loadScene, runGates } from '../pipeline.mjs';
import { buildReceipt, isoSeconds, receiptId } from '../receipt.mjs';
import { PROVE_SCHEMA_VERSION, writeJsonAtomic } from '../rooms.mjs';
import { fail, pass } from '../rules.mjs';
import { runTest } from '../sandbox.mjs';

export const verb = 'prove';
export const leaves = ['prove'];
export const usage = 'prove [room|all] [--json]';
export const MATURITY = Object.freeze(['contract_only', 'prototype', 'local_beta', 'tested']);
export const GENERIC_CEILING = 'local_beta';
/** Engine folders a room test may read beside its own folder; data/ and keys/ are never in this set. */
export const SANDBOX_ENGINE_DIRS = Object.freeze(['lib', 'schemas', 'renderers']);
const rank = (m) => MATURITY.indexOf(m);

/** The read set for a room's test.mjs: its folder plus the engine code, never the fork root (which holds data/keys/). */
export function testReadSet(room, ctx) {
  return [room.dir, ...SANDBOX_ENGINE_DIRS.map((d) => join(ctx.packageRoot, d))];
}
/** The lower of two maturities (unknown counts as contract_only). */
export const lowest = (a, b) => MATURITY[Math.max(0, Math.min(rank(a), rank(b)))];

/** The generic proof: every view of the room projects for self and passes schema → topology → privacy → layout. */
async function genericProof(room, ctx) {
  const checks = [];
  const views = Array.isArray(room.views) && room.views.length ? room.views : [{ id: null }];
  const results = [];
  for (const v of views) {
    const target = v.id ? `room:${room.id}/${v.id}` : `room:${room.id}`;
    const loaded = await loadScene(target, ctx, { viewer: 'self' });
    checks.push(...loaded.checks);
    if (!loaded.ok) { results.push({ view: v.id, ok: false, nodes: 0 }); continue; }
    const ir = runGates(loaded.scene, gateContext(ctx, { viewer: 'self', requireProjected: true }), IR_ORDER);
    checks.push(...ir.checks);
    results.push({ view: v.id, ok: !ir.blocked, nodes: loaded.scene.nodes.length, stopped_at: ir.stopped_at });
  }
  return { checks: dedupeChecks(checks), views: results, ok: !checks.some(isBlockingFail) };
}

/**
 * proveRoom(room, ctx, {receiptRef}) -> {record, checks, path}
 * record = {schema_version, room, ok, maturity_reached, manifest_digest, proved_at, receipt_ref, test, views}
 */
export async function proveRoom(room, ctx, { receiptRef = null } = {}) {
  const m = room.manifest;
  const checks = room.checks.filter((c) => c.code !== 'DF_ROOM_MATURITY_UNPROVEN' && c.code !== 'DF_ROOM_MATURITY_OVERCLAIM');
  let test = { present: false, ok: null, tests: 0, pass: 0, fail: 0 };
  let generic = { ok: false, views: [], checks: [] };
  if (m) {
    if (room.files['test.mjs']) {
      const r = await runTest({ dir: room.dir, allowRead: testReadSet(room, ctx), allowWrite: [join(ctx.dotDir, 'tmp')] });
      checks.push(...r.checks);
      test = { present: true, ok: r.ok && r.summary.tests > 0, tests: r.summary.tests, pass: r.summary.pass, fail: r.summary.fail + r.summary.cancelled };
      if (r.ok && r.summary.tests === 0) checks.push(fail('DF_SANDBOX_EXIT_NONZERO', { path: ctx.relRef(room.files['test.mjs']), detail: 'the test file ran but declared no test; zero tests prove nothing' }));
    }
    generic = await genericProof(room, ctx);
    checks.push(...generic.checks);
    if (m.maturity === 'tested' && test.ok !== true) checks.push(fail('DF_ROOM_MATURITY_OVERCLAIM', { path: `center/rooms/${room.id}/room.json#$.maturity`, detail: test.present ? `test.mjs ${test.ok === false ? 'failed' : 'proved nothing'} (${test.pass} pass / ${test.fail} fail)` : 'tested needs a test.mjs the sandbox can run' }));
    else checks.push(pass('DF_ROOM_MATURITY_OVERCLAIM'));
  }
  const ok = Boolean(m) && !checks.some(isBlockingFail) && generic.ok && test.ok !== false;
  const reached = !ok ? null : test.ok === true ? m.maturity : lowest(m.maturity, GENERIC_CEILING);
  const record = { schema_version: PROVE_SCHEMA_VERSION, room: room.id, ok, maturity_reached: reached, manifest_digest: room.manifest_digest, proved_at: isoSeconds(ctx.now), receipt_ref: receiptRef, test, views: generic.views };
  const path = writeJsonAtomic(join(ctx.dotDir, 'prove', `${room.id}.json`), record);
  return { record, checks: dedupeChecks(checks), path };
}

export async function run(args, ctx) {
  const target = args._[0] ?? 'all';
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init or cd to a fork root' })] });
  const discovered = ctx.rooms();
  const rooms = target === 'all' ? discovered.rooms : discovered.rooms.filter((r) => r.id === target);
  if (!rooms.length) return buildReceipt({ ...base, status: 'error', nextAction: target === 'all' ? 'No rooms under center/rooms/; add one with dotfield add room <id> --blank.' : `'${target}' is not a room under center/rooms/.` });
  const inputs = rooms.flatMap((r) => Object.values(r.files).filter(Boolean).map((f) => ctx.inputRef(f))).filter(Boolean).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const rid = receiptId({ inputs, command: verb, argv: args.argv, now: ctx.now });
  const receiptRef = `.dotfield/receipts/${rid}.json`;
  const checks = target === 'all' ? discovered.checks.filter((c) => c.code === 'DF_ROOM_NAMESPACE_SHARED' || c.code === 'DF_ROOM_LINK_ROOM_UNKNOWN') : [];
  const outputs = [];
  const results = [];
  for (const room of rooms) {
    const r = await proveRoom(room, ctx, { receiptRef });
    checks.push(...r.checks);
    outputs.push({ ...ctx.inputRef(r.path), kind: 'prove', action: 'written' });
    results.push(r.record);
  }
  const blocked = checks.some(isBlockingFail);
  const reached = results.map((r) => r.maturity_reached ?? 'contract_only').reduce((a, b) => lowest(a, b));
  const line = results.map((r) => `${r.room}: ${r.ok ? `proven to ${r.maturity_reached}` : 'not proven'}${r.test.present ? ` (test.mjs ${r.test.pass} pass / ${r.test.fail} fail)` : ' (generic proof)'}`).join('; ');
  const receipt = buildReceipt({ ...base, inputs, checks: dedupeChecks(checks), outputs, maturity: reached, status: blocked ? 'blocked' : 'written',
    nextAction: blocked ? undefined : `${line}. validate now reads a current prove record; a room reaches tested only through its own test.mjs.` });
  if (receipt.receipt_id !== rid) throw new Error('prove: the receipt id drifted from the one written into the prove records');
  return receipt;
}
