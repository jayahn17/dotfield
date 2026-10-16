// The benchmark corpus (V2_PLAN §9): the shipped scenes with their file
// digests, the archify fixtures (accepted or refused, with the DF_IMPORT
// code) and the vendored archify example corpus (test/fixtures/archify/,
// pinned by commit and sha256 in its manifest, each file measured at
// --quality showcase), and the synthetic families — tree, two-level
// clustered, random sparse — drawn from lib/layout/rng.mjs mulberry32 under
// fixed seeds, with 8–24 character labels and dates spread over one year,
// plus one workflow on `grid` and one on `layered`. Pure: reads files, never
// a child process; the archify showcase runs use a context pinned to
// IMPORT_EPOCH, so no row depends on the wall clock; the same arguments
// always yield the same corpus, so the digests printed in
// references/BENCHMARK.md only change when an input does.
//
//   corpus({ quick, root, now }) -> { scenes, archify, synthetic, workflows, digest }
//   archifyRows(root, { now, measure }) -> { rows, types_supported, archify_total_types, corpus_showcase_clean, ... }
//   showcaseOf(scene, ctx) -> { status: clean | blocked, exit_code, blocked_at, blocking, non_blocking }
//   archifySummary(archifyRows(...)) -> the row without per-file rows (the JSON's top-level archify)
//   syntheticScene({ family, n, seed }) -> scene       workflowScene({ layout }) -> scene
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha256, sha256File } from '../digest.mjs';
import { mulberry32 } from '../layout/rng.mjs';
import { importInput, loadInput } from '../../importers/index.mjs';
import * as archify from '../../importers/archify.mjs';
import { createContext } from '../context.mjs';
import { measureScene } from './measure.mjs';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The 8 examples (7 stamped scenes + scene-meet) and the 9 non-draft pack scenes, in the order the block prints them. */
export const SHIPPED_SCENES = Object.freeze([
  'examples/scene-graph.json', 'examples/scene-room.json', 'examples/scene-timeline.json', 'examples/scene-workflow.json', 'examples/scene-meet.example.json',
  'examples/scene-sequence.json', 'examples/scene-lifecycle.json', 'examples/scene-architecture.json',
  'packs/research-lab/examples/scene-citation-web.json', 'packs/research-lab/examples/scene-collaborators.json', 'packs/research-lab/examples/scene-experiment-timeline.json',
  'packs/robotics-lab/examples/scene-influence-graph.json', 'packs/robotics-lab/examples/scene-method-web.json', 'packs/robotics-lab/examples/scene-rig-room.json', 'packs/robotics-lab/examples/scene-run-history.json',
  'packs/starter/examples/scene-contacts-constellation.json', 'packs/starter/examples/scene-notes-web.json',
]);
/**
 * The viewBox each shipped scene committed on 2026-10-07 (scene-meet had none and ran the 1600x1000 default): the
 * denominator of the viewBox area ratio. The three examples added by examples-recipes (2026-10-08) did not exist then;
 * their denominator is the viewBox they were first committed with, so their ratio starts at 1.
 */
const FIRST_COMMITTED = { 'examples/scene-sequence.json': [0, 0, 1600, 772], 'examples/scene-lifecycle.json': [0, 0, 1200, 720], 'examples/scene-architecture.json': [0, 0, 1600, 1022.75] };
export const VIEWBOX_2026_10_07 = Object.freeze(Object.fromEntries(SHIPPED_SCENES.map((p) => [p, FIRST_COMMITTED[p] ?? (p.endsWith('scene-room.json') ? [0, 0, 1200, 800] : p.endsWith('scene-workflow.json') ? [0, 0, 1600, 900] : [0, 0, 1600, 1000])])));
export const FAMILIES = Object.freeze(['tree', 'clustered', 'sparse']);
export const SIZES_QUICK = Object.freeze([100, 500]);
export const SIZES_FULL = Object.freeze([100, 500, 2000]);
export const SIZES_TIMING_ONLY = Object.freeze([5000]);
export const SEEDS = Object.freeze({ tree: 101, clustered: 202, sparse: 303, workflow: 404 });
export const ARCHIFY_FIXTURES_DIR = 'test/fixtures/importers';
export const ARCHIFY_MANIFEST = 'test/fixtures/archify/manifest.json';
/** A fixed import clock: imported scenes carry captured_on from it, so a fixture row never depends on the wall clock. */
export const IMPORT_NOW = '2026-10-07T00:00:00Z';
/** IMPORT_NOW as SOURCE_DATE_EPOCH seconds: the clock of the archify showcase runs. */
export const IMPORT_EPOCH = '1791331200';
const KINDS = Object.freeze(['record', 'note', 'event', 'asset', 'file', 'person', 'idea', 'tag', 'place']);
const WORDS = Object.freeze(['loop', 'closure', 'bench', 'rig', 'calib', 'frame', 'sensor', 'hall', 'survey', 'dataset', 'metric', 'drift', 'weekly', 'plan', 'review', 'paper', 'method', 'imu', 'odometry', 'map', 'protocol', 'trace', 'budget', 'release']);
const MONTH_DAYS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const DIGEST_ZERO = `sha256:${'0'.repeat(64)}`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad = (n, w) => String(n).padStart(w, '0');

/** Day k of 2026 (0-based, clamped to the year) as YYYY-MM-DD, by integer arithmetic. */
export function dateOfDay(k) {
  let d = Math.max(0, Math.min(364, Math.floor(k)));
  let m = 0;
  while (d >= MONTH_DAYS[m]) { d -= MONTH_DAYS[m]; m += 1; }
  return `2026-${pad(m + 1, 2)}-${pad(d + 1, 2)}`;
}

/** A label of 8–24 characters from the word list, drawn from the stream. */
export function labelFrom(rng) {
  let text = WORDS[Math.floor(rng() * WORDS.length)];
  while (text.length < 8) text = `${text} ${WORDS[Math.floor(rng() * WORDS.length)]}`;
  if (rng() < 0.5 && text.length < 20) text = `${text} ${WORDS[Math.floor(rng() * WORDS.length)]}`;
  return text.length > 24 ? text.slice(0, 24).trimEnd() : text;
}

function node(id, rng, { kind, group = null, token = 'muted' }) {
  const day = Math.floor(rng() * 365);
  const n = {
    id, kind, label: labelFrom(rng), weight: Math.round(rng() * 100) / 100, tags: [], color_token: token, status: 'accepted',
    provenance: { owner_person_id: 'self', source: { kind: 'record', ref: `synthetic/${id}`, digest: sha256(id) }, captured_on: dateOfDay(day), happened_on: dateOfDay(day) },
    audience: { privacy_level: 'private', share_rule_ids: [] }, evidence_ids: [],
  };
  if (group) n.group = group;
  return n;
}
const edge = (id, from, to, extra = {}) => ({ id, from, to, kind: 'relates', directed: true, variant: 'solid', route: 'auto', ...extra });
/** Push one edge unless the unordered pair exists already (DF_IR_DUP_EDGE) or it would be a self edge; the draw is spent either way, so the stream stays aligned. */
function link(edges, pairs, from, to, extra = {}) {
  const key = from < to ? `${from}|${to}` : `${to}|${from}`;
  if (from === to || pairs.has(key)) return;
  pairs.add(key);
  edges.push(edge(`e${edges.length}`, from, to, extra));
}
function shell({ id, title, kind = 'graph', layout, seed, nodes, edges, groups = null, extra2d = {} }) {
  const s = {
    schema_version: 'dotfield.scene/1', kind,
    meta: { id, title, theme: 'default', quality: 'checked', privacy_mode: 'synthetic_data', maturity: 'prototype' },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    nodes, edges,
    views: { '2d': { layout, seed, ...extra2d }, '3d': { layout: 'lift', scale_m: 6, lift: { mode: 'group-weight', amplitude_m: 1.5 } }, vr: { enabled: true, scale_m: 4, floor_y: 0, eye_height_m: 1.6 } },
  };
  if (groups) s.groups = groups;
  return s;
}

/** Tree: branching 3, node i's parent is floor((i-1)/3); force layout. */
function tree(n, seed) {
  const rng = mulberry32(seed);
  const nodes = []; const edges = [];
  for (let i = 0; i < n; i += 1) {
    const id = `t${pad(i, 4)}`;
    nodes.push(node(id, rng, { kind: KINDS[i % KINDS.length], token: 'series-1' }));
    if (i > 0) edges.push(edge(`e${i}`, nodes[Math.floor((i - 1) / 3)].id, id));
  }
  return shell({ id: `synthetic-tree-${n}`, title: `Synthetic tree ${n}`, layout: 'force', seed, nodes, edges });
}

/** Two-level clustered: ~sqrt(n)/2 groups, members chain to earlier members of their group, every tenth node bridges to another group; cluster-disc layout. */
function clustered(n, seed) {
  const rng = mulberry32(seed);
  const g = Math.max(2, Math.round(Math.sqrt(n) / 2));
  const groups = Array.from({ length: g }, (_, i) => ({ id: `c${i}`, label: `Cluster ${i}`, kind: 'region', wraps: [] }));
  const members = groups.map(() => []);
  const nodes = []; const edges = []; const pairs = new Set();
  for (let i = 0; i < n; i += 1) {
    const gi = Math.floor(rng() * g);
    const id = `k${pad(i, 4)}`;
    nodes.push(node(id, rng, { kind: KINDS[i % KINDS.length], group: groups[gi].id, token: `series-${(gi % 6) + 1}` }));
    groups[gi].wraps.push(id);
    const own = members[gi];
    const m = own.length === 0 ? 0 : 1 + (rng() < 0.4 ? 1 : 0);
    for (let k = 0; k < m; k += 1) link(edges, pairs, id, own[Math.floor(rng() * own.length)]);
    if (i > 0 && i % 10 === 0) link(edges, pairs, id, nodes[Math.floor(rng() * i)].id, { variant: 'dashed' });
    own.push(id);
  }
  return shell({ id: `synthetic-clustered-${n}`, title: `Synthetic clustered ${n}`, layout: 'cluster-disc', seed, nodes, edges, groups });
}

/** Random sparse: every node links to one earlier node, a fifth of them to a second; force layout. */
function sparse(n, seed) {
  const rng = mulberry32(seed);
  const nodes = []; const edges = []; const pairs = new Set();
  for (let i = 0; i < n; i += 1) {
    const id = `s${pad(i, 4)}`;
    nodes.push(node(id, rng, { kind: KINDS[i % KINDS.length], token: 'series-3' }));
    if (i > 0) {
      link(edges, pairs, id, nodes[Math.floor(rng() * i)].id, { directed: false });
      if (rng() < 0.2) link(edges, pairs, id, nodes[Math.floor(rng() * i)].id, { directed: false });
    }
  }
  return shell({ id: `synthetic-sparse-${n}`, title: `Synthetic sparse ${n}`, layout: 'force', seed, nodes, edges });
}

const GENERATORS = Object.freeze({ tree, clustered, sparse });

/** One synthetic scene; the same {family, n, seed} always yields the same bytes. */
export function syntheticScene({ family, n, seed = SEEDS[family] }) {
  const gen = GENERATORS[family];
  if (!gen) throw new TypeError(`unknown synthetic family ${String(family)} (${FAMILIES.join(', ')})`);
  return gen(n, seed);
}

/** A 12-node, 3-zone workflow with ordered flow edges, on `grid` (4 columns) or `layered` (direction down). */
export function workflowScene({ layout = 'grid', seed = SEEDS.workflow } = {}) {
  const rng = mulberry32(seed);
  const zones = ['intake', 'core', 'output'].map((z, i) => ({ id: `z-${z}`, label: z, kind: 'zone', wraps: [], color_token: `series-${i + 1}` }));
  const nodes = []; const edges = [];
  for (let i = 0; i < 12; i += 1) {
    const zi = Math.min(2, Math.floor(i / 4));
    const id = `w${pad(i, 2)}`;
    nodes.push(node(id, rng, { kind: i % 3 === 0 ? 'file' : 'asset', group: zones[zi].id, token: zones[zi].color_token }));
    zones[zi].wraps.push(id);
    if (i > 0) edges.push(edge(`f${i}`, nodes[i - 1].id, id, { kind: 'flow', variant: 'flow', route: 'orthogonal', order: i, label: i % 2 ? 'rows' : null }));
  }
  edges.push(edge('f12', 'w11', 'w02', { kind: 'flow', variant: 'flow', route: 'orthogonal', order: 12 }));
  for (const e of edges) if (e.label === null) delete e.label;
  const extra2d = layout === 'grid' ? { columns: 4 } : { direction: 'down' };
  return shell({ id: `synthetic-workflow-${layout}`, title: `Synthetic workflow (${layout})`, kind: 'workflow', layout, seed, nodes, edges, groups: zones, extra2d });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The shipped scenes with path, sha256 of the file bytes and the parsed scene. */
export function shippedScenes(root = PACKAGE_ROOT) {
  return SHIPPED_SCENES.filter((p) => existsSync(join(root, p))).map((p) => {
    const scene = readJson(join(root, p));
    const v2 = isObject(scene.views) && isObject(scene.views['2d']) ? scene.views['2d'] : {};
    return { id: p.replace(/^.*\//, '').replace(/\.json$/, ''), path: p, sha256: sha256File(join(root, p)), scene, viewbox_2026_10_07: VIEWBOX_2026_10_07[p], mode2d: v2.layout ?? null };
  });
}

/** The measuring context of the archify rows: the package root under the fixed import clock, so a row never depends on the wall clock. */
export function archifyContext(root = PACKAGE_ROOT) {
  return createContext({ cwd: root, env: { SOURCE_DATE_EPOCH: IMPORT_EPOCH } });
}

/** One imported scene at --quality showcase, --view 2d, through lib/bench/measure.mjs (the order `render` runs): clean | blocked, with the failing codes split by blocking. */
export function showcaseOf(scene, ctx) {
  const row = measureScene(scene, ctx, { quality: 'showcase', views: '2d', metrics: false });
  const codes = (blocking) => Object.entries(row.fails).filter(([, f]) => f.blocking === blocking).map(([code]) => code);
  return { status: row.status === 'written' ? 'clean' : 'blocked', exit_code: row.exit_code, blocked_at: row.blocked_at, blocking: codes(true), non_blocking: codes(false) };
}

function archifyRow(abs, name, source, now, ctx) {
  const r = importInput(loadInput(abs), { now });
  const fails = (blocking) => [...new Set(r.checks.filter((c) => c.status === 'fail' && c.blocking === blocking).map((c) => c.code))].sort();
  const row = { name, source, sha256: sha256File(abs), status: r.ok ? 'accepted' : 'refused', codes: fails(true), notes: fails(false), diagram_type: r.scene && r.scene.ext && r.scene.ext.archify ? r.scene.ext.archify.diagram_type : diagramTypeOf(abs) };
  if (ctx && r.ok) row.showcase = showcaseOf(r.scene, ctx);
  return row;
}

/**
 * Archify rows: every *.archify.json fixture (accepted | refused with its
 * code) plus every file test/fixtures/archify/manifest.json pins (the
 * vendored archify example corpus, each re-hashed against its pinned
 * sha256), each accepted row measured at --quality showcase. The corpus
 * summary is the benchmark row: archify.types_supported (of the
 * diagram_types the manifest records at the pinned commit) and
 * corpus_showcase_clean, the fraction of corpus files that import, validate,
 * lay out and render with no blocking failure. `measure: false` skips the
 * showcase runs (imports only).
 */
export function archifyRows(root = PACKAGE_ROOT, { now = IMPORT_NOW, measure = true } = {}) {
  const ctx = measure ? archifyContext(root) : null;
  const dir = join(root, ARCHIFY_FIXTURES_DIR);
  const rows = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.archify\.json$/.test(f)).sort() : [];
  for (const file of files) rows.push(archifyRow(join(dir, file), file, `${ARCHIFY_FIXTURES_DIR}/${file}`, now, ctx));
  const manifestPath = join(root, ARCHIFY_MANIFEST);
  let manifest = null;
  if (existsSync(manifestPath)) {
    try { manifest = readJson(manifestPath); } catch { manifest = null; }
  }
  const corpusRows = [];
  if (manifest && Array.isArray(manifest.files)) {
    for (const f of manifest.files) {
      const rel = typeof f === 'string' ? f : f.file ?? f.path;
      if (typeof rel !== 'string') continue;
      const abs = join(dirname(manifestPath), rel);
      const source = `${dirname(ARCHIFY_MANIFEST)}/${rel}`;
      if (!existsSync(abs)) { corpusRows.push({ name: rel, source, sha256: null, status: 'missing', codes: [], notes: [], diagram_type: null, corpus: true, verified: false }); continue; }
      const row = archifyRow(abs, rel, source, now, ctx);
      row.corpus = true;
      row.verified = typeof f.sha256 === 'string' && row.sha256 === f.sha256;
      corpusRows.push(row);
    }
  }
  rows.push(...corpusRows);
  const totalTypes = manifest && Array.isArray(manifest.diagram_types) ? manifest.diagram_types.length : 'unknown';
  const clean = corpusRows.filter((r) => r.showcase && r.showcase.status === 'clean').length;
  return {
    rows,
    types_supported: archify.SUPPORTED.length,
    supported: [...archify.SUPPORTED],
    refused_by_name: [...(archify.REFUSED ?? [])],
    archify_total_types: totalTypes,
    pinned_commit: manifest && typeof manifest.commit === 'string' ? manifest.commit : null,
    manifest_present: manifest !== null,
    license_spdx: manifest && manifest.license && typeof manifest.license.spdx === 'string' ? manifest.license.spdx : null,
    corpus_files: corpusRows.length,
    corpus_verified: corpusRows.filter((r) => r.verified).length,
    corpus_imported: corpusRows.filter((r) => r.status === 'accepted').length,
    corpus_showcase_clean_count: measure ? clean : null,
    corpus_showcase_clean: measure && manifest ? `${clean}/${corpusRows.length}` : 'not_measured',
  };
}

/** The archify benchmark row without its per-file rows: what the JSON's top-level `archify` and the Markdown row print. */
export function archifySummary(a) {
  const keys = ['types_supported', 'supported', 'refused_by_name', 'archify_total_types', 'pinned_commit', 'license_spdx', 'corpus_files', 'corpus_verified', 'corpus_imported', 'corpus_showcase_clean_count', 'corpus_showcase_clean'];
  return Object.fromEntries(keys.map((k) => [k, a ? a[k] ?? null : null]));
}

function diagramTypeOf(path) {
  try { const d = readJson(path); return typeof d.diagram_type === 'string' ? d.diagram_type : null; } catch { return null; }
}

/** The whole corpus. `quick` keeps the tree family at 100 and 500 only. */
export function corpus({ quick = true, root = PACKAGE_ROOT, now = IMPORT_NOW } = {}) {
  const scenes = shippedScenes(root);
  const synthetic = [];
  const families = quick ? ['tree'] : FAMILIES;
  const sizes = quick ? SIZES_QUICK : SIZES_FULL;
  for (const family of families) for (const n of sizes) synthetic.push({ id: `synthetic-${family}-${n}`, family, n, seed: SEEDS[family], timing_only: false, scene: syntheticScene({ family, n }) });
  if (!quick) for (const n of SIZES_TIMING_ONLY) synthetic.push({ id: `synthetic-tree-${n}`, family: 'tree', n, seed: SEEDS.tree, timing_only: true, scene: syntheticScene({ family: 'tree', n }) });
  const workflows = ['grid', 'layered'].map((layout) => ({ id: `synthetic-workflow-${layout}`, layout, scene: workflowScene({ layout }) }));
  // The digest covers the quick subset whatever the mode, so a full run prints the same Markdown block as --quick.
  const quickIds = synthetic.filter((s) => s.family === 'tree' && SIZES_QUICK.includes(s.n)).map((s) => [s.id, s.seed]);
  const arch = archifyRows(root, { now });
  const archifyInputs = arch.rows.map((r) => [r.source, r.sha256 ?? null]);
  const digest = sha256(canonical({ scenes: scenes.map((s) => [s.path, s.sha256]), synthetic: quickIds, workflows: workflows.map((w) => w.id), archify: archifyInputs }));
  return { scenes, archify: arch, synthetic, workflows, digest, quick, zero_digest: DIGEST_ZERO };
}
