#!/usr/bin/env node
// mcp/http.mjs — stateless streamable HTTP on 127.0.0.1:4101 (VISION §8.3).
// Every request needs `Authorization: Bearer <DOTFIELD_MCP_AUTH_TOKEN>`; the
// server refuses to start without that token (fail closed). GET and DELETE
// answer 405 (DF_MCP_METHOD_NOT_ALLOWED): there is no session, no SSE
// stream and nothing to delete — one POST carries one JSON-RPC exchange,
// served by a fresh Server + transport pair that closes with the response.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RULES } from '../lib/rules.mjs';
import { SDK_INSTALL, createDotfieldServer, loadSdk } from './server.mjs';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4101;
export const TOKEN_ENV = 'DOTFIELD_MCP_AUTH_TOKEN';
export const MCP_PATH = '/mcp';

function sendJson(res, status, code, headers = {}) {
  const r = RULES[code];
  const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: status === 405 ? -32601 : -32001, message: r.message, data: { code, repair: r.repair } } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Constant-time bearer check: {ok} or {ok: false, code: 'DF_MCP_UNAUTHORIZED'}. */
export function authorize(req, token) {
  const header = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m || typeof token !== 'string' || !token.length) return { ok: false, code: 'DF_MCP_UNAUTHORIZED' };
  const a = Buffer.from(m[1]); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, code: 'DF_MCP_UNAUTHORIZED' };
}

/** The node:http request listener: 405 for GET/DELETE, 401 without the bearer, else one stateless MCP exchange. */
export function createHttpHandler({ cwd = process.cwd(), env = process.env, token } = {}) {
  if (typeof token !== 'string' || !token.length) throw new TypeError(`mcp/http.mjs needs the bearer token (${TOKEN_ENV}); it never serves without one`);
  return async function handle(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, 'DF_MCP_METHOD_NOT_ALLOWED', { allow: 'POST' });
    const auth = authorize(req, token);
    if (!auth.ok) return sendJson(res, 401, auth.code, { 'www-authenticate': 'Bearer realm="dotfield"' });
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = await createDotfieldServer({ cwd, env });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    try { await transport.handleRequest(req, res); } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e && e.message ? e.message : String(e) } })); }
    }
    return undefined;
  };
}

/** startHttp({cwd, env, host, port, token}) -> {server, host, port, url, close()}; port 0 picks a free one (tests). */
export async function startHttp({ cwd = process.cwd(), env = process.env, host = DEFAULT_HOST, port = DEFAULT_PORT, token = env[TOKEN_ENV] } = {}) {
  const sdk = await loadSdk();
  if (!sdk.ok) { const err = new Error(`${sdk.check.message} Run: ${SDK_INSTALL}`); err.code = 'DF_MCP_SDK_MISSING'; throw err; }
  const handler = createHttpHandler({ cwd, env, token });
  const server = createServer((req, res) => { handler(req, res).catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(e && e.message ? e.message : String(e)); } }); });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, () => { server.off('error', no); ok(); }); });
  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound ? bound.port : port;
  return { server, host, port: actualPort, url: `http://${host}:${actualPort}${MCP_PATH}`, close: () => new Promise((ok) => server.close(() => ok())) };
}

export async function main({ env = process.env, stderr = process.stderr } = {}) {
  if (!env[TOKEN_ENV]) { stderr.write(`DF_MCP_UNAUTHORIZED: set ${TOKEN_ENV} before starting mcp/http.mjs; it never serves without a bearer.\n`); return 3; }
  const port = /^[0-9]+$/.test(String(env.DOTFIELD_MCP_PORT ?? '')) ? Number(env.DOTFIELD_MCP_PORT) : DEFAULT_PORT;
  const started = await startHttp({ env, port });
  stderr.write(`dotfield MCP (stateless streamable HTTP) on ${started.url}; POST only, bearer from ${TOKEN_ENV}\n`);
  return 0;
}

function invokedDirectly() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  main().then((code) => { if (code !== 0) process.exit(code); }, (e) => { process.stderr.write(`${e && e.message ? e.message : String(e)}\n`); process.exit(e && e.code === 'DF_MCP_SDK_MISSING' ? 2 : 1); });
}
