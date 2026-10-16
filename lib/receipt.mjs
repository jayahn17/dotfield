// Receipts (VISION §8.4): buildReceipt (deterministic id and bytes under one
// clock), writeReceipt (atomic), readReceipt, verifyReceipt (recomputes every
// digest). No wall clock is read here: callers pass ctx.now.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digestTree, sha256, sha256File, sha256Hex } from './digest.mjs';
import { OK, fromReceipt } from './exit-codes.mjs';
import { RULES, fail, pass, summarize } from './rules.mjs';
import { validateAgainst } from './validate.mjs';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_VERSION = 'dotfield.receipt/1';
export const STATUSES = Object.freeze(['read', 'proposal', 'written', 'awaiting_owner', 'approved', 'rejected', 'blocked', 'refused', 'error']);
export const DECISION_STATES = Object.freeze(['not_required', 'awaiting_owner', 'approved', 'edited', 'rejected']);
export const RELEASE_TAGS = Object.freeze(['v1.0', 'v1.1-provisional']);
export const ENGINE_DIGEST_MEANING = 'detects unintended local edits; not tamper evidence';

function toDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  if (typeof now === 'string') { const d = new Date(now); if (!Number.isNaN(d.getTime())) return d; }
  throw new TypeError('a receipt needs now (Date, epoch ms or ISO string); pass ctx.now');
}

/** The one clock rule: SOURCE_DATE_EPOCH (seconds) wins, else the fallback the caller read. */
export function nowFrom(env, fallback) {
  const epoch = env ? env.SOURCE_DATE_EPOCH : undefined;
  if (typeof epoch === 'string' && /^[0-9]+$/.test(epoch)) return new Date(Number(epoch) * 1000);
  if (fallback === undefined) throw new TypeError('nowFrom needs a fallback date when SOURCE_DATE_EPOCH is unset');
  return toDate(fallback);
}

export function isoSeconds(now) {
  return toDate(now).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
}

export function compactStamp(now) {
  return isoSeconds(now).replace(/[-:]/g, '');
}

/** sha256(canonical(inputs) + command + argv), truncated to 4 hex. */
export function idSuffix({ inputs = [], command, argv = [] }) {
  return sha256Hex(`${canonical(inputs)}\n${String(command)}\n${canonical(argv)}`).slice(0, 4);
}

export function receiptId({ inputs, command, argv, now }) {
  return `rcpt_${compactStamp(now)}_${idSuffix({ inputs, command, argv })}`;
}

export function receiptFilename(receipt) {
  return `${receipt.receipt_id}.json`;
}

export function engineVersion(root = PACKAGE_ROOT) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

/** Digests of lib/ and schemas/ plus whether they match skill-release.json (null when absent). */
export function engineDigests(root = PACKAGE_ROOT) {
  const lib = digestTree(join(root, 'lib')).digest;
  const schemas = digestTree(join(root, 'schemas'), { include: (p) => p.endsWith('.json') }).digest;
  let match_release = null;
  try {
    const rel = JSON.parse(readFileSync(join(root, 'skill-release.json'), 'utf8'));
    if (rel && rel.digests && typeof rel.digests.lib === 'string' && typeof rel.digests.schemas === 'string') {
      match_release = rel.digests.lib === lib && rel.digests.schemas === schemas;
    }
  } catch { match_release = null; }
  return { lib, schemas, match_release, meaning: ENGINE_DIGEST_MEANING };
}

/** {ref, digest, bytes} for a file (ref relative to root), or null when it is not a regular file. */
export function refDigest(ref, root = PACKAGE_ROOT) {
  const abs = isAbsolute(ref) ? ref : resolve(root, ref);
  try {
    const st = statSync(abs);
    return st.isFile() ? { ref, digest: sha256File(abs), bytes: st.size } : null;
  } catch { return null; }
}

/** An input entry for an inline document (MCP, routes): ref "inline:<name>". */
export function inlineInput(name, doc) {
  const text = canonical(doc);
  return { ref: `inline:${name}`, digest: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
}

function normalizeCheck(c) {
  const r = RULES[c.code];
  const out = {
    code: String(c.code),
    gate: c.gate ?? (r ? r.gate : 'unknown'),
    blocking: typeof c.blocking === 'boolean' ? c.blocking : (r ? r.blocking : true),
    status: c.status === 'pass' ? 'pass' : 'fail',
  };
  if (out.status === 'fail') {
    if (c.path !== undefined && c.path !== null) out.path = String(c.path);
    out.message = c.message ?? (r ? r.message : '');
    out.repair = c.repair ?? (r ? r.repair : '');
  }
  return out;
}

function inputRef(x) {
  const out = { ref: String(x.ref), digest: x.digest };
  if (Number.isInteger(x.bytes)) out.bytes = x.bytes;
  return out;
}

function outputRef(x) {
  const out = { ref: String(x.ref), digest: x.digest ?? null };
  for (const k of ['bytes', 'kind', 'embedded_three', 'action']) if (x[k] !== undefined) out[k] = x[k];
  return out;
}

function defaultNextAction(status, sum) {
  switch (status) {
    case 'blocked': return `Fix the ${sum.blocking_failures} blocking finding(s) by their repair sentences, then run the command again.`;
    case 'awaiting_owner': return 'Review the summary and decide with dotfield approve <id> --decision approve|edit|reject from a TTY or the inbox page.';
    case 'proposal': return 'The proposal awaits the owner: open the inbox page or run dotfield approve <id>.';
    case 'refused': return 'Nothing was changed; read the failing check and apply its repair sentence.';
    case 'error': return 'Read the error check, fix the cause, and run the command again.';
    default: return 'No further action is required.';
  }
}

export function bodyDigest(receipt) {
  return sha256(canonical({ ...receipt, digest: undefined }));
}

/**
 * buildReceipt({command, argv, now, inputs, checks, outputs, status?, maturity,
 * scope, viewer, mode, store, ownerDecision, blockedActions, provider,
 * foreignSpansDigest, evidence, nextAction, releaseTag, root, engineDigests?,
 * engineVersion?}) -> receipt. Same inputs and clock -> same bytes and id.
 */
export function buildReceipt(opts = {}) {
  const {
    command, argv = [], now, inputs = [], checks = [], outputs = [], status, maturity = null,
    scope = 'owner', viewer = 'self', mode = null, store = null, ownerDecision, blockedActions = [],
    provider = null, foreignSpansDigest = null, evidence, nextAction, releaseTag = 'v1.0',
    root = PACKAGE_ROOT,
  } = opts;
  if (typeof command !== 'string' || !command) throw new TypeError('buildReceipt needs a command name');
  if (!RELEASE_TAGS.includes(releaseTag)) throw new TypeError(`unknown release tag ${String(releaseTag)}`);
  const date = toDate(now);
  const normChecks = checks.map(normalizeCheck);
  const sum = summarize(normChecks);
  const finalStatus = status ?? (sum.blocking_failures ? 'blocked' : (outputs.length ? 'written' : 'read'));
  if (!STATUSES.includes(finalStatus)) throw new TypeError(`unknown receipt status ${String(status)}`);
  const receipt = {
    receipt_id: receiptId({ inputs: inputs.map(inputRef), command, argv: argv.map(String), now: date }),
    schema_version: SCHEMA_VERSION,
    command,
    argv: argv.map(String),
    generated_at: isoSeconds(date),
    engine_version: opts.engineVersion ?? engineVersion(root),
    release_tag: releaseTag,
    engine_digests: opts.engineDigests ?? engineDigests(root),
    status: finalStatus,
    ok: false,
    exit_code: OK,
    maturity, scope, viewer, mode, store,
    inputs: inputs.map(inputRef),
    checks: normChecks,
    outputs: outputs.map(outputRef),
    owner_decision: {
      state: ownerDecision?.state ?? 'not_required',
      reviewed_summary_digest: ownerDecision?.reviewed_summary_digest ?? null,
    },
    blocked_actions: [...blockedActions].map(String),
    provider,
    foreign_spans_digest: foreignSpansDigest,
    evidence: {
      browser: evidence?.browser ?? 'not_captured',
      screenshot_ref: evidence?.screenshot_ref ?? null,
      device: evidence?.device ?? null,
    },
    next_action: nextAction ?? defaultNextAction(finalStatus, sum),
  };
  receipt.exit_code = fromReceipt(receipt);
  receipt.ok = receipt.exit_code === OK;
  receipt.digest = bodyDigest(receipt);
  return receipt;
}

export function serializeReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/** Atomic write (tmp + fsync + rename) of <dir>/<filename>; returns the path. */
export function writeReceipt(receipt, dir, { filename = 'receipt.json' } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, filename);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeReceipt(receipt), 'utf8');
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return file;
}

export function readReceipt(path) {
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { ok: false, error: 'receipt is not a JSON object' };
    return { ok: true, receipt };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** Engine-owned folders a customer never edits (VISION §9): a ref under one of them that is absent from the fork root is looked up in the engine root (init records its pack inputs this way). */
export const ENGINE_REF_DIRS = Object.freeze(['packs', 'examples', 'schemas', 'renderers', 'lib', 'importers', 'migrations', 'recipes', 'vendor', 'test']);
const underEngineDir = (ref) => !isAbsolute(ref) && ENGINE_REF_DIRS.some((d) => ref === d || ref.startsWith(`${d}/`));

/** The current {ref, digest, bytes} of a receipt ref: the fork root first, the engine root for an engine-folder ref the fork does not hold. */
export function resolveRef(ref, { root = PACKAGE_ROOT, engineRoot = PACKAGE_ROOT } = {}) {
  const atRoot = refDigest(ref, root);
  if (atRoot || resolve(engineRoot) === resolve(root) || !underEngineDir(ref)) return atRoot;
  return refDigest(ref, engineRoot);
}

function checkRefs(r, roots, checks) {
  let mismatches = 0;
  let missing = 0;
  for (const [field, list] of [['inputs', r.inputs], ['outputs', r.outputs]]) {
    (Array.isArray(list) ? list : []).forEach((entry, i) => {
      if (!entry || typeof entry.ref !== 'string' || entry.ref.startsWith('inline:') || entry.action === 'removed' || entry.digest == null) return;
      const current = resolveRef(entry.ref, roots);
      if (!current) { missing += 1; checks.push(fail('DF_RECEIPT_REF_MISSING', { path: `$.${field}[${i}].ref`, detail: entry.ref })); return; }
      if (current.digest !== entry.digest) { mismatches += 1; checks.push(fail('DF_RECEIPT_DIGEST_MISMATCH', { path: `$.${field}[${i}].digest`, detail: `${entry.ref} is now ${current.digest}` })); }
    });
  }
  if (!missing) checks.push(pass('DF_RECEIPT_REF_MISSING'));
  return mismatches;
}

/**
 * verifyReceipt(path, {root, engineRoot}) -> {ok, receipt, checks}. ok is
 * false when a blocking receipt check fails; schema findings are included as
 * checks. `root` is the fork root the refs resolve against; `engineRoot` is
 * the engine (lib/, schemas/) whose digests DF_RECEIPT_ENGINE_DRIFT compares
 * — the commands build receipts with root = ctx.packageRoot for their engine
 * digests, so a center living outside the engine tree passes its own root
 * here and the package root there (lib/commands/verify.mjs does), or drift
 * would fire on every receipt. engineRoot defaults to root.
 */
export function verifyReceipt(path, { root = PACKAGE_ROOT, engineRoot = root } = {}) {
  const checks = [];
  const read = readReceipt(path);
  if (!read.ok) {
    checks.push(fail('DF_RECEIPT_UNREADABLE', { path: String(path), detail: read.error }));
    return { ok: false, receipt: null, checks };
  }
  const r = read.receipt;
  checks.push(pass('DF_RECEIPT_UNREADABLE'));
  const v = validateAgainst('receipt', r);
  if (v.ok) checks.push(pass('DF_RECEIPT_INVALID'));
  else {
    for (const e of v.errors) checks.push(normalizeCheck({ ...e, status: 'fail' }));
    checks.push(fail('DF_RECEIPT_INVALID', { detail: `${v.errors.length} schema finding(s)` }));
  }
  let digestFailures = 0;
  if (r.digest !== bodyDigest(r)) { digestFailures += 1; checks.push(fail('DF_RECEIPT_DIGEST_MISMATCH', { path: '$.digest', detail: 'the receipt body changed after it was written' })); }
  digestFailures += checkRefs(r, { root, engineRoot }, checks);
  if (!digestFailures) checks.push(pass('DF_RECEIPT_DIGEST_MISMATCH'));
  let expectedId = null;
  try { expectedId = receiptId({ inputs: r.inputs, command: r.command, argv: r.argv, now: r.generated_at }); } catch { expectedId = null; }
  if (expectedId === r.receipt_id) checks.push(pass('DF_RECEIPT_ID_MISMATCH'));
  else checks.push(fail('DF_RECEIPT_ID_MISMATCH', { path: '$.receipt_id', detail: `expected ${expectedId ?? 'an id derived from generated_at'}` }));
  const expectedExit = fromReceipt(r);
  if (expectedExit === r.exit_code) checks.push(pass('DF_RECEIPT_EXIT_CODE_MISMATCH'));
  else checks.push(fail('DF_RECEIPT_EXIT_CODE_MISMATCH', { path: '$.exit_code', detail: `expected ${expectedExit}, found ${String(r.exit_code)}` }));
  const blockingFailures = summarize(r.checks).blocking_failures;
  const consistent = r.ok === (r.exit_code === OK) && !(r.ok && blockingFailures > 0);
  if (consistent) checks.push(pass('DF_RECEIPT_STATUS_INCONSISTENT'));
  else checks.push(fail('DF_RECEIPT_STATUS_INCONSISTENT', { path: '$.ok', detail: `ok ${String(r.ok)} with exit ${String(r.exit_code)} and ${blockingFailures} blocking failure(s)` }));
  const current = engineDigests(engineRoot);
  const drift = !r.engine_digests || r.engine_digests.lib !== current.lib || r.engine_digests.schemas !== current.schemas;
  if (drift) checks.push(fail('DF_RECEIPT_ENGINE_DRIFT', { path: '$.engine_digests', detail: 'lib/ or schemas/ differ from when the receipt was written' }));
  else checks.push(pass('DF_RECEIPT_ENGINE_DRIFT'));
  return { ok: !checks.some((c) => c.status === 'fail' && c.blocking), receipt: r, checks };
}
