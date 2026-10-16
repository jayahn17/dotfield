// The fail-closed wall in front of server/serve.mjs (VISION §8.5).
//
// Stance: safety that depends on an env var being present cannot be safe,
// because a host move is exactly the event that loses env vars. So with
// nothing configured a request from off the machine is refused for anything
// private; a local request (loopback peer AND no X-Forwarded-For AND a
// loopback Host header) keeps working unchanged. The X-Forwarded-For clause
// is the load-bearing half against a proxy (it connects from 127.0.0.1); the
// Host clause is the load-bearing half against DNS rebinding (a browser tab
// whose hostname was rebound to 127.0.0.1 is a loopback peer with no
// X-Forwarded-For, but its Host names the attacker's domain, never
// 127.0.0.1, localhost or [::1]). DOTFIELD_TRUSTED_PROXY_WALL=1 is the one
// assertion that a wall sits in front; it opens reads, never the decide route.
//
// The privacy levels come from lib/privacy-levels.mjs and nowhere else: the
// projector (lib/share.mjs) reads the same constant, and
// test/wall-share-agreement.test.js fails if either side defines its own.
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEVELS, PRIVATE_SET, isLevel, isPrivate, mostPrivate } from '../lib/privacy-levels.mjs';
import { fail, pass } from '../lib/rules.mjs';

/** The one private set; identical (===) to lib/privacy-levels.mjs PRIVATE_SET and lib/share.mjs PRIVATE_LEVELS. */
export const PRIVATE_LEVELS = PRIVATE_SET;
export const TRUSTED_PROXY_ENV = 'DOTFIELD_TRUSTED_PROXY_WALL';
export const OWNER_HEADER = 'x-dotfield-owner';
export const OWNER_TOKEN_FILE = 'owner.token';
export const JSON_MEDIA_TYPE = 'application/json';
export const SAME_SITE_VALUES = Object.freeze(['same-origin', 'none']);
export const LOOPBACK = Object.freeze(new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']));
/** Host-header authorities a local request may carry (the port is stripped first). */
export const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', 'localhost', '[::1]', '[::ffff:127.0.0.1]']));
export const DECIDE_PATH = 'POST /api/proposals/<id>/decide';
export const WALL_REASONS = Object.freeze({
  private_live: 'the room is private_live',
  level: 'the response could carry a private level',
  owner_only: 'the resource is owner-only',
});

export function envFlag(env, name) {
  const value = env && env[name];
  return value !== undefined && value !== '' && ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Length-independent constant-time compare; a wrong length costs the same as a wrong value. */
export function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (!b.length) return false;
  if (a.length !== b.length) { timingSafeEqual(b, b); return false; }
  return timingSafeEqual(a, b);
}

function header(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v.join(',') : (typeof v === 'string' ? v : '');
}

export function peerAddress(req) {
  return req && req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : null;
}

export function isLoopbackPeer(req) {
  const addr = peerAddress(req);
  return addr !== null && LOOPBACK.has(addr);
}

export function hasForwardedFor(req) {
  return header(req, 'x-forwarded-for').trim().length > 0;
}

/** The Host header without its port, lower-cased: "127.0.0.1:4100" -> "127.0.0.1", "[::1]:4100" -> "[::1]"; '' when absent. */
export function hostAuthority(req) {
  const raw = header(req, 'host').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) { const end = raw.indexOf(']'); return end > 0 ? raw.slice(0, end + 1) : raw; }
  return raw.split(':')[0];
}

/** Does the Host header name this machine? A rebound browser tab carries the attacker's hostname here; an absent Host is not loopback. */
export function hasLoopbackHost(req) {
  return LOOPBACK_HOSTS.has(hostAuthority(req));
}

/** Local = loopback peer AND no X-Forwarded-For AND a loopback Host. A request with no socket is remote. */
export function isLocalRequest(req) {
  return isLoopbackPeer(req) && !hasForwardedFor(req) && hasLoopbackHost(req);
}

export function trustedProxyWall(env) {
  return envFlag(env, TRUSTED_PROXY_ENV);
}

/** The media type of a Content-Type header, lower-cased, parameters dropped. */
export function mediaType(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase();
}

export function isJsonContentType(value) {
  return mediaType(value) === JSON_MEDIA_TYPE;
}

export function manifestOf(room) {
  return room && room.manifest ? room.manifest : room;
}

export function isPrivateLive(room) {
  const m = manifestOf(room);
  return Boolean(m && m.privacy_mode === 'private_live');
}

/** The viewer mode a viewer id resolves to: 'self' | 'public' | 'person'. */
export function modeOf(viewer, ownerId = 'self') {
  const id = viewer && typeof viewer === 'object' ? viewer.person_id : viewer;
  if (id === undefined || id === null || id === '' || id === 'self' || id === ownerId) return 'self';
  return id === 'public' ? 'public' : 'person';
}

/**
 * exposure({room, viewer, ownerId, fields}) -> the most private level a
 * response to this viewer could carry. self sees every record whatever its
 * level (the top of LEVELS); a person may receive fields beyond public_fields
 * under a rule, so at least 'private'; the public viewer sees public records
 * and public_fields only. A requested field outside public_fields lifts the
 * level to the room's default (the fields are private until a rule says
 * otherwise); an unknown level counts as the most private one.
 */
export function exposure({ room = null, viewer = 'self', ownerId = 'self', fields = null } = {}) {
  const mode = modeOf(viewer, ownerId);
  if (mode === 'self') return LEVELS[LEVELS.length - 1];
  let level = mode === 'person' ? 'private' : 'public';
  const m = manifestOf(room);
  const rec = m && m.record ? m.record : {};
  const publicFields = Array.isArray(rec.public_fields) ? rec.public_fields : [];
  if (Array.isArray(fields) && fields.some((f) => !publicFields.includes(f))) {
    const fallback = isLevel(rec.default_privacy_level) ? rec.default_privacy_level : 'private';
    level = mostPrivate(level, isPrivate(fallback) ? fallback : 'private');
  }
  return level;
}

export function levelIsPrivate(level) {
  return isLevel(level) ? PRIVATE_LEVELS.has(level) : true;
}

/**
 * checkWall({req, env, room, viewer, ownerId, fields, ownerOnly}) ->
 *   {ok, local, trusted, level, reasons[], check, status}
 * Local requests always pass. A remote request passes only when a trusted
 * proxy wall is asserted, or when nothing private could leave: not a
 * private_live room, not an owner-only resource, exposure level public.
 */
export function checkWall({ req = null, env = {}, room = null, viewer = 'public', ownerId = 'self', fields = null, ownerOnly = false, path = null } = {}) {
  const local = isLocalRequest(req);
  const trusted = trustedProxyWall(env);
  const level = exposure({ room, viewer, ownerId, fields });
  const reasons = [];
  if (!local && !trusted) {
    if (ownerOnly) reasons.push(WALL_REASONS.owner_only);
    if (isPrivateLive(room)) reasons.push(WALL_REASONS.private_live);
    if (levelIsPrivate(level)) reasons.push(`${WALL_REASONS.level} (${level})`);
  }
  const ok = reasons.length === 0;
  const check = ok ? pass('DF_SERVER_WALL_REFUSED') : fail('DF_SERVER_WALL_REFUSED', { path: path ?? undefined, detail: `${reasons.join('; ')}; peer ${peerAddress(req) ?? 'unknown'}${hasForwardedFor(req) ? ' behind X-Forwarded-For' : ''}${isLoopbackPeer(req) && !hasLoopbackHost(req) ? ` with Host ${JSON.stringify(hostAuthority(req) || 'absent')} (not a loopback authority)` : ''}` });
  return { ok, local, trusted, level, reasons, check, status: ok ? 200 : 403 };
}

export function ownerTokenPath(dataDir) {
  return join(dataDir, 'keys', OWNER_TOKEN_FILE);
}

/** The owner token on disk (trimmed) or null when absent or empty. */
export function readOwnerToken(dataDir) {
  const file = ownerTokenPath(dataDir);
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8').trim();
    return text.length ? text : null;
  } catch { return null; }
}

/**
 * checkDecideGuard({req, token}) -> {ok, local, reasons[], check, status}
 * The decide route needs all of: a local request (loopback peer, no
 * X-Forwarded-For, a loopback Host), Content-Type application/json,
 * X-Dotfield-Owner equal to the owner token, and Sec-Fetch-Site in
 * {same-origin, none} when present. Every missing piece is named; the token
 * value never is.
 */
export function checkDecideGuard({ req = null, token = null, path = DECIDE_PATH } = {}) {
  const reasons = [];
  const local = isLocalRequest(req);
  if (!isLoopbackPeer(req)) reasons.push('the peer is not loopback');
  if (hasForwardedFor(req)) reasons.push('X-Forwarded-For is present (a proxied request is never the owner session)');
  if (!hasLoopbackHost(req)) reasons.push(`Host is ${JSON.stringify(hostAuthority(req) || 'absent')}, not 127.0.0.1, localhost or [::1] (a rebound hostname is never the owner session)`);
  const ct = header(req, 'content-type');
  if (!isJsonContentType(ct)) reasons.push(`Content-Type is ${ct ? JSON.stringify(mediaType(ct)) : 'absent'}, not application/json`);
  const given = header(req, OWNER_HEADER);
  if (!token) reasons.push('no owner token is on disk (data/keys/owner.token); start dotfield serve to create one');
  else if (!given) reasons.push('X-Dotfield-Owner is absent');
  else if (!sameSecret(given, token)) reasons.push('X-Dotfield-Owner does not match the owner token');
  const site = header(req, 'sec-fetch-site').trim().toLowerCase();
  if (site && !SAME_SITE_VALUES.includes(site)) reasons.push(`Sec-Fetch-Site is ${JSON.stringify(site)}`);
  const ok = reasons.length === 0;
  const check = ok ? pass('DF_SERVER_DECIDE_REFUSED') : fail('DF_SERVER_DECIDE_REFUSED', { path, detail: reasons.join('; ') });
  return { ok, local, reasons, check, status: ok ? 200 : 403 };
}
