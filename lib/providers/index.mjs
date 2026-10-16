// One door to the four adapters: loadProvider(name, deps) returns the object
// the loop calls ask() on. Unknown names are DF_PROVIDER_UNKNOWN_ADAPTER
// (exit 5 by the catalog). Nothing is spawned or fetched at load time.
import { ADAPTERS, ProviderError, isProviderError } from './errors.mjs';
import * as anthropic from './anthropic.mjs';
import * as claudeCli from './claude-cli.mjs';
import * as dry from './dry.mjs';
import * as relay from './relay.mjs';

export { ADAPTERS, ProviderError, isProviderError };
export const MODULES = Object.freeze({ dry, 'claude-cli': claudeCli, anthropic, relay });

/**
 * loadProvider(name, {config, env, fetch, spawn, relayDir, mcpConfigPath, tmpDir, model})
 *   -> {id, model, ask, ...}
 * name defaults to config.provider.adapter, then 'dry'. relayDir defaults to
 * env.DOTFIELD_RELAY_DIR; the caller (lib/commands/run.mjs) passes
 * .dotfield/relay and .dotfield/tmp so nothing lands outside .dotfield/.
 */
export function loadProvider(name = null, { config = null, env = {}, fetch = globalThis.fetch, spawn = null, relayDir = null, mcpConfigPath = null, tmpDir = null, model = null } = {}) {
  const p = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  const adapter = name || p.adapter || 'dry';
  if (!ADAPTERS.includes(adapter)) throw new ProviderError('DF_PROVIDER_UNKNOWN_ADAPTER', `'${String(adapter)}' is not one of ${ADAPTERS.join(', ')}`, { path: '$.provider.adapter' });
  const chosenModel = model ?? (typeof p.model === 'string' ? p.model : null);
  switch (adapter) {
    case 'dry': return dry.createProvider({ model: chosenModel });
    case 'claude-cli': return claudeCli.createProvider({ config, env, spawn, mcpConfigPath, tmpDir });
    case 'anthropic': return anthropic.createProvider({ config, env, fetch });
    default: return relay.createProvider({ dir: relayDir || (env && env.DOTFIELD_RELAY_DIR) || null, model: chosenModel });
  }
}

/** True for anything the loop can call: an object with a string id in ADAPTERS and an ask function. */
export function isProvider(p) {
  return Boolean(p && typeof p === 'object' && ADAPTERS.includes(p.id) && typeof p.ask === 'function');
}

/** The receipt's provider block for an adapter, before tokens are known. */
export function providerInfo(p, { system = '' } = {}) {
  const out = { adapter: p.id, model: typeof p.model === 'string' ? p.model : null, argv_digest: null };
  if (typeof p.argvDigest === 'function') out.argv_digest = p.argvDigest({ system });
  return out;
}
