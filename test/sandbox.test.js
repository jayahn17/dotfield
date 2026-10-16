// lib/sandbox.mjs: customer modules run only in a permission-restricted child.
// Each test scaffolds a tiny center in a temp dir (center/rooms/demo/ holding
// the fixtures, data/demo.json as the store, .dotfield/tmp/ as the one
// writable directory) and asserts the typed DF_SANDBOX_* checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTmp } from './helpers/tmp.mjs';
import {
  runModule, runTest, permissionSupport, resetPermissionCache, permissionArgs, parseTapSummary, childEnv,
  MODULE_CODES, TEST_CODES, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, RUNNER_SOURCE,
} from '../lib/sandbox.mjs';
import { RULES } from '../lib/rules.mjs';
import { buildReceipt } from '../lib/receipt.mjs';
import { fromReceipt, GATE, STORAGE } from '../lib/exit-codes.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox');
const STORE_BODY = '[{"id":"r1","n":1},{"id":"r2","n":2}]\n';
const RECORDS = JSON.parse(STORE_BODY);

function scaffold(dir) {
  const room = join(dir, 'center', 'rooms', 'demo');
  cpSync(FIXTURES, room, { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'demo.json'), STORE_BODY);
  return { root: dir, room, store: join(dir, 'data', 'demo.json'), tmp: join(dir, '.dotfield', 'tmp') };
}

const failed = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.code);
const passed = (r) => r.checks.filter((c) => c.status === 'pass').map((c) => c.code);
const storeUntouched = (c) => assert.equal(readFileSync(c.store, 'utf8'), STORE_BODY, 'the store must be untouched');

test('every check code the sandbox emits is in the catalog and blocking', () => {
  for (const code of MODULE_CODES) {
    assert.ok(RULES[code], code);
    assert.equal(RULES[code].gate, 'sandbox');
    assert.equal(RULES[code].blocking, true);
  }
  assert.ok(TEST_CODES.every((c) => MODULE_CODES.includes(c)));
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024 * 1024);
  assert.doesNotMatch(RUNNER_SOURCE, /allow-child-process/);
});

test('this Node supports --permission (probed once, then cached)', () => {
  resetPermissionCache();
  const first = permissionSupport();
  assert.equal(first.supported, true, first.detail);
  assert.equal(first.cached, false);
  const second = permissionSupport();
  assert.equal(second.cached, true);
  assert.equal(second.node, process.execPath);
});

test('a node without --permission is refused before anything is spawned (fail closed)', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const fake = join(dir, 'fake-node');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--permission" ]; then echo "bad option: --permission" >&2; exit 9; fi\necho "{\\"ok\\":true,\\"output\\":\\"escaped\\"}"\n');
    chmodSync(fake, 0o755);
    resetPermissionCache();
    const r = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName: 'tag', args: [RECORDS, { tag: 'x' }], allowRead: c.root, nodePath: fake });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED']);
    assert.equal(r.output, null);
    assert.equal(r.exit_code, null, 'the module was never run');
    assert.match(r.checks[0].message, /bad option/);
    assert.match(r.checks[0].repair, /22\.13/);
    const t = await runTest({ dir: c.room, file: 'test-pass.mjs', nodePath: fake });
    assert.deepEqual(failed(t), ['DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED']);
    assert.equal(t.passed, 0);
    resetPermissionCache();
  });
});

test('a missing node binary is DF_SANDBOX_SPAWN_FAILED (storage exit 4 in a receipt)', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    resetPermissionCache();
    const r = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName: 'tag', input: RECORDS, allowRead: c.root, nodePath: join(dir, 'no-such-node') });
    assert.deepEqual(failed(r), ['DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED']);
    resetPermissionCache();
    const receipt = buildReceipt({ command: 'prove', now: 0, checks: r.checks });
    assert.equal(receipt.status, 'blocked');
    assert.equal(fromReceipt(receipt), GATE);
    assert.equal(RULES.DF_SANDBOX_SPAWN_FAILED.exit, STORAGE);
  });
});

test('permission argv realpaths every path, repeats the flag per path, creates write dirs, never allows child processes', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const argv = permissionArgs({ allowRead: [c.root], allowWrite: c.tmp });
    assert.equal(argv[0], '--permission');
    const reads = argv.filter((a) => a.startsWith('--allow-fs-read='));
    const writes = argv.filter((a) => a.startsWith('--allow-fs-write='));
    assert.equal(argv.length, 1 + reads.length + writes.length);
    assert.ok(reads.includes(`--allow-fs-read=${realpathSync(c.root)}`), 'the realpath is always allowed');
    assert.ok(reads.includes(`--allow-fs-read=${c.root}`), 'the spelling the caller used is allowed too');
    assert.ok(writes.includes(`--allow-fs-write=${realpathSync(c.tmp)}`));
    assert.ok(existsSync(c.tmp), 'the write directory is created');
    assert.ok(!argv.some((a) => a.includes(',')), 'one flag per path, never comma-joined');
    assert.ok(!argv.some((a) => /child-process/.test(a)));
    assert.deepEqual(permissionArgs({ allowRead: [c.root, c.root] }), permissionArgs({ allowRead: c.root }), 'deduplicated');
    const two = permissionArgs({ allowRead: [c.root, c.room] });
    assert.ok(two.filter((a) => a.startsWith('--allow-fs-read=')).length >= 2);
  });
});

test('a module that returns records passes them back as output, with every check passing', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName: 'tag', args: [RECORDS, { tag: 'reviewed' }], allowRead: c.root, allowWrite: c.tmp });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(r.output, [{ id: 'r1', n: 1, tag: 'reviewed' }, { id: 'r2', n: 2, tag: 'reviewed' }]);
    assert.deepEqual(passed(r), [...MODULE_CODES]);
    assert.equal(r.exit_code, 0);
    assert.equal(r.argv[0], '--permission');
    assert.ok(r.argv.includes('--input-type=module'));
    storeUntouched(c);
    const d = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName: 'double', input: RECORDS, allowRead: c.root });
    assert.equal(d.ok, true);
    assert.deepEqual(d.output, [{ id: 'r1', n: 2 }, { id: 'r2', n: 4 }]);
    const n = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName: 'nothing' });
    assert.equal(n.ok, true, 'allowRead defaults to the module directory');
    assert.equal(n.output, null);
  });
});

test('an actions module that writes data/ fails with DF_SANDBOX_WRITE_DENIED and the store is untouched', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runModule({ file: join(c.room, 'actions-writes-data.mjs'), exportName: 'leak', input: RECORDS, allowRead: c.root, allowWrite: c.tmp });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['DF_SANDBOX_WRITE_DENIED']);
    const check = r.checks.find((x) => x.code === 'DF_SANDBOX_WRITE_DENIED');
    assert.ok(check.path.endsWith(join('data', 'demo.json')), check.path);
    assert.match(check.repair, /cannot reach a store/);
    assert.equal(r.output, null);
    storeUntouched(c);
  });
});

test('a write under .dotfield/tmp/ is allowed', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runModule({ file: join(c.room, 'actions-writes-tmp.mjs'), exportName: 'scratch', input: RECORDS, allowRead: c.root, allowWrite: c.tmp });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.equal(r.output, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(c.tmp, 'scratch.json'), 'utf8')), RECORDS);
    storeUntouched(c);
  });
});

test('a read outside the allowed roots fails with DF_SANDBOX_READ_DENIED', async () => {
  await withTmp(async (dir) => {
    await withTmp(async (outside) => {
      const c = scaffold(dir);
      const secret = join(outside, 'owner.token');
      writeFileSync(secret, 'never-leaves');
      const r = await runModule({ file: join(c.room, 'actions-reads-outside.mjs'), exportName: 'peek', args: [RECORDS, { path: secret }], allowRead: c.root });
      assert.deepEqual(failed(r), ['DF_SANDBOX_READ_DENIED']);
      assert.equal(r.output, null);
      assert.ok(!r.stderr.includes('never-leaves') && !JSON.stringify(r.checks).includes('never-leaves'));
      const inside = await runModule({ file: join(c.room, 'actions-reads-outside.mjs'), exportName: 'peek', args: [RECORDS, { path: c.store }], allowRead: c.root });
      assert.equal(inside.ok, true, 'the store is readable inside the root; writing it is what the sandbox refuses');
      assert.equal(inside.output, STORE_BODY);
    });
  });
});

test('a module that never settles is killed with DF_SANDBOX_TIMEOUT', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runModule({ file: join(c.room, 'actions-hang.mjs'), exportName: 'hang', input: RECORDS, allowRead: c.root, timeoutMs: 1500 });
    assert.deepEqual(failed(r), ['DF_SANDBOX_TIMEOUT']);
    assert.match(r.checks.at(-1).message, /1500 ms/);
    assert.equal(r.signal, 'SIGKILL');
    assert.equal(r.output, null);
  });
});

test('stdout that is not one JSON document is DF_SANDBOX_OUTPUT_INVALID', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const noisy = await runModule({ file: join(c.room, 'actions-noisy.mjs'), exportName: 'chatty', input: RECORDS, allowRead: c.root });
    assert.deepEqual(failed(noisy), ['DF_SANDBOX_OUTPUT_INVALID']);
    assert.match(noisy.checks.at(-1).message, /progress: working/);
    assert.equal(noisy.output, null);
    const quiet = await runModule({ file: join(c.room, 'actions-throws.mjs'), exportName: 'quiet', input: RECORDS, allowRead: c.root });
    assert.deepEqual(failed(quiet), ['DF_SANDBOX_OUTPUT_INVALID']);
    assert.match(quiet.checks.at(-1).message, /empty/);
    const big = await runModule({ file: join(c.room, 'actions-big.mjs'), exportName: 'flood', args: [[], { bytes: 50_000 }], allowRead: c.root, maxOutputBytes: 4096 });
    assert.deepEqual(failed(big), ['DF_SANDBOX_OUTPUT_INVALID']);
    assert.match(big.checks.at(-1).message, /exceeded 4096 bytes/);
    assert.equal(big.output, null);
  });
});

test('a missing export is DF_SANDBOX_EXPORT_MISSING, including a non-function export', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    for (const exportName of ['nope', 'notAFunction']) {
      const r = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName, input: RECORDS, allowRead: c.root });
      assert.deepEqual(failed(r), ['DF_SANDBOX_EXPORT_MISSING'], exportName);
      assert.match(r.checks.at(-1).message, new RegExp(`no export named ${exportName}`));
      assert.match(r.checks.at(-1).repair, /export const <name>/);
    }
  });
});

test('a throw, a non-zero exit and a forbidden child process are DF_SANDBOX_EXIT_NONZERO', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const thrown = await runModule({ file: join(c.room, 'actions-throws.mjs'), exportName: 'explode', input: RECORDS, allowRead: c.root });
    assert.deepEqual(failed(thrown), ['DF_SANDBOX_EXIT_NONZERO']);
    assert.match(thrown.checks.at(-1).message, /boom from the module/);
    const exited = await runModule({ file: join(c.room, 'actions-throws.mjs'), exportName: 'exits', input: RECORDS, allowRead: c.root });
    assert.deepEqual(failed(exited), ['DF_SANDBOX_EXIT_NONZERO']);
    assert.equal(exited.exit_code, 7);
    const shell = await runModule({ file: join(c.room, 'actions-spawns.mjs'), exportName: 'shell', input: RECORDS, allowRead: c.root });
    assert.deepEqual(failed(shell), ['DF_SANDBOX_EXIT_NONZERO']);
    assert.match(shell.checks.at(-1).message, /ChildProcess denied/);
    assert.equal(shell.output, null, 'the shell never ran');
  });
});

test('the child environment is scrubbed: no parent secrets, no NODE_OPTIONS, TZ pinned', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    process.env.DOTFIELD_TEST_SECRET = 'do-not-forward';
    try {
      const r = await runModule({ file: join(c.room, 'actions-env.mjs'), exportName: 'env', allowRead: c.root, env: { DOTFIELD_EXTRA: '1' } });
      assert.equal(r.ok, true, JSON.stringify(r.checks));
      assert.ok(!r.output.keys.includes('DOTFIELD_TEST_SECRET'));
      assert.ok(!r.output.keys.includes('NODE_OPTIONS'));
      assert.ok(r.output.keys.includes('DOTFIELD_EXTRA'));
      assert.equal(r.output.tz, 'UTC');
      assert.equal(r.output.sandbox, '1');
    } finally {
      delete process.env.DOTFIELD_TEST_SECRET;
    }
    const env = childEnv();
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.TZ, 'UTC');
  });
});

test('runModule validates its own arguments and refuses a bad allow path without spawning', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    await assert.rejects(() => runModule({ exportName: 'tag' }), TypeError);
    await assert.rejects(() => runModule({ file: join(c.room, 'actions-ok.mjs') }), TypeError);
    const r = await runModule({ file: join(c.room, 'actions-ok.mjs'), exportName: 'tag', input: RECORDS, allowRead: join(dir, 'missing-dir') });
    assert.deepEqual(failed(r), ['DF_SANDBOX_SPAWN_FAILED']);
    assert.match(r.checks[0].message, /ENOENT/);
  });
});

test('runTest: a passing test.mjs passes with counts, by default name and by explicit file', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    cpSync(join(c.room, 'test-pass.mjs'), join(c.room, 'test.mjs'));
    const r = await runTest({ dir: c.room, allowRead: c.root, allowWrite: c.tmp });
    assert.equal(r.ok, true, r.stdout + r.stderr);
    assert.equal(r.passed, 2);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.summary, { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    assert.deepEqual(passed(r), [...TEST_CODES]);
    assert.ok(r.argv.includes('--test-reporter=tap'));
    assert.ok(!r.argv.includes('--test'), 'the --test runner needs child processes; the file runs directly');
    const explicit = await runTest({ dir: c.room, file: 'test-pass.mjs' });
    assert.equal(explicit.ok, true, 'allowRead defaults to dir');
    assert.equal(explicit.exit_code, 0);
  });
});

test('runTest: a failing test.mjs reports DF_SANDBOX_EXIT_NONZERO with the failure count', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runTest({ dir: c.room, file: 'test-fail.mjs', allowRead: c.root });
    assert.equal(r.ok, false);
    assert.equal(r.passed, 1);
    assert.equal(r.failed, 1);
    assert.deepEqual(failed(r), ['DF_SANDBOX_EXIT_NONZERO']);
    assert.match(r.checks.at(-1).message, /1 of 2 test\(s\) failed/);
    assert.match(r.stdout, /not ok 2 - fails on purpose/);
  });
});

test('runTest: a test that writes data/ fails with DF_SANDBOX_WRITE_DENIED and the store is untouched', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runTest({ dir: c.room, file: 'test-writes-data.mjs', allowRead: c.root, allowWrite: c.tmp });
    assert.equal(r.ok, false);
    assert.ok(failed(r).includes('DF_SANDBOX_WRITE_DENIED'), failed(r).join());
    assert.ok(failed(r).includes('DF_SANDBOX_EXIT_NONZERO'));
    const check = r.checks.find((x) => x.code === 'DF_SANDBOX_WRITE_DENIED');
    assert.match(check.path, /test-writes-data\.mjs:\d+:\d+$/, 'the TAP report names the failing test, not the resource');
    assert.match(check.message, /wrote outside/);
    storeUntouched(c);
  });
});

test('runTest: a hanging test is DF_SANDBOX_TIMEOUT; a missing file is DF_SANDBOX_EXIT_NONZERO', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const hang = await runTest({ dir: c.room, file: 'test-hang.mjs', allowRead: c.root, timeoutMs: 1500 });
    assert.deepEqual(failed(hang), ['DF_SANDBOX_TIMEOUT']);
    assert.equal(hang.signal, 'SIGKILL');
    const missing = await runTest({ dir: c.room, file: 'absent.mjs', allowRead: c.root });
    assert.deepEqual(failed(missing), ['DF_SANDBOX_EXIT_NONZERO']);
    assert.equal(missing.summary.tests, 0);
    await assert.rejects(() => runTest({}), TypeError);
  });
});

test('parseTapSummary reads the node:test footer and tolerates garbage', () => {
  assert.deepEqual(parseTapSummary('TAP version 13\n# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n'),
    { tests: 3, pass: 2, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  assert.deepEqual(parseTapSummary(''), { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.deepEqual(parseTapSummary('# pass notanumber\n# tests 4'), { tests: 4, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
});

test('a sandbox failure builds a blocked receipt with gate exit 2', async () => {
  await withTmp(async (dir) => {
    const c = scaffold(dir);
    const r = await runModule({ file: join(c.room, 'actions-writes-data.mjs'), exportName: 'leak', input: RECORDS, allowRead: c.root });
    const receipt = buildReceipt({ command: 'import', argv: ['records', 'demo'], now: 0, checks: r.checks });
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.exit_code, GATE);
    assert.equal(receipt.ok, false);
    assert.ok(receipt.checks.some((x) => x.code === 'DF_SANDBOX_WRITE_DENIED' && x.status === 'fail'));
  });
});
