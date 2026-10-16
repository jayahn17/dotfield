// The agent loop (VISION 1, 7.4, 14): mission brief (conductor) -> at most
// five specialist packets -> one challenger -> synthesis -> awaiting_owner.
// The loop reads nothing from a store (the caller hands in records read
// through the exit door, or a meet scene), writes only
// .dotfield/runs/<id>/{run.json, run.md, receipt.json}, .dotfield/receipts/
// and, through propose(), one data/proposals/<id>.json. Every foreign value
// a desk sees is fenced; DF_RUN_FOREIGN_UNFENCED aborts the run if one
// escapes. Only `dotfield approve` moves the run past awaiting_owner.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digestTree, sha256 } from '../digest.mjs';
import { propose } from '../proposals.mjs';
import { estimateTokens, isProviderError } from '../providers/errors.mjs';
import { isProvider, loadProvider, providerInfo } from '../providers/index.mjs';
import { isoSeconds } from '../receipt.mjs';
import { fail, pass } from '../rules.mjs';
import { extractClaims } from './claims.mjs';
import { GUARD_MIN_CHARS, buildContext } from './context.mjs';
import { closeFences, escapes, fence, spansDigest } from './fence.mjs';
import { buildIdeaRecord, pickTargetRoom } from './idea.mjs';
import { briefPrompt, challengerPrompt, specialistPrompt, stepMaxTokens, synthesisPrompt, systemPrompt } from './prompts.mjs';
import { deskById } from './roster.mjs';
import { route, routedDesks } from './router.mjs';
import { newRun, receiptRef, runChecks, runId, runReceipt, stepEntry, writeRunFiles, writeRunReceipt } from './run-record.mjs';

export { fence };
export const DEFAULT_BUDGET = 8000;
export const CONDUCTOR_ROLE = 'You are the conductor: you brief the desks and synthesise their packets. You never approve anything.';

const manifestOf = (room) => (room && room.manifest && typeof room.manifest === 'object' ? room.manifest : room);
const validRooms = (rooms) => (Array.isArray(rooms) ? rooms : []).filter((r) => r && (r.ok !== false) && manifestOf(r) && typeof manifestOf(r).id === 'string');
const blocking = (checks) => checks.filter((c) => c.status === 'fail' && c.blocking);
const notProposals = (p) => !p.startsWith('proposals/');

function storesSnapshot(dataDir) {
  // A missing data/ is the empty tree, so a fresh center whose first run creates only data/proposals/ reads as no store write (it used to compare null with a digest and block).
  return existsSync(dataDir) ? digestTree(dataDir, { include: notProposals }).digest : sha256([]);
}

function resolveProvider(provider, deps) {
  if (isProvider(provider)) return provider;
  if (provider && typeof provider === 'object') throw new TypeError('provider must be an adapter object {id, ask} or an adapter name');
  return loadProvider(provider ?? null, deps);
}

function defaultArgv({ task, roomIds, explicitRooms, between, withPerson, adapter, max }) {
  const argv = ['run', task];
  if (between) argv.push('--between', between.join(','));
  else if (withPerson) argv.push('--with', withPerson);
  else if (explicitRooms) argv.push('--rooms', roomIds.join(','));
  argv.push('--provider', adapter, '--budget', String(max));
  return argv;
}

/**
 * run({task, roster, provider, budget, between, withPerson, rooms, roomIds,
 *   records, scene, fieldsAllowed, personTerms, desks, planned, targetRoom,
 *   config, now, dataDir, dotDir, root, env, argv, by, viewer, signal}) ->
 *   {ok, run, receipt, paths:{dir, run, md, receipt, index}, proposal, checks, routing, transcript, context}
 * rooms: discoverRooms().rooms (or bare manifests); records: {roomId: records[]}
 * read by the caller through project.readRecords(); scene: a meet scene for
 * --between / --with (context is then its nodes only, foreign nodes cut to
 * fieldsAllowed[rule_ref]); provider: an adapter object or name (dry default).
 * ok is true when the run reached awaiting_owner (receipt exit 3 by design).
 */
export async function run(opts = {}) {
  const { task, roster, between = null, withPerson = null, records = {}, scene = null, fieldsAllowed = {}, personTerms = [], desks = null, planned = null,
    targetRoom = null, config = null, now, dataDir, dotDir, env = process.env, by = 'self', viewer = 'self', signal = undefined, fetch = globalThis.fetch, spawn = null } = opts;
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('run needs a task string');
  if (!roster || !Array.isArray(roster.desks)) throw new TypeError('run needs the merged roster (buildRoster().roster)');
  if (now === undefined || now === null) throw new TypeError('run needs now (ctx.now)');
  if (typeof dataDir !== 'string' || typeof dotDir !== 'string') throw new TypeError('run needs dataDir and dotDir');
  const root = opts.root || resolve(dataDir, '..');
  const checks = [];
  const transcript = [];
  const owner = config && config.center && typeof config.center.owner_person_id === 'string' ? config.center.owner_person_id : 'self';
  const rooms = validRooms(opts.rooms);
  const allIds = rooms.map((r) => manifestOf(r).id);
  const explicitRooms = Array.isArray(opts.roomIds) && opts.roomIds.length > 0;
  const roomIds = between ? [...between] : explicitRooms ? opts.roomIds.filter((id) => allIds.includes(id)) : [...allIds];
  const scopeRooms = rooms.filter((r) => roomIds.includes(manifestOf(r).id));
  const crossField = Boolean(between || withPerson);
  const max = Number.isInteger(opts.budget) && opts.budget > 0 ? opts.budget : (config && config.provider && Number.isInteger(config.provider.max_tokens_per_run) ? config.provider.max_tokens_per_run : DEFAULT_BUDGET);

  let provider = null;
  try { provider = resolveProvider(opts.provider, { config, env, fetch, spawn, relayDir: join(dotDir, 'relay'), tmpDir: join(dotDir, 'tmp') }); } catch (e) {
    if (!isProviderError(e)) throw e;
    checks.push(e.check);
  }
  const info = provider ? providerInfo(provider) : { adapter: typeof opts.provider === 'string' ? 'dry' : 'dry', model: null, argv_digest: null };
  if (provider) info.adapter = provider.id;
  const argv = Array.isArray(opts.argv) ? opts.argv.map(String) : defaultArgv({ task, roomIds, explicitRooms, between, withPerson, adapter: info.adapter, max });
  const request = { task, rooms: roomIds, between, with_person: withPerson, budget: max, provider: info.adapter, desks: desks ?? null };

  // Scope: a cross-field run needs --between or --with; a meet scene without either is refused.
  if (scene && !crossField) checks.push(fail('DF_RUN_SCOPE_REQUIRED', { path: '$.scope', detail: 'a meet scene was given without --between or --with' }));
  else if (between && (between.length !== 2 || between.some((id) => !allIds.includes(id)))) checks.push(fail('DF_RUN_SCOPE_REQUIRED', { path: '$.between', detail: `--between needs two rooms of this center, got ${JSON.stringify(between)}` }));
  else checks.push(pass('DF_RUN_SCOPE_REQUIRED'));

  const routing = route(task, roster, { rooms: between || explicitRooms ? roomIds : null, terms: personTerms, desks });
  checks.push(...routing.checks);
  const routed = routedDesks(routing);
  if (Array.isArray(planned) && JSON.stringify(planned) !== JSON.stringify(routing.specialists.map((s) => s.id))) {
    checks.push(fail('DF_RUN_ROUTE_PARITY', { path: '$.routing.specialists', detail: `plan listed [${planned.join(', ')}], run routed [${routing.specialists.map((s) => s.id).join(', ')}]` }));
  } else checks.push(pass('DF_RUN_ROUTE_PARITY'));

  const context = buildContext({ rooms: scopeRooms, records, scene, owner, fieldsAllowed });
  const id = runId({ now, task, rooms: roomIds, between, withPerson, by });
  const run = newRun({ id, task, now, roomIds, owner, viewer, routing, maxTokens: max, provider: info, between, withPerson });
  run.foreign_spans_count = context.spans.length;
  run.foreign_spans_digest = spansDigest(context.spans);
  run.proposal.blocked_actions = [...new Set(scopeRooms.flatMap((r) => manifestOf(r).blocked_actions || []))].sort();
  run.receipt_ref = receiptRef({ dotDir, root, id });
  const centerName = config && config.center && config.center.name ? config.center.name : 'this center';
  const scopeLine = { roomIds, between, withPerson };
  const before = storesSnapshot(dataDir);
  let proposalResult = null;
  let status = 'blocked';

  const step = async (name, desk, system, prompt) => {
    const need = estimateTokens(system, prompt);
    if (run.budget.used + need > max) {
      run.budget.exceeded = true;
      checks.push(fail('DF_RUN_BUDGET_EXCEEDED', { path: `$.steps[${run.steps.length}]`, detail: `${run.budget.used} used + ${need} for the ${name} prompt exceeds ${max}` }));
      return null;
    }
    // The owner's own task text is not foreign-derived; everything else in the prompt must keep its fence.
    const leaked = escapes(prompt.split(task).join(' '), context.guardValues, { minLength: GUARD_MIN_CHARS });
    if (leaked.length) {
      checks.push(fail('DF_RUN_FOREIGN_UNFENCED', { path: `$.steps[${run.steps.length}]`, detail: `${leaked.length} foreign value(s) outside a fence in the ${name} prompt (a desk or provider repeated foreign content without its fence)` }));
      return null;
    }
    let res;
    try { res = await provider.ask({ system, prompt, maxTokens: stepMaxTokens(name, max - run.budget.used), signal }); } catch (e) {
      checks.push(isProviderError(e) ? e.check : fail('DF_PROVIDER_UNAVAILABLE', { path: '$.provider', detail: e && e.message ? e.message : String(e) }));
      return null;
    }
    const text = closeFences(res.text);
    run.budget.used += res.tokens_used;
    run.steps.push(stepEntry({ index: run.steps.length, step: name, desk: desk.id, prompt, text, tokens_used: res.tokens_used, model: res.model, foreignValues: context.foreignValues }));
    transcript.push({ step: name, desk: desk.id, system, prompt, text });
    if (run.budget.used > max) {
      run.budget.exceeded = true;
      checks.push(fail('DF_RUN_BUDGET_EXCEEDED', { path: `$.steps[${run.steps.length - 1}]`, detail: `${run.budget.used} tokens used after the ${name} step exceeds ${max}` }));
      return null;
    }
    return text;
  };

  try {
    if (provider && !blocking(checks).length) {
      const conductorSystem = systemPrompt({ conductor: roster.conductor, centerName, blockedActions: run.proposal.blocked_actions, roleNote: CONDUCTOR_ROLE });
      const brief = await step('brief', roster.conductor, conductorSystem, briefPrompt({ task, scope: scopeLine, items: context.items, specialists: routing.specialists, challenger: routing.challenger }));
      const packets = [];
      for (const s of brief === null ? [] : routing.specialists) {
        const desk = deskById(roster, s.id);
        const text = await step('specialist', desk, systemPrompt({ desk, conductor: roster.conductor, centerName, blockedActions: run.proposal.blocked_actions }), specialistPrompt({ task, brief, items: context.items, desk, scope: scopeLine }));
        if (text === null) break;
        packets.push({ desk: desk.id, text });
      }
      let challenge = null;
      if (packets.length === routing.specialists.length && brief !== null) {
        const desk = deskById(roster, routing.challenger.id);
        challenge = await step('challenger', desk, systemPrompt({ desk, conductor: roster.conductor, centerName, blockedActions: run.proposal.blocked_actions }), challengerPrompt({ task, brief, packets, desk, scope: scopeLine }));
      }
      const synthesis = challenge === null ? null : await step('synthesis', roster.conductor, conductorSystem, synthesisPrompt({ task, brief, packets, challenge, scope: scopeLine }));
      if (synthesis !== null) {
        const extracted = extractClaims(synthesis, { items: context.items, desk: roster.conductor.id, crossField, foreignValues: context.foreignValues });
        checks.push(...extracted.checks);
        run.proposal.claims = extracted.claims;
        const target = pickTargetRoom(rooms, targetRoom);
        if (!target) checks.push(fail('DF_RUN_SCOPE_REQUIRED', { path: '$.proposal', detail: targetRoom ? `room '${targetRoom}' is not in the center` : 'no room can receive the idea note' }));
        if (!blocking(checks).length) {
          const m = manifestOf(target);
          const record = buildIdeaRecord(target, { runId: id, task, synthesis, date: isoSeconds(now).slice(0, 10), foreignValues: context.foreignValues });
          run.proposal.proposed_writes = [{ room: m.id, record }];
          proposalResult = await propose({ room: target, records: [record], by: `run:${id}`, scope: 'owner', kind: 'run', now, dataDir, config, env, argv: ['propose', m.id, '--run', id], root,
            foreignSpans: context.spans, blockedActions: run.proposal.blocked_actions, source: { kind: 'run', ref: id, digest: sha256(synthesis) }, runId: id });
          checks.push(...proposalResult.checks);
          if (proposalResult.ok) { run.proposal.proposal_ids = proposalResult.proposals.map((p) => p.proposal_id); status = 'awaiting_owner'; }
          else if (proposalResult.receipt.status === 'refused') status = 'refused';
        }
      }
    }
  } catch (e) {
    status = 'error';
    run.error = `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : String(e)}`.slice(0, 1000);
  }

  const after = storesSnapshot(dataDir);
  if (before === after) checks.push(pass('DF_RUN_WRITE_BEFORE_APPROVAL'));
  else { checks.push(fail('DF_RUN_WRITE_BEFORE_APPROVAL', { path: 'data/', detail: 'a file outside data/proposals/ changed during the run' })); if (status === 'awaiting_owner') status = 'blocked'; }
  for (const code of ['DF_RUN_BUDGET_EXCEEDED', 'DF_RUN_FOREIGN_UNFENCED', 'DF_RUN_CLAIM_WITHOUT_EVIDENCE']) if (!checks.some((c) => c.code === code)) checks.push(pass(code));
  run.status = status === 'awaiting_owner' ? 'awaiting_owner' : 'error';
  if (run.status === 'error' && !run.error) { const first = blocking(checks)[0]; run.error = first ? `${first.code}: ${first.message}` : 'the run ended without a proposal'; }
  checks.push(...runChecks(run));
  if (status === 'awaiting_owner' && blocking(checks).length) status = 'blocked';

  const files = writeRunFiles({ run, transcript, dotDir, root });
  const outputs = [...files.outputs, ...(proposalResult && proposalResult.ok ? proposalResult.receipt.outputs : [])];
  const target = pickTargetRoom(rooms, targetRoom);
  const m = target ? manifestOf(target) : null;
  const receipt = runReceipt({ run, roster, request, checks, outputs, status, now, argv, root, dotDir, maturity: m ? m.maturity : null, mode: m ? m.mode : null,
    store: proposalResult && proposalResult.receipt ? proposalResult.receipt.store : null, tokensUsed: run.budget.used });
  const written = writeRunReceipt(receipt, { dotDir, id });
  return {
    ok: run.status === 'awaiting_owner', run, receipt, checks, routing, routed, transcript, context,
    proposal: proposalResult && proposalResult.ok ? proposalResult.proposal : null,
    paths: { dir: files.dir, run: files.runPath, md: files.mdPath, receipt: written.path, index: written.index },
  };
}
