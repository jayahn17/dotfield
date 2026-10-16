// The dry provider: no network, no process, no clock. It answers every ask
// with a deterministic echo that keeps the node ids the prompt cited, so the
// loop's claim extraction, budget accounting and fence checks run end to end
// in tests and in `dotfield run --provider dry`.
import { estimateTokens, normalizeResponse } from './errors.mjs';

export const id = 'dry';
export const ECHO_CHARS = 600;
export const MAX_IDS = 64;
const ID_RE = /\[([a-z0-9][a-z0-9_.:-]{0,79})\]/g;

/** The node ids a prompt cites in square brackets, in order, de-duplicated. */
export function citedIds(text, max = MAX_IDS) {
  const out = [];
  for (const m of String(text ?? '').matchAll(ID_RE)) {
    if (out.includes(m[1])) continue;
    out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

/** The echo text for one ask: a header, an Evidence line with every cited id, then the clipped prompt. */
export function echo({ prompt, maxTokens = ECHO_CHARS, model = null }) {
  const ids = citedIds(prompt);
  const head = `dry echo${model ? ` (${model})` : ''}: no model was called.`;
  const evidence = `Evidence: ${ids.map((i) => `[${i}]`).join(' ') || '(none cited)'}`;
  const cap = Math.max(1, Math.min(ECHO_CHARS, (Number.isInteger(maxTokens) ? maxTokens : ECHO_CHARS) * 4));
  const body = String(prompt ?? '').slice(0, cap);
  return `${head}\n${evidence}\n${body}`;
}

/** createProvider({model}) -> {id, model, ask}: the adapter object the loop takes. */
export function createProvider({ model = null } = {}) {
  return Object.freeze({
    id,
    model,
    async ask({ system = '', prompt = '', maxTokens = ECHO_CHARS } = {}) {
      const text = echo({ prompt, maxTokens, model });
      return normalizeResponse({ text, tokens_used: estimateTokens(system, prompt, text), model }, { model, system, prompt });
    },
  });
}

const DEFAULT = createProvider();

/** Module-level ask (VISION 14): the default dry adapter with no model. */
export async function ask(req) {
  return DEFAULT.ask(req);
}
