// Rule family "record": per-row checks when records are imported or
// proposed (import records, propose). Gate id: "record".
export const family = 'record';
export const gate = 'record';
export const rules = {
  DF_RECORD_SCHEMA_INVALID: { gate, blocking: true,
    message: 'A record does not validate against the room record.schema.json.',
    repair: 'Fix the row named in the path using the DF_SCHEMA_* findings beside this one, or map the column with --map.' },
  DF_RECORD_ID_MISSING: { gate, blocking: true,
    message: 'A record has no value for the room id_field and no --id column was given.',
    repair: 'Provide the id column with --id <col>, or let the importer derive a row hash with --id hash.' },
  DF_RECORD_DUP_ID: { gate, blocking: true,
    message: 'Two records in one import share an id.',
    repair: 'Make ids unique in the source file or choose another --id column.' },
  DF_RECORD_UNKNOWN_COLUMN: { gate, blocking: true,
    message: 'A source column is not a declared record field.',
    repair: 'Map the column with --map <col>=<field>, drop it, or pass --relax to keep it under ext.' },
  DF_RECORD_TOO_LARGE: { gate, blocking: true,
    message: 'A record exceeds the room store.max_record_bytes.',
    repair: 'Trim the record or raise store.max_record_bytes in room.json (default 16384).' },
  DF_RECORD_MAP_FIELD_UNKNOWN: { gate, blocking: true,
    message: 'A --map target is not a field of record.schema.json.',
    repair: 'Map onto a declared field name; run dotfield validate <room> to list them.' },
  DF_RECORD_LINK_UNRESOLVED: { gate, blocking: false,
    message: 'A link field names a record id that does not exist in the target room.',
    repair: 'Import the target room first or correct the id; unresolved links are kept and listed, not dropped.' },
  DF_RECORD_DATE_INVALID: { gate, blocking: true,
    message: 'A date field is not YYYY-MM-DD.',
    repair: 'Write dates as YYYY-MM-DD (the three dates: happened_on, remembered_on, released_on).' },
  DF_RECORD_EXT_MOVED: { gate, blocking: false,
    message: 'Unknown columns were moved under ext because --relax was given.',
    repair: 'Nothing to change; declare the fields in record.schema.json if the engine should read them.' },
};
