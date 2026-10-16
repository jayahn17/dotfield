// run.json, run.md and the run receipt (VISION 3, 8.4): the derived files
// under .dotfield/runs/<run_id>/ plus the index copy under
// .dotfield/receipts/. Deterministic under one clock: the run id is the
// stamp plus a digest of the request, every step is recorded by digest, and
// the receipt's inputs are inline digests of the request and the roster.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonical, sha256, sha256Hex } from '../digest.mjs';
import { buildReceipt, inlineInput, isoSeconds, receiptFilename, refDigest, writeReceipt } from '../receipt.mjs';
import { writeJsonAtomic } from '../rooms.mjs';
import { fail } from '../rules.mjs';
import { loadSchema, validate } from '../validate.mjs';
import { scrub, stripFences } from './fence.mjs';
import { renderRunMd } from './transcript.mjs';

export const SCHEMA_VERSION = 'dotfield.run/1';
export const EXCERPT_CHARS = 400;
export const RUN_FILE = 'run.json';
export const MD_FILE = 'run.md';
export const RECEIPT_FILE = 'receipt.json';

const posix = (p) => p.split(sep).join('/');
/** A path relative to root in posix form (absolute when outside root). */
export function rel(root, file) {
  const r = posix(relative(root, file));
  return r && !r.startsWith('..') ? r : posix(file);
}

export function runsDir(dotDir) { return join(dotDir, 'runs'); }
export function runDir(dotDir, id) { return join(runsDir(dotDir), id); }

/** run_<YYYYMMDD>_<HHMMSS>_<6 hex of sha256(canonical(request))>: same clock and request -> same id. */
export function runId({ now, task, rooms = [], between = null, withPerson = null, by = 'self' }) {
  const stamp = isoSeconds(now).replace(/[-:]/g, '').replace('T', '_').replace('Z', '');
  return `run_${stamp}_${sha256Hex(canonical({ task, rooms, between, with_person: withPerson, by })).slice(0, 6)}`;
}

/** One step record: digests of prompt and response, tokens, model and a scrubbed excerpt (no fence, no raw foreign value). */
export function stepEntry({ index, step, desk, prompt, text, tokens_used, model, foreignValues = [] }) {
  const safe = scrub(stripFences(String(text ?? '')), foreignValues).replace(/\s+/g, ' ').trim();
  return {
    index, step, desk,
    prompt_digest: sha256(String(prompt ?? '')),
    response_digest: sha256(String(text ?? '')),
    tokens_used: Number.isInteger(tokens_used) ? tokens_used : 0,
    model: typeof model === 'string' ? model : null,
    excerpt: safe.length > EXCERPT_CHARS ? `${safe.slice(0, EXCERPT_CHARS - 1)}…` : safe,
  };
}

/** The run document at start (status running) with every required key present. */
export function newRun({ id, task, now, roomIds, owner, viewer, routing, maxTokens, provider, between, withPerson }) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: id,
    task: String(task).slice(0, 2000),
    status: 'running',
    created_at: isoSeconds(now),
    scope: { rooms: [...roomIds], owner_person_id: owner, viewer },
    routing: { specialists: routing.specialists.map((s) => s.id), challenger: routing.challenger ? routing.challenger.id : null, tokens: routing.tokens.slice(0, 64) },
    steps: [],
    proposal: { proposal_ids: [], proposed_writes: [], claims: [], blocked_actions: [] },
    budget: { max_tokens: maxTokens, used: 0, exceeded: false },
    provider: { adapter: provider.adapter, model: provider.model ?? null, argv_digest: provider.argv_digest ?? null },
    between: between ? [between[0], between[1]] : null,
    with_person: withPerson ?? null,
    foreign_spans_digest: null,
    foreign_spans_count: 0,
    receipt_ref: null,
    error: null,
  };
}

/** Schema findings for a run document as checks (path run.json#$...). */
export function runChecks(run) {
  const v = validate(loadSchema('run'), run);
  return v.errors.map((e) => fail(e.code, { path: `run.json#${e.path}`, detail: e.message }));
}

/** tmp + fsync + rename, the same discipline as writeJsonAtomic, for the markdown twin. */
export function writeTextAtomic(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return file;
}

/**
 * writeRunFiles({run, transcript, dotDir, root}) -> {dir, runPath, mdPath, outputs}
 * Writes run.json and run.md atomically under .dotfield/runs/<id>/ and
 * returns their receipt output entries (ref relative to root).
 */
export function writeRunFiles({ run, transcript = [], dotDir, root }) {
  const dir = runDir(dotDir, run.run_id);
  mkdirSync(dir, { recursive: true });
  const runPath = writeJsonAtomic(join(dir, RUN_FILE), run);
  const mdPath = writeTextAtomic(join(dir, MD_FILE), renderRunMd(run, transcript));
  const outputs = [
    { ...refDigest(runPath, root), ref: rel(root, runPath), kind: 'run', action: 'written' },
    { ...refDigest(mdPath, root), ref: rel(root, mdPath), kind: 'transcript', action: 'written' },
  ];
  return { dir, runPath, mdPath, outputs };
}

/** The receipt_ref a run carries before its receipt exists: deterministic, relative to root. */
export function receiptRef({ dotDir, root, id }) {
  return rel(root, join(runDir(dotDir, id), RECEIPT_FILE));
}

/**
 * runReceipt({run, roster, request, checks, outputs, status, now, argv, root,
 *   dotDir, maturity, mode, store, tokensUsed}) -> receipt
 * status: awaiting_owner (a proposal awaits), blocked (a gate or provider
 * check failed; the run ended cleanly without a proposal) or error.
 */
export function runReceipt({ run, roster, request, checks, outputs, status, now, argv, root, dotDir, maturity = null, mode = null, store = null, tokensUsed = 0 }) {
  const ids = run.proposal.proposal_ids;
  const md = rel(root, join(runDir(dotDir, run.run_id), MD_FILE));
  const provider = { adapter: run.provider.adapter, model: run.provider.model, tokens_used: tokensUsed, argv_digest: run.provider.argv_digest };
  let nextAction;
  if (status === 'awaiting_owner') nextAction = `Run ${run.run_id} awaits the owner: read ${md}, then dotfield approve ${ids[0] || '<proposal_id>'} --decision approve|edit|reject from a TTY or the inbox page. The agent cannot issue approve.`;
  else if (status === 'blocked') nextAction = `Run ${run.run_id} ended without a proposal; fix the failing check by its repair sentence and run again.`;
  return buildReceipt({
    command: 'run', argv, now, root,
    inputs: [inlineInput('run-request', request), inlineInput('roster', { digest: roster.digest, desks: roster.desks.map((d) => d.id) })],
    checks, outputs, status, maturity, scope: 'owner', viewer: run.scope.viewer, mode, store,
    ownerDecision: { state: status === 'awaiting_owner' ? 'awaiting_owner' : 'not_required', reviewed_summary_digest: null },
    blockedActions: run.proposal.blocked_actions, provider, foreignSpansDigest: run.foreign_spans_digest,
    nextAction,
    releaseTag: run.with_person ? 'v1.1-provisional' : 'v1.0',
  });
}

/** Write the receipt next to run.json and under .dotfield/receipts/; returns both paths. */
export function writeRunReceipt(receipt, { dotDir, id }) {
  const path = writeReceipt(receipt, runDir(dotDir, id), { filename: RECEIPT_FILE });
  const index = writeReceipt(receipt, join(dotDir, 'receipts'), { filename: receiptFilename(receipt) });
  return { path, index };
}
