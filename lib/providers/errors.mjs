// One typed error for every adapter: code is a DF_PROVIDER_* rule, check is
// the failing finding the loop puts in the receipt (exit 5 by the catalog).
import { fail } from '../rules.mjs';

export const ADAPTERS = Object.freeze(['dry', 'claude-cli', 'anthropic', 'relay']);

export class ProviderError extends Error {
  constructor(code, detail, { path = '$.provider', cause = null } = {}) {
    super(`${code}: ${detail}`);
    this.name = 'ProviderError';
    this.code = code;
    this.detail = String(detail);
    this.provider = true;
    this.cause = cause;
    this.check = fail(code, { path, detail });
  }
}

export function isProviderError(e) {
  return Boolean(e && typeof e === 'object' && e.provider === true && typeof e.code === 'string');
}

/** Estimate tokens of a text the way every adapter and the loop budget do: four characters per token. */
export function estimateTokens(...texts) {
  return texts.reduce((n, t) => n + Math.ceil(String(t ?? '').length / 4), 0);
}

/**
 * normalizeResponse(raw, {model, system, prompt}) -> {text, tokens_used, model}
 * Throws DF_PROVIDER_RESPONSE_INVALID unless raw carries a string text; a
 * missing tokens_used is estimated from the texts; model falls back to the
 * adapter's configured one.
 */
export function normalizeResponse(raw, { model = null, system = '', prompt = '' } = {}) {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') {
    throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', `expected {text, tokens_used, model}, got ${raw === null ? 'null' : typeof raw}${raw && typeof raw === 'object' ? ` with keys ${Object.keys(raw).join(',')}` : ''}`);
  }
  const tokens = Number.isInteger(raw.tokens_used) && raw.tokens_used >= 0 ? raw.tokens_used : estimateTokens(system, prompt, raw.text);
  const m = typeof raw.model === 'string' && raw.model ? raw.model : (model ?? null);
  return { text: raw.text, tokens_used: tokens, model: m };
}
