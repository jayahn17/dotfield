// The anthropic provider (VISION 8.5): one raw fetch to the Messages API with
// the model id from center.config.json and the key from the environment. The
// key is read at ask time and never copied into any object the loop keeps;
// fetch is injectable and tests only ever pass a stub (zero network).
import { ProviderError, normalizeResponse } from './errors.mjs';

export const id = 'anthropic';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
export const KEY_ENV = 'ANTHROPIC_API_KEY';
export const DEFAULT_MAX_TOKENS = 1024;

/** The request for one ask (key supplied by the caller, never stored): {url, init}. */
export function buildRequest({ model, system = '', prompt = '', maxTokens = DEFAULT_MAX_TOKENS, apiKey }) {
  const body = {
    model,
    max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: String(prompt ?? '') }],
  };
  if (system) body.system = String(system);
  return {
    url: API_URL,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': API_VERSION, 'x-api-key': String(apiKey) },
      body: JSON.stringify(body),
    },
  };
}

/** Messages API JSON -> {text, tokens_used, model}; throws DF_PROVIDER_RESPONSE_INVALID on any other shape. */
export function parseResponse(doc, { model = null, system = '', prompt = '' } = {}) {
  if (!doc || typeof doc !== 'object') throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', 'the API answered with something that is not an object');
  if (doc.type === 'error') throw new ProviderError('DF_PROVIDER_UNAVAILABLE', `the API returned an error: ${String(doc.error && doc.error.message ? doc.error.message : doc.error).slice(0, 200)}`);
  if (!Array.isArray(doc.content)) throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', `no content[] in the response (keys ${Object.keys(doc).join(',')})`);
  const text = doc.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  const u = doc.usage && typeof doc.usage === 'object' ? doc.usage : {};
  const raw = { text, model: typeof doc.model === 'string' ? doc.model : model };
  if (Number.isInteger(u.input_tokens) || Number.isInteger(u.output_tokens)) raw.tokens_used = (u.input_tokens || 0) + (u.output_tokens || 0);
  return normalizeResponse(raw, { model, system, prompt });
}

/**
 * createProvider({config, env, fetch}) -> {id, model, ask}
 * config.provider.model is required; env[ANTHROPIC_API_KEY] is read per call
 * (DF_PROVIDER_UNAVAILABLE when missing). A non-2xx answer is
 * DF_PROVIDER_UNAVAILABLE, an aborted signal DF_PROVIDER_TIMEOUT, any other
 * shape DF_PROVIDER_RESPONSE_INVALID.
 */
export function createProvider({ config = null, env = {}, fetch = globalThis.fetch } = {}) {
  const p = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  const model = typeof p.model === 'string' && p.model ? p.model : null;
  return Object.freeze({
    id,
    model,
    async ask({ system = '', prompt = '', maxTokens = DEFAULT_MAX_TOKENS, signal = undefined } = {}) {
      if (!model) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', 'provider.model is not set in center.config.json');
      const apiKey = env && typeof env[KEY_ENV] === 'string' ? env[KEY_ENV] : '';
      if (!apiKey) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', `${KEY_ENV} is not set in the environment`);
      if (typeof fetch !== 'function') throw new ProviderError('DF_PROVIDER_UNAVAILABLE', 'no fetch implementation is available');
      const { url, init } = buildRequest({ model, system, prompt, maxTokens, apiKey });
      let res;
      try { res = await fetch(url, { ...init, signal }); } catch (e) {
        if (e && e.name === 'AbortError') throw new ProviderError('DF_PROVIDER_TIMEOUT', 'the request was aborted before the API answered', { cause: e });
        throw new ProviderError('DF_PROVIDER_UNAVAILABLE', `the API could not be reached: ${e && e.message ? e.message : String(e)}`, { cause: e });
      }
      if (!res || typeof res.ok !== 'boolean') throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', 'fetch returned something that is not a Response');
      let doc = null;
      try { doc = await res.json(); } catch { doc = null; }
      if (!res.ok) {
        const msg = doc && doc.error && doc.error.message ? doc.error.message : `HTTP ${res.status}`;
        throw new ProviderError('DF_PROVIDER_UNAVAILABLE', `the API answered ${res.status}: ${String(msg).slice(0, 200)}`);
      }
      return parseResponse(doc, { model, system, prompt });
    },
  });
}
