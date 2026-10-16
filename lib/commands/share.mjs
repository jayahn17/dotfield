// dotfield share rule <file> · share project --rule <id> · share revoke <id>
// (VISION §7.1–7.3): the sharing seam. `share rule` proposes a rule (same
// path as add rule) so it waits for the owner; `share project` evaluates the
// active rule over the grantor's own projected nodes (exit door, viewer self)
// and writes one signed projection file per receiver under
// data/projections/out/ — refusing rather than filtering silently; `share
// revoke` moves a rule to revoked so the next emit carries revoked_rule_refs
// (files already sent cannot be recalled). project and revoke are outside
// the skill allow-list; every receipt here carries v1.1-provisional.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPeopleDir, originGrants, readOverlays, revokeRule } from '../overlay.mjs';
import { isBlockingFail } from '../pipeline.mjs';
import { projectDetailed } from '../project.mjs';
import { buildReceipt, inlineInput } from '../receipt.mjs';
import { fail } from '../rules.mjs';
import { ownerPersonId } from '../scope.mjs';
import { RELEASE_TAG, emitProjection, findRoom } from '../share.mjs';
import { loadKey } from '../sign.mjs';
import { proposeRule, ruleReceipt } from './add.mjs';

export const verb = 'share';
export const leaves = ['share rule', 'share project', 'share revoke'];
export const usage = 'share rule <file> · share project --rule <id> · share revoke <id> [--json]';

/** The grantor's own nodes and edges over the rooms a rule selects (graph view, viewer self). */
export async function grantorNodes(rule, ctx, pd) {
  const d = ctx.rooms();
  const nodes = []; const edges = []; const checks = []; const inputs = [];
  const sessionKey = ctx.sessionKey();
  if (!sessionKey) return { nodes, edges, inputs, checks: [fail('DF_RENDER_UNPROJECTED', { path: 'data/keys/session.key', detail: 'absent, so nothing can be projected; run dotfield init' })] };
  for (const id of Array.isArray(rule.subject && rule.subject.selector && rule.subject.selector.rooms) ? rule.subject.selector.rooms : []) {
    const room = findRoom(d.rooms, id);
    if (!room || !room.manifest) continue; // ruleChecks reports DF_SHARE_ROOM_UNKNOWN
    for (const f of Object.values(room.files)) if (f) inputs.push(ctx.inputRef(f));
    const view = Array.isArray(room.views) ? room.views.find((v) => v.kind === 'graph') ?? room.views[0] : null;
    const r = await projectDetailed({ rooms: d.rooms, view: `${room.id}/${view ? view.id : ''}`.replace(/\/$/, ''), viewer: 'self', rules: pd.rules, circles: pd.circles, now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, root: ctx.root, sessionKey, includeOverlays: true });
    checks.push(...r.checks.filter((c) => c.status === 'fail'));
    const own = r.scene.nodes.filter((n) => n.room === room.id || n.kind === 'boundary');
    const ids = new Set(own.map((n) => n.id));
    nodes.push(...own.filter((n) => !nodes.some((x) => x.id === n.id)));
    edges.push(...r.scene.edges.filter((e) => ids.has(e.from) && ids.has(e.to)));
  }
  return { nodes, edges, inputs: inputs.filter(Boolean), checks };
}

async function project(args, ctx, base) {
  const ruleId = typeof args.flags.rule === 'string' ? args.flags.rule : null;
  if (!ruleId) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const pd = existsSync(join(ctx.centerDir, 'people')) ? loadPeopleDir(ctx.centerDir) : { people: [], circles: [], rules: [], disciplines: [], self: null };
  const rule = pd.rules.find((r) => r && r.rule_id === ruleId);
  if (!rule) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SHARE_RULE_NOT_FOUND', { path: 'center/people/share-rules.json', detail: `'${ruleId}'` })] });
  const owner = ownerPersonId(ctx.config);
  const g = await grantorNodes(rule, ctx, pd);
  if (g.checks.some(isBlockingFail)) return buildReceipt({ ...base, status: 'blocked', inputs: [...g.inputs, inlineInput('rule', rule)], checks: g.checks });
  const key = loadKey(ctx.dataDir, owner).ok ? loadKey(ctx.dataDir, owner) : loadKey(ctx.dataDir, 'self');
  const result = await emitProjection({
    rule, nodes: g.nodes, edges: g.edges, rooms: ctx.rooms().rooms, people: pd.people, circles: pd.circles, disciplines: pd.disciplines, grants: originGrants(readOverlays(ctx.dataDir)), rules: pd.rules,
    key: key.ok ? key.privateKey : null, keyId: pd.self && typeof pd.self.key_id === 'string' ? pd.self.key_id : `${owner}-k1`, grantorId: owner, now: ctx.now, dataDir: ctx.dataDir, root: ctx.root, argv: args.argv,
  });
  const r = result.receipt;
  return buildReceipt({ ...base, inputs: [...g.inputs, ...r.inputs], checks: [...g.checks, ...r.checks], outputs: r.outputs, status: r.status, viewer: r.viewer, ownerDecision: r.owner_decision, releaseTag: RELEASE_TAG, nextAction: r.next_action });
}

async function revoke(args, ctx, base) {
  const ruleId = args._[1];
  if (!ruleId) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const r = revokeRule({ ruleId, centerDir: ctx.centerDir, now: ctx.now });
  if (!r.ok) return buildReceipt({ ...base, status: 'blocked', checks: [r.check], releaseTag: RELEASE_TAG });
  return buildReceipt({ ...base, inputs: [inlineInput('rule', r.rule)], outputs: [{ ...ctx.inputRef(r.path), kind: 'share-rules', action: 'written' }], status: 'written', releaseTag: RELEASE_TAG,
    nextAction: `Rule ${ruleId} is revoked: future emits stop and the next projection to ${r.rule.receiver.id} carries revoked_rule_refs; ask them to re-import. Files already sent cannot be recalled.` });
}

export async function run(args, ctx) {
  const leaf = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot, releaseTag: RELEASE_TAG };
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  if (leaf === 'rule') {
    if (!args._[1]) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
    return ruleReceipt(base, await proposeRule({ file: args._[1], args, ctx }));
  }
  if (leaf === 'project') return project(args, ctx, base);
  if (leaf === 'revoke') return revoke(args, ctx, base);
  return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
}
