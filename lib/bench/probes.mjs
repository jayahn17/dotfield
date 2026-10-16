// Benchmark probes (V2_PLAN §9): standalone-ness, 2D/3D/VR parity,
// determinism, the 4D probes (with edge-label truth), the agent surface and maintainability.
// Pure over what the script hands in (HTML strings, the corpus scenes, the
// MCP tool list, a test-runner summary): no clock, no child process. Every
// 4D probe answers true | false | 'not_implemented' — 'not_implemented'
// means the code path does not exist yet, false means it exists and fails.
//
//   probes({ root, html, htmlEmbedded, scenes, tools, testSummary, receiptRoundTrip }) -> {...}
//   parseCapSentinel(message) -> { shown, total } | null     memoRunner(base, { cold }) -> runner
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { sha256 } from '../digest.mjs';
import { CODES, FAMILIES, RULES } from '../rules.mjs';
import { frameOf, toThree, toVr, vrFrame } from '../layout/frame.mjs';
import * as layout from '../layout/index.mjs';
import { tryLoadSchema } from '../validate.mjs';
import { SCENE_KINDS } from '../gates/topology.mjs';
import { CDN_BASE } from '../../renderers/html.mjs';
import { renderSvg } from '../../renderers/svg.mjs';
import { edgeLabelBox } from '../layout/metrics.mjs';
import { edgePolyline } from '../layout/geometry.mjs';

/** The one regex for the layout gate's 200-row cap sentinel, today's form and the v2 form; pinned by test/benchmark.test.js. */
export const CAP_SENTINEL_RE = /further (?:(\d+) )?(DF_[A-Z0-9_]+) findings not listed \((\d+) shown(?: of (\d+))?\)/;
export const INFINITE_ANIMATION_RE = /animation(?:-iteration-count)?\s*:[^;}"']*\b(?:infinite|(?!1\b)\d+(?:e\d+)?)\b/g;
export const SMIL_INDEFINITE_RE = /<animate(?:Transform|Motion)?\b[^>]*\brepeatCount\s*=\s*["']indefinite["']/g;
export const NOT_IMPLEMENTED = 'not_implemented';
const CORE_DIRS = ['bin', 'lib', 'renderers', 'server', 'mcp', 'importers'];
const SCAN_DIRS = [...CORE_DIRS, 'packs', 'schemas', 'examples', 'scripts', 'test'];
const SKIP = new Set(['node_modules', '.git', 'data', '.dotfield', 'fixtures']);
const CODE_EXTS = new Set(['.mjs', '.js', '.cjs']);
const SOURCE_EXTS = new Set(['.mjs', '.js', '.cjs', '.css', '.html']);
const W3_RE = /^https?:\/\/www\.w3\.org\//;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/g;
const TOKENS_BLOCK_RE = /<style data-df="tokens">[\s\S]*?<\/style>/g;
const DATA_BLOCK_RE = /<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The parsed schema, or null: tryLoadSchema() answers {ok, schema}. */
const schemaOf = (name) => { const r = tryLoadSchema(name); return r && r.ok ? r.schema : null; };

/** "further 147 DF_X findings not listed (200 shown of 347)" -> {shown: 200, total: 347}; the pre-v2 sentinel has no total (null). */
export function parseCapSentinel(message) {
  const m = CAP_SENTINEL_RE.exec(String(message ?? ''));
  if (!m) return null;
  const shown = Number(m[3]);
  const total = m[4] !== undefined ? Number(m[4]) : (m[1] !== undefined ? shown + Number(m[1]) : null);
  return { shown, total, code: m[2] };
}

/**
 * A layout runner for lib/gates/layout.mjs deps.runner that runs cold for the
 * first `cold` calls per scene (so the gate's two-run determinism probe is
 * real) and serves the last result afterwards, so a scene measured at two
 * qualities pays for the probe once. Keyed by canonical scene + seed.
 */
export function memoRunner(base = layout.layoutTables, { cold = 2 } = {}) {
  const seen = new Map();
  const runner = (scene, ctx) => {
    const key = sha256({ scene, seed: frameOf(scene).seed });
    const entry = seen.get(key) ?? { calls: 0, last: null };
    if (entry.calls < cold || entry.last === null) { entry.last = base(scene, ctx); runner.stats.cold += 1; } else runner.stats.served += 1;
    entry.calls += 1;
    seen.set(key, entry);
    return entry.last;
  };
  runner.stats = { cold: 0, served: 0 };
  return runner;
}

function stripBlocks(html) {
  return String(html ?? '').replace(TOKENS_BLOCK_RE, '').replace(DATA_BLOCK_RE, '');
}

/** External references of a render by origin: {total, cdn, other, refs[]}; data: URLs and W3C namespace URIs are not references. */
export function externalRefs(html) {
  const refs = new Set();
  for (const m of stripBlocks(html).matchAll(URL_RE)) if (!W3_RE.test(m[0])) refs.add(m[0]);
  const list = [...refs].sort();
  const cdn = list.filter((u) => u.startsWith(CDN_BASE)).length;
  return { total: list.length, cdn, other: list.length - cdn, refs: list };
}

function importmapOf(html) {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(String(html ?? ''));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function standaloneProbe({ html, htmlEmbedded }) {
  const map = importmapOf(html);
  const imports = map && isObject(map.imports) ? Object.values(map.imports) : [];
  const integrity = map && isObject(map.integrity) ? map.integrity : {};
  const http = imports.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  const def = externalRefs(html); const emb = externalRefs(htmlEmbedded);
  return {
    external_refs_default: def.total, external_refs_default_by_origin: { cdn: def.cdn, other: def.other },
    external_refs_embed: emb.total, external_refs_embed_by_origin: { cdn: emb.cdn, other: emb.other },
    importmap_mode: !map ? 'none' : (http.length ? 'cdn' : 'embedded'),
    importmap_entries: imports.length,
    sri_complete: http.length > 0 && http.every((u) => /^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(String(integrity[u] ?? ''))),
    font_face_data_urls: (String(html ?? '').match(/@font-face[^}]*url\(\s*["']?data:/g) || []).length,
    fonts_embedded: (String(html ?? '').match(/@font-face[^}]*url\(\s*["']?data:/g) || []).length > 0,
    embedded_has_no_http: emb.total === 0,
  };
}

/** positions2d vs the inverse lift of positions3d (x and y), positionsVr == toVr(positions3d) exactly; rooms are metric and not applicable. */
export function parityProbe(scenes, { tolerancePx = 0.05 } = {}) {
  let nodes = 0; let mismatches3d = 0; let mismatchesVr = 0; let notApplicable = 0;
  for (const scene of scenes) {
    const mode = layout.mode3dOf(scene);
    const laid = layout.layoutScene(scene);
    const p2 = isObject(laid.positions) ? laid.positions : {};
    const p3 = layout.positions3d(laid); const pv = layout.positionsVr(laid);
    const frame = frameOf(laid); const vr = vrFrame(laid, mode);
    for (const [id, q2] of Object.entries(p2)) {
      nodes += 1;
      const q3 = p3[id]; const qv = pv[id];
      if (!q3 || !qv) { mismatches3d += 1; continue; }
      if (mode === 'metric') notApplicable += 1;
      else {
        const t = toThree(q2, frame);
        const dx = Math.abs(t[0] - q3[0]) / frame.metres_per_px;
        const dy = mode === 'lift' ? Math.abs(t[1] - q3[1]) / frame.metres_per_px : 0;
        if (dx > tolerancePx || dy > tolerancePx) mismatches3d += 1;
      }
      const w = toVr(q3, vr);
      if (w[0] !== qv[0] || w[1] !== qv[1] || w[2] !== qv[2]) mismatchesVr += 1;
    }
  }
  return { nodes, ground_mismatches_3d: mismatches3d, vr_mismatches: mismatchesVr, metric_not_applicable: notApplicable, parity_holds: mismatches3d === 0 && mismatchesVr === 0 };
}

/** verifyDeterminism() over every table layout exposes, plus the two-render digest comparison the script supplies. */
export function determinismProbe(scenes, { renderDigests = null } = {}) {
  const runner = typeof layout.layoutTables === 'function' ? layout.layoutTables : layout.positions2d;
  let diffs = 0; let nondeterministic = 0;
  for (const scene of scenes) {
    const r = layout.verifyDeterminism(scene, {}, runner);
    if (!r.deterministic) { nondeterministic += 1; diffs += r.diffs.length; }
  }
  const renders = Array.isArray(renderDigests) && renderDigests.length === 2 ? renderDigests[0] === renderDigests[1] : null;
  return { scenes: scenes.length, tables: runner === layout.positions2d ? ['positions'] : ['positions', 'routes', 'labels', 'plan'], nondeterministic_scenes: nondeterministic, diffs, layouts_deterministic: nondeterministic === 0, renders_identical: renders };
}

/** Infinite motion in a render: style blocks (minus tokens), style attributes, SMIL indefinite loops, decoded embedded renderer modules. */
export function motionLoops(html) {
  const text = String(html ?? '');
  const hits = [];
  const scan = (chunk, where) => {
    for (const m of chunk.matchAll(INFINITE_ANIMATION_RE)) hits.push({ match: m[0], where });
    for (const m of chunk.matchAll(SMIL_INDEFINITE_RE)) hits.push({ match: m[0].slice(0, 80), where });
  };
  const noTokens = text.replace(TOKENS_BLOCK_RE, '');
  for (const m of noTokens.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) scan(m[1], 'style block');
  for (const m of noTokens.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) scan(m[1], 'style attribute');
  scan(noTokens.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, ''), 'markup');
  for (const m of text.matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g)) {
    if (m[1].length > 512 * 1024) continue;
    try { scan(Buffer.from(m[1], 'base64').toString('utf8'), 'embedded module'); } catch { /* not base64: nothing to scan */ }
  }
  return hits;
}

/**
 * Edge-label truth (V2_PLAN §3 E, §9 svg-4d): in the SVG of every shipped
 * scene, each edge label's textLength equals the width of the edgeLabelBox()
 * the gate measured (2-decimal attribute form). true | false, or
 * 'not_implemented' when no scene draws an edge label.
 */
export function edgeLabelTruth(scenes, tokensCss) {
  let labels = 0; let mismatches = 0;
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const laid = layout.layoutScene(scene, { tokensCss });
    const input = layout.prepare(laid, { tokensCss });
    const svg = renderSvg(laid, tokensCss);
    const P = Object.fromEntries(input.nodes.map((n) => [n.id, laid.positions && laid.positions[n.id]]));
    const want = new Map();
    for (const [, , e] of input.edges) {
      if (typeof e.label !== 'string' || !e.label || typeof e.id !== 'string' || !P[e.from] || !P[e.to]) continue;
      const w = edgeLabelBox(e, edgePolyline(laid, e, P[e.from], P[e.to]), input.style).w;
      want.set(e.id, (Math.round(w * 100) / 100).toString());
    }
    for (const chunk of svg.split('<g class="df-edge-group').slice(1)) {
      const id = /^[^>]*data-edge-id="([^"]+)"/.exec(chunk); const t = /<text class="df-edge-label[^"]*"[^>]*textLength="([0-9.]+)"/.exec(chunk.split('<g class="df-edge-group')[0]);
      if (!id || !t || !want.has(id[1])) continue;
      labels += 1; if (t[1] !== want.get(id[1])) mismatches += 1;
    }
  }
  return { labels, mismatches, edge_label_truth: labels ? mismatches === 0 : NOT_IMPLEMENTED };
}

export function fourdProbe({ root, html, scenes = [] }) {
  const schema = schemaOf('scene');
  const views = schema && schema.$defs && isObject(schema.$defs.views) ? schema.$defs.views.properties ?? {} : {};
  const interactive = propsOf(schema, views.interactive);
  const time = propsOf(schema, views.time);
  const stateJs = readIf(join(root, 'renderers', 'viewer', 'state.js'));
  const keys = stateJs ? /DF\.KEYS\s*=\s*\[([^\]]*)\]/.exec(stateJs) : null;
  const keyList = keys ? [...keys[1].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]) : [];
  const loops = motionLoops(html);
  const truth = edgeLabelTruth(scenes, readIf(join(root, 'renderers', 'tokens.css')) ?? undefined);
  return {
    time_block: isObject(views.time) ? true : NOT_IMPLEMENTED,
    playhead_in_hash: keyList.includes('t') ? true : NOT_IMPLEMENTED,
    playhead_core_present: existsSync(join(root, 'lib', 'time', 'playhead.mjs')) ? true : NOT_IMPLEMENTED,
    compare_verb: existsSync(join(root, 'lib', 'commands', 'compare.mjs')) ? true : NOT_IMPLEMENTED,
    steps_in_schema: isObject(interactive.steps) ? true : NOT_IMPLEMENTED,
    trace_block_in_schema: isObject(time.trace) ? true : NOT_IMPLEMENTED,
    no_infinite_motion: loops.length === 0,
    infinite_motion_hits: loops.map((h) => `${h.where}: ${h.match}`),
    edge_label_truth: truth.edge_label_truth,
  };
}

// The properties of a schema node, following same-document "#/$defs/<name>" refs (views.time is one).
function propsOf(schema, node) {
  for (let hops = 0; isObject(node) && typeof node.$ref === 'string' && hops < 8; hops += 1) {
    const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(node.$ref);
    node = m && schema && isObject(schema.$defs) ? schema.$defs[m[1]] : null;
  }
  return isObject(node) && isObject(node.properties) ? node.properties : {};
}

function readIf(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; }
}

function skillPatterns(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!fm) return [];
  const m = /allowed-tools:\s*([\s\S]*?)(?:\n[A-Za-z][\w-]*:|$)/.exec(fm[1]);
  return m ? [...m[1].matchAll(/Bash\(([^)]*)\)/g)].map((x) => x[1]) : [];
}

export function agentProbe({ root, tools, receiptRoundTrip = null }) {
  const skill = readIf(join(root, '.claude', 'skills', 'dotfield', 'SKILL.md'));
  const skillTest = readIf(join(root, 'test', 'skill.test.js'));
  const forbidden = skillTest ? /FORBIDDEN_COMMANDS\s*=\s*\[([\s\S]*?)\];/.exec(skillTest) : null;
  const forbiddenCount = forbidden ? [...forbidden[1].matchAll(/'node bin\/dotfield\.mjs [^']*'/g)].length : 0;
  const settings = readIf(join(root, '.claude', 'settings.json'));
  const hooks = existsSync(join(root, '.claude', 'hooks.json')) || (settings !== null && /"hooks"\s*:/.test(settings));
  const approve = readIf(join(root, 'lib', 'commands', 'approve.mjs')) || '';
  const receiptSchema = schemaOf('receipt');
  const list = Array.isArray(tools) ? tools : [];
  return {
    skill_lines: skill ? skill.replace(/\n$/, '').split('\n').length : 0,
    skill_allowed_patterns: skillPatterns(skill).length,
    skill_wildcard_free: skillPatterns(skill).every((p) => /^node bin\/dotfield\.mjs [a-z][a-z ]*\*$/.test(p.trim())),
    forbidden_commands_tested: forbiddenCount,
    cc_hook_reminder_present: hooks,
    mcp_tools: list.length,
    mcp_present: list.length > 0,
    mcp_annotations_present: list.length > 0 && list.every((t) => isObject(t.annotations) && typeof t.annotations.readOnlyHint === 'boolean'),
    approve_tool_absent: !list.some((t) => /approve|project|export|delete/i.test(String(t.name ?? t))),
    owner_gate_present: /CLAUDECODE/.test(approve) && /token-file/.test(approve) && /isTTY|TTY/.test(approve),
    gate_enforced: /CLAUDECODE/.test(approve) && /token-file/.test(approve) && !list.some((t) => /approve/i.test(String(t.name ?? t))),
    rule_codes: CODES.length,
    rule_families: FAMILIES.length,
    codes_without_repair: CODES.filter((c) => !(typeof RULES[c].repair === 'string' && RULES[c].repair.trim().length >= 10)).length,
    receipt_required_fields: receiptSchema && Array.isArray(receiptSchema.required) ? receiptSchema.required.length : 0,
    receipt_round_trip: receiptRoundTrip,
    prev_digest_in_schema: Boolean(receiptSchema && isObject(receiptSchema.properties) && isObject(receiptSchema.properties.prev_digest)),
  };
}

function walk(root, rel, exts, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !(rel === 'vendor' && e.name === 'three')) walk(root, join(rel, e.name), exts, out); }
    else if (e.isFile() && exts.has(extname(e.name))) out.push(join(rel, e.name).split(sep).join('/'));
  }
  return out;
}
const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

export function maintainabilityProbe({ root, testSummary = null }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let coreLoc = 0;
  for (const rel of CORE_DIRS.flatMap((d) => walk(root, d, CODE_EXTS, []))) coreLoc += lineCount(readFileSync(join(root, rel), 'utf8'));
  let maxLines = 0; let maxFile = null; let over = 0;
  for (const rel of SCAN_DIRS.flatMap((d) => walk(root, d, SOURCE_EXTS, []))) {
    const n = lineCount(readFileSync(join(root, rel), 'utf8'));
    if (n >= 400) over += 1;
    if (n > maxLines) { maxLines = n; maxFile = rel; }
  }
  const testDir = join(root, 'test');
  const testFiles = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith('.test.js')).length : 0;
  return {
    dependencies: Object.keys(pkg.dependencies ?? {}).length,
    optional_dependencies: Object.keys(pkg.optionalDependencies ?? {}).length,
    core_loc: coreLoc, max_file_lines: maxLines, max_file: maxFile, files_at_or_over_400: over,
    test_files: testFiles,
    test_calls: testSummary && Number.isInteger(testSummary.tests) ? testSummary.tests : null,
    tests_passed: testSummary && Number.isInteger(testSummary.pass) ? testSummary.pass : null,
    tests_failed: testSummary && Number.isInteger(testSummary.fail) ? testSummary.fail : null,
    test_calls_source: testSummary ? 'node --test runner summary' : 'not run (--quick)',
    zero_dependencies: Object.keys(pkg.dependencies ?? {}).length === 0,
    // ci_workflow_shipped is what the checklist reads: it is the same inside another repository and after a subtree split,
    // so the committed block never flips at the split. ci_tests_present (JSON only) also needs this copy to be a
    // repository root, because GitHub runs workflows from the root only.
    ci_workflow_shipped: existsSync(join(root, '.github', 'workflows', 'dotfield.yml')),
    ci_tests_present: testFiles > 0 && existsSync(join(root, '.github', 'workflows', 'dotfield.yml')) && existsSync(join(root, '.git')),
  };
}

/** Layout modes and the gate policy the checklist reads as booleans. */
export function layoutProbe() {
  return {
    modes_2d: [...layout.MODES_2D], modes_3d: [...layout.MODES_3D],
    layered_mode: layout.MODES_2D.includes('layered'),
    sequence_mode: layout.MODES_2D.includes('sequence'),
    lifecycle_mode: layout.MODES_2D.includes('lifecycle'),
    gate_blocks_overlap: Boolean(RULES.DF_LAYOUT_OVERLAP && RULES.DF_LAYOUT_OVERLAP.blocking === true),
  };
}

/** Scene kinds the IR declares. */
export function typesProbe() {
  const schema = schemaOf('scene');
  const kinds = schema && isObject(schema.properties) && isObject(schema.properties.kind) && Array.isArray(schema.properties.kind.enum) ? schema.properties.kind.enum : [...SCENE_KINDS];
  return { scene_kinds: kinds.length, kinds: [...kinds], sequence_kind: kinds.includes('sequence'), lifecycle_kind: kinds.includes('lifecycle'), ten_or_more: kinds.length >= 10 };
}

/** What the built HTML carries, read from the string the script rendered. */
export function viewerProbe(html) {
  const h = String(html ?? '');
  return {
    key_table_present: (h.match(/DF\.HELP\s*=/g) || []).length === 1,
    key_tables: (h.match(/DF\.HELP\s*=/g) || []).length,
    hash_state_present: /DF\.parseHash\s*=/.test(h) && /location\.hash/.test(h),
    three_d_panel: /data-view="3d"/.test(h),
    vr_panel: /data-view="vr"/.test(h),
    export_buttons: /data-df="export-svg"/.test(h) && /data-df="export-png"/.test(h),
    focusable_nodes: /<g [^>]*data-node-id="[^"]+"[^>]*tabindex="0"/.test(h),
  };
}

/** Surfaces later components add; each is present | absent by file, never a claim. */
export function surfaceProbe(root) {
  return {
    interchange_export_present: existsSync(join(root, 'lib', 'export')),
    kinds_schema_present: existsSync(join(root, 'schemas', 'kinds.schema.json')),
    sketch_schema_present: existsSync(join(root, 'schemas', 'sketch.schema.json')),
    templates_present: existsSync(join(root, 'templates')) && readdirSync(join(root, 'templates')).some((f) => f.endsWith('.sketch.json')),
    packs_present: existsSync(join(root, 'packs')) && readdirSync(join(root, 'packs')).some((d) => existsSync(join(root, 'packs', d, 'pack.json'))),
    share_rule_schema_present: existsSync(join(root, 'schemas', 'share-rule.schema.json')),
    signing_present: existsSync(join(root, 'lib', 'sign.mjs')),
  };
}

export function verificationProbe(agent) {
  return { repair_complete: agent.rule_codes > 0 && agent.codes_without_repair === 0, receipt_verify_ok: agent.receipt_round_trip === true, receipts_per_action: agent.receipt_required_fields > 0 };
}

/** Every probe family in one object; `scenes` are the shipped scenes (parity and determinism), `html`/`htmlEmbedded` the two --view all renders of one scene. */
export function probes({ root, html, htmlEmbedded, scenes = [], tools = [], testSummary = null, receiptRoundTrip = null, renderDigests = null }) {
  const r = resolve(root);
  const agent = agentProbe({ root: r, tools, receiptRoundTrip });
  return {
    standalone: standaloneProbe({ html, htmlEmbedded }),
    parity: parityProbe(scenes),
    determinism: determinismProbe(scenes, { renderDigests }),
    fourd: fourdProbe({ root: r, html, scenes }),
    agent,
    verification: verificationProbe(agent),
    layout: layoutProbe(),
    types: typesProbe(),
    viewer: viewerProbe(html),
    surface: surfaceProbe(r),
    maintainability: maintainabilityProbe({ root: r, testSummary }),
  };
}

export function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
