// migrations/0001-center-config-v1.mjs — the scaffold every later migration
// copies (migrations/README.md). It moves a pre-release center config
// (`dotfield.center-config/0`: the shape before 0.1.0 pinned the eight
// blocks) to `dotfield.center-config/1` by filling the blocks that were
// optional then and are required now, touching nothing the owner wrote.
// A center created by `dotfield init` 0.1.0 is already at /1, so this file
// never applies to it: `pending` means `schema_version === from`.
export const from = 'dotfield.center-config/0';
export const to = 'dotfield.center-config/1';
export const kind = 'center-config';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The defaults `dotfield init` writes; a /0 document keeps every value it already has. */
export const DEFAULTS = Object.freeze({
  center: { name: 'Dotfield', tagline: 'A private center; rename it here, then run dotfield validate all.', owner_person_id: 'self', locale: 'en' },
  installed_packs: [],
  provider: { adapter: 'dry', model: null, max_tokens_per_run: 8000, allow_nested: false },
  server: { port: 4100, host: '127.0.0.1' },
  privacy: { default_privacy_level: 'private' },
  connect: { threshold: 0.35 },
  approval: { max_records_per_proposal: 200 },
  store: { allow_env_pins: false, object_store_url: null },
  conductor: { display: 'Conductor', lens: 'turn one question into a mission brief, route it to at most five desks and one challenger, and stop at awaiting_owner' },
});

/** Shallow-fill: every key of `defaults` that `doc[key]` lacks (one level into each block). */
function fill(doc, defaults) {
  const out = { ...doc };
  for (const [key, value] of Object.entries(defaults)) {
    if (Array.isArray(value)) { if (!Array.isArray(out[key])) out[key] = [...value]; continue; }
    if (isObject(value)) { out[key] = { ...value, ...(isObject(out[key]) ? out[key] : {}) }; continue; }
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/** migrate(doc) -> doc at /1. Pure: no clock, no I/O, the input is not mutated. */
export function migrate(doc) {
  const out = fill(structuredClone(doc), DEFAULTS);
  if (typeof out.center.owner_person_id !== 'string' || !out.center.owner_person_id) out.center.owner_person_id = 'self';
  out.schema_version = to;
  return out;
}
