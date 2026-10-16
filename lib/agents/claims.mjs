// Claims out of a synthesis text (VISION 7.4): one claim per line that cites
// at least one node id in square brackets; in a --between / --with run a
// claim must cite ids from both sides or it is dropped
// (DF_RUN_CLAIM_WITHOUT_EVIDENCE). Claim text carries no fence and no raw
// foreign value: fences become markers, raw values are scrubbed. Pure.
import { fail, pass } from '../rules.mjs';
import { scrub, stripFences, stripControl } from './fence.mjs';

export const MAX_CLAIMS = 32;
export const MAX_CLAIM_CHARS = 1000;
export const MAX_EVIDENCE = 64;
const ID_RE = /\[([a-z0-9][a-z0-9_.:-]{0,79})\]/g;
const LEAD_RE = /^\s*(?:[-*•]|\d+[.)]|evidence:)\s*/i;

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** The known node ids a line cites, in order, de-duplicated. */
export function citedIds(line, known) {
  const out = [];
  for (const m of String(line ?? '').matchAll(ID_RE)) {
    if (!known.has(m[1]) || out.includes(m[1])) continue;
    out.push(m[1]);
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

/**
 * extractClaims(text, {items, desk, crossField, foreignValues}) ->
 *   {claims:[{text, evidence_ids, desk}], dropped:{no_evidence, one_side}, checks}
 * items: the context items the desks saw (id, side); crossField: a
 * --between / --with run, where every claim needs both sides.
 */
export function extractClaims(text, { items = [], desk = 'conductor', crossField = false, foreignValues = [] } = {}) {
  const known = new Set(items.map((it) => it.id));
  const sideOf = new Map(items.map((it) => [it.id, it.side]));
  const claims = [];
  const dropped = { no_evidence: 0, one_side: 0 };
  for (const rawLine of String(text ?? '').split('\n')) {
    if (claims.length >= MAX_CLAIMS) break;
    const ids = citedIds(rawLine, known);
    if (!ids.length) { if (rawLine.trim()) dropped.no_evidence += 1; continue; }
    if (crossField && new Set(ids.map((i) => sideOf.get(i))).size < 2) { dropped.one_side += 1; continue; }
    const body = stripControl(scrub(stripFences(rawLine), foreignValues)).replace(LEAD_RE, '').trim();
    if (!body) continue;
    claims.push({ text: clip(body, MAX_CLAIM_CHARS), evidence_ids: ids, desk });
  }
  const checks = [];
  if (crossField && !claims.length) {
    checks.push(fail('DF_RUN_CLAIM_WITHOUT_EVIDENCE', { path: '$.proposal.claims', detail: `no synthesis line cites node ids from both sides (${dropped.one_side} one-sided, ${dropped.no_evidence} without evidence)` }));
  } else checks.push(pass('DF_RUN_CLAIM_WITHOUT_EVIDENCE'));
  return { claims, dropped, checks };
}

/** Every evidence id any claim cites, sorted and unique. */
export function evidenceOf(claims) {
  return [...new Set(claims.flatMap((c) => c.evidence_ids))].sort();
}
