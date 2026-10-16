// lib/rules.mjs and the family files: catalog completeness (every DF_* code
// VISION.md names exists), unique codes, non-empty repair sentences, the
// finding() shape, ABSOLUTE_PATH_RE, the pinned counts, RULES.md freshness,
// lib/privacy-levels.mjs and lib/exit-codes.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABSOLUTE_PATH_RE, CODES, FAMILIES, PINNED, RULES, RULE_CATALOG_VERSION, codesForFamily, codesForGate,
  fail, finding, has, pass, rule, summarize,
} from '../lib/rules.mjs';
import { renderRulesMd } from '../scripts/gen-rules-md.mjs';
import * as levels from '../lib/privacy-levels.mjs';
import * as exits from '../lib/exit-codes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAMILY_DIR = join(ROOT, 'lib', 'rules');
const EXPECTED_FAMILIES = ['schema', 'struct', 'receipt', 'room', 'record', 'store', 'proposal', 'approve', 'ir', 'privacy',
  'layout', 'render', 'share', 'overlay', 'run', 'provider', 'server', 'mcp', 'pack', 'engine', 'theme', 'import', 'sandbox', 'delta'];

test('every family file under lib/rules/ is aggregated, in the contract order', async () => {
  const onDisk = readdirSync(FAMILY_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')).sort();
  assert.deepEqual(onDisk, [...EXPECTED_FAMILIES].sort(), 'BUILD_CONTRACT §2 names these families');
  assert.deepEqual(FAMILIES.map((f) => f.id), EXPECTED_FAMILIES);
  assert.equal(FAMILIES.length, PINNED.rule_families);
  let total = 0;
  for (const id of onDisk) {
    const mod = await import(`../lib/rules/${id}.mjs`);
    assert.equal(mod.family, id, `${id}.mjs exports its own family id`);
    assert.match(mod.gate, /^[a-z][a-z0-9-]*$/);
    total += Object.keys(mod.rules).length;
    for (const [code, r] of Object.entries(mod.rules)) {
      assert.deepEqual(Object.keys(r).filter((k) => k !== 'exit').sort(), ['blocking', 'gate', 'message', 'repair'], `${code} has the contract shape`);
      assert.ok(code.startsWith(`DF_${id.toUpperCase()}_`), `${code} carries the family prefix`);
    }
  }
  assert.equal(total, CODES.length, 'no code is lost or duplicated by aggregation');
  assert.equal(new Set(CODES).size, CODES.length, 'codes are unique');
});

test('every code has a gate, a boolean blocking flag, a message and a non-empty repair sentence', () => {
  assert.ok(CODES.length >= 200);
  for (const code of CODES) {
    const r = RULES[code];
    assert.match(code, /^DF_[A-Z0-9]+(_[A-Z0-9]+)+$/);
    assert.equal(r.code, code);
    assert.match(r.gate, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof r.blocking, 'boolean');
    assert.ok(typeof r.message === 'string' && r.message.trim().length >= 10, `${code} message`);
    assert.ok(typeof r.repair === 'string' && r.repair.trim().length >= 10, `${code} repair`);
    assert.notEqual(r.repair.trim(), r.message.trim(), `${code} repair says what to do, not what went wrong`);
    if ('exit' in r) assert.ok([2, 3, 4, 5].includes(r.exit), `${code} exit is a gate/owner/storage/provider code`);
    assert.ok(Object.isFrozen(r));
  }
  assert.ok(Object.isFrozen(RULES));
});

test('every DF_* code named in VISION.md exists in the catalog; VISION names at least 20 and links references/RULES.md', () => {
  const vision = readFileSync(join(ROOT, 'VISION.md'), 'utf8');
  const named = [...new Set(vision.match(/DF_[A-Z0-9_]+/g))].filter((c) => !c.endsWith('_')).sort();
  assert.ok(named.length >= 20, `VISION names ${named.length} codes; the full catalog lives in references/RULES.md (V2_PLAN §12 decision 11)`);
  assert.ok(vision.includes('references/RULES.md'), 'VISION links references/RULES.md, where every code is documented');
  const missing = named.filter((c) => !has(c));
  assert.deepEqual(missing, [], 'VISION codes missing from lib/rules/');
  const prefixes = [...new Set(vision.match(/DF_[A-Z]+_/g))];
  for (const p of prefixes) assert.ok(CODES.some((c) => c.startsWith(p)), `family ${p} has codes`);
  for (const code of ['DF_SCHEMA_TYPE', 'DF_SCHEMA_REQUIRED', 'DF_SCHEMA_ENUM', 'DF_SCHEMA_UNKNOWN_FIELD', 'DF_SCHEMA_PATTERN', 'DF_SCHEMA_MAX_LENGTH', 'DF_SCHEMA_MAX_PROPERTIES', 'DF_SCHEMA_UNSUPPORTED_KEYWORD',
    'DF_ROOM_PROOF_COMMAND_FORBIDDEN', 'DF_STORE_SCOPE_REFUSED', 'DF_STORE_SCOPE_EMPTY_UID', 'DF_STORE_FAULT', 'DF_STORE_WRITE_WITHOUT_APPROVAL', 'DF_STORE_MAX_RECORDS', 'DF_STORE_MAX_BYTES', 'DF_STORE_ENV_PIN_IGNORED',
    'DF_OVERLAY_ID_NOT_NAMESPACED', 'DF_OVERLAY_GROUP_UNDECLARED', 'DF_OVERLAY_LINK_TARGET_NOT_BOUNDARY', 'DF_RECEIPT_DIGEST_MISMATCH', 'DF_SANDBOX_WRITE_DENIED']) {
    assert.ok(has(code), `${code} (spelled out in VISION prose) exists`);
  }
});

test('blocking policy matches VISION where it is stated', () => {
  const nonBlocking = ['DF_ROOM_MATURITY_UNPROVEN', 'DF_LAYOUT_POSE_IGNORED', 'DF_LAYOUT_LABEL_CLEARANCE', 'DF_LAYOUT_ROUTE_THROUGH_NODE', 'DF_LAYOUT_SERIES_COLLISION',
    'DF_RENDER_SELF_VIEW_EXPORTED', 'DF_OVERLAY_LINK_DROPPED', 'DF_OVERLAY_EXPIRED', 'DF_STORE_ENV_PIN_IGNORED', 'DF_MCP_SDK_MISSING',
    'DF_IR_LIFECYCLE_NO_INITIAL', 'DF_IR_TIME_RANGE_EMPTY', 'DF_LAYOUT_LAYER_CYCLE_BROKEN', 'DF_LAYOUT_LABEL_BUDGET', 'DF_LAYOUT_VIEWBOX_GROWN', 'DF_LAYOUT_EDGE_LABEL_CLEARANCE', 'DF_LAYOUT_ROUTE_OVERLAP', 'DF_IMPORT_ORDER_FILLED',
    'DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS', 'DF_DELTA_LAID_OUT_COLD'];
  for (const c of nonBlocking) assert.equal(RULES[c].blocking, false, `${c} is non-blocking`);
  for (const c of ['DF_IR_FIELDS_BUDGET', 'DF_ROOM_MATURITY_OVERCLAIM', 'DF_RENDER_UNPROJECTED', 'DF_SHARE_SWITCH_UNSUPPORTED', 'DF_LAYOUT_OVERLAP',
    'DF_IR_EDGE_ID_REQUIRED', 'DF_LAYOUT_ROUTE_MISSING', 'DF_RENDER_MOTION_INFINITE', 'DF_IR_DANGLING_VIEW_REF', 'DF_IR_ORDER_MISSING', 'DF_IR_TIME_WINDOW_INVALID', 'DF_RENDER_MOTION_WITHOUT_STILL', 'DF_IMPORT_SKETCH_INVALID',
    'DF_DELTA_KIND_MISMATCH', 'DF_DELTA_NO_STABLE_IDS', 'DF_DELTA_INPUT_BLOCKED']) assert.equal(RULES[c].blocking, true, `${c} is blocking`);
  assert.equal(CODES.length, 245, 'v2 catalog: 224 + 15 (IR_CHANGES_V2 item 12) + DF_IMPORT_ORDER_FILLED (importers-parity) + the 5 DF_DELTA_* codes (compare); a change is a deliberate commit');
  for (const reserved of ['DF_RECEIPT_CHAIN_BROKEN']) assert.ok(!has(reserved), `${reserved} is a v2.x ticket code, not declared yet`);
  assert.match(RULES.DF_LAYOUT_UNKNOWN_MODE.repair, /layered, sequence or lifecycle/);
  assert.match(RULES.DF_RENDER_SRI_MISSING.repair, /^Run npm run vendor \(network, once\)/);
  assert.match(RULES.DF_RENDER_VENDOR_MISSING.repair, /^Run npm run vendor \(network, once\)/);
  assert.match(RULES.DF_RENDER_VENDOR_MISSING.repair, /--no-embed-three/);
  assert.match(RULES.DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE.repair, /architecture, workflow, dataflow, sequence and lifecycle; <type> is not one of them\. Import it as a plain graph through the json importer/);
  assert.equal(RULES.DF_RENDER_SELF_VIEW_EXPORTED.blocking, false, 'unchanged: no exemption, still non-blocking');
  assert.equal(RULES.DF_APPROVE_NOT_OWNER.exit, 3);
  assert.equal(RULES.DF_STORE_FAULT.exit, 4);
  assert.equal(RULES.DF_PROVIDER_UNAVAILABLE.exit, 5);
  assert.equal(RULES.DF_SERVER_DECIDE_REFUSED.exit, 3);
  assert.deepEqual(codesForGate('topology'), codesForFamily('ir'));
  assert.deepEqual(codesForFamily('nope'), []);
});

test('finding() builds the one check shape', () => {
  assert.deepEqual(pass('DF_IR_DUP_ID'), { code: 'DF_IR_DUP_ID', gate: 'topology', blocking: true, status: 'pass' });
  const f = finding('DF_SCHEMA_REQUIRED', { path: '$.nodes[0].label', detail: "'label' is absent" });
  assert.deepEqual(Object.keys(f), ['code', 'gate', 'blocking', 'status', 'path', 'message', 'repair']);
  assert.equal(f.status, 'fail');
  assert.equal(f.message, "A required field is missing: 'label' is absent");
  assert.equal(f.repair, RULES.DF_SCHEMA_REQUIRED.repair);
  assert.equal(fail('DF_STORE_FAULT').message, RULES.DF_STORE_FAULT.message);
  assert.ok(!('path' in fail('DF_STORE_FAULT')));
  assert.equal(fail('DF_STORE_FAULT', { path: 7 }).path, '7');
  assert.throws(() => finding('DF_NOPE_X'), TypeError);
  assert.throws(() => finding('DF_IR_DUP_ID', { status: 'maybe' }), TypeError);
  assert.throws(() => rule(undefined), TypeError);
  assert.deepEqual(summarize([pass('DF_IR_DUP_ID'), fail('DF_IR_DUP_ID'), fail('DF_LAYOUT_POSE_IGNORED')]), { total: 3, passed: 1, failed: 2, blocking_failures: 1, by_code: { DF_IR_DUP_ID: 1, DF_LAYOUT_POSE_IGNORED: 1 } });
  assert.deepEqual(summarize(null), { total: 0, passed: 0, failed: 0, blocking_failures: 0, by_code: {} });
});

test('ABSOLUTE_PATH_RE is the one absolute-home-path regex', () => {
  const home = ['/', 'Users', '/'].join('');
  for (const s of [`${home}someone/Documents/x.pdf`, '/home/someone/x', 'C:\\Users\\someone\\x', 'c:\\Users\\x', '\\\\server\\share\\x']) assert.ok(ABSOLUTE_PATH_RE.test(s), `matches ${s}`);
  for (const s of ['center/rooms/x', 'data/rooms/x.json', './x', `.${home}x`, `https://example.test${home}x`, '/var/tmp/x', '/opt/x', 'C:/Users/x']) assert.ok(!ABSOLUTE_PATH_RE.test(s), `does not match ${s}`);
  assert.equal(ABSOLUTE_PATH_RE.source, '^(?:\\/Users\\/|\\/home\\/|[A-Za-z]:\\\\Users\\\\|\\\\\\\\)');
});

test('pinned counts and catalog version are the VISION values and RULES.md is current', () => {
  assert.equal(PINNED.cli_verbs, 19, 'v2.x ticket compare: + compare');
  assert.equal(PINNED.cli_leaf_subverbs, 27);
  assert.equal(PINNED.mcp_tools, 12);
  assert.equal(PINNED.rule_families, 24, 'v2.x ticket compare: + delta');
  assert.equal(PINNED.three_revision, '180');
  assert.equal(PINNED.min_node, '22.13');
  assert.equal(RULE_CATALOG_VERSION, '1');
  const vision = readFileSync(join(ROOT, 'VISION.md'), 'utf8');
  assert.ok(vision.includes(`\`PINNED\` is ${PINNED.cli_verbs} / ${PINNED.cli_leaf_subverbs} / ${PINNED.mcp_tools} / ${PINNED.rule_families}`), 'VISION §0.1 states the pinned counts the code holds');
  assert.ok(vision.includes(`(${PINNED.cli_verbs} verbs, ${PINNED.cli_leaf_subverbs} leaf subverbs`) && vision.includes(`leaf-subverb count (${PINNED.cli_leaf_subverbs})`), 'VISION §2 and §8.2 state the leaf count');
  for (const fam of EXPECTED_FAMILIES) assert.ok(vision.includes(`\`DF_${fam.toUpperCase()}_`), `VISION names the ${fam} family`);
  const md = renderRulesMd();
  assert.equal(readFileSync(join(ROOT, 'references', 'RULES.md'), 'utf8'), md, 'run npm run rules:md');
  for (const code of CODES) assert.ok(md.includes(`\`${code}\``), `${code} is documented`);
  assert.ok(md.includes('| CLI leaf subverbs | 27 |') && md.includes('| MCP tools | 12 |'));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(md), 'no dates: the file is byte-reproducible');
});

test('privacy levels: one ordered constant shared by wall and projector', () => {
  assert.deepEqual([...levels.LEVELS], ['public', 'private', 'sensitive', 'blocked']);
  assert.equal(levels.DEFAULT_LEVEL, 'private');
  assert.deepEqual([...levels.PRIVATE_SET].sort(), ['blocked', 'private', 'sensitive']);
  assert.ok(levels.atOrBelow('public', 'public') && levels.atOrBelow('public', 'private') && levels.atOrBelow('private', 'private') && levels.atOrBelow('sensitive', 'sensitive'));
  assert.ok(!levels.atOrBelow('private', 'public') && !levels.atOrBelow('sensitive', 'private'));
  assert.ok(!levels.atOrBelow('blocked', 'blocked') && !levels.atOrBelow('blocked', 'sensitive'), 'blocked never leaves');
  assert.ok(!levels.atOrBelow('secret', 'blocked') && !levels.atOrBelow('public', 'everything'));
  assert.equal(levels.rank('sensitive'), 2);
  assert.equal(levels.rank('nope'), -1);
  assert.ok(levels.isPrivate('private') && !levels.isPrivate('public') && levels.requiresOperators('sensitive') && !levels.requiresOperators('private'));
  assert.equal(levels.mostPrivate('public', 'sensitive'), 'sensitive');
  assert.equal(levels.mostPrivate('public', 'nope'), 'blocked');
  assert.ok(Object.isFrozen(levels.LEVELS) && Object.isFrozen(levels.PRIVATE_SET));
});

test('exit codes: constants, names and fromReceipt', () => {
  assert.deepEqual(exits.EXIT_CODES, { OK: 0, UNEXPECTED: 1, GATE: 2, AWAITING_OWNER: 3, STORAGE: 4, PROVIDER: 5 });
  assert.equal(exits.describe(3), 'awaiting_owner');
  assert.equal(exits.describe(9), 'unknown');
  assert.equal(exits.exitForCode('DF_IR_DUP_ID'), 2);
  assert.equal(exits.exitForCode('DF_STORE_FAULT'), 4);
  assert.equal(exits.exitForCode('DF_NOPE'), 2);
  const r = (status, checks = []) => ({ status, checks });
  const f = (code) => fail(code);
  assert.equal(exits.fromReceipt(r('read')), 0);
  assert.equal(exits.fromReceipt(r('written', [pass('DF_IR_DUP_ID'), f('DF_LAYOUT_POSE_IGNORED')])), 0, 'non-blocking failures do not change the exit');
  assert.equal(exits.fromReceipt(r('written', [f('DF_IR_DUP_ID')])), 2);
  assert.equal(exits.fromReceipt(r('blocked')), 2);
  assert.equal(exits.fromReceipt(r('awaiting_owner')), 3);
  assert.equal(exits.fromReceipt(r('refused')), 3);
  assert.equal(exits.fromReceipt(r('refused', [f('DF_APPROVE_NOT_OWNER')])), 3);
  assert.equal(exits.fromReceipt(r('refused', [f('DF_PACK_DRAFT')])), 2, 'a refusal by a gate is exit 2');
  assert.equal(exits.fromReceipt(r('error', [f('DF_STORE_FAULT')])), 1, 'status error wins');
  assert.equal(exits.fromReceipt(r('written', [f('DF_STORE_FAULT')])), 4);
  assert.equal(exits.fromReceipt(r('written', [f('DF_PROVIDER_UNAVAILABLE')])), 5);
  assert.equal(exits.fromReceipt(r('written', [f('DF_IR_DUP_ID'), f('DF_APPROVE_NOT_OWNER'), f('DF_PROVIDER_UNAVAILABLE'), f('DF_STORE_FAULT')])), 4, 'storage > provider > owner > gate');
  assert.equal(exits.fromReceipt(r('written', [f('DF_IR_DUP_ID'), f('DF_PROVIDER_UNAVAILABLE')])), 5);
  assert.equal(exits.fromReceipt(r('written', [f('DF_IR_DUP_ID'), f('DF_RUN_WRITE_BEFORE_APPROVAL')])), 3);
  assert.equal(exits.fromReceipt(r('surprise')), 1);
  assert.equal(exits.fromReceipt(null), 1);
  assert.equal(exits.fromReceipt({ status: 'written', checks: [{ code: 'DF_IR_DUP_ID', status: 'fail', blocking: false }] }), 0, 'the check flag, not the catalog, decides blocking');
});

// The v2.x ticket list lives in three places (V2_PLAN §0.1, MATURITY's v2.x table, VISION §0.1) and this test reads all
// three, so no ticket is reopened or dropped by an edit to one; MATURITY's v1 ladder is VISION §13 verbatim.
test('the v2.x ticket lists in V2_PLAN §0.1, MATURITY and VISION §0.1 agree, and MATURITY\'s v1 table is VISION §13', () => {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const names = (text) => [...text.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]);
  const after = (text, lead, stop = /\n/) => { const i = text.indexOf(lead); assert.ok(i >= 0, `"${lead}" is present`); const rest = text.slice(i + lead.length); const j = rest.search(stop); return j < 0 ? rest : rest.slice(0, j); };
  const plan = read('references/V2_PLAN.md'); const vision = read('VISION.md'); const maturity = read('references/MATURITY.md');
  const all = {
    plan: names(after(plan, '**Everything else is a v2.x ticket (§11)**:', / \(/)),
    vision: names(after(vision, '**Everything else is a v2.x ticket**, eleven of them:', /\. /)),
    maturity: [...after(maturity, '## v2.x tickets', /\n## /).matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]),
  };
  const opened = {
    plan: names(after(plan, 'satisfies the §0.1 opening rule (an external user names the need):**', /\. /)),
    vision: names(after(vision, '. Six (', /\)/)),
    maturity: [...after(maturity, '## v2.x tickets', /\n## /).matchAll(/^\| `([a-z0-9-]+)` \| landed /gm)].map((m) => m[1]),
  };
  const closed = { plan: names(after(plan, 'Still closed:', /\.\n/)), maturity: [...after(maturity, '## v2.x tickets', /\n## /).matchAll(/^\| `([a-z0-9-]+)` \| v2\.x ticket · not started/gm)].map((m) => m[1]) };
  const sorted = (l) => [...l].sort();
  assert.equal(all.plan.length, 11); assert.deepEqual(sorted(all.vision), sorted(all.plan)); assert.deepEqual(sorted(all.maturity), sorted(all.plan));
  assert.equal(opened.plan.length, 6); assert.deepEqual(sorted(opened.vision), sorted(opened.plan)); assert.deepEqual(sorted(opened.maturity), sorted(opened.plan));
  assert.deepEqual(sorted(closed.maturity), sorted(closed.plan)); assert.deepEqual(sorted([...opened.plan, ...closed.plan]), sorted(all.plan), 'opened + closed = every ticket');
  const table = (text, head) => after(text, head, /\n\n/).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Component |'));
  assert.deepEqual(table(maturity, '| Component | Tag | v1 target |'), table(vision, '| Component | Tag | v1 target |'), 'MATURITY v1 table == VISION §13');
});
