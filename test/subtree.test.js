// The release surface: scripts/subtree-check.mjs (git ls-files + the import
// and path scan reference nothing outside dotfield/, here and in a temp repo
// with planted escapes), the CI workflow's gates and order, the two-center
// demo script's shape, scripts/evidence.mjs (a screenshot attaches to a real
// render receipt that still verifies; the adb path against a stub adb; the
// refusals) and the Quest recipe. Temp dirs, zero network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { ROOT, runCli } from './helpers/cli.mjs';
import { EPOCH_ENV } from './helpers/center.mjs';
import { checkSubtree, listTree, scanFindings } from '../scripts/subtree-check.mjs';
import { EXIT, attachEvidence, captureAdb, isPng, main as evidenceMain, parseArgs as evidenceArgs } from '../scripts/evidence.mjs';
import { verifyReceipt } from '../lib/receipt.mjs';
import { RULES } from '../lib/rules.mjs';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Subtree', GIT_AUTHOR_EMAIL: 'subtree@localhost', GIT_COMMITTER_NAME: 'Subtree', GIT_COMMITTER_EMAIL: 'subtree@localhost' };
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const codesOf = (f) => f.map((x) => x.code);
const put = (dir, rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
/** Two levels up, spelled without a literal dot-dot-slash so this file itself passes the path scans. */
const UP2 = ['..', '..'].join('/');
/** Stub source lines assembled so the scanners (this one and no-son-imports) do not read this test file as the importer. */
const IMPORT = ['imp', 'ort'].join('');
const imp = (what, spec) => `${IMPORT} ${what} from '${spec}';\n`;
const dyn = (spec) => `await ${IMPORT}('${spec}')`;

test('this tree references nothing outside dotfield/: node scripts/subtree-check.mjs exits 0', () => {
  const report = checkSubtree({ root: ROOT });
  assert.ok(report.ok, JSON.stringify(report.findings, null, 2));
  assert.deepEqual(report.findings.filter((f) => f.level === 'fail'), []);
  assert.ok(report.counts.files > 100 && report.counts.code > 50, JSON.stringify(report.counts));
  const files = listTree(ROOT);
  assert.ok(files.includes('bin/dotfield.mjs') && files.includes('VISION.md'));
  assert.ok(!files.some((f) => f.startsWith('node_modules/') || f.startsWith('vendor/three/') || f.startsWith('.dotfield/') || f.startsWith('data/')));
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'subtree-check.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout);
  const json = JSON.parse(run.stdout);
  assert.equal(json.ok, true);
  assert.ok(['tracked', 'untracked', 'unavailable'].includes(json.git.status));
  const human = spawnSync(process.execPath, [join(ROOT, 'scripts', 'subtree-check.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /subtree-check: ok/);
});

test('in a committed repo: an escaping import, a bare package, a ../ path, an untracked file and an outside symlink are findings; a clean tree passes', { skip: hasGit ? false : 'git is not installed' }, async () => {
  await withTmp(async (dir) => {
    const repo = join(dir, 'parent', 'dotfield');
    mkdirSync(repo, { recursive: true });
    put(repo, 'package.json', '{"name":"mini","type":"module","dependencies":{}}\n');
    put(repo, '.gitignore', 'data/\n.dotfield/\nignored.log\n');
    put(repo, 'lib/a.mjs', `${imp('{ readFileSync }', 'node:fs')}${imp('{ b }', './b.mjs')}export const a = b + readFileSync.length;\n`);
    put(repo, 'lib/b.mjs', 'export const b = 1;\n');
    put(repo, 'mcp/s.mjs', `export const sdk = ${dyn('@modelcontextprotocol/sdk/server/index.js')};\n`);
    put(repo, 'renderers/t.mjs', `${imp('* as THREE', 'three')}export { THREE };\n`);
    put(repo, 'scripts/run.sh', '#!/usr/bin/env bash\nnode bin/x.mjs\n');
    put(repo, 'docs/notes.md', 'See ../README.md inside the folder.\n');
    git(join(dir, 'parent'), 'init', '-q', '-b', 'main');
    git(join(dir, 'parent'), 'add', '-A');
    git(join(dir, 'parent'), 'commit', '-q', '-m', 'base');
    const clean = checkSubtree({ root: repo });
    assert.deepEqual(clean.findings, [], JSON.stringify(clean.findings));
    assert.equal(clean.git.status, 'tracked');
    assert.equal(clean.git.prefix, 'dotfield');
    assert.ok(clean.ok);

    put(repo, 'lib/esc.mjs', `${imp('{ x }', `${UP2}/server/thing.js`)}${imp('zod', 'zod')}${imp('{ y }', 'left-pad')}export const z = [x, zod, y];\n`);
    put(repo, 'scripts/bad.sh', `cd ${UP2}/son && npm test\n`);
    put(repo, 'docs/bad.md', `The old API lived in ${UP2}/api/packet.js.\n`);
    put(repo, 'ignored.log', 'never tracked, never a finding\n');
    writeFileSync(join(dir, 'parent', 'outside.txt'), 'outside\n');
    symlinkSync(`${UP2}/outside.txt`, join(repo, 'lib', 'link.txt'));
    git(join(dir, 'parent'), 'add', 'dotfield/lib/esc.mjs', 'dotfield/scripts/bad.sh', 'dotfield/docs/bad.md', 'dotfield/lib/link.txt');
    git(join(dir, 'parent'), 'commit', '-q', '-m', 'escapes');
    put(repo, 'lib/untracked.mjs', 'export const u = 1;\n');
    put(repo, 'center/center.config.json', '{}\n'); // what CI's init step leaves behind: the owner's, never a finding
    const dirty = checkSubtree({ root: repo });
    assert.equal(dirty.ok, false);
    const by = (code) => dirty.findings.filter((f) => f.code === code).map((f) => f.file).sort();
    assert.deepEqual(by('import-outside'), ['lib/esc.mjs']);
    assert.deepEqual(by('import-package'), ['lib/esc.mjs', 'lib/esc.mjs']);
    assert.deepEqual(by('path-outside'), ['docs/bad.md', 'lib/esc.mjs', 'scripts/bad.sh'], 'a quoted escaping import is also a path reference');
    assert.deepEqual(by('untracked'), ['lib/untracked.mjs'], 'an untracked center/ is not a finding');
    assert.deepEqual(by('symlink-outside'), ['lib/link.txt']);
    assert.equal(dirty.git.untracked, 1);
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'subtree-check.mjs'), '--root', repo], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL import-outside lib\/esc\.mjs: (\.\.\/){2}server\/thing\.js/);
    assert.match(run.stdout, /subtree-check: FAILED/);
    assert.deepEqual(codesOf(scanFindings(dir, ['missing-file.mjs'])), [], 'an unreadable path is skipped, not a crash');
    put(repo, 'lib/uses-test.mjs', "import test from 'node:test';\nexport default test;\n");
    assert.deepEqual(codesOf(scanFindings(repo, ['lib/uses-test.mjs'])), [], 'node:test is a builtin on every supported Node (builtinModules omits it on 22 and 23)');
  });
});

test('the CI workflow runs Node 22 and 24 through every gate of VISION §10, in order, and uploads the receipts', () => {
  const yml = read('.github/workflows/dotfield.yml');
  assert.match(yml, /node: \['22', '24'\]/);
  assert.match(yml, /actions\/upload-artifact@v4/);
  assert.match(yml, /if: always\(\)/);
  assert.match(yml, /echo "RECEIPTS=\$RUNNER_TEMP\/receipts" >> "\$GITHUB_ENV"/, 'receipts live outside the tree so the manifest never hashes them');
  const jobEnv = /\n    env:\n((?: {6}.*\n)+)/.exec(yml);
  assert.ok(jobEnv && !/\$\{\{\s*(runner|env|steps|job)\./.test(jobEnv[1]), 'a job-level env block may only read github, matrix, needs, strategy, vars, secrets or inputs (GitHub rejects the whole file otherwise)');
  const order = ['npm ci', 'scripts/fetch-vendor.mjs', 'npm test', 'doctor --json', 'init --pack starter --name Dotfield --json', 'pack-init-check.mjs --json', 'validate all --json', 'prove all --json', 'packs/draft/*/examples/scene-*.json', 'SOURCE_DATE_EPOCH', 'diff -r', 'node --check', 'npm run manifest', 'git diff --exit-code -- engine.manifest.json skill-release.json', 'scripts/subtree-check.mjs', 'scripts/demo-two-centers.sh'];
  let at = -1;
  for (const needle of order) { const i = yml.indexOf(needle, at + 1); assert.ok(i > at, `${needle} missing or out of order`); at = i; }
  assert.ok(yml.indexOf('doctor --json') < yml.indexOf('init --pack starter'), 'doctor runs before any key exists');
  assert.ok(!/init --pack starter[^\n]*--force/.test(yml), 'a fresh clone has no center/, so CI never needs --force (and never overwrites a fork\'s center)');
  assert.match(yml, /DOTFIELD_TEMPLATE_REPO: \$\{\{ github\.repository == 'jayahn17\/dotfield'/, 'only the template refuses a tracked center/');
  assert.ok(!/\.\.\//.test(yml), 'no path leaves the folder');
  assert.match(yml, /permissions:\n  contents: read/);
});

test('demo-two-centers.sh: parses, fails closed, names the owner token file explicitly, runs the CLI per center, no network', () => {
  const sh = read('scripts/demo-two-centers.sh');
  const parse = spawnSync('bash', ['-n', join(ROOT, 'scripts', 'demo-two-centers.sh')], { encoding: 'utf8' });
  assert.equal(parse.status, 0, parse.stderr);
  assert.match(sh, /^set -euo pipefail$/m);
  assert.match(sh, /DOTFIELD_OWNER_TOKEN_FILE="\$OWNER_TOKEN_FILE" node "\$BIN"/);
  assert.match(sh, /mktemp -d/);
  assert.match(sh, /trap cleanup EXIT/);
  assert.match(sh, /\(cd "\$dir" && node "\$BIN" "\$@" --json\)/, 'every step runs bin/dotfield.mjs with the cwd set to the center');
  assert.ok(!/curl|wget|fetch\(|https?:\/\//.test(sh), 'no network');
  for (const code of [...sh.matchAll(/DF_[A-Z_]+/g)].map((m) => m[0])) assert.ok(RULES[code], `${code} is not in the catalog`);
  for (const step of ['import-unknown-key', 'import-wrong-receiver', 'approve-rule-alpha', 'share-project-alpha', 'import-projection-beta', 'render-meet-for-alpha', 'run-with-alpha', 'project-after-revoke']) assert.ok(sh.includes(step), step);
  assert.match(sh, /step 3 run-with-alpha/, 'the dry run ends awaiting_owner (exit 3)');
  assert.match(sh, /--provider dry/);
});

test('evidence.mjs: a screenshot attaches to a real render receipt that still verifies; the adb path runs against a stub adb; refusals exit 2', async () => {
  await withTmp(async (dir) => {
    const render = runCli(['render', join(ROOT, 'examples', 'scene-graph.json'), '--view', '2d', '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(render.code, 0, render.stdout);
    const folder = join(dir, render.json.outputs[0].ref, '..');
    const index = join(dir, '.dotfield', 'receipts', `${render.json.receipt_id}.json`);
    assert.ok(existsSync(join(folder, 'receipt.json')) && existsSync(index));
    assert.equal(render.json.evidence.browser, 'not_captured');

    const shot = join(dir, 'shot.png');
    writeFileSync(shot, PNG);
    const args = evidenceArgs([folder, '--screenshot', shot, '--json']);
    assert.deepEqual(args.errors, []); assert.equal(args.device, 'browser');
    const attached = attachEvidence({ folder, receiptPath: join(folder, 'receipt.json'), png: shot, device: 'browser' });
    assert.ok(attached.ok, attached.why);
    const receipt = JSON.parse(readFileSync(join(folder, 'receipt.json'), 'utf8'));
    assert.deepEqual(receipt.evidence, { browser: 'captured', screenshot_ref: `${render.json.outputs[0].ref.replace(/\/out\.html$/, '')}/evidence-browser.png`, device: 'browser' });
    assert.equal(receipt.receipt_id, render.json.receipt_id, 'the id depends on inputs, command, argv and clock only');
    assert.equal(receipt.outputs.at(-1).kind, 'screenshot');
    assert.match(receipt.next_action, /no longer provisional/);
    assert.deepEqual(JSON.parse(readFileSync(index, 'utf8')).evidence, receipt.evidence, 'the index copy is updated too');
    const verified = verifyReceipt(join(folder, 'receipt.json'), { root: dir });
    assert.deepEqual(verified.checks.filter((c) => c.status === 'fail' && c.blocking), [], 'the rewritten receipt verifies');
    assert.ok(verified.checks.some((c) => c.code === 'DF_RECEIPT_DIGEST_MISMATCH' && c.status === 'pass'));

    // The adb path against a stub: reverse, identify, open, screencap.
    const log = join(dir, 'adb.log');
    const png = join(dir, 'cap.png');
    writeFileSync(png, PNG);
    const adb = join(dir, 'fake-adb');
    writeFileSync(adb, `#!/bin/sh\nif [ "$1" = "-s" ]; then shift 2; fi\necho "$*" >> "${log}"\ncase "$1" in\n  version) echo "Android Debug Bridge version 1.0.41 (stub)";;\n  reverse) exit 0;;\n  get-serialno) echo "STUB0001";;\n  shell) case "$2" in getprop) echo "Quest 3";; am) exit 0;; *) exit 1;; esac;;\n  exec-out) cat "${png}";;\n  *) exit 1;;\nesac\n`);
    chmodSync(adb, 0o755);
    const cap = await captureAdb({ adb, serial: 'STUB0001', port: 4321, url: 'http://127.0.0.1:4321/renders/x/out.html#view=vr', wait: 0 });
    assert.ok(cap.ok, cap.why);
    assert.equal(cap.device, 'adb:Quest 3');
    assert.ok(isPng(cap.png));
    assert.match(readFileSync(log, 'utf8'), /^reverse tcp:4321 tcp:4321$/m);
    assert.match(readFileSync(log, 'utf8'), /^shell am start -a android\.intent\.action\.VIEW -d http:\/\/127\.0\.0\.1:4321\/renders\/x\/out\.html#view=vr$/m);
    let out = '';
    const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
    const code = await evidenceMain([folder, '--device', 'adb', '--adb', adb, '--port', '4321', '--open', '--json'], io);
    assert.equal(code, EXIT.ok, out);
    const result = JSON.parse(out);
    assert.equal(result.evidence.device, 'adb:Quest 3');
    assert.ok(existsSync(join(folder, 'evidence-adb-quest-3.png')));
    assert.ok(result.steps.some((s) => s.startsWith('open http://127.0.0.1:4321/renders/')));
    assert.ok(JSON.parse(readFileSync(join(folder, 'receipt.json'), 'utf8')).outputs.filter((o) => o.kind === 'screenshot').length === 2);

    // Refusals: no adb, a non-render receipt, a capture that is not a PNG, bad flags.
    out = '';
    assert.equal(await evidenceMain([folder, '--device', 'adb', '--adb', join(dir, 'no-such-adb'), '--json'], io), EXIT.refused);
    assert.match(JSON.parse(out).message, /adb not runnable/);
    const validate = runCli(['validate', join(ROOT, 'examples', 'scene-graph.json'), '--json'], { cwd: dir, env: EPOCH_ENV });
    assert.equal(validate.code, 0);
    writeFileSync(join(dir, 'other.json'), JSON.stringify(validate.json));
    out = '';
    assert.equal(await evidenceMain([join(dir, 'other.json'), '--screenshot', shot, '--json'], io), EXIT.refused);
    assert.match(JSON.parse(out).message, /not render/);
    writeFileSync(join(dir, 'text.png'), 'not a png');
    assert.equal(attachEvidence({ folder, receiptPath: join(folder, 'receipt.json'), png: join(dir, 'text.png'), device: 'browser' }).ok, false);
    assert.ok(evidenceArgs([]).errors.length >= 2);
    assert.ok(evidenceArgs([folder, '--device', 'tv']).errors.some((e) => /not browser\|adb/.test(e)));
    assert.ok(evidenceArgs([folder, '--device', 'adb', '--wait', 'soon']).errors.some((e) => /whole number/.test(e)));
  });
});

test('recipes/vr-on-quest.md documents adb reverse, the 127.0.0.1 secure context, the evidence step and the honest overlay states', () => {
  const md = read('recipes/vr-on-quest.md');
  for (const needle of ['adb reverse tcp:4100 tcp:4100', '127.0.0.1', 'scripts/evidence.mjs', '--device adb', '--screenshot', 'evidence.browser', 'provisional', 'insecure', 'unsupported', 'blocked', 'fetch-vendor.mjs', '#view=vr']) assert.ok(md.includes(needle), needle);
  assert.ok(!/\.\.\//.test(md));
});
