// router.mjs: deterministic routing shared by plan, run and the MCP plan
// tool. The binding assertion is plan == run on twelve fixture tasks over
// examples/roster.example.json; the rest pins the scoring rules a fork can
// rely on. node:test, zero network (dry provider), temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTmp } from './helpers/tmp.mjs';
import { NOW, readJson, scaffoldCenter } from './helpers/center.mjs';
import { discoverRooms, loadConfig } from '../lib/rooms.mjs';
import { MAX_SPECIALISTS, MAX_TOKENS, plan, route, routedDesks, scoreDesk, tokenize } from '../lib/agents/router.mjs';
import { deskIds } from '../lib/agents/roster.mjs';
import { run } from '../lib/agents/loop.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER = readJson(join(ROOT, 'examples', 'roster.example.json'));

const TASKS = [
  'start a simulation of the robot platform in gazebo',
  'write a weekly plan and a journal note',
  'benchmark the ATE metric of the new experiment against the survey paper',
  'which dataset license allows the hall loop data to be shared',
  'draft a summary of last week and schedule the next milestone',
  'review the estop wiring before the hardware launch',
  'read the loop closure survey and cite the doi in a note',
  'verify the storage modality of every dataset',
  'plan the ablation study and its metric',
  'journal the calibration drift and check the urdf',
  'what should the reading list for simulation methods contain',
  'a question with no matching words at all',
];

function boot(dir) {
  const c = scaffoldCenter(dir);
  const d = discoverRooms(c.centerDir, { dotDir: c.dotDir });
  const config = loadConfig(c.centerDir).config;
  const records = { notes: readJson(c.roomFile('notes', 'examples.json')) };
  return { c, d, config, records };
}

test('tokenize drops stopwords and one-character tokens, keeps order, caps at MAX_TOKENS', () => {
  assert.deepEqual(tokenize('The ATE of the hall-loop run, and a plan!'), ['ate', 'hall', 'loop', 'run', 'plan']);
  assert.deepEqual(tokenize('note note NOTE'), ['note']);
  assert.equal(tokenize(Array.from({ length: 200 }, (_, i) => `w${i}x`).join(' ')).length, MAX_TOKENS);
  assert.deepEqual(tokenize(null), []);
});

test('scoreDesk is integer, explains its matches and ranks keyword over domain over adjacent field', () => {
  const desk = ROSTER.desks.find((d) => d.id === 'method-review');
  const full = scoreDesk(desk, tokenize('benchmark the ATE metric with statistics'));
  assert.ok(Number.isInteger(full.score) && full.score > 0);
  assert.deepEqual(full.matched, ['adjacent_field:statistics', 'keyword:ate', 'keyword:benchmark', 'keyword:metric']);
  assert.equal(scoreDesk(desk, tokenize('nothing here')).score, 0);
  assert.ok(scoreDesk(desk, tokenize('ate')).score > scoreDesk(desk, tokenize('statistics')).score);
});

test('route is deterministic, pins the fixture expectations and never exceeds five specialists', () => {
  const a = route(TASKS[0], ROSTER);
  assert.deepEqual(a, route(TASKS[0], ROSTER));
  assert.deepEqual(a.specialists.map((s) => s.id), ['sim-ops']);
  assert.equal(a.challenger.id, 'method-review', 'two desks challenge sim-ops; the tie breaks by score then id');
  assert.match(a.challenger.reason, /challenger_for sim-ops/);
  const b = route(TASKS[1], ROSTER);
  assert.deepEqual(b.specialists.map((s) => s.id), ['scribe', 'planner']);
  assert.equal(b.challenger.id, 'skeptic');
  for (const task of TASKS) {
    const r = route(task, ROSTER);
    assert.ok(r.specialists.length <= MAX_SPECIALISTS);
    assert.ok(r.specialists.every((s) => s.tier !== 'challenger'), 'challenger-tier desks are never specialists');
    if (r.challenger) assert.ok(!r.specialists.some((s) => s.id === r.challenger.id), 'the challenger is outside the specialists');
    assert.equal(r.scored.length, ROSTER.desks.length, 'every desk is scored');
  }
  const none = route(TASKS[11], ROSTER);
  assert.equal(none.ok, false);
  assert.ok(none.checks.some((c) => c.code === 'DF_RUN_NO_SPECIALISTS' && c.status === 'fail'));
});

test('rooms restriction, explicit desks and the challenger fallbacks', () => {
  const notesOnly = route('write a journal note', ROSTER, { rooms: ['notes'] });
  assert.deepEqual(notesOnly.scored.map((s) => s.id).sort(), ['planner', 'scribe']);
  assert.equal(notesOnly.challenger, null);
  assert.ok(notesOnly.checks.some((c) => c.code === 'DF_RUN_NO_CHALLENGER' && c.status === 'fail'));
  const explicit = route('anything', ROSTER, { desks: ['scribe', 'sim-ops'] });
  assert.deepEqual(explicit.specialists.map((s) => s.id).sort(), ['scribe', 'sim-ops']);
  assert.equal(explicit.ok, true);
  const unknown = route('anything', ROSTER, { desks: ['scribe', 'ghost'] });
  assert.ok(unknown.checks.some((c) => c.code === 'DF_RUN_DESK_UNKNOWN' && c.status === 'fail' && /ghost/.test(c.message)));
  const tooMany = route('anything', ROSTER, { desks: ['scribe', 'planner', 'sim-ops', 'data-ops', 'lit-review', 'safety'] });
  assert.ok(tooMany.checks.some((c) => c.code === 'DF_RUN_TOO_MANY_DESKS' && c.status === 'fail'));
  const terms = route('journal', ROSTER, { terms: ['simulation'] });
  assert.ok(terms.specialists.some((s) => s.id === 'sim-ops'), 'extra terms (a person\'s disciplines) score desks too');
  const tiered = route('verify the dataset license', ROSTER, { rooms: ['datasets', 'contacts'] });
  assert.equal(tiered.challenger.id, 'skeptic');
  assert.equal(tiered.challenger.reason, 'tier challenger');
});

test('plan reduces route to ids and routedDesks lists specialists then challenger', () => {
  const p = plan(TASKS[2], ROSTER);
  const r = route(TASKS[2], ROSTER);
  assert.deepEqual(p.specialists, r.specialists.map((s) => s.id));
  assert.equal(p.challenger, r.challenger.id);
  assert.deepEqual(p.desks, routedDesks(r));
  assert.deepEqual(p.desks.slice(-1), [p.challenger]);
  assert.deepEqual(p.scored.map((s) => s.id).sort(), deskIds(ROSTER));
  assert.deepEqual(Object.keys(p).sort(), ['challenger', 'checks', 'desks', 'ok', 'scored', 'specialists', 'task', 'tokens']);
});

test('plan == run: the specialists and challenger run uses are exactly what plan listed, for twelve tasks', async () => {
  await withTmp(async (dir) => {
    const { c, d, config, records } = boot(dir);
    let ran = 0;
    for (const task of TASKS) {
      const p = plan(task, ROSTER);
      const res = await run({ task, roster: ROSTER, provider: 'dry', rooms: d.rooms, records, config, now: NOW, dataDir: c.dataDir, dotDir: c.dotDir, env: {}, budget: 20000, planned: p.specialists });
      assert.deepEqual(res.run.routing.specialists, p.specialists, task);
      assert.equal(res.run.routing.challenger, p.challenger, task);
      assert.deepEqual(res.routed, p.desks, task);
      assert.ok(res.checks.some((x) => x.code === 'DF_RUN_ROUTE_PARITY' && x.status === 'pass'), task);
      if (p.ok) {
        assert.equal(res.ok, true, `${task}: ${JSON.stringify(res.checks.filter((x) => x.status === 'fail'))}`);
        assert.equal(res.run.status, 'awaiting_owner');
        assert.deepEqual(res.run.steps.map((s) => s.desk), p.desks.length ? ['conductor', ...p.specialists, p.challenger, 'conductor'] : []);
        ran += 1;
      } else {
        assert.equal(res.ok, false);
        assert.equal(res.receipt.status, 'blocked');
        assert.equal(res.run.steps.length, 0, 'no tokens are spent when routing fails');
      }
    }
    assert.ok(ran >= 10, `${ran} of ${TASKS.length} tasks ran`);
  });
});

test('a run whose routing differs from the plan it was handed fails DF_RUN_ROUTE_PARITY before spending tokens', async () => {
  await withTmp(async (dir) => {
    const { c, d, config, records } = boot(dir);
    const res = await run({ task: TASKS[1], roster: ROSTER, provider: 'dry', rooms: d.rooms, records, config, now: NOW, dataDir: c.dataDir, dotDir: c.dotDir, env: {}, budget: 20000, planned: ['sim-ops'] });
    assert.equal(res.ok, false);
    assert.equal(res.receipt.status, 'blocked');
    assert.equal(res.receipt.exit_code, 2);
    assert.ok(res.checks.some((x) => x.code === 'DF_RUN_ROUTE_PARITY' && x.status === 'fail'));
    assert.equal(res.run.steps.length, 0);
  });
});
