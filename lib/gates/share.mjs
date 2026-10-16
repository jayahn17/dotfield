// Gate "share": the DF_SHARE_* family over a share rule or an emitted
// projection. One check per catalog code (pass, or one fail per offending
// path), never throws. The refusals themselves live in lib/share.mjs
// (ruleChecks / projectionChecks) so the projector and this gate can never
// disagree; `share project` runs schema -> share -> receipt through them.
//
//   check(doc, ctx) -> check[]
//   doc           a share rule (schema_version dotfield.share-rule/1) or a
//                 projection (dotfield.projection/1)
//   ctx.rooms     discovered rooms: fields_allowed is checked against each
//                 selected room's public_fields (FIELD/LABEL/TAG_NOT_PUBLIC)
//   ctx.people, ctx.circles   center/people: RECEIVER_UNKNOWN
//   ctx.nodes     the grantor's projected nodes: sensitive-without-operators,
//                 ceiling, re-share and derived re-share refusals per node,
//                 NOTHING_SELECTED when none matches
//   ctx.grants    rule_ref -> {re_share} for nodes that arrived through overlays
//   ctx.hasKey    false -> KEY_MISSING
//   ctx.rule      for a projection: the rule it was emitted under
//   ctx.now       the clock (ctx.now of the command); expiry is judged against it
import { codesForFamily, pass } from '../rules.mjs';
import { PROJECTION_SCHEMA_VERSION, RULE_SCHEMA_VERSION, projectionChecks, ruleChecks } from '../share.mjs';

export const id = 'share';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Which document shape `doc` is: 'rule', 'projection', or null. */
export function kindOf(doc) {
  if (!isObject(doc)) return null;
  if (doc.schema_version === PROJECTION_SCHEMA_VERSION) return 'projection';
  if (doc.schema_version === RULE_SCHEMA_VERSION || isObject(doc.subject)) return 'rule';
  return null;
}

/** Gate entry. */
export function check(doc, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  let fails = [];
  try {
    const kind = kindOf(doc);
    if (kind === 'projection') fails = projectionChecks(doc, c);
    else fails = ruleChecks(isObject(doc) ? doc : {}, c);
  } catch (e) {
    // Unreachable by design (every input shape is guarded); reported, never thrown.
    fails = [{ code: 'DF_SHARE_RULE_NOT_FOUND', gate: id, blocking: true, status: 'fail', path: '$', message: `share gate stopped: ${e && e.message ? e.message : String(e)}`, repair: 'Pass a share rule or a projection document.' }];
  }
  const codes = codesForFamily('share');
  const out = [];
  for (const code of codes) {
    const f = fails.filter((x) => x.code === code);
    out.push(...(f.length ? f : [pass(code)]));
  }
  return [...out, ...fails.filter((x) => !codes.includes(x.code))];
}
