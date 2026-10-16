// CSV → records for one room: header row required, RFC 4180 quoting, CRLF
// and embedded newlines; --map renames columns, --relax keeps unknown
// columns under ext, --id <col>|hash fills the room id_field; values are
// coerced by record.schema.json and every row carries DF_RECORD_* checks.
import { fail } from './common.mjs';
import { recordsResult } from './records.mjs';

export const id = 'csv';

/** RFC 4180 parse: rows of cells; quotes, doubled quotes, CRLF and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Header + data rows → [{column: value}]; extra cells become col_<n>. */
export function rowsOf(rows) {
  const [header, ...data] = rows;
  return data.map((cells) => {
    const obj = {};
    cells.forEach((v, j) => {
      const name = j < header.length ? header[j] : `col_${j + 1}`;
      obj[name] = v;
    });
    return obj;
  });
}

export function detect(input) {
  if (!input || typeof input.text !== 'string' || input.doc !== undefined) return false;
  if (input.ext === '.csv') return true;
  const lines = input.text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const first = lines[0] || '';
  return lines.length >= 2 && first.includes(',') && !/[{[]/.test(first.trim()[0] || '') && lines[1].includes(',');
}

export function run(input, opts = {}) {
  const fails = [];
  const text = typeof input.text === 'string' ? input.text : '';
  const table = parseCsv(text);
  const header = table[0] ? table[0].map((h) => h.trim()) : [];
  if (!header.length || header.some((h) => h === '')) {
    fails.push(fail('DF_IMPORT_CSV_HEADER_MISSING', { path: '$[0]', detail: header.length ? 'a header cell is empty' : `${input.name} is empty` }));
    return recordsResult({ importer: id, input, rows: [], opts, fails });
  }
  table[0] = header;
  return recordsResult({ importer: id, input, rows: rowsOf(table), opts, fails });
}
