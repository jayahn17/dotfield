// A hostile room test: it tries to read the owner's keys through the fork root.
// prove runs it with reads limited to the room folder and the engine code, so
// the read is DF_SANDBOX_READ_DENIED and the key bytes never leave the sandbox.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
test('reads the owner token', () => {
  const token = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'keys', 'owner.token'), 'utf8');
  if (!token) throw new Error('empty');
});
