// dotfield approve <proposal_id|run_id|rule_id> --decision approve|edit|reject
//   [--note <text>] [--edit <file>] [--token-file <path>] · approve --list
// The only state-changing verb (VISION §1, §8.2, §8.5). The owner gate runs
// first: under CLAUDECODE / CLAUDE_CODE_ENTRYPOINT, or without a TTY on both
// stdin and stdout, approve refuses with DF_APPROVE_NOT_OWNER (exit 3) unless
// --token-file (or DOTFIELD_OWNER_TOKEN_FILE) names a readable file whose
// content equals data/keys/owner.token (0600). The token is never printed.
// The summary the owner sees is printed, its digest is what decide() stores
// as reviewed_summary_digest, and the decision is idempotent through
// lib/proposals.mjs decide(). A rule proposal becomes active in
// center/people/share-rules.json, a pair proposal lands in data/boundaries.json
// and a run moves from awaiting_owner to approved | rejected in run.json.
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyPairDecision } from '../meet.mjs';
import { applyRuleDecision } from '../overlay.mjs';
import { readJsonFile } from '../pipeline.mjs';
import { decide, list, readProposal } from '../proposals.mjs';
import { buildReceipt, inlineInput } from '../receipt.mjs';
import { writeJsonAtomic } from '../rooms.mjs';
import { fail, pass } from '../rules.mjs';

export const verb = 'approve';
export const leaves = ['approve'];
export const usage = 'approve <proposal_id|run_id|rule_id> --decision approve|edit|reject [--note <text>] [--edit <file>] [--token-file <path>] [--json] · approve --list [--json]';
export const OWNER_TOKEN_REF = 'data/keys/owner.token';
export const RUN_STATE = Object.freeze({ approve: 'approved', edit: 'approved', reject: 'rejected' });
const RUN_RE = /^run_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;
const PROP_RE = /^prop_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}$/;

export function isAgentSession(env) { return Boolean(env && (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT)); }
export function ownerTokenPath(ctx) { return join(ctx.dataDir, 'keys', 'owner.token'); }
function readToken(path) { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } }
function sameToken(a, b) { const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8'); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
/** The permission bits of a file, or null when it does not exist. */
export function fileMode(path) { try { return statSync(path).mode & 0o777; } catch { return null; } }

/**
 * ownerGate(args, ctx) -> {ok, checks, via: 'tty' | 'token' | null}
 * A token file wins over the session check; without one, an agent session or
 * a piped stdio is refused. Shared with dotfield delete (owner-only).
 */
export function ownerGate(args, ctx) {
  const flag = typeof args.flags['token-file'] === 'string' && args.flags['token-file'] ? args.flags['token-file'] : null;
  const envFile = typeof ctx.env.DOTFIELD_OWNER_TOKEN_FILE === 'string' && ctx.env.DOTFIELD_OWNER_TOKEN_FILE ? ctx.env.DOTFIELD_OWNER_TOKEN_FILE : null;
  const tokenFile = flag ? ctx.absPath(flag) : envFile ? ctx.absPath(envFile) : null;
  const checks = [];
  if (tokenFile) {
    const ownerPath = ownerTokenPath(ctx);
    const expected = readToken(ownerPath);
    const given = readToken(tokenFile);
    if (expected === null) checks.push(fail('DF_APPROVE_TOKEN_INVALID', { path: OWNER_TOKEN_REF, detail: 'absent; dotfield init or dotfield serve writes it' }));
    else if (given === null) checks.push(fail('DF_APPROVE_TOKEN_INVALID', { path: ctx.relRef(tokenFile), detail: 'the token file cannot be read' }));
    else if (!sameToken(expected, given)) checks.push(fail('DF_APPROVE_TOKEN_INVALID', { path: ctx.relRef(tokenFile), detail: 'content differs from data/keys/owner.token' }));
    else checks.push(pass('DF_APPROVE_TOKEN_INVALID'));
    const mode = fileMode(ownerPath);
    if (mode !== null && process.platform !== 'win32' && (mode & 0o077) !== 0) checks.push(fail('DF_APPROVE_TOKEN_FILE_MODE', { path: OWNER_TOKEN_REF, detail: `mode ${mode.toString(8)}` }));
    else checks.push(pass('DF_APPROVE_TOKEN_FILE_MODE'));
    const ok = !checks.some((c) => c.status === 'fail');
    return { ok, checks: [pass('DF_APPROVE_NOT_OWNER'), ...checks], via: ok ? 'token' : null };
  }
  const reasons = [];
  if (isAgentSession(ctx.env)) reasons.push('CLAUDECODE / CLAUDE_CODE_ENTRYPOINT is set');
  if (!ctx.stdinIsTTY) reasons.push('stdin is not a TTY');
  if (!ctx.stdoutIsTTY) reasons.push('stdout is not a TTY');
  if (reasons.length) return { ok: false, checks: [fail('DF_APPROVE_NOT_OWNER', { path: '$.session', detail: `${reasons.join(', ')} and no --token-file was given` }), pass('DF_APPROVE_TOKEN_INVALID'), pass('DF_APPROVE_TOKEN_FILE_MODE')], via: null };
  return { ok: true, checks: [pass('DF_APPROVE_NOT_OWNER'), pass('DF_APPROVE_TOKEN_INVALID'), pass('DF_APPROVE_TOKEN_FILE_MODE')], via: 'tty' };
}

/** proposal id | run id | rule id -> {ok, proposalId, run: {path, doc} | null, checks}. */
export function resolveTarget(id, ctx) {
  const target = String(id ?? '');
  if (PROP_RE.test(target)) {
    const found = readProposal(ctx.dataDir, target);
    return found.ok ? { ok: true, proposalId: target, run: null, checks: [pass('DF_APPROVE_TARGET_UNKNOWN')] } : { ok: false, proposalId: null, run: null, checks: [fail('DF_APPROVE_TARGET_UNKNOWN', { path: target, detail: found.check.message })] };
  }
  if (RUN_RE.test(target)) {
    const path = join(ctx.dotDir, 'runs', target, 'run.json');
    if (!existsSync(path)) return { ok: false, proposalId: null, run: null, checks: [fail('DF_RUN_NOT_FOUND', { path: ctx.relRef(path), detail: `no run ${target}` })] };
    const read = readJsonFile(path);
    const doc = read.ok ? read.doc : null;
    const pid = doc && doc.proposal && Array.isArray(doc.proposal.proposal_ids) ? doc.proposal.proposal_ids[0] : null;
    if (!doc || !['awaiting_owner', 'approved', 'rejected'].includes(doc.status) || !pid) {
      return { ok: false, proposalId: null, run: { path, doc }, checks: [pass('DF_RUN_NOT_FOUND'), fail('DF_RUN_STATE_INVALID', { path: ctx.relRef(path), detail: doc ? `status is ${String(doc.status)}${pid ? '' : ' and no proposal was written'}` : 'run.json is unreadable' })] };
    }
    return { ok: true, proposalId: pid, run: { path, doc }, checks: [pass('DF_RUN_NOT_FOUND'), pass('DF_RUN_STATE_INVALID'), pass('DF_APPROVE_TARGET_UNKNOWN')] };
  }
  const rules = list({ dataDir: ctx.dataDir, kind: 'rule' }).filter((p) => Array.isArray(p.records) && p.records[0] && p.records[0].rule_id === target);
  const pick = rules.find((p) => p.status === 'awaiting_owner') ?? rules[rules.length - 1];
  if (pick) return { ok: true, proposalId: pick.proposal_id, run: null, checks: [pass('DF_APPROVE_TARGET_UNKNOWN')] };
  return { ok: false, proposalId: null, run: null, checks: [fail('DF_APPROVE_TARGET_UNKNOWN', { path: target, detail: 'no proposal, run or share rule carries this id' })] };
}

/** What the owner sees before deciding: the proposal summary, as text. */
export function summaryText(p) {
  const s = p.summary;
  const lines = [`proposal ${p.proposal_id} · ${p.kind} · room ${p.room ?? '-'} · by ${p.by} · ${p.status}`,
    `  adds ${s.adds} · changes ${s.changes} · unchanged ${s.unchanged} · fields: ${s.fields_touched.join(', ') || '-'}`];
  for (const row of s.sample_rows) lines.push(`  sample  ${JSON.stringify(row)}`);
  if (s.foreign_spans.length) lines.push(`  foreign spans ${s.foreign_spans.length}: ${s.foreign_spans.map((f) => `${f.person_id} ${f.rule_ref}`).join('; ')}`);
  if (s.blocked_actions.length) lines.push(`  blocked actions: ${s.blocked_actions.join(', ')}`);
  lines.push(`  summary digest ${p.summary_digest}`);
  return `${lines.join('\n')}\n`;
}

function listPending(args, ctx, base) {
  const pending = list({ dataDir: ctx.dataDir, status: 'awaiting_owner' });
  const line = pending.map((p) => `${p.proposal_id} (${p.kind}, ${p.room ?? '-'}, by ${p.by})`).join('; ');
  if (ctx.stdout && !args.json) for (const p of pending) ctx.stdout.write(summaryText(p));
  return buildReceipt({ ...base, status: 'read', inputs: [inlineInput('pending', pending.map((p) => p.proposal_id))], nextAction: pending.length ? `${pending.length} proposal(s) await the owner: ${line}.` : 'Nothing awaits the owner.' });
}

function readEdited(args, ctx) {
  const file = args.flags.edit;
  if (typeof file !== 'string' || !file) return { edited: null, check: null };
  const read = readJsonFile(ctx.absPath(file));
  const doc = read.ok ? read.doc : null;
  const edited = Array.isArray(doc) ? doc : doc && Array.isArray(doc.records) ? doc.records : null;
  return { edited, check: edited ? null : fail('DF_PROPOSAL_EDIT_FILE_INVALID', { path: ctx.relRef(ctx.absPath(file)), detail: read.ok ? 'expected an array of records or {records: []}' : `not valid JSON (${read.error})` }) };
}

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (args.flags.list === true) return listPending(args, ctx, base);
  const id = args._[0];
  if (!id) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const gate = ownerGate(args, ctx);
  if (!gate.ok) return buildReceipt({ ...base, status: 'refused', checks: gate.checks, inputs: [inlineInput('target', String(id))] });
  const target = resolveTarget(id, ctx);
  const checks = [...gate.checks, ...target.checks];
  if (!target.ok) return buildReceipt({ ...base, status: 'refused', checks, inputs: [inlineInput('target', String(id))] });
  const found = readProposal(ctx.dataDir, target.proposalId);
  if (!found.ok) return buildReceipt({ ...base, status: 'refused', checks: [...checks, found.check], inputs: [inlineInput('target', String(id))] });
  const proposal = found.proposal;
  if (ctx.stdout && !args.json) ctx.stdout.write(summaryText(proposal));
  const decision = typeof args.flags.decision === 'string' ? args.flags.decision : null;
  const { edited, check: editCheck } = readEdited(args, ctx);
  if (decision === 'edit' && !edited) return buildReceipt({ ...base, status: 'blocked', checks: [...checks, editCheck ?? fail('DF_PROPOSAL_EDIT_FILE_INVALID', { path: '--edit', detail: 'edit needs --edit <file> holding the corrected records' })], inputs: [inlineInput('proposal', proposal)] });
  const note = typeof args.flags.note === 'string' ? args.flags.note : null;
  const result = await decide(target.proposalId, {
    decision, note, edited, reviewedDigest: proposal.summary_digest, now: ctx.now, dataDir: ctx.dataDir, dotDir: ctx.dotDir,
    rooms: ctx.hasCenter ? ctx.rooms().rooms : [], config: ctx.config, env: ctx.env, argv: args.argv, root: ctx.root, by: 'self',
  });
  const r = result.receipt;
  const outputs = [...r.outputs];
  const notes = [];
  const decided = result.proposal;
  if (decided && ['approved', 'edited'].includes(decided.status) && decided.kind === 'rule' && !result.idempotent) {
    const a = applyRuleDecision({ proposal: decided, centerDir: ctx.centerDir, now: ctx.now, receiptRef: decided.receipt_ref });
    if (a.applied) { outputs.push({ ...ctx.inputRef(a.path), kind: 'share-rules', action: 'written' }); notes.push(`rule ${a.rule.rule_id} is active`); }
  }
  if (decided && ['approved', 'edited'].includes(decided.status) && decided.kind === 'pair' && !result.idempotent) {
    const a = applyPairDecision({ proposal: decided, dataDir: ctx.dataDir, now: ctx.now });
    if (a.applied) { outputs.push({ ...ctx.inputRef(a.path), kind: 'boundaries', action: 'written' }); notes.push(`${a.added} boundary pair(s) recorded`); }
  }
  if (target.run && decided && target.run.doc.status === 'awaiting_owner' && RUN_STATE[decision] && ['approved', 'edited', 'rejected'].includes(decided.status)) {
    writeJsonAtomic(target.run.path, { ...target.run.doc, status: RUN_STATE[decision] });
    outputs.push({ ...ctx.inputRef(target.run.path), kind: 'run', action: 'written' });
    notes.push(`run ${target.run.doc.run_id} is ${RUN_STATE[decision]}`);
  }
  return buildReceipt({
    ...base, inputs: r.inputs, checks: [...checks, ...result.checks], outputs, status: r.status, maturity: r.maturity, scope: r.scope, viewer: r.viewer, mode: r.mode, store: r.store,
    ownerDecision: r.owner_decision, blockedActions: r.blocked_actions,
    nextAction: notes.length ? `${r.next_action.replace(/\.$/, '')}; ${notes.join('; ')}.` : r.next_action,
  });
}
