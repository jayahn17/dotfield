// dotfield run "<task>" [--rooms a,b] [--between a,b] [--with <person>]
//   [--provider dry|claude-cli|anthropic|relay] [--budget 8000] [--desks a,b]
// (VISION §1, §7.4, §8.2): the agent loop (lib/agents/loop.mjs). Records
// reach the loop only through the exit door (project.readRecords, viewer
// self); --between / --with hand it the meeting-layer scene from connect's
// buildMeet(), so a cross-field run sees boundary stubs and fields_allowed
// only, fenced. The run ends at awaiting_owner (exit 3) with
// .dotfield/runs/<id>/{run.json, run.md, receipt.json} and one proposal; only
// dotfield approve moves it on.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run as runLoop } from '../agents/loop.mjs';
import { buildRoster } from '../agents/roster.mjs';
import { loadPeopleDir, originGrants, readOverlays } from '../overlay.mjs';
import { readRecords } from '../project.mjs';
import { buildReceipt } from '../receipt.mjs';
import { fail } from '../rules.mjs';
import { isActive, receives, ruleRef } from '../share.mjs';
import { buildMeet } from './connect.mjs';

export const verb = 'run';
export const leaves = ['run'];
export const usage = 'run "<task>" [--rooms a,b] [--between a,b] [--with <person>] [--provider dry|claude-cli|anthropic|relay] [--budget 8000] [--desks a,b] [--json]';
const splitList = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

/** {roomId: records[]} for the rooms in scope, read for self through the exit door; store faults become checks. */
export async function recordsFor(ctx, rooms, pd) {
  const grants = originGrants(readOverlays(ctx.dataDir));
  const records = {};
  const checks = [];
  for (const room of rooms) {
    const r = await readRecords({ room, viewer: 'self', rules: pd.rules, circles: pd.circles, grants, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, root: ctx.root, now: ctx.now });
    checks.push(...r.checks.filter((c) => c.status === 'fail'));
    records[room.id] = r.records;
  }
  return { records, checks };
}

export async function run(args, ctx) {
  const task = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!task) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  const d = ctx.rooms();
  const pd = existsSync(join(ctx.centerDir, 'people')) ? loadPeopleDir(ctx.centerDir) : { people: [], circles: [], rules: [] };
  const between = splitList(args.flags.between);
  const withPerson = typeof args.flags.with === 'string' && args.flags.with ? args.flags.with : null;
  const roomIds = splitList(args.flags.rooms);
  const rooms = d.rooms.filter((r) => r.manifest);
  const budget = args.flags.budget !== undefined && /^[0-9]+$/.test(String(args.flags.budget)) ? Number(args.flags.budget) : null;
  const provider = typeof args.flags.provider === 'string' && args.flags.provider ? args.flags.provider : undefined;
  let scene = null; let personTerms = []; let fieldsAllowed = {};
  const checks = [];
  if (between || withPerson) {
    const built = await buildMeet({ ctx, between, withPerson, viewer: 'self', roomIds });
    if (!built.ok) return buildReceipt({ ...base, status: 'blocked', inputs: built.inputs.filter(Boolean), checks: built.checks, releaseTag: withPerson ? 'v1.1-provisional' : 'v1.0' });
    scene = built.raw; personTerms = built.personTerms;
    if (withPerson) fieldsAllowed = Object.fromEntries(pd.rules.filter((r) => isActive(r, ctx.now) && receives(r, withPerson, pd.circles, ctx.now)).map((r) => [ruleRef(r), r.redaction.fields_allowed]));
    checks.push(...built.checks.filter((c) => c.status === 'fail'));
  }
  const inScope = between ? rooms.filter((r) => between.includes(r.id)) : roomIds ? rooms.filter((r) => roomIds.includes(r.id)) : rooms;
  const read = await recordsFor(ctx, inScope, pd);
  checks.push(...read.checks);
  const result = await runLoop({
    task, roster: buildRoster(rooms, ctx.config).roster, provider, budget, between, withPerson, rooms, roomIds, records: read.records, scene, fieldsAllowed, personTerms,
    desks: splitList(args.flags.desks), config: ctx.config, now: ctx.now, dataDir: ctx.dataDir, dotDir: ctx.dotDir, root: ctx.root, env: ctx.env, argv: args.argv, by: 'self', viewer: 'self',
  });
  if (ctx.stdout && !args.json) ctx.stdout.write(`run ${result.run.run_id} · ${result.run.status} · transcript ${ctx.relRef(result.paths.md)}${result.proposal ? ` · proposal ${result.proposal.proposal_id}` : ''}\n`);
  return result.receipt;
}
