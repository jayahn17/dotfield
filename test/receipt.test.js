// lib/receipt.mjs: build/write/read/verify round-trip in a temp dir, same
// SOURCE_DATE_EPOCH -> same bytes and same id, tamper detection, exit and
// status derivation, schema validity, the committed example, engine
// digests. node:test, every file under its own temp dir (test/helpers/tmp.mjs
// withTmp), no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISION_STATES, ENGINE_DIGEST_MEANING, PACKAGE_ROOT, RELEASE_TAGS, STATUSES, bodyDigest, buildReceipt, compactStamp,
  engineDigests, engineVersion, idSuffix, inlineInput, isoSeconds, nowFrom, readReceipt, receiptFilename, receiptId,
  refDigest, serializeReceipt, verifyReceipt, writeReceipt,
} from '../lib/receipt.mjs';
import { canonical, digestTree, hmac, sha256, sha256Hex, shortDigest } from '../lib/digest.mjs';
import { fail, pass } from '../lib/rules.mjs';
import { loadSchema, openPaths, validate } from '../lib/validate.mjs';
import { withTmp } from './helpers/tmp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = { SOURCE_DATE_EPOCH: '1790849700' }; // 2026-10-01T10:15:00Z

function scaffold(dir) {
  writeFileSync(join(dir, 'package.json'), '{"name":"scratch","version":"0.1.0"}\n');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'schemas', 'x.schema.json'), '{"type":"object"}\n');
  writeFileSync(join(dir, 'in.json'), '{"a":1}\n');
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'out', 'out.html'), '<!doctype html><title>x</title>\n');
}

function build(dir, extra = {}) {
  return buildReceipt({
    command: 'render', argv: ['render', 'in.json', 'out/out.html', '--view', '2d'], now: nowFrom(EPOCH), root: dir,
    inputs: [refDigest('in.json', dir)], outputs: [{ ...refDigest('out/out.html', dir), kind: 'html', embedded_three: false }],
    checks: [pass('DF_IR_DUP_ID'), fail('DF_LAYOUT_LABEL_CLEARANCE', { path: '$.nodes[3]', detail: 'label collides' })],
    maturity: 'local_beta', mode: 'proposal_only', store: { target: 'data/rooms/x.json', backend: 'file' }, ...extra,
  });
}

test('digest helpers: canonical JSON, sha256, hmac, tree digests', () => {
  assert.equal(canonical({ b: 1, a: [1, { z: 2, y: undefined, f() {} }], '10': 1, '9': 2 }), '{"10":1,"9":2,"a":[1,{"z":2}],"b":1}');
  assert.equal(canonical({ d: new Date('2026-10-01T10:15:00Z'), n: NaN, u: undefined, big: 10n }), '{"big":"10","d":"2026-10-01T10:15:00.000Z","n":null}');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }));
  assert.match(sha256('x'), /^sha256:[0-9a-f]{64}$/);
  assert.match(hmac('key', { a: 1 }), /^hmac-sha256:[0-9a-f]{64}$/);
  assert.notEqual(hmac('key', 'x'), hmac('other', 'x'));
  assert.equal(shortDigest('sha256:abcdef0123'), 'abcdef');
});

test('build -> write -> read -> verify round-trip, and the id is deterministic under one clock', () => withTmp(async (dir) => {
  scaffold(dir);
  const r = build(dir);
  assert.match(r.receipt_id, /^rcpt_20261001T101500Z_[0-9a-f]{4}$/);
  assert.equal(r.generated_at, '2026-10-01T10:15:00Z');
  assert.equal(r.status, 'written');
  assert.equal(r.ok, true);
  assert.equal(r.exit_code, 0);
  assert.equal(r.engine_version, '0.1.0');
  assert.equal(r.engine_digests.match_release, null, 'no skill-release.json in the scratch root');
  assert.equal(r.engine_digests.meaning, ENGINE_DIGEST_MEANING);
  assert.equal(r.checks[1].gate, 'layout', 'gate and blocking come from the catalog');
  assert.equal(r.checks[1].blocking, false);
  assert.equal(validate(loadSchema('receipt'), r).ok, true, JSON.stringify(validate(loadSchema('receipt'), r).errors));
  const file = writeReceipt(r, join(dir, '.dotfield', 'receipts'), { filename: receiptFilename(r) });
  assert.equal(file, join(dir, '.dotfield', 'receipts', `${r.receipt_id}.json`));
  assert.deepEqual(readdirSync(join(dir, '.dotfield', 'receipts')), [`${r.receipt_id}.json`], 'no tmp file is left behind');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n') && text.includes('\n  "receipt_id"'));
  assert.deepEqual(readReceipt(file), { ok: true, receipt: r });
  const v = verifyReceipt(file, { root: dir });
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => c.status === 'fail')));
  assert.deepEqual(v.checks.filter((c) => c.status === 'fail'), []);
  assert.deepEqual(v.checks.map((c) => c.code).sort(), ['DF_RECEIPT_DIGEST_MISMATCH', 'DF_RECEIPT_ENGINE_DRIFT', 'DF_RECEIPT_EXIT_CODE_MISMATCH', 'DF_RECEIPT_ID_MISMATCH', 'DF_RECEIPT_INVALID', 'DF_RECEIPT_REF_MISSING', 'DF_RECEIPT_STATUS_INCONSISTENT', 'DF_RECEIPT_UNREADABLE']);
  const again = build(dir);
  assert.equal(serializeReceipt(again), serializeReceipt(r), 'same epoch, same inputs -> same bytes');
  assert.equal(again.receipt_id, r.receipt_id);
  assert.notEqual(build(dir, { argv: ['render', 'in.json', 'out/out.html', '--view', '3d'] }).receipt_id, r.receipt_id, 'argv is part of the id');
  assert.notEqual(build(dir, { command: 'validate' }).receipt_id, r.receipt_id, 'command is part of the id');
  assert.notEqual(build(dir, { now: nowFrom({ SOURCE_DATE_EPOCH: '1790849701' }) }).receipt_id, r.receipt_id);
  assert.equal(idSuffix({ inputs: r.inputs, command: r.command, argv: r.argv }), r.receipt_id.slice(-4));
  assert.equal(receiptId({ inputs: r.inputs, command: r.command, argv: r.argv, now: r.generated_at }), r.receipt_id);
}));

test('tampering is detected: body, id, output file; a removed file is a non-blocking note', () => withTmp(async (dir) => {
  scaffold(dir);
  const r = build(dir);
  const file = writeReceipt(r, dir);
  const codes = (v) => v.checks.filter((c) => c.status === 'fail').map((c) => `${c.code}${c.blocking ? '!' : ''}`).sort();
  const edited = { ...r, next_action: 'edited by hand' };
  writeFileSync(file, serializeReceipt(edited));
  let v = verifyReceipt(file, { root: dir });
  assert.equal(v.ok, false);
  assert.deepEqual(codes(v), ['DF_RECEIPT_DIGEST_MISMATCH!']);
  writeFileSync(file, serializeReceipt({ ...r, command: 'validate', digest: bodyDigest({ ...r, command: 'validate' }) }));
  v = verifyReceipt(file, { root: dir });
  assert.deepEqual(codes(v), ['DF_RECEIPT_ID_MISMATCH!']);
  writeFileSync(file, serializeReceipt({ ...r, ok: false, digest: bodyDigest({ ...r, ok: false }) }));
  assert.deepEqual(codes(verifyReceipt(file, { root: dir })), ['DF_RECEIPT_STATUS_INCONSISTENT!']);
  writeFileSync(file, serializeReceipt({ ...r, exit_code: 2, digest: bodyDigest({ ...r, exit_code: 2 }) }));
  assert.deepEqual(codes(verifyReceipt(file, { root: dir })), ['DF_RECEIPT_EXIT_CODE_MISMATCH!', 'DF_RECEIPT_STATUS_INCONSISTENT!']);
  writeFileSync(file, serializeReceipt(r));
  writeFileSync(join(dir, 'out', 'out.html'), 'changed');
  v = verifyReceipt(file, { root: dir });
  assert.deepEqual(codes(v), ['DF_RECEIPT_DIGEST_MISMATCH!']);
  assert.equal(v.checks.find((c) => c.code === 'DF_RECEIPT_DIGEST_MISMATCH').path, '$.outputs[0].digest');
  rmSync(join(dir, 'out', 'out.html'));
  v = verifyReceipt(file, { root: dir });
  assert.equal(v.ok, true, 'a missing output is a note, not a failure');
  assert.deepEqual(codes(v), ['DF_RECEIPT_REF_MISSING']);
  writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 2;\n');
  v = verifyReceipt(file, { root: dir });
  assert.ok(codes(v).includes('DF_RECEIPT_ENGINE_DRIFT') && v.ok, 'an engine edit is non-blocking drift');
  writeFileSync(file, '{not json');
  v = verifyReceipt(file, { root: dir });
  assert.deepEqual(codes(v), ['DF_RECEIPT_UNREADABLE!']);
  assert.equal(v.receipt, null);
  assert.deepEqual(codes(verifyReceipt(join(dir, 'missing.json'), { root: dir })), ['DF_RECEIPT_UNREADABLE!']);
  writeFileSync(file, '{"receipt_id":"x"}');
  v = verifyReceipt(file, { root: dir });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('DF_RECEIPT_INVALID!') && codes(v).includes('DF_SCHEMA_REQUIRED!'));
}));

test('status, ok and exit derive from the checks and never report a non-zero exit as success', () => withTmp(async (dir) => {
  scaffold(dir);
  const base = { command: 'validate', argv: ['validate', 'in.json'], now: nowFrom(EPOCH), root: dir, inputs: [refDigest('in.json', dir)] };
  const schema = loadSchema('receipt');
  const expectValid = (r) => assert.equal(validate(schema, r).ok, true, JSON.stringify(validate(schema, r).errors));
  let r = buildReceipt(base);
  assert.deepEqual([r.status, r.ok, r.exit_code], ['read', true, 0]);
  assert.equal(r.next_action, 'No further action is required.');
  expectValid(r);
  r = buildReceipt({ ...base, checks: [fail('DF_IR_DANGLING_EDGE', { path: '$.edges[0]' })] });
  assert.deepEqual([r.status, r.ok, r.exit_code], ['blocked', false, 2]);
  assert.match(r.next_action, /1 blocking finding/);
  expectValid(r);
  r = buildReceipt({ ...base, status: 'awaiting_owner', ownerDecision: { state: 'awaiting_owner' }, outputs: [{ ref: 'data/proposals/p-1.json', digest: sha256('x') }] });
  assert.deepEqual([r.status, r.ok, r.exit_code, r.owner_decision.state], ['awaiting_owner', false, 3, 'awaiting_owner']);
  expectValid(r);
  r = buildReceipt({ ...base, checks: [fail('DF_STORE_FAULT')], status: 'error' });
  assert.deepEqual([r.status, r.ok, r.exit_code], ['error', false, 1]);
  r = buildReceipt({ ...base, checks: [fail('DF_STORE_FAULT')] });
  assert.deepEqual([r.status, r.ok, r.exit_code], ['blocked', false, 4]);
  r = buildReceipt({ ...base, status: 'refused', checks: [fail('DF_APPROVE_NOT_OWNER')] });
  assert.deepEqual([r.ok, r.exit_code], [false, 3]);
  r = buildReceipt({ ...base, status: 'proposal', provider: { adapter: 'dry', model: null, tokens_used: 0, argv_digest: null }, foreignSpansDigest: sha256('spans'), blockedActions: ['launch_hardware'], releaseTag: 'v1.1-provisional', viewer: 'ada', scope: 'person_ada', outputs: [{ ref: 'data/rooms/x.json', digest: null, action: 'removed' }] });
  assert.deepEqual([r.status, r.ok, r.exit_code, r.release_tag], ['proposal', false, 3, 'v1.1-provisional'], 'a proposal waits for the owner: exit 3, not ok');
  expectValid(r);
  r = buildReceipt({ ...base, checks: [{ code: 'DF_IR_DUP_ID', status: 'fail', blocking: false, message: 'overridden', repair: 'do this' }], inputs: [inlineInput('scene', { a: 1 })] });
  assert.deepEqual([r.ok, r.checks[0].blocking, r.checks[0].message, r.inputs[0].ref], [true, false, 'overridden', 'inline:scene']);
  expectValid(r);
  assert.throws(() => buildReceipt({ ...base, now: undefined }), TypeError);
  assert.throws(() => buildReceipt({ ...base, command: '' }), TypeError);
  assert.throws(() => buildReceipt({ ...base, status: 'done' }), TypeError);
  assert.throws(() => buildReceipt({ ...base, releaseTag: 'v2' }), TypeError);
  assert.deepEqual([...STATUSES], ['read', 'proposal', 'written', 'awaiting_owner', 'approved', 'rejected', 'blocked', 'refused', 'error']);
  assert.deepEqual([...DECISION_STATES], ['not_required', 'awaiting_owner', 'approved', 'edited', 'rejected']);
  assert.deepEqual([...RELEASE_TAGS], ['v1.0', 'v1.1-provisional']);
}));

test('the committed example receipt validates, verifies and reproduces its own id', async () => {
  const file = join(ROOT, 'examples', 'receipt.example.json');
  const ex = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(validate(loadSchema('receipt'), ex).ok, true);
  assert.equal(ex.receipt_id, 'rcpt_20261001T101500Z_' + idSuffix(ex));
  assert.equal(ex.digest, bodyDigest(ex));
  // Its refs name a center/ and a data/ that exist nowhere: verify against an empty root, never this folder's own center (a fork has one).
  const v = await withTmp(async (dir) => verifyReceipt(file, { root: dir }));
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => c.status === 'fail' && c.blocking)));
  for (const c of v.checks.filter((c) => c.status === 'fail')) assert.ok(['DF_RECEIPT_REF_MISSING', 'DF_RECEIPT_ENGINE_DRIFT'].includes(c.code), c.code);
  assert.equal(ex.evidence.browser, 'not_captured');
  assert.equal(ex.release_tag, 'v1.1-provisional');
  assert.deepEqual(openPaths(loadSchema('receipt')), []);
});

test('nowFrom honours SOURCE_DATE_EPOCH and otherwise needs the caller clock', () => {
  assert.equal(nowFrom(EPOCH).toISOString(), '2026-10-01T10:15:00.000Z');
  assert.equal(nowFrom({}, new Date('2026-01-02T03:04:05Z')).toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(nowFrom({ SOURCE_DATE_EPOCH: 'soon' }, '2026-01-02T03:04:05Z').toISOString(), '2026-01-02T03:04:05.000Z');
  assert.throws(() => nowFrom({}), TypeError);
  assert.throws(() => nowFrom({}, 'not a date'), TypeError);
  assert.equal(isoSeconds('2026-10-01T10:15:00.750Z'), '2026-10-01T10:15:00Z');
  assert.equal(compactStamp(1790849700000), '20261001T101500Z');
});

test('engine digests change with lib/ or schemas/ and compare to skill-release.json', () => withTmp(async (dir) => {
  scaffold(dir);
  const a = engineDigests(dir);
  assert.match(a.lib, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.match_release, null);
  writeFileSync(join(dir, 'lib', 'a.mjs'), 'export const a = 2;\n');
  const b = engineDigests(dir);
  assert.notEqual(b.lib, a.lib);
  assert.equal(b.schemas, a.schemas);
  writeFileSync(join(dir, 'skill-release.json'), JSON.stringify({ digests: { lib: b.lib, schemas: b.schemas } }));
  assert.equal(engineDigests(dir).match_release, true);
  writeFileSync(join(dir, 'schemas', 'y.schema.json'), '{}');
  assert.equal(engineDigests(dir).match_release, false);
  assert.equal(digestTree(join(dir, 'schemas'), { include: (p) => p.endsWith('.json') }).files.length, 2);
  assert.equal(engineVersion(dir), '0.1.0');
  assert.equal(engineVersion(join(dir, 'nowhere')), '0.0.0');
  assert.equal(refDigest('nowhere.json', dir), null);
  assert.equal(refDigest('lib', dir), null, 'a directory is not a file ref');
  assert.equal(PACKAGE_ROOT, ROOT);
  assert.ok(existsSync(join(PACKAGE_ROOT, 'package.json')));
}));
