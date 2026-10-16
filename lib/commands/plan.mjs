// dotfield plan "<task>" [--rooms a,b] [--with <person>] [--desks a,b]
// (VISION §8.2): dry-run routing, no tokens. The same route() the loop calls
// (lib/agents/router.mjs plan()) over the merged roster, so what plan prints
// is what run reproduces (DF_RUN_ROUTE_PARITY). A read receipt; the routing
// rides in next_action and, in human mode, as a table on stdout.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoster } from '../agents/roster.mjs';
import { plan } from '../agents/router.mjs';
import { findPerson, loadPeopleDir } from '../overlay.mjs';
import { isBlockingFail } from '../pipeline.mjs';
import { buildReceipt, inlineInput } from '../receipt.mjs';
import { fail } from '../rules.mjs';

export const verb = 'plan';
export const leaves = ['plan'];
export const usage = 'plan "<task>" [--rooms a,b] [--with <person>] [--desks a,b] [--json]';
const splitList = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

/** The discipline labels of a pinned person: extra routing terms for --with. */
export function personTerms(ctx, personId) {
  if (!personId || !existsSync(join(ctx.centerDir, 'people'))) return [];
  const person = findPerson(loadPeopleDir(ctx.centerDir).people, personId);
  return person && Array.isArray(person.disciplines) ? person.disciplines.map((d) => d.label).filter((l) => typeof l === 'string') : [];
}

export function planText(p) {
  const rows = p.scored.filter((s) => s.score > 0).map((s) => `  ${s.id.padEnd(20)} ${s.room.padEnd(14)} ${s.tier.padEnd(11)} ${String(s.score).padStart(3)}  ${s.matched.join(' ')}`);
  return [`plan: ${p.task}`, `  specialists: ${p.specialists.join(', ') || '-'}`, `  challenger:  ${p.challenger ?? '-'}`, '  desk                 room           tier       score matched', ...rows, ''].join('\n');
}

export async function run(args, ctx) {
  const task = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!task) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  const roster = buildRoster(ctx.rooms().rooms, ctx.config);
  const withPerson = typeof args.flags.with === 'string' && args.flags.with ? args.flags.with : null;
  const p = plan(task, roster.roster, { rooms: splitList(args.flags.rooms), terms: personTerms(ctx, withPerson), desks: splitList(args.flags.desks) });
  // A duplicate desk id is dropped by buildRoster and the roster stays usable: reported, not blocking (the loop routes over the same roster).
  const checks = [...roster.checks.map((c) => (c.status === 'fail' ? { ...c, blocking: false } : c)), ...p.checks];
  if (ctx.stdout && !args.json) ctx.stdout.write(planText(p));
  const blocked = checks.some(isBlockingFail);
  return buildReceipt({ ...base, inputs: [inlineInput('task', task), inlineInput('roster', { digest: roster.roster.digest })], checks, status: blocked ? 'blocked' : 'read',
    nextAction: blocked ? undefined : `Specialists ${p.specialists.join(', ')}; challenger ${p.challenger}; no tokens spent. Run it with dotfield run ${JSON.stringify(task)}${withPerson ? ` --with ${withPerson}` : ''} --provider dry.` });
}
