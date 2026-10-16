// Writes under .dotfield/tmp/, the one directory the sandbox allows.
import { writeFileSync } from 'node:fs';
export const scratch = (records) => {
  writeFileSync(new URL('../../../.dotfield/tmp/scratch.json', import.meta.url), JSON.stringify(records));
  return records.length;
};
