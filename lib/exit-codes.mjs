// Exit codes (VISION §8.2): 0 ok · 2 blocking gate · 3 awaiting_owner, owner
// gate or not-owner · 4 storage fault · 5 provider fault · 1 unexpected error.
// fromReceipt() is the only place a receipt becomes an exit code, so a
// non-zero exit is never reported as success.
import { RULES } from './rules.mjs';

export const OK = 0;
export const UNEXPECTED = 1;
export const GATE = 2;
export const AWAITING_OWNER = 3;
export const STORAGE = 4;
export const PROVIDER = 5;

export const EXIT_CODES = Object.freeze({ OK, UNEXPECTED, GATE, AWAITING_OWNER, STORAGE, PROVIDER });

export const NAMES = Object.freeze({
  [OK]: 'ok',
  [UNEXPECTED]: 'unexpected',
  [GATE]: 'gate',
  [AWAITING_OWNER]: 'awaiting_owner',
  [STORAGE]: 'storage',
  [PROVIDER]: 'provider',
});

/** Receipt statuses that mean the command finished what it was asked to do. A proposal is not one: it waits for the owner (exit 3). */
export const DONE_STATUSES = Object.freeze(new Set(['read', 'written', 'approved', 'rejected']));

/** Statuses that leave something for the owner to decide: the process exits 3 so a script or an agent stops there. */
export const OWNER_STATUSES = Object.freeze(new Set(['awaiting_owner', 'proposal', 'refused']));

// When several blocking checks fail, the most infrastructural exit wins.
const PRIORITY = [STORAGE, PROVIDER, AWAITING_OWNER, GATE];

export function describe(code) {
  return NAMES[code] ?? 'unknown';
}

/** The exit a blocking failure of this rule code maps to (default GATE). */
export function exitForCode(code) {
  const r = RULES[code];
  return r && Number.isInteger(r.exit) ? r.exit : GATE;
}

export function isSuccess(code) {
  return code === OK;
}

/**
 * Derive the exit code from a receipt: status error -> 1; otherwise the
 * failing blocking checks decide (storage > provider > owner gate > gate);
 * otherwise anything this command left for the owner (status awaiting_owner,
 * proposal or refused, or owner_decision.state awaiting_owner on a non-read)
 * -> 3, blocked -> 2, else 0.
 */
export function fromReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return UNEXPECTED;
  if (receipt.status === 'error') return UNEXPECTED;
  const exits = new Set();
  for (const c of Array.isArray(receipt.checks) ? receipt.checks : []) {
    if (c && c.status === 'fail' && c.blocking === true) exits.add(exitForCode(c.code));
  }
  for (const code of PRIORITY) if (exits.has(code)) return code;
  if (OWNER_STATUSES.has(receipt.status)) return AWAITING_OWNER;
  // An item this command left waiting for the owner, whatever its status word; a read that merely lists waiting items stays 0.
  if (receipt.status !== 'read' && receipt.owner_decision && receipt.owner_decision.state === 'awaiting_owner') return AWAITING_OWNER;
  if (receipt.status === 'blocked') return GATE;
  if (DONE_STATUSES.has(receipt.status)) return OK;
  return UNEXPECTED;
}
