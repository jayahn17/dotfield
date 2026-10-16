// JSON → records for one room: an array of records, {records: [...]}, or a
// dotfield.store/1 envelope. Same --map / --relax / --id handling and the
// same per-row DF_RECORD_* checks as csv.
import { fail, isObject } from './common.mjs';
import { recordsResult } from './records.mjs';

export const id = 'json';

export function rowsOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (isObject(doc) && Array.isArray(doc.records)) return doc.records;
  return null;
}

export function detect(input) {
  if (!input || input.doc === undefined) return false;
  const rows = rowsOf(input.doc);
  if (!rows) return false;
  if (Array.isArray(input.doc)) return rows.length === 0 || rows.every((r) => isObject(r) || r === null || typeof r !== 'object');
  return isObject(input.doc) && (input.doc.schema_version === 'dotfield.store/1' || Object.keys(input.doc).every((k) => ['records', 'schema_version', 'room', 'namespace', 'scope', 'written_at', 'written_by', 'count', 'digest'].includes(k)));
}

export function run(input, opts = {}) {
  const fails = [];
  if (input.doc === undefined) {
    fails.push(fail('DF_IMPORT_FILE_UNREADABLE', { path: '$', detail: `${input.name} is not JSON` }));
    return recordsResult({ importer: id, input, rows: [], opts, fails });
  }
  const rows = rowsOf(input.doc);
  if (!rows) {
    fails.push(fail('DF_IMPORT_FORMAT_UNKNOWN', { path: '$', detail: 'expected an array of records or {records: [...]}' }));
    return recordsResult({ importer: id, input, rows: [], opts, fails });
  }
  return recordsResult({ importer: id, input, rows, opts, fails });
}
