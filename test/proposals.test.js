// lib/proposals.mjs: propose() writes only data/proposals/<id>.json (the
// store is untouched until approve), the summary and its digest, per-row
// DF_RECORD_* checks, the mode refusal, the split above
// approval.max_records_per_proposal, decide() approve/edit/reject with the
// reviewed digest, idempotent approve, a conflicting second decision refused,
// storage faults as exit 4, receipts that verify, list(), and the static
// guarantee that no MCP tool reaches a decide path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MAX_PER_PROPOSAL, checkRecords, decide, list, propose, proposalId, proposalPath, readProposal, summarize, summaryDigest,
} from '../lib/proposals.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { verifyReceipt } from '../lib/receipt.mjs';
import { sha256File } from '../lib/digest.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { exists, imports, walk } from './helpers/scan.mjs';
import { NOW, NOW_ISO, patchJson, readJson, scaffoldCenter } from './helpers/center.mjs';
import { withTmp } from './helpers/tmp.mjs';

const ENV = {};
const rec = (i, extra = {}) => ({ note_id: `n-${i}`, title: `Note ${i}`, logged_on: '2026-10-01', tags: ['t'], ...extra });
const failed = (checks) => checks.filter((c) => c.status === 'fail').map((c) => c.code);
const storeFile = (c) => join(c.dataDir, 'rooms', 'notes.json');

function boot(dir, patch = null) {
  const c = scaffoldCenter(dir);
  if (patch) patchJson(c.roomFile('notes', 'room.json'), patch);
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const base = { now: NOW, dataDir: c.dataDir, dotDir: c.dotDir, config: c.config, env: ENV, root: c.root, rooms: d.rooms };
  return { c, room: d.rooms[0], base };
}

test('propose writes one proposal file and nothing else; the proposal validates; the receipt is status proposal, exit 3', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const r = await propose({ ...base, room, records: [rec(1), rec(2)], by: 'agent:scribe' });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((x) => x.status === 'fail')));
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposal, r.proposals[0]);
  const p = r.proposal;
  assert.match(p.proposal_id, /^prop_20261001T101500Z_[0-9a-f]{6}$/);
  assert.equal(validate(loadSchema('proposal'), p).ok, true);
  assert.equal(p.status, 'awaiting_owner');
  assert.deepEqual(p.owner_decision, { state: 'awaiting_owner', decision: null, reviewed_summary_digest: null, note: null });
  assert.equal(p.created_at, NOW_ISO);
  assert.equal(p.decided_at, null);
  assert.equal(p.split, null);
  assert.equal(p.by, 'agent:scribe');
  assert.equal(p.scope, 'owner');
  assert.deepEqual(p.summary, { adds: 2, changes: 0, unchanged: 0, fields_touched: ['logged_on', 'note_id', 'tags', 'title'], sample_rows: [rec(1), rec(2)], foreign_spans: [], blocked_actions: ['send_email'] });
  assert.equal(p.summary_digest, summaryDigest(p.summary));
  assert.deepEqual(readdirSync(c.dataDir), ['proposals'], 'only data/proposals/ exists');
  assert.deepEqual(readdirSync(join(c.dataDir, 'proposals')), [`${p.proposal_id}.json`]);
  assert.deepEqual(readJson(r.paths[0]), p);
  assert.equal(existsSync(storeFile(c)), false, 'the store is untouched');
  assert.equal(r.receipt.status, 'proposal');
  assert.equal(r.receipt.exit_code, 3, 'a proposal waits for the owner');
  assert.equal(r.receipt.command, 'propose');
  assert.deepEqual(r.receipt.store, { target: 'data/rooms/notes.json', backend: 'file' });
  assert.equal(r.receipt.owner_decision.state, 'awaiting_owner');
  assert.deepEqual(r.receipt.outputs.map((o) => [o.ref, o.kind]), [[`data/proposals/${p.proposal_id}.json`, 'proposal']]);
  assert.equal(validate(loadSchema('receipt'), r.receipt).ok, true, JSON.stringify(validate(loadSchema('receipt'), r.receipt).errors));
  assert.equal(r.receipt.maturity, 'local_beta');
  assert.equal(r.receipt.mode, 'proposal_only');
  const again = await propose({ ...base, room, records: [rec(1), rec(2)], by: 'agent:scribe' });
  assert.equal(again.proposal.proposal_id, p.proposal_id, 'same clock, same content, same id');
  assert.equal(proposalId({ now: NOW, room: 'notes', by: 'x', scope: 'owner', records: [1] }), proposalId({ now: NOW, room: 'notes', by: 'x', scope: 'owner', records: [1] }));
  assert.notEqual(proposalId({ now: NOW, room: 'notes', by: 'x', scope: 'owner', records: [1] }), proposalId({ now: NOW, room: 'notes', by: 'x', scope: 'owner', records: [2] }));
  await assert.rejects(propose({ ...base, now: undefined, room, records: [] }), TypeError);
  await assert.rejects(propose({ ...base, room, records: [], kind: 'wish' }), TypeError);
}));

test('per-row checks block a proposal and write nothing: schema, id missing, duplicate id, too large, bad date', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const rows = [rec(1, { title: 7 }), { title: 'no id', logged_on: '2026-10-01' }, rec(3), rec(3), rec(4, { body: 'x'.repeat(20000) }), rec(5, { happened_on: '2026-13-01' })];
  const checks = checkRecords(room, rows);
  assert.deepEqual([...new Set(failed(checks))].sort(), ['DF_RECORD_DATE_INVALID', 'DF_RECORD_DUP_ID', 'DF_RECORD_ID_MISSING', 'DF_RECORD_SCHEMA_INVALID', 'DF_RECORD_TOO_LARGE', 'DF_SCHEMA_FORMAT', 'DF_SCHEMA_MAX_LENGTH', 'DF_SCHEMA_REQUIRED', 'DF_SCHEMA_TYPE'], 'the DF_SCHEMA_* details ride beside the DF_RECORD_* codes');
  assert.deepEqual(checks.filter((x) => x.code === 'DF_RECORD_DUP_ID' && x.status === 'fail').map((x) => x.path), ['$[3].note_id']);
  assert.deepEqual(checks.filter((x) => x.code === 'DF_SCHEMA_TYPE').map((x) => x.path), ['$[0].title']);
  assert.deepEqual(checks.filter((x) => x.code === 'DF_RECORD_DATE_INVALID').map((x) => x.path), ['$[5].happened_on']);
  assert.deepEqual(checkRecords(room, [rec(1)]).map((x) => x.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(checkRecords(room, 'nope')[0].code, 'DF_RECORD_SCHEMA_INVALID');
  assert.equal(checkRecords(room, [null])[0].code, 'DF_RECORD_SCHEMA_INVALID');
  assert.equal(checkRecords({ manifest: room.manifest }, [rec(1)])[0].code, 'DF_RECORD_SCHEMA_INVALID', 'no record schema loaded');
  const r = await propose({ ...base, room, records: rows });
  assert.equal(r.ok, false);
  assert.deepEqual(r.proposals, []);
  assert.equal(r.receipt.status, 'blocked');
  assert.equal(r.receipt.exit_code, 2);
  assert.equal(existsSync(join(c.dataDir, 'proposals')), false);
}));

test('a read_only or blocked room refuses proposals with DF_PROPOSAL_MODE_REFUSED (exit 3) and writes nothing', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir, (doc) => { doc.mode = 'read_only'; });
  const r = await propose({ ...base, room, records: [rec(1)] });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r.checks), ['DF_PROPOSAL_MODE_REFUSED']);
  assert.equal(r.receipt.status, 'refused');
  assert.equal(r.receipt.exit_code, 3);
  assert.equal(existsSync(join(c.dataDir, 'proposals')), false);
  room.manifest.mode = 'blocked';
  assert.equal((await propose({ ...base, room, records: [rec(1)] })).receipt.exit_code, 3);
}));

test('decide approve: needs the reviewed digest, then writes the store (merged by id) and the decided proposal; the receipt verifies', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const { proposal: p } = await propose({ ...base, room, records: [rec(1), rec(2)] });
  const noDigest = await decide(p.proposal_id, { ...base, decision: 'approve' });
  assert.equal(noDigest.ok, false);
  assert.deepEqual(failed(noDigest.checks), ['DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH']);
  assert.equal(noDigest.receipt.exit_code, 3);
  assert.equal(existsSync(storeFile(c)), false, 'nothing written before approve');
  assert.equal(readProposal(c.dataDir, p.proposal_id).proposal.status, 'awaiting_owner');
  const stale = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: 'sha256:' + '0'.repeat(64) });
  assert.deepEqual(failed(stale.checks), ['DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH']);
  const ok = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest, note: 'looks right' });
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((x) => x.status === 'fail')));
  assert.equal(ok.applied, true);
  assert.equal(ok.idempotent, false);
  assert.deepEqual([ok.written.count, ok.written.target, ok.written.backend], [2, 'data/rooms/notes.json', 'file']);
  assert.deepEqual(readJson(storeFile(c)).records, [rec(1), rec(2)]);
  const d = ok.proposal;
  assert.equal(d.status, 'approved');
  assert.deepEqual(d.owner_decision, { state: 'approved', decision: 'approve', reviewed_summary_digest: p.summary_digest, note: 'looks right' });
  assert.equal(d.decided_at, NOW_ISO);
  assert.deepEqual(readJson(proposalPath(c.dataDir, p.proposal_id)), d, 'the decided proposal is on disk');
  assert.equal(validate(loadSchema('proposal'), d).ok, true);
  assert.equal(ok.receipt.status, 'approved');
  assert.equal(ok.receipt.exit_code, 0);
  assert.equal(ok.receipt.command, 'approve');
  assert.deepEqual(ok.receipt.owner_decision, { state: 'approved', reviewed_summary_digest: p.summary_digest });
  assert.deepEqual(ok.receipt.outputs.map((o) => [o.ref, o.kind, o.action]), [['data/rooms/notes.json', 'store', 'written'], [`data/proposals/${p.proposal_id}.json`, 'proposal', 'written']]);
  assert.equal(d.receipt_ref, `.dotfield/receipts/${ok.receipt.receipt_id}.json`);
  assert.equal(ok.receiptPath, join(c.dotDir, 'receipts', `${ok.receipt.receipt_id}.json`));
  const v = verifyReceipt(ok.receiptPath, { root: c.root });
  assert.deepEqual(v.checks.filter((x) => x.status === 'fail' && x.code !== 'DF_RECEIPT_ENGINE_DRIFT'), [], 'the written receipt verifies against the files it names');
  assert.equal(validate(loadSchema('receipt'), ok.receipt).ok, true);
  const second = await propose({ ...base, room, records: [rec(2, { title: 'Two, edited' }), rec(3)] });
  assert.deepEqual(second.proposal.summary, { ...second.proposal.summary, adds: 1, changes: 1, unchanged: 0 });
  await decide(second.proposal.proposal_id, { ...base, decision: 'approve', reviewedDigest: second.proposal.summary_digest });
  assert.deepEqual(readJson(storeFile(c)).records.map((x) => [x.note_id, x.title]), [['n-1', 'Note 1'], ['n-2', 'Two, edited'], ['n-3', 'Note 3']], 'merged by id, order kept');
  assert.ok(existsSync(`${storeFile(c)}.bak`));
}));

test('approve is idempotent; a different second decision is refused with DF_PROPOSAL_ALREADY_DECIDED and changes nothing', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const { proposal: p } = await propose({ ...base, room, records: [rec(1)] });
  const first = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
  assert.equal(first.ok, true);
  const storeDigest = sha256File(storeFile(c));
  const proposalDigest = sha256File(proposalPath(c.dataDir, p.proposal_id));
  const again = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.applied, false);
  assert.equal(again.written, null);
  assert.equal(again.receipt.status, 'approved');
  assert.equal(again.receipt.exit_code, 0);
  assert.ok(again.checks.some((x) => x.code === 'DF_PROPOSAL_ALREADY_DECIDED' && x.status === 'pass'));
  const stillAgain = await decide(p.proposal_id, { ...base, decision: 'approve' });
  assert.equal(stillAgain.ok, true, 'the digest is not re-checked for a repeated identical decision');
  for (const decision of ['reject', 'edit']) {
    const conflict = await decide(p.proposal_id, { ...base, decision, edited: [rec(9)], reviewedDigest: p.summary_digest });
    assert.equal(conflict.ok, false);
    assert.deepEqual(failed(conflict.checks), ['DF_PROPOSAL_ALREADY_DECIDED']);
    assert.equal(conflict.receipt.status, 'refused');
    assert.equal(conflict.receipt.exit_code, 3);
  }
  assert.equal(sha256File(storeFile(c)), storeDigest, 'the store did not change');
  assert.equal(sha256File(proposalPath(c.dataDir, p.proposal_id)), proposalDigest, 'the proposal did not change');
  assert.ok(!existsSync(`${storeFile(c)}.bak`), 'no second write happened');
}));

test('reject writes nothing to the store; edit replaces the records and refuses an invalid edit file', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const { proposal: p } = await propose({ ...base, room, records: [rec(1)] });
  const rejected = await decide(p.proposal_id, { ...base, decision: 'reject', note: 'not now' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.receipt.status, 'rejected');
  assert.equal(rejected.receipt.exit_code, 0);
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.proposal.owner_decision.note, 'not now');
  assert.equal(rejected.proposal.owner_decision.reviewed_summary_digest, null, 'reject needs no digest');
  assert.equal(existsSync(storeFile(c)), false);
  assert.deepEqual(rejected.receipt.outputs.map((o) => o.kind), ['proposal']);
  const late = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
  assert.deepEqual(failed(late.checks), ['DF_PROPOSAL_ALREADY_DECIDED']);
  assert.equal(existsSync(storeFile(c)), false);
  const { proposal: q } = await propose({ ...base, room, records: [rec(2)], by: 'import:csv' });
  const badEdit = await decide(q.proposal_id, { ...base, decision: 'edit', edited: [{ note_id: 'n-2', title: 5 }], reviewedDigest: q.summary_digest });
  assert.equal(badEdit.ok, false);
  assert.ok(failed(badEdit.checks).includes('DF_PROPOSAL_EDIT_FILE_INVALID') && failed(badEdit.checks).includes('DF_RECORD_SCHEMA_INVALID'));
  assert.equal(badEdit.receipt.exit_code, 2);
  assert.equal(existsSync(storeFile(c)), false);
  assert.equal(readProposal(c.dataDir, q.proposal_id).proposal.status, 'awaiting_owner');
  const edited = await decide(q.proposal_id, { ...base, decision: 'edit', edited: [rec(2, { title: 'Edited by the owner' })], reviewedDigest: q.summary_digest });
  assert.equal(edited.ok, true, JSON.stringify(edited.checks.filter((x) => x.status === 'fail')));
  assert.equal(edited.proposal.status, 'edited');
  assert.equal(edited.proposal.owner_decision.state, 'edited');
  assert.equal(edited.receipt.status, 'approved');
  assert.equal(edited.receipt.owner_decision.state, 'edited');
  assert.deepEqual(readJson(storeFile(c)).records, [rec(2, { title: 'Edited by the owner' })]);
  assert.deepEqual(edited.proposal.records, [rec(2, { title: 'Edited by the owner' })], 'the proposal keeps what was applied');
}));

test('split: above approval.max_records_per_proposal (200) the import becomes several proposals with one batch id', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  assert.equal(DEFAULT_MAX_PER_PROPOSAL, 200);
  const rows = Array.from({ length: 450 }, (_, i) => rec(i + 1));
  const r = await propose({ ...base, room, records: rows, by: 'import:csv' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.proposals.map((p) => p.records.length), [200, 200, 50]);
  assert.deepEqual(r.proposals.map((p) => p.split), [1, 2, 3].map((index) => ({ batch_id: r.proposals[0].split.batch_id, index, of: 3 })));
  assert.equal(new Set(r.proposals.map((p) => p.proposal_id)).size, 3);
  assert.deepEqual(r.checks.filter((x) => x.code === 'DF_PROPOSAL_SPLIT').map((x) => [x.status, x.blocking]), [['fail', false]]);
  assert.equal(r.receipt.exit_code, 3, 'the split is a non-blocking finding: the proposals still wait for the owner');
  assert.equal(readdirSync(join(c.dataDir, 'proposals')).length, 3);
  assert.equal(list({ dataDir: c.dataDir, status: 'awaiting_owner' }).length, 3);
  const r2 = await propose({ ...base, config: { ...c.config, approval: { max_records_per_proposal: 100 } }, room, records: rows, by: 'import:other' });
  assert.deepEqual(r2.proposals.map((p) => p.records.length), [100, 100, 100, 100, 50]);
  const one = await propose({ ...base, room, records: rows.slice(0, 200), by: 'import:exact' });
  assert.equal(one.proposals.length, 1);
  assert.ok(one.checks.some((x) => x.code === 'DF_PROPOSAL_SPLIT' && x.status === 'pass'));
  for (const p of r.proposals) {
    const d = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
    assert.equal(d.ok, true);
  }
  assert.equal(readJson(storeFile(c)).records.length, 450);
}));

test('refusals: unknown id, invalid decision, a draft, a room missing from the center', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const missing = await decide('prop_20261001T101500Z_abcdef', { ...base, decision: 'approve' });
  assert.deepEqual(failed(missing.checks), ['DF_PROPOSAL_NOT_FOUND']);
  assert.equal(missing.receipt.status, 'refused');
  assert.equal(missing.receipt.exit_code, 2);
  assert.equal(missing.proposal, null);
  assert.deepEqual(failed((await decide(['..', '..', 'etc', 'passwd'].join('/'), { ...base, decision: 'approve' })).checks), ['DF_PROPOSAL_NOT_FOUND'], 'a path-like id is not a proposal');
  const { proposal: p } = await propose({ ...base, room, records: [rec(1)] });
  const bad = await decide(p.proposal_id, { ...base, decision: 'maybe' });
  assert.deepEqual(failed(bad.checks), ['DF_PROPOSAL_INVALID_DECISION']);
  assert.equal(bad.receipt.exit_code, 2);
  patchJson(proposalPath(c.dataDir, p.proposal_id), (doc) => { doc.status = 'draft'; });
  const draft = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
  assert.deepEqual(failed(draft.checks), ['DF_PROPOSAL_NOT_AWAITING']);
  assert.equal(draft.receipt.exit_code, 3);
  patchJson(proposalPath(c.dataDir, p.proposal_id), (doc) => { doc.status = 'awaiting_owner'; });
  const noRoom = await decide(p.proposal_id, { ...base, rooms: [], decision: 'approve', reviewedDigest: p.summary_digest });
  assert.deepEqual(failed(noRoom.checks), ['DF_PROPOSAL_NOT_FOUND']);
  assert.equal(existsSync(storeFile(c)), false);
  patchJson(proposalPath(c.dataDir, p.proposal_id), (doc) => { doc.status = 'surprise'; });
  assert.equal(readProposal(c.dataDir, p.proposal_id).ok, false, 'an invalid proposal file is reported, not thrown');
  await assert.rejects(decide(p.proposal_id, { ...base, now: null, decision: 'approve' }), TypeError);
}));

test('a storage fault at approve is exit 4 and leaves the proposal awaiting; a limit breach is exit 2', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const { proposal: p } = await propose({ ...base, room, records: [rec(1), rec(2), rec(3)] });
  mkdirSync(c.dataDir, { recursive: true });
  writeFileSync(join(c.dataDir, 'rooms'), 'a file in the way');
  const fault = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
  assert.equal(fault.ok, false);
  assert.deepEqual(failed(fault.checks), ['DF_STORE_FAULT']);
  assert.equal(fault.receipt.status, 'blocked');
  assert.equal(fault.receipt.exit_code, 4);
  assert.equal(readProposal(c.dataDir, p.proposal_id).proposal.status, 'awaiting_owner', 'the proposal can be approved again once storage is back');
  const { c: c2, room: room2, base: base2 } = boot(join(dir, 'two'), (doc) => { doc.store.max_records = 2; });
  const { proposal: q } = await propose({ ...base2, room: room2, records: [rec(1), rec(2), rec(3)] });
  const limit = await decide(q.proposal_id, { ...base2, decision: 'approve', reviewedDigest: q.summary_digest });
  assert.deepEqual(failed(limit.checks), ['DF_STORE_MAX_RECORDS']);
  assert.equal(limit.receipt.exit_code, 2);
  assert.equal(existsSync(storeFile(c2)), false);
  assert.equal(readProposal(c2.dataDir, q.proposal_id).proposal.status, 'awaiting_owner');
}));

test('scope: a person-scoped proposal on an owner-scoped room is refused at approve; a person-scoped room shards', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const { proposal: p } = await propose({ ...base, room, records: [rec(1)], scope: 'person_ada', by: 'ada' });
  assert.equal(p.scope, 'person_ada');
  const r = await decide(p.proposal_id, { ...base, decision: 'approve', reviewedDigest: p.summary_digest });
  assert.deepEqual(failed(r.checks), ['DF_STORE_SCOPE_REFUSED']);
  assert.equal(r.receipt.exit_code, 3);
  assert.equal(existsSync(storeFile(c)), false);
  room.manifest.store.scope = 'person';
  const { proposal: q } = await propose({ ...base, room, records: [rec(2)], scope: 'person_ada', by: 'ada' });
  const ok = await decide(q.proposal_id, { ...base, decision: 'approve', reviewedDigest: q.summary_digest });
  assert.equal(ok.ok, true);
  assert.equal(ok.written.target, 'data/person_ada/rooms/notes.json');
  assert.equal(ok.receipt.scope, 'person_ada');
  assert.equal(ok.receipt.viewer, 'ada');
}));

test('rule and pair proposals record the decision only (applied: false); summarize and list behave', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const pair = await propose({ ...base, room, records: [rec(7)], kind: 'pair', by: 'connect' });
  const d = await decide(pair.proposal.proposal_id, { ...base, decision: 'approve', reviewedDigest: pair.proposal.summary_digest });
  assert.equal(d.ok, true);
  assert.equal(d.applied, false);
  assert.equal(d.written, null);
  assert.equal(d.proposal.status, 'approved');
  assert.equal(existsSync(storeFile(c)), false, 'the pair effect belongs to meet.mjs');
  assert.match(d.receipt.next_action, /applied by its own verb/);
  const existing = [rec(1), rec(2)];
  const s = summarize({ room, records: [rec(1), rec(2, { title: 'changed' }), rec(3, { body: 'x'.repeat(500) })], existing, foreignSpans: [{ person_id: 'ada', rule_ref: 'ada/rule-01', text: 'span' }], blockedActions: ['send_email'] });
  assert.deepEqual([s.adds, s.changes, s.unchanged], [1, 1, 1]);
  assert.deepEqual(s.fields_touched, ['body', 'logged_on', 'note_id', 'tags', 'title']);
  assert.equal(s.sample_rows.length, 3);
  assert.equal(s.sample_rows[2].body.length, 201, 'long values are clipped in the sample');
  assert.deepEqual(s.foreign_spans, [{ person_id: 'ada', rule_ref: 'ada/rule-01', text: 'span' }]);
  assert.equal(summarize({ room, records: Array.from({ length: 9 }, (_, i) => rec(i)) }).sample_rows.length, 5);
  await propose({ ...base, room, records: [rec(1)], by: 'a' });
  await propose({ ...base, room, records: [rec(2)], by: 'b' });
  assert.equal(list({ dataDir: c.dataDir }).length, 3);
  assert.equal(list({ dataDir: c.dataDir, status: 'awaiting_owner' }).length, 2);
  assert.equal(list({ dataDir: c.dataDir, kind: 'pair' }).length, 1);
  assert.equal(list({ dataDir: c.dataDir, room: 'notes', status: 'approved' }).length, 1);
  assert.deepEqual(list({ dataDir: join(dir, 'nowhere') }), []);
  const ids = list({ dataDir: c.dataDir }).map((x) => x.proposal_id);
  assert.deepEqual(ids, [...ids].sort(), 'same created_at: sorted by id');
}));

test('no MCP tool reaches a decide path: nothing under mcp/ imports lib/proposals.mjs decide or lib/store.mjs', (t) => {
  if (!exists('mcp/server.mjs')) return t.skip('mcp/ not built yet; the scan runs once it lands');
  for (const rel of walk('mcp', { exts: new Set(['.mjs', '.js']) })) {
    const text = readFileSync(join(process.cwd(), rel), 'utf8');
    for (const spec of imports(text)) assert.ok(!/\/store\.mjs$/.test(spec), `${rel} imports the store`);
    assert.ok(!/\bdecide\s*\(/.test(text), `${rel} calls decide()`);
  }
  return undefined;
});

test('a decision is final: proposing the same records under the same clock after approve is refused with DF_PROPOSAL_ALREADY_DECIDED (exit 3) and the decided file is untouched; while still awaiting, the file is reused unchanged', () => withTmp(async (dir) => {
  const { c, room, base } = boot(dir);
  const first = await propose({ ...base, room, records: [rec(1), rec(2)], by: 'import:csv' });
  const file = proposalPath(c.dataDir, first.proposal.proposal_id);
  const bytes = readFileSync(file);
  const again = await propose({ ...base, room, records: [rec(1), rec(2)], by: 'import:csv' });
  assert.equal(again.ok, true);
  assert.equal(again.proposal.proposal_id, first.proposal.proposal_id, 'same clock, same content, same id');
  assert.ok(readFileSync(file).equals(bytes), 'an awaiting proposal is reused, not rewritten');
  assert.match(again.receipt.next_action, /already awaiting under this clock, left as written/);
  assert.equal(again.receipt.outputs[0].action, undefined, 'nothing was written');
  assert.equal(readdirSync(join(c.dataDir, 'proposals')).length, 1);
  const ok = await decide(first.proposal.proposal_id, { ...base, decision: 'approve', reviewedDigest: first.proposal.summary_digest });
  assert.equal(ok.ok, true, JSON.stringify(failed(ok.checks)));
  assert.equal(readJson(storeFile(c)).count, 2);
  const decided = readProposal(c.dataDir, first.proposal.proposal_id).proposal;
  assert.equal(decided.status, 'approved');
  const after = await propose({ ...base, room, records: [rec(1), rec(2)], by: 'import:csv' });
  assert.equal(after.ok, false);
  assert.deepEqual(after.proposals, []);
  assert.equal(after.proposal, null);
  assert.deepEqual(failed(after.checks), ['DF_PROPOSAL_ALREADY_DECIDED']);
  assert.equal(after.receipt.status, 'refused');
  assert.equal(after.receipt.exit_code, 3);
  assert.match(after.checks.find((x) => x.code === 'DF_PROPOSAL_ALREADY_DECIDED').message, /already approved/);
  assert.deepEqual(readProposal(c.dataDir, first.proposal.proposal_id).proposal, decided, 'the decided file was not overwritten');
  assert.equal(readProposal(c.dataDir, first.proposal.proposal_id).proposal.receipt_ref, decided.receipt_ref);
  const reject = await decide(first.proposal.proposal_id, { ...base, decision: 'reject' });
  assert.equal(reject.ok, false);
  assert.deepEqual(failed(reject.checks), ['DF_PROPOSAL_ALREADY_DECIDED'], 'no second, conflicting decision gets through');
  assert.equal(readProposal(c.dataDir, first.proposal.proposal_id).proposal.status, 'approved');
  assert.equal(readJson(storeFile(c)).count, 2, 'the store keeps the approved records');
  const other = await propose({ ...base, room, records: [rec(3)], by: 'import:csv' });
  assert.equal(other.ok, true, 'different content is a new proposal under the same clock');
  assert.notEqual(other.proposal.proposal_id, first.proposal.proposal_id);
}));
