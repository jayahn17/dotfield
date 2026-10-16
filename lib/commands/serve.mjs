// dotfield serve [--port 4100] [--check] (VISION §8.2, §8.5): the local
// node:http server (server/serve.mjs) as a child process. serve writes the
// owner token to data/keys/owner.token (0600, created once) and prints the
// /inbox?t=<token> URL only when stdout is a TTY — never into a receipt, a
// pipe or --json output. The token file path reaches the server as
// DOTFIELD_OWNER_TOKEN_FILE; the inbox reads the token from ?t= once and
// keeps it in memory. --check prepares everything and reports without
// spawning (what tests and CI call).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReceipt } from '../receipt.mjs';
import { fail, pass } from '../rules.mjs';

export const verb = 'serve';
export const leaves = ['serve'];
export const usage = 'serve [--port 4100] [--check] [--json]';
export const DEFAULT_PORT = 4100;
export const DEFAULT_HOST = '127.0.0.1';
export const SERVER_SCRIPT = 'server/serve.mjs';

/** data/keys/owner.token: created at 0600 when absent; returns {path, token, created}. The token never leaves this process except on a TTY. */
export function ensureOwnerToken(dataDir) {
  const dir = join(dataDir, 'keys');
  const path = join(dir, 'owner.token');
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
    created = true;
  }
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return { path, token: readFileSync(path, 'utf8').trim(), created };
}

function spawnServer({ script, port, host, ctx, tokenPath }) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [script, '--port', String(port), '--host', host], {
      cwd: ctx.root, stdio: 'inherit',
      env: { ...ctx.env, DOTFIELD_OWNER_TOKEN_FILE: tokenPath, DOTFIELD_ROOT: ctx.root, DOTFIELD_PORT: String(port), DOTFIELD_HOST: host },
    });
    child.on('error', (e) => resolveExit({ code: null, error: e }));
    child.on('close', (code, signal) => resolveExit({ code, signal, error: null }));
  });
}

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  const cfg = ctx.config.server || {};
  const port = args.flags.port !== undefined && /^[0-9]{2,5}$/.test(String(args.flags.port)) ? Number(args.flags.port) : (Number.isInteger(cfg.port) ? cfg.port : DEFAULT_PORT);
  const host = typeof cfg.host === 'string' && cfg.host ? cfg.host : DEFAULT_HOST;
  const token = ensureOwnerToken(ctx.dataDir);
  const script = join(ctx.packageRoot, SERVER_SCRIPT);
  const present = existsSync(script);
  const url = `http://${host}:${port}/inbox?t=${token.token}`;
  if (ctx.stdoutIsTTY && !args.json) ctx.stdout.write(`inbox: ${url}\n`);
  const inputs = [ctx.inputRef(join(ctx.centerDir, 'center.config.json'))].filter(Boolean);
  const storeUrl = ctx.config.store && typeof ctx.config.store.object_store_url === 'string' ? ctx.config.store.object_store_url : null;
  const common = { ...base, inputs, store: { target: storeUrl ?? 'data/rooms', backend: storeUrl ? 'object' : 'file' }, provider: ctx.config.provider ? { adapter: ctx.config.provider.adapter, model: ctx.config.provider.model ?? null } : null };
  const tokenNote = `owner token ${token.created ? 'written' : 'present'} at data/keys/owner.token (0600, printed only on a TTY)`;
  if (args.flags.check === true || !present) {
    const checks = [present ? pass('DF_SERVER_ROUTE_UNKNOWN') : fail('DF_SERVER_ROUTE_UNKNOWN', { path: SERVER_SCRIPT, detail: 'the server component is not installed in this engine; nothing can listen' })];
    return buildReceipt({ ...common, checks, status: present ? 'read' : 'blocked', nextAction: present ? `Ready to serve ${host}:${port} from ${SERVER_SCRIPT}; ${tokenNote}. Run dotfield serve without --check from your terminal to start it.` : `${SERVER_SCRIPT} is absent, so the inbox cannot start; ${tokenNote}.` });
  }
  const exit = await spawnServer({ script, port, host, ctx, tokenPath: token.path });
  if (exit.error) return buildReceipt({ ...common, status: 'error', checks: [fail('DF_SERVER_LISTEN_FAILED', { path: `${host}:${port}`, detail: exit.error.message })], nextAction: `The server could not be started: ${exit.error.message}.` });
  const stoppedBy = exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`;
  // A clean stop (Ctrl-C, SIGTERM, exit 0) is a read; a child that died with a
  // non-zero exit never served (EADDRINUSE and friends) and is an error.
  if (exit.code !== 0 && !exit.signal) return buildReceipt({ ...common, status: 'error', checks: [fail('DF_SERVER_LISTEN_FAILED', { path: `${host}:${port}`, detail: `server/serve.mjs stopped with ${stoppedBy} before serving` })], nextAction: `The server on ${host}:${port} did not start (${stoppedBy}); is another dotfield serve already listening there? Stop it or pass a free --port.` });
  return buildReceipt({ ...common, status: 'read', nextAction: `The server on ${host}:${port} stopped with ${stoppedBy}; ${tokenNote}.` });
}
