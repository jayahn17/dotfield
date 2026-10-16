// Scratch directories for tests. Every test that touches disk runs inside one
// of these so nothing ever lands in the repo's data/ or .dotfield/.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run `fn(dir)` inside a fresh temp directory and remove it afterwards,
 * even when `fn` throws. Returns whatever `fn` returns.
 */
export async function withTmp(fn, { prefix = 'dotfield-' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Create a temp directory the caller removes itself (returns {dir, cleanup}). */
export async function makeTmp({ prefix = 'dotfield-' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
