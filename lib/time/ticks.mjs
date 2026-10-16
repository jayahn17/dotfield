// UTC integer day arithmetic on ISO dates (YYYY-MM-DD) for the one playhead
// (V2_PLAN §5). Pure integer maths, no Date object anywhere: a day index is
// the count of days since 1970-01-01 (proleptic Gregorian), so two renders of
// one scene agree on every tick whatever the host clock or zone says.
// Months and years step by calendar fields with the day clamped to the target
// month's length: 2026-01-31 + 1 month = 2026-02-28, 2024-02-29 + 1 year =
// 2025-02-28, 2024-01-31 + 1 month = 2024-02-29. renderers/viewer/time.js
// mirrors every export; test/time.test.js deep-equals the two.

/** Steps that walk a date axis in calendar units; `event` and `beat` are value steps and leave a date unchanged. */
export const CALENDAR_STEPS = Object.freeze(['day', 'week', 'month', 'year']);

const ISO_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const floor = Math.floor;
const pad = (n, w) => String(n).padStart(w, '0');

/** Days in month `m` (1..12) of year `y`, leap years included. */
export function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** [y, m, d] for a real calendar date in YYYY-MM-DD form; null for anything else (2026-13-40, 2026-02-30, 12, null). */
export function parseIso(v) {
  const m = typeof v === 'string' ? ISO_RE.exec(v) : null;
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return [y, mo, d];
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(v) {
  return parseIso(v) !== null;
}

/** [y, m, d] -> YYYY-MM-DD. */
export function formatIso(y, m, d) {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Days since 1970-01-01 for a real ISO date (civil -> days, proleptic Gregorian); null for an invalid one. */
export function dayIndex(isoDate) {
  const p = parseIso(isoDate);
  if (!p) return null;
  const [y0, m, d] = p;
  const y = m <= 2 ? y0 - 1 : y0;
  const era = floor(y / 400);
  const yoe = y - era * 400;
  const doy = floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The ISO date `n` days after 1970-01-01 (days -> civil); null unless `n` is an integer. */
export function fromDayIndex(n) {
  if (!Number.isInteger(n)) return null;
  const z = n + 719468;
  const era = floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = floor((doe - floor(doe / 1460) + floor(doe / 36524) - floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + floor(yoe / 4) - floor(yoe / 100));
  const mp = floor((5 * doy + 2) / 153);
  const d = doy - floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return formatIso(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
}

/** Add `k` calendar months to [y, m, d], clamping the day to the target month. */
function addMonths(y, m, d, k) {
  const total = y * 12 + (m - 1) + k;
  const y2 = floor(total / 12); const m2 = total - y2 * 12 + 1;
  return [y2, m2, Math.min(d, daysInMonth(y2, m2))];
}

/**
 * addStep(isoDate, step, k = 1) -> isoDate: `k` steps (negative allowed) along
 * day|week|month|year. month and year move the calendar field and clamp the day;
 * any other step (event, beat, unknown) returns the date unchanged. null for an invalid date.
 */
export function addStep(isoDate, step, k = 1) {
  const p = parseIso(isoDate);
  if (!p || !Number.isInteger(k)) return p ? isoDate : null;
  if (step === 'day') return fromDayIndex(dayIndex(isoDate) + k);
  if (step === 'week') return fromDayIndex(dayIndex(isoDate) + 7 * k);
  if (step === 'month') return formatIso(...addMonths(p[0], p[1], p[2], k));
  if (step === 'year') return formatIso(...addMonths(p[0], p[1], p[2], 12 * k));
  return isoDate;
}

/**
 * floorToStep(isoDate, step) -> isoDate: the start of the step holding the date —
 * day: itself; week: its Monday; month: the 1st; year: January 1st. Other steps
 * return the date unchanged. null for an invalid date.
 */
export function floorToStep(isoDate, step) {
  const p = parseIso(isoDate);
  if (!p) return null;
  if (step === 'week') { const n = dayIndex(isoDate); return fromDayIndex(n - (((n + 3) % 7) + 7) % 7); }
  if (step === 'month') return formatIso(p[0], p[1], 1);
  if (step === 'year') return formatIso(p[0], 1, 1);
  return isoDate;
}
