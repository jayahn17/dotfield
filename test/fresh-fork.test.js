// Three defects a fresh-fork walkthrough found on 2026-10-09, each pinned here:
//   1. a task that matched only challenger desks routed no specialist, so the
//      agent loop could not start in six pack rooms (robotics experiments, the
//      starter pack's contacts, ...);
//   2. a verb that leaves a proposal for the owner exited 0, while VISION §8.2
//      and the skill promise exit 3 (the skill stops on it);
//   3. the benchmark's CI cell depended on where the repository root was, so
//      `npm run check` failed on a fork's first run after `git subtree split`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runCli } from './helpers/cli.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { CENTER_MIN, EPOCH_ENV, initCenter, scaffoldCenter } from './helpers/center.mjs';
import { discoverRooms, loadConfig } from '../lib/rooms.mjs';
import { buildRoster } from '../lib/agents/roster.mjs';
import { route } from '../lib/agents/router.mjs';
import { fromReceipt } from '../lib/exit-codes.mjs';

const packDirs = () => {
  const out = [];
  for (const base of ['packs', join('packs', 'draft')]) {
    for (const id of readdirSync(join(ROOT, base))) {
      const dir = join(ROOT, base, id);
      if (id !== 'draft' && existsSync(join(dir, 'pack.json'))) out.push(dir);
    }
  }
  return out;
};
const rosterOf = (dir) => {
  const rooms = discoverRooms(dir, {}).rooms;
  const config = loadConfig(CENTER_MIN).config;
  return { rooms, roster: buildRoster(rooms, config).roster };
};

test('every room of every shipped and draft pack routes its own keywords to a specialist and a challenger', () => {
  const dirs = packDirs();
  assert.ok(dirs.length >= 5, 'starter, robotics-lab, research-lab and the two drafts');
  let rooms = 0;
  for (const dir of dirs) {
    const { rooms: list, roster } = rosterOf(dir);
    for (const room of list) {
      const desks = (room.manifest && room.manifest.desks) || [];
      if (!desks.length) continue;
      rooms += 1;
      const task = desks[0].keywords.slice(0, 4).join(' ');
      const r = route(task, roster);
      const where = `${dir.slice(ROOT.length + 1)} room ${room.id} task "${task}"`;
      assert.ok(r.specialists.length >= 1, `${where}: a specialist`);
      assert.ok(r.challenger, `${where}: a challenger`);
      assert.ok(!r.specialists.some((s) => s.id === r.challenger.id), `${where}: the challenger is not a specialist`);
      assert.equal(r.ok, true, `${where}: routing ok`);
    }
  }
  assert.ok(rooms >= 15, `rooms with desks checked: ${rooms}`);
});

test('robotics-lab: a method review of experiments routes method-review (a core desk, as VISION §5 has it) and safety challenges', () => {
  const { roster } = rosterOf(join(ROOT, 'packs', 'robotics-lab'));
  const r = route('method review of the ATE benchmark experiments', roster);
  assert.deepEqual(r.specialists.map((s) => s.id), ['method-review']);
  assert.equal(r.challenger.id, 'safety');
  const sim = route('isaac simulation of the urdf', roster);
  assert.equal(sim.specialists[0].id, 'sim-ops');
  assert.equal(sim.challenger.id, 'method-review', 'method-review challenges sim-ops (challenger_for)');
});

test('a task that matches only a challenger desk promotes it, says so, and another desk challenges', () => {
  const { roster } = rosterOf(join(ROOT, 'packs', 'starter'));
  const r = route('verify the evidence behind this assumption', roster);
  assert.deepEqual(r.specialists.map((s) => s.id), ['skeptic']);
  assert.match(r.specialists[0].reason, /promoted/);
  assert.equal(r.challenger.id, 'planner', 'the planner declares challenger_for skeptic');
  const none = route('zebra quantum marmalade', roster);
  assert.equal(none.specialists.length, 0, 'a task that matches nothing is still refused');
  assert.ok(none.checks.some((c) => c.code === 'DF_RUN_NO_SPECIALISTS' && c.status === 'fail'));
});

test('starter: a question about the people you met routes to the connector desk and the skeptic challenges', () => {
  const { roster } = rosterOf(join(ROOT, 'packs', 'starter'));
  for (const task of ['who did I meet at the conference?', 'who could introduce me to a colleague in structural engineering', 'add the contacts from the workshop']) {
    const r = route(task, roster);
    assert.deepEqual(r.specialists.map((s) => s.id), ['connector'], task);
    assert.ok(!r.specialists[0].reason, `${task}: the connector is a core desk, not a promoted challenger`);
    assert.equal(r.challenger.id, 'skeptic', task);
  }
  const notes = route('summarize my journal note', roster);
  assert.equal(notes.specialists[0].id, 'scribe', 'notes tasks still go to the scribe');
});

test('the first agent run on a brand-new center (no data/ yet) reaches awaiting_owner instead of a false write-guard block', async () => {
  await withTmp(async (dir) => {
    // The starter center as init writes it, with data/ removed: nothing written yet (the write guard digests a missing data/ as the empty tree).
    initCenter(dir, { pack: 'starter', keepData: false });
    const dataDir = join(dir, 'data');
    assert.equal(existsSync(dataDir), false);
    for (const task of ['summarize my journal note', 'who did I meet at the conference?']) {
      rmSync(dataDir, { recursive: true, force: true });
      const r = runCli(['run', task, '--provider', 'dry', '--json'], { cwd: dir, env: { ...EPOCH_ENV, DOTFIELD_ROOT: dir } });
      assert.equal(r.code, 3, r.stdout || r.stderr);
      assert.equal(r.json.status, 'awaiting_owner', task);
      assert.ok(!r.json.checks.some((k) => k.code === 'DF_RUN_WRITE_BEFORE_APPROVAL' && k.status === 'fail'), `${task}: only data/proposals/ was created`);
      assert.deepEqual(readdirSync(dataDir), ['proposals'], `${task}: the run wrote nothing but its proposal`);
    }
  });
});

test('anything left for the owner exits 3: a proposal, a run awaiting the owner, a refusal', () => {
  assert.equal(fromReceipt({ status: 'proposal', checks: [], owner_decision: { state: 'awaiting_owner' } }), 3);
  assert.equal(fromReceipt({ status: 'awaiting_owner', checks: [] }), 3);
  assert.equal(fromReceipt({ status: 'refused', checks: [] }), 3);
  assert.equal(fromReceipt({ status: 'written', checks: [], owner_decision: { state: 'awaiting_owner' } }), 3, 'an item awaiting the owner, whatever the status word');
  assert.equal(fromReceipt({ status: 'written', checks: [], owner_decision: { state: 'approved' } }), 0);
  assert.equal(fromReceipt({ status: 'read', checks: [] }), 0);
  assert.equal(fromReceipt({ status: 'read', checks: [], owner_decision: { state: 'awaiting_owner' } }), 0, 'listing waiting proposals is a read, not a wait');
});

test('import records exits 3 with a proposal, writes nothing, and its receipt verifies', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const examples = join(c.centerDir, 'rooms', 'notes', 'examples.json');
    const r = runCli(['import', 'records', 'notes', examples, '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 3, r.stdout || r.stderr);
    assert.equal(r.json.status, 'proposal');
    assert.equal(r.json.exit_code, 3);
    assert.equal(r.json.owner_decision.state, 'awaiting_owner');
    assert.equal(existsSync(join(c.dataDir, 'rooms', 'notes.json')), false, 'nothing is written before approve');
    const receipt = r.json.outputs.map((o) => o.ref).find((ref) => ref.startsWith('.dotfield/receipts/'));
    if (receipt) {
      const v = runCli(['verify', join(c.root, receipt), '--json'], { cwd: c.root, env: EPOCH_ENV });
      assert.ok(!v.json.checks.some((k) => k.code === 'DF_RECEIPT_EXIT_CODE_MISMATCH' && k.status === 'fail'), 'the receipt agrees with its exit code');
    }
  });
});

test('the CI checklist cell is the same inside son and after a subtree split', () => {
  const list = JSON.parse(readFileSync(join(ROOT, 'references', 'benchmark-checklist.json'), 'utf8'));
  const probes = [];
  const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'probe' && typeof v === 'string') probes.push(v); else walk(v); } };
  walk(list);
  assert.ok(!probes.includes('maintainability.ci_tests_present'), 'no checklist cell reads the location-dependent probe');
  assert.ok(probes.includes('maintainability.ci_workflow_shipped'), 'the CI cell reads the shipped workflow instead');
});
