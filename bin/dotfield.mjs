#!/usr/bin/env node
// The CLI entry (VISION §3, §8.2): argv -> lib/commands/<verb>.mjs -> receipt
// -> exit code. Dispatch is by file: verb X loads lib/commands/X.mjs, which
// exports {verb, leaves, usage, run(args, ctx) -> receipt}; adding a verb
// never edits this file. Every verb accepts --json and --as <person_id>.
// Exit codes come only from the receipt (lib/exit-codes.mjs fromReceipt), so
// a non-zero exit is never printed as success; an unknown verb or a thrown
// error still yields a receipt (status error, exit 1).
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext } from '../lib/context.mjs';
import { buildReceipt } from '../lib/receipt.mjs';
import { fail, has, summarize } from '../lib/rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const COMMANDS_DIR = resolve(HERE, '..', 'lib', 'commands');
export const VERB_RE = /^[a-z][a-z-]{0,31}$/;
/** Flags that never take a value (a positional may follow them). */
export const BOOLEAN_FLAGS = new Set(['json', 'i-know', 'ir-only', 'embed-three', 'force', 'relax', 'fetch-vendor', 'dry-run', 'check', 'help', 'version', 'blank', 'all', 'require-projected', 'resolved']);

/**
 * parseArgs(argv) -> {verb, _: positionals[], flags: {...}, json, as, argv}
 * --name=value, --name value (unless the flag is boolean), --no-name -> false,
 * -o value, and `--` ends flag parsing. Repeated flags keep the last value.
 */
export function parseArgs(argv) {
  const args = { verb: null, _: [], flags: {}, json: false, as: null, argv: [...argv] };
  const list = [...argv];
  let endOfFlags = false;
  while (list.length) {
    const tok = list.shift();
    if (endOfFlags || !tok.startsWith('-') || tok === '-') { args._.push(tok); continue; }
    if (tok === '--') { endOfFlags = true; continue; }
    let name = tok.replace(/^--?/, '');
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    else if (name.startsWith('no-') && !BOOLEAN_FLAGS.has(name)) { name = name.slice(3); value = false; }
    else if (BOOLEAN_FLAGS.has(name) || !list.length || list[0].startsWith('--')) value = true;
    else value = list.shift();
    args.flags[name] = value;
  }
  args.json = args.flags.json === true;
  args.as = typeof args.flags.as === 'string' && args.flags.as ? args.flags.as : null;
  args.verb = args._.length ? args._.shift() : null;
  return args;
}

/** The verbs installed under lib/commands/, sorted. */
export function listVerbs(dir = COMMANDS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.slice(0, -4)).filter((v) => VERB_RE.test(v)).sort();
}

export async function loadCommand(verb, dir = COMMANDS_DIR) {
  if (!VERB_RE.test(String(verb))) return null;
  const file = join(dir, `${verb}.mjs`);
  if (!existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  return typeof mod.run === 'function' ? mod : null;
}

export async function usageText(verb = null) {
  const lines = [];
  if (verb) {
    const mod = await loadCommand(verb);
    if (mod) { lines.push(`usage: dotfield ${mod.usage ?? verb}`); return `${lines.join('\n')}\n`; }
  }
  lines.push('usage: dotfield <verb> [...] [--json] [--as <person_id>]', '', 'verbs:');
  for (const v of listVerbs()) {
    try { const mod = await loadCommand(v); lines.push(`  ${mod && mod.usage ? mod.usage : v}`); } catch { lines.push(`  ${v}  (failed to load)`); }
  }
  lines.push('', 'exit codes: 0 ok · 2 blocking gate · 3 awaiting_owner / owner gate · 4 storage fault · 5 provider fault · 1 unexpected error');
  return `${lines.join('\n')}\n`;
}

/** A receipt for a failure outside any verb: unknown verb, refused --as, or a thrown error. */
export function errorReceipt({ command, argv, ctx, message, checks = [], status = 'error' }) {
  return buildReceipt({ command, argv, now: ctx.now, checks, status, scope: ctx.scope ?? 'owner', viewer: ctx.viewer ?? 'self', nextAction: message });
}

/** A thrown error becomes checks: a typed DF_STORE_* fault keeps its code (exit 4), anything else is status error (exit 1). */
export function receiptFromError(e, { command, argv, ctx }) {
  const code = e && typeof e.code === 'string' ? e.code : null;
  const message = e && e.message ? `${e.name || 'Error'}: ${e.message}` : String(e);
  if (code && has(code) && code.startsWith('DF_STORE_')) {
    return buildReceipt({ command, argv, now: ctx.now, status: 'blocked', scope: ctx.scope ?? 'owner', viewer: ctx.viewer ?? 'self', checks: [fail(code, { path: e.path ?? undefined, detail: e.detail ?? e.message })], nextAction: 'The store answered with a fault; nothing was written. Retry when the storage target is reachable.' });
  }
  return errorReceipt({ command, argv, ctx, message: `${message}. Read the error, fix the cause, and run the command again.` });
}

function pad(s, n) { return String(s).padEnd(n); }

/** The human summary: status line, failing checks with repair sentences, outputs, evidence, next action. */
export function formatReceipt(receipt, { receiptPaths = [] } = {}) {
  const sum = summarize(receipt.checks);
  const nonBlocking = sum.failed - sum.blocking_failures;
  const lines = [`dotfield ${receipt.command} — ${receipt.status} (exit ${receipt.exit_code}${receipt.ok ? ', ok' : ''})`];
  lines.push(`  ${pad('receipt', 10)}${receipt.receipt_id} · ${receipt.release_tag} · maturity ${receipt.maturity ?? 'n/a'} · viewer ${receipt.viewer ?? 'self'} (${receipt.scope ?? 'owner'})`);
  lines.push(`  ${pad('checks', 10)}${sum.passed} pass / ${sum.failed} fail${sum.failed ? ` (${sum.blocking_failures} blocking, ${nonBlocking} non-blocking)` : ''}`);
  for (const c of receipt.checks.filter((x) => x.status === 'fail')) {
    lines.push(`  ${c.blocking ? 'FAIL' : 'warn'} ${c.code} (${c.gate}${c.blocking ? '' : ', non-blocking'})${c.path ? ` at ${c.path}` : ''}`);
    if (c.message) lines.push(`       ${c.message}`);
    if (c.repair) lines.push(`       repair: ${c.repair}`);
  }
  for (const o of receipt.outputs) lines.push(`  ${pad('output', 10)}${o.ref}${Number.isInteger(o.bytes) ? ` (${o.bytes} bytes)` : ''}${o.embedded_three ? ' embedded three' : ''}${o.action ? ` ${o.action}` : ''}`);
  for (const p of receiptPaths) lines.push(`  ${pad('written', 10)}${p}`);
  if (receipt.store) lines.push(`  ${pad('store', 10)}${receipt.store.target ?? 'n/a'} (${receipt.store.backend})`);
  if (receipt.provider) lines.push(`  ${pad('provider', 10)}${receipt.provider.adapter}${receipt.provider.model ? ` ${receipt.provider.model}` : ''}`);
  if (receipt.engine_digests && receipt.engine_digests.match_release === false) lines.push(`  ${pad('engine', 10)}lib/ or schemas/ differ from skill-release.json (${receipt.engine_digests.meaning})`);
  lines.push(`  ${pad('evidence', 10)}browser ${receipt.evidence.browser}${receipt.evidence.browser === 'not_captured' && receipt.command === 'render' ? ' → provisional' : ''}`);
  lines.push(`  ${pad('next', 10)}${receipt.next_action}`);
  return `${lines.join('\n')}\n`;
}

/** Run one invocation: returns {receipt, receiptPaths}; prints nothing. */
export async function dispatch(argv, { cwd = process.cwd(), env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const ctx = createContext({ cwd, env, stdin, stdout, as: args.as });
  const command = VERB_RE.test(String(args.verb)) ? args.verb : 'dotfield';
  let receipt;
  if (ctx.scopeRefused) {
    receipt = errorReceipt({ command, argv, ctx, status: 'refused', checks: ctx.scopeRefused.checks, message: `--as ${JSON.stringify(args.as)} names nobody; pass a person id or leave --as out.` });
    return { receipt, receiptPaths: [], args, ctx };
  }
  const mod = await loadCommand(args.verb);
  if (!mod) {
    const verbs = listVerbs();
    receipt = errorReceipt({ command, argv, ctx, message: `unknown verb ${JSON.stringify(String(args.verb))}; verbs: ${verbs.join(', ')}. Run dotfield help.` });
    return { receipt, receiptPaths: [], args, ctx };
  }
  try {
    receipt = await mod.run(args, ctx);
    if (!receipt || typeof receipt !== 'object' || typeof receipt.receipt_id !== 'string') throw new TypeError(`${args.verb} returned no receipt`);
  } catch (e) {
    receipt = receiptFromError(e, { command: mod.verb ?? args.verb, argv, ctx });
  }
  let receiptPaths = [];
  if (receipt.outputs.length && receipt.status !== 'error') {
    try { receiptPaths = ctx.persistReceipt(receipt, { index: true }); } catch { receiptPaths = []; }
  }
  return { receipt, receiptPaths, args, ctx };
}

export async function main(argv = process.argv.slice(2)) {
  const first = argv[0];
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    process.stdout.write(await usageText(argv[1] ?? null));
    return 0;
  }
  const { receipt, receiptPaths, args } = await dispatch(argv);
  if (args.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else (receipt.ok ? process.stdout : process.stderr).write(formatReceipt(receipt, { receiptPaths }));
  return receipt.exit_code;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`dotfield: ${e && e.stack ? e.stack : String(e)}\n`); process.exitCode = 1; });
}
