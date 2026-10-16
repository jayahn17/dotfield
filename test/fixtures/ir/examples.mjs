// The seven shipped scenes under examples/ as data: scene-graph (VISION §4
// verbatim, digests expanded, a date time block and two steps), scene-room (a
// metric rig room), scene-timeline (a dated run history), scene-workflow (an
// archify-style dataflow with ext.archify and a trace time block), and the v2
// routed scenes scene-sequence, scene-lifecycle and scene-architecture, which
// are laid out here through lib/layout (cold, at generation time) so they are
// committed with complete positions, dense routes, sparse labels, the plan
// and a written viewBox: goldens never re-simulate. The four hand-placed
// scenes carry the plan a cold run writes for their mode. Each is finalized
// the way `render` leaves it: laid_out, a `projected` block whose mac is the
// real stamp under EXAMPLE_SESSION_KEY, and an embedded receipt summary.
// build-fixtures.mjs writes them to examples/; ir-gates.test.js fails when
// the files drift from this module, test/examples.test.js pins their shape.
import { readFileSync } from 'node:fs';
import { stamp } from '../../../lib/gates/privacy.mjs';
import { layoutDetailed } from '../../../lib/layout/index.mjs';

/** The engine tokens the layout measures labels with (the same file renders and gates read). */
export const TOKENS_CSS = readFileSync(new URL('../../../renderers/tokens.css', import.meta.url), 'utf8');

/** A fixture session key, not a real one: it lets the committed stamps verify. */
export const EXAMPLE_SESSION_KEY = 'dotfield-example-session-key';
export const PROJECTED_AT = '2026-10-01T10:14:58Z';

/** sha256:<64 hex> built from a short hex seed, so illustrative digests are shaped right and traceable. */
export function fakeDigest(seed) {
  return `sha256:${seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64)}`;
}

const AUD = (privacy_level, share_rule_ids = []) => ({ privacy_level, share_rule_ids });
const SRC = (kind, ref, seed) => ({ kind, ref, digest: fakeDigest(seed) });
const OWN = (source, captured_on, extra = {}) => ({ owner_person_id: 'self', source, captured_on, ...extra });

/** Append projected (stamped) and receipt to an unstamped scene. */
export function finalize(scene, { receiptId, sourceSeed, tokensSeed, checksPassed, viewer = 'self' }) {
  const projected = {
    by: 'lib/project.mjs', engine_version: '0.1.0', viewer, at: PROJECTED_AT, dropped: 0,
    limit: { focus: null, reach: null, lens: null, max_nodes: 2000 },
    mac: stamp(scene, EXAMPLE_SESSION_KEY),
  };
  const receipt = { receipt_id: receiptId, source_digest: fakeDigest(sourceSeed), tokens_digest: fakeDigest(tokensSeed), validator_version: '1', checks_passed: checksPassed };
  return { ...scene, projected, receipt };
}

/** VISION §4: a robotics-lab experiments graph after render. */
export function graphScene() {
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'graph',
    meta: { id: 'experiments-graph', title: 'Experiments — method web', output: 'out.html', theme: 'studio', quality: 'checked', units: 'm', up_axis: 'y', privacy_mode: 'synthetic_data', maturity: 'local_beta', legend: true },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups: [
      { id: 'g-slam', label: 'SLAM', kind: 'discipline', wraps: ['exp-0412', 'paper-orb3'], color_token: 'series-2' },
      { id: 'g-people', label: 'Collaborators', kind: 'person', wraps: ['person-ada', 'person-ada-calib-cadence'], color_token: 'series-5' },
    ],
    nodes: [
      { id: 'exp-0412', kind: 'record', label: 'ORB-SLAM3 on hall-loop', sublabel: 'ATE 0.042 m', room: 'experiments', record_id: 'exp-0412', group: 'g-slam', weight: 0.7, tags: ['slam', 'indoor'], color_token: 'series-2', status: 'accepted',
        fields: { title: 'ORB-SLAM3 on hall-loop', metric: 'ATE', value: 0.042, run_on: '2026-09-18', tags: ['slam', 'indoor'] },
        provenance: OWN(SRC('record', 'experiments/exp-0412', '9b1c'), '2026-09-18', { happened_on: '2026-09-18', remembered_on: '2026-09-19' }),
        audience: AUD('private'), evidence_ids: ['ev-1'] },
      { id: 'paper-orb3', kind: 'record', label: 'ORB-SLAM3 (Campos 2021)', room: 'papers', record_id: 'paper-orb3', group: 'g-slam', weight: 0.5, tags: ['slam'], color_token: 'series-3', status: 'accepted',
        provenance: OWN(SRC('record', 'papers/paper-orb3', '11aa'), '2026-08-02'), audience: AUD('public'), evidence_ids: [] },
      { id: 'robot-hb1', kind: 'asset', label: 'Hallbot 1', room: 'robots', record_id: 'robot-hb1', weight: 0.4, tags: ['hardware'], color_token: 'series-4', status: 'accepted',
        provenance: OWN(SRC('record', 'robots/robot-hb1', 'a0a0'), '2026-07-10'), audience: AUD('private'), evidence_ids: [] },
      { id: 'person-ada', kind: 'person', label: 'Ada (structural)', group: 'g-people', weight: 0.3, tags: ['structural-engineering'], color_token: 'series-5', status: 'accepted',
        provenance: OWN(SRC('record', 'contacts/ada', 'c4c4'), '2026-06-01'), audience: AUD('sensitive'), evidence_ids: [] },
      { id: 'person-ada-calib-cadence', kind: 'boundary', label: 'Inspection cadence by cumulative vibration', group: 'g-people', weight: 0.3, tags: ['vibration', 'inspection'], color_token: 'foreign', status: 'accepted',
        provenance: { owner_person_id: 'ada', source: SRC('share', 'projection:ada-to-self-20260920', 'e7e7'), captured_on: '2026-09-20', released_on: '2026-09-20', imported_via_rule_ref: 'ada/rule-01' },
        audience: AUD('private'),
        boundary: { rule_ref: 'ada/rule-01', digest: fakeDigest('e7e7'), shared_by: 'ada', released_on: '2026-09-20', expires_on: '2027-09-20', key_id: 'ada-k1' },
        evidence_ids: ['ev-2'] },
      { id: 'idea-vib-cadence', kind: 'idea', label: 'Recalibrate IMU by cumulative vibration, not calendar', weight: 0.6, tags: ['vibration', 'calibration'], color_token: 'accent', status: 'proposal',
        provenance: OWN(SRC('run', 'run-20261001-01', 'f1f1'), '2026-10-01', { derived_from: [{ person_id: 'ada', rule_ref: 'ada/rule-01', key_id: 'ada-k1' }] }),
        audience: AUD('private'), evidence_ids: ['ev-1', 'ev-2'] },
    ],
    edges: [
      { id: 'e1', from: 'exp-0412', to: 'paper-orb3', kind: 'cites', directed: true, variant: 'solid', route: 'auto' },
      { id: 'e2', from: 'exp-0412', to: 'robot-hb1', kind: 'depends', directed: true, variant: 'solid', route: 'auto' },
      { id: 'e3', from: 'person-ada', to: 'person-ada-calib-cadence', kind: 'share', directed: true, variant: 'dashed', route: 'auto', rule_ref: 'ada/rule-01' },
      { id: 'e4', from: 'idea-vib-cadence', to: 'person-ada-calib-cadence', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' },
      { id: 'e5', from: 'idea-vib-cadence', to: 'exp-0412', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' },
    ],
    positions: { 'exp-0412': [612, 418], 'paper-orb3': [748, 505], 'robot-hb1': [430, 560], 'person-ada': [1110, 420], 'person-ada-calib-cadence': [1180, 540], 'idea-vib-cadence': [880, 300] },
    laid_out: true,
    views: {
      '2d': { layout: 'cluster-disc', seed: 7, viewBox: [0, 0, 1600, 1000] },
      '3d': { layout: 'lift', scale_m: 6, camera: { position: [0, 2.2, 8], target: [0, 0, 0] }, lift: { mode: 'group-weight', amplitude_m: 1.5 } },
      vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6, entry_node: 'exp-0412', label_budget: 64 },
      time: { axis: 'date', field: 'happened_on', from: '2026-06-01', to: '2026-10-01', step: 'week', playhead: null, cumulative: true, motion: 'still' },
      interactive: { focus: 'exp-0412', reach: 'both',
        lenses: [{ id: 'mine', label: 'Mine only', match: { owner: ['self'] } }, { id: 'slam', label: 'SLAM', match: { groups: ['g-slam'] } }],
        presentation: ['exp-0412', 'paper-orb3', 'idea-vib-cadence'], deep_link: true,
        steps: [{ id: 's1', label: 'The experiment', nodes: ['exp-0412', 'paper-orb3'] }, { id: 's2', label: 'The idea', nodes: ['idea-vib-cadence', 'person-ada-calib-cadence'], edges: ['e4'] }] },
    },
    evidence: [
      { id: 'ev-1', kind: 'record', ref: 'experiments/exp-0412', digest: fakeDigest('9b1c'), label: 'SRC 1' },
      { id: 'ev-2', kind: 'projection', ref: 'data/overlays/ada.json#person-ada-calib-cadence', digest: fakeDigest('e7e7'), label: 'SRC 2' },
    ],
  };
}

/** A metric rig room from the robotics-lab pack: benches are zones, robots carry pose_m. */
export function roomScene() {
  const asset = (id, label, group, xyz, size, seed, captured, tags) => ({
    id, kind: 'asset', label, room: 'robots', record_id: id, group, weight: 0.5, tags, color_token: 'series-4', status: 'accepted',
    pose_m: { xyz, rpy: [0, 0, 0] }, size_m: size, provenance: OWN(SRC('record', `robots/${id}`, seed), captured), audience: AUD('private'), evidence_ids: [],
  });
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'room',
    meta: { id: 'hall-lab-rig', title: 'Hall Lab — rig room', output: 'out.html', theme: 'field', quality: 'checked', units: 'm', up_axis: 'y', privacy_mode: 'synthetic_data', maturity: 'prototype', legend: true, room: 'robots', view: 'rig' },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups: [
      { id: 'bench-a', label: 'Bench A', kind: 'zone', center_xyz_m: [-1.5, 0.5, 0.5], size_xyz_m: [3, 1, 2], color_token: 'series-1' },
      { id: 'bench-b', label: 'Bench B', kind: 'zone', center_xyz_m: [2, 0.6, -0.5], size_xyz_m: [1.5, 1.4, 1.5], color_token: 'series-2' },
    ],
    nodes: [
      { ...asset('robot-hb1', 'Hallbot 1', 'bench-a', [-2, 0.4, 0], [0.6, 0.8, 0.6], 'a0a0', '2026-07-10', ['hardware', 'mobile']), evidence_ids: ['ev-1'] },
      asset('robot-hb2', 'Hallbot 2', 'bench-a', [-1, 0.4, 0.5], [0.6, 0.8, 0.6], 'a1a1', '2026-07-12', ['hardware', 'mobile']),
      asset('lidar-rig', 'Lidar test rig', 'bench-b', [2, 0.6, -0.5], [0.4, 1.2, 0.4], 'b2b2', '2026-08-01', ['hardware', 'sensor']),
      { id: 'dock-1', kind: 'place', label: 'Charging dock', room: 'robots', record_id: 'dock-1', group: 'bench-a', weight: 0.3, tags: ['power'], color_token: 'muted', status: 'accepted',
        pose_m: { xyz: [-2.5, 0.1, 1.2], rpy: [0, 0, 0] }, size_m: [0.5, 0.2, 0.5], provenance: OWN(SRC('record', 'robots/dock-1', 'd0d0'), '2026-07-10'), audience: AUD('private'), evidence_ids: [] },
      { id: 'note-estop', kind: 'note', label: 'E-stop check before every run', room: 'notes', record_id: 'note-estop', weight: 0.6, tags: ['safety', 'estop'], color_token: 'warn', status: 'accepted',
        pose_m: { xyz: [0, 1.5, -2.5], rpy: [0, 0, 0] }, provenance: OWN(SRC('record', 'notes/note-estop', 'e5e5'), '2026-09-01', { happened_on: '2026-09-01' }), audience: AUD('private'), evidence_ids: ['ev-2'] },
    ],
    edges: [
      { id: 'e1', from: 'robot-hb1', to: 'lidar-rig', kind: 'depends', directed: true, variant: 'solid', route: 'auto' },
      { id: 'e2', from: 'dock-1', to: 'robot-hb2', kind: 'contains', directed: true, variant: 'solid', route: 'straight' },
      { id: 'e3', from: 'note-estop', to: 'robot-hb1', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' },
    ],
    positions: { 'robot-hb1': [300, 400], 'robot-hb2': [450, 475], 'lidar-rig': [900, 325], 'dock-1': [225, 580], 'note-estop': [600, 60] },
    laid_out: true,
    views: {
      '2d': { layout: 'metric', seed: 0, viewBox: [0, 0, 1200, 800] },
      '3d': { layout: 'metric', scale_m: 1, camera: { position: [0, 3, 6], target: [0, 0.5, 0] } },
      vr: { enabled: true, scale_m: 1, floor_y: 0, eye_height_m: 1.6, entry_node: 'robot-hb1', label_budget: 32 },
      interactive: { focus: 'robot-hb1', reach: 'both', lenses: [{ id: 'hardware', label: 'Hardware', match: { kinds: ['asset'] } }], presentation: ['robot-hb1', 'lidar-rig'], deep_link: true },
    },
    evidence: [
      { id: 'ev-1', kind: 'record', ref: 'robots/robot-hb1', digest: fakeDigest('a0a0'), label: 'SRC 1' },
      { id: 'ev-2', kind: 'record', ref: 'notes/note-estop', digest: fakeDigest('e5e5'), label: 'SRC 2' },
    ],
  };
}

/** A dated run history: events in order, one proposed next run from a dry agent run. */
export function timelineScene() {
  const runs = [['exp-0401', 'Loop closure baseline', '2026-09-02', ['slam'], '0401'], ['exp-0402', 'IMU bias sweep', '2026-09-05', ['imu', 'calibration'], '0402'],
    ['exp-0403', 'Hall-loop at 1.2 m/s', '2026-09-09', ['slam', 'indoor'], '0403'], ['exp-0404', 'Stairwell attempt', '2026-09-12', ['slam', 'failed'], '0404'],
    ['exp-0405', 'Hall-loop with wheel odometry', '2026-09-18', ['slam', 'indoor'], '0405']];
  const nodes = runs.map(([id, label, on, tags, seed]) => ({
    id, kind: 'event', label, room: 'experiments', record_id: id, group: 'g-sept', weight: tags.includes('failed') ? 0.3 : 0.6, tags, color_token: tags.includes('failed') ? 'warn' : 'series-2', status: 'accepted',
    provenance: OWN(SRC('record', `experiments/${id}`, seed), on, { happened_on: on, remembered_on: on }), audience: AUD('private'), evidence_ids: [],
  }));
  nodes.push({ id: 'exp-0406-plan', kind: 'event', label: 'Planned: stairwell with wheel odometry', room: 'experiments', record_id: 'exp-0406-plan', weight: 0.5, tags: ['slam', 'planned'], color_token: 'accent', status: 'proposal',
    provenance: OWN(SRC('run', 'run-20260920-02', '0406'), '2026-09-20', { happened_on: '2026-10-05' }), audience: AUD('private'), evidence_ids: ['ev-1'] });
  const edges = runs.slice(1).map(([id], i) => ({ id: `e${i + 1}`, from: runs[i][0], to: id, kind: 'precedes', directed: true, variant: 'solid', route: 'straight', order: i + 1 }));
  edges.push({ id: 'e5', from: 'exp-0405', to: 'exp-0406-plan', kind: 'precedes', directed: true, variant: 'dashed', route: 'straight', order: 5 });
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'timeline',
    meta: { id: 'run-history', title: 'Experiments — run history', output: 'out.html', theme: 'paper', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'local_beta', legend: true, room: 'experiments', view: 'timeline' },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups: [{ id: 'g-sept', label: 'September runs', kind: 'region', wraps: runs.map(([id]) => id), color_token: 'series-2' }],
    nodes,
    edges,
    positions: { 'exp-0401': [150, 500], 'exp-0402': [370, 500], 'exp-0403': [590, 500], 'exp-0404': [810, 500], 'exp-0405': [1030, 500], 'exp-0406-plan': [1250, 500] },
    laid_out: true,
    views: {
      '2d': { layout: 'timeline', seed: 3, viewBox: [0, 0, 1600, 1000] },
      '3d': { layout: 'tier-wall', scale_m: 5, camera: { position: [0, 1.6, 7], target: [0, 1, 0] } },
      vr: { enabled: false },
      interactive: { focus: 'exp-0403', reach: 'both', lenses: [{ id: 'failed', label: 'Failed runs', match: { tags: ['failed'] } }], presentation: ['exp-0401', 'exp-0404', 'exp-0405'], deep_link: true },
    },
    evidence: [{ id: 'ev-1', kind: 'run', ref: 'run-20260920-02', digest: fakeDigest('0406'), label: 'SRC 1' }],
  };
}

/** An archify dataflow imported as kind workflow; the source attributes round-trip under ext.archify. */
export function workflowScene() {
  const src = SRC('import', 'import:archify/telemetry.archify.json', '7a7a');
  const step = (id, kind, label, group, tags, token) => ({
    id, kind, label, group, weight: 0.5, tags, color_token: token, status: 'accepted', provenance: OWN(src, '2026-09-25'), audience: AUD('private'), evidence_ids: ['ev-1'],
  });
  const flow = (i, from, to, label) => ({ id: `f${i}`, from, to, kind: 'flow', directed: true, label, order: i, variant: 'flow', route: 'orthogonal' });
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'workflow',
    meta: { id: 'telemetry-pipeline', title: 'Telemetry pipeline (archify dataflow)', output: 'out.html', theme: 'studio', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype', legend: true },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups: [
      { id: 'z-edge', label: 'Edge', kind: 'zone', wraps: ['src-rosbag', 'svc-ingest'], color_token: 'series-1' },
      { id: 'z-core', label: 'Core', kind: 'zone', wraps: ['svc-sync', 'store-parquet', 'svc-eval'], color_token: 'series-3' },
      { id: 'z-out', label: 'Outputs', kind: 'zone', wraps: ['out-report'], color_token: 'series-6' },
    ],
    nodes: [
      step('src-rosbag', 'file', 'rosbag capture', 'z-edge', ['input'], 'series-1'),
      step('svc-ingest', 'asset', 'Ingest service', 'z-edge', ['service'], 'series-1'),
      step('svc-sync', 'asset', 'Time sync', 'z-core', ['service'], 'series-3'),
      step('store-parquet', 'file', 'Parquet store', 'z-core', ['storage'], 'series-3'),
      step('svc-eval', 'asset', 'Evaluation job', 'z-core', ['service', 'metric'], 'series-3'),
      step('out-report', 'file', 'Run report', 'z-out', ['output'], 'series-6'),
    ],
    edges: [
      flow(1, 'src-rosbag', 'svc-ingest', 'bag → frames'), flow(2, 'svc-ingest', 'svc-sync', 'frames'), flow(3, 'svc-sync', 'store-parquet', 'aligned rows'),
      flow(4, 'store-parquet', 'svc-eval', 'rows'), flow(5, 'svc-eval', 'out-report', 'ATE, RPE'),
    ],
    positions: { 'src-rosbag': [300, 250], 'svc-ingest': [800, 250], 'svc-sync': [1300, 250], 'store-parquet': [300, 650], 'svc-eval': [800, 650], 'out-report': [1300, 650] },
    laid_out: true,
    views: {
      '2d': { layout: 'grid', seed: 0, viewBox: [0, 0, 1600, 900], columns: 3 },
      '3d': { layout: 'lift', scale_m: 6, camera: { position: [0, 2.5, 8], target: [0, 0, 0] }, lift: { mode: 'group-weight', amplitude_m: 1 } },
      vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6, entry_node: 'svc-ingest', label_budget: 32 },
      time: { axis: 'order', step: 'beat', playhead: null, motion: 'trace', trace: { beads: 3 } },
      interactive: { focus: 'svc-ingest', reach: 'out', lenses: [{ id: 'services', label: 'Services', match: { tags: ['service'] } }], presentation: ['src-rosbag', 'svc-sync', 'out-report'], deep_link: true },
    },
    evidence: [{ id: 'ev-1', kind: 'import', ref: 'import:archify/telemetry.archify.json', digest: fakeDigest('7a7a'), label: 'SRC 1' }],
    ext: {
      archify: {
        source: 'telemetry.archify.json', diagram_type: 'dataflow', archify_version: '1',
        nodes: { 'src-rosbag': { type: 'datasource', tech: 'rosbag2' }, 'svc-ingest': { type: 'service', tech: 'node' }, 'svc-sync': { type: 'service', tech: 'python' },
          'store-parquet': { type: 'datastore', tech: 'parquet' }, 'svc-eval': { type: 'job', tech: 'python' }, 'out-report': { type: 'artifact', tech: 'markdown' } },
      },
    },
  };
}

/** A node of a sketch-shaped example: provenance names the sketch it was expanded from. */
const sketchNode = (sketch) => (id, kind, label, color_token, seed, extra = {}) => ({
  id, kind, label, weight: 0.5, tags: [], color_token, status: 'accepted', ...extra,
  provenance: OWN(SRC('import', `sketch:${sketch}`, seed), '2026-10-07'), audience: AUD('private'), evidence_ids: ['ev-1'],
});
const sketchEvidence = (sketch, seed) => [{ id: 'ev-1', kind: 'import', ref: `sketch:${sketch}`, digest: fakeDigest(seed), label: 'SRC 1' }];
const META = (id, title, extra = {}) => ({ id, title, output: 'out.html', theme: 'studio', quality: 'showcase', privacy_mode: 'synthetic_data', maturity: 'prototype', legend: true, ...extra });
const VIEWER = { person_id: 'self', mode: 'self', rule_refs: [] };

/** Sequence: three participants, six ordered messages (m2 and m3 share beat 2), one self message, replies dashed. */
export function sequenceScene() {
  const n = sketchNode('handoff');
  const msg = (id, from, to, label, order, variant = 'solid') => ({ id, from, to, kind: 'message', directed: true, label, order, variant, route: 'straight' });
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'sequence',
    meta: META('handoff', 'Handoff — operator to desk'),
    viewer: VIEWER,
    groups: [],
    nodes: [n('operator', 'person', 'Operator', 'series-1', '5a5a', { weight: 0.6 }), n('conductor', 'desk', 'Conductor', 'series-2', '5b5b'), n('desk-slam', 'desk', 'SLAM desk', 'series-3', '5c5c')],
    edges: [
      msg('m1', 'operator', 'conductor', 'brief', 1), msg('m2', 'conductor', 'desk-slam', 'packet', 2), msg('m3', 'conductor', 'operator', 'ack', 2, 'dashed'),
      msg('m4', 'desk-slam', 'desk-slam', 'work', 3, 'dashed'), msg('m5', 'desk-slam', 'conductor', 'result', 4, 'dashed'), msg('m6', 'desk-slam', 'operator', 'summary', 5),
    ],
    views: {
      '2d': { layout: 'sequence', seed: 0 },
      '3d': { layout: 'lift', scale_m: 6, camera: { position: [0, 2.2, 8], target: [0, 0, 0] } },
      vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6, entry_node: 'operator', label_budget: 32 },
      time: { axis: 'order', step: 'beat', playhead: null, motion: 'still' },
      interactive: { focus: 'conductor', reach: 'both', deep_link: true,
        steps: [{ id: 's1', label: 'The brief', nodes: ['operator', 'conductor'], edges: ['m1'], playhead: 1 }, { id: 's2', label: 'The answer', nodes: ['desk-slam', 'operator'], edges: ['m6'], playhead: 5 }] },
    },
    evidence: sketchEvidence('handoff', '5d5d'),
  };
}

/** Lifecycle: five pill states (draft initial, archived final), seven transitions with a review loop, a self transition and a withdraw shortcut. */
export function lifecycleScene() {
  const n = sketchNode('review-cycle');
  const st = (id, label, color_token, seed, tags = []) => n(id, 'event', label, color_token, seed, { tags, shape: 'pill' });
  const tr = (id, from, to, label, order, variant = 'solid') => ({ id, from, to, kind: 'transition', directed: true, label, order, variant, route: 'orthogonal' });
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'lifecycle',
    meta: META('review-cycle', 'Paper — review cycle'),
    viewer: VIEWER,
    groups: [],
    nodes: [st('draft', 'Draft', 'series-1', '6a6a', ['initial']), st('review', 'In review', 'series-2', '6b6b'), st('revise', 'Revising', 'warn', '6c6c'),
      st('approved', 'Approved', 'good', '6d6d'), st('archived', 'Archived', 'muted', '6e6e', ['final'])],
    edges: [
      tr('t1', 'draft', 'review', 'submit', 1), tr('t2', 'review', 'revise', 'changes asked', 2), tr('t3', 'revise', 'review', 'resubmit', 3, 'dashed'),
      tr('t4', 'review', 'review', 'reassign', 4, 'dashed'), tr('t5', 'review', 'approved', 'approve', 5), tr('t6', 'approved', 'archived', 'archive', 6),
      tr('t7', 'draft', 'archived', 'withdraw', 7, 'dashed'),
    ],
    views: {
      '2d': { layout: 'lifecycle', direction: 'right', seed: 0, spacing: 88, viewBox: [0, 0, 1200, 720] },
      '3d': { layout: 'lift', scale_m: 6, camera: { position: [0, 2.2, 8], target: [0, 0, 0] } },
      vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6, entry_node: 'draft', label_budget: 32 },
      time: { axis: 'order', step: 'beat', playhead: null, motion: 'playback' },
      interactive: { focus: 'review', reach: 'both', deep_link: true },
    },
    evidence: sketchEvidence('review-cycle', '6f6f'),
  };
}

/** Architecture: twelve components in three zones, layered top-down, orthogonal channel routes, two authored port hints. */
export function architectureScene() {
  const n = sketchNode('telemetry-platform');
  const c = (id, kind, label, group, tags, seed) => n(id, kind, label, ZONE_TOKEN[group], seed, { group, tags });
  const flow = (i, from, to, label, extra = {}) => ({ id: `e${i}`, from, to, kind: 'flow', directed: true, ...(label ? { label } : {}), variant: 'solid', route: 'orthogonal', ...extra });
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'workflow',
    meta: META('telemetry-platform', 'Telemetry platform — architecture'),
    viewer: VIEWER,
    groups: [
      { id: 'z-edge', label: 'Edge', kind: 'zone', wraps: ['src-robots', 'svc-gateway', 'svc-recorder', 'file-bags'], color_token: 'series-1' },
      { id: 'z-core', label: 'Core', kind: 'zone', wraps: ['svc-ingest', 'svc-sync', 'store-lake', 'svc-eval'], color_token: 'series-3' },
      { id: 'z-out', label: 'Outputs', kind: 'zone', wraps: ['svc-api', 'out-dash', 'out-report', 'person-ops'], color_token: 'series-6' },
    ],
    nodes: [
      c('src-robots', 'asset', 'Robot fleet', 'z-edge', ['input'], '7a01'), c('svc-gateway', 'asset', 'MQTT gateway', 'z-edge', ['service'], '7a02'),
      c('svc-recorder', 'asset', 'Bag recorder', 'z-edge', ['service'], '7a03'), c('file-bags', 'file', 'rosbag archive', 'z-edge', ['storage'], '7a04'),
      c('svc-ingest', 'asset', 'Ingest', 'z-core', ['service'], '7a05'), c('svc-sync', 'asset', 'Time sync', 'z-core', ['service'], '7a06'),
      c('store-lake', 'file', 'Parquet lake', 'z-core', ['storage'], '7a07'), c('svc-eval', 'asset', 'Eval jobs', 'z-core', ['service', 'metric'], '7a08'),
      c('svc-api', 'asset', 'Query API', 'z-out', ['service'], '7a09'), c('out-dash', 'file', 'Dashboard', 'z-out', ['output'], '7a0a'),
      c('out-report', 'file', 'Run report', 'z-out', ['output'], '7a0b'), c('person-ops', 'person', 'Operator', 'z-out', ['people'], '7a0c'),
    ],
    edges: [
      flow(1, 'src-robots', 'svc-gateway', 'telemetry'), flow(2, 'src-robots', 'svc-recorder', 'raw topics'), flow(3, 'svc-gateway', 'svc-ingest', 'frames'),
      flow(4, 'svc-recorder', 'file-bags'), flow(5, 'svc-ingest', 'store-lake', 'rows'), flow(6, 'file-bags', 'store-lake', 'replay', { from_side: 'right' }),
      flow(7, 'svc-ingest', 'svc-sync', 'stamps'), flow(8, 'svc-sync', 'svc-eval'), flow(9, 'store-lake', 'svc-eval'),
      flow(10, 'store-lake', 'svc-api', null, { to_side: 'top' }), flow(11, 'svc-eval', 'out-report', 'ATE, RPE'), flow(12, 'svc-api', 'out-dash'),
      flow(13, 'person-ops', 'svc-api', 'queries'),
    ],
    views: {
      '2d': { layout: 'layered', direction: 'down', seed: 0 },
      '3d': { layout: 'lift', scale_m: 6, camera: { position: [0, 2.5, 8], target: [0, 0, 0] }, lift: { mode: 'group-weight', amplitude_m: 1 } },
      vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6, entry_node: 'svc-ingest', label_budget: 32 },
      interactive: { focus: 'svc-ingest', reach: 'both', lenses: [{ id: 'services', label: 'Services', match: { tags: ['service'] } }, { id: 'core', label: 'Core', match: { groups: ['z-core'] } }],
        presentation: ['src-robots', 'svc-ingest', 'store-lake', 'person-ops'], deep_link: true },
    },
    evidence: sketchEvidence('telemetry-platform', '7f7f'),
  };
}
const ZONE_TOKEN = { 'z-edge': 'series-1', 'z-core': 'series-3', 'z-out': 'series-6' };

/** A routed scene laid out cold through lib/layout: positions, dense routes, sparse labels, plan and viewBox, as render writes them. */
export function laidOut(scene) {
  return layoutDetailed(scene, { force: true, tokensCss: TOKENS_CSS }).scene;
}

/**
 * A hand-placed scene with the plan a cold run of its mode writes (the committed positions are kept). Only
 * scene-graph, the VISION §4 example whose positions test/ir-gates.test.js pins, is built this way (V2_PLAN §3:
 * the one exemption from "committed tables are cold-run outputs"); every other example is laidOut().
 */
export function withPlan(scene) {
  const { plan } = layoutDetailed(scene, { force: true, tokensCss: TOKENS_CSS });
  return { ...scene, views: { ...scene.views, '2d': { ...scene.views['2d'], plan } } };
}

const FINAL = { sourceSeed: '0b0b', tokensSeed: '0b0b', checksPassed: 31 };
/** name -> finalized scene, exactly what examples/<name>.json holds. */
export function examples() {
  return {
    'scene-graph': finalize(withPlan(graphScene()), { ...FINAL, receiptId: 'rcpt_20261001T101500Z_7f3a', sourceSeed: '33d3' }),
    'scene-room': finalize(laidOut(roomScene()), { ...FINAL, receiptId: 'rcpt_20261001T101500Z_2b61', sourceSeed: '44d4' }),
    'scene-timeline': finalize(laidOut(timelineScene()), { ...FINAL, receiptId: 'rcpt_20261001T101500Z_c0de', sourceSeed: '55d5' }),
    'scene-workflow': finalize(laidOut(workflowScene()), { ...FINAL, receiptId: 'rcpt_20261001T101500Z_9a9a', sourceSeed: '66d6' }),
    'scene-sequence': finalize(laidOut(sequenceScene()), { ...FINAL, receiptId: 'rcpt_20261007T090000Z_5e01', sourceSeed: '77d7' }),
    'scene-lifecycle': finalize(laidOut(lifecycleScene()), { ...FINAL, receiptId: 'rcpt_20261007T090000Z_1c02', sourceSeed: '88d8' }),
    'scene-architecture': finalize(laidOut(architectureScene()), { ...FINAL, receiptId: 'rcpt_20261007T090000Z_a703', sourceSeed: '99d9' }),
  };
}
