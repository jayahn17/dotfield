// The one privacy-level constant that the wall (server/wall.mjs) and the
// projector (lib/share.mjs) share; test/wall-share-agreement.test.js fails if
// either side defines its own. Levels run from most open to most closed.
export const LEVELS = Object.freeze(['public', 'private', 'sensitive', 'blocked']);

/** Every node is born with this level (VISION §2.7: default is none). */
export const DEFAULT_LEVEL = 'private';

/** Levels that never leave the machine without an active share rule. */
export const PRIVATE_SET = Object.freeze(new Set(['private', 'sensitive', 'blocked']));

/** Levels that a share rule can only project with redaction operators. */
export const OPERATORS_REQUIRED_SET = Object.freeze(new Set(['sensitive']));

/** Levels no rule, ceiling or operator can ever project. */
export const NEVER_LEAVES_SET = Object.freeze(new Set(['blocked']));

export function isLevel(value) {
  return typeof value === 'string' && LEVELS.includes(value);
}

/** Position in LEVELS (0 = public), or -1 for an unknown level. */
export function rank(level) {
  return LEVELS.indexOf(level);
}

export function isPrivate(level) {
  return PRIVATE_SET.has(level);
}

export function requiresOperators(level) {
  return OPERATORS_REQUIRED_SET.has(level);
}

/**
 * True when a node at `level` may be projected under a rule whose
 * redaction.privacy_level_ceiling is `ceiling`: the level must be at or
 * below the ceiling, both must be real levels, and a blocked node is never
 * admitted whatever the ceiling says.
 */
export function atOrBelow(level, ceiling) {
  if (!isLevel(level) || !isLevel(ceiling)) return false;
  if (NEVER_LEAVES_SET.has(level)) return false;
  return rank(level) <= rank(ceiling);
}

/** The more closed of two levels; unknown values count as blocked. */
export function mostPrivate(a, b) {
  const ra = isLevel(a) ? rank(a) : LEVELS.length - 1;
  const rb = isLevel(b) ? rank(b) : LEVELS.length - 1;
  return LEVELS[Math.max(ra, rb)];
}
