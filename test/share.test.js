// lib/share.mjs, lib/sign.mjs and lib/gates/share.mjs: the eight privacy
// cases (no rule -> absent; revoke -> absent and receipted; overlay cannot
// overwrite and annotation never mutates live in overlay.test.js; sensitive
// without operators refused; no viewer -> empty; wall and projector agree;
// derived node refused to a third party) plus re_share blocked, switch
// unsupported, label/tag not public, signature tamper, fingerprint words,
// key files, circle receivers, and the shipped examples re-derived from
// their seeds. Temp dirs only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATORS, PRIVATE_LEVELS, STUB_RE, applyOperators, emitProjection, envelope, evaluate, outDir, projectionChecks, redact, revokedRefs, ruleChecks, ruleState, selects,
} from '../lib/share.mjs';
import { WORDS, fingerprint, fingerprintMatches, generateKeyPair, hmacHandle, keyFromSeed, loadKey, pseudonym, publicKeyBase64, sign, verify, writeKeyFile } from '../lib/sign.mjs';
import * as shareGate from '../lib/gates/share.mjs';
import { PRIVATE_SET } from '../lib/privacy-levels.mjs';
import { canonical, sha256 } from '../lib/digest.mjs';
import { codesForFamily } from '../lib/rules.mjs';
import { verifyReceipt, writeReceipt } from '../lib/receipt.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { project } from '../lib/project.mjs';
import { NOW, patchJson, scaffoldCenter } from './helpers/center.mjs';
import { withTmp } from './helpers/tmp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const SALT = `base64:${Buffer.alloc(32, 9).toString('base64')}`;
const SELF = keyFromSeed('share-test-self');
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const codes = (checks) => [...new Set(fails(checks).map((c) => c.code))].sort();
const NOTES = { id: 'notes', record: { id_field: 'note_id', label_field: 'title', sublabel_field: 'body', tag_field: 'tags', dates: { happened_on: 'happened_on', remembered_on: 'logged_on' }, public_fields: ['title', 'tags'] } };
const PEOPLE = [
  { person_id: 'self', kind: 'self', display_name: 'Owner', handles: [], disciplines: [], provenance: { introduced_by_person_id: 'self', introduced_on: '2026-01-01', evidence_ref: null }, privacy_mode: 'private_live' },
  { person_id: 'ada', kind: 'contact', display_name: 'Ada', handles: [], disciplines: [], public_key: keyFromSeed('share-test-ada').publicKey, key_id: 'ada-k1', provenance: { introduced_by_person_id: 'self', introduced_on: '2026-06-01', evidence_ref: null }, privacy_mode: 'private_live' },
  { person_id: 'bob', kind: 'contact', display_name: 'Bob', handles: [], disciplines: [], provenance: { introduced_by_person_id: 'self', introduced_on: '2026-06-01', evidence_ref: null }, privacy_mode: 'private_live' },
];

function rule(over = {}) {
  const base = {
    schema_version: 'dotfield.share-rule/1', rule_id: 'rule-01', grantor_person_id: 'self', receiver: { type: 'person', id: 'ada' },
    subject: { selector: { rooms: ['notes'], tags: ['idea'] } }, switches: { view: true, annotate: true, re_share: false, aggregate: false, train: false },
    redaction: { privacy_level_ceiling: 'private', fields_allowed: ['title', 'tags'], operators: [], salt: SALT },
    dates: { granted_on: '2026-10-01', released_on: '2026-10-01', expires_on: '2027-10-01' }, state: 'active',
    approval: { proposal_id: 'prop_20261001T101500Z_0a0a0a', decided_at: '2026-10-01T10:15:00Z', receipt_ref: null }, evidence_refs: [],
  };
  const { selector, redaction, switches, ...rest } = over;
  const out = { ...base, ...rest };
  if (redaction) out.redaction = { ...base.redaction, ...redaction };
  if (switches) out.switches = { ...base.switches, ...switches };
  if (selector) out.subject = { selector: { ...base.subject.selector, ...selector } };
  return out;
}
function node(id, over = {}) {
  return {
    id, kind: 'note', label: `Title of ${id}`, sublabel: 'private body', room: 'notes', record_id: id.replace(/^notes-/, ''), weight: 0.5, tags: ['idea', 'calibration'], color_token: 'series-1', status: 'accepted',
    fields: { title: `Title of ${id}`, tags: ['idea', 'calibration'] },
    provenance: { owner_person_id: 'self', source: { kind: 'record', ref: `notes/${id}`, digest: sha256(id) }, captured_on: '2026-09-19', happened_on: '2026-09-18' },
    audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [], ...over,
  };
}
const stub = (id, over = {}) => node(id, { kind: 'boundary', room: undefined, tags: ['vibration'], fields: { title: 'Shared' },
  provenance: { owner_person_id: 'ada', source: { kind: 'share', ref: 'proj-ada', digest: sha256('x') }, captured_on: '2026-09-20', released_on: '2026-09-20', imported_via_rule_ref: 'ada/rule-01' },
  boundary: { rule_ref: 'ada/rule-01', digest: sha256('x'), shared_by: 'ada', released_on: '2026-09-20', key_id: 'ada-k1' }, ...over });
const emit = (dir, over = {}) => emitProjection({ rule: rule(), nodes: [node('notes-n1'), node('notes-n2', { tags: ['plan'], fields: { title: 'Title of notes-n2', tags: ['plan'] } })], rooms: [NOTES], people: PEOPLE, key: SELF.privateKey, keyId: 'self-k1', now: NOW, dataDir: join(dir, 'data'), root: dir, ...over });
const files = (dir) => (existsSync(outDir(join(dir, 'data'))) ? readdirSync(outDir(join(dir, 'data'))) : []);

test('rule state and selection: expiry is judged against the clock; a selector needs room (+tags +kinds) or an explicit id', () => {
  assert.equal(ruleState(rule(), NOW), 'active');
  assert.equal(ruleState(rule({ dates: { granted_on: '2026-01-01', released_on: '2026-01-01', expires_on: '2026-09-30' } }), NOW), 'expired');
  assert.equal(ruleState(rule({ state: 'awaiting_owner' }), NOW), 'awaiting_owner');
  assert.ok(selects(rule(), node('notes-n1')));
  assert.ok(!selects(rule(), node('notes-n1', { tags: ['plan'] })), 'tags: any overlap');
  assert.ok(!selects(rule(), node('notes-n1', { room: 'papers' })), 'room is required');
  assert.ok(!selects(rule({ selector: { kinds: ['record'] } }), node('notes-n1')) && selects(rule({ selector: { kinds: ['note'] } }), node('notes-n1')));
  assert.ok(selects(rule({ selector: { rooms: [], ids: ['person-ada-x'] } }), stub('person-ada-x')), 'ids select whatever the room');
  assert.ok(!selects(rule(), null) && !selects(null, node('notes-n1')));
  assert.deepEqual([...OPERATORS], ['replace', 'redact', 'mask', 'pseudonymize', 'keep_private']);
});

test('a rule in awaiting_owner emits nothing (refused, exit 3); an active rule writes one signed file; revoke stops future emits, is receipted, and the next projection carries revoked_rule_refs', () => withTmp(async (dir) => {
  const waiting = await emit(dir, { rule: rule({ state: 'awaiting_owner', approval: null }) });
  assert.deepEqual([waiting.ok, waiting.receipt.status, waiting.receipt.exit_code, codes(waiting.checks), files(dir)], [false, 'refused', 3, ['DF_SHARE_RULE_NOT_ACTIVE'], []]);
  assert.equal(validate(loadSchema('receipt'), waiting.receipt).ok, true);
  const ok = await emit(dir);
  assert.deepEqual([ok.ok, ok.receipt.status, ok.receipt.exit_code, fails(ok.checks)], [true, 'written', 0, []]);
  assert.deepEqual(files(dir), ['ada-rule-01-20261001T101500Z.json']);
  const p = ok.projections[0].projection;
  assert.deepEqual(readJson(ok.paths[0]), p);
  assert.equal(validate(loadSchema('projection'), p).ok, true, JSON.stringify(validate(loadSchema('projection'), p).errors));
  assert.deepEqual([p.projection_id, p.receiver, p.rule_refs, p.released_on, p.expires_on, p.revoked_rule_refs, p.receipt_id], ['proj-self-to-ada-rule-01-20261001', { type: 'person', id: 'ada' }, ['self/rule-01'], '2026-10-01', '2027-10-01', [], ok.receipt.receipt_id]);
  assert.deepEqual(p.overlay.nodes.map((n) => n.id), ['person-self-notes-n1'], 'only the selected node');
  assert.ok(verify(p, p.signature, SELF.publicKey));
  assert.deepEqual(ok.receipt.outputs.map((o) => [o.ref, o.kind, o.action]), [['data/projections/out/ada-rule-01-20261001T101500Z.json', 'projection', 'written']]);
  assert.equal(ok.receipt.release_tag, 'v1.1-provisional');
  assert.equal(ok.receipt.viewer, 'ada');
  const v = verifyReceipt(writeReceipt(ok.receipt, join(dir, '.dotfield')), { root: dir });
  assert.deepEqual(codes(v.checks).filter((c) => c !== 'DF_RECEIPT_ENGINE_DRIFT'), [], 'the share receipt verifies against its outputs');
  const revoked = rule({ rule_id: 'rule-02', state: 'revoked', selector: { tags: ['plan'] } });
  const again = await emit(dir, { rules: [rule(), revoked], now: new Date('2026-10-02T09:00:00Z') });
  assert.deepEqual(again.projections[0].projection.revoked_rule_refs, ['self/rule-02']);
  assert.deepEqual(revokedRefs([rule(), revoked], 'self', 'ada'), ['self/rule-02']);
  const stopped = await emit(dir, { rule: revoked, now: new Date('2026-10-03T09:00:00Z') });
  assert.deepEqual([stopped.ok, stopped.receipt.exit_code, codes(stopped.checks), files(dir).length], [false, 3, ['DF_SHARE_RULE_NOT_ACTIVE'], 2], 'nothing new was written');
  assert.match(stopped.receipt.next_action, /not active/);
}));

test('the envelope is exactly fields_allowed plus the fixed metadata set; the stub label when label_field is not allowed; sublabel, tags and dates need their field; the digest is salted and never the record digest', () => {
  const ctx = { now: NOW, keyId: 'self-k1', projectionId: 'proj-x' };
  const full = envelope(node('notes-n1'), rule(), NOTES, ctx).node;
  assert.deepEqual(Object.keys(full).sort(), ['audience', 'boundary', 'fields', 'id', 'kind', 'label', 'provenance', 'tags']);
  assert.deepEqual([full.id, full.kind, full.label, full.sublabel, full.tags, full.fields], ['person-self-notes-n1', 'boundary', 'Title of notes-n1', undefined, ['idea', 'calibration'], { title: 'Title of notes-n1', tags: ['idea', 'calibration'] }]);
  const digest = sha256(canonical({ fields: full.fields, salt: SALT }));
  assert.deepEqual(full.provenance, { owner_person_id: 'self', source: { kind: 'share', ref: 'proj-x', digest }, captured_on: '2026-09-19', released_on: '2026-10-01', imported_via_rule_ref: 'self/rule-01' }, 'happened_on is absent: its field is not allowed');
  assert.deepEqual(full.audience, { privacy_level: 'private', share_rule_ids: ['rule-01'] });
  assert.deepEqual(full.boundary, { rule_ref: 'self/rule-01', digest, shared_by: 'self', released_on: '2026-10-01', key_id: 'self-k1', expires_on: '2027-10-01' });
  assert.notEqual(digest, sha256('notes-n1'), 'never the private record digest');
  assert.notEqual(envelope(node('notes-n1'), rule({ redaction: { salt: `base64:${Buffer.alloc(32, 1).toString('base64')}` } }), NOTES, ctx).node.boundary.digest, digest, 'another salt, another digest');
  const tagsOnly = envelope(node('notes-n1'), rule({ redaction: { fields_allowed: ['tags'] } }), NOTES, ctx).node;
  assert.match(tagsOnly.label, STUB_RE);
  assert.ok(tagsOnly.label.startsWith('notes · '));
  assert.deepEqual([tagsOnly.tags, Object.keys(tagsOnly.fields)], [['idea', 'calibration'], ['tags']]);
  const titleOnly = envelope(node('notes-n1'), rule({ redaction: { fields_allowed: ['title'] } }), NOTES, ctx).node;
  assert.deepEqual([titleOnly.tags, titleOnly.group], [[], undefined]);
  const dated = envelope(node('notes-n1', { fields: { title: 'T', happened_on: '2026-09-18', body: 'secret' } }), rule({ redaction: { fields_allowed: ['title', 'happened_on'] } }), { ...NOTES, record: { ...NOTES.record, public_fields: ['title', 'happened_on'] } }, ctx).node;
  assert.deepEqual([dated.provenance.happened_on, Object.keys(dated.fields)], ['2026-09-18', ['title', 'happened_on']], 'a date travels only when its field is allowed; body never');
  const withGroups = envelope(node('notes-n1'), rule(), NOTES, { ...ctx, disciplines: [{ label: 'Calibration', patterns: ['calib'], weight: 1, source: 'x' }, { label: 'Secret', patterns: ['body'], weight: 1, source: 'x' }] });
  assert.deepEqual(withGroups.groups, [{ id: 'person-self-g-calibration', label: 'Calibration', kind: 'discipline' }], 'disciplines match emitted tags only');
  assert.equal(withGroups.node.group, 'person-self-g-calibration');
});

test('sensitive without operators is refused and nothing is written; with pseudonymize the values link within one rule only; the operator table', () => withTmp(async (dir) => {
  const sensitive = node('notes-n1', { audience: { privacy_level: 'sensitive', share_rule_ids: [] } });
  const refused = await emit(dir, { nodes: [sensitive], rule: rule({ redaction: { privacy_level_ceiling: 'sensitive' } }) });
  assert.deepEqual([refused.ok, codes(refused.checks), refused.receipt.exit_code, files(dir)], [false, ['DF_SHARE_SENSITIVE_WITHOUT_OPERATORS'], 2, []]);
  assert.deepEqual(codes(await emit(dir, { nodes: [sensitive] }).then((r) => r.checks)), ['DF_SHARE_CEILING_EXCEEDED'], 'a private ceiling does not cover sensitive');
  const ok = await emit(dir, { nodes: [sensitive, node('notes-n2', { audience: { privacy_level: 'sensitive', share_rule_ids: [] } })], rule: rule({ redaction: { privacy_level_ceiling: 'sensitive', operators: ['pseudonymize'] } }) });
  assert.equal(ok.ok, true, JSON.stringify(fails(ok.checks)));
  const [a, b] = ok.projections[0].projection.overlay.nodes;
  assert.match(a.fields.title, /^pseu-[0-9a-f]{16}$/);
  assert.equal(a.label, a.fields.title, 'the label is the pseudonymised allowed field');
  assert.deepEqual(a.fields.tags, [pseudonym(SALT, 'idea'), pseudonym(SALT, 'calibration')]);
  assert.equal(a.fields.tags[0], b.fields.tags[0], 'the same value links inside one rule');
  assert.notEqual(pseudonym(SALT, 'idea'), pseudonym(`base64:${Buffer.alloc(32, 1).toString('base64')}`, 'idea'), 'and nowhere else');
  assert.deepEqual(applyOperators('Hello', ['mask'], SALT), 'H****');
  assert.deepEqual(applyOperators(['Hello', 42.7, true], ['mask'], SALT), ['H****', 40, true]);
  assert.deepEqual(applyOperators(['Hello', 42.7, null], ['redact'], SALT), ['[redacted]', 42.7, null]);
  assert.deepEqual(applyOperators(['Hello', 42.7], ['replace'], SALT), '[withheld]');
  assert.deepEqual(applyOperators({ k: 1 }, ['keep_private'], SALT), { k: 1 });
  assert.deepEqual(redact(node('notes-n1'), rule()).fields, { title: 'Title of notes-n1', tags: ['idea', 'calibration'] }, 'private nodes pass untouched');
  assert.deepEqual(redact(sensitive, rule({ redaction: { operators: ['redact'] } })).fields, { title: '[redacted]', tags: ['[redacted]', '[redacted]'] });
}));

test('the switch set: aggregate or train true is refused by evaluate, by the gate and by emitProjection', () => withTmp(async (dir) => {
  for (const sw of [{ aggregate: true }, { train: true }]) {
    const r = await emit(dir, { rule: rule({ switches: sw }) });
    assert.deepEqual([r.ok, codes(r.checks), r.receipt.exit_code], [false, ['DF_SHARE_SWITCH_UNSUPPORTED'], 2]);
    assert.equal(evaluate(rule({ switches: sw }), 'ada', node('notes-n1'), { now: NOW }).code, 'DF_SHARE_SWITCH_UNSUPPORTED');
  }
  assert.deepEqual(files(dir), []);
  const gate = shareGate.check(rule({ switches: { aggregate: true } }), { now: NOW });
  assert.deepEqual(gate.filter((c) => c.status === 'pass').length, codesForFamily('share').length - 1);
  assert.equal(gate.find((c) => c.code === 'DF_SHARE_SWITCH_UNSUPPORTED').path, '$.switches.aggregate');
}));

test('fields outside public_fields: FIELD_NOT_PUBLIC; the label field: LABEL_NOT_PUBLIC; the tag field: TAG_NOT_PUBLIC; the gate refuses a tampered envelope; one check per catalog code', () => withTmp(async (dir) => {
  const body = await emit(dir, { rule: rule({ redaction: { fields_allowed: ['title', 'body'] } }) });
  assert.deepEqual([body.ok, codes(body.checks), files(dir)], [false, ['DF_SHARE_FIELD_NOT_PUBLIC'], []]);
  assert.equal(fails(body.checks)[0].path, '$.redaction.fields_allowed[1]');
  const tagsRoom = { ...NOTES, record: { ...NOTES.record, public_fields: ['tags'] } };
  assert.deepEqual(codes(ruleChecks(rule(), { rooms: [tagsRoom], now: NOW })), ['DF_SHARE_LABEL_NOT_PUBLIC']);
  const titleRoom = { ...NOTES, record: { ...NOTES.record, public_fields: ['title'] } };
  assert.deepEqual(codes(ruleChecks(rule(), { rooms: [titleRoom], now: NOW })), ['DF_SHARE_TAG_NOT_PUBLIC']);
  assert.deepEqual(codes(ruleChecks(rule({ selector: { rooms: ['ghost'] } }), { rooms: [NOTES], now: NOW })), ['DF_SHARE_ROOM_UNKNOWN']);
  assert.deepEqual(codes(ruleChecks(rule({ receiver: { type: 'person', id: 'nobody' } }), { people: PEOPLE, now: NOW })), ['DF_SHARE_RECEIVER_UNKNOWN']);
  assert.deepEqual(codes(ruleChecks({ rule_id: 'x' }, { now: NOW })).some((c) => c.startsWith('DF_SCHEMA_')), true, 'a malformed rule reports schema findings and stops');
  const ok = await emit(dir);
  const good = ok.projections[0].projection;
  assert.deepEqual(fails(projectionChecks(good, { rule: rule(), rooms: [NOTES], now: NOW })), []);
  const tamper = (fn) => { const p = structuredClone(good); fn(p.overlay.nodes[0]); return codes(projectionChecks(p, { rule: rule(), rooms: [NOTES], now: NOW })); };
  assert.deepEqual(tamper((n) => { n.label = 'the private body leaked'; }), ['DF_SHARE_LABEL_NOT_PUBLIC']);
  assert.deepEqual(tamper((n) => { n.tags = ['secret-tag']; }), ['DF_SHARE_TAG_NOT_PUBLIC']);
  assert.deepEqual(tamper((n) => { n.fields.body = 'leak'; }), ['DF_SHARE_FIELD_NOT_PUBLIC']);
  assert.deepEqual(tamper((n) => { n.label = 'notes · abcdef'; n.tags = []; }), [], 'a stub label and no tags are always allowed');
  const gate = shareGate.check(good, { rule: rule(), rooms: [NOTES], now: NOW });
  assert.deepEqual(gate.map((c) => c.code), codesForFamily('share'));
  assert.ok(gate.every((c) => c.status === 'pass'));
  assert.deepEqual(shareGate.check(rule(), { rooms: [NOTES], people: PEOPLE, nodes: [node('notes-n1')], hasKey: true, now: NOW }).map((c) => c.status), codesForFamily('share').map(() => 'pass'));
  assert.deepEqual(shareGate.kindOf(good), 'projection');
  assert.deepEqual(shareGate.kindOf(rule()), 'rule');
  for (const bad of [undefined, null, 7, 'x', [], {}]) assert.ok(shareGate.check(bad).length >= codesForFamily('share').length, 'never throws');
}));

test('re_share: a foreign stub under re_share false is refused; a derived node goes only to its originating grantor unless every origin allows re_share', () => withTmp(async (dir) => {
  const foreign = stub('person-ada-x');
  const pick = rule({ receiver: { type: 'person', id: 'bob' }, selector: { rooms: [], ids: ['person-ada-x', 'notes-d1'] } });
  const noGrant = evaluate(pick, 'bob', foreign, { now: NOW });
  assert.deepEqual([noGrant.allow, noGrant.code], [false, 'DF_SHARE_RESHARE_BLOCKED']);
  assert.equal(evaluate(pick, 'bob', foreign, { now: NOW, grants: { 'ada/rule-01': { re_share: false } } }).code, 'DF_SHARE_RESHARE_BLOCKED');
  assert.equal(evaluate(pick, 'bob', foreign, { now: NOW, grants: new Map([['ada/rule-01', { re_share: true }]]) }).allow, true);
  assert.equal(evaluate(rule({ selector: { rooms: [], ids: ['person-ada-x'] } }), 'ada', foreign, { now: NOW }).allow, true, 'back to its own grantor is fine');
  const derived = node('notes-d1', { provenance: { ...node('notes-d1').provenance, derived_from: [{ person_id: 'ada', rule_ref: 'ada/rule-01', key_id: 'ada-k1' }] } });
  assert.equal(evaluate(pick, 'bob', derived, { now: NOW }).code, 'DF_SHARE_DERIVED_RESHARE_BLOCKED');
  assert.equal(evaluate(rule({ selector: { rooms: [], ids: ['notes-d1'] } }), 'ada', derived, { now: NOW }).allow, true, 'the originating grantor may receive it');
  assert.equal(evaluate(pick, 'bob', derived, { now: NOW, grants: { 'ada/rule-01': { re_share: true } } }).allow, true);
  const r = await emit(dir, { rule: pick, nodes: [foreign, derived] });
  assert.deepEqual([r.ok, codes(r.checks), files(dir)], [false, ['DF_SHARE_DERIVED_RESHARE_BLOCKED', 'DF_SHARE_RESHARE_BLOCKED'], []]);
  assert.deepEqual(fails(r.checks).map((c) => c.path), ['$.nodes[0]', '$.nodes[1]']);
  const toAda = await emit(dir, { rule: rule({ selector: { rooms: [], ids: ['notes-d1'] } }), nodes: [derived] });
  assert.equal(toAda.ok, true, JSON.stringify(fails(toAda.checks)));
  const notMine = evaluate(rule(), 'bob', node('notes-n1'), { now: NOW });
  assert.deepEqual([notMine.allow, notMine.code], [false, null], 'not the receiver: no grant, no gate code');
  assert.deepEqual(evaluate(rule(), 'ada', node('notes-n1', { audience: { privacy_level: 'blocked', share_rule_ids: [] } }), { now: NOW }).code, 'DF_SHARE_CEILING_EXCEEDED', 'blocked never leaves');
}));

test('key missing, nothing selected, circle receivers, and the refusal that an unknown receiver is', () => withTmp(async (dir) => {
  const noKey = await emit(dir, { key: null });
  assert.deepEqual([noKey.ok, codes(noKey.checks), files(dir)], [false, ['DF_SHARE_KEY_MISSING'], []]);
  const empty = await emit(dir, { rule: rule({ selector: { tags: ['nothing-has-this'] } }) });
  assert.deepEqual([empty.ok, codes(empty.checks), fails(empty.checks)[0].blocking, empty.projections[0].projection.overlay.nodes], [true, ['DF_SHARE_NOTHING_SELECTED'], false, []]);
  const circles = [{ circle_id: 'lab', owner_person_id: 'self', label: 'Lab', members: [{ person_id: 'ada', role: 'viewer', joined_on: '2026-01-01' }, { person_id: 'bob', role: 'viewer', joined_on: '2026-01-01', expires_on: '2026-06-30' }], visibility: 'private' }];
  const c = await emit(dir, { rule: rule({ rule_id: 'rule-circle', receiver: { type: 'circle', id: 'lab' } }), circles });
  assert.equal(c.ok, true, JSON.stringify(fails(c.checks)));
  assert.deepEqual(c.projections.map((p) => [p.receiver, p.projection.receiver.id]), [['ada', 'ada']], 'one file per live member; bob expired');
  assert.ok(verify(c.projections[0].projection, c.projections[0].projection.signature, SELF.publicKey));
  assert.deepEqual(codes(ruleChecks(rule({ receiver: { type: 'circle', id: 'ghost' } }), { people: PEOPLE, circles, now: NOW })), ['DF_SHARE_RECEIVER_UNKNOWN']);
  await assert.rejects(emit(dir, { now: undefined }), TypeError);
}));

test('no viewer sees nothing; the wall and the projector share one private set; a person with a grant sees through the same door', () => withTmp(async (dir) => {
  assert.equal(PRIVATE_LEVELS, PRIVATE_SET, 'lib/share.mjs re-exports the constant server/wall.mjs reads');
  const c = scaffoldCenter(dir);
  patchJson(c.roomFile('notes', 'room.json'), (m) => { m.record.default_privacy_level = 'private'; });
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const base = { rooms: d, now: NOW, dataDir: c.dataDir, config: c.config, env: {}, root: c.root, sessionKey: 'k' };
  assert.deepEqual((await project({ ...base, view: 'notes/graph', viewer: 'public' })).nodes, []);
  assert.deepEqual((await project({ ...base, view: 'notes/graph', viewer: 'ada', rules: [rule()] })).nodes, [], 'an empty store is empty for everyone');
  assert.deepEqual(readdirSync(c.dataDir), []);
}));

test('signing: tamper and wrong key fail, the fingerprint is eight words from the list, key files are 0600, and no private key ever enters a projection', () => withTmp(async (dir) => {
  const pair = generateKeyPair();
  const doc = { a: 1, receiver: { id: 'ada' } };
  const sig = sign(doc, pair.privateKey, 'k1');
  assert.deepEqual([sig.alg, sig.key_id, sig.signed], ['ed25519', 'k1', 'canonical(projection minus signature)']);
  assert.ok(verify({ ...doc, signature: sig }, sig, pair.publicKey) && verify(doc, sig.sig, pair.publicKey));
  assert.ok(!verify({ ...doc, a: 2 }, sig, pair.publicKey) && !verify(doc, sig, SELF.publicKey) && !verify(doc, { ...sig, alg: 'rsa' }, pair.publicKey) && !verify(doc, 'nonsense', pair.publicKey));
  assert.ok(!verify(doc, sig, 'not a key'), 'never throws');
  assert.throws(() => sign(doc, pair.privateKey, ''), TypeError);
  const fp = fingerprint(pair.publicKey);
  assert.equal(fp.split(' ').length, 8);
  assert.ok(fp.split(' ').every((w) => WORDS.includes(w)));
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256);
  assert.ok(fingerprintMatches(pair.publicKey, fp.toUpperCase().replace(/ /g, ', ')) && !fingerprintMatches(pair.publicKey, fingerprint(SELF.publicKey)));
  assert.equal(fingerprint(SELF.publicKey), fingerprint(keyFromSeed('share-test-self').publicKey), 'seeded keys are reproducible');
  assert.equal(publicKeyBase64(pair.privateKey), pair.publicKey);
  const path = writeKeyFile(join(dir, 'data', 'keys', 'self.ed25519'), pair.privateKey);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const loaded = loadKey(join(dir, 'data'), 'self');
  assert.deepEqual([loaded.ok, loaded.publicKey, loaded.privateKey], [true, pair.publicKey, pair.privateKey]);
  assert.equal(loadKey(join(dir, 'data'), 'nobody').ok, false);
  assert.match(hmacHandle('salt', 'Ada@Example'), /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(hmacHandle('salt', ' ada@example '), hmacHandle('salt', 'Ada@Example'), 'handles are normalised before hashing');
  const r = await emit(dir, { key: pair.privateKey, keyId: 'k1' });
  const text = JSON.stringify(r.projections[0].projection);
  assert.ok(!text.includes('PRIVATE KEY') && !text.includes(SALT.slice(7)) && !text.includes('hmac-sha256'), 'no key, salt or handle in the file');
  assert.equal(r.projections[0].projection.signature.key_id, 'k1');
}));

test('the shipped examples: people validate with one self; the rule example emits nothing until approved; the projection example re-derives from its seeds', () => withTmp(async (dir) => {
  const people = readJson(join(ROOT, 'examples', 'people.example.json'));
  assert.equal(people.schema_version, 'dotfield.people/1');
  for (const p of people.people) assert.equal(validate(loadSchema('person'), p).ok, true, JSON.stringify(validate(loadSchema('person'), p).errors));
  assert.equal(people.people.filter((p) => p.kind === 'self').length, 1);
  const exampleRule = readJson(join(ROOT, 'examples', 'share-rule.example.json'));
  assert.equal(validate(loadSchema('share-rule'), exampleRule).ok, true);
  assert.equal(exampleRule.state, 'awaiting_owner');
  const selfKey = keyFromSeed('dotfield-example-self-key');
  assert.equal(people.people[0].public_key, selfKey.publicKey);
  assert.equal(people.people[1].public_key, keyFromSeed('dotfield-example-ada-key').publicKey);
  assert.equal(exampleRule.redaction.salt, `base64:${Buffer.from(sha256('dotfield-example-rule-salt').slice(7), 'hex').toString('base64')}`);
  const now = new Date('2026-10-01T11:00:00Z');
  const graph = readJson(join(ROOT, 'examples', 'scene-graph.json'));
  const exp = graph.nodes.find((n) => n.id === 'exp-0412');
  const nodes = [{ ...exp, tags: ['vibration', 'slam'], fields: { ...exp.fields, tags: ['vibration', 'slam'] } }];
  const experiments = { id: 'experiments', record: { id_field: 'exp_id', label_field: 'title', sublabel_field: 'metric', tag_field: 'tags', dates: { happened_on: 'run_on', remembered_on: 'logged_on' }, public_fields: ['title', 'metric', 'value', 'run_on', 'tags'] } };
  const disciplines = [{ label: 'SLAM', patterns: ['slam', 'loop closure'], weight: 1, source: 'robotics-lab' }, { label: 'vibration', patterns: ['vibration'], weight: 0.8, source: 'robotics-lab' }];
  const common = { nodes, rooms: [experiments], people: people.people, disciplines, key: selfKey.privateKey, keyId: 'self-k1', now, dataDir: join(dir, 'data'), root: dir, argv: ['share', 'project', '--rule', 'rule-01'] };
  const waiting = await emitProjection({ ...common, rule: exampleRule, rules: [exampleRule] });
  assert.deepEqual([waiting.ok, waiting.receipt.exit_code, files(dir)], [false, 3, []], 'the literal example emits nothing');
  const active = { ...exampleRule, state: 'active', approval: { proposal_id: 'prop_20261001T103000Z_5e1f00', decided_at: '2026-10-01T10:30:00Z', receipt_ref: '.dotfield/receipts/rcpt_20261001T103000Z_5e1f.json' }, dates: { ...exampleRule.dates, released_on: '2026-10-01' } };
  const r = await emitProjection({ ...common, rule: active, rules: [active] });
  assert.equal(r.ok, true, JSON.stringify(fails(r.checks)));
  assert.deepEqual(r.projections[0].projection, readJson(join(ROOT, 'examples', 'projection.example.json')), 'examples/projection.example.json is current (regenerate from the seeds in references/SHARING.md)');
  assert.ok(verify(r.projections[0].projection, r.projections[0].projection.signature, people.people[0].public_key));
}));
