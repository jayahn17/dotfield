// renderers/svg.mjs — scene -> SVG string. The 2D truth: rendered in Node,
// golden-tested, and the very DOM the interactive view pans and zooms (each
// node is a natively focusable <g>, so there is no canvas and no mirror list).
// A pure function of (scene, tokens, playhead): positions, routes and label
// sides come from the committed geometry tables (never re-simulated), sizes
// and the theme's font from lib/layout/metrics.mjs, group regions, region
// labels, sublabels, evidence pins and order badges from
// lib/layout/drawn.mjs (the boxes lib/gates/layout.mjs measures), and the time
// state from lib/time/playhead.mjs visibleAt() at the authored playhead, so
// the still carries the meaning of t. Colours are var(--df-*) only.
//
//   renderSvg(scene, tokens, opts) -> string
//     tokens  tokens.css text (or its parseThemes() result): the label font
//             and size for the theme are read here, colours stay var() refs.
//     opts    {shapes, xmlns=true, ownerId='self', inlineTokens=false, theme, playhead}
//             playhead: the t the still shows (default timeOf(scene).playhead)
//
// svg-edges.mjs draws the edge layer and svg-chrome.mjs the title block, time
// ruler, lifelines, span bars and legend; both import the drawing primitives
// exported here. Nothing runs at import time, so the import cycle is inert.
// One hook: a scene carrying a delta block (dotfield compare) also gets
// svg-delta.mjs's classes, rings, ghosts, move connectors and delta legend;
// without one nothing it draws is emitted, so the output is unchanged.
import { prepare, groupToken } from '../lib/layout/index.mjs';
import { PIN_SIZE, SUBLABEL_SIZE, evidenceLabels, labelBox, labelSide, labelWidth, parsedTokens, pinBoxes, shapesTable, sublabelBox } from '../lib/layout/metrics.mjs';
import { REGION_LABEL_SIZE, drawnItems, regionLabels } from '../lib/layout/drawn.mjs';
import { glyphShapes } from '../lib/layout/labels.mjs';
import { metricFrame, poseOf } from '../lib/layout/metric.mjs';
import { parseThemes } from '../lib/theme.mjs';
import { timeOf, visibleAt } from '../lib/time/playhead.mjs';
import { edgeMarkers, renderEdges } from './svg-edges.mjs';
import { RULER_H, legendRows, renderChrome, renderUnderlay, rulerOf } from './svg-chrome.mjs';
import { deltaLayers } from './svg-delta.mjs';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const GLYPHS = Object.freeze(['circle', 'square', 'diamond', 'hexagon', 'triangle', 'pill', 'ring', 'document', 'pin', 'shield', 'bubble', 'star']);
export const TOKENS_STYLE_ATTR = 'data-df="tokens"';
export const SMALL = 11;
const DASH = '6 4';
const STAR = [[0, -1], [0.265, -0.364], [0.951, -0.309], [0.428, 0.139], [0.588, 0.809], [0, 0.45], [-0.588, 0.809], [-0.428, 0.139], [-0.951, -0.309], [-0.265, -0.364]];

export function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** Numbers at 2 decimals, never "-0", never exponent form: stable across platforms. */
export function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
}
/** fmt at 3 decimals: dash lengths in pathLength units, where 0.01 of a long path is several px. */
export function fmt3(n) {
  const r = Math.round(n * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
}
export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pts = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${fmt(p[0])} ${fmt(p[1])}`).join('') + 'Z';
export const tok = (name) => `var(--df-${name})`;
/** An attribute string from an object; null/undefined/false values are skipped. */
export function attrs(o) {
  return Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
}
/** A <text> whose textLength is the width-table advance of `str` (or `width`, when the caller measured the box itself). */
export function text(cls, x, y, str, style, size, extra = {}, width = null) {
  const w = typeof width === 'number' ? width : labelWidth(str, { ...style, size });
  return `<text${attrs({ class: cls, x: fmt(x), y: fmt(y), 'font-size': fmt(size), textLength: fmt(w), lengthAdjust: 'spacingAndGlyphs', ...extra })}>${escapeXml(str)}</text>`;
}

/** The path of a glyph centred on the origin with circumradius r. Unknown names fall back to a circle. */
export function glyphPath(glyph, r) {
  const s = r * 0.88;
  switch (glyph) {
    case 'square': return `M${fmt(-s)} ${fmt(-s)}H${fmt(s)}V${fmt(s)}H${fmt(-s)}Z`;
    case 'diamond': return pts([[0, -r], [r, 0], [0, r], [-r, 0]]);
    case 'hexagon': return pts([[0, -r], [0.866 * r, -0.5 * r], [0.866 * r, 0.5 * r], [0, r], [-0.866 * r, 0.5 * r], [-0.866 * r, -0.5 * r]]);
    case 'triangle': return pts([[0, -r], [0.866 * r, 0.5 * r], [-0.866 * r, 0.5 * r]]);
    case 'pill': { const h = 0.6 * r; const w = 1.3 * r; return `M${fmt(-w + h)} ${fmt(-h)}H${fmt(w - h)}a${fmt(h)} ${fmt(h)} 0 0 1 0 ${fmt(2 * h)}H${fmt(-w + h)}a${fmt(h)} ${fmt(h)} 0 0 1 0 ${fmt(-2 * h)}Z`; }
    case 'ring': return `${glyphPath('circle', r)}${glyphPath('circle', 0.45 * r)}`;
    case 'document': return pts([[-s, -s], [0.45 * s, -s], [s, -0.45 * s], [s, s], [-s, s]]);
    case 'pin': return `M0 ${fmt(r)}L${fmt(-0.6 * r)} 0A${fmt(0.7 * r)} ${fmt(0.7 * r)} 0 1 1 ${fmt(0.6 * r)} 0Z`;
    case 'shield': return `M0 ${fmt(-r)}L${fmt(0.9 * r)} ${fmt(-0.6 * r)}V${fmt(0.1 * r)}Q${fmt(0.9 * r)} ${fmt(0.7 * r)} 0 ${fmt(r)}Q${fmt(-0.9 * r)} ${fmt(0.7 * r)} ${fmt(-0.9 * r)} ${fmt(0.1 * r)}V${fmt(-0.6 * r)}Z`;
    case 'bubble': return pts([[-r, -0.7 * r], [r, -0.7 * r], [r, 0.5 * r], [-0.2 * r, 0.5 * r], [-0.6 * r, r], [-0.6 * r, 0.5 * r], [-r, 0.5 * r]]);
    case 'star': return pts(STAR.map(([x, y]) => [x * r, y * r]));
    default: return `M${fmt(-r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0Z`;
  }
}

/** Which glyph a node draws: node.shape when it names a known glyph, else the kind's shapes.json row, else circle. */
export function glyphOf(node, shapes) {
  if (GLYPHS.includes(node.shape)) return node.shape;
  const row = shapes && isObject(shapes[node.kind]) ? shapes[node.kind] : null;
  return row && GLYPHS.includes(row.glyph2d) ? row.glyph2d : 'circle';
}

export function isForeign(node, ownerId = 'self') {
  const owner = node && node.provenance ? node.provenance.owner_person_id : undefined;
  return node.kind === 'boundary' || node.color_token === 'foreign' || (typeof owner === 'string' && owner !== ownerId && owner !== 'self');
}

function styleBlock(tokens, theme, inlineTokens) {
  const rules = `.df-scene{font-family:var(--df-font-text);color:var(--df-ink)}.df-scene text{fill:var(--df-ink);paint-order:stroke;stroke:var(--df-bg);stroke-width:3px;stroke-linejoin:round}`
    + `.df-title{font-family:var(--df-font-display);font-weight:600}.df-sublabel,.df-edge-label,.df-region-label,.df-legend text,.df-ruler text{fill:var(--df-muted)}.df-eyebrow{fill:var(--df-faint)}.df-pin{fill:var(--df-faint);font-family:var(--df-font-mono)}`
    + `.df-node{cursor:pointer;outline:none}.df-node.df-fresh .df-glyph{stroke:var(--df-fresh);stroke-width:2.5px}.df-node.df-active .df-glyph{stroke:var(--df-active);stroke-width:3px}`
    + `.df-node:focus-visible .df-glyph,.df-node.df-focus .df-glyph{stroke:var(--df-accent);stroke-width:3px}.df-node.df-reach .df-glyph{stroke:var(--df-accent-2);stroke-width:2.5px}`
    + `.df-label--budget{visibility:hidden}.df-node:hover .df-label--budget,.df-node:focus-visible .df-label--budget,.df-node.df-focus .df-label--budget,.df-node.df-reach .df-label--budget{visibility:visible}`
    + `.df-dim{opacity:0.22}.df-unborn{opacity:var(--df-ghost-opacity)}.df-unborn .df-label,.df-unborn .df-sublabel,.df-unborn .df-pin,.df-unborn .df-edge-label,.df-unborn .df-badge{visibility:hidden}.df-hidden{display:none}`
    + `.df-edge{fill:none;stroke-linecap:round;stroke-linejoin:round}.df-scene .df-badge text,.df-scene .df-edge-label--pill{stroke:none}@media print{.df-edge[data-phase]{stroke-dashoffset:0}}`;
  let vars = '';
  if (inlineTokens) {
    const parsed = typeof tokens === 'string' ? parseThemes(tokens) : tokens;
    const base = parsed && parsed.themes ? { ...(parsed.themes.default || {}), ...(parsed.themes[theme] || {}) } : {};
    vars = `:root{${Object.entries(base).filter(([k]) => k.startsWith('--df-')).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  }
  return `<style ${TOKENS_STYLE_ATTR}>${vars}</style><style>${rules}</style>`;
}

/** The group regions (lib/layout/drawn.mjs regionShapes) and their labels, each at the first clear place regionLabels() finds, as the gate measures them. */
function regions(input, P, X, Y, g, items) {
  const { groups, style } = input;
  const has = P.map(Boolean);
  const labels = regionLabels(input, X, Y, g, items, has);
  const out = [];
  groups.forEach((gr, gi) => {
    const lab = labels[gi];
    if (!lab) return;
    const { shape } = lab;
    const token = tok(groupToken(gr));
    const paint = { fill: token, 'fill-opacity': 0.08, stroke: token, 'stroke-opacity': 0.1 };
    let body;
    if (shape.kind !== 'hull') {
      const box = shape.box;
      const extra = shape.kind === 'room' ? { rx: 4, 'stroke-opacity': 0.5, 'stroke-dasharray': DASH } : { rx: 8, 'stroke-opacity': 0.35, 'data-band-axis': shape.axis };
      body = `<rect${attrs({ x: fmt(box.x), y: fmt(box.y), width: fmt(box.w), height: fmt(box.h), ...paint, ...extra })}/>`;
    } else {
      const { hull, pad } = shape.region;
      const stroke = { ...paint, 'stroke-width': fmt(2 * pad), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      if (hull.length === 1) body = `<circle${attrs({ cx: fmt(hull[0][0]), cy: fmt(hull[0][1]), r: fmt(pad), ...paint, 'fill-opacity': 0.1, stroke: null })}/>`;
      else if (hull.length === 2) body = `<path${attrs({ d: `M${fmt(hull[0][0])} ${fmt(hull[0][1])}L${fmt(hull[1][0])} ${fmt(hull[1][1])}`, ...stroke, fill: 'none' })}/>`;
      else body = `<path${attrs({ d: pts(hull), ...stroke })}/>`;
    }
    out.push(`<g${attrs({ class: `df-region df-region--${gr.kind}`, 'data-group-id': gr.id, 'data-kind': gr.kind })}>${body}${text('df-region-label', lab.x, lab.baseline, lab.text, style, REGION_LABEL_SIZE, {}, lab.w)}</g>`);
  });
  return out.join('');
}

function nodeAria(n, foreign) {
  let s = `${n.label}: ${n.kind}${n.status === 'proposal' ? ', proposal' : ''}`;
  if (foreign && n.boundary) s += `, shared by ${n.boundary.shared_by} under ${n.boundary.rule_ref}`;
  else if (foreign) s += `, shared by ${n.provenance.owner_person_id}`;
  const d = n.provenance && Array.isArray(n.provenance.derived_from) ? n.provenance.derived_from : [];
  if (d.length) s += `, derived from ${d.map((x) => x.person_id).join(', ')}`;
  if (n.sublabel) s += `. ${n.sublabel}`;
  return s;
}

function nodes(input, P, style, opts, evidenceLabel, visible, dl) {
  const { shapes, radii, upAxis, scene, measured } = input;
  const mf = scene.kind === 'room' ? metricFrame(input) : null;
  return input.nodes.map((n, i) => {
    const p = P[i] || [input.frame.cx, input.frame.cy];
    const r = radii[i]; const glyph = glyphOf(n, shapes); const foreign = isForeign(n, opts.ownerId);
    const proposal = n.status === 'proposal'; const derived = !!(n.provenance && Array.isArray(n.provenance.derived_from) && n.provenance.derived_from.length);
    const fill = tok(n.color_token || 'muted');
    const cls = ['df-node', `df-node--${n.kind}`, proposal && 'df-node--proposal', foreign && 'df-node--foreign', derived && 'df-node--derived',
      !visible.present.has(n.id) && 'df-unborn', visible.fresh.has(n.id) && 'df-fresh', visible.active === n.id && 'df-active', dl && dl.classOf(n.id)].filter(Boolean).join(' ');
    let body = '';
    if (mf && Array.isArray(n.size_m) && poseOf(n)) {
      const half = upAxis === 'z' ? [n.size_m[0] / 2, n.size_m[1] / 2] : [n.size_m[0] / 2, n.size_m[2] / 2];
      body += `<rect${attrs({ class: 'df-footprint', x: fmt(-half[0] * mf.scale), y: fmt(-half[1] * mf.scale), width: fmt(2 * half[0] * mf.scale), height: fmt(2 * half[1] * mf.scale), fill, 'fill-opacity': 0.12, stroke: fill, 'stroke-opacity': 0.4 })}/>`;
    }
    if (foreign) body += `<circle${attrs({ class: 'df-foreign-ring', r: fmt(r + 3), fill: 'none', stroke: tok('foreign'), 'stroke-width': 2 })}/>`;
    body += `<path${attrs({ class: `df-glyph df-glyph--${glyph}`, d: glyphPath(glyph, r), 'fill-rule': glyph === 'ring' ? 'evenodd' : null, fill, 'fill-opacity': proposal ? 0.3 : null, stroke: proposal ? fill : tok('bg'), 'stroke-width': 1.5, 'stroke-dasharray': proposal ? tok('proposal-dash') : null })}/>`;
    const side = labelSide(scene, n, shapes);
    const box = labelBox(n, p, r, style, shapes, side);
    // A label beyond the budget is drawn hidden, and so are its sublabel and pins: what is visible is what the gate measured.
    const budget = typeof n.label === 'string' && n.label && !measured.has(i) ? ' df-label--budget' : '';
    if (typeof n.label === 'string' && n.label) body += text(`df-label${budget}`, box.x - p[0], box.y - p[1] + style.size, n.label, style, style.size);
    const sub = sublabelBox(n, p, r, style, shapes, side);
    if (sub) body += text(`df-sublabel${budget}`, sub.x - p[0], sub.baseline - p[1], n.sublabel, style, SUBLABEL_SIZE, {}, sub.w);
    for (const pin of pinBoxes(n, p, r, style, evidenceLabel)) body += text(`df-pin${budget}`, pin.dx, pin.dy, pin.label, style, PIN_SIZE, { 'data-evidence-id': pin.id }, pin.w);
    return `<g${attrs({ class: cls, 'data-node-id': n.id, 'data-kind': n.kind, 'data-status': n.status, 'data-owner': n.provenance && n.provenance.owner_person_id, 'data-group': typeof n.group === 'string' ? n.group : null, 'data-room': typeof n.room === 'string' ? n.room : null, 'data-token': n.color_token, 'data-unplaced': P[i] ? null : 'true', tabindex: '0', role: 'button', 'aria-label': nodeAria(n, foreign), transform: `translate(${fmt(p[0])} ${fmt(p[1])})` })}>${body}</g>`;
  }).join('');
}

/** Render a scene to SVG. Never re-simulates: a node without a position sits at the frame centre with data-unplaced="true". */
export function renderSvg(scene, tokens, opts = {}) {
  const s = isObject(scene) ? scene : {};
  const o = { xmlns: true, ownerId: 'self', inlineTokens: false, ...opts };
  const meta = isObject(s.meta) ? s.meta : {};
  const theme = (typeof o.theme === 'string' && o.theme) || (typeof meta.theme === 'string' && meta.theme) || 'default';
  const tokensCss = typeof tokens === 'string' || (isObject(tokens) && isObject(tokens.themes)) ? tokens : undefined;
  const input = prepare(s, { shapes: o.shapes || shapesTable(o), tokensCss, theme });
  const { style, frame } = input;
  const positions = isObject(s.positions) ? s.positions : {};
  const P = input.nodes.map((n) => { const p = positions[n.id]; return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null; });
  const X = Float64Array.from(P, (p) => (p ? p[0] : frame.cx)); const Y = Float64Array.from(P, (p) => (p ? p[1] : frame.cy));
  const g = glyphShapes(input);
  const evidenceLabel = evidenceLabels(s);
  const time = timeOf(s);
  const t = o.playhead === undefined ? null : o.playhead;
  const visible = visibleAt(s, t);
  const ruler = rulerOf(s, time, t);
  const title = String(meta.title ?? meta.id ?? 'scene');
  const vb = [...frame.viewBox]; if (ruler) vb[3] += RULER_H;
  const head = `<svg${attrs({ xmlns: o.xmlns ? SVG_NS : null, viewBox: vb.map(fmt).join(' '), width: fmt(vb[2]), height: fmt(vb[3]), class: 'df-scene', role: 'img', 'aria-label': title, 'data-scene-id': meta.id, 'data-kind': s.kind, 'data-theme': theme, 'data-layout': input.mode2d, 'data-viewer': isObject(s.viewer) ? s.viewer.person_id : null })}>`;
  const under = renderUnderlay(input, P, style, { scene: s, g });
  const rows = meta.legend === true ? legendRows(input, { scene: s, visible, ownerId: o.ownerId }) : [];
  const dl = deltaLayers(s, input, P, style);
  const items = drawnItems(s, input, X, Y, g);
  return `${head}<title>${escapeXml(title)}</title><defs>${edgeMarkers(input, P)}${styleBlock(tokens, theme, o.inlineTokens)}${dl ? dl.style : ''}</defs>`
    + `<g class="df-layer df-layer--regions">${regions(input, P, X, Y, g, items)}</g>`
    + (under ? `<g class="df-layer df-layer--under">${under}</g>` : '')
    + (dl ? `<g class="df-layer df-layer--delta-under">${dl.under}</g>` : '')
    + `<g class="df-layer df-layer--edges">${renderEdges(input, P, style, { scene: s, time, visible, g, items })}</g>`
    + (dl ? `<g class="df-layer df-layer--delta">${dl.over}</g>` : '')
    + `<g class="df-layer df-layer--nodes">${nodes(input, P, style, o, evidenceLabel, visible, dl)}</g>`
    + `<g class="df-chrome">${renderChrome(input, style, { scene: s, time, ruler, legendRows: rows, theme, parsed: parsedTokens(tokensCss) })}${dl ? dl.legend : ''}</g></svg>`;
}
