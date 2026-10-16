// Spawns the real CLI (bin/dotfield.mjs) the way an operator or the skill
// would, and hands back exit code, both streams and the parsed --json body.
// test/ is exempt from the child_process rule in structure.test.js.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = resolve(ROOT, 'bin', 'dotfield.mjs');

/** Pull the last JSON document out of stdout, or null when there is none. */
export function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A human line may precede the JSON; take the last top-level {...} block.
    const start = text.lastIndexOf('\n{');
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start + 1));
    } catch {
      return null;
    }
  }
}

/**
 * runCli(args, {cwd, env, stdin}) → {code, stdout, stderr, json}
 * `env` is merged over a minimal process env; CLAUDECODE is stripped unless
 * the caller sets it, so approve-refusal tests choose the condition explicitly.
 */
export function runCli(args, { cwd = ROOT, env = {}, stdin, timeout = 60_000 } = {}) {
  const base = { ...process.env };
  delete base.CLAUDECODE;
  delete base.CLAUDE_CODE_ENTRYPOINT;
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...base, ...env },
    input: stdin,
    encoding: 'utf8',
    timeout,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    code: result.status ?? (result.signal ? 1 : 1),
    stdout,
    stderr,
    json: parseJsonOutput(stdout),
    signal: result.signal ?? null,
    error: result.error ?? null,
  };
}
