// The DF_* rule catalog. Every code lives once, in exactly one family file
// under lib/rules/<family>.mjs; this module only aggregates, checks that
// codes are unique and correctly prefixed, and offers finding() so gates,
// commands, routes and tools produce one check shape:
//   { code, gate, blocking, status: "pass" | "fail", path?, message?, repair? }
// A later component adds a code only to its own family file.
import * as schema from './rules/schema.mjs';
import * as struct from './rules/struct.mjs';
import * as receipt from './rules/receipt.mjs';
import * as room from './rules/room.mjs';
import * as record from './rules/record.mjs';
import * as store from './rules/store.mjs';
import * as proposal from './rules/proposal.mjs';
import * as approve from './rules/approve.mjs';
import * as ir from './rules/ir.mjs';
import * as privacy from './rules/privacy.mjs';
import * as layout from './rules/layout.mjs';
import * as render from './rules/render.mjs';
import * as share from './rules/share.mjs';
import * as overlay from './rules/overlay.mjs';
import * as run from './rules/run.mjs';
import * as provider from './rules/provider.mjs';
import * as server from './rules/server.mjs';
import * as mcp from './rules/mcp.mjs';
import * as pack from './rules/pack.mjs';
import * as engine from './rules/engine.mjs';
import * as theme from './rules/theme.mjs';
import * as importRules from './rules/import.mjs';
import * as sandbox from './rules/sandbox.mjs';
import * as delta from './rules/delta.mjs';

// The one absolute-home-path regex, shared by the privacy gate and the
// structure scan. It is defined in lib/rules/privacy.mjs (exempt from the scan).
export { ABSOLUTE_PATH_RE } from './rules/privacy.mjs';

export const RULE_CATALOG_VERSION = '1';

// Counts and constants that tests pin and references/RULES.md prints.
// Changing one is a deliberate commit that also explains why.
// v2.x ticket compare (V2_PLAN §11): + the verb compare (1 verb, 1 leaf) and
// the family delta, landed in one commit with test/cli.test.js,
// test/rules.test.js and references/RULES.md.
export const PINNED = Object.freeze({
  cli_verbs: 19,
  cli_leaf_subverbs: 27,
  mcp_tools: 12,
  rule_families: 24,
  three_revision: '180',
  min_node: '22.13',
});

const FAMILY_MODULES = [
  schema, struct, receipt, room, record, store, proposal, approve, ir, privacy,
  layout, render, share, overlay, run, provider, server, mcp, pack, engine,
  theme, importRules, sandbox, delta,
];

function build() {
  const rules = {};
  const families = [];
  for (const mod of FAMILY_MODULES) {
    const prefix = `DF_${mod.family.toUpperCase()}_`;
    const codes = [];
    for (const [code, r] of Object.entries(mod.rules)) {
      if (Object.hasOwn(rules, code)) throw new Error(`duplicate rule code ${code} in family ${mod.family}`);
      if (!code.startsWith(prefix)) throw new Error(`${code} does not carry the prefix ${prefix} of family ${mod.family}`);
      const entry = {
        code, family: mod.family, gate: r.gate, blocking: r.blocking === true,
        message: r.message, repair: r.repair,
      };
      if (Number.isInteger(r.exit)) entry.exit = r.exit;
      rules[code] = Object.freeze(entry);
      codes.push(code);
    }
    families.push(Object.freeze({ id: mod.family, gate: mod.gate, codes: Object.freeze(codes) }));
  }
  return { rules: Object.freeze(rules), families: Object.freeze(families) };
}

const built = build();

/** code -> { code, family, gate, blocking, message, repair, exit? } */
export const RULES = built.rules;
/** [{ id, gate, codes[] }] in catalog order */
export const FAMILIES = built.families;
/** every code, in catalog order */
export const CODES = Object.freeze(Object.keys(RULES));

export function has(code) {
  return typeof code === 'string' && Object.hasOwn(RULES, code);
}

/** The catalog entry for a code; an unknown code is a programming error. */
export function rule(code) {
  if (!has(code)) throw new TypeError(`unknown rule code: ${String(code)}`);
  return RULES[code];
}

/**
 * One check object. status "pass" carries only {code, gate, blocking, status};
 * status "fail" adds path (when given), message (catalog message, with the
 * detail appended after a colon) and the catalog repair sentence.
 */
export function finding(code, { path, detail, status = 'fail' } = {}) {
  const r = rule(code);
  if (status !== 'pass' && status !== 'fail') throw new TypeError(`check status must be pass or fail, got ${String(status)}`);
  const check = { code, gate: r.gate, blocking: r.blocking, status };
  if (status === 'pass') return check;
  if (path !== undefined && path !== null) check.path = String(path);
  check.message = detail ? `${r.message.replace(/\.$/, '')}: ${String(detail)}` : r.message;
  check.repair = r.repair;
  return check;
}

export function pass(code) {
  return finding(code, { status: 'pass' });
}

export function fail(code, opts = {}) {
  return finding(code, { ...opts, status: 'fail' });
}

export function codesForGate(gate) {
  return CODES.filter((c) => RULES[c].gate === gate);
}

export function codesForFamily(family) {
  const f = FAMILIES.find((x) => x.id === family);
  return f ? [...f.codes] : [];
}

/** Totals over a check list: how many passed, failed, and failed while blocking. */
export function summarize(checks) {
  const out = { total: 0, passed: 0, failed: 0, blocking_failures: 0, by_code: {} };
  for (const c of Array.isArray(checks) ? checks : []) {
    out.total += 1;
    if (c.status === 'pass') { out.passed += 1; continue; }
    out.failed += 1;
    if (c.blocking) out.blocking_failures += 1;
    out.by_code[c.code] = (out.by_code[c.code] || 0) + 1;
  }
  return out;
}
