#!/usr/bin/env node
// scripts/contrast.mjs — compute the WCAG contrast ledger for every theme in a tokens file and
// write it between the @df-ledger markers.  --check compares instead of writing and exits 2 on
// drift, on any text/surface pair under 4.5:1, or when auto-light and light differ.
//
//   node scripts/contrast.mjs                 regenerate renderers/tokens.css
//   node scripts/contrast.mjs --check         CI gate (no write)
//   node scripts/contrast.mjs path.css [--check] [--json]
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { buildLedger, injectLedger, MIN_CONTRAST } from "../lib/theme.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILE = join(ROOT, "renderers", "tokens.css");
const EXIT_OK = 0, EXIT_GATE = 2;

export function runContrast({ file = DEFAULT_FILE, check = false, write = true } = {}) {
  let css;
  try { css = readFileSync(file, "utf8"); } catch (e) {
    return { ok: false, file, problems: [`cannot read ${file}: ${e.message}`], ledger: null, drift: false, failures: [], pairs: [] };
  }
  const ledger = buildLedger(css);
  const problems = [...ledger.errors];
  for (const p of ledger.failures) problems.push(`${p.theme}: --df-${p.text} on --df-${p.surface} is ${p.ratio.toFixed(2)}:1 (minimum ${MIN_CONTRAST.toFixed(2)}:1)`);
  if (!ledger.mirror.ok) problems.push(`auto-light differs from light: ${ledger.mirror.diffs.join(", ")}`);
  const { css: next, found } = injectLedger(css, ledger.text);
  if (!found) problems.push("ledger markers (@df-ledger:start / @df-ledger:end) are missing");
  const drift = found && next !== css;
  if (check) {
    if (drift) problems.push(`ledger is stale — run: node scripts/contrast.mjs ${relative(ROOT, file)}`);
  } else if (found && drift && write) {
    writeFileSync(file, next);
  }
  return { ok: problems.length === 0, file, problems, ledger: ledger.text, drift, failures: ledger.failures, pairs: ledger.pairs, wrote: !check && found && drift && write };
}

function main(argv) {
  const check = argv.includes("--check"), json = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_FILE;
  const r = runContrast({ file, check });
  if (json) {
    process.stdout.write(JSON.stringify({ ok: r.ok, file: relative(ROOT, r.file), check, wrote: !!r.wrote, drift: r.drift, pairs: r.pairs.length, failures: r.failures, problems: r.problems }, null, 2) + "\n");
  } else {
    process.stdout.write(`contrast: ${relative(ROOT, r.file)} — ${r.pairs.length} pairs, ${r.failures.length} under ${MIN_CONTRAST}:1${check ? (r.drift ? ", ledger STALE" : ", ledger current") : r.wrote ? ", ledger written" : ", ledger unchanged"}\n`);
    for (const p of r.problems) process.stdout.write(`  FAIL ${p}\n`);
  }
  return r.ok ? EXIT_OK : EXIT_GATE;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
