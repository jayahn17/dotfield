// cli-full: the thirteen verbs beyond cli-core (init, prove, add, import,
// approve, plan, run, share, connect, serve, export, delete, migrate) run
// through the real bin on fixtures inside temp dirs: the 19/27 count pins,
// exit codes 0/2/3/4/5, the owner gate (piped approve exits 3 and the store
// is untouched; a token file approves and is idempotent), the two-center
// projection round trip, and init against packs/starter. Zero network, dry
// provider only, one clock (SOURCE_DATE_EPOCH).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { ROOT, runCli } from './helpers/cli.mjs';
import { CENTER_MIN, EPOCH_ENV, NOW_ISO, cloneRoom, patchJson, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { listVerbs, loadCommand } from '../bin/dotfield.mjs';
import { PINNED } from '../lib/rules.mjs';
import { canonical } from '../lib/digest.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { createStore } from '../lib/store.mjs';
import { fingerprint, generateKeyPair, keyFromSeed, loadKey, writeKeyFile } from '../lib/sign.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'importers');
const SKEPTIC = { id: 'skeptic', display: 'Skeptic', tier: 'challenger', domain: 'review', primary_field: 'methodology', adjacent_fields: [], lens: 'the burden of proof is on the claim', keywords: ['review', 'verify'], challenger_for: ['scribe'], influences: [], constraint: 'never approves; it only asks for evidence', prompt: null };
const fails = (r) => r.checks.filter((c) => c.status === 'fail');
const codes = (r) => fails(r).map((c) => c.code);
const cli = (args, c, env = {}, extra = {}) => runCli(args, { cwd: c.root, env: { ...EPOCH_ENV, ...env }, ...extra });

async function seed(c, roomId, records) {
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const store = createStore({ room: d.rooms.find((r) => r.id === roomId), dataDir: c.dataDir, config: c.config, env: {}, root: c.root });
  await store.write(records, { approved: true, now: new Date(NOW_ISO), by: 'test' });
  return store.path();
}
function keyFiles(c) {
  mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
  writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'cli-test-session-key\n');
  writeFileSync(join(c.dataDir, 'keys', 'handle.salt'), 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n');
  const token = join(c.dataDir, 'keys', 'owner.token');
  writeFileSync(token, 'test-owner-token-0123456789abcdef\n', { mode: 0o600 });
  chmodSync(token, 0o600);
  return token;
}
/** A center with records, keys, a challenger desk (papers room) and the owner token; returns {c, token}. */
async function ready(dir, { owner = null } = {}) {
  const c = scaffoldCenter(dir);
  cloneRoom(c, 'notes', 'papers', (d) => { d.label = 'Papers'; d.desks = [SKEPTIC]; });
  if (owner) {
    patchJson(c.configPath, (cfg) => { cfg.center.owner_person_id = owner; });
    patchJson(join(c.centerDir, 'people', 'people.json'), (doc) => { doc.people[0].person_id = owner; });
  }
  const examples = readJson(c.roomFile('notes', 'examples.json'));
  await seed(c, 'notes', examples);
  await seed(c, 'papers', examples);
  const token = keyFiles(c);
  return { c, token };
}
function rule(receiver) {
  return { schema_version: 'dotfield.share-rule/1', rule_id: 'rule-01', grantor_person_id: 'self', receiver: { type: 'person', id: receiver }, subject: { selector: { rooms: ['notes'], tags: ['idea'] } }, switches: { view: true, annotate: true, re_share: false, aggregate: false, train: false }, redaction: { privacy_level_ceiling: 'private', fields_allowed: ['title', 'tags'], operators: [], salt: `base64:${Buffer.alloc(32, 9).toString('base64')}` }, dates: { granted_on: '2026-10-01', released_on: null, expires_on: '2027-10-01' }, state: 'draft', approval: null, evidence_refs: [] };
}
/** A schema-valid local pack built from the center-min fixture (one room, a theme, disciplines, no code). */
function miniPack(dir) {
  const pack = join(dir, 'packs', 'mini');
  cpSync(join(CENTER_MIN, 'rooms', 'notes'), join(pack, 'rooms', 'notes'), { recursive: true });
  cpSync(join(CENTER_MIN, 'brand.json'), join(pack, 'theme.json'));
  cpSync(join(CENTER_MIN, 'people', 'disciplines.json'), join(pack, 'disciplines.json'));
  writeJson(join(pack, 'roster.json'), { schema_version: 'dotfield.pack-roster/1', pack: 'mini', desks: [] });
  writeJson(join(pack, 'pack.json'), { schema_version: 'dotfield.pack/1', id: 'mini', label: 'Mini', profession: 'anyone', summary: 'One room to begin with.', version: '0.1.0', maturity: 'local_beta', rooms: ['notes'], roster: 'roster.json', disciplines: 'disciplines.json', theme: 'theme.json', boundary_vocab: ['calibration'], share_defaults: { privacy_level: 'private', redaction_operators: [] }, views_off: [], regulatory_notes: [], recipes: ['first-hour.md'] });
  return pack;
}

test('19 verbs and 27 leaf subverbs, every module exporting {verb, leaves, usage, run}', async () => {
  const verbs = listVerbs();
  assert.equal(verbs.length, PINNED.cli_verbs);
  assert.deepEqual(verbs, ['add', 'approve', 'compare', 'connect', 'delete', 'doctor', 'export', 'import', 'init', 'migrate', 'plan', 'prove', 'render', 'run', 'serve', 'share', 'theme', 'validate', 'verify']);
  let leaves = 0;
  for (const v of verbs) { const m = await loadCommand(v); assert.equal(m.verb, v); assert.ok(typeof m.usage === 'string' && Array.isArray(m.leaves) && m.leaves.length, v); leaves += m.leaves.length; }
  assert.equal(leaves, PINNED.cli_leaf_subverbs);
});

test('init: a local pack becomes a center with keys (0600), a prove record and a registry; refusals for URL, draft, unknown and an existing center', async () => {
  await withTmp(async (dir) => {
    const pack = miniPack(dir);
    const root = join(dir, 'fork');
    mkdirSync(root);
    const c = { root };
    const r = cli(['init', '--pack', pack, '--name', 'Mini Center', '--json'], c);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.status, 'written');
    assert.deepEqual(codes(r.json), []);
    const cfg = readJson(join(root, 'center', 'center.config.json'));
    assert.equal(cfg.center.name, 'Mini Center');
    assert.deepEqual(cfg.installed_packs.map((p) => [p.id, p.version]), [['mini', '0.1.0']]);
    assert.match(cfg.installed_packs[0].digest, /^sha256:[0-9a-f]{64}$/);
    const people = readJson(join(root, 'center', 'people', 'people.json')).people;
    assert.equal(people.length, 1); assert.equal(people[0].kind, 'self'); assert.equal(people[0].public_key, undefined, 'no key material in people.json');
    assert.equal(readJson(join(root, 'center', 'brand.json')).name, 'Mini Center');
    for (const f of ['session.key', 'owner.token', 'handle.salt', 'self.ed25519']) assert.ok(existsSync(join(root, 'data', 'keys', f)), f);
    if (process.platform !== 'win32') for (const f of ['owner.token', 'self.ed25519']) assert.equal(statSync(join(root, 'data', 'keys', f)).mode & 0o077, 0, `${f} is 0600`);
    assert.ok(loadKey(join(root, 'data'), 'self').ok);
    assert.equal(readJson(join(root, '.dotfield', 'prove', 'notes.json')).ok, true);
    assert.ok(existsSync(join(root, '.dotfield', 'registry.json')));
    assert.ok(existsSync(join(root, 'center', 'docs', 'recipes', 'first-hour.md')));
    assert.equal(cli(['init', '--pack', pack, '--json'], c).code, 3, 'an existing center is refused without --force');
    assert.equal(cli(['init', '--pack', pack, '--force', '--json'], c).code, 0);
    assert.ok(codes(cli(['init', '--pack', 'https://example.invalid/pack', '--json'], c).json).includes('DF_PACK_URL_REFUSED'));
    assert.ok(codes(cli(['init', '--pack', join(dir, 'packs', 'draft', 'clinic'), '--json'], c).json).includes('DF_PACK_DRAFT'));
    assert.ok(codes(cli(['init', '--pack', 'no-such-pack', '--force', '--json'], c).json).includes('DF_PACK_NOT_FOUND'));
  });
});

test('init --pack <id> writes exactly what scripts/pack-init-check.mjs states, for every shipped pack, and the check catches a drifted room, brand, lock or key', async () => {
  const { checkInstantiated } = await import('../scripts/pack-init-check.mjs');
  const { listPacks } = await import('../lib/packs.mjs');
  for (const p of listPacks(ROOT).filter((x) => !x.draft)) {
    await withTmp(async (dir) => {
      const r = cli(['init', '--pack', p.id, '--name', 'Dotfield', '--json'], { root: dir });
      assert.equal(r.code, 0, r.stdout);
      const centerDir = join(dir, 'center');
      const check = () => checkInstantiated({ centerDir, packDir: p.dir, packId: p.id, name: 'Dotfield' });
      assert.deepEqual(check(), [], `${p.id}: the instantiation contract holds for init output`);
      if (p.id !== 'starter') return;
      const views = join(centerDir, 'rooms', 'notes', 'views.json');
      const keep = readFileSync(views);
      writeFileSync(views, '[]\n');
      assert.ok(check().some((f) => f.code === 'DF_SCHEMA_CONST' && f.path === 'starter: center/rooms/notes/views.json'), 'a changed room file is reported');
      writeFileSync(views, keep);
      const brand = readJson(join(centerDir, 'brand.json')); brand.accent = '#000000'; writeFileSync(join(centerDir, 'brand.json'), JSON.stringify(brand));
      assert.ok(check().some((f) => f.path === 'starter: center/brand.json'), 'a brand edit is reported');
      writeFileSync(join(centerDir, 'pack-lock.json'), '{}');
      assert.ok(check().some((f) => f.path === 'starter: center/pack-lock.json'), 'a lock that does not match the pack is reported');
      mkdirSync(join(centerDir, 'keys'), { recursive: true }); writeFileSync(join(centerDir, 'keys', 'session.key'), 'x');
      assert.ok(check().some((f) => f.code === 'DF_PRIVACY_KEY_MATERIAL'), 'keys under center/ are reported');
    });
  }
});

test('prove: the generic proof lifts to local_beta; tested needs a passing test.mjs (DF_ROOM_MATURITY_OVERCLAIM blocks)', async () => {
  await withTmp(async (dir) => {
    const { c } = await ready(dir);
    const r = cli(['prove', 'notes', '--json'], c);
    assert.equal(r.code, 0, r.stdout);
    const rec = readJson(join(c.dotDir, 'prove', 'notes.json'));
    assert.equal(rec.ok, true); assert.equal(rec.maturity_reached, 'local_beta'); assert.equal(rec.receipt_ref, `.dotfield/receipts/${r.json.receipt_id}.json`);
    assert.ok(!codes(cli(['validate', 'notes', '--json'], c).json).includes('DF_ROOM_MATURITY_UNPROVEN'), 'a current prove record clears UNPROVEN');
    patchJson(c.roomFile('papers', 'room.json'), (d) => { d.maturity = 'tested'; });
    const over = cli(['prove', 'papers', '--json'], c);
    assert.equal(over.code, 2); assert.ok(codes(over.json).includes('DF_ROOM_MATURITY_OVERCLAIM'));
    cpSync(join(ROOT, 'test', 'fixtures', 'sandbox', 'test-pass.mjs'), c.roomFile('papers', 'test.mjs'));
    const ok = cli(['prove', 'papers', '--json'], c);
    assert.equal(ok.code, 0, ok.stdout); assert.equal(readJson(join(c.dotDir, 'prove', 'papers.json')).maturity_reached, 'tested');
    assert.equal(cli(['prove', 'all', '--json'], c).json.maturity, 'local_beta');
  });
});

test('add: a blank room validates; a person enters only by matching fingerprint; a rule becomes an awaiting proposal', async () => {
  await withTmp(async (dir) => {
    const { c } = await ready(dir);
    assert.equal(cli(['add', 'room', 'lab-log', '--blank', '--json'], c).code, 0);
    assert.equal(cli(['validate', 'lab-log', '--json'], c).code, 0);
    assert.equal(cli(['add', 'room', 'lab-log', '--blank', '--json'], c).code, 3, 'an existing room folder is refused');
    assert.equal(cli(['add', 'room', 'copy', '--from', c.roomDir('notes'), '--json'], c).code, 0);
    assert.equal(readJson(c.roomFile('copy', 'room.json')).store.namespace, 'copy');
    const solKey = keyFromSeed('cli-test-sol').publicKey;
    writeJson(join(dir, 'sol.json'), { person_id: 'sol', kind: 'contact', display_name: 'Sol', handles: ['sol-handle'], disciplines: [], public_key: solKey });
    const bad = cli(['add', 'person', join(dir, 'sol.json'), '--fingerprint', 'not the words', '--json'], c);
    assert.equal(bad.code, 2); assert.ok(codes(bad.json).includes('DF_OVERLAY_KEY_UNKNOWN'));
    assert.ok(!readJson(join(c.centerDir, 'people', 'people.json')).people.some((p) => p.person_id === 'sol'));
    const words = fingerprint(solKey);
    const good = cli(['add', 'person', join(dir, 'sol.json'), '--fingerprint', words, '--json'], c);
    assert.equal(good.code, 0, good.stdout);
    const saved = readJson(join(c.centerDir, 'people', 'people.json')).people.find((p) => p.person_id === 'sol');
    assert.equal(saved.verification.method, 'fingerprint'); assert.match(saved.handles[0], /^hmac-sha256:[0-9a-f]{64}$/); assert.equal(saved.key_id, 'sol-k1');
    assert.equal(cli(['add', 'person', join(dir, 'sol.json'), '--fingerprint', words, '--json'], c).code, 0, 'repinning replaces the entry');
    assert.equal(readJson(join(c.centerDir, 'people', 'people.json')).people.filter((p) => p.person_id === 'sol').length, 1);
    writeJson(join(dir, 'twin.json'), { ...readJson(join(dir, 'sol.json')), person_id: 'twin', kind: 'self' });
    assert.equal(cli(['add', 'person', join(dir, 'twin.json'), '--fingerprint', words, '--json'], c).code, 2, 'a second kind: self is refused');
    writeJson(join(dir, 'rule.json'), rule('sol'));
    const r = cli(['add', 'rule', join(dir, 'rule.json'), '--json'], c);
    assert.equal(r.code, 3, r.stdout); assert.equal(r.json.status, 'proposal'); assert.equal(r.json.owner_decision.state, 'awaiting_owner');
    const file = readdirSync(join(c.dataDir, 'proposals'))[0];
    assert.equal(readJson(join(c.dataDir, 'proposals', file)).kind, 'rule');
  });
});

test('import + approve: records become one proposal; piped approve exits 3 and leaves the store; a token file approves, idempotently', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const token = keyFiles(c);
    const bad = cli(['import', 'records', 'notes', join(FIX, 'notes.csv'), '--map', 'nonsense', '--json'], c);
    assert.equal(bad.code, 2); assert.ok(codes(bad.json).includes('DF_IMPORT_MAP_INVALID'));
    const r = cli(['import', 'records', 'notes', join(FIX, 'notes.csv'), '--map', 'Title=title', '--id', 'ref', '--relax', '--json'], c);
    assert.equal(r.code, 3, r.stdout); assert.equal(r.json.status, 'proposal'); assert.equal(r.json.command, 'import');
    const pid = readdirSync(join(c.dataDir, 'proposals'))[0].replace(/\.json$/, '');
    const store = join(c.dataDir, 'rooms', 'notes.json');
    assert.ok(!existsSync(store), 'nothing is written before approve');
    const piped = cli(['approve', pid, '--decision', 'approve', '--json'], c, {}, { stdin: '' });
    assert.equal(piped.code, 3); assert.ok(codes(piped.json).includes('DF_APPROVE_NOT_OWNER')); assert.ok(!existsSync(store));
    assert.equal(cli(['approve', pid, '--decision', 'approve', '--json'], c, { CLAUDECODE: '1' }).code, 3);
    writeFileSync(join(dir, 'wrong.token'), 'wrong\n');
    assert.ok(codes(cli(['approve', pid, '--decision', 'approve', '--token-file', join(dir, 'wrong.token'), '--json'], c).json).includes('DF_APPROVE_TOKEN_INVALID'));
    if (process.platform !== 'win32') {
      chmodSync(token, 0o644);
      assert.ok(codes(cli(['approve', pid, '--decision', 'approve', '--token-file', token, '--json'], c).json).includes('DF_APPROVE_TOKEN_FILE_MODE'));
      chmodSync(token, 0o600);
    }
    assert.ok(!existsSync(store), 'every refusal left the store untouched');
    const ok = cli(['approve', pid, '--decision', 'approve', '--token-file', token, '--json'], c, { CLAUDECODE: '1' });
    assert.equal(ok.code, 0, ok.stdout); assert.equal(ok.json.status, 'approved'); assert.equal(ok.json.owner_decision.state, 'approved');
    assert.match(ok.json.owner_decision.reviewed_summary_digest, /^sha256:/);
    assert.equal(readJson(store).count, 6);
    assert.ok(existsSync(join(c.dotDir, 'receipts', `${ok.json.receipt_id}.json`)));
    const again = cli(['approve', pid, '--decision', 'approve', '--json'], c, { DOTFIELD_OWNER_TOKEN_FILE: token });
    assert.equal(again.code, 0); assert.match(again.json.next_action, /already approved/);
    const conflict = cli(['approve', pid, '--decision', 'reject', '--token-file', token, '--json'], c);
    assert.equal(conflict.code, 3); assert.ok(codes(conflict.json).includes('DF_PROPOSAL_ALREADY_DECIDED')); assert.equal(readJson(store).count, 6);
    const unknown = cli(['approve', 'prop_20261001T101500Z_000000', '--decision', 'approve', '--token-file', token, '--json'], c);
    assert.equal(unknown.code, 3); assert.ok(codes(unknown.json).includes('DF_APPROVE_TARGET_UNKNOWN'));
    assert.equal(cli(['approve', '--list', '--json'], c).code, 0);
    writeFileSync(store, '{not json');
    assert.equal(cli(['import', 'records', 'notes', join(FIX, 'notes.csv'), '--map', 'Title=title', '--id', 'ref', '--relax', '--json'], c).code, 4, 'a corrupt store is a storage fault');
  });
});

test('plan == run: a dry run ends awaiting_owner (exit 3); approving the run id writes the idea note; an unknown provider exits 5', async () => {
  await withTmp(async (dir) => {
    const { c, token } = await ready(dir);
    const task = 'summarize the calibration note into a journal entry';
    const p = cli(['plan', task, '--json'], c);
    assert.equal(p.code, 0, p.stdout); assert.match(p.json.next_action, /Specialists scribe; challenger skeptic/);
    const r = cli(['run', task, '--provider', 'dry', '--budget', '20000', '--json'], c);
    assert.equal(r.code, 3, r.stdout); assert.equal(r.json.status, 'awaiting_owner'); assert.equal(r.json.provider.adapter, 'dry');
    const runId = readdirSync(join(c.dotDir, 'runs'))[0];
    for (const f of ['run.json', 'run.md', 'receipt.json']) assert.ok(existsSync(join(c.dotDir, 'runs', runId, f)));
    assert.deepEqual(readJson(join(c.dotDir, 'runs', runId, 'run.json')).routing.specialists, ['scribe']);
    const a = cli(['approve', runId, '--decision', 'approve', '--token-file', token, '--json'], c);
    assert.equal(a.code, 0, a.stdout); assert.equal(readJson(join(c.dotDir, 'runs', runId, 'run.json')).status, 'approved');
    assert.ok(readJson(join(c.dataDir, 'rooms', 'notes.json')).records.some((x) => x.note_id.startsWith('run-')));
    const bad = cli(['run', 'plan the week', '--provider', 'nope', '--json'], c);
    assert.equal(bad.code, 5); assert.ok(codes(bad.json).includes('DF_PROVIDER_UNKNOWN_ADAPTER'));
  });
});

test('connect --between: a meet scene with candidates, never persisted; --accept proposes pairs that approve records in boundaries.json', async () => {
  await withTmp(async (dir) => {
    const { c, token } = await ready(dir);
    const r = cli(['connect', '--between', 'notes,papers', '-o', 'meet.json', '--json'], c);
    assert.equal(r.code, 0, r.stdout);
    const scene = readJson(join(c.root, 'meet.json'));
    assert.equal(scene.kind, 'meet'); assert.ok(scene.edges.some((e) => e.kind === 'candidate')); assert.match(scene.projected.mac, /^hmac-sha256:/);
    assert.ok(!existsSync(join(c.dataDir, 'boundaries.json')));
    assert.equal(cli(['render', 'meet.json', '--json'], c).code, 0, 'the meet scene renders');
    const acc = cli(['connect', '--between', 'notes,papers', '--accept', 'all', '--json'], c);
    assert.equal(acc.code, 3, acc.stdout); assert.equal(acc.json.status, 'proposal');
    const pid = readdirSync(join(c.dataDir, 'proposals')).map((f) => f.replace(/\.json$/, '')).find((id) => readJson(join(c.dataDir, 'proposals', `${id}.json`)).kind === 'pair');
    assert.equal(cli(['approve', pid, '--decision', 'approve', '--token-file', token, '--json'], c).code, 0);
    assert.ok(readJson(join(c.dataDir, 'boundaries.json')).pairs.length > 0);
    assert.equal(cli(['connect', '--between', 'notes', '--json'], c).code, 2);
  });
});

test('two centers: share rule → approve → share project signs a file the receiver imports after add person; revoke stops emits', async () => {
  await withTmp(async (dir) => {
    const g = await ready(join(dir, 'grantor'), { owner: 'sol' });
    const r = await ready(join(dir, 'receiver'), { owner: 'ada' });
    const solKey = generateKeyPair();
    writeKeyFile(join(g.c.dataDir, 'keys', 'sol.ed25519'), solKey.privateKey);
    assert.ok(loadKey(g.c.dataDir, 'sol').ok);
    const adaKey = keyFromSeed('cli-test-ada').publicKey;
    writeJson(join(dir, 'ada.json'), { person_id: 'ada', kind: 'contact', display_name: 'Ada', handles: [], disciplines: [], public_key: adaKey, key_id: 'ada-k1' });
    writeJson(join(dir, 'rule.json'), { ...rule('ada'), grantor_person_id: 'sol' });
    const unknownReceiver = cli(['share', 'rule', join(dir, 'rule.json'), '--json'], g.c);
    assert.equal(unknownReceiver.code, 2); assert.ok(codes(unknownReceiver.json).includes('DF_SHARE_RECEIVER_UNKNOWN'), 'a rule needs a pinned receiver');
    assert.equal(cli(['add', 'person', join(dir, 'ada.json'), '--fingerprint', fingerprint(adaKey), '--json'], g.c).code, 0);
    assert.equal(cli(['share', 'rule', join(dir, 'rule.json'), '--json'], g.c).code, 3, 'a new rule waits for the owner');
    const before = cli(['share', 'project', '--rule', 'rule-01', '--json'], g.c);
    assert.equal(before.code, 2, 'nothing is emitted before approve'); assert.ok(!existsSync(join(g.c.dataDir, 'projections')));
    assert.equal(cli(['approve', 'rule-01', '--decision', 'approve', '--token-file', g.token, '--json'], g.c).code, 0);
    assert.equal(readJson(join(g.c.centerDir, 'people', 'share-rules.json')).rules[0].state, 'active');
    const emitted = cli(['share', 'project', '--rule', 'rule-01', '--json'], g.c);
    assert.equal(emitted.code, 0, emitted.stdout); assert.equal(emitted.json.release_tag, 'v1.1-provisional');
    const file = join(g.c.dataDir, 'projections', 'out', readdirSync(join(g.c.dataDir, 'projections', 'out'))[0]);
    writeJson(join(dir, 'sol.json'), { person_id: 'sol', kind: 'contact', display_name: 'Sol', handles: [], disciplines: [{ label: 'calibration', source: 'introduced', weight: 0.7 }], public_key: solKey.publicKey, key_id: 'sol-k1' });
    const unpinned = cli(['import', 'projection', file, '--json'], r.c);
    assert.equal(unpinned.code, 2); assert.ok(codes(unpinned.json).includes('DF_OVERLAY_KEY_UNKNOWN'));
    assert.equal(cli(['add', 'person', join(dir, 'sol.json'), '--fingerprint', fingerprint(solKey.publicKey), '--json'], r.c).code, 0);
    const imp = cli(['import', 'projection', file, '--json'], r.c);
    assert.equal(imp.code, 0, imp.stdout); assert.ok(existsSync(join(r.c.dataDir, 'overlays', 'sol.json')));
    const meet = cli(['connect', '--with', 'sol', '--json'], r.c);
    assert.equal(meet.code, 0, meet.stdout); assert.equal(meet.json.release_tag, 'v1.1-provisional');
    assert.ok(readJson(join(r.c.root, meet.json.outputs[0].ref)).groups.some((grp) => grp.kind === 'person'));
    assert.equal(cli(['share', 'revoke', 'rule-01', '--json'], g.c).code, 0);
    assert.equal(readJson(join(g.c.centerDir, 'people', 'share-rules.json')).rules[0].state, 'revoked');
    assert.equal(cli(['share', 'project', '--rule', 'rule-01', '--json'], g.c).code, 3, 'a revoked rule is not active: exit 3');
  });
});

test('import archify/son-graph/spatial-scene write gate-clean scenes; archify sequence and lifecycle render at showcase; export excludes handles; serve --check never prints the token', async () => {
  await withTmp(async (dir) => {
    const { c } = await ready(dir);
    for (const [leaf, file, tag] of [['archify', 'telemetry.archify.json', 'v1.1-provisional'], ['son-graph', 'son-graph.json', 'v1.0'], ['spatial-scene', 'spatial-asset-scene.json', 'v1.0']]) {
      const r = cli(['import', leaf, join(FIX, file), '--json'], c);
      assert.equal(r.code, 0, r.stdout); assert.ok(existsSync(join(c.root, r.json.outputs[0].ref)), leaf);
      assert.equal(r.json.release_tag, tag, `${leaf} is a ${tag} importer (VISION §11 slice 8 tags archify and markdown v1.1)`);
    }
    const md = cli(['import', 'records', 'notes', join(FIX, 'notes-md'), '--json'], c);
    assert.equal(md.code, 3, md.stdout); assert.equal(md.json.status, 'proposal');
    assert.equal(md.json.release_tag, 'v1.1-provisional', 'a folder of markdown goes through the slice-8 markdown-dir importer');
    assert.match(md.json.next_action, /4 record\(s\) from .*notes-md proposed/);
    const csv = cli(['import', 'records', 'notes', join(FIX, 'notes.csv'), '--map', 'Title=title', '--id', 'ref', '--relax', '--json'], c);
    assert.equal(csv.json.release_tag, 'v1.0', 'csv is v1.0');
    for (const file of ['checkout.sequence.archify.json', 'release.lifecycle.archify.json']) {
      const imp = cli(['import', 'archify', join(FIX, file), '--json'], c);
      assert.equal(imp.code, 0, imp.stdout); assert.ok(!codes(imp.json).includes('DF_IMPORT_UNSUPPORTED_DIAGRAM_TYPE'), file);
      const scene = readJson(join(c.root, imp.json.outputs[0].ref));
      assert.ok(!('positions' in scene) && !('routes' in scene), `${file}: the importer leaves layout to lib/layout`);
      const shown = cli(['render', imp.json.outputs[0].ref, join('out', `${file}.html`), '--view', '2d', '--quality', 'showcase', '--json'], c);
      assert.equal(shown.code, 0, `${file} renders at showcase: ${shown.stdout}`);
    }
    patchJson(join(c.centerDir, 'people', 'people.json'), (doc) => { doc.people[0].handles = [`hmac-sha256:${'a'.repeat(64)}`]; });
    const ex = cli(['export', '-o', 'out', '--json'], c);
    assert.equal(ex.code, 0, ex.stdout);
    assert.equal(readJson(join(c.root, 'out', 'rooms', 'notes.json')).count, 4);
    assert.deepEqual(readJson(join(c.root, 'out', 'people', 'people.json')).people[0].handles, []);
    assert.ok(!existsSync(join(c.root, 'out', 'people', 'self-card.json')), 'no self key, no card');
    writeKeyFile(join(c.dataDir, 'keys', 'self.ed25519'), generateKeyPair().privateKey);
    assert.equal(cli(['export', '-o', 'out2', '--json'], c).code, 0);
    const card = readJson(join(c.root, 'out2', 'people', 'self-card.json'));
    assert.equal(card.kind, 'contact'); assert.equal(card.key_id, 'self-k1'); assert.equal(card.ext.fingerprint, fingerprint(card.public_key)); assert.ok(!JSON.stringify(card).includes('PRIVATE KEY'));
    assert.ok(existsSync(join(c.root, 'out', 'export.json')) && existsSync(join(c.root, 'out', 'receipt.json')));
    assert.equal(cli(['export', '--as', 'ada', '--json'], c).code, 3, 'a person scope exports nothing');
    const token = readFileSync(join(c.dataDir, 'keys', 'owner.token'), 'utf8').trim();
    const s = cli(['serve', '--check', '--json'], c);
    assert.equal(s.code, 0, s.stdout); assert.ok(!s.stdout.includes(token) && !s.stderr.includes(token), 'the token is printed only on a TTY');
    const h = cli(['serve', '--check'], c);
    assert.ok(!h.stdout.includes(token));
  });
});
