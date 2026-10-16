// One scene through the real pipeline, in process, with the layout gate's
// determinism probe memoised across qualities (V2_PLAN §9 --quick rule):
// schema -> topology -> privacy (lib/pipeline.mjs runGates), relayout(),
// lib/gates/layout.mjs check(laid, ctx, {runner}), then renderScene() and
// the render gate — the same order `render` runs. Pure over (scene, ctx):
// no clock (ctx.now is the caller's), no child process, nothing written;
// timings are the script's business. Fails are grouped by code with the
// 200-row cap sentinel parsed into {shown, total, capped}.
//
//   measureScene(scene, ctx, { quality, views, runner, metrics, v1ViewBox }) -> row
//   failsByCode(checks) -> { CODE: { rows, shown, total, capped, blocking } }
import { join } from 'node:path';
import * as layoutGate from '../gates/layout.mjs';
import { gateContext, isBlockingFail, relayout, renderScene, runGates } from '../pipeline.mjs';
import { mode2dOf } from '../layout/index.mjs';
import { labelLegibility, layoutMetrics, oneEditStability } from './metrics.mjs';
import { parseCapSentinel } from './probes.mjs';

export const PRE_LAYOUT = Object.freeze(['schema', 'topology', 'privacy']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Group failing checks by code; the cap sentinel row is counted in `rows`, excluded from `shown`, and sets `total` when it carries one. */
export function failsByCode(checks) {
  const out = {};
  for (const c of checks) {
    if (!c || c.status !== 'fail') continue;
    const e = out[c.code] ?? (out[c.code] = { rows: 0, shown: 0, total: null, capped: false, blocking: false });
    e.rows += 1;
    const cap = parseCapSentinel(c.message);
    if (cap) { e.capped = true; if (cap.total !== null) e.total = cap.total; } else e.shown += 1;
    if (c.blocking === true) e.blocking = true;
  }
  for (const e of Object.values(out)) if (e.total === null) e.total = e.shown;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const summary = (checks) => {
  const fails = checks.filter((c) => c.status === 'fail');
  return { checks: checks.length, failed: fails.length, blocking_failures: fails.filter((c) => c.blocking === true).length };
};

/**
 * measureScene(scene, ctx, opts) -> {
 *   status: 'written' | 'blocked', blocked_at, exit_code, nodes, edges, mode2d, quality, views,
 *   fails, blocking_failures, non_blocking_failures, metrics, stability, legibility,
 *   render: { bytes_html, bytes_svg, importmap_mode, views, embedded_three } | null,
 *   laid (the laid-out scene, for callers that need the table)
 * }
 * ctx is a command context (lib/context.mjs createContext()); `runner` is the
 * memoised layout runner for the determinism probe; `metrics: false` skips the
 * layout metrics (timing-only rows); `v1ViewBox` is the 2026-10-07 box.
 */
export function measureScene(scene, ctx, { quality = 'checked', views = '2d', runner = null, metrics = true, v1ViewBox = null } = {}) {
  const gctx = gateContext(ctx, { quality, viewer: 'self', requireProjected: false });
  const checks = [];
  const pre = runGates(scene, gctx, PRE_LAYOUT);
  checks.push(...pre.checks);
  const nodes = Array.isArray(scene.nodes) ? scene.nodes.length : 0;
  const edges = Array.isArray(scene.edges) ? scene.edges.length : 0;
  const row = { status: 'blocked', blocked_at: null, exit_code: 2, nodes, edges, mode2d: mode2dOf(scene), quality, views, fails: {}, blocking_failures: 0, non_blocking_failures: 0, metrics: null, stability: null, legibility: null, render: null, laid: null };
  const finish = (laid) => {
    row.fails = failsByCode(checks);
    const s = summary(checks);
    row.blocking_failures = s.blocking_failures; row.non_blocking_failures = s.failed - s.blocking_failures; row.checks = s.checks;
    row.laid = laid;
    return row;
  };
  if (pre.blocked) { row.blocked_at = pre.stopped_at; return finish(pre.scene); }
  const laid = relayout(pre.scene, gctx);
  const lchecks = layoutGate.check(laid, gctx, runner ? { runner } : {});
  checks.push(...lchecks);
  if (metrics) {
    row.metrics = layoutMetrics(laid, { tokensCss: gctx.tokensCss, theme: gctx.theme, v1ViewBox });
    row.stability = oneEditStability(laid, gctx);
  }
  if (lchecks.some(isBlockingFail)) { row.blocked_at = 'layout'; return finish(laid); }
  const outputPath = join(ctx.dotDir, 'renders', 'benchmark', 'out.html');
  const rendered = renderScene(laid, ctx, { views, quality, viewer: 'self', outputPath, requireProjected: false });
  checks.push(...rendered.checks);
  if (rendered.checks.some(isBlockingFail)) { row.blocked_at = 'render'; return finish(laid); }
  row.status = 'written'; row.exit_code = 0;
  const d = rendered.detailed;
  row.render = {
    bytes_html: d ? d.bytes : Buffer.byteLength(rendered.html ?? '', 'utf8'),
    bytes_svg: Buffer.byteLength(rendered.svgStandalone ?? '', 'utf8'),
    importmap_mode: d ? d.importmap.mode : 'none',
    views: rendered.views, embedded_three: rendered.embedThree, release_tag: rendered.releaseTag,
  };
  if (metrics) row.legibility = labelLegibility(rendered.svgStandalone, { tokensCss: gctx.tokensCss });
  return finish(laid);
}

/** The compact per-code table the Markdown prints: `CODE n` with `!` when blocking at that quality and `^` when capped. */
export function failsLabel(fails) {
  const parts = Object.entries(fails).map(([code, f]) => `${code} ${f.total}${f.blocking ? '!' : ''}${f.capped ? '^' : ''}`);
  return parts.length ? parts.join(', ') : 'none';
}

export function isScene(v) {
  return isObject(v) && v.schema_version === 'dotfield.scene/1';
}
