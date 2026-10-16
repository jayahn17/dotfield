// The packs and the shipped center (VISION §6, BUILD_CONTRACT §1 "packs"):
// every pack validates (pack.json, rooms, roster, disciplines, theme),
// every example scene is laid out once and gate-clean, boundary vocab is
// backed by disciplines, packs hold no code, drafts are refused by the
// resolver init uses, runs.csv imports cleanly, the research-lab demo
// projections verify, and the center init writes from packs/starter validates
// and renders (the template ships no center/: scripts/pack-init-check.mjs and
// test/cli.test.js state what init writes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { runCli } from './helpers/cli.mjs';
import { EPOCH_ENV, NOW, initCenter } from './helpers/center.mjs';
import { ROOT, EMAIL_RE, HEX_RE, JAY_RE, PHONE_RE, absolutePathRe, absolutePathHits, matchLines } from './helpers/scan.mjs';
import { discoverRooms } from '../lib/rooms.mjs';
import { buildRoster } from '../lib/agents/roster.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import { buildTokens } from '../lib/theme.mjs';
import { layoutScene, positionsComplete } from '../lib/layout/index.mjs';
import { GATE_ORDER, isBlockingFail, runGates } from '../lib/pipeline.mjs';
import { importPath } from '../importers/index.mjs';
import { importProjection, loadPeopleDir } from '../lib/overlay.mjs';
import { verify } from '../lib/sign.mjs';
import { listPacks, resolvePack } from '../lib/packs.mjs';

const SHIPPED = ['research-lab', 'robotics-lab', 'starter'];
const DRAFTS = ['clinic', 'law-practice'];
const EXPECTED_ROOMS = { starter: ['contacts', 'notes'], 'robotics-lab': ['datasets', 'experiments', 'papers', 'robots'], 'research-lab': ['collaborators', 'datasets', 'experiments', 'papers'], 'law-practice': ['authorities', 'clients', 'deadlines', 'matters'], clinic: ['cases', 'followups', 'literature', 'protocols'] };
const EXPECTED_DESKS = { starter: ['connector', 'planner', 'scribe', 'skeptic'], 'robotics-lab': ['data-ops', 'method-review', 'safety', 'sim-ops'], 'research-lab': ['data-desk', 'grants', 'lit-review', 'methods'], 'law-practice': ['conflicts', 'docket', 'intake', 'researcher'], clinic: ['audit', 'evidence', 'safety-review', 'triage-support'] };
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const tokensCss = readFileSync(join(ROOT, 'renderers', 'tokens.css'), 'utf8');
const packSchema = loadSchema('pack');
const sub = (def) => ({ $ref: `#/$defs/${def}`, $defs: packSchema.$defs });
const packs = listPacks(ROOT);
const walk = (dir) => { const out = []; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out.sort(); };
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const sceneFiles = (p) => (existsSync(join(p.dir, 'examples')) ? readdirSync(join(p.dir, 'examples')).filter((f) => /^scene-.*\.json$/.test(f)).map((f) => join(p.dir, 'examples', f)) : []);
const nonBlocking = (checks) => checks.filter((c) => c.status === 'fail' && !c.blocking).map((c) => c.code);

test('the pack set is exactly VISION §6: three shipped, two drafts under packs/draft/', () => {
  assert.deepEqual(packs.filter((p) => !p.draft).map((p) => p.id), SHIPPED);
  assert.deepEqual(packs.filter((p) => p.draft).map((p) => p.id), DRAFTS);
  for (const p of packs) assert.equal(rel(p.dir), p.draft ? `packs/draft/${p.id}` : `packs/${p.id}`);
});

for (const p of packs) {
  const pack = readJson(join(p.dir, 'pack.json'));
  const discovered = discoverRooms(p.dir);

  test(`${p.id}: pack.json validates and names exactly its room folders`, () => {
    const v = validate(packSchema, pack);
    assert.deepEqual(v.errors, []);
    assert.equal(pack.id, p.id);
    assert.deepEqual([...pack.rooms].sort(), EXPECTED_ROOMS[p.id]);
    assert.deepEqual(discovered.rooms.map((r) => r.id), EXPECTED_ROOMS[p.id]);
    for (const f of ['roster.json', 'disciplines.json', 'theme.json', 'README.md']) assert.ok(existsSync(join(p.dir, f)), `${p.id}/${f} exists`);
    assert.ok(sceneFiles(p).length >= 2, `${p.id} ships at least two example scenes`);
  });

  test(`${p.id}: every room validates with the owner gate, synthetic examples and no blocking finding`, () => {
    assert.equal(discovered.ok, true, JSON.stringify(discovered.checks.filter(isBlockingFail)));
    for (const r of discovered.rooms) {
      assert.equal(r.ok, true, `${p.id}/${r.id}: ${JSON.stringify(r.checks.filter((c) => c.status === 'fail'))}`);
      assert.deepEqual([...new Set(nonBlocking(r.checks))], ['DF_ROOM_MATURITY_UNPROVEN'], `${r.id}: only the unproven note is expected in a pack`);
      const m = r.manifest;
      assert.equal(m.pack, p.id);
      assert.equal(m.privacy_mode, 'synthetic_data');
      assert.equal(m.owner_gates.writes, 'required');
      assert.equal(m.owner_gates.share, 'required');
      assert.equal(m.mode, 'proposal_only');
      assert.ok(Array.isArray(r.examples) && r.examples.length >= 3 && r.examples.length <= 20, `${r.id}: 3 to 20 examples`);
      for (const v of r.views) { assert.ok(v.limit && Number.isInteger(v.limit.max_nodes), `${r.id}/${v.id} declares limit.max_nodes`); if (pack.views_off.includes('vr') && v.views && v.views.vr) assert.equal(v.views.vr.enabled, false, `${r.id}/${v.id}: vr disabled by the pack`); }
      for (const f of m.record.public_fields) assert.ok(Object.hasOwn(r.recordSchema.properties, f), `${r.id}: public field ${f} declared`);
    }
  });

  test(`${p.id}: roster.json is the rooms' desks lifted, with a challenger and no conductor`, () => {
    const roster = readJson(join(p.dir, 'roster.json'));
    assert.deepEqual(validate(sub('roster_file'), roster).errors, []);
    assert.equal(roster.pack, p.id);
    assert.equal(Object.hasOwn(roster, 'conductor'), false, 'DF_PACK_CONDUCTOR_IN_PACK: the conductor is never in a pack');
    assert.equal(roster.desks.some((d) => d.id === 'conductor'), false);
    const built = buildRoster(discovered.rooms, null);
    assert.equal(built.ok, true, JSON.stringify(built.checks.filter((c) => c.status === 'fail')));
    assert.deepEqual(roster.desks, built.roster.desks, 'roster.json drifted from the rooms; regenerate it');
    assert.deepEqual(roster.desks.map((d) => d.id), EXPECTED_DESKS[p.id]);
    assert.ok(roster.desks.some((d) => d.tier === 'challenger' && d.challenger_for.length), 'at least one challenger with targets');
    if (p.id === 'law-practice') for (const d of roster.desks) assert.equal(d.constraint, 'research only, not licensed legal advice');
    if (p.id === 'clinic') assert.match(roster.desks.find((d) => d.id === 'triage-support').constraint, /never a diagnosis/);
  });

  test(`${p.id}: disciplines.json backs every boundary_vocab term; theme.json is a passing brand preset`, () => {
    const disc = readJson(join(p.dir, 'disciplines.json'));
    assert.deepEqual(validate(sub('disciplines_file'), disc).errors, []);
    for (const d of disc.disciplines) assert.equal(d.source, p.id);
    const terms = new Set(disc.disciplines.flatMap((d) => [d.label, ...d.patterns]));
    for (const v of pack.boundary_vocab) assert.ok(terms.has(v), `${p.id}: boundary term '${v}' is a discipline label or pattern`);
    const theme = readJson(join(p.dir, 'theme.json'));
    assert.deepEqual(validate(loadSchema('brand'), theme).errors, []);
    const t = buildTokens(theme, tokensCss);
    assert.equal(t.ok, true, JSON.stringify(t.failures));
    assert.equal(theme.room_preset, { starter: 'paper', 'robotics-lab': 'studio', 'research-lab': 'story', 'law-practice': 'paper', clinic: 'light' }[p.id]);
  });

  test(`${p.id}: README names the boundary it shares and a negative case${p.draft ? ', and the three draft-exit conditions' : ''}`, () => {
    const md = readFileSync(join(p.dir, 'README.md'), 'utf8');
    assert.match(md, /^## What crosses the boundary$/m);
    assert.match(md, /^## A negative case$/m);
    assert.match(md, /DF_[A-Z_]+/, 'the negative case names the code that refuses it');
    if (p.draft) {
      assert.match(md, /^## Leaving draft$/m);
      for (const n of [1, 2, 3]) assert.match(md, new RegExp(`^${n}\\. \\*\\*`, 'm'), `condition ${n}`);
      assert.match(md, /practitioner's review/); assert.match(md, /encryption/); assert.match(md, /retention/);
      assert.match(md, /DF_PACK_DRAFT/);
    }
  });

  test(`${p.id}: example scenes are synthetic, laid out once and gate-clean at checked`, () => {
    const ctx = { viewer: 'self', quality: 'checked', config: { center: { owner_person_id: 'self' } }, rooms: discovered, tokensCss, requireProjected: false };
    for (const file of sceneFiles(p)) {
      const scene = readJson(file);
      assert.equal(scene.schema_version, 'dotfield.scene/1', rel(file));
      assert.equal(scene.meta.privacy_mode, 'synthetic_data', rel(file));
      assert.equal(scene.meta.maturity, pack.maturity, `${rel(file)} carries the pack maturity`);
      assert.equal(scene.laid_out, true, `${rel(file)} is frozen`);
      assert.equal(positionsComplete(scene), true, `${rel(file)} has a position per node`);
      assert.equal(layoutScene(scene), scene, `${rel(file)} is never re-simulated`);
      const room = discovered.rooms.find((r) => r.id === scene.meta.room);
      assert.ok(room && room.views.some((v) => v.id === scene.meta.view), `${rel(file)} names a room view`);
      assert.equal(scene.nodes.filter((n) => n.room === room.id).length, room.examples.length, `${rel(file)}: one node per example record`);
      if (pack.views_off.includes('vr')) assert.equal(scene.views.vr ? scene.views.vr.enabled : false, false, `${rel(file)}: vr off`);
      const r = runGates(scene, ctx, GATE_ORDER);
      assert.equal(r.blocked, false, `${rel(file)}: ${JSON.stringify(r.checks.filter(isBlockingFail))}`);
      assert.deepEqual(r.ran, [...GATE_ORDER]);
    }
  });
}

test('packs hold JSON, CSV and Markdown only; no private strings, hex outside theme.json, or absolute paths under packs/ and templates/center-docs/', async () => {
  const re = await absolutePathRe();
  const bad = [];
  for (const file of [...walk(join(ROOT, 'packs')), ...walk(join(ROOT, 'templates', 'center-docs'))]) {
    const r = rel(file);
    if (!/\.(json|csv|md|css)$/.test(r)) bad.push(`${r}: DF_PACK_CODE_IN_PACK (only .json, .csv, .md ship)`);
    const text = readFileSync(file, 'utf8');
    if (!/^templates\/center-docs\//.test(r)) for (const h of matchLines(text, new RegExp(JAY_RE.source, 'gi'))) bad.push(`${r}:${h.line} private string`);
    for (const h of matchLines(text, EMAIL_RE)) bad.push(`${r}:${h.line} email`);
    for (const h of matchLines(text, PHONE_RE)) bad.push(`${r}:${h.line} phone`);
    for (const h of absolutePathHits(text, re, { json: r.endsWith('.json') })) bad.push(`${r}:${h.line ?? ''} absolute path`);
    if (!/(^|\/)theme\.json$|^center\/brand\.json$/.test(r)) for (const h of matchLines(text, HEX_RE)) bad.push(`${r}:${h.line} hex literal`);
  }
  assert.deepEqual(bad, []);
});

test('resolvePack: shipped ids resolve, drafts are refused with DF_PACK_DRAFT, URLs and unknown ids are refused', () => {
  for (const id of SHIPPED) { const r = resolvePack(id); assert.equal(r.ok, true, id); assert.equal(r.draft, false); assert.equal(rel(r.dir), `packs/${id}`); }
  for (const id of DRAFTS) { const r = resolvePack(id); assert.equal(r.ok, false); assert.equal(r.draft, true); assert.equal(r.checks[0].code, 'DF_PACK_DRAFT'); assert.equal(r.checks[0].blocking, true); assert.equal(rel(r.dir), `packs/draft/${id}`); }
  assert.equal(resolvePack('https://example.invalid/pack.json').checks[0].code, 'DF_PACK_URL_REFUSED');
  assert.equal(resolvePack('file:///somewhere/pack').checks[0].code, 'DF_PACK_URL_REFUSED');
  assert.equal(resolvePack('no-such-pack').checks[0].code, 'DF_PACK_NOT_FOUND');
  assert.equal(resolvePack('../lib').checks[0].code, 'DF_PACK_NOT_FOUND');
});

test('init refuses a draft pack with DF_PACK_DRAFT (through the CLI once lib/commands/init.mjs exists)', async (t) => {
  if (!existsSync(join(ROOT, 'lib', 'commands', 'init.mjs'))) { t.diagnostic('lib/commands/init.mjs not built yet (cli-full); the resolver test above holds the rule'); return; }
  await withTmp(async (dir) => {
    for (const id of DRAFTS) {
      const r = runCli(['init', '--pack', id, '--name', 'Draft check', '--json'], { cwd: dir, env: EPOCH_ENV });
      assert.notEqual(r.code, 0, `init --pack ${id} exits non-zero`);
      assert.ok(r.json && r.json.checks.some((c) => c.code === 'DF_PACK_DRAFT' && c.status === 'fail'), `DF_PACK_DRAFT in the receipt for ${id}`);
      assert.equal(existsSync(join(dir, 'center', 'rooms')), false, 'nothing instantiated');
    }
  });
});

test('robotics-lab examples/runs.csv imports into experiments with no mapping and no DF_RECORD_* failure', () => {
  const rooms = discoverRooms(join(ROOT, 'packs', 'robotics-lab')).rooms;
  const room = rooms.find((r) => r.id === 'experiments');
  const r = importPath(join(ROOT, 'packs', 'robotics-lab', 'examples', 'runs.csv'), { room });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.status === 'fail')));
  assert.deepEqual(r.checks.filter((c) => c.status === 'fail'), []);
  assert.equal(r.records.length, 6);
  for (const rec of r.records) { assert.match(rec.exp_id, /^exp-04/); assert.ok(Array.isArray(rec.tags) && rec.tags.length); assert.equal(typeof rec.value, 'number'); }
  assert.deepEqual(r.records[0].paper_ids, ['paper-orb3', 'paper-kalman']);
  assert.equal(r.room, 'experiments');
});

test('research-lab two-center demo: configs and people validate, projections verify under the pinned keys and import into the right center only', async () => {
  const dir = join(ROOT, 'packs', 'research-lab', 'examples');
  const people = {};
  for (const id of ['alpha', 'beta']) {
    const cfg = readJson(join(dir, `center-${id}.config.json`));
    assert.deepEqual(validate(loadSchema('center-config'), cfg).errors, [], id);
    assert.equal(cfg.center.owner_person_id, id);
    const doc = readJson(join(dir, `people-${id}.json`));
    assert.equal(doc.schema_version, 'dotfield.people/1');
    for (const person of doc.people) assert.deepEqual(validate(loadSchema('person'), person).errors, [], `${id}: ${person.person_id}`);
    assert.equal(doc.people.filter((x) => x.kind === 'self').length, 1);
    assert.equal(doc.people.find((x) => x.kind === 'self').person_id, id);
    people[id] = doc.people;
  }
  const projSchema = loadSchema('projection');
  for (const [from, to] of [['alpha', 'beta'], ['beta', 'alpha']]) {
    const proj = readJson(join(dir, `projection-${from}-to-${to}.json`));
    assert.deepEqual(validate(projSchema, proj).errors, [], `${from}->${to}`);
    const grantor = people[to].find((x) => x.person_id === from);
    assert.equal(verify(proj, proj.signature, grantor.public_key), true, `${from}->${to} verifies under the key ${to} pinned`);
    assert.equal(verify(proj, proj.signature, people[from].find((x) => x.person_id === to).public_key), false, 'and not under the other key');
    for (const n of proj.overlay.nodes) { assert.match(n.id, new RegExp(`^person-${from}-`)); assert.equal(Object.hasOwn(n.fields, 'notes'), false, 'no free text crosses'); }
    await withTmp(async (tmp) => {
      const ok = importProjection(join(dir, `projection-${from}-to-${to}.json`), { people: people[to], self: to, dataDir: join(tmp, 'data'), now: NOW });
      assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => c.status === 'fail')));
      assert.equal(ok.overlay.nodes.length, proj.overlay.nodes.length);
      const wrong = importProjection(join(dir, `projection-${from}-to-${to}.json`), { people: people[from], self: from, dataDir: join(tmp, 'data2'), now: NOW });
      assert.equal(wrong.ok, false);
      assert.ok(wrong.checks.some((c) => c.code === 'DF_OVERLAY_WRONG_RECEIVER' && c.status === 'fail'));
    });
  }
});

test('the starter center init writes validates and renders: validate all exits 0 with both rooms registered; a pack scene renders through the CLI', async () => {
  await withTmp(async (dir) => {
    initCenter(dir, { pack: 'starter' });
    const people = loadPeopleDir(join(dir, 'center'));
    assert.deepEqual(people.checks.filter((c) => c.status === 'fail'), []);
    assert.equal(people.self.person_id, 'self');
    const v = runCli(['validate', 'all', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(v.code, 0, v.stderr || v.stdout);
    assert.equal(v.json.status, 'written');
    assert.deepEqual(v.json.checks.filter(isBlockingFail), []);
    const registry = readJson(join(dir, '.dotfield', 'registry.json'));
    assert.deepEqual(registry.rooms.map((r) => r.id), ['contacts', 'notes']);
    assert.deepEqual(registry.invalid, []);
    assert.equal(registry.center.name, readJson(join(dir, 'center', 'center.config.json')).center.name);
    const scene = join(ROOT, 'packs', 'robotics-lab', 'examples', 'scene-rig-room.json');
    const out = join(dir, '.dotfield', 'rig.html');
    const r = runCli(['render', scene, out, '--view', '2d', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.equal(r.json.status, 'written');
    assert.ok(existsSync(out) && statSync(out).size > 1000, 'the HTML was written');
    assert.ok(readFileSync(out, 'utf8').includes('Hallbot 1'));
  });
});
