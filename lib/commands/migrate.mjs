// dotfield migrate [--dry-run] [--resolved] (VISION §8.2, §9 upgrade path):
// runs migrations/NNNN-*.mjs over center/**/*.json through lib/migrate.mjs,
// then brings each installed pack's files up to the shipped version through
// center/pack-lock.json: a file the owner never touched is replaced, a file
// the owner changed is kept and the shipped version is written beside the
// backups for a hand merge (DF_PACK_VERSION_DRIFT stays, non-blocking, until
// that is done), a file the owner deleted stays deleted. Every replaced file
// is backed up under .dotfield/migrate-<ts>/ first. --dry-run prints the
// patch and writes nothing; --resolved records the remaining merges as done
// (the owner kept their file or merged by hand) and moves installed_packs to
// the shipped version. An owner verb: outside the skill allow-list and the
// MCP tools, like approve. DOTFIELD_MIGRATIONS_DIR / DOTFIELD_PACKS_DIR
// relocate the two engine folders for tests.
import { join } from 'node:path';
import { migrate } from '../migrate.mjs';
import { isBlockingFail } from '../pipeline.mjs';
import { buildReceipt } from '../receipt.mjs';
import { fail } from '../rules.mjs';

export const verb = 'migrate';
export const leaves = ['migrate'];
export const usage = 'migrate [--dry-run] [--resolved] [--json]';

/** One line per pack: what the plan does (dry run) or did. */
function packLine(r, dryRun, resolved) {
  if (!r.packs.plans.length) return 'no installed pack';
  const count = (a) => r.packs.plans.reduce((n, p) => n + p.rows.filter((x) => (Array.isArray(a) ? a.includes(x.action) : x.action === a)).length, 0);
  const merge = count(['conflict', 'unknown_no_lock', 'missing_no_lock']);
  const updates = count(['update', 'add']);
  const head = dryRun ? `pack files: ${updates} to update` : `pack files: ${r.packApplied.written.filter((w) => !/pack-lock\.json$|center\.config\.json$/.test(w.ref)).length} updated`;
  const kept = count('kept_deleted') ? `, ${count('kept_deleted')} you deleted stay deleted` : '';
  const merges = !merge ? '' : resolved && !dryRun ? `, ${merge} merge(s) recorded as resolved (your file kept as it is)`
    : `, ${merge} you changed kept as they are${dryRun ? '' : ' (shipped version under shipped/ in the backup folder; merge by hand, then dotfield migrate --resolved)'}`;
  const advanced = r.packApplied.advanced.length ? `; installed_packs now ${r.packApplied.advanced.join(', ')} at the shipped version` : '';
  return `${head}${kept}${merges}${advanced}`;
}

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot, releaseTag: 'v1.1-provisional' };
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init or cd to a fork root' })] });
  const dryRun = args.flags['dry-run'] === true;
  const resolved = args.flags.resolved === true;
  const r = await migrate({
    packageRoot: ctx.packageRoot, centerDir: ctx.centerDir, dotDir: ctx.dotDir, root: ctx.root, config: ctx.config, now: ctx.now, dryRun, resolved,
    migrationsDir: ctx.env.DOTFIELD_MIGRATIONS_DIR || join(ctx.packageRoot, 'migrations'), packsDir: ctx.env.DOTFIELD_PACKS_DIR || join(ctx.packageRoot, 'packs'),
  });
  if (ctx.stdout && !args.json && r.patch) ctx.stdout.write(r.patch);
  const inputs = r.steps.map((s) => ctx.inputRef(s.file)).filter(Boolean);
  const outputs = [
    ...r.applied.written.flatMap((w) => [{ ...ctx.inputRef(w.file), kind: 'migrated', action: 'written' }, { ...ctx.inputRef(w.backup), kind: 'backup', action: 'written' }]),
    ...r.packApplied.written.flatMap((w) => [{ ...ctx.inputRef(w.file), kind: 'pack_update', action: 'written' }, ...(w.backup ? [{ ...ctx.inputRef(w.backup), kind: 'backup', action: 'written' }] : [])]),
    ...r.packApplied.merges.map((m) => ({ ...ctx.inputRef(m.shipped), kind: 'shipped_for_merge', action: 'written' })),
  ];
  const wrote = r.applied.written.length + r.packApplied.written.length + r.packApplied.merges.length;
  const blocked = r.checks.some(isBlockingFail);
  const stepLine = r.steps.length ? r.steps.map((s) => `${s.ref}: ${s.from} → ${s.to}`).join('; ') : 'no migration applies';
  const next = blocked ? undefined
    : dryRun ? `Dry run: ${stepLine}; ${packLine(r, true, resolved)}. Run dotfield migrate to apply with a backup under .dotfield/migrate-<ts>/.`
      : wrote ? `${stepLine}; ${packLine(r, false, resolved)}; originals under ${ctx.relRef(r.applied.backupDir)}. Run dotfield validate all, then commit center/.`
        : `${stepLine} (${r.migrations.length} migration(s) shipped); ${packLine(r, false, resolved)}.`;
  return buildReceipt({ ...base, inputs, checks: r.checks, outputs, status: blocked ? 'blocked' : wrote ? 'written' : 'read', nextAction: next });
}
