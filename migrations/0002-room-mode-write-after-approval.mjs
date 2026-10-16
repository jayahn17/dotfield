// migrations/0002-room-mode-write-after-approval.mjs — a pre-release room
// manifest (`dotfield.room/0`) could say `mode: "write_after_approval"`; the
// released schema names the same thing `proposal_only` (every write is a
// proposal until the owner approves it). This migration aliases the mode
// and moves the document to `dotfield.room/1`; everything else in the
// manifest is left as written, so a /0 room that is otherwise incomplete is
// still refused by the shipped schema after migration (and left pending).
export const from = 'dotfield.room/0';
export const to = 'dotfield.room/1';
export const kind = 'room';

/** Old mode name -> the released enum value (room.schema.json: read_only | proposal_only | blocked). */
export const MODE_ALIASES = Object.freeze({ write_after_approval: 'proposal_only' });

/** migrate(doc) -> doc at /1. Pure: no clock, no I/O, the input is not mutated. */
export function migrate(doc) {
  const out = structuredClone(doc);
  if (typeof out.mode === 'string' && Object.hasOwn(MODE_ALIASES, out.mode)) out.mode = MODE_ALIASES[out.mode];
  out.schema_version = to;
  return out;
}
