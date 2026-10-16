// test/tokens.test.js — renderers/tokens.css, renderers/font-metrics.json and scripts/contrast.mjs.
// node:test, zero network, temp dirs only for the tampered-copy cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseThemes, buildLedger, injectLedger, resolveToken, resolveColor, parseColor, contrastRatio,
  TEXT_TOKENS, SURFACE_TOKENS, ROOM_PRESETS, STACK_IDS, FONT_ROLES, FONT_METRICS, MIN_CONTRAST,
} from "../lib/theme.mjs";
import { runContrast } from "../scripts/contrast.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = join(ROOT, "renderers", "tokens.css");
const css = readFileSync(TOKENS, "utf8");
const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "brand.schema.json"), "utf8"));
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_-])/;
/** Every theme tokens.css declares, in file order (the auto-light mirror is not a theme). */
const THEMES = parseThemes(css).order.filter((t) => t !== "auto-light");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "df-tokens-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("no hex literal under renderers/ lib/ packs/ center/ except center/brand.json, packs/*/theme.json and *.generated.css", () => {
  const offenders = [];
  for (const dir of ["renderers", "lib", "packs", "center"]) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (rel === "renderers/tokens.css" || rel === "center/brand.json" || rel.endsWith(".generated.css")) continue;
      if (/^packs\/(?:draft\/)?[^/]+\/theme\.json$/.test(rel)) continue;
      if (!/\.(mjs|js|css|json|html|svg)$/.test(rel)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => { if (HEX.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`); });
    }
  }
  assert.deepEqual(offenders, []);
});

test("tokens.css declares the default, the auto-light mirror, the room themes and the two presets, in that order", () => {
  const { order, themes } = parseThemes(css);
  assert.deepEqual(order, ["default", "auto-light", "light", "paper", "studio", "field", "story", "editorial", "blueprint"]);
  assert.deepEqual(ROOM_PRESETS, THEMES, "lib/theme.mjs ROOM_PRESETS names every theme tokens.css declares, in order");
  for (const p of ROOM_PRESETS) assert.ok(themes[p], `preset ${p} has a block`);
  assert.deepEqual(themes["auto-light"], themes.light, "the prefers-color-scheme mirror equals [data-theme=light]");
  for (const t of ["light", "paper", "studio", "editorial"]) assert.equal(themes[t]["color-scheme"], "light");
  for (const t of ["default", "blueprint"]) assert.equal(themes[t]["color-scheme"], "dark");
});

test("every text and surface token resolves to a colour in every theme and every pair clears 4.5:1", () => {
  const parsed = parseThemes(css);
  for (const theme of THEMES) {
    for (const name of [...TEXT_TOKENS, ...SURFACE_TOKENS, "ink-invert", "accent-quiet", "line", "line-strong", "line-quiet"]) {
      assert.ok(resolveColor(parsed, theme, name), `${theme}: --df-${name} is a colour`);
    }
    for (let i = 1; i <= 6; i++) {
      const s = resolveColor(parsed, theme, `series-${i}`), bg = resolveColor(parsed, theme, "bg");
      assert.ok(s, `${theme}: series-${i}`);
      assert.ok(contrastRatio(s, bg) >= 3, `${theme}: series-${i} is >= 3:1 on bg (graphic contrast)`);
    }
  }
  const ledger = buildLedger(css);
  assert.deepEqual(ledger.errors, []);
  assert.deepEqual(ledger.failures, []);
  assert.equal(ledger.pairs.length, THEMES.length * (TEXT_TOKENS.length * SURFACE_TOKENS.length + 1));
  assert.ok(ledger.pairs.every((p) => p.ratio >= MIN_CONTRAST));
  assert.ok(ledger.mirror.ok);
});

test("the ledger in tokens.css is byte-identical to a fresh computation (contrast.mjs --check passes)", () => {
  const ledger = buildLedger(css);
  const { css: next, found } = injectLedger(css, ledger.text);
  assert.ok(found, "ledger markers present");
  assert.equal(next, css);
  for (const theme of THEMES) assert.ok(css.includes(`── ${theme} (`), `ledger lists ${theme}`);
  const r = runContrast({ file: TOKENS, check: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.drift, false);
});

test("contrast.mjs --check fails on a stale ledger, on a pair under 4.5:1 and on auto-light drift; without --check it rewrites", () => {
  withTmp((dir) => {
    const stale = join(dir, "stale.css");
    writeFileSync(stale, css.replace(/\/\* @df-ledger:start[\s\S]*?@df-ledger:end \*\//, "/* @df-ledger:start\n   @df-ledger:end */"));
    const r1 = runContrast({ file: stale, check: true });
    assert.equal(r1.ok, false); assert.equal(r1.drift, true);
    assert.ok(r1.problems.some((p) => p.includes("stale")));
    const r2 = runContrast({ file: stale });
    assert.equal(r2.ok, true); assert.equal(r2.wrote, true);
    assert.equal(readFileSync(stale, "utf8"), css, "regenerated copy equals the committed file");

    const faintDefault = parseThemes(css).themes.default["--df-faint"];
    const bgDefault = parseThemes(css).themes.default["--df-bg"];
    const weak = join(dir, "weak.css");
    const weakCss = css.replace(new RegExp(`--df-faint:\\s*${faintDefault};`), `--df-faint: ${bgDefault};`);
    assert.notEqual(weakCss, css, "the default --df-faint declaration was found and replaced");
    writeFileSync(weak, weakCss);
    const r3 = runContrast({ file: weak, check: true });
    assert.equal(r3.ok, false);
    assert.ok(r3.failures.some((f) => f.theme === "default" && f.text === "faint"));
    assert.ok(r3.problems.some((p) => /default: --df-faint on --df-bg is 1\.00:1/.test(p)));

    const drift = join(dir, "drift.css");
    const driftCss = css.replace(/(:root\[data-theme="light"\]\s*\{)/, "$1 --df-tap-min: 48px;");
    assert.notEqual(driftCss, css, "the [data-theme=light] block was found and tampered");
    writeFileSync(drift, driftCss);
    const r4 = runContrast({ file: drift, check: true });
    assert.equal(r4.ok, false);
    assert.ok(r4.problems.some((p) => p.includes("auto-light differs from light: --df-tap-min")));
  });
});

test("font tokens name a stack whose families match renderers/font-metrics.json in every theme", () => {
  const parsed = parseThemes(css);
  for (const theme of THEMES) {
    for (const role of FONT_ROLES) {
      const id = resolveToken(parsed, `font-metrics-${role}`, theme);
      assert.ok(STACK_IDS.includes(id), `${theme}: --df-font-metrics-${role} = ${id} is a stack id`);
      assert.equal(resolveToken(parsed, `font-${role}`, theme), FONT_METRICS.stacks[id].families, `${theme}: --df-font-${role} equals the stack's families`);
    }
  }
  assert.equal(resolveToken(css, "font-metrics-display", "paper"), "serif");
  assert.equal(resolveToken(css, "font-metrics-text", "editorial"), "serif");
  assert.equal(resolveToken(css, "font-metrics-text", "blueprint"), "mono");
});

test("font-metrics.json covers printable ASCII for every stack with sane em widths", () => {
  assert.equal(FONT_METRICS.schema_version, "dotfield.font-metrics/1");
  assert.equal(FONT_METRICS.unit, "em");
  for (const id of STACK_IDS) {
    const s = FONT_METRICS.stacks[id];
    assert.equal(s.id, id);
    assert.equal(Object.keys(s.chars).length, 95, `${id}: 95 ASCII characters`);
    for (let c = 32; c < 127; c++) {
      const w = s.chars[String.fromCharCode(c)];
      assert.ok(typeof w === "number" && w > 0 && w <= 1.2, `${id}: width of U+${c.toString(16)}`);
    }
    assert.ok(s.avg_em > 0.3 && s.avg_em <= 0.7, `${id}: avg_em ${s.avg_em}`);
    assert.equal(s.fallback_em, s.avg_em);
    assert.ok(typeof s.families === "string" && s.families.length > 0);
  }
  assert.equal(FONT_METRICS.stacks.mono.chars.i, FONT_METRICS.stacks.mono.chars.W, "mono is fixed-pitch");
  assert.ok(FONT_METRICS.stacks.sans.chars.i < FONT_METRICS.stacks.sans.chars.W, "sans is proportional");
  assert.ok(css.includes("renderers/font-metrics.json"), "tokens.css points at the metrics file");
});

test("brand.schema.json agrees with lib/theme.mjs constants and is closed", () => {
  assert.equal(schema.$id, "dotfield.brand/1");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["name", "accent", "surface", "ink", "font", "room_preset"]);
  assert.deepEqual(schema.properties.room_preset.enum, ROOM_PRESETS);
  assert.deepEqual(schema.properties.room_preset.enum, THEMES, "a brand may tint any theme tokens.css declares, editorial and blueprint included");
  for (const role of FONT_ROLES) assert.deepEqual(schema.properties.font.properties[role].enum, STACK_IDS);
  assert.deepEqual(schema.properties.font.required, FONT_ROLES);
  assert.equal(schema.properties.font.additionalProperties, false);
  assert.equal(schema.properties.files.items.additionalProperties, false);
  assert.ok(new RegExp(schema.properties.accent.pattern).test("#1a2B3c"));
  assert.ok(!new RegExp(schema.properties.accent.pattern).test("#fff"));
});

test("tokens.css carries the accessibility floor, the proposal dash, reduced motion and the focus ring", () => {
  assert.equal(resolveToken(css, "tap-min"), "44px");
  assert.equal(resolveToken(css, "proposal-dash"), "6 4");
  const ring = resolveToken(css, "focus-ring");
  assert.ok(!ring.includes("var("), "focus ring var() chain resolves");
  assert.ok(ring.includes(resolveToken(css, "bg")) && ring.includes(resolveToken(css, "accent")));
  assert.equal(resolveToken(css, "focus-ring", "studio").includes(resolveToken(css, "accent", "studio")), true);
  assert.ok(css.includes("prefers-reduced-motion: reduce"));
  assert.ok(css.includes(":focus-visible"));
  assert.ok(css.includes("--df-foreign"), "foreign nodes have their own token");
  assert.equal(resolveToken(css, "nope"), null);
  assert.deepEqual(parseColor(resolveToken(css, "ink-invert")), parseColor(resolveToken(css, "bg")), "ink on accent fills is the page background");
});

test("owned files stay under 400 lines and the library is clock-free, random-free and network-free", () => {
  const owned = ["renderers/tokens.css", "renderers/font-metrics.json", "lib/theme.mjs", "schemas/brand.schema.json",
    "scripts/contrast.mjs", "test/tokens.test.js", "test/theme.test.js", "test/themes-presets.test.js"];
  for (const rel of owned) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n").length;
    assert.ok(lines < 400, `${rel} has ${lines} lines`);
  }
  for (const rel of ["lib/theme.mjs", "scripts/contrast.mjs"]) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const bad of ["Date.now(", "Math.random(", "fetch(", "localStorage", "../../"]) assert.ok(!text.includes(bad), `${rel} has no ${bad}`);
  }
});
