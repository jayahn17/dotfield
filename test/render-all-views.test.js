// `--view all` means every view the scene enables (VISION §8.2). A scene that
// turns VR off (views.vr.enabled: false) must still render its 2D and 3D
// views under `all`, with the dropped view reported as a non-blocking
// DF_RENDER_VIEW_DISABLED; asking for that view explicitly still blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runCli } from './helpers/cli.mjs';
import { withTmp } from './helpers/tmp.mjs';

// The robotics-lab run history declares views.vr.enabled === false.
const SCENE = 'packs/robotics-lab/examples/scene-run-history.json';

test('--view all renders the enabled views and reports the disabled one as non-blocking', async () => {
  await withTmp(async (dir) => {
    const r = runCli(['render', SCENE, join(dir, 'out.html'), '--view', 'all', '--json']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.equal(r.json.status, 'written');
    assert.equal(r.json.ok, true);
    // The gate records one `pass` row per code it evaluated; the dropped view is the `fail` row.
    const disabled = r.json.checks.filter((c) => c.code === 'DF_RENDER_VIEW_DISABLED' && c.status === 'fail');
    assert.ok(disabled.length >= 1, 'the dropped VR view is reported');
    assert.ok(disabled.every((c) => c.blocking === false), 'reported, never blocking');
    assert.ok(disabled.some((c) => c.path === '$.views.vr'), 'the report names $.views.vr');
    assert.ok(r.json.outputs.some((o) => o.ref.endsWith('out.html')), 'the HTML was written');
  });
});

test('an explicit --view vr on a scene with VR disabled still blocks with exit 2', async () => {
  await withTmp(async (dir) => {
    const r = runCli(['render', SCENE, join(dir, 'out.html'), '--view', 'vr', '--json']);
    assert.equal(r.code, 2, r.stderr || r.stdout);
    assert.equal(r.json.status, 'blocked');
    assert.ok(r.json.checks.some((c) => c.code === 'DF_RENDER_VIEW_DISABLED' && c.blocking === true));
  });
});
