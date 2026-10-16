// cli-core: bin/dotfield.mjs dispatch, lib/context.mjs, lib/pipeline.mjs and
// the five verbs validate / render / verify / theme / doctor, exercised the
// way an operator would: the real bin spawned on fixtures inside temp dirs.
// Zero network, no provider, one clock (SOURCE_DATE_EPOCH) where bytes matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { ROOT, runCli } from './helpers/cli.mjs';
import { EPOCH_ENV, NOW_ISO, patchJson, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { createStore } from '../lib/store.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { parseArgs, listVerbs } from '../bin/dotfield.mjs';
import { createContext, findRoot } from '../lib/context.mjs';
import { GATE_ORDER, IR_ORDER, parseRoomTarget, runGates } from '../lib/pipeline.mjs';
import { PINNED } from '../lib/rules.mjs';

const EXAMPLE = resolve(ROOT, 'examples', 'scene-graph.json');
const RECEIPT_KEYS = ['receipt_id', 'schema_version', 'command', 'argv', 'generated_at', 'engine_version', 'release_tag', 'engine_digests', 'status', 'ok', 'exit_code', 'maturity', 'scope', 'viewer', 'mode', 'store', 'inputs', 'checks', 'outputs', 'owner_decision', 'blocked_actions', 'provider', 'foreign_spans_digest', 'evidence', 'next_action', 'digest'];
const fails = (r) => r.checks.filter((c) => c.status === 'fail');
const codes = (r) => fails(r).map((c) => c.code);
const renderDirs = (root) => (existsSync(join(root, '.dotfield', 'renders')) ? readdirSync(join(root, '.dotfield', 'renders')).sort() : []);

function publicScene() {
  const scene = readJson(EXAMPLE);
  for (const n of scene.nodes) n.audience = { ...n.audience, privacy_level: 'public' };
  return scene;
}

async function seededCenter(dir) {
  const c = scaffoldCenter(dir);
  mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
  writeFileSync(join(c.dataDir, 'keys', 'session.key'), 'cli-core-test-session-key\n');
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const store = createStore({ room: d.rooms[0], dataDir: c.dataDir, config: c.config, env: process.env, root: c.root });
  await store.write(readJson(c.roomFile('notes', 'examples.json')), { approved: true, now: new Date(NOW_ISO), by: 'test' });
  return c;
}

test('parseArgs: verb, positionals, --flag value, --flag=value, boolean flags, --no-x, --json, --as', () => {
  const a = parseArgs(['render', 'room:notes/graph', 'out.html', '--view', 'all', '--for=ada', '--i-know', '--no-embed-three', '--json', '--as', 'ada', '--quality', 'showcase']);
  assert.equal(a.verb, 'render');
  assert.deepEqual(a._, ['room:notes/graph', 'out.html']);
  assert.deepEqual(a.flags, { view: 'all', for: 'ada', 'i-know': true, 'embed-three': false, json: true, as: 'ada', quality: 'showcase' });
  assert.equal(a.json, true);
  assert.equal(a.as, 'ada');
  assert.deepEqual(parseArgs(['validate', 'all']).flags, {});
  assert.deepEqual(parseArgs(['x', '--', '--not-a-flag'])._, ['--not-a-flag']);
  const verbs = listVerbs();
  for (const v of ['doctor', 'render', 'theme', 'validate', 'verify']) assert.ok(verbs.includes(v), `cli-core verb ${v} is installed`);
  assert.equal(verbs.length, PINNED.cli_verbs, 'cli-core ships five verbs; cli-full adds the rest to reach PINNED.cli_verbs');
  assert.deepEqual(parseRoomTarget('room:notes/graph'), { room: 'notes', view: 'graph' });
  assert.equal(parseRoomTarget('notes.json'), null);
});

test('help exits 0 and lists the installed verbs; an unknown verb exits 1 with an error receipt', () => {
  const help = runCli(['help']);
  assert.equal(help.code, 0);
  for (const v of ['validate', 'render', 'verify', 'theme', 'doctor']) assert.match(help.stdout, new RegExp(`^  ${v}`, 'm'));
  const bad = runCli(['frobnicate', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.status, 'error');
  assert.equal(bad.json.exit_code, 1);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.next_action, /unknown verb "frobnicate"/);
  assert.deepEqual(Object.keys(bad.json), RECEIPT_KEYS, 'the §8.4 envelope, every key, in order');
  const refused = runCli(['validate', 'all', '--as', '///', '--json']);
  assert.equal(refused.code, 3, 'an --as that sanitises to nothing is refused (exit 3), never the owner container');
  assert.equal(refused.json.status, 'refused');
  assert.ok(codes(refused.json).includes('DF_STORE_SCOPE_EMPTY_UID'));
});

test('context: root discovery, SOURCE_DATE_EPOCH clock, viewer from --as, tokens source', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const nested = join(c.root, 'center', 'rooms', 'notes');
    assert.equal(findRoot(nested), c.root);
    assert.equal(findRoot(nested, { DOTFIELD_ROOT: dir }), dir, 'DOTFIELD_ROOT wins over the walk');
    assert.equal(createContext({ cwd: ROOT, env: { DOTFIELD_ROOT: c.root } }).root, c.root);
    const parent = resolve(ROOT, '..');
    if (!existsSync(join(parent, 'center', 'center.config.json'))) {
      assert.equal(findRoot(parent, {}), ROOT, 'run from the parent of the engine folder (the nested case) the root is the engine folder, center or not: init never writes a center/ beside it');
    }
    assert.equal(findRoot(dir, {}), resolve(dir), 'a bare folder that is not an ancestor of the engine is its own root');
    const ctx = createContext({ cwd: nested, env: { ...process.env, ...EPOCH_ENV }, as: 'Ada' });
    assert.equal(ctx.root, c.root);
    assert.equal(ctx.now.toISOString(), '2026-10-01T10:15:00.000Z');
    assert.equal(ctx.viewer, 'ada');
    assert.equal(ctx.scope, 'person_ada');
    assert.equal(ctx.config.center.name, 'Minimal center');
    assert.equal(ctx.sessionKey(), null);
    assert.equal(ctx.tokens().ref, 'renderers/tokens.css');
    assert.equal(ctx.relRef(join(c.root, 'center', 'brand.json')), 'center/brand.json');
    await withTmp(async (elsewhere) => {
      const bare = createContext({ cwd: elsewhere, env: process.env });
      assert.equal(bare.root, elsewhere);
      assert.equal(bare.config, null);
      assert.equal(bare.viewer, 'self');
      assert.equal(bare.scope, 'owner');
    });
    const inside = createContext({ cwd: c.root, env: process.env });
    assert.equal(inside.hasCenter, true);
    assert.equal(inside.config !== null, true);
  });
});

test('pipeline: runGates runs schema → topology → privacy → layout → render and stops at the first blocking failure', () => {
  const clean = runGates(readJson(EXAMPLE), { viewer: 'self', views: '2d' }, GATE_ORDER);
  assert.equal(clean.blocked, false);
  assert.deepEqual(clean.ran, [...GATE_ORDER]);
  assert.equal(clean.scene.laid_out, true);
  assert.equal(clean.checks.filter((c) => c.code === 'DF_RENDER_UNPROJECTED').length, 1, 'a repeated pass entry is deduped');
  const broken = readJson(EXAMPLE);
  broken.nodes = broken.nodes.slice(1);
  const r = runGates(broken, { viewer: 'self' }, IR_ORDER);
  assert.equal(r.blocked, true);
  assert.equal(r.stopped_at, 'topology');
  assert.ok(r.checks.some((c) => c.code === 'DF_IR_DANGLING_EDGE' && c.status === 'fail' && c.repair));
  assert.ok(!r.checks.some((c) => c.gate === 'layout'), 'the layout gate never ran');
});

test('validate: a shipped scene exits 0 with the --json envelope; a dangling edge exits 2 with a repair line', async () => {
  const ok = runCli(['validate', EXAMPLE, '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.status, 'read');
  assert.equal(ok.json.maturity, 'local_beta');
  assert.ok(ok.json.checks.some((c) => c.code === 'DF_IR_DANGLING_EDGE' && c.status === 'pass'));
  assert.ok(ok.json.checks.some((c) => c.gate === 'layout') && ok.json.checks.some((c) => c.gate === 'render'));
  assert.deepEqual(ok.json.outputs, []);
  await withTmp(async (dir) => {
    const broken = readJson(EXAMPLE);
    broken.nodes = broken.nodes.slice(1);
    writeJson(join(dir, 'broken.json'), broken);
    const r = runCli(['validate', 'broken.json', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.json.status, 'blocked');
    const f = fails(r.json).find((c) => c.code === 'DF_IR_DANGLING_EDGE');
    assert.ok(f && f.blocking && f.path && f.repair, JSON.stringify(fails(r.json)));
    const human = runCli(['validate', 'broken.json'], { cwd: dir });
    assert.equal(human.code, 2);
    assert.match(human.stderr, /FAIL DF_IR_DANGLING_EDGE/);
    assert.match(human.stderr, /repair:/);
    writeFileSync(join(dir, 'bad.json'), '{not json');
    assert.equal(runCli(['validate', 'bad.json', '--json'], { cwd: dir }).json.checks[0].code, 'DF_SCHEMA_TYPE');
    assert.equal(runCli(['validate', 'nope', '--json'], { cwd: dir }).code, 1);
  });
});

test('validate all writes .dotfield/registry.json, keeps DF_ROOM_MATURITY_UNPROVEN non-blocking and indexes its receipt', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const r = runCli(['validate', 'all', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'written');
    assert.equal(r.json.maturity, 'local_beta');
    const unproven = fails(r.json).find((x) => x.code === 'DF_ROOM_MATURITY_UNPROVEN');
    assert.ok(unproven && unproven.blocking === false);
    const registry = readJson(join(c.dotDir, 'registry.json'));
    assert.deepEqual(registry.rooms.map((x) => x.id), ['notes']);
    assert.equal(r.json.outputs[0].ref, '.dotfield/registry.json');
    assert.ok(existsSync(join(c.dotDir, 'receipts', `${r.json.receipt_id}.json`)), 'the receipt index copy');
    const room = runCli(['validate', 'notes', '--json'], { cwd: c.root });
    assert.equal(room.code, 0);
    assert.equal(room.json.status, 'read');
    assert.equal(room.json.mode, 'proposal_only');
    assert.equal(room.json.inputs.length, 4);
    patchJson(c.roomFile('notes', 'room.json'), (doc) => { doc.record.label_field = 'nope'; });
    const broken = runCli(['validate', 'all', '--json'], { cwd: c.root });
    assert.equal(broken.code, 2);
    assert.deepEqual(readJson(join(c.dotDir, 'registry.json')).invalid.map((x) => x.id), ['notes']);
  });
});

test('render: the example yields out.html + out.svg + scene.json + receipt.json, flags a self view outside .dotfield/, and is byte-reproducible', async () => {
  await withTmp(async (dir) => {
    const r = runCli(['render', EXAMPLE, 'out.html', '--view', '2d', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'written');
    assert.equal(r.json.release_tag, 'v1.0');
    assert.equal(r.json.viewer, 'self');
    assert.equal(r.json.scope, 'owner');
    assert.equal(r.json.evidence.browser, 'not_captured');
    const dirs = renderDirs(dir);
    assert.equal(dirs.length, 1);
    assert.match(dirs[0], /^graph-experiments-graph-20261001T101500Z$/);
    const folder = join(dir, '.dotfield', 'renders', dirs[0]);
    assert.deepEqual(readdirSync(folder).sort(), ['out.html', 'out.svg', 'receipt.json', 'scene.json']);
    assert.deepEqual(r.json.outputs.map((o) => [o.ref, o.kind, o.embedded_three]), [
      [`.dotfield/renders/${dirs[0]}/out.html`, 'html', false], [`.dotfield/renders/${dirs[0]}/out.svg`, 'svg', undefined],
      [`.dotfield/renders/${dirs[0]}/scene.json`, 'scene', undefined], ['out.html', 'html', false],
    ]);
    assert.equal(readFileSync(join(dir, 'out.html'), 'utf8'), readFileSync(join(folder, 'out.html'), 'utf8'));
    assert.equal(readJson(join(folder, 'receipt.json')).receipt_id, r.json.receipt_id);
    const scene = readJson(join(folder, 'scene.json'));
    assert.equal(scene.laid_out, true);
    assert.equal(scene.receipt.receipt_id, r.json.receipt_id);
    const self = fails(r.json).find((c) => c.code === 'DF_RENDER_SELF_VIEW_EXPORTED');
    assert.ok(self && self.blocking === false, 'a self render outside .dotfield/ is flagged, not blocked');
    assert.equal(r.json.ok, true);
    assert.ok(!codes(runCli(['render', EXAMPLE, 'out2.html', '--i-know', '--json'], { cwd: dir }).json).includes('DF_RENDER_SELF_VIEW_EXPORTED'));
    assert.ok(!codes(runCli(['render', EXAMPLE, '--json'], { cwd: dir }).json).includes('DF_RENDER_SELF_VIEW_EXPORTED'), 'the default folder is inside .dotfield/');
    await withTmp(async (other) => {
      const again = runCli(['render', EXAMPLE, 'out.html', '--view', '2d', '--json'], { cwd: other, env: EPOCH_ENV });
      assert.equal(again.json.receipt_id, r.json.receipt_id, 'same epoch, same inputs → same id');
      assert.equal(readFileSync(join(other, 'out.html'), 'utf8'), readFileSync(join(dir, 'out.html'), 'utf8'), 'same bytes');
      assert.equal(again.json.outputs[0].digest, r.json.outputs[0].digest);
    });
    assert.equal(runCli(['render', EXAMPLE, '--quality', 'bogus', '--json'], { cwd: dir }).json.checks[0].code, 'DF_SCHEMA_ENUM');
    assert.equal(runCli(['render', 'missing.json', '--json'], { cwd: dir }).code, 2);
  });
});

test('render --view all without renderers/three.mjs: 2D succeeds, the receipt is v1.1-provisional and says why', async () => {
  await withTmp(async (dir) => {
    const r = runCli(['render', EXAMPLE, '--view', 'all', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.release_tag, 'v1.1-provisional');
    const html = readFileSync(join(dir, '.dotfield', 'renders', renderDirs(dir)[0], 'out.html'), 'utf8');
    assert.match(html, /data-view="3d"/);
    if (existsSync(resolve(ROOT, 'renderers', 'three.mjs'))) return;
    const disabled = fails(r.json).find((c) => c.code === 'DF_RENDER_VIEW_DISABLED');
    assert.ok(disabled && disabled.blocking === false && /three\.mjs/.test(disabled.message), JSON.stringify(fails(r.json)));
    assert.match(html, /renderer not installed/);
  });
});

test('render --for ada: projected through lib/project.mjs, embedded by default; refused without a session key', async () => {
  await withTmp(async (dir) => {
    const c = await seededCenter(dir);
    writeJson(join(c.root, 'public.json'), publicScene());
    const r = runCli(['render', 'public.json', 'ada.html', '--view', '2d', '--for', 'ada', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json && fails(r.json)));
    assert.equal(r.json.viewer, 'ada');
    assert.equal(r.json.scope, 'owner');
    assert.equal(r.json.outputs[0].embedded_three, true, 'embed is the default for anyone but self');
    assert.ok(r.json.checks.some((x) => x.code === 'DF_RENDER_UNPROJECTED' && x.status === 'pass'));
    const scene = readJson(join(c.root, '.dotfield', 'renders', renderDirs(c.root)[0], 'scene.json'));
    assert.equal(scene.viewer.mode, 'person');
    assert.equal(scene.projected.viewer, 'ada');
    assert.match(scene.projected.mac, /^hmac-sha256:[0-9a-f]{64}$/);
    assert.match(readFileSync(join(c.root, 'ada.html'), 'utf8'), /data-viewer="ada"/);
    assert.ok(!codes(r.json).includes('DF_RENDER_SELF_VIEW_EXPORTED'));
    const plain = runCli(['render', 'public.json', '--for', 'ada', '--no-embed-three', '--json'], { cwd: c.root });
    assert.equal(plain.json.outputs[0].embedded_three, false);
  });
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    writeJson(join(c.root, 'public.json'), publicScene());
    const r = runCli(['render', 'public.json', '--for', 'ada', '--json'], { cwd: c.root });
    assert.equal(r.code, 2);
    assert.deepEqual(codes(r.json), ['DF_RENDER_UNPROJECTED']);
    assert.match(fails(r.json)[0].path, /session\.key/);
  });
});

test('render room:<id>/<view> goes through the exit door and records mode, store and maturity', async () => {
  await withTmp(async (dir) => {
    const c = await seededCenter(dir);
    const r = runCli(['render', 'room:notes/graph', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json && fails(r.json)));
    assert.equal(r.json.status, 'written');
    assert.equal(r.json.mode, 'proposal_only');
    assert.deepEqual(r.json.store, { target: 'data/rooms/notes.json', backend: 'file' });
    assert.equal(r.json.maturity, 'local_beta');
    assert.ok(r.json.inputs.some((i) => i.ref === 'center/rooms/notes/room.json') && r.json.inputs.some((i) => i.ref === 'data/rooms/notes.json'));
    assert.match(renderDirs(c.root)[0], /^graph-notes-graph-/);
    const scene = readJson(join(c.root, '.dotfield', 'renders', renderDirs(c.root)[0], 'scene.json'));
    assert.equal(scene.nodes.length, readJson(c.roomFile('notes', 'examples.json')).length);
    assert.equal(scene.projected.by, 'lib/project.mjs');
    const written = join('.dotfield', 'renders', renderDirs(c.root)[0], 'scene.json');
    const restamped = runCli(['validate', written, '--require-projected', '--json'], { cwd: c.root });
    assert.equal(restamped.code, 0, `the laid-out scene carries a stamp that verifies: ${JSON.stringify(restamped.json && fails(restamped.json))}`);
    const missing = runCli(['render', 'room:nope/graph', '--json'], { cwd: c.root });
    assert.equal(missing.code, 2);
    assert.deepEqual(codes(missing.json), ['DF_ROOM_FILE_MISSING']);
    const noView = runCli(['render', 'room:notes/nope', '--json'], { cwd: c.root });
    assert.deepEqual(codes(noView.json), ['DF_ROOM_VIEW_INVALID']);
    assert.match(noView.json.next_action, /Fix the 1 blocking finding/, 'a blocked render carries the repair instruction');
    assert.doesNotMatch(noView.json.next_action, /Open the HTML/, 'no HTML was written, so nothing says to open one');
    assert.doesNotMatch(missing.json.next_action, /Open the HTML/);
    const ir = runCli(['render', 'room:notes/timeline', '--ir-only', '--json'], { cwd: c.root });
    assert.equal(ir.code, 0, JSON.stringify(ir.json && fails(ir.json)));
    assert.deepEqual(ir.json.outputs.map((o) => o.kind), ['scene']);
  });
});

test('verify: a render receipt verifies; a touched output is DF_RECEIPT_DIGEST_MISMATCH (exit 2)', async () => {
  await withTmp(async (dir) => {
    const r = runCli(['render', EXAMPLE, '--json'], { cwd: dir, env: EPOCH_ENV });
    const receiptPath = join('.dotfield', 'renders', renderDirs(dir)[0], 'receipt.json');
    const ok = runCli(['verify', receiptPath, '--json'], { cwd: dir });
    assert.equal(ok.code, 0, JSON.stringify(ok.json && fails(ok.json)));
    assert.equal(ok.json.status, 'read');
    assert.equal(ok.json.maturity, 'local_beta');
    assert.match(ok.json.next_action, new RegExp(r.json.receipt_id));
    assert.ok(ok.json.checks.some((c) => c.code === 'DF_RECEIPT_DIGEST_MISMATCH' && c.status === 'pass'));
    writeFileSync(join(dir, '.dotfield', 'renders', renderDirs(dir)[0], 'out.html'), '<!doctype html><p>edited</p>\n');
    const bad = runCli(['verify', receiptPath, '--json'], { cwd: dir });
    assert.equal(bad.code, 2);
    assert.ok(codes(bad.json).includes('DF_RECEIPT_DIGEST_MISMATCH'));
    const gone = runCli(['verify', 'nothing.json', '--json'], { cwd: dir });
    assert.equal(gone.code, 2);
    assert.deepEqual(codes(gone.json), ['DF_RECEIPT_UNREADABLE']);
  });
});

test('theme: brand.json → tokens.generated.css with the ledger; a failing pair is refused with the nearest passing value; renders pick the generated css up', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const r = runCli(['theme', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json && fails(r.json)));
    assert.equal(r.json.status, 'written');
    assert.deepEqual(r.json.outputs.map((o) => [o.ref, o.kind]), [['center/brand/tokens.generated.css', 'css']]);
    const css = readFileSync(join(c.centerDir, 'brand', 'tokens.generated.css'), 'utf8');
    assert.match(css, /@df-ledger:start/);
    assert.match(css, /:root\[data-theme="brand"\]/);
    assert.ok(r.json.checks.some((x) => x.code === 'DF_THEME_CONTRAST' && x.status === 'pass'));
    const again = runCli(['theme', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(again.json.outputs[0].digest, r.json.outputs[0].digest, 'deterministic');
    const render = runCli(['render', EXAMPLE, '--json'], { cwd: c.root });
    assert.equal(render.code, 0, JSON.stringify(render.json && fails(render.json)));
    assert.match(readFileSync(join(c.root, '.dotfield', 'renders', renderDirs(c.root)[0], 'out.html'), 'utf8'), /:root\[data-theme="brand"\]/);
    patchJson(join(c.centerDir, 'brand.json'), (b) => { b.accent = '#9ec5ff'; });
    const bad = runCli(['theme', '--json'], { cwd: c.root });
    assert.equal(bad.code, 2);
    const contrast = fails(bad.json).find((x) => x.code === 'DF_THEME_CONTRAST');
    assert.ok(contrast && contrast.blocking && /nearest passing value #[0-9a-f]{6}/.test(contrast.message), JSON.stringify(fails(bad.json)));
    assert.equal(readFileSync(join(c.centerDir, 'brand', 'tokens.generated.css'), 'utf8'), css, 'nothing is rewritten on a refusal');
    patchJson(join(c.centerDir, 'brand.json'), (b) => { b.accent = 'blue'; });
    assert.ok(codes(runCli(['theme', '--json'], { cwd: c.root }).json).includes('DF_SCHEMA_PATTERN'));
  });
});

test('doctor: node version, provider, SDK, vendor, manifest, keys, migrations and store target in one read receipt', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const r = runCli(['doctor', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json && fails(r.json)));
    assert.equal(r.json.status, 'read');
    const by = Object.fromEntries(r.json.checks.map((x) => [x.code, x]));
    assert.equal(by.DF_ENGINE_NODE_VERSION.status, 'pass');
    assert.equal(by.DF_ENGINE_NODE_VERSION.blocking, true);
    assert.equal(by.DF_PROVIDER_UNAVAILABLE.status, 'pass', 'the dry provider is always available');
    assert.ok(by.DF_MCP_SDK_MISSING && by.DF_MCP_SDK_MISSING.blocking === false);
    assert.ok(by.DF_ENGINE_VENDOR_MISSING && by.DF_ENGINE_VENDOR_HASH_MISMATCH);
    assert.equal(by.DF_ENGINE_MIGRATION_PENDING.status, 'pass');
    assert.ok(by.DF_ENGINE_MODIFIED && by.DF_ENGINE_MODIFIED.blocking === false);
    const keys = fails(r.json).find((x) => x.code === 'DF_ENGINE_KEYS_MISSING');
    assert.ok(keys && keys.blocking === false && /session\.key/.test(keys.message));
    assert.deepEqual(r.json.store, { target: 'data/rooms', backend: 'file' });
    assert.deepEqual(r.json.provider, { adapter: 'dry', model: null });
    assert.ok(fails(r.json).every((x) => x.blocking === false));
    mkdirSync(join(c.dataDir, 'keys'), { recursive: true });
    for (const f of ['session.key', 'owner.token', 'handle.salt', 'self.ed25519']) writeFileSync(join(c.dataDir, 'keys', f), 'x\n');
    assert.ok(!codes(runCli(['doctor', '--json'], { cwd: c.root }).json).includes('DF_ENGINE_KEYS_MISSING'));
    patchJson(c.configPath, (cfg) => { cfg.provider.adapter = 'anthropic'; });
    const anth = runCli(['doctor', '--json'], { cwd: c.root, env: { ANTHROPIC_API_KEY: '' } });
    assert.equal(anth.code, 0, 'doctor reports, it does not exit 5');
    assert.ok(codes(anth.json).includes('DF_PROVIDER_UNAVAILABLE'));
    const fetched = runCli(['doctor', '--fetch-vendor', '--json'], { cwd: c.root });
    assert.equal(fetched.code, 0);
    if (!existsSync(resolve(ROOT, 'scripts', 'fetch-vendor.mjs'))) assert.ok(fails(fetched.json).some((x) => x.code === 'DF_ENGINE_VENDOR_MISSING' && /fetch-vendor/.test(x.message)));
  });
  await withTmp(async (dir) => {
    const bare = runCli(['doctor', '--json'], { cwd: dir });
    assert.equal(bare.code, 0, 'no center is a finding, not a crash');
    assert.match(bare.json.next_action, /no center here/);
  });
});
