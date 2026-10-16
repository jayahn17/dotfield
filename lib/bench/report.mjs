// The benchmark report (V2_PLAN §9): the Markdown auto block between
// <!-- bench:auto:start --> and <!-- bench:auto:end --> holds corpus-input
// digests, counts, booleans and input-derived ratios only — no bytes, no
// timings, no dates, nothing read back from renderer text — so a viewer,
// style or token edit never churns it and `--check` stays green across
// components; the block is the --quick subset by construction, so a full run
// writes the same bytes. The competitor checklist block copies
// present|absent|unknown cells from references/benchmark-checklist.json
// (Dotfield cells that name a probe come from the probes; the rest are typed
// values with a source, as the checklist's own rules[1] says) under a header
// sentence that is regenerated, not typed. Dotfield's D6 (3D, VR) and D7
// (4D viewer) cells print `present (provisional)`: a browser or headset
// capture lives under the ignored .dotfield/, so it is never an input of
// this block, and references/MATURITY.md carries the capture state. The
// JSON holds everything.
//
//   renderMarkdownBlock(result) -> string      renderChecklistBlock(checklist, probes) -> string
//   toJson(result, { timings, bytes, node, digests }) -> object
//   replaceBlock(text, start, end, body) -> text   extractBlock(text, start, end) -> string | null
import { failsLabel } from './measure.mjs';
import { archifySummary } from './corpus.mjs';

export const AUTO_START = '<!-- bench:auto:start -->';
export const AUTO_END = '<!-- bench:auto:end -->';
export const CHECKLIST_START = '<!-- bench:checklist:start -->';
export const CHECKLIST_END = '<!-- bench:checklist:end -->';
export const HEADER_SENTENCE = "Self-assessed by the maintainer from each project's repository at the pinned commit; no competitor was executed; Phase 2 adapters not present.";
export const CELL_VALUES = Object.freeze(['present', 'absent', 'unknown']);
export const QUICK_QUALITIES = Object.freeze(['checked', 'showcase']);
/** Dotfield's cells in these dimensions (3D/VR, the 4D viewer) stay provisional: no capture is an input of the block (V2_PLAN §4). */
export const PROVISIONAL_DIMENSIONS = Object.freeze(['D6', 'D7']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (digest) => String(digest ?? '').replace(/^sha256:/, '').slice(0, 12);
const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a');
const BS = '\u005c';
const cell = (s) => String(s ?? '').replace(/\|/g, `${BS}|`);

function sceneRow(entry) {
  const checked = entry.runs.find((r) => r.quality === 'checked' && r.views === '2d');
  const showcase = entry.runs.find((r) => r.quality === 'showcase' && r.views === '2d');
  const m = (checked && checked.metrics) || (showcase && showcase.metrics) || {};
  const st = (checked && checked.stability) || {};
  const status = (r) => (r ? (r.status === 'written' ? 'written' : `blocked at ${r.blocked_at}`) : 'n/a');
  return `| ${cell(entry.id)} | ${num(entry.nodes)} | ${num(entry.edges)} | ${cell(entry.mode2d ?? 'default')} | ${status(checked)} | ${status(showcase)} | ${cell(checked ? failsLabel(checked.fails) : 'n/a')} | ${num(m.overlap_pairs)} | ${num(m.label_collisions)} | ${num(m.labels_measured)} | ${num(m.labels_total)} | ${num(m.route_through_node)} | ${num(m.crossings)} | ${num(m.containment_violations)} | ${num(m.stress)} | ${num(m.neighborhood_preservation)} | ${num(m.edge_uniformity)} | ${st.applicable === false ? 'n/a' : num(st.mean)} | ${st.applicable === false ? 'n/a' : num(st.max)} | ${num(m.viewbox_area_ratio)} |`;
}

const SCENE_HEAD = ['| Scene | n | e | Mode | checked | showcase | Fails at checked (code total, `!` blocking, `^` capped) | Overlaps | Label hits | Labels measured | Labels total | Route-through | Crossings | Containment | Stress | NP k=3 | EU | One-edit mean px | One-edit max px | viewBox area ratio |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];

/** The auto block body (without the markers): digests, counts, booleans, input-derived ratios. */
export function renderMarkdownBlock(result) {
  const c = result.corpus;
  const lines = [];
  lines.push('_Written by `node scripts/benchmark.mjs --write` and compared byte for byte by `--check` (`npm run check` runs it with `--quick`). This block holds corpus-input digests, counts, booleans and input-derived ratios only: no bytes, no timings, no dates, nothing read back from renderer text. The JSON under `.dotfield/benchmark/` holds everything else. A full `npm run bench` writes the same block: the extra families, sizes, views and timings go to the JSON only._', '');
  const acc = c.archify.rows.filter((r) => r.status === 'accepted').length;
  const ref = c.archify.rows.filter((r) => r.status === 'refused').length;
  // The quick subset by construction: the tree family at 100 and 500, whatever else a full run measured (that goes to the JSON).
  const synthetic = result.synthetic.filter((s) => !s.timing_only && s.family === 'tree' && [100, 500].includes(s.n));
  lines.push(`**Corpus** · shipped scenes: ${c.scenes.length} (${c.scenes.filter((s) => s.path.startsWith('examples/')).length} examples, ${c.scenes.filter((s) => s.path.startsWith('packs/')).length} pack scenes) · corpus digest \`${short(c.digest)}\` · archify fixtures: ${c.archify.rows.length} (accepted ${acc}, refused ${ref}) · synthetic in the quick block: ${synthetic.map((s) => `tree n = ${s.n}`).join(', ')} · workflow variants: ${result.workflows.map((w) => `${w.layout} (${w.status})`).join(', ')}`, '');
  lines.push(`**Shipped scenes, \`--view 2d\`** · written at checked: ${result.scenes.filter((e) => e.runs.some((r) => r.quality === 'checked' && r.views === '2d' && r.status === 'written')).length} of ${result.scenes.length} · written at showcase: ${result.scenes.filter((e) => e.runs.some((r) => r.quality === 'showcase' && r.views === '2d' && r.status === 'written')).length} of ${result.scenes.length} · metrics are over the committed positions table (stress, NP = neighbourhood preservation, EU = edge-length uniformity: lower stress and EU, higher NP are better; one-edit = displacement of the existing nodes after one leaf is added to the max-degree node and the layout re-runs with ctx.incremental).`, '');
  lines.push(...SCENE_HEAD);
  for (const e of result.scenes) lines.push(sceneRow(e));
  lines.push('', `**Synthetic (quick subset, \`checked\`, \`--view 2d\`)** · generator seeds ${synthetic.map((s) => `${s.family} ${s.seed}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')} · labels 8–24 characters, dates over 2026`, '');
  lines.push(...SCENE_HEAD);
  for (const s of synthetic) lines.push(sceneRow({ id: s.id, nodes: s.nodes, edges: s.edges, mode2d: s.mode2d, runs: s.runs.filter((r) => r.quality === 'checked' && r.views === '2d') }));
  lines.push('', '**Workflow variants** (12 nodes, 3 zones, ordered flow edges)', '', '| Variant | Status at checked | Fails |', '|---|---|---|');
  for (const w of result.workflows) lines.push(`| ${cell(w.layout)} | ${cell(w.status)} | ${cell(w.fails ?? 'n/a')} |`);
  const a = c.archify;
  lines.push('', `**Archify fixtures and corpus** (importers/archify.mjs; test/fixtures/importers/*.archify.json, then the archify example corpus vendored under test/fixtures/archify/ at ${a.pinned_commit ? `commit \`${a.pinned_commit.slice(0, 12)}\`` : 'no pinned commit'}, ${a.license_spdx ?? 'licence unrecorded'}; showcase = --quality showcase, --view 2d)`, '', '| Fixture | diagram_type | Status | Code |', '|---|---|---|---|');
  for (const r of a.rows) lines.push(`| ${cell(r.name)} | ${cell(r.diagram_type ?? 'n/a')} | ${cell(r.status)}${r.showcase ? `, showcase ${cell(r.showcase.status)}` : ''} | ${cell([...r.codes, ...(r.showcase ? r.showcase.blocking : [])].join(', ') || 'none')} |`);
  lines.push(`| archify.types_supported | ${a.types_supported} of ${a.archify_total_types} (${a.supported.join(', ')}) | refused_by_name: ${a.refused_by_name.length ? a.refused_by_name.join(', ') : 'none'} | corpus_showcase_clean: ${a.corpus_showcase_clean ?? 'not_measured'} |`);
  const p = result.probes;
  lines.push('', '**Probes**', '', '| Probe | Value |', '|---|---|');
  lines.push(`| Standalone | default render external refs ${p.standalone.external_refs_default} (cdn ${p.standalone.external_refs_default_by_origin.cdn}, other ${p.standalone.external_refs_default_by_origin.other}) · \`--embed-three\` external refs ${p.standalone.external_refs_embed} · importmap ${p.standalone.importmap_mode} · SRI complete ${yn(p.standalone.sri_complete)} · font-face data URLs ${p.standalone.font_face_data_urls} |`);
  lines.push(`| Parity | nodes ${p.parity.nodes} · ground mismatches 2D vs 3D ${p.parity.ground_mismatches_3d} · VR mismatches ${p.parity.vr_mismatches} · metric rooms not applicable ${p.parity.metric_not_applicable} · holds ${yn(p.parity.parity_holds)} |`);
  lines.push(`| Determinism | tables ${p.determinism.tables.join(', ')} · scenes ${p.determinism.scenes} · nondeterministic ${p.determinism.nondeterministic_scenes} · two renders under one clock identical ${yn(p.determinism.renders_identical)} |`);
  lines.push(`| 4D | time block ${yn(p.fourd.time_block)} · playhead in hash ${yn(p.fourd.playhead_in_hash)} · playhead core ${yn(p.fourd.playhead_core_present)} · compare verb ${yn(p.fourd.compare_verb)} · steps in schema ${yn(p.fourd.steps_in_schema)} · no infinite motion ${yn(p.fourd.no_infinite_motion)} · edge-label truth ${yn(p.fourd.edge_label_truth)} |`);
  lines.push(`| Agent | SKILL.md lines ${p.agent.skill_lines} · allowed patterns ${p.agent.skill_allowed_patterns} (wildcard-free ${yn(p.agent.skill_wildcard_free)}) · forbidden commands tested ${p.agent.forbidden_commands_tested} · Claude Code hook reminder ${yn(p.agent.cc_hook_reminder_present)} · MCP tools ${p.agent.mcp_tools} (annotations ${yn(p.agent.mcp_annotations_present)}, approve absent ${yn(p.agent.approve_tool_absent)}) · owner gate ${yn(p.agent.owner_gate_present)} |`);
  lines.push(`| Verification | rule codes ${p.agent.rule_codes} in ${p.agent.rule_families} families · without repair ${p.agent.codes_without_repair} · receipt required fields ${p.agent.receipt_required_fields} · verify round trip ${yn(p.agent.receipt_round_trip)} · prev_digest in schema ${yn(p.agent.prev_digest_in_schema)} |`);
  lines.push(`| Maintainability | dependencies ${p.maintainability.dependencies} · optional ${p.maintainability.optional_dependencies} · files at or over 400 lines ${p.maintainability.files_at_or_over_400} · test files ${p.maintainability.test_files} · test() calls: runner summary in the full-bench JSON |`);
  lines.push('', '_Not measured here, and never claimed: competitor renders (Phase 2 adapters run only when installed, else `not run`), browser frame rates, visual quality and headset behaviour; those come from receipts with `evidence.browser: captured` or stay `provisional`._');
  return lines.join('\n');
}

/** The checklist body: header sentence, one row per feature with a column per system, then the sources. Dotfield cells come from the probes. */
export function renderChecklistBlock(checklist, probes) {
  const systems = checklist.systems;
  const lines = [`_${HEADER_SENTENCE}_`, '', `_Selection rule: ${checklist.selection.rule}_ _${checklist.selection.note}_`, ''];
  lines.push(`| Feature | ${systems.map((s) => cell(s.short)).join(' | ')} |`, `|---|${systems.map(() => '---').join('|')}|`);
  for (const f of checklist.features) {
    const cells = systems.map((s) => {
      const v = s.cells[f.id];
      if (!v) return 'unknown';
      const out = v.probe ? probeCell(probes, v.probe) : v.value;
      return s.id === 'dotfield' && out === 'present' && PROVISIONAL_DIMENSIONS.includes(f.dimension) ? 'present (provisional)' : out;
    });
    lines.push(`| ${cell(f.label)} (${f.dimension}) | ${cells.join(' | ')} |`);
  }
  const unpinned = systems.filter((s) => !s.pinned_commit && s.id !== 'dotfield').length;
  const starless = systems.filter((s) => !(s.stars && Number.isInteger(s.stars.count))).length;
  lines.push('', `**Sources** (repo · pin · anchors). Pin date ${checklist.pin_date}; ${unpinned} of ${systems.length - 1} competitors are unpinned (no network in this build: pin the default-branch commit on the first refresh); star counts are recorded for ${systems.length - starless} of ${systems.length} systems and are a dated note, never a score. Every cell's own source sentence is in \`benchmark-checklist.json\`.`, '');
  for (const s of systems) {
    const pin = s.pinned_commit ? `commit \`${s.pinned_commit}\`` : (s.id === 'dotfield' ? 'this tree' : 'unpinned');
    const stars = s.stars && Number.isInteger(s.stars.count) ? ` · ${s.stars.count} stars as of ${s.stars.as_of}` : '';
    lines.push(`- **${cell(s.name)}** (${cell(s.category)}) — ${s.repo} · ${pin}${stars}${s.anchors && s.anchors.length ? ` · anchors: ${s.anchors.join(' · ')}` : ''}`);
  }
  return lines.join('\n');
}

/** present when the named probe is true, absent when false or 'not_implemented', unknown when the probe is missing (Dotfield cells that name a probe). */
export function probeCell(probes, path) {
  let v = probes;
  for (const k of String(path).split('.')) v = isObject(v) ? v[k] : undefined;
  if (v === undefined) return 'unknown';
  return v === true ? 'present' : 'absent';
}

export function extractBlock(text, start, end) {
  const a = String(text).indexOf(start); const b = String(text).indexOf(end);
  if (a < 0 || b < 0 || b < a) return null;
  return String(text).slice(a + start.length, b);
}

/** Replace the body between the markers (the markers stay; the body is wrapped in newlines). */
export function replaceBlock(text, start, end, body) {
  const a = String(text).indexOf(start); const b = String(text).indexOf(end);
  if (a < 0 || b < 0 || b < a) throw new Error(`markers ${start} … ${end} not found`);
  return `${String(text).slice(0, a + start.length)}\n${body}\n${String(text).slice(b)}`;
}

const stripLaid = (run) => { const { laid, ...rest } = run; return rest; };

/** The JSON document: the whole result plus bytes, timings, Node version and engine digests (the fields the Markdown leaves out). */
export function toJson(result, { timings = null, bytes = null, node = null, digests = null, generated_at = null, mode = 'quick', fresh_clone = null, cli = null, tests = null } = {}) {
  return {
    schema_version: 'dotfield.benchmark/1',
    mode, generated_at, node, engine_digests: digests,
    corpus: { digest: result.corpus.digest, scenes: result.corpus.scenes.map((s) => ({ id: s.id, path: s.path, sha256: s.sha256, mode2d: s.mode2d, viewbox_2026_10_07: s.viewbox_2026_10_07 })), archify: result.corpus.archify, synthetic: result.synthetic.map((s) => ({ id: s.id, family: s.family, n: s.n, seed: s.seed, timing_only: s.timing_only, digest: s.digest })), workflows: result.workflows.map((w) => ({ id: w.id, layout: w.layout, status: w.status, fails: w.fails })) },
    archify: archifySummary(result.corpus.archify),
    scenes: result.scenes.map((e) => ({ ...e, runs: e.runs.map(stripLaid) })),
    synthetic: result.synthetic.map((s) => ({ ...s, runs: (s.runs ?? []).map(stripLaid) })),
    workflows: result.workflows.map((w) => ({ ...w, runs: (w.runs ?? []).map(stripLaid) })),
    probes: result.probes,
    bytes, timings, fresh_clone, cli, tests,
    not_measured: ['competitor renders (Phase 2 adapters not present)', 'browser frame rate', 'visual quality', 'headset behaviour (provisional until a capture is attached with scripts/evidence.mjs)'],
  };
}
