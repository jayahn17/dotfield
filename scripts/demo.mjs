#!/usr/bin/env node
// npm run demo (V2_PLAN §6): render every templates/*.sketch.json with
// `render <template> .dotfield/demo/<name>.html --view all` through the real
// CLI dispatch (so each render runs every gate and leaves its receipt under
// .dotfield/receipts/ like a typed command), then write .dotfield/demo/
// index.html — one standalone page (tokens inlined, no external reference)
// linking every render with its gate summary — and print the paths. Writes
// only inside .dotfield/ (a self render there is never DF_RENDER_SELF_VIEW_
// EXPORTED); dotfield delete sweeps .dotfield/demo/ as derived output.
// Exit 0 when every template rendered, 1 otherwise.
//
//   node scripts/demo.mjs [--json]
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../bin/dotfield.mjs';
import { createContext } from '../lib/context.mjs';
import { summarize } from '../lib/rules.mjs';
import { escapeXml } from '../renderers/svg.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES_DIR = join(ROOT, 'templates');
export const TEMPLATE_RE = /^[a-z0-9][a-z0-9-]*\.sketch\.json$/;

/** templates/*.sketch.json file names, sorted. */
export function templateFiles(dir = TEMPLATES_DIR) {
  return readdirSync(dir).filter((f) => TEMPLATE_RE.test(f)).sort();
}

const PAGE_CSS = `body{margin:0;background:var(--df-bg);color:var(--df-ink);font-family:var(--df-font-text);font-size:var(--df-text-base);line-height:var(--df-leading)}
main{max-width:56rem;margin:0 auto;padding:var(--df-space-5) var(--df-space-4)}
h1{font-family:var(--df-font-display);font-size:var(--df-text-lg);margin:0 0 var(--df-space-2)}
p{color:var(--df-muted);margin:0 0 var(--df-space-4)}
table{width:100%;border-collapse:collapse;font-size:var(--df-text-sm)}
th,td{text-align:left;padding:var(--df-space-2) var(--df-space-3);border-bottom:1px solid var(--df-line)}
th{color:var(--df-faint);font-weight:600}
a{color:var(--df-accent)}
code{font-family:var(--df-font-mono);color:var(--df-muted)}
.df-bad{color:var(--df-bad);font-weight:600}`;

/** The index page: one row per template (title, type, gate summary, link to its HTML); standalone, tokens inlined. */
export function indexHtml(rows, { tokensCss = '', outDir }) {
  const body = rows.map((r) => {
    const link = r.html ? `<a href="${escapeXml(relative(outDir, r.html))}">${escapeXml(r.title)}</a>` : escapeXml(r.title);
    const gates = `${r.passed} pass / ${r.failed} fail${r.codes.length ? ` (${escapeXml(r.codes.join(', '))})` : ''}`;
    return `<tr><td>${link}</td><td>${escapeXml(r.type)}</td><td${r.exit === 0 ? '' : ' class="df-bad"'}>${escapeXml(r.status)} · exit ${r.exit}</td><td>${gates}</td><td><code>${escapeXml(r.template)}</code></td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dotfield templates</title>
<style data-df="tokens">${tokensCss}</style>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<h1>Dotfield templates</h1>
<p>Every sketch under templates/ rendered with --view all (2D, 3D, VR). The 3D and VR tabs load three.js from jsdelivr (pinned, with SRI) unless you run npm run vendor once and render with --embed-three.</p>
<table>
<thead><tr><th>Render</th><th>Type</th><th>Status</th><th>Gates</th><th>Template</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
</main>
</body>
</html>
`;
}

/**
 * runDemo({cwd, env, templatesDir}) -> {rows, index, outDir, ok}. Renders in
 * file order through dispatch(); nothing here reads a clock (receipts take
 * ctx.now, which SOURCE_DATE_EPOCH pins).
 */
export async function runDemo({ cwd = ROOT, env = process.env, templatesDir = TEMPLATES_DIR } = {}) {
  const ctx = createContext({ cwd, env });
  const outDir = join(ctx.dotDir, 'demo');
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const file of templateFiles(templatesDir)) {
    const name = file.replace(/\.sketch\.json$/, '');
    const src = join(templatesDir, file);
    let sketch = {};
    try { sketch = JSON.parse(readFileSync(src, 'utf8')); } catch { sketch = {}; }
    const html = join(outDir, `${name}.html`);
    const { receipt } = await dispatch(['render', src, html, '--view', 'all', '--json'], { cwd, env, stdin: null, stdout: null });
    const sum = summarize(receipt.checks);
    const written = receipt.outputs.some((o) => o.kind === 'html');
    rows.push({
      name, title: typeof sketch.title === 'string' ? sketch.title : name, type: typeof sketch.type === 'string' ? sketch.type : 'unknown',
      template: relative(ctx.root, src) || src, html: written ? html : null, exit: receipt.exit_code, status: receipt.status,
      passed: sum.passed, failed: sum.failed, codes: Object.keys(sum.by_code).sort(),
    });
  }
  const index = join(outDir, 'index.html');
  writeFileSync(index, indexHtml(rows, { tokensCss: ctx.tokens().css, outDir }), 'utf8');
  return { rows, index, outDir, root: ctx.root, ok: rows.length > 0 && rows.every((r) => r.exit === 0) };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const r = await runDemo();
  const rel = (p) => relative(r.root, p) || p;
  if (argv.includes('--json')) {
    stdout.write(`${JSON.stringify({ ok: r.ok, index: rel(r.index), renders: r.rows.map((x) => ({ ...x, html: x.html ? rel(x.html) : null })) }, null, 2)}\n`);
  } else {
    for (const x of r.rows) (x.exit === 0 ? stdout : stderr).write(`${x.name.padEnd(14)} ${x.type.padEnd(13)} exit ${x.exit}  ${x.passed} pass / ${x.failed} fail  ${x.html ? rel(x.html) : '(not written)'}\n`);
    stdout.write(`index          ${rel(r.index)}\n`);
  }
  return r.ok ? 0 : 1;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`demo: ${e && e.stack ? e.stack : String(e)}\n`); process.exitCode = 1; });
