// The three-state scope rule (VISION §2.7, ported from son as internal
// code): a single-owner request opens the owner container; `--as <person>`
// opens person_<id> (tests and future sessions); a non-owner request with no
// session is refused and never falls back to the owner's data. There is no
// multi_person flag anywhere: the rule is reached only through --as or a
// server session object.
import { fail, pass } from './rules.mjs';

export const PERSON_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
export const SCOPE_RE = /^(owner|public|person_[a-z0-9][a-z0-9_.:-]{0,79})$/;
export const OWNER_SCOPE = 'owner';
export const PUBLIC_SCOPE = 'public';
export const SELF = 'self';
export const CODES = Object.freeze(['DF_STORE_SCOPE_REFUSED', 'DF_STORE_SCOPE_EMPTY_UID']);

/**
 * Lower-case, trim, drop every character outside [a-z0-9_.:-], drop a
 * leading run of non-alphanumerics (so "../x" cannot become a path), cap
 * at 80. An id that survives matches PERSON_ID_RE; "" means nothing did.
 */
export function sanitizeId(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '').replace(/^[^a-z0-9]+/, '');
  return s.slice(0, 80);
}

/** The owner's person id from center.config.json (default "self"). */
export function ownerPersonId(config) {
  const id = config && config.center && typeof config.center.owner_person_id === 'string' ? config.center.owner_person_id : SELF;
  return PERSON_ID_RE.test(id) ? id : SELF;
}

export function isScope(value) {
  return typeof value === 'string' && SCOPE_RE.test(value);
}

/** person_<id> -> <id>; owner -> the owner id; public -> "public"; else null. */
export function personOfScope(scope, config) {
  if (scope === OWNER_SCOPE) return ownerPersonId(config);
  if (scope === PUBLIC_SCOPE) return PUBLIC_SCOPE;
  return isScope(scope) ? scope.slice('person_'.length) : null;
}

/** The directory under data/ a scope's stores live in: "" (owner), "person_<id>", or null (no store). */
export function containerOf(scope) {
  if (scope === OWNER_SCOPE) return '';
  if (scope === PUBLIC_SCOPE) return null;
  return isScope(scope) ? scope : null;
}

function accepted(scope, viewer, owner, extra = {}) {
  return {
    ok: true, scope, viewer, container: containerOf(scope), owner, status: 200, code: null,
    checks: CODES.map((c) => pass(c)), ...extra,
  };
}

function refused(code, status, detail, owner) {
  return { ok: false, scope: null, viewer: null, container: null, owner, status, code, checks: [fail(code, { detail })] };
}

/**
 * resolveScope({config, as, session, origin}) ->
 *   {ok: true, scope: 'owner' | 'public' | 'person_<id>', viewer, container, owner, checks}
 *   | {ok: false, status: 401 | 400, code: 'DF_STORE_SCOPE_REFUSED' | 'DF_STORE_SCOPE_EMPTY_UID', checks}
 *
 * origin 'local' (CLI, loopback owner session): no `as`, "self" or the owner
 * id -> owner; "public" -> the public viewer (no store); anything else ->
 * person_<sanitised id>; an id empty after sanitising is refused.
 * origin 'remote' (a non-owner request): only a session {person_id} opens a
 * person scope; `as` is ignored, the owner container is never offered.
 */
export function resolveScope({ config = null, as = null, session = null, origin = 'local' } = {}) {
  const owner = ownerPersonId(config);
  if (origin !== 'local') {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return refused('DF_STORE_SCOPE_REFUSED', 401, 'a non-owner request arrived without a session; the owner container is never the fallback', owner);
    }
    const id = sanitizeId(session.person_id);
    if (!id) return refused('DF_STORE_SCOPE_EMPTY_UID', 400, 'session.person_id is empty after sanitising', owner);
    if (id === SELF || id === owner) return refused('DF_STORE_SCOPE_REFUSED', 401, 'a session cannot claim the owner container', owner);
    return accepted(`person_${id}`, id, owner, { requested: String(session.person_id) });
  }
  if (as === undefined || as === null) return accepted(OWNER_SCOPE, SELF, owner);
  const raw = String(as);
  const id = sanitizeId(raw);
  if (!id) return refused('DF_STORE_SCOPE_EMPTY_UID', 400, `--as ${JSON.stringify(raw)} is empty after sanitising`, owner);
  if (id === SELF || id === owner) return accepted(OWNER_SCOPE, SELF, owner, { requested: raw });
  if (id === PUBLIC_SCOPE) return accepted(PUBLIC_SCOPE, PUBLIC_SCOPE, owner, { requested: raw });
  return accepted(`person_${id}`, id, owner, { requested: raw });
}
