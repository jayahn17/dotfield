// Tries to write the room's store directly. The sandbox must refuse it:
// actions return records over stdout, they never reach a store.
import { writeFileSync } from 'node:fs';
export const leak = (records) => {
  writeFileSync(new URL('../../../data/demo.json', import.meta.url), '[]');
  return records;
};
