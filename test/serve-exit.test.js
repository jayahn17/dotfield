// `dotfield serve` must never report a server that failed to start as ok.
// Found live on 2026-10-06: a second `serve` on an occupied port printed
// "read (exit 0, ok)" after the child died with EADDRINUSE. Now the child's
// non-zero exit is an `error` receipt carrying DF_SERVER_LISTEN_FAILED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { runCli } from './helpers/cli.mjs';
import { withTmp } from './helpers/tmp.mjs';
import { EPOCH_ENV, scaffoldCenter } from './helpers/center.mjs';

const occupy = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(() => r())) }));
});

test('serve on an occupied port is an error receipt (exit 1) with DF_SERVER_LISTEN_FAILED, never ok', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const held = await occupy();
    try {
      const r = runCli(['serve', '--port', String(held.port), '--json'], { cwd: c.root, env: EPOCH_ENV });
      assert.equal(r.code, 1, r.stdout || r.stderr);
      assert.equal(r.json.status, 'error');
      assert.equal(r.json.ok, false);
      const fail = r.json.checks.find((k) => k.code === 'DF_SERVER_LISTEN_FAILED');
      assert.ok(fail, 'the failing check is present');
      assert.equal(fail.status, 'fail');
      assert.equal(fail.blocking, true);
      assert.match(r.json.next_action, /did not start/);
      assert.ok(!r.stdout.includes('inbox: http'), 'no inbox URL (and no token) is printed off a TTY');
    } finally {
      await held.close();
    }
  });
});

test('serve --check stays a read receipt and prints no token', async () => {
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    const r = runCli(['serve', '--check', '--json'], { cwd: c.root, env: EPOCH_ENV });
    assert.equal(r.code, 0, r.stdout || r.stderr);
    assert.equal(r.json.status, 'read');
    assert.ok(!r.stdout.includes('?t='), 'the owner token never reaches stdout');
  });
});
