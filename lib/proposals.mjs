// The approval hop (VISION §1, §8.5): every write path is a proposal file
// under data/proposals/ until the owner decides. propose() writes that file
// and nothing else; summarize() builds what the owner must see; decide() is
// the one function that turns a proposal into a store write, reached only by
// dotfield approve (TTY or owner token) and the inbox decide route. There is
// no flag that turns proposals into writes. checkRecords() holds the per-row
// DF_RECORD_* checks that import and propose share.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonical, sha256, sha256File, sha256Hex } from './digest.mjs';
import { buildReceipt, compactStamp, inlineInput, isoSeconds, receiptFilename, receiptId, refDigest, writeReceipt } from './receipt.mjs';
import { writeJsonAtomic } from './rooms.mjs';
import { fail, pass } from './rules.mjs';
import { createStore, isStoreError } from './store.mjs';
import { isDate, loadSchema, validate } from './validate.mjs';

export const SCHEMA_VERSION = 'dotfield.proposal/1';
export const KINDS = Object.freeze(['records', 'run', 'rule', 'pair']);
export const DECISIONS = Object.freeze(['approve', 'edit', 'reject']);
export const STATE_OF = Object.freeze({ approve: 'approved', edit: 'edited', reject: 'rejected' });
export const DEFAULT_MAX_PER_PROPOSAL = 200;
export const SAMPLE_ROWS = 5;
export const CLIP = 200;
const RECORD_CODES = ['DF_RECORD_SCHEMA_INVALID', 'DF_RECORD_ID_MISSING', 'DF_RECORD_DUP_ID', 'DF_RECORD_TOO_LARGE', 'DF_RECORD_DATE_INVALID'];

const posix = (p) => p.split(sep).join('/');
const rel = (root, file) => { const r = posix(relative(root, file)); return r && !r.startsWith('..') ? r : posix(file); };
const manifestOf = (room) => (room && room.manifest ? room.manifest : room);
const blocking = (checks) => checks.filter((c) => c.status === 'fail' && c.blocking);

export function proposalsDir(dataDir) { return join(dataDir, 'proposals'); }
export function proposalPath(dataDir, id) { return join(proposalsDir(dataDir), `${id}.json`); }
export function summaryDigest(summary) { return sha256(canonical(summary)); }

/** prop_<stamp>_<6 hex of sha256(canonical({room, by, scope, kind, index, records}))>: same clock and content -> same id. */
export function proposalId({ now, room, by, scope, kind = 'records', index = 1, records = [] }) {
  return `prop_${compactStamp(now)}_${sha256Hex(canonical({ room, by, scope, kind, index, records })).slice(0, 6)}`;
}

function clip(value) {
  if (typeof value === 'string') return value.length > CLIP ? `${value.slice(0, CLIP)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  const s = canonical(value);
  return s.length > CLIP ? `${s.slice(0, CLIP)}…` : value;
}

/**
 * summarize({room, records, existing, foreignSpans, blockedActions}) ->
 * {adds, changes, unchanged, fields_touched[], sample_rows[<=5], foreign_spans[], blocked_actions[]}
 * compared by the room id_field against the records already in the store.
 */
export function summarize({ room, records = [], existing = [], foreignSpans = [], blockedActions = [] }) {
  const idField = manifestOf(room).record.id_field;
  const byId = new Map(existing.map((r) => [String(r[idField]), r]));
  let adds = 0; let changes = 0; let unchanged = 0;
  const fields = new Set();
  for (const r of records) {
    for (const k of Object.keys(r)) fields.add(k);
    const before = byId.get(String(r[idField]));
    if (!before) adds += 1;
    else if (canonical(before) === canonical(r)) unchanged += 1;
    else changes += 1;
  }
  const sample = records.slice(0, SAMPLE_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)])));
  return { adds, changes, unchanged, fields_touched: [...fields].sort(), sample_rows: sample, foreign_spans: [...foreignSpans], blocked_actions: [...blockedActions].map(String) };
}

/** Per-row checks (DF_RECORD_*) for a room's records: schema, id present and unique, size, the date fields. */
export function checkRecords(room, records) {
  const m = manifestOf(room);
  const schema = room && room.recordSchema ? room.recordSchema : null;
  if (!Array.isArray(records)) return [fail('DF_RECORD_SCHEMA_INVALID', { path: '$', detail: 'records is not an array' })];
  if (!schema) return [fail('DF_RECORD_SCHEMA_INVALID', { path: '$', detail: `room ${m.id} has no loaded record.schema.json` })];
  const out = [];
  const seen = new Map();
  const dateFields = Object.values(m.record.dates || {});
  records.forEach((rec, i) => {
    const at = `$[${i}]`;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { out.push(fail('DF_RECORD_SCHEMA_INVALID', { path: at, detail: 'not an object' })); return; }
    const v = validate(schema, rec, { path: at });
    if (!v.ok) {
      for (const e of v.errors) out.push({ ...fail(e.code, { path: e.path }), message: e.message });
      out.push(fail('DF_RECORD_SCHEMA_INVALID', { path: at, detail: `${v.errors.length} schema finding(s), first ${v.errors[0].code} at ${v.errors[0].path}` }));
    }
    const id = rec[m.record.id_field];
    if (id === undefined || id === null || String(id).trim() === '') out.push(fail('DF_RECORD_ID_MISSING', { path: `${at}.${m.record.id_field}`, detail: `no value for id_field '${m.record.id_field}'` }));
    else if (seen.has(String(id))) out.push(fail('DF_RECORD_DUP_ID', { path: `${at}.${m.record.id_field}`, detail: `'${id}' is also the id at $[${seen.get(String(id))}]` }));
    else seen.set(String(id), i);
    const bytes = Buffer.byteLength(canonical(rec), 'utf8');
    if (bytes > m.store.max_record_bytes) out.push(fail('DF_RECORD_TOO_LARGE', { path: at, detail: `${bytes} bytes > store.max_record_bytes ${m.store.max_record_bytes}` }));
    for (const f of dateFields) {
      if (rec[f] !== undefined && rec[f] !== null && !isDate(String(rec[f]))) out.push(fail('DF_RECORD_DATE_INVALID', { path: `${at}.${f}`, detail: `${JSON.stringify(rec[f])} is not YYYY-MM-DD` }));
    }
  });
  for (const code of RECORD_CODES) if (!out.some((c) => c.code === code)) out.push(pass(code));
  return out;
}

function mergeById(existing, incoming, idField) {
  const out = existing.map((r) => structuredClone(r));
  const index = new Map(out.map((r, i) => [String(r[idField]), i]));
  for (const r of incoming) {
    const key = String(r[idField]);
    if (index.has(key)) out[index.get(key)] = structuredClone(r);
    else { index.set(key, out.length); out.push(structuredClone(r)); }
  }
  return out;
}

export function readProposal(dataDir, id) {
  const file = proposalPath(dataDir, String(id));
  if (!/^prop_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}$/.test(String(id)) || !existsSync(file)) return { ok: false, proposal: null, path: file, check: fail('DF_PROPOSAL_NOT_FOUND', { path: String(id), detail: 'no proposal file with that id' }) };
  try {
    const proposal = JSON.parse(readFileSync(file, 'utf8'));
    const v = validate(loadSchema('proposal'), proposal);
    if (!v.ok) return { ok: false, proposal: null, path: file, check: fail('DF_PROPOSAL_NOT_FOUND', { path: String(id), detail: `the proposal file is invalid: ${v.errors[0].code} at ${v.errors[0].path}` }) };
    return { ok: true, proposal, path: file, check: pass('DF_PROPOSAL_NOT_FOUND') };
  } catch (e) {
    return { ok: false, proposal: null, path: file, check: fail('DF_PROPOSAL_NOT_FOUND', { path: String(id), detail: `unreadable: ${e.message}` }) };
  }
}

/** Every proposal under data/proposals/, optionally filtered by status, room or kind; sorted by created_at then id. */
export function list({ dataDir, status = null, room = null, kind = null } = {}) {
  const dir = proposalsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const r = readProposal(dataDir, f.slice(0, -5));
    if (!r.ok) continue;
    const p = r.proposal;
    if ((status && p.status !== status) || (room && p.room !== room) || (kind && p.kind !== kind)) continue;
    out.push(p);
  }
  return out.sort((a, b) => (a.created_at === b.created_at ? (a.proposal_id < b.proposal_id ? -1 : 1) : (a.created_at < b.created_at ? -1 : 1)));
}

function receiptFor(opts) {
  return buildReceipt({ releaseTag: 'v1.0', ...opts });
}

/**
 * propose({room, records, by, scope, kind, now, dataDir, config, env, argv, root,
 *   foreignSpans, blockedActions, source, runId}) ->
 *   {ok, proposals[], proposal, paths[], checks, receipt}
 * Writes data/proposals/<id>.json and nothing else; refuses when the room
 * mode is not proposal_only (DF_PROPOSAL_MODE_REFUSED, exit 3); blocks on any
 * DF_RECORD_* failure; splits above approval.max_records_per_proposal. The id
 * is deterministic, so a proposal file may already exist: one still
 * awaiting_owner is reused untouched, one already decided is final and the
 * call is refused (DF_PROPOSAL_ALREADY_DECIDED, exit 3) — a decision is never
 * overwritten by a repeat of the same proposal.
 */
export async function propose({ room, records, by = 'self', scope = 'owner', kind = 'records', now, dataDir, config = null, env = process.env, argv = null, root = null, foreignSpans = [], blockedActions = null, source = null, runId = null } = {}) {
  if (now === undefined || now === null) throw new TypeError('propose needs now (ctx.now)');
  if (!KINDS.includes(kind)) throw new TypeError(`unknown proposal kind ${String(kind)}`);
  const m = manifestOf(room);
  const rootDir = root || resolve(dataDir, '..');
  const scopeName = typeof scope === 'string' ? scope : scope.scope;
  const viewer = scopeName === 'owner' ? 'self' : scopeName.slice('person_'.length);
  const blocked = blockedActions ?? [...(m.blocked_actions || [])];
  const checks = [];
  const argvOut = argv ?? ['propose', m.id];
  const base = { command: 'propose', argv: argvOut, now, inputs: [inlineInput('records', records)], maturity: m.maturity, scope: scopeName, viewer, mode: m.mode, blockedActions: blocked, root: rootDir };
  if (m.mode !== 'proposal_only') {
    checks.push(fail('DF_PROPOSAL_MODE_REFUSED', { path: `center/rooms/${m.id}/room.json#$.mode`, detail: `mode is ${m.mode}` }));
    return { ok: false, proposals: [], proposal: null, paths: [], checks, receipt: receiptFor({ ...base, checks, status: 'refused' }) };
  }
  checks.push(pass('DF_PROPOSAL_MODE_REFUSED'));
  checks.push(...checkRecords(room, records));
  let store = null;
  let existing = [];
  if (!blocking(checks).length) {
    try { store = createStore({ room, dataDir, scope, config, env, root: rootDir }); checks.push(...store.checks); existing = await store.read(); } catch (e) {
      if (!isStoreError(e)) throw e;
      checks.push(e.check);
    }
  }
  if (blocking(checks).length) return { ok: false, proposals: [], proposal: null, paths: [], checks, receipt: receiptFor({ ...base, checks, status: 'blocked', store: store ? store.target() : null }) };
  const max = config && config.approval && Number.isInteger(config.approval.max_records_per_proposal) ? config.approval.max_records_per_proposal : DEFAULT_MAX_PER_PROPOSAL;
  const batches = [];
  for (let i = 0; i < records.length; i += max) batches.push(records.slice(i, i + max));
  if (!batches.length) batches.push([]);
  if (batches.length > 1) checks.push(fail('DF_PROPOSAL_SPLIT', { detail: `${records.length} records split into ${batches.length} proposals of at most ${max}` }));
  else checks.push(pass('DF_PROPOSAL_SPLIT'));
  const batchId = sha256Hex(canonical({ room: m.id, by, scope: scopeName, records })).slice(0, 12);
  const schema = loadSchema('proposal');
  const built = batches.map((batch, i) => {
    const summary = summarize({ room, records: batch, existing, foreignSpans, blockedActions: blocked });
    const proposal = {
      schema_version: SCHEMA_VERSION, proposal_id: proposalId({ now, room: m.id, by, scope: scopeName, kind, index: i + 1, records: batch }),
      kind, room: m.id, scope: scopeName, by, run_id: runId, source, records: batch, summary, summary_digest: summaryDigest(summary),
      status: 'awaiting_owner', owner_decision: { state: 'awaiting_owner', decision: null, reviewed_summary_digest: null, note: null },
      created_at: isoSeconds(now), decided_at: null, receipt_ref: null, split: batches.length > 1 ? { batch_id: batchId, index: i + 1, of: batches.length } : null,
    };
    const v = validate(schema, proposal);
    if (!v.ok) throw new Error(`propose built an invalid proposal: ${v.errors[0].code} at ${v.errors[0].path}`);
    return { proposal, existing: readProposal(dataDir, proposal.proposal_id) };
  });
  // The id is deterministic (clock + content), so a file may already be there. A decided one is final:
  // nothing is overwritten and the second propose is refused (exit 3); an awaiting one is reused as it is.
  const decided = built.filter((b) => b.existing.ok && b.existing.proposal.status !== 'awaiting_owner');
  if (decided.length) {
    for (const b of decided) checks.push(fail('DF_PROPOSAL_ALREADY_DECIDED', { path: b.proposal.proposal_id, detail: `the same records were proposed under this clock and already ${b.existing.proposal.status} (decision '${b.existing.proposal.owner_decision.decision}'); the decided file is kept` }));
    return { ok: false, proposals: [], proposal: null, paths: [], checks, receipt: receiptFor({ ...base, checks, status: 'refused', store: store.target(), ownerDecision: { state: decided[0].existing.proposal.owner_decision.state, reviewed_summary_digest: decided[0].existing.proposal.owner_decision.reviewed_summary_digest } }) };
  }
  checks.push(pass('DF_PROPOSAL_ALREADY_DECIDED'));
  const proposals = [];
  const paths = [];
  const outputs = [];
  let reused = 0;
  for (const b of built) {
    const file = proposalPath(dataDir, b.proposal.proposal_id);
    if (b.existing.ok) { reused += 1; proposals.push(b.existing.proposal); paths.push(file); outputs.push({ ...refDigest(file, rootDir), ref: rel(rootDir, file), kind: 'proposal' }); continue; }
    paths.push(writeJsonAtomic(file, b.proposal));
    proposals.push(b.proposal);
    outputs.push({ ...refDigest(file, rootDir), ref: rel(rootDir, file), kind: 'proposal', action: 'written' });
  }
  const receipt = receiptFor({ ...base, checks, outputs, status: 'proposal', store: store.target(), ownerDecision: { state: 'awaiting_owner', reviewed_summary_digest: null },
    nextAction: `Proposal ${proposals.map((p) => p.proposal_id).join(', ')} awaits the owner${reused ? ` (${reused} of ${proposals.length} already awaiting under this clock, left as written)` : ''}: review the summary, then dotfield approve <id> --decision approve|edit|reject from a TTY or the inbox page.` });
  return { ok: true, proposals, proposal: proposals[0], paths, checks, receipt };
}

function refuse(code, detail, path) {
  return fail(code, { path, detail });
}

/**
 * decide(id, {decision, note, edited, reviewedDigest, now, dataDir, dotDir, rooms, config, env, argv, root, by}) ->
 *   {ok, proposal, written, applied, idempotent, checks, receipt, receiptPath}
 * approve/edit write the room store through store.write({approved: true}) and
 * then the decided proposal; reject writes only the proposal. A repeated
 * identical decision changes nothing and is ok; a different one is refused
 * with DF_PROPOSAL_ALREADY_DECIDED. reviewedDigest must equal the proposal's
 * summary_digest for approve and edit (DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH).
 * Kinds rule and pair record the decision only; share.mjs and meet.mjs apply it.
 */
export async function decide(id, { decision, note = null, edited = null, reviewedDigest = null, now, dataDir, dotDir = null, rooms = [], config = null, env = process.env, argv = null, root = null, by = 'self' } = {}) {
  if (now === undefined || now === null) throw new TypeError('decide needs now (ctx.now)');
  const rootDir = root || resolve(dataDir, '..');
  const checks = [];
  const argvOut = argv ?? ['approve', String(id), '--decision', String(decision)];
  const found = readProposal(dataDir, id);
  checks.push(found.check);
  const done = (status, extra = {}, receiptOpts = {}) => {
    const receipt = receiptFor({ command: 'approve', argv: argvOut, now, root: rootDir, checks, status, ...receiptOpts });
    return { ok: !blocking(checks).length && receipt.ok, proposal: found.proposal, written: null, applied: false, idempotent: false, checks, receipt, receiptPath: null, ...extra };
  };
  if (!found.ok) return done('refused');
  const p = found.proposal;
  const inputs = [inlineInput('proposal', p), inlineInput('reviewed_summary_digest', reviewedDigest)];
  const list = Array.isArray(rooms) ? rooms : (rooms && Array.isArray(rooms.rooms) ? rooms.rooms : [rooms]);
  const room = p.room ? list.find((r) => r && r.id === p.room) : null;
  const m = room ? manifestOf(room) : null;
  const common = { inputs, maturity: m ? m.maturity : null, mode: m ? m.mode : null, scope: p.scope, viewer: p.scope === 'owner' ? 'self' : p.scope.slice('person_'.length), blockedActions: p.summary.blocked_actions };
  if (!DECISIONS.includes(decision)) { checks.push(refuse('DF_PROPOSAL_INVALID_DECISION', `got ${JSON.stringify(decision)}`, '$.decision')); return done('refused', {}, common); }
  checks.push(pass('DF_PROPOSAL_INVALID_DECISION'));
  if (p.status !== 'awaiting_owner') {
    if (p.status === 'draft') { checks.push(refuse('DF_PROPOSAL_NOT_AWAITING', 'the proposal is a draft', p.proposal_id)); return done('refused', {}, common); }
    if (p.owner_decision.decision === decision) {
      checks.push(pass('DF_PROPOSAL_ALREADY_DECIDED'));
      return done(p.status === 'rejected' ? 'rejected' : 'approved', { idempotent: true }, { ...common, ownerDecision: { state: p.owner_decision.state, reviewed_summary_digest: p.owner_decision.reviewed_summary_digest }, nextAction: `Proposal ${p.proposal_id} was already ${p.status}; nothing changed.` });
    }
    checks.push(refuse('DF_PROPOSAL_ALREADY_DECIDED', `already ${p.status} by decision '${p.owner_decision.decision}', now asked to '${decision}'`, p.proposal_id));
    return done('refused', {}, common);
  }
  checks.push(pass('DF_PROPOSAL_NOT_AWAITING'), pass('DF_PROPOSAL_ALREADY_DECIDED'));
  const needsDigest = decision !== 'reject' || reviewedDigest !== null;
  if (needsDigest && reviewedDigest !== p.summary_digest) { checks.push(refuse('DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH', reviewedDigest ? `reviewed ${reviewedDigest}, current ${p.summary_digest}` : 'no reviewed summary digest was given', '$.summary_digest')); return done('refused', {}, common); }
  checks.push(pass('DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH'));
  const writes = (p.kind === 'records' || p.kind === 'run') && p.room !== null;
  if (writes && !room) { checks.push(refuse('DF_PROPOSAL_NOT_FOUND', `room '${p.room}' is not in the center`, p.proposal_id)); return done('refused', {}, common); }
  let records = p.records;
  if (decision === 'edit') {
    const rowChecks = writes ? checkRecords(room, edited) : (Array.isArray(edited) ? [] : [fail('DF_RECORD_SCHEMA_INVALID', { path: '$', detail: 'edited is not an array' })]);
    checks.push(...rowChecks);
    if (blocking(rowChecks).length) { checks.push(refuse('DF_PROPOSAL_EDIT_FILE_INVALID', `${blocking(rowChecks).length} failing row check(s)`, '$.edited')); return done('blocked', {}, common); }
    checks.push(pass('DF_PROPOSAL_EDIT_FILE_INVALID'));
    records = edited;
  }
  const rid = receiptId({ inputs, command: 'approve', argv: argvOut, now });
  const receiptRef = dotDir ? `${rel(rootDir, join(dotDir, 'receipts', `${rid}.json`))}` : null;
  let written = null;
  let store = null;
  const outputs = [];
  if (decision !== 'reject' && writes) {
    try {
      store = createStore({ room, dataDir, scope: p.scope, config, env, root: rootDir });
      checks.push(...store.checks);
      const merged = mergeById(await store.read(), records, m.record.id_field);
      written = await store.write(merged, { approved: true, now, by });
      checks.push(pass('DF_STORE_MAX_RECORDS'), pass('DF_STORE_MAX_BYTES'), pass('DF_STORE_FAULT'), pass('DF_STORE_WRITE_WITHOUT_APPROVAL'));
      const fileDigest = store.backend === 'file' ? refDigest(store.path(), rootDir) : null;
      outputs.push({ ref: written.target, digest: fileDigest ? fileDigest.digest : null, bytes: written.bytes, kind: 'store', action: 'written' });
    } catch (e) {
      if (!isStoreError(e)) throw e;
      checks.push(e.check);
      return done('blocked', {}, { ...common, store: store ? store.target() : null });
    }
  }
  const decided = {
    ...p, records, status: STATE_OF[decision], decided_at: isoSeconds(now), receipt_ref: receiptRef,
    owner_decision: { state: STATE_OF[decision], decision, reviewed_summary_digest: reviewedDigest, note: note === null || note === undefined ? null : String(note).slice(0, 2000) },
  };
  writeJsonAtomic(found.path, decided);
  outputs.push({ ...refDigest(found.path, rootDir), ref: rel(rootDir, found.path), kind: 'proposal', action: 'written' });
  const applied = Boolean(written);
  const receipt = receiptFor({
    command: 'approve', argv: argvOut, now, root: rootDir, checks, outputs, status: decision === 'reject' ? 'rejected' : 'approved',
    ...common, store: store ? store.target() : null, ownerDecision: { state: STATE_OF[decision], reviewed_summary_digest: reviewedDigest },
    nextAction: decision === 'reject' ? `Proposal ${p.proposal_id} is rejected; nothing was written.` : applied ? `${written.count} record(s) now in ${written.target}; render the room to see them.` : `Proposal ${p.proposal_id} is ${STATE_OF[decision]}; the ${p.kind} effect is applied by its own verb.`,
  });
  const receiptPath = dotDir ? writeReceipt(receipt, join(dotDir, 'receipts'), { filename: receiptFilename(receipt) }) : null;
  return { ok: receipt.ok, proposal: decided, written, applied, idempotent: false, checks, receipt, receiptPath };
}
