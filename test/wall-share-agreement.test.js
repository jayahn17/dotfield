// VISION §7.5: server/wall.mjs and lib/share.mjs agree on the private set
// through lib/privacy-levels.mjs. This file fails if either side defines its
// own levels, if the wall admits remotely what the projector withholds, or if
// the wall stops failing closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as levels from '../lib/privacy-levels.mjs';
import * as share from '../lib/share.mjs';
import * as wall from '../server/wall.mjs';
import { readRecords } from '../lib/project.mjs';
import { imports } from './helpers/scan.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { NOW, cloneRoom, scaffoldCenter } from './helpers/center.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { propose, decide } from '../lib/proposals.mjs';

const SRC = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
/** A fake request: loopback peer and a loopback Host unless the case says otherwise (a browser always sends Host). */
const req = ({ peer = '127.0.0.1', headers = {} } = {}) => ({ socket: peer === null ? undefined : { remoteAddress: peer }, headers: { host: '127.0.0.1:4100', ...headers } });
const LOCAL = req();
const PROXIED = req({ headers: { 'x-forwarded-for': '203.0.113.9' } });
const OFF_BOX = req({ peer: '198.51.100.7' });
const NO_SOCKET = req({ peer: null });
/** DNS rebinding: a loopback peer with no X-Forwarded-For whose Host is the attacker's hostname. */
const REBOUND = req({ headers: { host: 'notes.attacker-controlled.test' } });

test('one private set: the wall, the projector and privacy-levels hold the same frozen object', () => {
  assert.equal(wall.PRIVATE_LEVELS, levels.PRIVATE_SET, 'wall === privacy-levels');
  assert.equal(share.PRIVATE_LEVELS, levels.PRIVATE_SET, 'share === privacy-levels');
  assert.equal(wall.PRIVATE_LEVELS, share.PRIVATE_LEVELS, 'wall === share');
  assert.ok(Object.isFrozen(wall.PRIVATE_LEVELS));
  assert.deepEqual([...wall.PRIVATE_LEVELS].sort(), ['blocked', 'private', 'sensitive']);
  for (const level of levels.LEVELS) assert.equal(wall.levelIsPrivate(level), share.PRIVATE_LEVELS.has(level), level);
  assert.equal(wall.levelIsPrivate('secret'), true, 'an unknown level is private');
});

test('neither side defines its own level list: both import lib/privacy-levels.mjs and name no level array', () => {
  for (const rel of ['server/wall.mjs', 'lib/share.mjs']) {
    const text = SRC(rel);
    assert.ok(imports(text).some((s) => /(^|\/)privacy-levels\.mjs$/.test(s)), `${rel} imports lib/privacy-levels.mjs`);
    assert.ok(!/\[\s*['"]public['"]\s*,\s*['"]private['"]/.test(text), `${rel} does not spell out the level order`);
    assert.ok(!/new Set\(\s*\[\s*['"](?:private|sensitive|blocked)['"]/.test(text), `${rel} does not build its own private set`);
  }
  assert.ok(!imports(SRC('server/wall.mjs')).some((s) => /(^|\/)(store|project|share)\.mjs$/.test(s)), 'the wall reads no store and projects nothing');
});

test('exposure: self carries every level, a person at least private, the public viewer public; a non-public field lifts the level', () => {
  const room = { manifest: { id: 'notes', privacy_mode: 'synthetic_data', record: { public_fields: ['title', 'tags'], default_privacy_level: 'private' } } };
  assert.equal(wall.exposure({ room, viewer: 'self' }), 'blocked');
  assert.equal(wall.exposure({ room, viewer: { person_id: 'self' } }), 'blocked');
  assert.equal(wall.exposure({ room, viewer: 'owner-1', ownerId: 'owner-1' }), 'blocked', 'the owner id is self');
  assert.equal(wall.exposure({ room, viewer: 'ada' }), 'private');
  assert.equal(wall.exposure({ room, viewer: 'public' }), 'public');
  assert.equal(wall.exposure({ room, viewer: 'public', fields: ['title'] }), 'public');
  assert.equal(wall.exposure({ room, viewer: 'public', fields: ['body'] }), 'private');
  const sensitive = { manifest: { ...room.manifest, record: { ...room.manifest.record, default_privacy_level: 'sensitive' } } };
  assert.equal(wall.exposure({ room: sensitive, viewer: 'public', fields: ['body'] }), 'sensitive');
  assert.equal(wall.exposure({ room: null, viewer: 'public' }), 'public');
  for (const v of ['self', 'ada', 'public']) assert.equal(wall.levelIsPrivate(wall.exposure({ room, viewer: v })), v !== 'public');
});

test('local means loopback AND no X-Forwarded-For; a request with no socket is remote', () => {
  assert.equal(wall.isLocalRequest(LOCAL), true);
  assert.equal(wall.isLocalRequest(req({ peer: '::1' })), true);
  assert.equal(wall.isLocalRequest(req({ peer: '::ffff:127.0.0.1' })), true);
  assert.equal(wall.isLocalRequest(PROXIED), false, 'the header clause is the load-bearing half');
  assert.equal(wall.isLocalRequest(OFF_BOX), false);
  assert.equal(wall.isLocalRequest(NO_SOCKET), false);
  assert.equal(wall.isLocalRequest(null), false);
  // The Host clause: a rebound hostname is never local, every loopback spelling is, an absent Host is not.
  assert.equal(wall.isLocalRequest(REBOUND), false, 'DNS rebinding: loopback peer, no X-Forwarded-For, foreign Host');
  for (const host of ['localhost:4100', 'LOCALHOST', '127.0.0.1', '[::1]:4100', '[::ffff:127.0.0.1]:4100']) assert.equal(wall.isLocalRequest(req({ headers: { host } })), true, host);
  for (const host of ['127.0.0.1.attacker.test', 'localhost.attacker.test', '[::2]:4100', '']) assert.equal(wall.isLocalRequest(req({ headers: { host } })), false, host || '(empty)');
  assert.equal(wall.isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false, 'no Host header is not loopback');
  assert.equal(wall.hostAuthority(req({ headers: { host: '[::1]:4100' } })), '[::1]');
  assert.equal(wall.hostAuthority(req({ headers: { host: 'Example.TEST:80' } })), 'example.test');
  assert.equal(wall.hostAuthority({ headers: {} }), '');
  assert.equal(wall.hasForwardedFor(req({ headers: { 'x-forwarded-for': '  ' } })), false, 'an empty header is no header');
});

test('the wall fails closed with nothing configured and opens reads only under DOTFIELD_TRUSTED_PROXY_WALL=1', () => {
  const synthetic = { manifest: { id: 'notes', privacy_mode: 'synthetic_data', record: { public_fields: ['title'], default_privacy_level: 'private' } } };
  const live = { manifest: { ...synthetic.manifest, id: 'diary', privacy_mode: 'private_live' } };
  const pass = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.status, 200); assert.equal(r.check.status, 'pass'); };
  const refused = (r, re) => { assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.check.code, 'DF_SERVER_WALL_REFUSED'); assert.equal(r.check.blocking, true); if (re) assert.match(r.check.message, re); };
  pass(wall.checkWall({ req: LOCAL, room: live, viewer: 'self' }));
  pass(wall.checkWall({ req: LOCAL, room: live, viewer: 'self', ownerOnly: true, env: {} }));
  for (const remote of [PROXIED, OFF_BOX, NO_SOCKET, null]) {
    pass(wall.checkWall({ req: remote, room: synthetic, viewer: 'public' }));
    refused(wall.checkWall({ req: remote, room: synthetic, viewer: 'self' }), /private level \(blocked\)/);
    refused(wall.checkWall({ req: remote, room: synthetic, viewer: 'ada' }), /private level \(private\)/);
    refused(wall.checkWall({ req: remote, room: live, viewer: 'public' }), /private_live/);
    refused(wall.checkWall({ req: remote, room: synthetic, viewer: 'public', ownerOnly: true }), /owner-only/);
    refused(wall.checkWall({ req: remote, room: synthetic, viewer: 'public', fields: ['body'] }), /private level/);
    refused(wall.checkWall({ req: remote, room: null, viewer: 'self' }));
  }
  assert.match(wall.checkWall({ req: PROXIED, room: live, viewer: 'self' }).check.message, /behind X-Forwarded-For/);
  const rebound = wall.checkWall({ req: REBOUND, room: synthetic, viewer: 'self' });
  assert.equal(rebound.ok, false, 'a rebound tab never reads as the owner');
  assert.equal(rebound.local, false);
  assert.match(rebound.check.message, /Host "notes\.attacker-controlled\.test" \(not a loopback authority\)/);
  pass(wall.checkWall({ req: REBOUND, room: synthetic, viewer: 'public' }), 'what a rebound tab may read is exactly the public projection');
  const trusted = { DOTFIELD_TRUSTED_PROXY_WALL: '1' };
  pass(wall.checkWall({ req: PROXIED, room: live, viewer: 'self', env: trusted }));
  pass(wall.checkWall({ req: OFF_BOX, room: synthetic, viewer: 'ada', env: trusted, ownerOnly: true }));
  for (const value of ['0', '', 'no', 'false', undefined]) refused(wall.checkWall({ req: PROXIED, room: live, viewer: 'public', env: { DOTFIELD_TRUSTED_PROXY_WALL: value } }));
  assert.equal(wall.trustedProxyWall({ DOTFIELD_TRUSTED_PROXY_WALL: 'yes' }), true);
  assert.equal(wall.trustedProxyWall({}), false);
  assert.equal(wall.trustedProxyWall(undefined), false);
});

test('the decide guard names every missing piece and never the token', () => {
  const token = 'owner-token-for-guard-test';
  const base = { 'content-type': 'application/json; charset=utf-8', 'x-dotfield-owner': token };
  const ok = wall.checkDecideGuard({ req: req({ headers: base }), token });
  assert.deepEqual([ok.ok, ok.status, ok.check.status], [true, 200, 'pass']);
  assert.equal(wall.checkDecideGuard({ req: req({ headers: { ...base, 'sec-fetch-site': 'same-origin' } }), token }).ok, true);
  assert.equal(wall.checkDecideGuard({ req: req({ headers: { ...base, 'sec-fetch-site': 'none' } }), token }).ok, true, 'a typed URL or bookmark');
  const cases = [
    [{ headers: { 'content-type': 'application/json' } }, /X-Dotfield-Owner is absent/],
    [{ headers: { ...base, 'content-type': 'text/plain' } }, /Content-Type is "text\/plain"/],
    [{ headers: { ...base, 'content-type': 'multipart/form-data; boundary=x' } }, /multipart\/form-data/],
    [{ headers: { 'x-dotfield-owner': token } }, /Content-Type is absent/],
    [{ headers: { ...base, 'sec-fetch-site': 'cross-site' } }, /Sec-Fetch-Site is "cross-site"/],
    [{ headers: { ...base, 'sec-fetch-site': 'same-site' } }, /"same-site"/],
    [{ headers: { ...base, 'x-forwarded-for': '203.0.113.9' } }, /X-Forwarded-For is present/],
    [{ headers: { ...base, host: 'notes.attacker-controlled.test' } }, /Host is "notes\.attacker-controlled\.test", not 127\.0\.0\.1, localhost or \[::1\]/],
    [{ headers: { ...base, host: '' } }, /Host is "absent"/],
    [{ peer: '198.51.100.7', headers: base }, /not loopback/],
    [{ headers: { ...base, 'x-dotfield-owner': `${token}!` } }, /does not match/],
    [{ headers: { ...base, 'x-dotfield-owner': token.slice(0, -1) } }, /does not match/],
  ];
  for (const [shape, re] of cases) {
    const r = wall.checkDecideGuard({ req: req(shape), token });
    assert.equal(r.ok, false, re.source);
    assert.equal(r.status, 403);
    assert.equal(r.check.code, 'DF_SERVER_DECIDE_REFUSED');
    assert.match(r.check.message, re);
    assert.ok(!r.check.message.includes(token), 'the token value is never written out');
  }
  const noToken = wall.checkDecideGuard({ req: req({ headers: base }), token: null });
  assert.match(noToken.check.message, /no owner token is on disk/);
  const everything = wall.checkDecideGuard({ req: req({ peer: '198.51.100.7', headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '1.1.1.1' } }), token });
  assert.ok(everything.reasons.length >= 5, 'every reason is listed, not only the first');
  assert.equal(wall.sameSecret('abc', 'abc'), true);
  assert.equal(wall.sameSecret('abc', 'abd'), false);
  assert.equal(wall.sameSecret('', ''), false, 'an empty expected token matches nothing');
  assert.equal(wall.sameSecret(undefined, 'x'), false);
  assert.equal(wall.mediaType(' Application/JSON ; charset=utf-8'), 'application/json');
  assert.equal(wall.isJsonContentType('application/json;charset=utf-8'), true);
  assert.equal(wall.isJsonContentType('application/x-www-form-urlencoded'), false);
});

test('owner token file: readOwnerToken trims and treats an empty file as absent', () => withTmp(async (dir) => {
  const dataDir = join(dir, 'data');
  assert.equal(wall.readOwnerToken(dataDir), null);
  mkdirSync(join(dataDir, 'keys'), { recursive: true });
  writeFileSync(wall.ownerTokenPath(dataDir), '\n');
  assert.equal(wall.readOwnerToken(dataDir), null);
  writeFileSync(wall.ownerTokenPath(dataDir), '  tok-1\n');
  assert.equal(wall.readOwnerToken(dataDir), 'tok-1');
}));

test('agreement over real records: what the wall admits remotely is exactly what the projector gives the public viewer', () => withTmp(async (dir) => {
  const c = scaffoldCenter(dir);
  cloneRoom(c, 'notes', 'pubnotes', (m) => { m.privacy_mode = 'public_demo'; m.record.default_privacy_level = 'public'; });
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const common = { now: NOW, dataDir: c.dataDir, config: c.config, env: {}, root: c.root };
  for (const id of ['notes', 'pubnotes']) {
    const room = d.rooms.find((r) => r.id === id);
    const p = await propose({ ...common, room, records: room.examples, by: 'self' });
    assert.equal(p.ok, true);
    const dec = await decide(p.proposal.proposal_id, { ...common, decision: 'approve', reviewedDigest: p.proposal.summary_digest, rooms: d.rooms });
    assert.equal(dec.ok, true);
  }
  for (const id of ['notes', 'pubnotes']) {
    const room = d.rooms.find((r) => r.id === id);
    for (const viewer of ['self', 'ada', 'public']) {
      const read = await readRecords({ ...common, room, viewer });
      const w = wall.checkWall({ req: PROXIED, room, viewer, env: {} });
      const level = wall.exposure({ room, viewer });
      const leaks = read.visible.filter((v) => share.PRIVATE_LEVELS.has(v.level) || (v.fields && v.fields.some((f) => !room.manifest.record.public_fields.includes(f))));
      if (w.ok) {
        assert.equal(level, 'public');
        assert.deepEqual(leaks, [], `${id}/${viewer}: nothing private rides a response the wall admits`);
      } else {
        assert.ok(share.PRIVATE_LEVELS.has(level) || viewer === 'self', `${id}/${viewer}: the wall refuses because the level is private`);
      }
      if (viewer === 'public') assert.equal(read.visible.every((v) => !share.PRIVATE_LEVELS.has(v.level)), true, 'the projector withholds every private level from the public viewer');
    }
  }
  const notes = d.rooms.find((r) => r.id === 'notes');
  assert.equal((await readRecords({ ...common, room: notes, viewer: 'public' })).records.length, 0, 'private records: the public door is empty');
  assert.equal((await readRecords({ ...common, room: notes, viewer: 'self' })).records.length, 4);
  assert.equal(wall.checkWall({ req: LOCAL, room: notes, viewer: 'self' }).ok, true, 'and the owner at the keyboard reads them');
}));
