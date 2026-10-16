// lib/theme.mjs — brand.json → tokens.generated.css + WCAG contrast ledger + inlined brand fonts.
// Pure functions over strings and plain objects: no clock, no randomness, no network, never throws
// on bad input (failures come back as checks shaped like every other gate finding).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FONT_METRICS_PATH = join(HERE, "..", "renderers", "font-metrics.json");
export const FONT_METRICS = JSON.parse(readFileSync(FONT_METRICS_PATH, "utf8"));
export const STACK_IDS = Object.keys(FONT_METRICS.stacks);
export const ROOM_PRESETS = ["default", "light", "paper", "studio", "field", "story", "editorial", "blueprint"];
export const FONT_ROLES = ["display", "text", "mono"];
export const DENSITIES = { compact: 0.85, comfortable: 1, spacious: 1.2 };
export const TEXT_TOKENS = ["ink", "muted", "faint", "accent", "accent-2", "good", "warn", "bad", "info", "foreign"];
export const SURFACE_TOKENS = ["bg", "bg-chrome", "panel", "panel-2"];
export const OWNER_TEXT = new Set(["ink", "accent", "ink-invert"]); // set by brand.json; refused, never nudged
export const MIN_CONTRAST = 4.5;
export const MIN_GRAPHIC_CONTRAST = 3;
export const LEDGER_START = "/* @df-ledger:start";
export const LEDGER_END = "@df-ledger:end */";
export const BRAND_SELECTOR = ':root:not([data-theme]), :root[data-theme="brand"]';
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

// ── colour math (WCAG 2.x) ─────────────────────────────────────────────────────
export function parseColor(str) {
  const s = String(str ?? "").trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split("").map((c) => parseInt(c + c, 16));
      return { r, g, b, a: h.length === 4 ? a / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, a)) };
  }
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}
export function toHex({ r, g, b }) {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
export function luminance({ r, g, b }) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function composite(fg, bg) {
  const a = fg.a ?? 1;
  if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const mix = (f, b2) => f * a + b2 * (1 - a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}
export function contrastRatio(fg, bg) {
  const l1 = luminance(composite(fg, bg)), l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
export const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
const rgba = (c, a) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;

export function rotateHue(c, deg) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - C / 2;
  const [r1, g1, b1] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255, a: 1 };
}

const roundRgb = (c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 1 });
/** Ratio as the ledger prints it: floored to two decimals, so "passes" means the printed number passes. */
export const ledgerRatio = (fg, bg) => Math.floor(contrastRatio(fg, bg) * 100) / 100;
/** Smallest move of `fg` toward black or white whose integer-rgb result reaches `min` on `bg`; rgb or null. */
export function nearestPassing(fg, bg, min = MIN_CONTRAST) {
  const base = composite(fg, bg);
  if (ledgerRatio(base, bg) >= min) return base;
  const dirs = luminance(bg) >= 0.18 ? [BLACK, WHITE] : [WHITE, BLACK];
  for (const pole of dirs) {
    if (ledgerRatio(pole, bg) < min) continue;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) { const t = (lo + hi) / 2; if (contrastRatio(mix(base, pole, t), bg) >= min) hi = t; else lo = t; }
    for (let t = hi; t <= 1; t += 0.002) { const out = roundRgb(mix(base, pole, t)); if (ledgerRatio(out, bg) >= min) return out; }
    return roundRgb(pole);
  }
  return null;
}

// ── CSS theme parser ───────────────────────────────────────────────────────────
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
function parseBlocks(css, media = null, out = []) {
  let i = 0, prelude = "";
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      let depth = 1, j = i + 1;
      while (j < css.length && depth > 0) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
      const body = css.slice(i + 1, j - 1), sel = prelude.trim();
      if (sel.startsWith("@media")) parseBlocks(body, sel, out);
      else if (!sel.startsWith("@")) out.push({ selector: sel, body, media });
      else out.push({ selector: sel, body, media, at: true });
      prelude = ""; i = j;
    } else if (ch === ";" && !prelude.includes("{")) { prelude = ""; i++; } else { prelude += ch; i++; }
  }
  return out;
}
export function themeNameFor(selector, media) {
  const sel = selector.replace(/\s+/g, " ").trim();
  if (sel === BRAND_SELECTOR) return "brand";
  if (media && /prefers-color-scheme:\s*light/.test(media) && sel === ":root:not([data-theme])") return "auto-light";
  if (media) return null;
  if (sel === ":root") return "default";
  const m = sel.match(/^:root\[data-theme="([a-z][a-z0-9-]*)"\]$/);
  return m ? m[1] : null;
}
/** css → { order: string[], themes: { [name]: { "--df-x": "value", ..., "color-scheme"?: "dark"|"light" } } } */
export function parseThemes(css) {
  const order = [], themes = {};
  for (const b of parseBlocks(stripComments(css))) {
    const name = b.at ? null : themeNameFor(b.selector, b.media);
    if (!name) continue;
    if (!themes[name]) { themes[name] = {}; order.push(name); }
    for (const decl of b.body.split(";")) {
      const k = decl.indexOf(":"); if (k < 0) continue;
      const prop = decl.slice(0, k).trim(), val = decl.slice(k + 1).trim();
      if (prop.startsWith("--df-") || prop === "color-scheme") themes[name][prop] = val;
    }
  }
  return { order, themes };
}
function rawToken(parsed, theme, prop) {
  const t = parsed.themes[theme] || {};
  return t[prop] ?? parsed.themes.default?.[prop];
}
function resolveIn(parsed, theme, value, depth = 0) {
  if (value == null || depth > 16) return value ?? null;
  return value.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi, (_, name, fb) => {
    const v = rawToken(parsed, theme, name);
    return resolveIn(parsed, theme, v ?? fb ?? "", depth + 1);
  });
}
const tokenName = (name) => (name.startsWith("--") ? name : `--df-${name}`);
/** resolveToken(css, "ink" | "--df-ink", theme = "default") → resolved value string (var() chains followed) or null */
export function resolveToken(css, name, theme = "default") {
  const parsed = typeof css === "string" ? parseThemes(css) : css;
  const raw = rawToken(parsed, theme, tokenName(name));
  return raw == null ? null : resolveIn(parsed, theme, raw);
}
export function resolveColor(parsed, theme, name) {
  const v = resolveToken(parsed, name, theme);
  return v == null ? null : parseColor(v);
}

// ── contrast ledger ────────────────────────────────────────────────────────────
const fmt = (n) => n.toFixed(2).padStart(5);
/** buildLedger(css) → { text, pairs, failures, mirror: {ok, diffs}, errors } for every theme in the css. */
export function buildLedger(css) {
  const parsed = parseThemes(css), pairs = [], failures = [], errors = [], lines = [];
  const themes = parsed.order.filter((t) => t !== "auto-light");
  for (const theme of themes) {
    const bg = resolveColor(parsed, theme, "bg");
    if (!bg) { errors.push(`${theme}: --df-bg does not resolve to a colour`); continue; }
    const surfaces = {};
    for (const s of SURFACE_TOKENS) {
      const c = resolveColor(parsed, theme, s);
      if (!c) { errors.push(`${theme}: --df-${s} does not resolve to a colour`); continue; }
      surfaces[s] = composite(c, bg);
    }
    const scheme = rawToken(parsed, theme, "color-scheme") ?? "dark";
    lines.push(`   ── ${theme} (${scheme}) ──`);
    const row = (text, cells) => lines.push(`   ${text.padEnd(11)}${cells.join("  ")}`);
    for (const text of TEXT_TOKENS) {
      const fg = resolveColor(parsed, theme, text);
      if (!fg) { errors.push(`${theme}: --df-${text} does not resolve to a colour`); continue; }
      const cells = [];
      for (const s of Object.keys(surfaces)) {
        const ratio = Math.floor(contrastRatio(fg, surfaces[s]) * 100) / 100;
        const pair = { theme, text, surface: s, ratio };
        pairs.push(pair); if (ratio < MIN_CONTRAST) failures.push(pair);
        cells.push(`${s} ${fmt(ratio)}`);
      }
      row(text, cells);
    }
    const inv = resolveColor(parsed, theme, "ink-invert"), acc = resolveColor(parsed, theme, "accent");
    if (inv && acc) {
      const ratio = Math.floor(contrastRatio(inv, composite(acc, bg)) * 100) / 100;
      const pair = { theme, text: "ink-invert", surface: "accent", ratio };
      pairs.push(pair); if (ratio < MIN_CONTRAST) failures.push(pair);
      row("ink-invert", [`accent ${fmt(ratio)}`]);
    } else errors.push(`${theme}: --df-ink-invert or --df-accent does not resolve to a colour`);
  }
  const mirror = { ok: true, diffs: [] };
  if (parsed.themes["auto-light"] || parsed.themes.light) {
    const a = parsed.themes["auto-light"] || {}, l = parsed.themes.light || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(l)])) if (a[k] !== l[k]) mirror.diffs.push(k);
    mirror.ok = mirror.diffs.length === 0;
  }
  const head = [
    "   CONTRAST LEDGER — WCAG 2.x, var() chains resolved, rgba() composited over the theme's own --df-bg.",
    "   Generated by scripts/contrast.mjs — do not hand-edit. Every text/surface pair is >= 4.5:1 (AA, normal text).",
    "   Series tokens are node fills, not text, and are not in this ledger. auto-light is verified identical to light.",
    "",
  ];
  return { text: [...head, ...lines].join("\n"), pairs, failures, mirror, errors };
}
export function injectLedger(css, text) {
  const start = css.indexOf(LEDGER_START), end = css.indexOf(LEDGER_END);
  if (start < 0 || end < 0 || end < start) return { css, found: false };
  return { css: css.slice(0, start) + `${LEDGER_START}\n${text}\n   ${LEDGER_END}` + css.slice(end + LEDGER_END.length), found: true };
}

// ── brand.json → generated tokens ──────────────────────────────────────────────
const HEX6 = /^#[0-9a-fA-F]{6}$/, FILE_RE = /^[A-Za-z0-9._-]+\.woff2$/, LOGO_RE = /^[A-Za-z0-9._-]+\.(svg|png)$/;
const fail = (code, path, message, repair, extra = {}) => ({ code, gate: "theme", blocking: true, status: "fail", path, message, repair, ...extra });
const schemaFail = (code, path, message, repair) => ({ ...fail(code, path, message, repair), gate: "schema" });
/** Structural check mirroring schemas/brand.schema.json (the schema stays the gate; this keeps theme.mjs dependency-free). */
export function validateBrand(brand) {
  const f = [];
  if (!brand || typeof brand !== "object" || Array.isArray(brand)) return [schemaFail("DF_SCHEMA_TYPE", "$", "brand must be an object", "Write center/brand.json as a JSON object with name, accent, surface, ink, font and room_preset.")];
  const known = new Set(["schema_version", "name", "accent", "surface", "ink", "font", "room_preset", "files", "logo", "radius", "density"]);
  for (const k of Object.keys(brand)) if (!known.has(k)) f.push(schemaFail("DF_SCHEMA_UNKNOWN_FIELD", `$.${k}`, `unknown field "${k}"`, "Remove it; brand.json is closed (see schemas/brand.schema.json)."));
  for (const k of ["name", "accent", "surface", "ink", "font", "room_preset"]) if (brand[k] === undefined) f.push(schemaFail("DF_SCHEMA_REQUIRED", `$.${k}`, `missing required field "${k}"`, `Add "${k}" to center/brand.json.`));
  if (brand.schema_version !== undefined && brand.schema_version !== "dotfield.brand/1") f.push(schemaFail("DF_SCHEMA_ENUM", "$.schema_version", "schema_version must be dotfield.brand/1", 'Set "schema_version": "dotfield.brand/1".'));
  if (brand.name !== undefined && (typeof brand.name !== "string" || !brand.name.trim() || brand.name.length > 80)) f.push(schemaFail("DF_SCHEMA_TYPE", "$.name", "name must be a non-empty string of at most 80 characters", "Give the center a short display name."));
  for (const k of ["accent", "surface", "ink"]) if (brand[k] !== undefined && !(typeof brand[k] === "string" && HEX6.test(brand[k]))) f.push(schemaFail("DF_SCHEMA_PATTERN", `$.${k}`, `${k} must be a 6-digit hex colour (#rrggbb)`, `Write ${k} as #rrggbb; alpha and shorthand are not accepted.`));
  if (brand.font !== undefined) {
    if (!brand.font || typeof brand.font !== "object") f.push(schemaFail("DF_SCHEMA_TYPE", "$.font", "font must be an object {display, text, mono}", "Pick one stack id per role."));
    else for (const role of FONT_ROLES) if (!STACK_IDS.includes(brand.font[role])) f.push(schemaFail("DF_SCHEMA_ENUM", `$.font.${role}`, `font.${role} must be one of ${STACK_IDS.join("|")}`, "Choose a local stack id from renderers/font-metrics.json."));
  }
  if (brand.room_preset !== undefined && !ROOM_PRESETS.includes(brand.room_preset)) f.push(schemaFail("DF_SCHEMA_ENUM", "$.room_preset", `room_preset must be one of ${ROOM_PRESETS.join("|")}`, "Pick the theme the brand tints."));
  if (brand.files !== undefined) {
    if (!Array.isArray(brand.files)) f.push(schemaFail("DF_SCHEMA_TYPE", "$.files", "files must be an array", "List {path, family, role} objects."));
    else brand.files.forEach((x, i) => {
      const p = `$.files[${i}]`;
      if (!x || typeof x !== "object") return f.push(schemaFail("DF_SCHEMA_TYPE", p, "file entry must be an object", "Use {path, family, role, weight?, style?}."));
      if (!FILE_RE.test(String(x.path))) f.push(schemaFail("DF_SCHEMA_PATTERN", `${p}.path`, "path must be a bare .woff2 filename under center/brand/", "Copy the font into center/brand/ and name the file only."));
      if (typeof x.family !== "string" || !x.family.trim() || x.family.length > 64) f.push(schemaFail("DF_SCHEMA_TYPE", `${p}.family`, "family must be a short font-family name", "Name the family as @font-face should declare it."));
      if (!FONT_ROLES.includes(x.role)) f.push(schemaFail("DF_SCHEMA_ENUM", `${p}.role`, "role must be display|text|mono", "Say which role the file serves."));
      if (x.weight !== undefined && !(Number.isInteger(x.weight) && x.weight >= 100 && x.weight <= 900)) f.push(schemaFail("DF_SCHEMA_TYPE", `${p}.weight`, "weight must be an integer 100..900", "Use a CSS font-weight."));
      if (x.style !== undefined && !["normal", "italic"].includes(x.style)) f.push(schemaFail("DF_SCHEMA_ENUM", `${p}.style`, "style must be normal|italic", "Use a CSS font-style."));
    });
  }
  if (brand.logo !== undefined && !(typeof brand.logo === "string" && LOGO_RE.test(brand.logo))) f.push(schemaFail("DF_SCHEMA_PATTERN", "$.logo", "logo must be a bare .svg or .png filename under center/brand/", "Copy the logo into center/brand/."));
  if (brand.radius !== undefined && !(Number.isInteger(brand.radius) && brand.radius >= 0 && brand.radius <= 24)) f.push(schemaFail("DF_SCHEMA_TYPE", "$.radius", "radius must be an integer 0..24 (px)", "Use the medium corner radius in pixels."));
  if (brand.density !== undefined && !(brand.density in DENSITIES)) f.push(schemaFail("DF_SCHEMA_ENUM", "$.density", "density must be compact|comfortable|spacious", "Pick one density."));
  return f;
}

function nudgeAll(c, surfaces, min) {
  let out = c;
  for (let pass = 0; pass < 4; pass++) {
    const bad = Object.values(surfaces).filter((s) => ledgerRatio(out, s) < min);
    if (!bad.length) return out;
    const worst = bad.sort((a, b) => ledgerRatio(out, a) - ledgerRatio(out, b))[0];
    out = nearestPassing(out, worst, min) ?? out;
  }
  return out;
}
function fontFaces(brand, fontFiles, failures) {
  const fonts = [], css = [], prepend = { display: [], text: [], mono: [] };
  for (const [i, f] of (brand.files ?? []).entries()) {
    const bytes = fontFiles[f.path];
    if (!bytes) { failures.push(fail("DF_THEME_FONT_FILE_MISSING", `$.files[${i}].path`, `font file ${f.path} was not found under center/brand/`, "Copy the .woff2 into center/brand/ or remove the entry.")); continue; }
    const b64 = Buffer.from(bytes).toString("base64"), uri = `data:font/woff2;base64,${b64}`;
    css.push(`@font-face { font-family: "${f.family}"; font-weight: ${f.weight ?? 400}; font-style: ${f.style ?? "normal"}; font-display: swap; src: url("${uri}") format("woff2"); }`);
    fonts.push({ path: f.path, family: f.family, role: f.role, bytes: bytes.length, data_uri_bytes: uri.length });
    if (!prepend[f.role].includes(`"${f.family}"`)) prepend[f.role].push(`"${f.family}"`);
  }
  return { fonts, css, prepend, bytes: fonts.reduce((n, x) => n + x.data_uri_bytes, 0) };
}

/** buildTokens(brand, baseCss, {fontFiles}) → {ok, css, ledger, failures, fonts, bytes}. css is null when refused. */
export function buildTokens(brand, baseCss, { fontFiles = {} } = {}) {
  const failures = validateBrand(brand);
  const empty = { ok: false, css: null, ledger: null, failures, fonts: [], bytes: 0 };
  if (failures.length || typeof baseCss !== "string") { if (typeof baseCss !== "string") failures.push(fail("DF_THEME_BASE_MISSING", "$", "base tokens.css is missing", "Pass the text of renderers/tokens.css.")); return empty; }
  const parsed = parseThemes(baseCss);
  if (!parsed.themes[brand.room_preset]) { failures.push(fail("DF_THEME_PRESET_UNKNOWN", "$.room_preset", `theme ${brand.room_preset} is not in the base tokens`, "Use a theme that renderers/tokens.css defines.")); return empty; }
  const surface = parseColor(brand.surface), ink = parseColor(brand.ink), accent = parseColor(brand.accent);
  const light = luminance(surface) >= 0.18, t = {};
  t["color-scheme"] = light ? "light" : "dark";
  t["--df-bg"] = toHex(surface);
  t["--df-bg-chrome"] = toHex(light ? mix(surface, WHITE, 0.5) : mix(surface, ink, 0.03));
  t["--df-panel"] = toHex(light ? mix(surface, WHITE, 0.6) : mix(surface, ink, 0.05));
  t["--df-panel-2"] = toHex(light ? mix(surface, ink, 0.04) : mix(surface, ink, 0.09));
  const surfaces = {}; for (const s of SURFACE_TOKENS) surfaces[s] = parseColor(t[`--df-${s}`]);
  t["--df-line"] = rgba(ink, 0.18); t["--df-line-strong"] = rgba(ink, 0.45); t["--df-line-quiet"] = rgba(ink, 0.08);
  t["--df-ink"] = toHex(ink); t["--df-ink-invert"] = toHex(surface);
  t["--df-muted"] = toHex(nudgeAll(mix(ink, surface, 0.3), surfaces, MIN_CONTRAST));
  t["--df-faint"] = toHex(nudgeAll(mix(ink, surface, 0.45), surfaces, MIN_CONTRAST));
  t["--df-accent"] = toHex(accent); t["--df-accent-quiet"] = rgba(accent, 0.12);
  t["--df-accent-2"] = toHex(nudgeAll(rotateHue(accent, 40), surfaces, MIN_CONTRAST));
  for (const k of ["good", "warn", "bad", "info", "foreign"]) {
    const c = resolveColor(parsed, brand.room_preset, k) ?? ink;
    t[`--df-${k}`] = toHex(nudgeAll(c, surfaces, MIN_CONTRAST));
  }
  for (let i = 1; i <= 6; i++) t[`--df-series-${i}`] = toHex(nudgeAll(rotateHue(accent, 55 * (i - 1)), { bg: surface }, MIN_GRAPHIC_CONTRAST));
  const faces = fontFaces(brand, fontFiles, failures);
  for (const role of FONT_ROLES) {
    const id = brand.font[role];
    t[`--df-font-${role}`] = [...faces.prepend[role], FONT_METRICS.stacks[id].families].join(", ");
    t[`--df-font-metrics-${role}`] = id;
  }
  if (brand.radius !== undefined) { const r = brand.radius; t["--df-radius-sm"] = `${Math.round(r * 0.75)}px`; t["--df-radius-md"] = `${r}px`; t["--df-radius-lg"] = `${Math.round(r * 1.75)}px`; t["--df-radius-xl"] = `${Math.round(r * 2.75)}px`; }
  if (brand.density !== undefined) {
    const k = DENSITIES[brand.density], base = [0, 4, 8, 12, 16, 24, 32, 48];
    base.forEach((px, i) => { t[`--df-space-${i}`] = `${Math.round(px * k)}px`; });
  }
  const preset = parsed.themes[brand.room_preset];
  const block = [`${BRAND_SELECTOR} {`, `  /* brand "${brand.name.replace(/\*\//g, "")}" — preset ${brand.room_preset}; generated by lib/theme.mjs from center/brand.json; do not hand-edit */`];
  for (const [k, v] of Object.entries({ ...preset, ...t })) block.push(`  ${k}: ${v};`);
  block.push("}");
  const css0 = `${baseCss.replace(/\s+$/, "")}\n\n/* ── BRAND (generated) ── */\n${faces.css.join("\n")}${faces.css.length ? "\n" : ""}${block.join("\n")}\n`;
  const ledger = buildLedger(css0);
  for (const p of ledger.failures.filter((x) => x.theme === "brand")) {
    const field = p.text === "ink" ? "ink" : p.text === "accent" || p.text === "ink-invert" ? "accent" : null;
    const fg = parseColor(t[`--df-${p.text}`]), surf = parseColor(t[`--df-${p.surface}`]);
    const sug = fg && surf ? nearestPassing(p.text === "ink-invert" ? surf : fg, p.text === "ink-invert" ? fg : surf) : null;
    const suggestion = sug ? toHex(sug) : null;
    failures.push(fail("DF_THEME_CONTRAST", field ? `$.${field}` : "$", `--df-${p.text} on --df-${p.surface} is ${p.ratio.toFixed(2)}:1 in theme brand (minimum ${MIN_CONTRAST.toFixed(2)}:1)`,
      suggestion ? `Set ${field ?? p.text} to ${suggestion} (nearest passing value) or move surface further from it.` : "Choose a surface that any text can pass on.", { suggestion, detail: p }));
  }
  for (const e of ledger.errors) failures.push(fail("DF_THEME_TOKEN_UNKNOWN", "$", e, "Fix renderers/tokens.css so every text and surface token resolves to a colour."));
  const { css } = injectLedger(css0, ledger.text);
  return { ok: failures.length === 0, css: failures.length ? null : css, ledger: ledger.text, failures, fonts: faces.fonts, bytes: faces.bytes };
}
