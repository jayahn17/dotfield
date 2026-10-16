// The only spawner of customer modules. Today that is a room's test.mjs
// (lib/commands/prove.mjs via runTest); actions.mjs and center/importers/*.mjs
// are planned callers of runModule and no verb reaches them yet
// (references/MATURITY.md). Every customer module runs in a child
//   node --permission --allow-fs-read=<dir>... --allow-fs-write=<dir>...
// with JSON over stdin/stdout, a timeout, an output cap and a scrubbed
// environment. The read set is the caller's to narrow: prove passes the room
// folder plus the engine's lib/, schemas/ and renderers/, never the fork root,
// so data/keys/ stays out of reach (the permission model cannot fence the
// network, so keeping secrets out of the read set is the control). Nothing
// here imports a customer module into this process.
//
// Two facts about the permission model shape this file (probed on Node 24,
// documented for Node 22.13+):
//   - `node --test` spawns one child per file, which the model forbids, so a
//     test.mjs is executed directly with --test-reporter=tap;
//   - ESM resolution realpaths the module and stats every ancestor, so every
//     allowed path and the module path are realpathed before the spawn.
// `--allow-child-process` is never passed: as a boolean flag even
// `--allow-child-process=false` would enable it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail, pass, PINNED } from './rules.mjs';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const STDERR_TAIL_BYTES = 64 * 1024;
export const MIN_NODE = PINNED.min_node;
/** Codes runModule evaluates, in order; runTest evaluates the same minus EXPORT_MISSING / OUTPUT_INVALID. */
export const MODULE_CODES = Object.freeze([
  'DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED', 'DF_SANDBOX_SPAWN_FAILED', 'DF_SANDBOX_TIMEOUT',
  'DF_SANDBOX_OUTPUT_INVALID', 'DF_SANDBOX_EXPORT_MISSING', 'DF_SANDBOX_WRITE_DENIED',
  'DF_SANDBOX_READ_DENIED', 'DF_SANDBOX_EXIT_NONZERO',
]);
export const TEST_CODES = Object.freeze(MODULE_CODES.filter((c) => !/EXPORT_MISSING|OUTPUT_INVALID/.test(c)));

// The child-side runner, passed with `node --input-type=module -e`. It reads
// one JSON document {args: [...]} from stdin, imports the customer module,
// calls the named export, and answers with exactly one JSON envelope:
//   {ok: true, output}  or  {ok: false, error: {code, name, message, permission?, resource?}}
// The write callback precedes exit because pipes are asynchronous on macOS.
export const RUNNER_SOURCE = [
  'const [file, name] = process.argv.slice(1);',
  'const done = (code, body) => process.stdout.write(JSON.stringify(body), () => process.exit(code));',
  'const errorOf = (e) => ({ code: e && e.code, name: e && e.name, message: e && e.message != null ? String(e.message) : String(e),',
  '  permission: e && e.permission, resource: e && e.resource });',
  'let raw = ""; process.stdin.setEncoding("utf8");',
  'for await (const chunk of process.stdin) raw += chunk;',
  'let args; try { args = JSON.parse(raw).args; } catch (e) { done(1, { ok: false, error: errorOf(e) }); }',
  'if (Array.isArray(args)) {',
  '  try {',
  '    const mod = await import(file);',
  '    const fn = mod[name];',
  '    if (typeof fn !== "function") done(1, { ok: false, error: { code: "DF_SANDBOX_EXPORT_MISSING", name: "TypeError",',
  '      message: "no export named " + name + " in " + file } });',
  '    else { const out = await fn(...args); done(0, { ok: true, output: out === undefined ? null : out }); }',
  '  } catch (e) { done(1, { ok: false, error: errorOf(e) }); }',
  '}',
].join('\n');

const supportCache = new Map();

/**
 * Whether `nodePath` accepts --permission. Probed once per binary
 * (`node --permission -e 0`) and cached; resetPermissionCache() forgets it.
 * Returns {supported, node, detail, cached}. Fails closed on any doubt.
 */
export function permissionSupport({ nodePath = process.execPath } = {}) {
  if (supportCache.has(nodePath)) return { ...supportCache.get(nodePath), cached: true };
  let entry;
  try {
    const r = spawnSync(nodePath, ['--permission', '-e', '0'], { encoding: 'utf8', timeout: 20_000, env: childEnv() });
    if (r.error) entry = { supported: false, node: nodePath, detail: `${r.error.code || r.error.name}: ${r.error.message}` };
    else if (r.status === 0) entry = { supported: true, node: nodePath, detail: `node --permission accepted (minimum ${MIN_NODE})` };
    else entry = { supported: false, node: nodePath, detail: `node --permission exited ${r.status ?? r.signal}: ${tail(r.stderr, 300).trim()}` };
  } catch (e) {
    entry = { supported: false, node: nodePath, detail: `${e.code || e.name}: ${e.message}` };
  }
  supportCache.set(nodePath, entry);
  return { ...entry, cached: false };
}

export function resetPermissionCache() {
  supportCache.clear();
}

/** The scrubbed child environment: no NODE_OPTIONS, no keys, a fixed clock zone. */
export function childEnv(extra = {}) {
  const env = { TZ: 'UTC', NO_COLOR: '1', FORCE_COLOR: '0', DOTFIELD_SANDBOX: '1' };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SOURCE_DATE_EPOCH) env.SOURCE_DATE_EPOCH = process.env.SOURCE_DATE_EPOCH;
  return { ...env, ...extra };
}

function tail(text, n) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(s.length - n) : s;
}

function listOf(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

/**
 * An allowed directory in both spellings the child may see: as given
 * (absolute) and realpathed. The model matches path strings, and ESM
 * resolution realpaths module files, so a symlinked root (macOS /tmp,
 * /var/folders) needs both. A write directory that does not exist is created.
 */
function allowedPaths(p, { create = false } = {}) {
  const abs = resolve(p);
  if (create && !existsSync(abs)) mkdirSync(abs, { recursive: true });
  const real = realpathSync(abs);
  return real === abs ? [abs] : [abs, real];
}

/** Build the permission argv for the child: one flag per path, deduplicated. */
export function permissionArgs({ allowRead = [], allowWrite = [] } = {}) {
  const reads = new Set();
  const writes = new Set();
  for (const p of listOf(allowRead)) for (const a of allowedPaths(p)) reads.add(a);
  for (const p of listOf(allowWrite)) for (const a of allowedPaths(p, { create: true })) writes.add(a);
  return ['--permission', ...[...reads].map((a) => `--allow-fs-read=${a}`), ...[...writes].map((a) => `--allow-fs-write=${a}`)];
}

/**
 * Spawn `nodePath argv` with `stdin`, a timeout and a stdout cap. Resolves
 * (never rejects) with {spawnError, timedOut, overflow, status, signal, stdout, stderr}.
 */
function spawnCapped({ nodePath, argv, cwd, stdin, timeoutMs, maxOutputBytes, env }) {
  return new Promise((resolveRun) => {
    const result = { spawnError: null, timedOut: false, overflow: false, status: null, signal: null, stdout: '', stderr: '' };
    let child;
    try {
      child = spawn(nodePath, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      result.spawnError = e;
      return resolveRun(result);
    }
    const out = [];
    let outBytes = 0;
    let errText = '';
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); result.stdout = Buffer.concat(out).toString('utf8'); result.stderr = errText; resolveRun(result); } };
    const timer = setTimeout(() => { result.timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { result.spawnError = e; clearTimeout(timer); finish(); });
    child.stdout.on('data', (chunk) => {
      if (result.overflow) return;
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) { result.overflow = true; child.kill('SIGKILL'); return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { errText = tail(errText + chunk.toString('utf8'), STDERR_TAIL_BYTES); });
    child.on('close', (status, signal) => { result.status = status; result.signal = signal; finish(); });
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

/** Parse the runner envelope; null when stdout is not exactly one envelope. */
function parseEnvelope(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.ok !== 'boolean') return null;
  if (doc.ok === false && (!doc.error || typeof doc.error !== 'object')) return null;
  return doc;
}

function deniedCode(permission) {
  if (permission === 'FileSystemWrite') return 'DF_SANDBOX_WRITE_DENIED';
  if (permission === 'FileSystemRead') return 'DF_SANDBOX_READ_DENIED';
  return null;
}

/** Common pre-flight: permission support, then the spawn, with the checks so far. */
async function preflight({ nodePath, argv, cwd, stdin, timeoutMs, maxOutputBytes, env, checks }) {
  const support = permissionSupport({ nodePath });
  if (!support.supported) {
    checks.push(fail('DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED', { detail: support.detail }));
    return null;
  }
  checks.push(pass('DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED'));
  const run = await spawnCapped({ nodePath, argv, cwd, stdin, timeoutMs, maxOutputBytes, env });
  if (run.spawnError) {
    checks.push(fail('DF_SANDBOX_SPAWN_FAILED', { detail: `${run.spawnError.code || run.spawnError.name}: ${run.spawnError.message}` }));
    return null;
  }
  checks.push(pass('DF_SANDBOX_SPAWN_FAILED'));
  if (run.timedOut) checks.push(fail('DF_SANDBOX_TIMEOUT', { detail: `killed after ${timeoutMs} ms` }));
  else checks.push(pass('DF_SANDBOX_TIMEOUT'));
  return run;
}

function baseResult({ nodePath, argv, run, checks }) {
  return {
    ok: checks.every((c) => c.status === 'pass'),
    checks,
    node: nodePath,
    argv,
    exit_code: run ? run.status : null,
    signal: run ? run.signal : null,
    stdout_bytes: run ? Buffer.byteLength(run.stdout) : 0,
    stderr: run ? run.stderr : '',
  };
}

/**
 * runModule({file, exportName, input, args?, allowRead, allowWrite, timeoutMs,
 * maxOutputBytes, nodePath, env}) → {output, checks, ok, node, argv, exit_code,
 * signal, stdout_bytes, stderr}
 *
 * Imports `file` in a permission-restricted child and calls `exportName`
 * with `args` (default `[input]`), JSON over stdin; the awaited return value
 * comes back as `output` (null on any failure). `allowRead` defaults to the
 * module's own directory; `allowWrite` defaults to nothing. Never throws for
 * anything the customer module does: every failure is one DF_SANDBOX_* check.
 */
export async function runModule(opts = {}) {
  const {
    file, exportName, input, args, allowRead, allowWrite = [], timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, nodePath = process.execPath, env = {},
  } = opts;
  if (typeof file !== 'string' || !file) throw new TypeError('runModule needs a file path');
  if (typeof exportName !== 'string' || !exportName) throw new TypeError('runModule needs an exportName');
  const checks = [];
  const absFile = resolve(file);
  const realFile = existsSync(absFile) ? realpathSync(absFile) : absFile;
  const reads = allowRead === undefined ? [dirname(realFile)] : listOf(allowRead);
  let argv;
  try {
    argv = [...permissionArgs({ allowRead: reads, allowWrite }), '--input-type=module', '-e', RUNNER_SOURCE, '--', realFile, exportName];
  } catch (e) {
    checks.push(fail('DF_SANDBOX_SPAWN_FAILED', { detail: `${e.code || e.name}: ${e.message}` }));
    return { output: null, ...baseResult({ nodePath, argv: [], run: null, checks }) };
  }
  const stdin = JSON.stringify({ args: Array.isArray(args) ? args : [input === undefined ? null : input] });
  const run = await preflight({ nodePath, argv, cwd: dirname(realFile), stdin, timeoutMs, maxOutputBytes, env: childEnv(env), checks });
  if (!run || run.timedOut) return { output: null, ...baseResult({ nodePath, argv, run, checks }) };
  let output = null;
  const envelope = run.overflow ? null : parseEnvelope(run.stdout);
  if (run.overflow) {
    checks.push(fail('DF_SANDBOX_OUTPUT_INVALID', { detail: `stdout exceeded ${maxOutputBytes} bytes` }));
  } else if (!envelope) {
    if (run.status !== 0 || run.signal) {
      checks.push(pass('DF_SANDBOX_OUTPUT_INVALID'));
      checks.push(fail('DF_SANDBOX_EXIT_NONZERO', { detail: `exit ${run.status ?? run.signal}${run.stderr ? `; stderr: ${tail(run.stderr, 400).trim()}` : ''}` }));
    } else {
      checks.push(fail('DF_SANDBOX_OUTPUT_INVALID', { detail: run.stdout.trim() ? `stdout began with ${JSON.stringify(run.stdout.trim().slice(0, 120))}` : 'stdout was empty' }));
    }
  } else {
    checks.push(pass('DF_SANDBOX_OUTPUT_INVALID'));
    const error = envelope.ok ? null : envelope.error;
    const denied = error ? deniedCode(error.permission) : null;
    if (error && error.code === 'DF_SANDBOX_EXPORT_MISSING') {
      checks.push(fail('DF_SANDBOX_EXPORT_MISSING', { path: realFile, detail: error.message }));
    } else {
      checks.push(pass('DF_SANDBOX_EXPORT_MISSING'));
      for (const code of ['DF_SANDBOX_WRITE_DENIED', 'DF_SANDBOX_READ_DENIED']) {
        checks.push(denied === code ? fail(code, { path: error.resource, detail: error.message }) : pass(code));
      }
      if (!denied) {
        if (error) checks.push(fail('DF_SANDBOX_EXIT_NONZERO', { detail: `${error.name || error.code || 'Error'}: ${error.message}${error.permission ? ` (${error.permission} denied)` : ''}` }));
        else if (run.status !== 0) checks.push(fail('DF_SANDBOX_EXIT_NONZERO', { detail: `exit ${run.status}` }));
        else { checks.push(pass('DF_SANDBOX_EXIT_NONZERO')); output = envelope.output; }
      }
    }
  }
  return { output, ...baseResult({ nodePath, argv, run, checks }) };
}

/**
 * Find a permission denial of `kind` (read|write) in a TAP report; returns
 * {location} of the failing test (the report prints no resource path) or null.
 */
function deniedTest(text, kind) {
  const needle = `Use --allow-fs-${kind} to manage permissions`;
  if (!text.includes(needle)) return null;
  for (const block of text.split(/^# Subtest: /m)) {
    if (!block.includes(needle)) continue;
    const m = block.match(/^\s*location:\s*'([^']*)'/m);
    return { location: m ? m[1] : undefined };
  }
  return { location: undefined };
}

/** Parse the `# tests N` summary lines of a TAP report into counts. */
export function parseTapSummary(stdout) {
  const summary = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const m of String(stdout ?? '').matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) summary[m[1]] = Number(m[2]);
  return summary;
}

/**
 * runTest({dir, file='test.mjs', allowRead, allowWrite, timeoutMs, maxOutputBytes,
 * nodePath, env}) → {ok, passed, failed, summary, checks, node, argv, exit_code,
 * signal, stdout, stdout_bytes, stderr}
 *
 * Executes a node:test file directly under the permission flags with the TAP
 * reporter (the --test runner would need child processes). `ok` is true only
 * when the child exited 0 with no failed or cancelled test. `allowRead`
 * defaults to `dir`; `allowWrite` defaults to nothing.
 */
export async function runTest(opts = {}) {
  const {
    dir, file = 'test.mjs', allowRead, allowWrite = [], timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, nodePath = process.execPath, env = {},
  } = opts;
  if (typeof dir !== 'string' || !dir) throw new TypeError('runTest needs a dir');
  const checks = [];
  const absDir = resolve(dir);
  const realDir = existsSync(absDir) ? realpathSync(absDir) : absDir;
  const target = resolve(realDir, file);
  const realTarget = existsSync(target) ? realpathSync(target) : target;
  const reads = allowRead === undefined ? [realDir] : listOf(allowRead);
  let argv;
  try {
    argv = [...permissionArgs({ allowRead: reads, allowWrite }), '--test-reporter=tap', realTarget];
  } catch (e) {
    checks.push(fail('DF_SANDBOX_SPAWN_FAILED', { detail: `${e.code || e.name}: ${e.message}` }));
    return finishTest({ nodePath, argv: [], run: null, checks });
  }
  const run = await preflight({ nodePath, argv, cwd: realDir, stdin: '', timeoutMs, maxOutputBytes, env: childEnv(env), checks });
  if (!run || run.timedOut) return finishTest({ nodePath, argv, run, checks });
  const combined = `${run.stdout}\n${run.stderr}`;
  for (const [code, kind, verb] of [['DF_SANDBOX_WRITE_DENIED', 'write', 'wrote'], ['DF_SANDBOX_READ_DENIED', 'read', 'read']]) {
    const hit = deniedTest(combined, kind);
    checks.push(hit ? fail(code, { path: hit.location, detail: `the test ${verb} outside the allowed directories` }) : pass(code));
  }
  const summary = parseTapSummary(run.stdout);
  if (run.overflow) {
    checks.push(fail('DF_SANDBOX_EXIT_NONZERO', { detail: `test output exceeded ${maxOutputBytes} bytes` }));
  } else if (run.status !== 0 || run.signal || summary.fail || summary.cancelled) {
    const detail = summary.tests
      ? `${summary.fail + summary.cancelled} of ${summary.tests} test(s) failed (exit ${run.status ?? run.signal})`
      : `exit ${run.status ?? run.signal}${run.stderr ? `; stderr: ${tail(run.stderr, 400).trim()}` : ''}`;
    checks.push(fail('DF_SANDBOX_EXIT_NONZERO', { path: realTarget, detail }));
  } else {
    checks.push(pass('DF_SANDBOX_EXIT_NONZERO'));
  }
  return finishTest({ nodePath, argv, run, checks, summary });
}

function finishTest({ nodePath, argv, run, checks, summary = parseTapSummary('') }) {
  const base = baseResult({ nodePath, argv, run, checks });
  return { ...base, passed: summary.pass, failed: summary.fail + summary.cancelled, summary, stdout: run ? run.stdout : '' };
}
