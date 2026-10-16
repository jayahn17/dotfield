// The claude-cli provider (VISION 8.5): one `claude -p` call per ask with an
// empty MCP config, one turn and the model from center.config.json. It
// refuses to start inside a Claude Code session (CLAUDECODE or
// CLAUDE_CODE_ENTRYPOINT set) unless provider.allow_nested is true, so the
// loop can never spawn a nested agent by accident. spawn is injectable for
// tests; nothing here reads a clock.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from '../digest.mjs';
import { ProviderError, normalizeResponse } from './errors.mjs';

export const id = 'claude-cli';
export const BINARY = 'claude';
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}\n';
export const FIXED_ARGV = Object.freeze(['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config']);
export const MAX_STDOUT = 4 * 1024 * 1024;

/** True inside a Claude Code session: the two env markers Claude Code sets. */
export function isNested(env = {}) {
  return Boolean(env && (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT));
}

/** The argv the adapter runs, binary first: claude -p --output-format json --strict-mcp-config --mcp-config <file> --max-turns 1 --model <model> [--system-prompt <system>]. */
export function buildArgv({ model, mcpConfigPath, system = '' } = {}) {
  const argv = [BINARY, ...FIXED_ARGV, String(mcpConfigPath), '--max-turns', '1', '--model', String(model)];
  if (system) argv.push('--system-prompt', String(system));
  return argv;
}

/** sha256 of the canonical argv: what the run receipt records as provider.argv_digest. */
export function argvDigest(argv) {
  return sha256(canonical(argv.map(String)));
}

/** Parse `claude -p --output-format json` stdout into {text, tokens_used, model}; throws DF_PROVIDER_RESPONSE_INVALID. */
export function parseOutput(stdout, { model = null } = {}) {
  let doc;
  try { doc = JSON.parse(String(stdout)); } catch (e) {
    throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', `claude printed something that is not JSON (${e.message})`);
  }
  if (!doc || typeof doc !== 'object') throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', 'claude output is not an object');
  if (doc.is_error === true) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', `claude reported an error: ${String(doc.result ?? doc.error ?? '').slice(0, 200)}`);
  const text = typeof doc.result === 'string' ? doc.result : (typeof doc.text === 'string' ? doc.text : null);
  if (text === null) throw new ProviderError('DF_PROVIDER_RESPONSE_INVALID', `claude output has no result string (keys ${Object.keys(doc).join(',')})`);
  const u = doc.usage && typeof doc.usage === 'object' ? doc.usage : {};
  const inTok = Number.isInteger(u.input_tokens) ? u.input_tokens : 0;
  const outTok = Number.isInteger(u.output_tokens) ? u.output_tokens : 0;
  const raw = { text, model: typeof doc.model === 'string' ? doc.model : model };
  if (inTok || outTok) raw.tokens_used = inTok + outTok;
  return normalizeResponse(raw, { model, prompt: text });
}

function ensureMcpConfig(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, EMPTY_MCP_CONFIG, 'utf8');
  return path;
}

function runChild(spawnFn, argv, { stdin, signal }) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawnFn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], signal }); } catch (e) {
      reject(new ProviderError('DF_PROVIDER_UNAVAILABLE', `could not start ${argv[0]}: ${e.message}`, { cause: e }));
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { if (out.length < MAX_STDOUT) out += String(d); });
    child.stderr.on('data', (d) => { if (err.length < 4096) err += String(d); });
    child.on('error', (e) => {
      if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) reject(new ProviderError('DF_PROVIDER_TIMEOUT', 'the claude process was aborted before it answered', { cause: e }));
      else reject(new ProviderError('DF_PROVIDER_UNAVAILABLE', `${argv[0]} failed to run: ${e.message}`, { cause: e }));
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new ProviderError('DF_PROVIDER_UNAVAILABLE', `${argv[0]} exited ${code}${err ? `: ${err.trim().slice(0, 300)}` : ''}`));
    });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(String(stdin ?? '')); }
  });
}

/**
 * createProvider({config, env, spawn, mcpConfigPath, tmpDir}) -> {id, model, argv({system}), ask}
 * config.provider.model is required (there is no default model here);
 * mcpConfigPath (or <tmpDir>/mcp-empty.json) receives the empty MCP config
 * before each call. ask refuses with DF_PROVIDER_NESTED_REFUSED under
 * CLAUDECODE unless config.provider.allow_nested is true.
 */
export function createProvider({ config = null, env = {}, spawn = null, mcpConfigPath = null, tmpDir = null } = {}) {
  const p = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  const model = typeof p.model === 'string' && p.model ? p.model : null;
  const allowNested = p.allow_nested === true;
  const configPath = mcpConfigPath || (tmpDir ? join(tmpDir, 'mcp-empty.json') : null);
  const spawnFn = spawn || nodeSpawn;
  const argv = ({ system = '' } = {}) => buildArgv({ model, mcpConfigPath: configPath, system });
  return Object.freeze({
    id,
    model,
    argv,
    argvDigest: ({ system = '' } = {}) => argvDigest(argv({ system })),
    async ask({ system = '', prompt = '', maxTokens = null, signal = undefined } = {}) {
      if (isNested(env) && !allowNested) throw new ProviderError('DF_PROVIDER_NESTED_REFUSED', 'CLAUDECODE is set and provider.allow_nested is false');
      if (!model) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', 'provider.model is not set in center.config.json');
      if (!configPath) throw new ProviderError('DF_PROVIDER_UNAVAILABLE', 'no path for the empty MCP config (pass mcpConfigPath or tmpDir)');
      ensureMcpConfig(configPath);
      const stdout = await runChild(spawnFn, argv({ system }), { stdin: prompt, signal });
      const res = parseOutput(stdout, { model });
      if (Number.isInteger(maxTokens) && maxTokens > 0 && res.text.length > maxTokens * 4) res.text = res.text.slice(0, maxTokens * 4);
      return normalizeResponse(res, { model, system, prompt });
    },
  });
}
