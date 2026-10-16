// test/theme.test.js — lib/theme.mjs buildTokens / resolveToken / validateBrand.
// node:test, zero network; font files are synthetic bytes written to a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTokens, resolveToken, validateBrand, buildLedger, injectLedger, parseThemes, parseColor, contrastRatio,
  nearestPassing, toHex, composite, BRAND_SELECTOR, SURFACE_TOKENS, TEXT_TOKENS, MIN_CONTRAST,
} from "../lib/theme.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseCss = readFileSync(join(ROOT, "renderers", "tokens.css"), "utf8");
const brand = () => ({
  schema_version: "dotfield.brand/1", name: "Hall Lab", accent: "#1c55b9", surface: "#f3f6fa", ink: "#162034",
  font: { display: "grotesk", text: "sans", mono: "mono" }, room_preset: "studio",
});
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "df-theme-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const codes = (r) => r.failures.map((f) => f.code);

test("colour math: WCAG reference values", () => {
  const white = parseColor("#ffffff"), black = parseColor("#000000");
  assert.equal(contrastRatio(white, black).toFixed(2), "21.00");
  assert.equal(contrastRatio(parseColor("#777777"), white).toFixed(2), "4.48");
  assert.equal(contrastRatio(parseColor("#767676"), white).toFixed(2), "4.54");
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0.5)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(composite(parseColor("rgba(0, 0, 0, 0.5)"), white), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  assert.equal(parseColor("#abc").r, 170);
  assert.equal(parseColor("12px"), null);
  const fixed = nearestPassing(parseColor("#9ec5ff"), white);
  assert.ok(contrastRatio(fixed, white) >= MIN_CONTRAST && contrastRatio(fixed, white) < MIN_CONTRAST + 0.05, "nearest passing stops just past 4.5");
  assert.equal(toHex(fixed).length, 7);
});

test("brand → tokens is deterministic, tints every theme-independent token and clears the ledger", () => {
  const a = buildTokens(brand(), baseCss), b = buildTokens(brand(), baseCss);
  assert.equal(a.ok, true, JSON.stringify(a.failures));
  assert.equal(a.css, b.css);
  assert.equal(a.ledger, b.ledger);
  assert.ok(a.css.includes(`${BRAND_SELECTOR} {`));
  assert.ok(a.css.startsWith(baseCss.replace(/\/\* @df-ledger:start[\s\S]*$/, "").trimEnd().slice(0, 200)), "base css is kept, brand block appended");
  const { order } = parseThemes(a.css);
  assert.equal(order[order.length - 1], "brand");
  assert.equal(resolveToken(a.css, "accent", "brand"), "#1c55b9");
  assert.equal(resolveToken(a.css, "bg", "brand"), "#f3f6fa");
  assert.equal(resolveToken(a.css, "ink", "brand"), "#162034");
  assert.equal(resolveToken(a.css, "ink-invert", "brand"), "#f3f6fa");
  assert.equal(resolveToken(a.css, "color-scheme", "brand"), null, "color-scheme is not a --df- token");
  assert.equal(parseThemes(a.css).themes.brand["color-scheme"], "light");
  assert.equal(resolveToken(a.css, "font-metrics-display", "brand"), "grotesk");
  assert.ok(resolveToken(a.css, "focus-ring", "brand").includes("#f3f6fa"), "var() chains resolve inside the brand theme");
  assert.equal(resolveToken(a.css, "accent", "paper"), resolveToken(baseCss, "accent", "paper"), "room themes keep their own palette");
  const ledger = buildLedger(a.css);
  assert.deepEqual(ledger.failures, []);
  assert.equal(ledger.pairs.filter((p) => p.theme === "brand").length, TEXT_TOKENS.length * SURFACE_TOKENS.length + 1);
  assert.ok(a.ledger.includes("── brand (light) ──"));
  assert.equal(injectLedger(a.css, ledger.text).css, a.css, "the ledger inside the generated css is byte-identical to a recomputation");
  for (let i = 1; i <= 6; i++) {
    const s = parseColor(resolveToken(a.css, `series-${i}`, "brand"));
    assert.ok(s && contrastRatio(s, parseColor("#f3f6fa")) >= 3, `series-${i} is a colour >= 3:1 on the brand surface`);
  }
  assert.equal(resolveToken(a.css, "series-1", "brand"), "#1c55b9", "series-1 is the accent");
  assert.deepEqual(a.fonts, []); assert.equal(a.bytes, 0);
});

test("a dark surface flips the scheme and seeds semantic colours from the preset", () => {
  const r = buildTokens({ ...brand(), surface: "#0b1410", ink: "#eef6f1", accent: "#5cd7a9", room_preset: "field" }, baseCss);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(parseThemes(r.css).themes.brand["color-scheme"], "dark");
  const bg = parseColor("#0b1410");
  for (const k of ["good", "warn", "bad", "info", "foreign", "muted", "faint", "accent-2"]) {
    const c = parseColor(resolveToken(r.css, k, "brand"));
    assert.ok(c, `${k} resolves`);
    for (const s of SURFACE_TOKENS) assert.ok(contrastRatio(c, composite(parseColor(resolveToken(r.css, s, "brand")), bg)) >= MIN_CONTRAST, `${k} on ${s}`);
  }
  assert.equal(resolveToken(r.css, "good", "brand"), resolveToken(baseCss, "good", "field"), "field's good already passes, so it is kept as-is");
});

test("a failing owner pair is refused with DF_THEME_CONTRAST and the nearest passing value, which then passes", () => {
  const weak = buildTokens({ ...brand(), accent: "#9ec5ff" }, baseCss);
  assert.equal(weak.ok, false); assert.equal(weak.css, null);
  const f = weak.failures.filter((x) => x.code === "DF_THEME_CONTRAST");
  assert.ok(f.length >= SURFACE_TOKENS.length, "every surface the accent fails on is listed");
  assert.ok(f.every((x) => x.path === "$.accent" && x.gate === "theme" && x.blocking && x.status === "fail"));
  assert.ok(f.every((x) => /^#[0-9a-f]{6}$/.test(x.suggestion) && x.repair.includes(x.suggestion)));
  assert.ok(f.some((x) => x.detail.surface === "bg" && x.detail.ratio < MIN_CONTRAST));
  const darkest = f.map((x) => x.suggestion).sort((p, q) => contrastRatio(parseColor(q), parseColor("#f3f6fa")) - contrastRatio(parseColor(p), parseColor("#f3f6fa")))[0];
  const fixed = buildTokens({ ...brand(), accent: darkest }, baseCss);
  assert.equal(fixed.ok, true, JSON.stringify(fixed.failures));
  assert.equal(resolveToken(fixed.css, "accent", "brand"), darkest);

  const ink = buildTokens({ ...brand(), ink: "#8a94a0" }, baseCss);
  assert.equal(ink.ok, false);
  assert.ok(ink.failures.some((x) => x.code === "DF_THEME_CONTRAST" && x.path === "$.ink" && x.message.includes("--df-ink on --df-")));
  assert.ok(ink.ledger.includes("── brand"), "the ledger is still reported so the owner sees the numbers");
});

test("an invalid brand is refused with schema codes and no css", () => {
  const missing = buildTokens({ name: "x" }, baseCss);
  assert.equal(missing.css, null);
  assert.ok(codes(missing).filter((c) => c === "DF_SCHEMA_REQUIRED").length === 5);
  assert.ok(missing.failures.every((f) => f.gate === "schema" && f.repair));
  const bad = validateBrand({ ...brand(), extra: 1, accent: "#fff", font: { display: "comic", text: "sans", mono: "mono" }, room_preset: "neon",
    files: [{ path: "../x.woff2", family: "", role: "body" }], logo: "/etc/logo.svg", radius: 99, density: "dense" });
  const by = Object.fromEntries(bad.map((f) => [f.path, f.code]));
  assert.equal(by["$.extra"], "DF_SCHEMA_UNKNOWN_FIELD");
  assert.equal(by["$.accent"], "DF_SCHEMA_PATTERN");
  assert.equal(by["$.font.display"], "DF_SCHEMA_ENUM");
  assert.equal(by["$.room_preset"], "DF_SCHEMA_ENUM");
  assert.equal(by["$.files[0].path"], "DF_SCHEMA_PATTERN");
  assert.equal(by["$.files[0].family"], "DF_SCHEMA_TYPE");
  assert.equal(by["$.files[0].role"], "DF_SCHEMA_ENUM");
  assert.equal(by["$.logo"], "DF_SCHEMA_PATTERN");
  assert.equal(by["$.radius"], "DF_SCHEMA_TYPE");
  assert.equal(by["$.density"], "DF_SCHEMA_ENUM");
  assert.deepEqual(validateBrand(brand()), []);
  assert.equal(validateBrand(null)[0].code, "DF_SCHEMA_TYPE");
  assert.equal(buildTokens(brand(), null).failures[0].code, "DF_THEME_BASE_MISSING");
  assert.equal(buildTokens(brand(), ":root { --df-bg: #fff; }").failures[0].path, "$.room_preset");
});

test("brand font files are inlined as data: URIs, counted in bytes and prepended to the role's stack", () => {
  withTmp((dir) => {
    mkdirSync(join(dir, "brand"));
    const bytes = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(1500, 7)]);
    writeFileSync(join(dir, "brand", "hall-display.woff2"), bytes);
    const fontFiles = Object.fromEntries(readdirSync(join(dir, "brand")).map((f) => [f, readFileSync(join(dir, "brand", f))]));
    const b = { ...brand(), files: [{ path: "hall-display.woff2", family: "Hall Display", role: "display", weight: 600 }] };
    const r = buildTokens(b, baseCss, { fontFiles });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(r.fonts.length, 1);
    assert.equal(r.fonts[0].bytes, bytes.length);
    const uri = `data:font/woff2;base64,${bytes.toString("base64")}`;
    assert.equal(r.fonts[0].data_uri_bytes, uri.length);
    assert.equal(r.bytes, uri.length);
    assert.ok(r.css.includes(`@font-face { font-family: "Hall Display"; font-weight: 600; font-style: normal; font-display: swap; src: url("${uri}") format("woff2"); }`));
    assert.ok(resolveToken(r.css, "font-display", "brand").startsWith('"Hall Display", "Space Grotesk"'));
    assert.equal(resolveToken(r.css, "font-text", "brand"), resolveToken(baseCss, "font-text"), "other roles untouched");
    assert.ok(!r.css.includes(dir), "no absolute path leaks into the css");
    const r2 = buildTokens(b, baseCss, { fontFiles });
    assert.equal(r2.css, r.css, "inlining is deterministic");

    const missing = buildTokens({ ...b, files: [{ path: "nope.woff2", family: "Nope", role: "text" }] }, baseCss, { fontFiles });
    assert.equal(missing.ok, false); assert.equal(missing.css, null);
    assert.ok(missing.failures.some((f) => f.code === "DF_THEME_FONT_FILE_MISSING" && f.path === "$.files[0].path"));
  });
});

test("radius and density derive their scales; omitted ones keep the preset's values", () => {
  const r = buildTokens({ ...brand(), radius: 12, density: "compact" }, baseCss);
  assert.equal(r.ok, true);
  assert.equal(resolveToken(r.css, "radius-sm", "brand"), "9px");
  assert.equal(resolveToken(r.css, "radius-md", "brand"), "12px");
  assert.equal(resolveToken(r.css, "radius-lg", "brand"), "21px");
  assert.equal(resolveToken(r.css, "radius-xl", "brand"), "33px");
  assert.equal(resolveToken(r.css, "space-0", "brand"), "0px");
  assert.equal(resolveToken(r.css, "space-4", "brand"), "14px");
  assert.equal(resolveToken(r.css, "space-7", "brand"), "41px");
  const d = buildTokens(brand(), baseCss);
  assert.equal(resolveToken(d.css, "radius-md", "brand"), resolveToken(baseCss, "radius-md"));
  assert.equal(resolveToken(d.css, "space-4", "brand"), "16px");
  assert.equal(resolveToken(d.css, "shadow-2", "brand"), resolveToken(baseCss, "shadow-2", "studio"), "preset-only tokens come from the preset");
});

test("a brand may tint the editorial and blueprint presets: preset tokens carry over, the brand's fonts and colours win, the ledger clears", () => {
  const ed = buildTokens({ ...brand(), surface: "#faf5ea", ink: "#211c18", accent: "#1f3a5f", room_preset: "editorial", font: { display: "serif", text: "serif", mono: "mono" } }, baseCss);
  assert.equal(ed.ok, true, JSON.stringify(ed.failures));
  assert.equal(resolveToken(ed.css, "label-size", "brand"), "13px", "editorial's label size rides into the brand block");
  assert.equal(resolveToken(ed.css, "space-4", "brand"), "20px", "editorial's generous spacing rides into the brand block");
  assert.equal(resolveToken(ed.css, "font-metrics-text", "brand"), "serif");
  const bp = buildTokens({ ...brand(), surface: "#0a2342", ink: "#eaf6ff", accent: "#66e0f5", room_preset: "blueprint", font: { display: "condensed", text: "mono", mono: "mono" } }, baseCss);
  assert.equal(bp.ok, true, JSON.stringify(bp.failures));
  assert.equal(parseThemes(bp.css).themes.brand["color-scheme"], "dark");
  assert.equal(resolveToken(bp.css, "font-metrics-text", "brand"), "mono");
  const grid = resolveToken(bp.css, "texture", "brand");
  assert.ok(grid.includes("linear-gradient(") && grid.includes(resolveToken(bp.css, "line-quiet", "brand")), "the grid texture follows the brand's own line colour");
  for (const r of [ed, bp]) assert.deepEqual(buildLedger(r.css).failures, []);
  const wrongFont = buildTokens({ ...brand(), room_preset: "blueprint" }, baseCss);
  assert.equal(resolveToken(wrongFont.css, "font-metrics-text", "brand"), "sans", "brand.font decides the fonts even over a preset");
});
