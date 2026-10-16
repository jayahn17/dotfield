// dotfield verify <receipt.json> (VISION §8.2): recomputes every digest a
// receipt carries (its body, each input and output file), its id, its exit
// code and its status consistency; DF_RECEIPT_DIGEST_MISMATCH is the finding
// for any hand edit. Refs resolve against the fork root: ctx.root when the
// receipt lies inside it, else the root the receipt's own path implies (the
// parent of its .dotfield/ folder, or the nearest ancestor holding a center),
// so a receipt from another center verifies from anywhere. Engine digests
// compare against ctx.packageRoot, which is where every receipt took them.
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { findRoot, insideDir } from '../context.mjs';
import { buildReceipt, verifyReceipt } from '../receipt.mjs';
import { fail } from '../rules.mjs';
import { isBlockingFail } from '../pipeline.mjs';

export const verb = 'verify';
export const leaves = ['verify'];
export const usage = 'verify <receipt.json> [--json] [--as <person_id>]';

/** The fork root a receipt's refs resolve against (see the header). */
export function receiptRoot(path, ctx) {
  const abs = resolve(path);
  if (insideDir(abs, ctx.root)) return ctx.root;
  const parts = abs.split(sep);
  const at = parts.lastIndexOf('.dotfield');
  if (at > 0) return parts.slice(0, at).join(sep) || sep;
  return findRoot(dirname(abs), {});
}

/** The two roots verifyReceipt needs for a receipt at `path`. */
export const verifyRoots = (path, ctx) => ({ root: receiptRoot(path, ctx), engineRoot: ctx.packageRoot });

export async function run(args, ctx) {
  const target = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!target) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const path = ctx.absPath(target);
  if (!existsSync(path)) return buildReceipt({ ...base, checks: [fail('DF_RECEIPT_UNREADABLE', { path: ctx.relRef(path), detail: 'no such file' })], status: 'blocked' });
  const result = verifyReceipt(path, verifyRoots(path, ctx));
  const inputs = [ctx.inputRef(path)].filter(Boolean);
  const blocked = result.checks.some(isBlockingFail);
  const verified = result.receipt;
  const failed = result.checks.filter((c) => c.status === 'fail').map((c) => c.code);
  return buildReceipt({
    ...base, inputs, checks: result.checks, status: blocked ? 'blocked' : 'read',
    maturity: verified && typeof verified.maturity === 'string' ? verified.maturity : null,
    nextAction: blocked
      ? `The receipt ${verified ? verified.receipt_id : ctx.relRef(path)} does not verify (${[...new Set(failed)].join(', ')}); re-run the command that wrote it rather than editing it.`
      : `The receipt ${verified.receipt_id} (${verified.command}, ${verified.status}) verifies${failed.length ? ` with non-blocking notes: ${[...new Set(failed)].join(', ')}` : ''}.`,
  });
}
