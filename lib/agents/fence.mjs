// Structural fences for foreign-owned content (VISION 7.4): every value a
// provider sees that another person owns is wrapped as
// <foreign person=".." rule="..">..</foreign>, control characters stripped,
// each span capped at FENCE_CAP characters, and a value can never close its
// own fence. The system prompt names the fence as data, not instruction;
// DF_RUN_FOREIGN_UNFENCED fires when a raw foreign value escapes.
import { canonical, sha256 } from '../digest.mjs';

export const FENCE_CAP = 512;
export const FENCE_TAG = 'foreign';
const ATTR_RE = /[^a-z0-9_.:/-]/g;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g;
const FENCE_RE = /<foreign person="([^"]*)" rule="([^"]*)">([\s\S]*?)<\/foreign>/g;
const CLOSE_RE = /<(\/?)(foreign)\b/gi;

/** Remove C0/C1 controls (newline and tab kept), zero-width and bidi overrides. */
export function stripControl(text) {
  return String(text ?? '').replace(CONTROL_RE, '');
}

/** One printable string for any JSON value: strings as-is, arrays joined, objects canonical. */
export function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(', ');
  return canonical(value);
}

function attr(v, fallback) {
  const s = String(v ?? '').toLowerCase().replace(ATTR_RE, '-');
  return s || fallback;
}

/** A foreign span's body: controls stripped, fence sequences neutralised, capped. */
export function fenceBody(value) {
  return stripControl(textOf(value)).replace(CLOSE_RE, '&lt;$1$2').slice(0, FENCE_CAP);
}

/**
 * fence(value, {person, rule}) -> '<foreign person="ada" rule="ada/rule-01">…</foreign>'
 * person: the grantor's person_id; rule: the rule_ref the value crossed under.
 */
export function fence(value, { person, rule } = {}) {
  const p = attr(person, 'unknown');
  const r = attr(rule, `${p}/none`);
  return `<${FENCE_TAG} person="${p}" rule="${r}">${fenceBody(value)}</${FENCE_TAG}>`;
}

/** Close any fence a provider left open (a response clipped mid-span), so the span never leaks into the next prompt. */
export function closeFences(text) {
  const s = String(text ?? '');
  const opened = (s.match(/<foreign person="[^"]*" rule="[^"]*">/g) || []).length;
  const closed = (s.match(/<\/foreign>/g) || []).length;
  return opened > closed ? `${s}${'</foreign>'.repeat(opened - closed)}` : s;
}

/** Every fenced span in a prompt or a response: [{person_id, rule_ref, text}] (the proposal summary shape). */
export function fencedSpans(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(FENCE_RE)) out.push({ person_id: m[1], rule_ref: m[2], text: m[3] });
  return out;
}

/** The text with every fenced span replaced by a marker: what synthesis may carry into a proposal. */
export function stripFences(text, marker = (s) => `[foreign ${s.person_id} ${s.rule_ref}]`) {
  return String(text ?? '').replace(FENCE_RE, (_, person_id, rule_ref) => marker({ person_id, rule_ref }));
}

/** The text with fences removed entirely (bodies dropped), for escape checks. */
export function withoutFences(text) {
  return String(text ?? '').replace(FENCE_RE, ' ');
}

/**
 * escapes(text, values) -> the raw foreign values (length >= minLength) that
 * appear in `text` outside every fence. An empty array means nothing leaked.
 */
export function escapes(text, values, { minLength = 4 } = {}) {
  const bare = withoutFences(text).toLowerCase();
  const out = [];
  for (const v of values) {
    const s = stripControl(textOf(v)).trim().toLowerCase();
    if (s.length < minLength) continue;
    if (bare.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Replace every case-insensitive occurrence of needle in text with marker (plain scan, no regex). */
function replaceAllFold(text, needle, marker) {
  const low = text.toLowerCase();
  const n = needle.toLowerCase();
  let from = 0;
  let out = '';
  for (;;) {
    const i = low.indexOf(n, from);
    if (i < 0) return out + text.slice(from);
    out += text.slice(from, i) + marker;
    from = i + n.length;
  }
}

/** Remove every raw foreign value from a text (case-insensitive), replacing it with a marker. */
export function scrub(text, values, marker = '[foreign span removed]') {
  let out = String(text ?? '');
  const sorted = [...new Set(values.map((v) => stripControl(textOf(v)).trim()).filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  for (const s of sorted) out = replaceAllFold(out, s, marker);
  return out;
}

/** sha256 of the canonical span list, or null when there are none (the receipt's foreign_spans_digest). */
export function spansDigest(spans) {
  return Array.isArray(spans) && spans.length ? sha256(canonical(spans)) : null;
}
