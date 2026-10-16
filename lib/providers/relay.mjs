// The relay provider (VISION 8.5, the file queue ported from son's
// server/relay.js in shape): an ask is a request file under <dir>/outbox/
// that some other process — a human, a batch job, another agent outside this
// center — answers by writing <dir>/inbox/<same id>.json. The adapter polls a
// bounded number of times and then fails with DF_PROVIDER_TIMEOUT. Ids are
// a per-provider sequence plus a content digest: no clock, no randomness.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256Hex } from '../digest.mjs';
import { ProviderError, normalizeResponse } from './errors.mjs';

export const id = 'relay';
export const OUTBOX = 'outbox';
export const INBOX = 'inbox';
export const DEFAULT_POLL_MS = 250;
export const DEFAULT_MAX_POLLS = 240;
export const REQUEST_VERSION = 'dotfield.relay-request/1';
const ID_RE = /^[0-9]{1,6}-[0-9a-f]{8}$/;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requestPath(dir, reqId) { return join(dir, OUTBOX, `${reqId}.json`); }
export function answerPath(dir, reqId) { return join(dir, INBOX, `${reqId}.json`); }

function writeAtomic(file, doc) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** The id of the n-th request of this provider for this content. */
export function requestId(seq, { system = '', prompt = '' } = {}) {
  return `${String(seq).padStart(4, '0')}-${sha256Hex(canonical({ system, prompt })).slice(0, 8)}`;
}

/** Requests in the outbox with no answer yet: [{id, path}], sorted by id. */
export function pending(dir) {
  const out = join(dir, OUTBOX);
  if (!existsSync(out)) return [];
  return readdirSync(out).filter((f) => f.endsWith('.json') && ID_RE.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5)).filter((reqId) => !existsSync(answerPath(dir, reqId))).sort()
    .map((reqId) => ({ id: reqId, path: requestPath(dir, reqId) }));
}

/** The other side's write: answer(dir, id, {text, tokens_used?, model?} | {error}) -> path. */
export function answer(dir, reqId, response) {
  if (!ID_RE.test(String(reqId))) throw new TypeError(`not a relay request id: ${String(reqId)}`);
  return writeAtomic(answerPath(dir, reqId), response);
}

function readAnswer(file) {
  try { return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * createProvider({dir, model, pollMs, maxPolls, sleep}) -> {id, model, dir, ask}
 * dir is the queue root (the CLI passes .dotfield/relay or DOTFIELD_RELAY_DIR).
 * ask writes outbox/<id>.json {schema_version, id, model, system, prompt,
 * max_tokens} and waits for inbox/<id>.json; an answer {error} is
 * DF_PROVIDER_UNAVAILABLE, no answer after maxPolls is DF_PROVIDER_TIMEOUT.
 */
export function createProvider({ dir, model = null, pollMs = DEFAULT_POLL_MS, maxPolls = DEFAULT_MAX_POLLS, sleep = defaultSleep } = {}) {
  if (typeof dir !== 'string' || !dir) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', 'the relay provider needs a queue directory (dir)');
  let seq = 0;
  return Object.freeze({
    id,
    model,
    dir,
    async ask({ system = '', prompt = '', maxTokens = null, signal = undefined } = {}) {
      seq += 1;
      const reqId = requestId(seq, { system, prompt });
      const file = requestPath(dir, reqId);
      writeAtomic(file, { schema_version: REQUEST_VERSION, id: reqId, model, system: String(system), prompt: String(prompt), max_tokens: Number.isInteger(maxTokens) ? maxTokens : null });
      const target = answerPath(dir, reqId);
      for (let i = 0; i <= maxPolls; i += 1) {
        if (signal && signal.aborted) throw new ProviderError('DF_PROVIDER_TIMEOUT', `aborted while waiting for ${reqId}`);
        if (existsSync(target)) {
          const r = readAnswer(target);
          if (!r.ok) throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', `inbox/${reqId}.json is not JSON (${r.error})`);
          if (r.doc && typeof r.doc === 'object' && r.doc.error !== undefined) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', `the relay answered with an error: ${String(r.doc.error).slice(0, 200)}`);
          return normalizeResponse(r.doc, { model, system, prompt });
        }
        if (i < maxPolls) await sleep(pollMs);
      }
      throw new ProviderError('DF_PROVIDER_TIMEOUT', `no answer in ${INBOX}/${reqId}.json after ${maxPolls} polls of ${pollMs} ms`);
    },
  });
}
