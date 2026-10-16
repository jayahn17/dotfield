// Writes test/fixtures/ir/<CODE>.{fail,pass}.json (one pair per DF_IR_* and
// DF_PRIVACY_* code plus DF_RENDER_UNPROJECTED) and examples/scene-*.json
// from examples.mjs (owned by examples-recipes; this file only writes it). Byte-reproducible: ir-gates.test.js fails when a
// committed file drifts from this generator.
//
//   node test/fixtures/ir/build-fixtures.mjs           write both sets
//   node test/fixtures/ir/build-fixtures.mjs --check   exit 1 on any drift
//
// Fixture shape: {code, expect: "fail"|"pass", why, ctx?, expand?, scene}.
// `ctx` is merged over the test's default gate context; `expand` grows the
// scene at load time (expandFixture) so the 2001-node and 1 MB cases stay
// small on disk. Every fixture is schema-valid, so each isolates one rule.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stamp } from '../../../lib/gates/privacy.mjs';
import { codesForFamily } from '../../../lib/rules.mjs';
import { examples, fakeDigest } from './examples.mjs';

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(FIXTURE_DIR, '..', '..', '..');
export const FIXTURE_SESSION_KEY = 'dotfield-fixture-session-key';
export const FIXTURE_CODES = Object.freeze([...codesForFamily('ir'), ...codesForFamily('privacy'), 'DF_RENDER_UNPROJECTED']);
const HAND_TYPED_MAC = `hmac-sha256:${'4c4c'.repeat(16)}`;

const AUD = (privacy_level, share_rule_ids = []) => ({ privacy_level, share_rule_ids });
const SRC = (kind, ref, seed) => ({ kind, ref, digest: fakeDigest(seed) });
const OWN = (source, captured_on, extra = {}) => ({ owner_person_id: 'self', source, captured_on, ...extra });
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A small valid graph: two records in one region, one free note, two edges. */
export function base() {
  return {
    schema_version: 'dotfield.scene/1',
    kind: 'graph',
    meta: { id: 'fixture-graph', title: 'Fixture graph', theme: 'studio', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype', legend: true },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups: [{ id: 'g-a', label: 'Region A', kind: 'region', wraps: ['n-1', 'n-2'], color_token: 'series-1' }],
    nodes: [
      { id: 'n-1', kind: 'record', label: 'One', room: 'notes', record_id: 'note-1', group: 'g-a', weight: 0.6, tags: ['a'], color_token: 'series-1', status: 'accepted',
        fields: { title: 'One', tags: ['a'] }, provenance: OWN(SRC('record', 'notes/note-1', '1111'), '2026-09-01'), audience: AUD('private'), evidence_ids: ['ev-1'] },
      { id: 'n-2', kind: 'record', label: 'Two', room: 'notes', record_id: 'note-2', group: 'g-a', weight: 0.4, tags: ['b'], color_token: 'series-2', status: 'accepted',
        provenance: OWN(SRC('record', 'notes/note-2', '2222'), '2026-09-02'), audience: AUD('public'), evidence_ids: [] },
      { id: 'n-3', kind: 'note', label: 'Three', weight: 0.5, tags: [], color_token: 'muted', status: 'accepted',
        provenance: OWN(SRC('record', 'notes/note-3', '3333'), '2026-09-03'), audience: AUD('private'), evidence_ids: [] },
    ],
    edges: [
      { id: 'e1', from: 'n-1', to: 'n-2', kind: 'cites', directed: true, variant: 'solid', route: 'auto' },
      { id: 'e2', from: 'n-3', to: 'n-1', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' },
    ],
    positions: { 'n-1': [400, 300], 'n-2': [700, 300], 'n-3': [550, 600] },
    laid_out: true,
    views: { '2d': { layout: 'cluster-disc', seed: 1, viewBox: [0, 0, 1200, 800] }, interactive: { focus: 'n-1', reach: 'both', lenses: [{ id: 'a', label: 'Region A', match: { groups: ['g-a'] } }] } },
    evidence: [{ id: 'ev-1', kind: 'record', ref: 'notes/note-1', digest: fakeDigest('1111'), label: 'SRC 1' }],
  };
}

/** base() plus a contact, a boundary stub shared by ada under ada/rule-01, and a derived idea. */
export function shared() {
  const s = base();
  s.groups.push({ id: 'g-people', label: 'People', kind: 'person', wraps: ['person-ada', 'person-ada-stub'], color_token: 'series-5' });
  s.nodes.push(
    { id: 'person-ada', kind: 'person', label: 'Ada', group: 'g-people', weight: 0.3, tags: [], color_token: 'series-5', status: 'accepted',
      provenance: OWN(SRC('record', 'contacts/ada', 'c4c4'), '2026-06-01'), audience: AUD('sensitive'), evidence_ids: [] },
    { id: 'person-ada-stub', kind: 'boundary', label: 'Shared cadence', group: 'g-people', weight: 0.3, tags: ['vibration'], color_token: 'foreign', status: 'accepted',
      fields: { title: 'Shared cadence' },
      provenance: { owner_person_id: 'ada', source: SRC('share', 'projection:ada-to-self-20260920', 'e7e7'), captured_on: '2026-09-20', released_on: '2026-09-20', imported_via_rule_ref: 'ada/rule-01' },
      audience: AUD('private'), boundary: { rule_ref: 'ada/rule-01', digest: fakeDigest('e7e7'), shared_by: 'ada', released_on: '2026-09-20', key_id: 'ada-k1' }, evidence_ids: ['ev-2'] },
    { id: 'idea-1', kind: 'idea', label: 'Derived idea', weight: 0.5, tags: [], color_token: 'accent', status: 'proposal',
      provenance: OWN(SRC('run', 'run-20261001-01', 'f1f1'), '2026-10-01', { derived_from: [{ person_id: 'ada', rule_ref: 'ada/rule-01', key_id: 'ada-k1' }] }),
      audience: AUD('private'), evidence_ids: ['ev-1', 'ev-2'] },
  );
  s.edges.push(
    { id: 'e-share', from: 'person-ada', to: 'person-ada-stub', kind: 'share', directed: true, variant: 'dashed', route: 'auto', rule_ref: 'ada/rule-01' },
    { id: 'e-idea', from: 'idea-1', to: 'person-ada-stub', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' },
  );
  Object.assign(s.positions, { 'person-ada': [1000, 300], 'person-ada-stub': [1000, 600], 'idea-1': [800, 450] });
  s.evidence.push({ id: 'ev-2', kind: 'projection', ref: 'data/overlays/ada.json#person-ada-stub', digest: fakeDigest('e7e7'), label: 'SRC 2' });
  return s;
}

/** A meet scene: one local node per side and a candidate edge between them. */
export function meet() {
  const s = base();
  s.kind = 'meet';
  s.meta = { ...s.meta, id: 'fixture-meet', title: 'Fixture meet' };
  s.groups = [{ id: 'left', label: 'Experiments', kind: 'region', wraps: ['n-1'] }, { id: 'right', label: 'Papers', kind: 'region', wraps: ['n-2'] }];
  s.nodes[0].group = 'left';
  s.nodes[1].group = 'right';
  s.edges.push({ id: 'cand-1', from: 'n-1', to: 'n-2', kind: 'candidate', directed: false, variant: 'dashed', route: 'auto', weight: 0.7 });
  s.views = { '2d': { layout: 'lanes', seed: 1, viewBox: [0, 0, 1200, 800] } };
  return s;
}

/** A participant or a state: a node with import provenance and no room. */
function plain(id, kind, label, seed, captured_on, color_token, extra = {}) {
  return { id, kind, label, weight: 0.5, tags: [], color_token, status: 'accepted', ...extra,
    provenance: OWN(SRC('import', `sketch:fixture#${id}`, seed), captured_on), audience: AUD('private'), evidence_ids: ['ev-1'] };
}

/** A sequence scene: three participants, three ordered message edges (one a self message), dense routes. */
export function sequence() {
  const s = base();
  s.kind = 'sequence';
  s.meta = { ...s.meta, id: 'fixture-sequence', title: 'Fixture sequence' };
  s.groups = [];
  s.nodes = [plain('n-1', 'person', 'Operator', '5151', '2026-09-01', 'series-1'), plain('n-2', 'desk', 'Conductor', '5252', '2026-09-01', 'series-2'), plain('n-3', 'desk', 'Desk', '5353', '2026-09-01', 'series-3')];
  s.edges = [
    { id: 'm1', from: 'n-1', to: 'n-2', kind: 'message', directed: true, label: 'brief', order: 1, variant: 'solid', route: 'straight' },
    { id: 'm2', from: 'n-2', to: 'n-3', kind: 'message', directed: true, label: 'packet', order: 2, variant: 'solid', route: 'straight' },
    { id: 'm3', from: 'n-3', to: 'n-3', kind: 'message', directed: true, label: 'work', order: 3, variant: 'dashed', route: 'straight' },
  ];
  s.positions = { 'n-1': [300, 140], 'n-2': [800, 140], 'n-3': [1300, 140] };
  s.routes = { m1: [[300, 236], [800, 236]], m2: [[800, 332], [1300, 332]], m3: [[1300, 428], [1340, 428], [1340, 468], [1300, 468]] };
  s.views = { '2d': { layout: 'sequence', viewBox: [0, 0, 1600, 700], plan: { mode: 'sequence', beats: 3 } }, time: { axis: 'order', step: 'beat', playhead: null, motion: 'still' } };
  return s;
}

/** A lifecycle scene: three pill states (initial, middle, final), ordered transitions with a back edge, dense routes. */
export function lifecycle() {
  const s = base();
  s.kind = 'lifecycle';
  s.meta = { ...s.meta, id: 'fixture-lifecycle', title: 'Fixture lifecycle' };
  s.groups = [];
  s.nodes = [
    plain('draft', 'event', 'Draft', '6161', '2026-09-01', 'series-1', { tags: ['initial'], shape: 'pill' }),
    plain('review', 'event', 'Review', '6262', '2026-09-02', 'series-2', { shape: 'pill' }),
    plain('done', 'event', 'Done', '6363', '2026-09-03', 'good', { tags: ['final'], shape: 'pill' }),
  ];
  s.edges = [
    { id: 't1', from: 'draft', to: 'review', kind: 'transition', directed: true, label: 'submit', order: 1, variant: 'solid', route: 'orthogonal' },
    { id: 't2', from: 'review', to: 'done', kind: 'transition', directed: true, label: 'accept', order: 2, variant: 'solid', route: 'orthogonal' },
    { id: 't3', from: 'review', to: 'draft', kind: 'transition', directed: true, label: 'reopen', order: 3, variant: 'dashed', route: 'orthogonal' },
  ];
  s.positions = { draft: [200, 300], review: [600, 300], done: [1000, 300] };
  s.routes = { t1: [[260, 300], [540, 300]], t2: [[660, 300], [940, 300]], t3: [[600, 340], [600, 420], [200, 420], [200, 340]] };
  s.views = { '2d': { layout: 'lifecycle', direction: 'right', viewBox: [0, 0, 1200, 600], plan: { mode: 'lifecycle', reversed: ['t3'], layers: 3, dummies: 0, crossings: 0 } }, time: { axis: 'order', step: 'beat', playhead: null, motion: 'still' } };
  return s;
}

const fx = (code, expect, why, scene, extra = {}) => ({ code, expect, why, ...extra, scene });
const edit = (scene, fn) => { fn(scene); return scene; };
const node = (s, id) => s.nodes.find((n) => n.id === id);
const SHAPES = { 'x-sensor': { glyph2d: 'diamond', primitive3d: 'octahedron', size_mult: 1, label_anchor: 'below' } };
const ROOMS = (fields) => [{ id: 'notes', record: { public_fields: fields } }];
const padded = (s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === 'n-3' ? { ...n, fields: { note: 'é'.repeat(500) } } : n)) });

/** Every fixture document, in FIXTURE_CODES order. */
export function fixtureDocs() {
  const docs = [
    fx('DF_IR_DUP_ID', 'fail', 'a fourth node reuses the id n-1', edit(base(), (s) => s.nodes.push({ ...clone(node(s, 'n-3')), id: 'n-1', label: 'Also one' }))),
    fx('DF_IR_DUP_ID', 'pass', 'every node id is unique', base()),
    fx('DF_IR_DANGLING_EDGE', 'fail', 'e1 points at a node that is not in nodes[]', edit(base(), (s) => { s.edges[0].to = 'ghost'; })),
    fx('DF_IR_DANGLING_EDGE', 'pass', 'every edge end resolves to a node (view references are DF_IR_DANGLING_VIEW_REF)', base()),
    fx('DF_IR_SELF_EDGE', 'fail', 'e1 connects n-1 to itself in a graph scene', edit(base(), (s) => { s.edges[0].to = 'n-1'; })),
    fx('DF_IR_SELF_EDGE', 'pass', 'a self message in a sequence scene is a loop the layout draws, not a refused edge', sequence()),
    fx('DF_IR_DUP_EDGE', 'fail', 'e3 repeats the from, to and kind of e1', edit(base(), (s) => s.edges.push({ ...s.edges[0], id: 'e3' }))),
    fx('DF_IR_DUP_EDGE', 'pass', 'the same pair with another kind is a second edge', edit(base(), (s) => s.edges.push({ id: 'e3', from: 'n-1', to: 'n-2', kind: 'relates', directed: false, variant: 'solid', route: 'auto' }))),
    fx('DF_IR_KIND_UNKNOWN', 'fail', 'an x- kind without a shapes.json row', edit(base(), (s) => { node(s, 'n-3').kind = 'x-unregistered'; })),
    fx('DF_IR_KIND_UNKNOWN', 'pass', 'an x- kind with a shapes.json row (ctx.shapes)', edit(base(), (s) => { node(s, 'n-3').kind = 'x-sensor'; }), { ctx: { shapes: SHAPES } }),
    fx('DF_IR_GROUP_UNDECLARED', 'fail', 'n-3 names a group that is not in groups[]', edit(base(), (s) => { node(s, 'n-3').group = 'g-ghost'; })),
    fx('DF_IR_GROUP_UNDECLARED', 'pass', 'every node.group and lens group is declared', base()),
    fx('DF_IR_GROUP_DUP_ID', 'fail', 'two groups share the id g-a', edit(base(), (s) => s.groups.push({ id: 'g-a', label: 'Again', kind: 'region', wraps: ['n-3'] }))),
    fx('DF_IR_GROUP_DUP_ID', 'pass', 'two groups with distinct ids', edit(base(), (s) => s.groups.push({ id: 'g-b', label: 'Region B', kind: 'region', wraps: ['n-3'] }))),
    fx('DF_IR_GROUP_MEMBER_UNKNOWN', 'fail', 'g-a wraps a node that is not in nodes[]', edit(base(), (s) => s.groups[0].wraps.push('ghost'))),
    fx('DF_IR_GROUP_MEMBER_UNKNOWN', 'pass', 'every wrapped id is a node', base()),
    fx('DF_IR_GROUP_SHAPE', 'fail', 'g-a declares both wraps[] and a metric box', edit(base(), (s) => Object.assign(s.groups[0], { center_xyz_m: [0, 0, 0], size_xyz_m: [1, 1, 1] }))),
    fx('DF_IR_GROUP_SHAPE', 'pass', 'graph groups wrap; a room group is a box', base()),
    fx('DF_IR_EVIDENCE_UNKNOWN', 'fail', 'n-1 cites an evidence id that is not in evidence[]', edit(base(), (s) => { node(s, 'n-1').evidence_ids = ['ev-ghost']; })),
    fx('DF_IR_EVIDENCE_UNKNOWN', 'pass', 'every cited evidence id exists', base()),
    fx('DF_IR_SHARE_EDGE_NO_RULE', 'fail', 'the share edge has no rule_ref', edit(shared(), (s) => { delete s.edges.find((e) => e.kind === 'share').rule_ref; })),
    fx('DF_IR_SHARE_EDGE_NO_RULE', 'pass', 'the share edge carries ada/rule-01', shared()),
    fx('DF_IR_PROPOSAL_NO_PROVENANCE', 'fail', 'a proposal whose source is a record, not a run or import', edit(base(), (s) => { node(s, 'n-3').status = 'proposal'; })),
    fx('DF_IR_PROPOSAL_NO_PROVENANCE', 'pass', 'a proposal sourced from a run', edit(base(), (s) => { node(s, 'n-3').status = 'proposal'; node(s, 'n-3').provenance.source = SRC('run', 'run-20261001-02', 'f2f2'); })),
    fx('DF_IR_BOUNDARY_BLOCK', 'fail', 'a boundary block on a note', edit(base(), (s) => { node(s, 'n-3').boundary = { rule_ref: 'ada/rule-01', digest: fakeDigest('e7e7'), shared_by: 'ada', released_on: '2026-09-20', key_id: 'ada-k1' }; })),
    fx('DF_IR_BOUNDARY_BLOCK', 'pass', 'the boundary node carries its block and no other node does', shared()),
    fx('DF_IR_CANDIDATE_OUTSIDE_MEET', 'fail', 'a candidate edge in a graph scene', edit(base(), (s) => s.edges.push({ id: 'cand-1', from: 'n-1', to: 'n-3', kind: 'candidate', directed: false, variant: 'dashed', route: 'auto' }))),
    fx('DF_IR_CANDIDATE_OUTSIDE_MEET', 'pass', 'a candidate edge in a meet scene', meet()),
    fx('DF_IR_TOO_LARGE', 'fail', '2001 nodes', base(), { expand: { clone: 'n-3', count: 1998 } }),
    fx('DF_IR_TOO_LARGE', 'pass', 'exactly 2000 nodes', base(), { expand: { clone: 'n-3', count: 1997 } }),
    fx('DF_IR_FIELDS_BUDGET', 'fail', '300 clones with 4 x 900-byte fields each (about 1.09 MB in total, every node under 4 KB)', base(), { expand: { clone: 'n-3', count: 300, fields: { keys: 4, chars: 900 } } }),
    fx('DF_IR_FIELDS_BUDGET', 'pass', '300 clones with 2 x 900-byte fields each (about 0.55 MB in total)', base(), { expand: { clone: 'n-3', count: 300, fields: { keys: 2, chars: 900 } } }),
    fx('DF_IR_FIELD_TOO_LARGE', 'fail', 'a string value of 600 two-byte characters (1200 bytes) and a 30-key map over 4 KB', edit(base(), (s) => {
      node(s, 'n-1').fields.title = 'é'.repeat(600);
      node(s, 'n-3').fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'a'.repeat(200)]));
    })),
    fx('DF_IR_FIELD_TOO_LARGE', 'pass', 'a 1000-byte string value and a map under 4 KB', padded(base())),
    fx('DF_IR_DANGLING_VIEW_REF', 'fail', 'focus, a presentation entry, a step node, a step edge and the VR entry node name ids that are not in the scene', edit(base(), (s) => {
      s.views.interactive.focus = 'ghost';
      s.views.interactive.presentation = ['n-1', 'ghost'];
      s.views.interactive.steps = [{ id: 's1', label: 'Ghosts', nodes: ['ghost'], edges: ['e-ghost'] }];
      s.views.vr = { enabled: true, entry_node: 'ghost' };
    })),
    fx('DF_IR_DANGLING_VIEW_REF', 'pass', 'every focus, presentation, step and entry_node id resolves to a node or an edge', edit(base(), (s) => {
      s.views.interactive.presentation = ['n-1', 'n-3'];
      s.views.interactive.steps = [{ id: 's1', label: 'One and two', nodes: ['n-1', 'n-2'], edges: ['e1'] }, { id: 's2', label: 'Three', caption: 'The free note.', nodes: ['n-3'], edges: ['e2'], playhead: null }];
      s.views.vr = { enabled: true, entry_node: 'n-1' };
    })),
    fx('DF_IR_ORDER_MISSING', 'fail', 'a message edge without order, and a relates edge of a sequence scene without order', edit(sequence(), (s) => {
      delete s.edges[1].order;
      s.edges.push({ id: 'r1', from: 'n-1', to: 'n-3', kind: 'relates', directed: false, variant: 'dashed', route: 'auto' });
    })),
    fx('DF_IR_ORDER_MISSING', 'pass', 'every message edge of the sequence scene carries an integer order', sequence()),
    fx('DF_IR_EDGE_ID_REQUIRED', 'fail', 'a layered workflow with an id-less flow edge, plus an id-less message edge: the router cannot key either', edit(base(), (s) => {
      s.kind = 'workflow';
      s.views['2d'] = { layout: 'layered', direction: 'down', seed: 1, viewBox: [0, 0, 1200, 800] };
      delete s.edges[0].id;
      s.edges.push({ from: 'n-1', to: 'n-3', kind: 'message', directed: true, order: 1, variant: 'solid', route: 'straight' });
    })),
    fx('DF_IR_EDGE_ID_REQUIRED', 'pass', 'every edge of the layered workflow, the message edge included, carries an id', edit(base(), (s) => {
      s.kind = 'workflow';
      s.views['2d'] = { layout: 'layered', direction: 'down', seed: 1, viewBox: [0, 0, 1200, 800] };
      s.edges.push({ id: 'm1', from: 'n-1', to: 'n-3', kind: 'message', directed: true, order: 1, variant: 'solid', route: 'straight' });
    })),
    fx('DF_IR_LIFECYCLE_NO_INITIAL', 'fail', 'a lifecycle whose states carry no initial tag', edit(lifecycle(), (s) => { for (const n of s.nodes) n.tags = n.tags.filter((t) => t !== 'initial'); })),
    fx('DF_IR_LIFECYCLE_NO_INITIAL', 'pass', 'one state is tagged initial', lifecycle()),
    fx('DF_IR_TIME_WINDOW_INVALID', 'fail', 'from after to, a playhead outside the window, and step beat on a date axis', edit(base(), (s) => {
      s.views.time = { axis: 'date', field: 'captured_on', from: '2026-10-01', to: '2026-06-01', step: 'beat', playhead: '2026-12-24', cumulative: true, motion: 'still' };
    })),
    fx('DF_IR_TIME_WINDOW_INVALID', 'pass', 'a date window with the playhead inside it and a day step', edit(base(), (s) => {
      s.views.time = { axis: 'date', field: 'captured_on', from: '2026-09-01', to: '2026-09-03', step: 'day', playhead: '2026-09-02', cumulative: true, motion: 'still' };
    })),
    fx('DF_IR_TIME_RANGE_EMPTY', 'fail', 'a date axis over happened_on when no node carries happened_on', edit(base(), (s) => {
      s.views.time = { axis: 'date', field: 'happened_on', step: 'week', playhead: null, motion: 'still' };
    })),
    fx('DF_IR_TIME_RANGE_EMPTY', 'pass', 'one node carries happened_on, so the date axis has a range', edit(base(), (s) => {
      node(s, 'n-1').provenance.happened_on = '2026-08-30';
      s.views.time = { axis: 'date', field: 'happened_on', step: 'week', playhead: null, motion: 'still' };
    })),
    fx('DF_PRIVACY_VIEWER_EXCLUDED', 'fail', 'rendered for ada with no rule: the private nodes are not hers to see', edit(base(), (s) => { s.viewer = { person_id: 'ada', mode: 'person', rule_refs: [] }; })),
    fx('DF_PRIVACY_VIEWER_EXCLUDED', 'pass', 'rendered for ada under self/rule-01, which every private node lists', edit(base(), (s) => {
      s.viewer = { person_id: 'ada', mode: 'person', rule_refs: ['self/rule-01'] };
      for (const n of s.nodes) if (n.audience.privacy_level !== 'public') n.audience.share_rule_ids = ['rule-01'];
    })),
    fx('DF_PRIVACY_FOREIGN_BODY_WITHOUT_RULE', 'fail', 'the foreign stub carries fields but names no imported_via_rule_ref', edit(shared(), (s) => { delete node(s, 'person-ada-stub').provenance.imported_via_rule_ref; })),
    fx('DF_PRIVACY_FOREIGN_BODY_WITHOUT_RULE', 'pass', 'the foreign stub records the rule it was imported under', shared()),
    fx('DF_PRIVACY_FIELD_NOT_PUBLIC', 'fail', 'n-1 carries tags but the notes room only publishes title', base(), { ctx: { rooms: ROOMS(['title']) } }),
    fx('DF_PRIVACY_FIELD_NOT_PUBLIC', 'pass', 'every field of n-1 is in the notes room public_fields', base(), { ctx: { rooms: ROOMS(['title', 'tags']) } }),
    fx('DF_PRIVACY_ABSOLUTE_PATH', 'fail', 'an evidence ref that is an absolute home path', edit(base(), (s) => { s.evidence[0].ref = '/home/someone/notes/one.md'; })),
    fx('DF_PRIVACY_ABSOLUTE_PATH', 'pass', 'every ref is repo-relative or logical', base()),
    fx('DF_PRIVACY_DERIVED_UNTAINTED', 'fail', 'the idea cites the stub evidence and relates to the stub but lists no derived_from', edit(shared(), (s) => { delete node(s, 'idea-1').provenance.derived_from; })),
    fx('DF_PRIVACY_DERIVED_UNTAINTED', 'pass', 'the idea lists ada/rule-01 in derived_from', shared()),
    fx('DF_PRIVACY_HANDLE_PRESENT', 'fail', 'a handles key with an HMAC value', edit(base(), (s) => { node(s, 'n-3').fields = { handles: [`hmac-sha256:${'ab'.repeat(32)}`] }; })),
    fx('DF_PRIVACY_HANDLE_PRESENT', 'pass', 'no handle key and no HMAC outside projected.mac', base()),
    fx('DF_PRIVACY_KEY_MATERIAL', 'fail', 'a session_key under ext', edit(base(), (s) => { s.ext = { session_key: 'not-a-real-key' }; })),
    fx('DF_PRIVACY_KEY_MATERIAL', 'pass', 'an ext block with ordinary customer data', edit(base(), (s) => { s.ext = { imported_from: 'notes export 2026-09' }; })),
  ];
  const stamped = base();
  const projected = { by: 'lib/project.mjs', engine_version: '0.1.0', viewer: 'self', at: '2026-10-01T10:14:58Z', dropped: 0, limit: { focus: null, reach: null, lens: null, max_nodes: 2000 }, mac: stamp(stamped, FIXTURE_SESSION_KEY) };
  docs.push(
    fx('DF_RENDER_UNPROJECTED', 'fail', 'a hand-typed projected block: HMAC-shaped, but not the stamp of this scene under the session key', { ...stamped, projected: { ...projected, mac: HAND_TYPED_MAC } }, { ctx: { requireProjected: true } }),
    fx('DF_RENDER_UNPROJECTED', 'pass', 'the stamp lib/project.mjs would write under the fixture session key', { ...stamped, projected }, { ctx: { requireProjected: true } }),
  );
  return docs;
}

/** Apply a fixture's expand directive: clone a node `count` times, with optional padded fields. */
export function expandFixture(doc) {
  if (!doc || !doc.expand) return doc;
  const { clone: id, count, fields } = doc.expand;
  const scene = clone(doc.scene);
  const src = scene.nodes.find((n) => n.id === id);
  for (let i = 0; i < count; i += 1) {
    const n = clone(src);
    n.id = `${id}-c${String(i).padStart(4, '0')}`;
    if (fields) n.fields = Object.fromEntries(Array.from({ length: fields.keys }, (_, k) => [`f${k}`, 'a'.repeat(fields.chars)]));
    scene.nodes.push(n);
    scene.positions[n.id] = [100 + (i % 40) * 25, 100 + Math.floor(i / 40) * 25];
  }
  return { ...doc, scene };
}

export const fixtureName = (doc) => `${doc.code}.${doc.expect}.json`;

const isPrimitive = (v) => v === null || typeof v !== 'object';
function renderValue(v, indent) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(isPrimitive)) {
      const one = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (one.length + indent.length <= 100) return one;
    }
    const inner = `${indent}  `;
    return `[\n${v.map((x) => `${inner}${renderValue(x, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const inner = `${indent}  `;
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${renderValue(v[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/** 2-space JSON with short primitive arrays (positions, tags, vectors) kept on one line, as VISION §4 writes them. */
export const renderJson = (doc) => `${renderValue(doc, '')}\n`;

/** Every file this generator owns: path (relative to the package root) -> content. */
export function generated() {
  const out = new Map();
  for (const doc of fixtureDocs()) out.set(`test/fixtures/ir/${fixtureName(doc)}`, renderJson(doc));
  for (const [name, scene] of Object.entries(examples())) out.set(`examples/${name}.json`, renderJson(scene));
  return out;
}

/** {diffs[]}: files that are missing, stale, or stray (a fixture json the generator does not produce). */
export function checkGenerated(root = PACKAGE_ROOT) {
  const files = generated();
  const diffs = [];
  for (const [rel, content] of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) diffs.push(`${rel}: missing`);
    else if (readFileSync(abs, 'utf8') !== content) diffs.push(`${rel}: stale`);
  }
  const dir = join(root, 'test', 'fixtures', 'ir');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith('.json') && !files.has(`test/fixtures/ir/${f}`)) diffs.push(`test/fixtures/ir/${f}: stray (not produced by build-fixtures.mjs)`);
  }
  return { diffs, count: files.size };
}

export function writeGenerated(root = PACKAGE_ROOT) {
  const files = generated();
  for (const [rel, content] of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return files.size;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--check')) {
    const { diffs, count } = checkGenerated();
    if (!diffs.length) { process.stdout.write(`ir fixtures: ok (${count} files)\n`); return 0; }
    for (const d of diffs) process.stdout.write(`ir fixtures: ${d}\n`);
    process.stdout.write('run: node test/fixtures/ir/build-fixtures.mjs\n');
    return 1;
  }
  const n = writeGenerated();
  process.stdout.write(`wrote ${n} files (test/fixtures/ir/*.json, examples/scene-*.json)\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
