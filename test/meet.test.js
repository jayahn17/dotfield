// lib/meet.mjs: a kind "meet" scene with two regions and candidate edges at
// or above the threshold, deterministic, schema-valid and gate-clean; the
// scoring; `--between` and `--with` produce one shape; candidates are never
// persisted (meet() writes nothing; a pair proposal becomes a row in
// data/boundaries.json only through applyPairDecision after approval); and
// the shipped scene-meet example equals meet() over its sides. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THRESHOLD, SIDE_IDS, applyPairDecision, boundariesPath, candidates, meet, pairId, pairRows, readBoundaries, score, sideFromOverlay, sideFromScene, tokensOf } from '../lib/meet.mjs';
import { emptyOverlay } from '../lib/overlay.mjs';
import { project } from '../lib/project.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';
import * as schemaGate from '../lib/gates/schema.mjs';
import * as topology from '../lib/gates/topology.mjs';
import * as privacy from '../lib/gates/privacy.mjs';
import { NOW } from './helpers/center.mjs';
import { withTmp } from './helpers/tmp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fails = (checks) => checks.filter((c) => c.status === 'fail');
const gates = (scene, ctx = {}) => [...schemaGate.check(scene, ctx), ...topology.check(scene, ctx), ...privacy.check(scene, ctx)];
const EXAMPLE_NOW = new Date('2026-10-01T11:00:00Z');
const VOCAB = ['sensor-fusion', 'estop', 'vibration', 'inspection', 'calibration'];
const DISCIPLINES = [{ label: 'SLAM', patterns: ['slam', 'loop closure'], weight: 1, source: 'robotics-lab' }, { label: 'vibration', patterns: ['vibration'], weight: 0.8, source: 'robotics-lab' }];

/** The synthetic experiments x papers sides the shipped example is built from (kept in step with references/SHARING.md §9). */
export function exampleSides() {
  const D = (seed) => `sha256:${seed.repeat(16)}`;
  const mk = (id, kind, label, room, tags, seed, token, on) => ({ id, kind, label, room, record_id: id.replace(`${room}-`, ''), weight: 0.5, tags, color_token: token, status: 'accepted',
    provenance: { owner_person_id: 'self', source: { kind: 'record', ref: `${room}/${id.replace(`${room}-`, '')}`, digest: D(seed) }, captured_on: on, happened_on: on }, audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [`ev-${id}`] });
  const ev = (n) => ({ id: `ev-${n.id}`, kind: 'record', ref: n.provenance.source.ref, digest: n.provenance.source.digest, label: `SRC ${n.id.slice(-4)}` });
  const left = { id: 'experiments', label: 'Experiments', kind: 'room', nodes: [
    mk('experiments-exp-0412', 'record', 'ORB-SLAM3 on hall-loop', 'experiments', ['slam', 'indoor', 'vibration'], '9b1c', 'series-2', '2026-09-18'),
    mk('experiments-exp-0402', 'record', 'IMU bias sweep', 'experiments', ['imu', 'calibration'], '0402', 'series-2', '2026-09-05'),
    mk('experiments-exp-0404', 'record', 'Stairwell attempt', 'experiments', ['slam', 'failed', 'estop'], '0404', 'warn', '2026-09-12'),
  ] };
  const right = { id: 'papers', label: 'Papers', kind: 'room', nodes: [
    mk('papers-paper-orb3', 'record', 'ORB-SLAM3 (Campos 2021)', 'papers', ['slam', 'loop-closure'], '11aa', 'series-3', '2026-08-02'),
    mk('papers-paper-vib', 'record', 'Vibration-aware IMU calibration', 'papers', ['calibration', 'vibration', 'imu'], '22bb', 'series-3', '2026-08-20'),
    mk('papers-paper-safety', 'record', 'Emergency stop practice in mobile robots', 'papers', ['safety', 'estop'], '33cc', 'series-3', '2026-07-11'),
  ] };
  left.evidence = left.nodes.map(ev);
  right.evidence = right.nodes.map(ev);
  return { left, right };
}
const build = (over = {}) => meet({ ...exampleSides(), disciplines: DISCIPLINES, vocab: VOCAB, threshold: 0.35, now: EXAMPLE_NOW, meta: { privacy_mode: 'synthetic_data', theme: 'studio' }, ...over });

test('meet builds a kind meet scene: two regions, candidates at or above the threshold best first, labels naming the shared tokens; schema-valid, gate-clean, deterministic, and no file is written', () => withTmp(async (dir) => {
  const s = build();
  assert.equal(validate(loadSchema('scene'), s).ok, true, JSON.stringify(validate(loadSchema('scene'), s).errors));
  assert.deepEqual(fails(gates(s)), []);
  assert.deepEqual(s, build());
  assert.equal(s.kind, 'meet');
  assert.deepEqual(s.meta, { id: 'meet-experiments-papers', title: 'Meet — Experiments × Papers', theme: 'studio', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'local_beta', legend: true });
  assert.deepEqual(s.viewer, { person_id: 'self', mode: 'self', rule_refs: [] });
  assert.deepEqual(s.groups.map((g) => [g.id, g.kind, g.wraps.length, g.color_token]), [['meet-left', 'region', 3, 'series-1'], ['meet-right', 'region', 3, 'series-2']]);
  assert.deepEqual(s.nodes.map((n) => n.group), ['meet-left', 'meet-left', 'meet-left', 'meet-right', 'meet-right', 'meet-right']);
  assert.deepEqual(s.edges.map((e) => [e.id, e.from, e.to, e.weight, e.label, e.kind, e.directed, e.variant]), [
    ['cand-1', 'experiments-exp-0402', 'papers-paper-vib', 0.75, 'calibration, imu', 'candidate', false, 'dashed'],
    ['cand-2', 'experiments-exp-0412', 'papers-paper-vib', 0.429, 'discipline:vibration, vibration', 'candidate', false, 'dashed'],
    ['cand-3', 'experiments-exp-0404', 'papers-paper-orb3', 0.4, 'discipline:slam, slam', 'candidate', false, 'dashed'],
    ['cand-4', 'experiments-exp-0404', 'papers-paper-safety', 0.4, 'estop', 'candidate', false, 'dashed'],
  ]);
  assert.ok(s.edges.every((e) => e.weight >= 0.35));
  assert.deepEqual(s.views['2d'], { layout: 'lanes', seed: 1 });
  assert.deepEqual(s.views.interactive.lenses.map((l) => l.match), [{ groups: ['meet-left'] }, { groups: ['meet-right'] }]);
  assert.deepEqual(s.evidence.map((e) => e.id), s.nodes.map((n) => n.evidence_ids[0]));
  assert.deepEqual(readdirSync(dir), [], 'meet() touched no file');
  assert.equal(s.projected, undefined, 'unstamped until project({authored}) runs');
  const stamped = await project({ authored: s, now: NOW, sessionKey: 'k', includeOverlays: false });
  assert.ok(privacy.verifyStamp(stamped, 'k'));
  assert.deepEqual(fails(gates(stamped, { sessionKey: 'k', requireProjected: true })), []);
  assert.deepEqual(stamped.edges.map((e) => e.id), ['cand-1', 'cand-2', 'cand-3', 'cand-4']);
}));

test('scoring: shared tokens over the union with vocab counted twice; discipline labels join through their patterns; the threshold is a floor; ties are broken by id', () => {
  const { left, right } = exampleSides();
  assert.deepEqual([...tokensOf(left.nodes[0], { disciplines: DISCIPLINES, vocab: VOCAB })].sort(), ['discipline:slam', 'discipline:vibration', 'indoor', 'slam', 'vibration']);
  assert.deepEqual(score({ tags: ['a', 'b'] }, { tags: ['a', 'b'] }), { score: 1, shared: ['a', 'b'] });
  assert.deepEqual(score({ tags: ['a'] }, { tags: ['b'] }), { score: 0, shared: [] });
  assert.equal(score({ tags: ['a', 'x'] }, { tags: ['a', 'y'] }).score, 0.333);
  assert.equal(score({ tags: ['a', 'x'] }, { tags: ['a', 'y'] }, { vocab: ['a'] }).score, 0.667, 'a shared vocab term counts twice');
  assert.equal(candidates(left, right, { disciplines: DISCIPLINES, vocab: VOCAB, threshold: 1 }).length, 0);
  assert.equal(candidates(left, right, { disciplines: DISCIPLINES, vocab: VOCAB, threshold: 0 }).length, 5, 'one pair shares nothing and never scores');
  assert.deepEqual(candidates(left, right, { threshold: 0.4, maxCandidates: 1 }).map((c) => c.from), ['experiments-exp-0402']);
  assert.equal(DEFAULT_THRESHOLD, 0.35);
  assert.equal(build({ threshold: 0.5 }).edges.length, 1);
  assert.deepEqual(SIDE_IDS, { left: 'meet-left', right: 'meet-right' });
});

test('--between (two room scenes) and --with (one person\'s overlay) produce the same scene shape; a node on both sides appears once', () => {
  const graph = readJson(join(ROOT, 'examples', 'scene-graph.json'));
  const experiments = sideFromScene(graph, { id: 'experiments', label: 'Experiments', roomId: 'experiments' });
  const papers = sideFromScene(graph, { id: 'papers', label: 'Papers', roomId: 'papers' });
  assert.deepEqual([experiments.kind, experiments.nodes.map((n) => n.id), papers.nodes.map((n) => n.id), experiments.evidence.length], ['room', ['exp-0412'], ['paper-orb3'], 2]);
  const stub = graph.nodes.find((n) => n.id === 'person-ada-calib-cadence');
  const overlay = { ...emptyOverlay('ada'), nodes: [{ ...stub, boundary: { ...stub.boundary, expires_on: '2027-09-20' } }, { ...stub, id: 'person-ada-old', boundary: { ...stub.boundary, expires_on: '2026-09-01' } }] };
  const ada = sideFromOverlay(overlay, { now: NOW, label: 'Ada' });
  assert.deepEqual([ada.id, ada.kind, ada.nodes.map((n) => n.id), ada.nodes[0].evidence_ids, ada.nodes[0].color_token], ['ada', 'person', ['person-ada-calib-cadence'], [], 'foreign']);
  const between = meet({ left: experiments, right: papers, now: NOW, threshold: 0.3 });
  const withAda = meet({ left: experiments, right: ada, now: NOW, threshold: 0.3, vocab: ['vibration'] });
  assert.deepEqual(Object.keys(between), Object.keys(withAda));
  const shape = (v) => ({ ...v, interactive: { ...v.interactive, lenses: v.interactive.lenses.map((l) => [l.id, l.match]) } });
  assert.deepEqual(shape(between.views), shape(withAda.views), 'the same views; only the lens labels name the sides');
  assert.deepEqual([between.groups.map((g) => g.kind), withAda.groups.map((g) => g.kind)], [['region', 'region'], ['region', 'person']]);
  assert.deepEqual([between.edges.map((e) => e.kind), withAda.edges.map((e) => e.kind)], [['candidate'], []], 'slam joins the experiment and the paper; the cadence stub shares nothing with exp-0412');
  for (const s of [between, withAda]) assert.deepEqual(fails(gates(s, { viewer: 'self' })), [], 'gate-clean (viewer self sees the stub)');
  const same = meet({ left: experiments, right: { ...papers, nodes: [...papers.nodes, ...experiments.nodes] }, now: NOW });
  assert.deepEqual(same.nodes.map((n) => n.id), ['exp-0412', 'paper-orb3'], 'left wins');
  assert.deepEqual(same.groups[1].wraps, ['paper-orb3']);
  const forAda = meet({ left: experiments, right: ada, now: NOW, viewer: 'ada', owner: 'ada' });
  assert.deepEqual(forAda.viewer, { person_id: 'self', mode: 'self', rule_refs: [] }, 'the owner id is mode self whatever it is called');
  assert.deepEqual(meet({ left: experiments, right: ada, now: NOW, viewer: { person_id: 'bob', rule_refs: ['self/rule-01'] } }).viewer, { person_id: 'bob', mode: 'person', rule_refs: ['self/rule-01'] });
  assert.throws(() => meet({ left: experiments, now: NOW }), TypeError);
  assert.throws(() => meet({ left: experiments, right: papers }), TypeError);
});

test('candidates are never persisted: pairRows are the records of a pair proposal; applyPairDecision writes data/boundaries.json only for an approved or edited proposal, idempotently', () => withTmp(async (dir) => {
  const s = build();
  const rows = pairRows(s);
  assert.deepEqual(rows.map((r) => [r.local_node, r.other_node, r.rule_ref, r.score]), s.edges.map((e) => [e.from, e.to, null, e.weight]));
  assert.ok(rows.every((r) => /^pair-[0-9a-f]{12}$/.test(r.pair_id)));
  assert.equal(rows[0].pair_id, pairId('experiments-exp-0402', 'papers-paper-vib'));
  assert.deepEqual(pairRows(s, ['cand-4']).map((r) => r.local_node), ['experiments-exp-0404']);
  const stub = { ...s.nodes[3], id: 'person-ada-x', kind: 'boundary', boundary: { rule_ref: 'ada/rule-01', digest: `sha256:${'a'.repeat(64)}`, shared_by: 'ada', released_on: '2026-09-20', key_id: 'ada-k1' } };
  assert.equal(pairRows({ nodes: [s.nodes[0], stub], edges: [{ kind: 'candidate', from: s.nodes[0].id, to: 'person-ada-x', weight: 0.5 }] })[0].rule_ref, 'ada/rule-01', 'a stub pair records the rule it came under');
  const dataDir = join(dir, 'data');
  assert.deepEqual(readBoundaries(dataDir), { schema_version: 'dotfield.boundaries/1', pairs: [] });
  const proposal = (status, records = rows.slice(0, 2)) => ({ kind: 'pair', proposal_id: 'prop_20261001T101500Z_0c0c0c', status, records });
  assert.deepEqual(applyPairDecision({ proposal: proposal('awaiting_owner'), dataDir, now: NOW }).applied, false);
  assert.deepEqual(applyPairDecision({ proposal: proposal('rejected'), dataDir, now: NOW }).applied, false);
  assert.deepEqual(applyPairDecision({ proposal: { ...proposal('approved'), kind: 'records' }, dataDir, now: NOW }).applied, false);
  assert.equal(existsSync(boundariesPath(dataDir)), false, 'nothing is written before approval');
  const a = applyPairDecision({ proposal: proposal('approved'), dataDir, now: NOW });
  assert.deepEqual([a.applied, a.added, a.pairs.length, a.path], [true, 2, 2, boundariesPath(dataDir)]);
  assert.deepEqual(readBoundaries(dataDir).pairs[0], { pair_id: rows[0].pair_id, local_node: 'experiments-exp-0402', other_node: 'papers-paper-vib', rule_ref: null, accepted_on: '2026-10-01', proposal_id: 'prop_20261001T101500Z_0c0c0c' });
  assert.deepEqual(applyPairDecision({ proposal: proposal('approved'), dataDir, now: NOW }).added, 0, 'idempotent by pair_id');
  assert.deepEqual(applyPairDecision({ proposal: proposal('edited', rows.slice(2)), dataDir, now: NOW }).added, 2);
  assert.deepEqual(readBoundaries(dataDir).pairs.map((p) => p.local_node), rows.map((r) => r.local_node));
  assert.deepEqual(readdirSync(dir), ['data'], 'only data/boundaries.json came into being');
  assert.throws(() => applyPairDecision({ proposal: proposal('approved'), dataDir }), TypeError);
}));

test('the shipped scene-meet example equals meet() over its sides', () => {
  const onDisk = readJson(join(ROOT, 'examples', 'scene-meet.example.json'));
  assert.deepEqual(onDisk, build(), 'examples/scene-meet.example.json is current (regenerate with the sides of exampleSides())');
  assert.deepEqual(fails(gates(onDisk)), []);
});
