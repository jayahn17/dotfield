// Reads whatever path it is handed; the sandbox refuses paths outside the allowed roots.
import { readFileSync } from 'node:fs';
export const peek = (records, input) => readFileSync(input.path, 'utf8');
