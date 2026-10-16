// Rule family "store": lib/store.mjs and lib/scope.mjs. Gate id: "store".
// exit: a blocking failure maps to this exit code (lib/exit-codes.mjs).
export const family = 'store';
export const gate = 'store';
export const rules = {
  DF_STORE_SCOPE_REFUSED: { gate, blocking: true, exit: 3,
    message: 'A non-owner request arrived with no session, so no store was opened.',
    repair: 'Run as the owner, or pass --as <person_id> in tests; the engine never falls back to the owner container.' },
  DF_STORE_SCOPE_EMPTY_UID: { gate, blocking: true, exit: 3,
    message: 'A person scope was requested with an empty or invalid person id.',
    repair: 'Pass a person id matching ^[a-z0-9][a-z0-9_.:-]*$ to --as.' },
  DF_STORE_FAULT: { gate, blocking: true, exit: 4,
    message: 'The store could not be read or written (typed 503 storage fault).',
    repair: 'Check disk space and permissions on data/, then retry; nothing was partially written (tmp + fsync + rename).' },
  DF_STORE_CORRUPT: { gate, blocking: true, exit: 4,
    message: 'A store file is not valid JSON.',
    repair: 'Restore the sibling .bak file written by the last successful write, then retry.' },
  DF_STORE_WRITE_WITHOUT_APPROVAL: { gate, blocking: true, exit: 3,
    message: 'A write to a store was attempted outside dotfield approve.',
    repair: 'Create a proposal instead; only approve writes to data/rooms/.' },
  DF_STORE_MAX_RECORDS: { gate, blocking: true,
    message: 'The write would exceed the room store.max_records.',
    repair: 'Delete or archive records, or raise store.max_records in room.json.' },
  DF_STORE_MAX_BYTES: { gate, blocking: true,
    message: 'A record exceeds store.max_record_bytes.',
    repair: 'Trim the record or raise store.max_record_bytes in room.json.' },
  DF_STORE_ENV_PIN_IGNORED: { gate, blocking: false,
    message: 'A DOTFIELD_STORE_<ROOM>_FILE pin was present but ignored outside tests.',
    repair: 'Set store.allow_env_pins: true in center.config.json if the pin is intended; every receipt prints store.target.' },
};
