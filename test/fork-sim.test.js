// The upgrade path of VISION §9, rehearsed in a temp git repository: a copy
// of this tree becomes "upstream 0.1.0" (manifest regenerated so the base is
// self-consistent; no center/, the template ships packs only); a fork runs
// `init --pack robotics-lab`, customises the center it got (brand, a new room,
// an edited pack room, docs prose, the package name) and commits it; an
// upstream commit edits lib/, schemas/ and two files of that pack and
// regenerates the manifest; the merge is conflict-free with no merge driver
// configured, the fork's edits survive, `doctor` reports no
// DF_ENGINE_MODIFIED and no pending migration, `migrate` takes the pack file
// the fork never touched, keeps the one it edited (the shipped copy beside
// the backups, drift reported until `migrate --resolved`), and `validate
// all` passes. Plus: the shipped migrations load clean, touch nothing at /1
// and move /0 documents to /1. No network; the CLI under test is the copy's
// own bin/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { withTmp } from './helpers/tmp.mjs';
import { ROOT } from './helpers/cli.mjs';
import { EPOCH_ENV, NOW, cloneRoom, patchJson, readJson, scaffoldCenter, writeJson } from './helpers/center.mjs';
import { compareManifest, writeManifests } from '../scripts/manifest.mjs';
import { loadMigrations, migrate, planMigrations } from '../lib/migrate.mjs';

const SKIP_TOP = new Set(['node_modules', '.git', 'data', '.dotfield', 'center']);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fork Sim', GIT_AUTHOR_EMAIL: 'fork-sim@localhost', GIT_COMMITTER_NAME: 'Fork Sim', GIT_COMMITTER_EMAIL: 'fork-sim@localhost' };
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const fails = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.code);

/** The engine tree without owner data, derived output, deps or the fetched vendor files. */
function copyTree(src, dst) {
  cpSync(src, dst, {
    recursive: true,
    filter: (s) => {
      const rel = relative(src, s);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (SKIP_TOP.has(parts[0])) return false;
      return !(parts[0] === 'vendor' && parts[1] === 'three');
    },
  });
}
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/** The copy's own CLI (not this tree's), so packageRoot, manifest and migrations are the copy's. */
function cli(repo, args, env = {}) {
  const base = { ...process.env, ...EPOCH_ENV, ...env };
  delete base.CLAUDECODE; delete base.CLAUDE_CODE_ENTRYPOINT;
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'dotfield.mjs'), ...args, '--json'], { cwd: repo, env: base, encoding: 'utf8', timeout: 120_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test('a fork commits the center init wrote, merges an upstream release of lib/, schemas/ and its pack with no conflict and no merge driver, and migrate brings the untouched pack file forward while keeping the owner edit', { skip: hasGit ? false : 'git is not installed' }, async () => {
  await withTmp(async (tmp) => {
    // The copy's bin/ runs only when process.argv[1] equals its real path, so resolve the temp dir's symlinks (macOS /var → /private/var).
    const dir = realpathSync(tmp);
    const repo = join(dir, 'repo');
    copyTree(ROOT, repo);
    writeManifests(repo);
    assert.ok(compareManifest(repo).ok, 'the base release is self-consistent');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'upstream 0.1.0');
    assert.equal(git(repo, 'ls-files', '--', 'center'), '', 'the template ships no center/');
    assert.doesNotMatch(readFileSync(join(repo, '.gitattributes'), 'utf8'), /merge=ours/);

    // The fork: init (no --force on a fresh clone), then brand, a new room, an edited pack room, prose, package name.
    git(repo, 'checkout', '-q', '-b', 'fork');
    const init = cli(repo, ['init', '--pack', 'robotics-lab', '--name', 'Hall Lab']);
    assert.equal(init.code, 0, init.stdout);
    assert.equal(init.json && init.json.status, 'written', init.stdout);
    for (const k of ['session.key', 'owner.token', 'handle.salt', 'self.ed25519']) assert.ok(existsSync(join(repo, 'data', 'keys', k)), k);
    assert.ok(existsSync(join(repo, 'center', 'pack-lock.json')));
    patchJson(join(repo, 'center', 'brand.json'), (b) => { b.name = 'Hall Lab · Bay 4'; });
    const center = { root: repo, centerDir: join(repo, 'center'), roomDir: (id) => join(repo, 'center', 'rooms', id), roomFile: (id, f) => join(repo, 'center', 'rooms', id, f) };
    cloneRoom(center, 'experiments', 'bench-runs', (d) => { d.label = 'Bench runs'; d.pack = null; });
    patchJson(center.roomFile('robots', 'room.json'), (d) => { d.label = 'Our robots'; });
    appendFileSync(join(repo, 'center', 'docs', 'README.md'), '\n## Hall Lab\n\nThe rig lives in room 204; calibration runs every Monday.\n');
    patchJson(join(repo, 'package.json'), (p) => { p.name = 'hall-lab-center'; p.description = 'The Hall Lab center, forked from dotfield.'; });
    git(repo, 'add', '-A');
    assert.ok(git(repo, 'diff', '--cached', '--name-only').split('\n').some((f) => f.startsWith('center/')), 'the fork tracks its center');
    assert.ok(!git(repo, 'diff', '--cached', '--name-only').split('\n').some((f) => f.startsWith('data/') || f.startsWith('.dotfield/')), 'keys and derived output stay ignored');
    git(repo, 'commit', '-q', '-m', 'fork: init robotics-lab, brand, a room, prose, package name');
    assert.deepEqual(compareManifest(repo), { ok: true, changed: [], missing: [], added: [] }, 'a fork commit is not an engine change');

    // Upstream 0.1.1: lib/, schemas/ and two robotics-lab room files change; the manifest is regenerated in the same commit.
    git(repo, 'checkout', '-q', 'main');
    appendFileSync(join(repo, 'lib', 'digest.mjs'), '\n// 0.1.1: the canonical form is documented in references/IR.md.\n');
    patchJson(join(repo, 'schemas', 'center-config.schema.json'), (s) => { s.description = 'The center configuration (0.1.1).'; });
    patchJson(join(repo, 'packs', 'robotics-lab', 'rooms', 'datasets', 'room.json'), (d) => { d.label = 'Datasets (0.1.1)'; });
    patchJson(join(repo, 'packs', 'robotics-lab', 'rooms', 'robots', 'room.json'), (d) => { d.label = 'Robots (0.1.1)'; });
    writeManifests(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'upstream 0.1.1: lib + schemas + robotics-lab');

    // The merge: no driver is configured (GIT_CONFIG_GLOBAL=/dev/null), and none is needed.
    git(repo, 'checkout', '-q', 'fork');
    assert.doesNotThrow(() => git(repo, 'merge', '-q', '--no-edit', 'main'), 'the merge must not conflict');
    assert.equal(git(repo, 'ls-files', '-u'), '', 'no unmerged path');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'a clean tree after the merge');
    assert.equal(readJson(join(repo, 'package.json')).name, 'hall-lab-center');
    assert.equal(readJson(join(repo, 'center', 'brand.json')).name, 'Hall Lab · Bay 4');
    assert.match(readFileSync(join(repo, 'center', 'docs', 'README.md'), 'utf8'), /room 204/);
    assert.match(readFileSync(join(repo, 'lib', 'digest.mjs'), 'utf8'), /0\.1\.1: the canonical form/);
    assert.deepEqual(compareManifest(repo), { ok: true, changed: [], missing: [], added: [] }, 'the merged tree matches the upstream manifest');

    const doctor = cli(repo, ['doctor']);
    assert.equal(doctor.code, 0, doctor.stdout);
    assert.ok(!fails(doctor.json).includes('DF_ENGINE_MODIFIED'), `doctor: ${fails(doctor.json).join(', ')}`);
    assert.ok(!fails(doctor.json).includes('DF_ENGINE_MIGRATION_PENDING'));

    // migrate: a dry run writes nothing; the apply takes the untouched file, keeps the edited one; --resolved closes the drift.
    const dry = cli(repo, ['migrate', '--dry-run']);
    assert.equal(dry.code, 0, dry.stdout);
    assert.equal(dry.json.status, 'read');
    assert.ok(dry.json.checks.some((c) => c.code === 'DF_PACK_VERSION_DRIFT' && c.status === 'fail' && c.blocking === false), 'the upstream pack change shows as drift');
    assert.match(dry.json.next_action, /1 to update, 1 you changed kept as they are/);
    assert.equal(git(repo, 'status', '--porcelain'), '', 'a dry run writes nothing');
    const apply = cli(repo, ['migrate']);
    assert.equal(apply.code, 0, apply.stdout);
    assert.equal(apply.json.status, 'written');
    assert.equal(readJson(join(repo, 'center', 'rooms', 'datasets', 'room.json')).label, 'Datasets (0.1.1)', 'the file the fork never touched took the update');
    assert.equal(readJson(join(repo, 'center', 'rooms', 'robots', 'room.json')).label, 'Our robots', 'the fork edit is kept');
    const shipped = apply.json.outputs.find((o) => o.kind === 'shipped_for_merge');
    assert.ok(shipped && readJson(join(repo, shipped.ref)).label === 'Robots (0.1.1)', 'the shipped version waits under .dotfield/migrate-<ts>/shipped/');
    assert.ok(apply.json.checks.some((c) => c.code === 'DF_PACK_VERSION_DRIFT' && c.status === 'fail'), 'drift stays while a merge is open');
    const resolved = cli(repo, ['migrate', '--resolved']);
    assert.equal(resolved.code, 0, resolved.stdout);
    assert.ok(resolved.json.checks.some((c) => c.code === 'DF_PACK_VERSION_DRIFT' && c.status === 'pass'), 'resolved: no drift');
    assert.equal(readJson(join(repo, 'center', 'rooms', 'robots', 'room.json')).label, 'Our robots');
    const validate = cli(repo, ['validate', 'all']);
    assert.equal(validate.code, 0, validate.stdout);
    const changed = git(repo, 'status', '--porcelain').split('\n').map((l) => l.trim().split(/\s+/).pop()).sort();
    assert.deepEqual(changed, ['center/center.config.json', 'center/pack-lock.json', 'center/rooms/datasets/room.json'], 'the upgrade leaves a center/ diff for the fork to commit, nothing else');
  });
});

test('shipped migrations load clean, touch nothing at /1, and move /0 documents to /1 that validate and are no longer pending', async () => {
  const { migrations, checks } = await loadMigrations(join(ROOT, 'migrations'));
  assert.deepEqual(checks, []);
  assert.deepEqual(migrations.map((m) => [m.file, m.from, m.to, m.kind]), [
    ['0001-center-config-v1.mjs', 'dotfield.center-config/0', 'dotfield.center-config/1', 'center-config'],
    ['0002-room-mode-write-after-approval.mjs', 'dotfield.room/0', 'dotfield.room/1', 'room'],
  ]);
  assert.ok(existsSync(join(ROOT, 'migrations', 'README.md')));
  for (const m of migrations) assert.notEqual(m.from, m.to, `${m.file}: a same-version step would be pending forever (doctor: pending = schema_version === from)`);
  await withTmp(async (dir) => {
    const c = scaffoldCenter(dir);
    assert.equal(planMigrations(migrations, { centerDir: c.centerDir, root: c.root }).steps.length, 0, 'a 0.1.0 center has nothing pending');
    const oldConfig = { schema_version: 'dotfield.center-config/0', center: { name: 'Old Center', owner_person_id: 'self' } };
    writeJson(c.configPath, oldConfig);
    patchJson(c.roomFile('notes', 'room.json'), (d) => { d.schema_version = 'dotfield.room/0'; d.mode = 'write_after_approval'; });
    const input = structuredClone(oldConfig);
    migrations[0].migrate(input);
    assert.deepEqual(input, oldConfig, 'migrate() never mutates its input');
    const plan = planMigrations(migrations, { centerDir: c.centerDir, root: c.root });
    assert.equal(plan.steps.length, 2);
    const cfg = plan.steps.find((s) => s.kind === 'center-config');
    assert.ok(cfg.validated && cfg.valid, JSON.stringify(cfg.checks));
    assert.equal(cfg.after.schema_version, 'dotfield.center-config/1');
    assert.equal(cfg.after.center.name, 'Old Center');
    assert.equal(cfg.after.provider.adapter, 'dry');
    assert.deepEqual(cfg.after.installed_packs, []);
    assert.match(cfg.patch, /\+  "schema_version": "dotfield\.center-config\/1"/);
    const room = plan.steps.find((s) => s.kind === 'room');
    assert.ok(room.validated && room.valid, JSON.stringify(room.checks));
    assert.equal(room.after.mode, 'proposal_only');
    assert.equal(room.after.schema_version, 'dotfield.room/1');
    const r = await migrate({ packageRoot: ROOT, centerDir: c.centerDir, dotDir: c.dotDir, root: c.root, config: null, now: NOW, packsDir: join(dir, 'nopacks') });
    assert.equal(r.applied.written.length, 2);
    assert.ok(r.checks.some((x) => x.code === 'DF_ENGINE_MIGRATION_PENDING' && x.status === 'pass'));
    assert.equal(readJson(c.configPath).schema_version, 'dotfield.center-config/1');
    assert.equal(readJson(c.roomFile('notes', 'room.json')).mode, 'proposal_only');
    assert.equal(planMigrations(migrations, { centerDir: c.centerDir, root: c.root }).steps.length, 0, 'nothing pending after apply');
    const validate = spawnSync(process.execPath, [join(ROOT, 'bin', 'dotfield.mjs'), 'validate', 'all', '--json'], { cwd: c.root, env: { ...process.env, ...EPOCH_ENV }, encoding: 'utf8' });
    assert.equal(validate.status, 0, validate.stdout);
    writeFileSync(join(dir, 'unused.txt'), '');
  });
});
