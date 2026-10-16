import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('tries to seed the store', () => {
  writeFileSync(new URL('../../../data/demo.json', import.meta.url), '[]');
});
