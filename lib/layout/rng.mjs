// The one source of randomness under lib/: a seeded mulberry32 stream.
// Nothing in the engine draws from the host's random source; a layout seeded with
// views.2d.seed produces the same positions on every run and every Node
// version (integer arithmetic only, no transcendental functions).
//
//   mulberry32(seed) -> next(): number in [0, 1)
//   hashString(s)    -> uint32 (FNV-1a) — folds an id to a seed or a slot
//   seedFrom(...parts) -> uint32 combining numbers and strings deterministically

/** The mulberry32 increment (0x6D2B79F5) written in decimal. */
export const MULBERRY_INC = 1831565813;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const TWO_32 = 4294967296;

function toUint32(v) {
  if (typeof v === 'string') return hashString(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(Math.abs(n)) >>> 0;
}

/** A seeded PRNG stream; the same seed always yields the same sequence. */
export function mulberry32(seed) {
  let a = toUint32(seed);
  return function next() {
    a = (a + MULBERRY_INC) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_32;
  };
}

/** FNV-1a over the UTF-16 code units of a string; a uint32. */
export function hashString(s) {
  const str = String(s);
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** One uint32 from several numbers and strings, order-sensitive. */
export function seedFrom(...parts) {
  let h = FNV_OFFSET;
  for (const p of parts) {
    h ^= toUint32(p);
    h = Math.imul(h, FNV_PRIME);
    h ^= h >>> 13;
  }
  return h >>> 0;
}
