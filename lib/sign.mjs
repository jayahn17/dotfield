// Signing (VISION §7.2, §7.3): ed25519 through node:crypto, signatures over
// canonical JSON bytes, a word-list fingerprint read out of band before a key
// is pinned by `add person`, key files written 0600, and the two HMAC
// primitives of the sharing layer: handles (owner-only, salted with
// data/keys/handle.salt) and pseudonyms (salted with one rule's own salt, so
// they link inside that rule and nowhere else). No clock, no randomness
// beyond the key generator itself.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonical, hmacHex } from './digest.mjs';

export const ALG = 'ed25519';
/** The statement every signature block carries: what the bytes under the signature are. */
export const SIGNED_STATEMENT = 'canonical(projection minus signature)';
export const KEY_FILE_MODE = 0o600;
export const FINGERPRINT_WORDS = 8;
/** A raw 32-byte ed25519 public key in standard base64 (44 characters). */
export const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 256 words, one per byte value; a fingerprint is the first 8 bytes of sha256(public key). */
export const WORDS = Object.freeze([
  'acid', 'acorn', 'actor', 'adobe', 'agate', 'aisle', 'alarm', 'album', 'alloy', 'almond', 'alpha', 'amber', 'anchor', 'angle', 'ankle', 'anvil',
  'apple', 'apron', 'arbor', 'arena', 'argon', 'arrow', 'ashes', 'aspen', 'atlas', 'attic', 'audio', 'autumn', 'avenue', 'award', 'axis', 'azure',
  'bacon', 'badge', 'bagel', 'baker', 'bamboo', 'banjo', 'barn', 'basil', 'basin', 'baton', 'beach', 'beacon', 'beetle', 'bell', 'bench', 'berry',
  'bison', 'blade', 'blaze', 'bloom', 'board', 'boat', 'bonnet', 'border', 'bottle', 'bowl', 'branch', 'brass', 'bread', 'brick', 'bridge', 'broom',
  'brush', 'bucket', 'bugle', 'bulb', 'butter', 'button', 'cabin', 'cable', 'cactus', 'camel', 'candle', 'canoe', 'canvas', 'canyon', 'carbon', 'cargo',
  'carrot', 'castle', 'cedar', 'cello', 'chain', 'chalk', 'chapel', 'cheese', 'cherry', 'chess', 'chime', 'cider', 'cinder', 'circle', 'citrus', 'claw',
  'clay', 'cliff', 'clock', 'cloud', 'clover', 'coast', 'cobalt', 'cocoa', 'coffee', 'comet', 'compass', 'copper', 'coral', 'cotton', 'cradle', 'crane',
  'crater', 'cream', 'creek', 'crest', 'cricket', 'crown', 'crumb', 'crystal', 'cube', 'cumin', 'curtain', 'cushion', 'cycle', 'daisy', 'dance', 'dawn',
  'delta', 'denim', 'desert', 'dial', 'diamond', 'dinghy', 'dollar', 'dome', 'donkey', 'dragon', 'drum', 'dune', 'dusk', 'eagle', 'earth', 'easel',
  'echo', 'eclipse', 'elbow', 'elder', 'elm', 'ember', 'emerald', 'engine', 'envelope', 'falcon', 'farm', 'feather', 'fence', 'fennel', 'ferry', 'fiddle',
  'field', 'fig', 'finch', 'fjord', 'flame', 'flask', 'fleet', 'flint', 'flute', 'forest', 'fossil', 'fox', 'frost', 'galaxy', 'garden', 'garlic',
  'gazelle', 'gecko', 'geyser', 'ginger', 'glacier', 'globe', 'glove', 'goose', 'granite', 'grape', 'gravel', 'grove', 'guitar', 'hammer', 'harbor', 'harp',
  'harvest', 'hazel', 'heron', 'hill', 'honey', 'horizon', 'hummus', 'ice', 'igloo', 'indigo', 'ink', 'iris', 'iron', 'island', 'ivory', 'ivy',
  'jade', 'jasmine', 'jelly', 'jewel', 'jungle', 'kayak', 'kettle', 'kiwi', 'knot', 'ladder', 'lagoon', 'lantern', 'lava', 'leaf', 'lemon', 'lily',
  'linen', 'lion', 'lotus', 'lumber', 'lunar', 'magnet', 'maple', 'marble', 'meadow', 'melon', 'meteor', 'mint', 'mirror', 'moss', 'motor', 'nectar',
  'needle', 'nickel', 'north', 'oak', 'oasis', 'ocean', 'olive', 'onion', 'opal', 'orbit', 'orchid', 'otter', 'oxygen', 'paddle', 'palm', 'panda',
]);

function isKeyObject(v) {
  return v !== null && typeof v === 'object' && typeof v.export === 'function' && typeof v.type === 'string';
}

/** A public key as node accepts it: a KeyObject, a PEM string, or the raw base64 form this module exports. */
export function toPublicKeyObject(value) {
  if (isKeyObject(value)) return value.type === 'private' ? createPublicKey(value) : value;
  if (typeof value !== 'string' || !value) throw new TypeError('a public key is a KeyObject, a PEM string or 44 base64 characters');
  if (PUBLIC_KEY_RE.test(value)) return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(value, 'base64').toString('base64url') }, format: 'jwk' });
  return createPublicKey(value);
}

/** A private key as node accepts it: a KeyObject, a PKCS8 PEM string, or {privateKey}. */
export function toPrivateKeyObject(value) {
  if (isKeyObject(value)) return value;
  if (value && typeof value === 'object' && value.privateKey !== undefined) return toPrivateKeyObject(value.privateKey);
  if (typeof value !== 'string' || !value) throw new TypeError('a private key is a KeyObject or a PKCS8 PEM string');
  return createPrivateKey(value);
}

/** The raw 32-byte public key, standard base64 — the form stored in people.json and fingerprinted. */
export function publicKeyBase64(key) {
  const pub = toPublicKeyObject(key);
  return Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

function pairFrom(privateKey) {
  return { publicKey: publicKeyBase64(privateKey), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** A fresh ed25519 pair: {publicKey: base64 (44 chars), privateKey: PKCS8 PEM}. */
export function generateKeyPair() {
  return pairFrom(generateKeyPairSync(ALG).privateKey);
}

/** The pair derived from a 32-byte seed (a Buffer, or any string hashed with sha256): tests and examples regenerate keys from it. */
export function keyFromSeed(seed) {
  const bytes = seed instanceof Uint8Array && seed.length === 32 ? Buffer.from(seed) : createHash('sha256').update(String(seed), 'utf8').digest();
  return pairFrom(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: 'der', type: 'pkcs8' }));
}

/** The object without its signature block: exactly the bytes that are signed. */
export function unsigned(obj) {
  const copy = { ...(obj && typeof obj === 'object' ? obj : {}) };
  delete copy.signature;
  return copy;
}

/** sign(obj, privateKey, keyId) -> {alg, key_id, signed, sig}: ed25519 over canonical(obj minus signature). */
export function sign(obj, privateKey, keyId) {
  if (typeof keyId !== 'string' || !keyId) throw new TypeError('sign needs the key_id the receiver pinned');
  const sig = cryptoSign(null, Buffer.from(canonical(unsigned(obj)), 'utf8'), toPrivateKeyObject(privateKey));
  return { alg: ALG, key_id: keyId, signed: SIGNED_STATEMENT, sig: sig.toString('base64') };
}

/** verify(obj, sig, publicKey) -> boolean; `sig` is a signature block or its base64; never throws. */
export function verify(obj, sig, publicKey) {
  try {
    const b64 = sig && typeof sig === 'object' ? sig.sig : sig;
    if (typeof b64 !== 'string' || !b64) return false;
    if (sig && typeof sig === 'object' && sig.alg !== undefined && sig.alg !== ALG) return false;
    return cryptoVerify(null, Buffer.from(canonical(unsigned(obj)), 'utf8'), toPublicKeyObject(publicKey), Buffer.from(b64, 'base64'));
  } catch {
    return false;
  }
}

/** Eight words from WORDS indexed by the first eight bytes of sha256(raw public key); read out loud, typed into `add person --fingerprint`. */
export function fingerprint(publicKey) {
  const raw = Buffer.from(publicKeyBase64(publicKey), 'base64');
  const digest = createHash('sha256').update(raw).digest();
  return Array.from(digest.subarray(0, FINGERPRINT_WORDS), (b) => WORDS[b]).join(' ');
}

/** Lower-case words separated by single spaces, whatever punctuation or case the typist used. */
export function normalizeFingerprint(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean).join(' ');
}

export function fingerprintMatches(publicKey, words) {
  return normalizeFingerprint(words) === fingerprint(publicKey);
}

/** data/keys/<person_id>.ed25519 */
export function keyPath(dataDir, personId) {
  return join(dataDir, 'keys', `${personId}.ed25519`);
}

/** Write a private key file at mode 0600 (tmp + rename); returns the path. */
export function writeKeyFile(path, privateKeyPem) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, String(privateKeyPem), { encoding: 'utf8', mode: KEY_FILE_MODE });
  chmodSync(tmp, KEY_FILE_MODE);
  renameSync(tmp, path);
  return path;
}

/** The PEM text of a key file, or null when it does not exist. */
export function readKeyFile(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** loadKey(dataDir, personId) -> {ok: true, path, privateKey (PEM), publicKey (base64)} | {ok: false, path}. */
export function loadKey(dataDir, personId) {
  const path = keyPath(dataDir, personId);
  const pem = readKeyFile(path);
  if (pem === null) return { ok: false, path };
  try {
    return { ok: true, path, privateKey: pem, publicKey: publicKeyBase64(createPrivateKey(pem)) };
  } catch {
    return { ok: false, path };
  }
}

/** Bytes of a salt: "base64:<...>" decodes, anything else is used as UTF-8. */
export function saltBytes(salt) {
  const s = String(salt ?? '');
  return s.startsWith('base64:') ? Buffer.from(s.slice('base64:'.length), 'base64') : Buffer.from(s, 'utf8');
}

/** A person handle as stored: HMAC-SHA256 under data/keys/handle.salt; owner-only, never projected or exported. */
export function hmacHandle(salt, value) {
  return `hmac-sha256:${hmacHex(saltBytes(salt), String(value).trim().toLowerCase())}`;
}

/** The pseudonymize operator: pseu-<16 hex> of HMAC-SHA256(rule salt, value); linkable within one rule only. */
export function pseudonym(salt, value) {
  return `pseu-${hmacHex(saltBytes(salt), String(value)).slice(0, 16)}`;
}
