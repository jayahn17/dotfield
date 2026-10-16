// Sizes the layout and the clearance gate measure with, and the renderers
// draw with: the glyph radius and extent model, the node and edge label
// boxes, the label budget and the default viewBox, and label widths from
// renderers/font-metrics.json (the per-font advance table tokens-theme
// owns). The font follows the theme: --df-font-metrics-<role> and
// --df-label-size are resolved through lib/theme.mjs parseThemes() +
// resolveToken() (the theme block over :root), never by the first match in
// the file. When the metrics file is absent the width falls back to 0.55 em
// per character and labelStyle() says so in `source`.
//
//   glyphRadius(node, shapes)                 -> px
//   glyphExtent(node, shapes)                 -> [halfW, halfH] ([1.3r, 0.6r] for a pill)
//   labelStyle({tokensCss, theme})            -> {stack, size, source, theme}
//   fontStackFor(parsed, role, theme)         -> stack id of display | text | mono
//   labelWidth(text, style)                   -> px
//   labelSide(scene, node, shapes)            -> scene.labels[id] ?? the kind's label_anchor
//   labelBox(node, p, radius, style, shapes, side) -> {x, y, w, h}
//   edgeLabelBox(edge, poly, style)           -> the box an edge label is drawn in
//   sublabelBox(node, p, radius, style, shapes, side) -> the box a node's sublabel is drawn in (null without one)
//   pinBoxes(node, p, radius, style, labelOf) -> the boxes of a node's evidence pins, left to right
//   evidenceLabels(scene)                     -> evidence id -> pin text (the row's label)
//   badgeT(edge) / badgePoint(edge, raw, r, box) / badgeCircle(edge, raw, order, style) -> an order badge's place and disc
//   labelBudgetOf(scene, n) / measuredLabels(nodes, budget) -> the measured labels
//   defaultViewBox(n, spacing, meanLabelW)    -> [0, 0, w, h]
//   shapesTable(ctx)                          -> kind -> row (renderers/shapes.json)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThemes, resolveToken } from '../theme.mjs';
import { circleBoxOverlap, pointAt } from './geometry.mjs';

export const DEFAULT_VIEWBOX = Object.freeze([0, 0, 1600, 1000]);
export const DEFAULT_PADDING = 50;
export const DEFAULT_SPACING = 48;
export const DEFAULT_SCALE_M = 6;
export const GLYPH_RADIUS_PX = 10;
export const GLYPH_GAP_PX = 6;
export const LABEL_GAP_PX = 4;
/** A group region extends this far beyond the outermost member glyph; svg.mjs draws it, the gate measures it. */
export const REGION_PAD_PX = 18;
export const LABEL_LINE_HEIGHT = 1.25;
export const FALLBACK_EM = 0.55;
export const DEFAULT_LABEL_STACK = 'sans';
export const DEFAULT_LABEL_SIZE = 12;
/** Edge labels: svg draws them at 11 px, baseline 4 px above the route point. */
export const EDGE_LABEL_SIZE = 11;
export const EDGE_LABEL_RISE_PX = 4;
export const LABEL_ANCHORS = Object.freeze(['below', 'above', 'right', 'left', 'center']);
/** Sublabels: 11 px, left-aligned with the label box, baseline 3 px above it (label above) or 0.9 em below it. */
export const SUBLABEL_SIZE = 11;
/** Evidence pins: 9 px, from 0.7 r right of the centre, baseline 0.7 r + 3 px above it, 6 px apart. */
export const PIN_SIZE = 9;
export const PIN_GAP_PX = 6;
/** Order badges: a 9 px number on a disc of radius max(7, w/2 + 3), stepped 0.025 of the route clear of the edge label. */
export const BADGE_SIZE = 9;
export const BADGE_R = 7;
export const BADGE_STEP = 0.025;
/** Labels measured by default: every one up to this many nodes, then this many (views.2d.label_budget overrides). */
export const LABEL_BUDGET_DEFAULT = 300;
export const PILL_EXTENT = Object.freeze([1.3, 0.6]);
const ROLE_DEFAULT = Object.freeze({ display: 'grotesk', text: 'sans', mono: 'mono' });
const STACK_ID_RE = /^[a-z][a-z0-9-]*$/;
const SIZE_RE = /^([0-9]+(?:\.[0-9]+)?)px$/;

const RENDERERS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderers');
const FONT_METRICS_FILE = resolve(RENDERERS, 'font-metrics.json');
const TOKENS_FILE = resolve(RENDERERS, 'tokens.css');
const SHAPES_FILE = resolve(RENDERERS, 'shapes.json');

let metricsCache;
let tokensCache;
let shapesCache;
const parsedCache = new Map();

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function readJsonIfPresent(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** renderers/font-metrics.json stacks, read once; null when absent or unreadable. */
export function fontMetrics() {
  if (metricsCache === undefined) {
    const doc = readJsonIfPresent(FONT_METRICS_FILE);
    metricsCache = doc && isObject(doc.stacks) ? doc.stacks : null;
  }
  return metricsCache;
}

function tokensText(tokensCss) {
  if (typeof tokensCss === 'string') return tokensCss;
  if (tokensCache === undefined) {
    try { tokensCache = existsSync(TOKENS_FILE) ? readFileSync(TOKENS_FILE, 'utf8') : ''; } catch { tokensCache = ''; }
  }
  return tokensCache;
}

/** parseThemes(css), memoised by the css string (a handful of distinct token files per process). */
export function parsedTokens(tokensCss) {
  if (isObject(tokensCss) && isObject(tokensCss.themes)) return tokensCss;
  const css = tokensText(tokensCss);
  let parsed = parsedCache.get(css);
  if (!parsed) {
    if (parsedCache.size >= 8) parsedCache.delete(parsedCache.keys().next().value);
    parsed = parseThemes(css);
    parsedCache.set(css, parsed);
  }
  return parsed;
}

/** The width-table id a font role resolves to under a theme (the theme block over :root), else the role's default. */
export function fontStackFor(parsed, role = 'text', theme = 'default') {
  const p = isObject(parsed) && isObject(parsed.themes) ? parsed : parsedTokens(parsed);
  const raw = resolveToken(p, `--df-font-metrics-${role}`, typeof theme === 'string' && theme ? theme : 'default');
  const id = typeof raw === 'string' ? raw.trim() : '';
  return STACK_ID_RE.test(id) ? id : (ROLE_DEFAULT[role] ?? DEFAULT_LABEL_STACK);
}

/** The text stack and label size for a theme: from tokensCss (string or parseThemes() result), else renderers/tokens.css. */
export function labelStyle({ tokensCss, theme = 'default' } = {}) {
  const t = typeof theme === 'string' && theme ? theme : 'default';
  const parsed = parsedTokens(tokensCss);
  const stack = fontStackFor(parsed, 'text', t);
  const rawSize = resolveToken(parsed, '--df-label-size', t);
  const m = typeof rawSize === 'string' ? SIZE_RE.exec(rawSize.trim()) : null;
  const size = m && Number(m[1]) > 0 ? Number(m[1]) : DEFAULT_LABEL_SIZE;
  const stacks = fontMetrics();
  const table = stacks && isObject(stacks[stack]) && isObject(stacks[stack].chars) ? stacks[stack] : null;
  return { stack, size, source: table ? 'font-metrics.json' : 'fallback-0.55em', theme: t };
}

/** Advance width of `text` in px under a labelStyle(): the sum of the table's per-character ems times the size. */
export function labelWidth(text, style = labelStyle()) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  const size = style && style.size > 0 ? style.size : DEFAULT_LABEL_SIZE;
  const stacks = fontMetrics();
  const table = stacks && style && isObject(stacks[style.stack]) ? stacks[style.stack] : null;
  if (!table || !isObject(table.chars)) return str.length * FALLBACK_EM * size;
  const fallback = typeof table.fallback_em === 'number' ? table.fallback_em : (typeof table.avg_em === 'number' ? table.avg_em : FALLBACK_EM);
  let em = 0;
  for (const ch of str) {
    const w = table.chars[ch];
    em += typeof w === 'number' ? w : fallback;
  }
  return em * size;
}

function normalizeShapes(raw) {
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter((r) => isObject(r) && typeof r.kind === 'string').map((r) => [r.kind, r]));
  if (!isObject(raw)) return {};
  return isObject(raw.kinds) ? raw.kinds : raw;
}

/** renderers/shapes.json as kind -> row; ctx.shapes (map, {kinds}, or [{kind}]) overrides the file. */
export function shapesTable(ctx = {}) {
  if (ctx && (isObject(ctx.shapes) || Array.isArray(ctx.shapes))) return normalizeShapes(ctx.shapes);
  if (shapesCache === undefined) shapesCache = normalizeShapes(readJsonIfPresent(SHAPES_FILE));
  return shapesCache;
}

function rowOf(node, shapes) {
  return node && shapes && isObject(shapes[node.kind]) ? shapes[node.kind] : null;
}

function sizeMult(node, shapes) {
  const row = rowOf(node, shapes);
  const m = row ? row.size_mult : undefined;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 1;
}

/** The glyph radius in px: 7 px at weight 0, 10 at 0.5, 13 at 1, times the kind's size_mult. */
export function glyphRadius(node, shapes = shapesTable()) {
  const w = node && typeof node.weight === 'number' && Number.isFinite(node.weight) ? Math.min(1, Math.max(0, node.weight)) : 0.5;
  return GLYPH_RADIUS_PX * (0.7 + 0.6 * w) * sizeMult(node, shapes);
}

/** shape: pill on the node, or glyph2d pill for its kind. */
export function isPillGlyph(node, shapes = shapesTable()) {
  if (node && node.shape === 'pill') return true;
  const row = rowOf(node, shapes);
  return !!row && row.glyph2d === 'pill';
}

/** Half extents of a glyph: [1.3 r, 0.6 r] for a pill (layered-order.mjs extentOf agrees), else [r, r]. */
export function glyphExtent(node, shapes = shapesTable()) {
  const r = glyphRadius(node, shapes);
  return isPillGlyph(node, shapes) ? [PILL_EXTENT[0] * r, PILL_EXTENT[1] * r] : [r, r];
}

/** Where the label sits relative to the glyph by default: the kind's shapes.json label_anchor, else below. */
export function labelAnchor(node, shapes = shapesTable()) {
  const row = rowOf(node, shapes);
  const a = row ? row.label_anchor : undefined;
  return LABEL_ANCHORS.includes(a) ? a : 'below';
}

/** The side a node's label is drawn on: the layout's sparse scene.labels entry, else the default anchor. */
export function labelSide(scene, node, shapes = shapesTable()) {
  const table = isObject(scene) && isObject(scene.labels) ? scene.labels : null;
  const side = table && node && typeof node.id === 'string' && Object.hasOwn(table, node.id) ? table[node.id] : undefined;
  return LABEL_ANCHORS.includes(side) ? side : labelAnchor(node, shapes);
}

/** The box a label of width w and height h occupies on `side` of a glyph of the given radius centred at p. */
export function sideBox(p, radius, w, h, side) {
  const x = p[0];
  const y = p[1];
  switch (side) {
    case 'above': return { x: x - w / 2, y: y - radius - LABEL_GAP_PX - h, w, h };
    case 'right': return { x: x + radius + LABEL_GAP_PX, y: y - h / 2, w, h };
    case 'left': return { x: x - radius - LABEL_GAP_PX - w, y: y - h / 2, w, h };
    case 'center': return { x: x - w / 2, y: y - h / 2, w, h };
    default: return { x: x - w / 2, y: y + radius + LABEL_GAP_PX, w, h };
  }
}

/** The axis-aligned box a node's label occupies for a glyph centred at p; `side` defaults to the kind's anchor. */
export function labelBox(node, p, radius, style = labelStyle(), shapes = shapesTable(), side = undefined) {
  const text = node && typeof node.label === 'string' ? node.label : '';
  const w = labelWidth(text, style);
  const h = (style && style.size > 0 ? style.size : DEFAULT_LABEL_SIZE) * LABEL_LINE_HEIGHT;
  return sideBox(p, radius, w, h, LABEL_ANCHORS.includes(side) ? side : labelAnchor(node, shapes));
}

/** The exact box an edge label is drawn in: 11 px, centred at pointAt(poly, label_at ?? 0.5), baseline 4 px above. */
export function edgeLabelBox(edge, poly, style = labelStyle()) {
  const text = edge && typeof edge.label === 'string' ? edge.label : '';
  const at = edge && typeof edge.label_at === 'number' && Number.isFinite(edge.label_at) ? edge.label_at : 0.5;
  const q = pointAt(poly, at);
  const w = labelWidth(text, { ...style, size: EDGE_LABEL_SIZE });
  return { x: q[0] - w / 2, y: q[1] - EDGE_LABEL_RISE_PX - EDGE_LABEL_SIZE, w, h: EDGE_LABEL_SIZE * LABEL_LINE_HEIGHT };
}

/** The box a node's sublabel is drawn in (svg.mjs): SUBLABEL_SIZE at the label box's x, on the label's side; null without a sublabel. */
export function sublabelBox(node, p, radius, style = labelStyle(), shapes = shapesTable(), side = undefined) {
  if (!node || typeof node.sublabel !== 'string' || !node.sublabel) return null;
  const s = LABEL_ANCHORS.includes(side) ? side : labelAnchor(node, shapes);
  const lb = labelBox(node, p, radius, style, shapes, s);
  const baseline = s === 'above' ? lb.y - 3 : lb.y + lb.h + SUBLABEL_SIZE * 0.9;
  const w = labelWidth(node.sublabel, { ...style, size: SUBLABEL_SIZE });
  return { x: lb.x, y: baseline - SUBLABEL_SIZE, w, h: SUBLABEL_SIZE * LABEL_LINE_HEIGHT, baseline };
}

/** Evidence id -> the pin text a node draws for it (the evidence row's label; the id itself when the row has none). */
export function evidenceLabels(scene) {
  const rows = isObject(scene) && Array.isArray(scene.evidence) ? scene.evidence.filter(isObject) : [];
  return new Map(rows.map((e) => [e.id, e.label]));
}

/** The boxes of a node's evidence pins (svg.mjs draws one 9 px text per evidence id), left to right; dx/dy are the text origin relative to p. */
export function pinBoxes(node, p, radius, style = labelStyle(), labelOf = null) {
  const out = [];
  let dx = radius * 0.7; const dy = -radius * 0.7 - 3;
  for (const id of node && Array.isArray(node.evidence_ids) ? node.evidence_ids : []) {
    const label = (labelOf && labelOf.get(id)) || id;
    const w = labelWidth(label, { ...style, size: PIN_SIZE });
    out.push({ id, label, dx, dy, x: p[0] + dx, y: p[1] + dy - PIN_SIZE, w, h: PIN_SIZE * LABEL_LINE_HEIGHT });
    dx += w + PIN_GAP_PX;
  }
  return out;
}

const clampT = (t) => (t < 0.05 ? 0.05 : (t > 0.95 ? 0.95 : t));
/** Where along the route an order badge sits: label_at − 0.1 beside a label, label_at without one, clamped to [0.05, 0.95]. */
export function badgeT(edge) {
  const at = isObject(edge) && typeof edge.label_at === 'number' && Number.isFinite(edge.label_at) ? edge.label_at : 0.5;
  return clampT(isObject(edge) && typeof edge.label === 'string' && edge.label ? at - 0.1 : at);
}

/**
 * The badge centre on the untrimmed route. Candidates: badgeT(edge), then
 * stepping back by BADGE_STEP to 0.05, then forward from label_at + 0.1 to
 * 0.95. The first candidate clear of the edge's own label box and of
 * `blocked(q, r)` (whatever else is drawn: lib/layout/drawn.mjs passes the
 * glyphs, labels, pins, edge labels and earlier badges) wins; else the first
 * clear of the label box alone; else badgeT(edge).
 */
export function badgePoint(edge, raw, r, box, blocked = null) {
  const first = badgeT(edge);
  const at = isObject(edge) && typeof edge.label_at === 'number' && Number.isFinite(edge.label_at) ? edge.label_at : 0.5;
  const ts = [];
  for (let k = 0; first - k * BADGE_STEP >= 0.05 - 1e-9; k += 1) ts.push(clampT(first - k * BADGE_STEP));
  if (box) for (let k = 0; at + 0.1 + k * BADGE_STEP <= 0.95 + 1e-9; k += 1) ts.push(clampT(at + 0.1 + k * BADGE_STEP));
  const ownClear = (q) => !box || !circleBoxOverlap(q[0], q[1], r + 1, box);
  if (typeof blocked === 'function') for (const t of ts) { const q = pointAt(raw, t); if (ownClear(q) && !blocked(q, r)) return q; }
  if (box) for (const t of ts) { const q = pointAt(raw, t); if (ownClear(q)) return q; }
  return pointAt(raw, first);
}

/** The disc of an order badge (svg-edges.mjs draws the one lib/layout/drawn.mjs placed): {cx, cy, r, w} with w the number's advance. */
export function badgeCircle(edge, raw, order, style = labelStyle(), blocked = null) {
  const w = labelWidth(String(order), { ...style, size: BADGE_SIZE });
  const r = Math.max(BADGE_R, w / 2 + 3);
  const box = isObject(edge) && typeof edge.label === 'string' && edge.label ? edgeLabelBox(edge, raw, style) : null;
  const q = badgePoint(edge, raw, r, box, blocked);
  return { cx: q[0], cy: q[1], r, w };
}

/** How many labels are measured: views.2d.label_budget, else every one up to 300 nodes, then 300. */
export function labelBudgetOf(scene, nodeCount) {
  const v2 = isObject(scene) && isObject(scene.views) && isObject(scene.views['2d']) ? scene.views['2d'] : {};
  if (Number.isInteger(v2.label_budget) && v2.label_budget >= 0) return v2.label_budget;
  const n = Number.isInteger(nodeCount) && nodeCount > 0 ? nodeCount : 0;
  return n <= LABEL_BUDGET_DEFAULT ? n : LABEL_BUDGET_DEFAULT;
}

function weightOf(node) {
  return node && typeof node.weight === 'number' && Number.isFinite(node.weight) ? node.weight : 0.5;
}

/** The indices whose labels are measured: labelled nodes ranked by weight (heaviest first) then index, the first `budget`. */
export function measuredLabels(nodes, budget) {
  const list = Array.isArray(nodes) ? nodes : [];
  const labelled = [];
  list.forEach((n, i) => { if (n && typeof n.label === 'string' && n.label.length) labelled.push(i); });
  labelled.sort((a, b) => (weightOf(list[b]) - weightOf(list[a])) || (a - b));
  return new Set(labelled.slice(0, Number.isInteger(budget) && budget > 0 ? budget : 0));
}

/**
 * A viewBox sized for n nodes when the scene declares none: 1600x1000 up to
 * the area the glyphs need (2.2 n spacing^2, the 2026-10-07 rule), plus
 * room for the labels: 1.5 n meanLabelW (label height + spacing), where
 * meanLabelW is the measured label width summed over the budget and divided
 * by n. meanLabelW = 0 reproduces the old box exactly.
 */
export function defaultViewBox(n, spacing, meanLabelW = 0) {
  const lw = typeof meanLabelW === 'number' && meanLabelW > 0 ? meanLabelW : 0;
  const lineH = DEFAULT_LABEL_SIZE * LABEL_LINE_HEIGHT;
  const area = Math.max(1600 * 1000, n * spacing * spacing * 2.2 + 1.5 * n * lw * (lineH + spacing));
  const w = Math.ceil(Math.sqrt(area * 1.6) / 10) * 10;
  const h = Math.ceil(w / 1.6 / 10) * 10;
  return [0, 0, w, h];
}

/** Test hook: forget the cached files so a test can point at other content. */
export function clearMetricsCache() {
  metricsCache = undefined;
  tokensCache = undefined;
  shapesCache = undefined;
  parsedCache.clear();
}
