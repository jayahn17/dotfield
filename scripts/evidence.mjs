#!/usr/bin/env node
// scripts/evidence.mjs — attach browser evidence to a render receipt (VISION
// §10 "Browser evidence is not in CI"; §13 ladder). Opt-in, run by a person:
//
//   node scripts/evidence.mjs <render folder | receipt.json> --screenshot <png>
//       a capture you took yourself (the Claude Code browser pane, any
//       browser's screenshot) — recorded as device "browser"
//   node scripts/evidence.mjs <render folder | receipt.json> --device adb
//       [--serial <S>] [--port 4100] [--open | --url <url>] [--wait <seconds>] [--adb <path>]
//       a Quest (or any Android browser) reached over USB: runs
//       `adb reverse tcp:<port> tcp:<port>` so 127.0.0.1:<port> on the headset
//       is the laptop's `dotfield serve` (a secure context, so WebXR is
//       allowed), optionally opens the render's URL there, waits for you to
//       enter VR, then pulls `adb exec-out screencap -p` into the render folder
//   --json   machine-readable result
//
// The receipt (receipt.json beside the render, and its .dotfield/receipts/
// index copy when present) gains evidence {browser: "captured",
// screenshot_ref, device}, the PNG as an output with its digest, and a new
// next_action; its body digest is recomputed so `dotfield verify` still
// passes. Nothing else in the receipt changes, no clock is read (the file is
// named by its device, not a time), and without this step every render stays
// `provisional`, which is the honest state. recipes/vr-on-quest.md walks
// through the headset path.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../lib/digest.mjs';
import { bodyDigest, readReceipt, receiptFilename, writeReceipt } from '../lib/receipt.mjs';

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const DEFAULT_PORT = 4100;
export const DEVICES = Object.freeze(['browser', 'adb']);
export const EXIT = Object.freeze({ ok: 0, error: 1, refused: 2 });
export const MAX_PNG_BYTES = 64 * 1024 * 1024;
const posix = (p) => p.split(sep).join('/');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device';

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

export function parseArgs(argv) {
  const out = { target: null, screenshot: null, device: null, serial: null, port: DEFAULT_PORT, url: null, open: false, wait: 0, adb: null, json: false, errors: [] };
  const list = [...argv];
  while (list.length) {
    const tok = list.shift();
    const value = () => (list.length && !list[0].startsWith('--') ? list.shift() : (out.errors.push(`${tok} needs a value`), null));
    if (tok === '--json') out.json = true;
    else if (tok === '--open') out.open = true;
    else if (tok === '--screenshot') out.screenshot = value();
    else if (tok === '--device') out.device = value();
    else if (tok === '--serial') out.serial = value();
    else if (tok === '--url') out.url = value();
    else if (tok === '--adb') out.adb = value();
    else if (tok === '--port') { const v = value(); out.port = /^[0-9]+$/.test(String(v)) ? Number(v) : (out.errors.push(`--port ${v} is not a number`), out.port); }
    else if (tok === '--wait') { const v = value(); out.wait = /^[0-9]+$/.test(String(v)) ? Number(v) : (out.errors.push(`--wait ${v} is not a whole number of seconds`), 0); }
    else if (tok.startsWith('--')) out.errors.push(`unknown flag ${tok}`);
    else if (out.target === null) out.target = tok;
    else out.errors.push(`unexpected argument ${tok}`);
  }
  if (!out.device) out.device = out.screenshot ? 'browser' : null;
  if (!out.target) out.errors.push('a render folder or receipt.json is required');
  if (!out.device) out.errors.push('pass --screenshot <png> or --device adb');
  else if (!DEVICES.includes(out.device)) out.errors.push(`--device ${out.device} is not ${DEVICES.join('|')}`);
  if (out.device === 'browser' && !out.screenshot) out.errors.push('--device browser needs --screenshot <png>');
  return out;
}

/** <folder> or <folder>/receipt.json -> {folder, receiptPath}. */
export function resolveFolder(target) {
  const abs = resolve(target);
  if (!existsSync(abs)) return null;
  const folder = statSync(abs).isDirectory() ? abs : dirname(abs);
  const receiptPath = statSync(abs).isDirectory() ? join(abs, 'receipt.json') : abs;
  return { folder, receiptPath };
}

/** The render receipt beside an out.html; anything else is refused (only a render has a screen). */
export function loadRenderReceipt(receiptPath) {
  if (!existsSync(receiptPath)) return { ok: false, why: `${receiptPath} does not exist; point at a .dotfield/renders/<id>/ folder` };
  const read = readReceipt(receiptPath);
  if (!read.ok) return { ok: false, why: `receipt unreadable: ${read.error}` };
  const r = read.receipt;
  if (r.command !== 'render') return { ok: false, why: `receipt command is '${String(r.command)}', not render; evidence is browser evidence of a render` };
  if (!Array.isArray(r.outputs) || !r.outputs.length) return { ok: false, why: 'the render receipt lists no output (blocked render); nothing to show in a browser' };
  return { ok: true, receipt: r };
}

/** The receipt-relative folder its outputs live in ('.dotfield/renders/<id>'), else the folder relative to cwd. */
export function refBase(receipt, folder) {
  const name = basename(folder);
  for (const o of Array.isArray(receipt.outputs) ? receipt.outputs : []) {
    const ref = typeof o.ref === 'string' ? o.ref : '';
    const dir = ref.includes('/') ? ref.slice(0, ref.lastIndexOf('/')) : '';
    if (dir && dir.split('/').pop() === name) return dir;
  }
  return posix(relative(process.cwd(), folder)) || '.';
}

/** The .dotfield/receipts/<id>.json copy bin wrote, when the folder lives under .dotfield/renders/. */
export function indexPathFor(folder, receipt) {
  const candidate = join(folder, '..', '..', 'receipts', receiptFilename(receipt));
  return existsSync(candidate) ? resolve(candidate) : null;
}

/**
 * attachEvidence({folder, receiptPath, png: Buffer | path, device}) -> {ok, why?, receipt, screenshot: {path, ref, digest, bytes}, written[]}
 * Copies/writes the PNG beside the render as evidence-<device>.png, rewrites the receipt (and its index copy) with evidence captured.
 */
export function attachEvidence({ folder, receiptPath, png, device }) {
  const loaded = loadRenderReceipt(receiptPath);
  if (!loaded.ok) return { ok: false, why: loaded.why };
  const bytes = Buffer.isBuffer(png) ? png : (existsSync(png) ? readFileSync(png) : null);
  if (!bytes) return { ok: false, why: `screenshot ${png} does not exist` };
  if (!isPng(bytes)) return { ok: false, why: 'the capture is not a PNG (no PNG signature); the headset or browser gave something else' };
  if (bytes.length > MAX_PNG_BYTES) return { ok: false, why: `the capture is ${bytes.length} bytes; the cap is ${MAX_PNG_BYTES}` };
  const receipt = loaded.receipt;
  const name = `evidence-${slug(device)}.png`;
  const dest = join(folder, name);
  if (Buffer.isBuffer(png)) writeAtomic(dest, bytes); else if (resolve(png) !== dest) copyFileSync(png, dest);
  const ref = `${refBase(receipt, folder)}/${name}`;
  const digest = sha256File(dest);
  const entry = { ref, digest, bytes: statSync(dest).size, kind: 'screenshot', action: 'written' };
  receipt.outputs = [...receipt.outputs.filter((o) => o.ref !== ref), entry];
  receipt.evidence = { browser: 'captured', screenshot_ref: ref, device: String(device).slice(0, 120) };
  receipt.next_action = `Evidence recorded: ${ref} (${receipt.evidence.device}). This render is reviewed in a browser, no longer provisional; keep the screenshot beside the receipt, since dotfield verify recomputes its digest.`;
  receipt.digest = bodyDigest(receipt);
  const written = [writeReceipt(receipt, folder, { filename: basename(receiptPath) })];
  const index = indexPathFor(folder, receipt);
  if (index) written.push(writeReceipt(receipt, dirname(index), { filename: basename(index) }));
  return { ok: true, receipt, screenshot: { path: dest, ...entry }, written };
}

function writeAtomic(path, bytes) {
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

/** One adb invocation; binary captures stdout as a Buffer. */
export function adbRun(adb, serial, args, { binary = false } = {}) {
  const full = [...(serial ? ['-s', serial] : []), ...args];
  const r = spawnSync(adb, full, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: MAX_PNG_BYTES + 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, status: null, stdout: binary ? Buffer.alloc(0) : '', stderr: r.error.message };
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? (binary ? Buffer.alloc(0) : ''), stderr: String(r.stderr ?? '').trim() };
}

/**
 * captureAdb({adb, serial, port, url, wait}) -> Promise<{ok, why?, png, device, steps[]}>
 * reverse → identify → (open url) → wait → screencap. Every failure names the adb step.
 */
export async function captureAdb({ adb = 'adb', serial = null, port = DEFAULT_PORT, url = null, wait = 0 } = {}) {
  const steps = [];
  const version = adbRun(adb, null, ['version']);
  if (!version.ok) return { ok: false, why: `adb not runnable (${adb}): ${version.stderr || 'install Android platform-tools or pass --adb <path>'}`, steps };
  steps.push('version');
  const rev = adbRun(adb, serial, ['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (!rev.ok) return { ok: false, why: `adb reverse tcp:${port} failed: ${rev.stderr || 'no device? run adb devices and accept the USB debugging prompt on the headset'}`, steps };
  steps.push(`reverse tcp:${port}`);
  const serialno = adbRun(adb, serial, ['get-serialno']);
  const model = adbRun(adb, serial, ['shell', 'getprop', 'ro.product.model']);
  const device = `adb:${(model.ok && model.stdout.trim()) || (serialno.ok && serialno.stdout.trim()) || 'device'}`;
  if (url) {
    const open = adbRun(adb, serial, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
    if (!open.ok) return { ok: false, why: `could not open ${url} on the device: ${open.stderr}`, steps, device };
    steps.push(`open ${url}`);
  }
  if (wait > 0) { await new Promise((done) => { setTimeout(done, wait * 1000); }); steps.push(`wait ${wait}s`); }
  const cap = adbRun(adb, serial, ['exec-out', 'screencap', '-p'], { binary: true });
  if (!cap.ok || !isPng(cap.stdout)) return { ok: false, why: `adb exec-out screencap -p gave no PNG${cap.stderr ? ` (${cap.stderr})` : ''}`, steps, device };
  steps.push(`screencap ${cap.stdout.length} bytes`);
  return { ok: true, png: cap.stdout, device, steps };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  const emit = (code, body) => { stdout.write(args.json ? `${JSON.stringify({ ok: code === EXIT.ok, exit_code: code, ...body }, null, 2)}\n` : `${body.message}\n`); return code; };
  if (args.errors.length) return emit(EXIT.refused, { message: `evidence: ${args.errors.join('; ')}\nusage: node scripts/evidence.mjs <render folder | receipt.json> --screenshot <png> | --device adb [--serial S] [--port ${DEFAULT_PORT}] [--open|--url <url>] [--wait <s>] [--adb <path>] [--json]` });
  const where = resolveFolder(args.target);
  if (!where) return emit(EXIT.refused, { message: `evidence: ${args.target} does not exist` });
  const loaded = loadRenderReceipt(where.receiptPath);
  if (!loaded.ok) return emit(EXIT.refused, { message: `evidence: ${loaded.why}` });
  let png = args.screenshot; let device = 'browser'; let steps = [];
  if (args.device === 'adb') {
    const url = args.url ?? (args.open ? `http://127.0.0.1:${args.port}/renders/${basename(where.folder)}/out.html#view=vr` : null);
    const cap = await captureAdb({ adb: args.adb ?? process.env.ADB ?? 'adb', serial: args.serial, port: args.port, url, wait: args.wait });
    if (!cap.ok) { stderr.write(`evidence: ${cap.why}\n`); return emit(EXIT.refused, { message: `evidence: ${cap.why}`, steps: cap.steps, device: cap.device ?? null }); }
    png = cap.png; device = cap.device; steps = cap.steps;
  }
  const result = attachEvidence({ folder: where.folder, receiptPath: where.receiptPath, png, device });
  if (!result.ok) return emit(EXIT.refused, { message: `evidence: ${result.why}` });
  return emit(EXIT.ok, {
    message: `evidence: ${result.screenshot.ref} (${result.screenshot.bytes} bytes, ${device}) attached; receipt ${result.receipt.receipt_id} updated${result.written.length > 1 ? ' (index copy too)' : ''}; browser: captured.`,
    folder: where.folder, receipt_path: result.written[0], index_path: result.written[1] ?? null, receipt_id: result.receipt.receipt_id, evidence: result.receipt.evidence, screenshot: result.screenshot, steps,
  });
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`evidence: ${e && e.stack ? e.stack : String(e)}\n`); process.exitCode = EXIT.error; });
