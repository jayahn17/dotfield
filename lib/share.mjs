// The outbound half of sharing (VISION §7.1, §7.2, §7.5): share-rule state
// and selection, evaluate() (refuses rather than filters silently), the
// redaction operators, envelope() (exactly fields_allowed plus a fixed
// metadata set), the pure check lists lib/gates/share.mjs wraps, and
// emitProjection(), which signs and writes data/projections/out/ for an
// active rule and nothing for any other state. The private set and the
// ceiling test come from lib/privacy-levels.mjs, the same constant
// server/wall.mjs reads. No clock: callers pass ctx.now.
import { join, relative, resolve, sep } from 'node:path';
import { canonical, sha256, shortDigest } from './digest.mjs';
import { NEVER_LEAVES_SET, PRIVATE_SET, atOrBelow, isLevel, requiresOperators } from './privacy-levels.mjs';
import { buildReceipt, compactStamp, inlineInput, isoSeconds, receiptId, refDigest } from './receipt.mjs';
import { schemaChecks, writeJsonAtomic } from './rooms.mjs';
import { fail } from './rules.mjs';
import { pseudonym, sign } from './sign.mjs';
import { isDate, loadSchema, validate } from './validate.mjs';

export const RULE_SCHEMA_VERSION = 'dotfield.share-rule/1';
export const PROJECTION_SCHEMA_VERSION = 'dotfield.projection/1';
export const RELEASE_TAG = 'v1.1-provisional';
export const OPERATORS = Object.freeze(['replace', 'redact', 'mask', 'pseudonymize', 'keep_private']);
export const STATES = Object.freeze(['draft', 'awaiting_owner', 'active', 'revoked', 'expired']);
/** The one private set, shared with server/wall.mjs through lib/privacy-levels.mjs. */
export const PRIVATE_LEVELS = PRIVATE_SET;
export const WITHHELD = '[withheld]';
export const REDACTED = '[redacted]';
export const STUB_RE = /^[a-z0-9][a-z0-9_-]{0,39} · [0-9a-f]{6}$/;
const posix = (p) => p.split(sep).join('/');
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => ([...String(s)].length > n ? [...String(s)].slice(0, n).join('') : String(s));

export function today(now) { return isoSeconds(now).slice(0, 10); }
export function manifestOf(room) { return room && room.manifest ? room.manifest : room; }
export function findRoom(rooms, id) {
  const arr = rooms instanceof Map ? [...rooms.values()] : Array.isArray(rooms) ? rooms : isObject(rooms) ? (Array.isArray(rooms.rooms) ? rooms.rooms : Object.values(rooms)) : [];
  return arr.find((r) => r && (r.id === id || (r.manifest && r.manifest.id === id))) ?? null;
}
export function ruleRef(rule) { return `${rule.grantor_person_id}/${rule.rule_id}`; }
export function namespaced(grantor, id) { return `person-${grantor}-${id}`; }
export function stubLabel(room, digest) { return `${room} · ${shortDigest(digest)}`; }
export function levelOf(node) { const l = isObject(node) && isObject(node.audience) ? node.audience.privacy_level : undefined; return isLevel(l) ? l : 'private'; }

/** The effective state: 'expired' once dates.expires_on is behind `now`, else rule.state. */
export function ruleState(rule, now) {
  if (!isObject(rule)) return 'draft';
  const exp = isObject(rule.dates) ? rule.dates.expires_on : null;
  if (rule.state === 'active' && typeof exp === 'string' && now !== undefined && exp < today(now)) return 'expired';
  return rule.state;
}
export function isActive(rule, now) { return ruleState(rule, now) === 'active'; }

/** Member ids of a circle that have not expired at `now`. */
export function circleMembers(circle, now) {
  const day = now === undefined ? null : today(now);
  return list(circle && circle.members).filter((m) => m && typeof m.person_id === 'string' && !(day && typeof m.expires_on === 'string' && m.expires_on < day)).map((m) => m.person_id);
}
/** Every person a rule addresses: the person, or the live members of the circle (unknown circle -> []). */
export function receiverIds(rule, circles = [], now) {
  const r = isObject(rule) && isObject(rule.receiver) ? rule.receiver : {};
  if (r.type === 'person') return typeof r.id === 'string' ? [r.id] : [];
  const circle = list(circles).find((c) => c && c.circle_id === r.id);
  return circle ? [...new Set(circleMembers(circle, now))] : [];
}
export function receives(rule, viewerId, circles = [], now) { return receiverIds(rule, circles, now).includes(viewerId); }

/** Does the selector pick this node? Listed ids always; otherwise room (required) + tags (any) + kinds. */
export function selects(rule, node) {
  if (!isObject(rule) || !isObject(rule.subject) || !isObject(rule.subject.selector) || !isObject(node)) return false;
  const sel = rule.subject.selector;
  if (list(sel.ids).includes(node.id)) return true;
  if (!list(sel.rooms).includes(node.room)) return false;
  if (Array.isArray(sel.kinds) && !sel.kinds.includes(node.kind)) return false;
  if (Array.isArray(sel.tags) && sel.tags.length && !list(node.tags).some((t) => sel.tags.includes(t))) return false;
  return true;
}

function maskValue(v) {
  if (typeof v === 'string') { const cs = [...v]; return cs.length ? cs[0] + '*'.repeat(Math.min(7, Math.max(1, cs.length - 1))) : v; }
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return Number(v.toPrecision(1));
  return v;
}
function opOne(v, op, salt) {
  switch (op) {
    case 'pseudonymize': return typeof v === 'string' ? pseudonym(salt, v) : v;
    case 'mask': return maskValue(v);
    case 'redact': return typeof v === 'string' ? REDACTED : v;
    case 'replace': return WITHHELD;
    default: return v;
  }
}
/** Apply the operators in order to one value (arrays element-wise); keep_private transforms nothing. */
export function applyOperators(value, operators, salt) {
  let out = value;
  for (const op of list(operators)) out = Array.isArray(out) && op !== 'replace' ? out.map((x) => opOne(x, op, salt)) : opOne(out, op, salt);
  return out;
}
/** fields restricted to fields_allowed (in that order); operators run only when the level requires them (sensitive). */
export function redactFields(fields, rule, level) {
  const red = isObject(rule.redaction) ? rule.redaction : {};
  const src = isObject(fields) ? fields : {};
  const out = {};
  for (const f of list(red.fields_allowed)) {
    if (!Object.hasOwn(src, f)) continue;
    out[f] = requiresOperators(level) ? applyOperators(src[f], red.operators, red.salt) : src[f];
  }
  return out;
}
export function redact(node, rule) { return { ...node, fields: redactFields(node.fields, rule, levelOf(node)) }; }

function tagsOf(v) { return list(Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v])).filter((t) => typeof t === 'string' && t.length).map((t) => clip(t, 40)).slice(0, 32); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'; }

/** Discipline groups a node may carry: labels from ctx.disciplines whose patterns match an EMITTED tag only. */
export function disciplineGroups(tags, disciplines, grantor) {
  const out = [];
  for (const d of list(disciplines)) {
    if (!d || typeof d.label !== 'string') continue;
    const hit = list(d.patterns).some((p) => typeof p === 'string' && tags.some((t) => t.toLowerCase().includes(p.toLowerCase())));
    if (hit) out.push({ id: namespaced(grantor, `g-${slug(d.label)}`), label: clip(d.label, 120), kind: 'discipline' });
  }
  return out;
}

/**
 * envelope(node, rule, room, ctx) -> overlay node: exactly fields_allowed plus
 * the fixed metadata set. ctx = {now, keyId, projectionId, disciplines}.
 * The source digest is sha256 of the projected subset plus the rule salt,
 * never of the private record.
 */
export function envelope(node, rule, room, ctx = {}) {
  const rec = isObject(manifestOf(room)) && isObject(manifestOf(room).record) ? manifestOf(room).record : {};
  const allowed = list(rule.redaction && rule.redaction.fields_allowed);
  const level = levelOf(node);
  const fields = redactFields(node.fields, rule, level);
  const digest = sha256(canonical({ fields, salt: rule.redaction.salt }));
  const ref = ruleRef(rule);
  const released = today(ctx.now);
  const grantor = rule.grantor_person_id;
  const roomId = typeof node.room === 'string' ? node.room : (manifestOf(room) && manifestOf(room).id) || 'node';
  const out = { id: namespaced(grantor, node.id), kind: 'boundary' };
  const labelOk = allowed.includes(rec.label_field) && fields[rec.label_field] !== undefined && fields[rec.label_field] !== null && String(fields[rec.label_field]).length;
  out.label = labelOk ? clip(fields[rec.label_field], 120) : stubLabel(roomId, digest);
  if (rec.sublabel_field && allowed.includes(rec.sublabel_field) && fields[rec.sublabel_field] !== undefined && fields[rec.sublabel_field] !== null) out.sublabel = clip(fields[rec.sublabel_field], 200);
  out.tags = rec.tag_field && allowed.includes(rec.tag_field) ? tagsOf(fields[rec.tag_field]) : [];
  const groups = disciplineGroups(out.tags, ctx.disciplines, grantor);
  if (groups.length) out.group = groups[0].id;
  out.fields = fields;
  const captured = isObject(node.provenance) && isDate(node.provenance.captured_on) ? node.provenance.captured_on : released;
  out.provenance = { owner_person_id: grantor, source: { kind: 'share', ref: ctx.projectionId ?? ref, digest }, captured_on: captured };
  for (const [k, f] of Object.entries(isObject(rec.dates) ? rec.dates : {})) if (k !== 'released_on' && allowed.includes(f) && isDate(fields[f])) out.provenance[k] = fields[f];
  out.provenance.released_on = released;
  out.provenance.imported_via_rule_ref = ref;
  out.audience = { privacy_level: level, share_rule_ids: [rule.rule_id] };
  out.boundary = { rule_ref: ref, digest, shared_by: grantor, released_on: released, key_id: ctx.keyId ?? `${grantor}-k1` };
  if (typeof rule.dates.expires_on === 'string') out.boundary.expires_on = rule.dates.expires_on;
  return { node: out, groups };
}

function grantOf(grants, ref) {
  if (!grants || typeof ref !== 'string') return null;
  return grants instanceof Map ? grants.get(ref) ?? null : isObject(grants) && isObject(grants[ref]) ? grants[ref] : null;
}

/**
 * evaluate(rule, viewer, node, ctx) -> {allow, code, reason, operators}.
 * ctx = {now, circles, grants (rule_ref -> {re_share, person_id, key_id} for
 * nodes that arrived through overlays)}. `code` is the DF_SHARE_* refusal, or
 * null when the node is simply not selected or not addressed to the viewer.
 */
export function evaluate(rule, viewer, node, ctx = {}) {
  const viewerId = typeof viewer === 'string' ? viewer : viewer && viewer.person_id;
  const no = (code, reason) => ({ allow: false, code, reason, operators: [] });
  if (!selects(rule, node)) return no(null, 'not selected by subject.selector');
  const state = ruleState(rule, ctx.now);
  if (state === 'expired') return no('DF_SHARE_RULE_EXPIRED', `expires_on ${rule.dates.expires_on} is past`);
  if (state !== 'active') return no('DF_SHARE_RULE_NOT_ACTIVE', `state is ${state}`);
  if (rule.switches.aggregate === true || rule.switches.train === true) return no('DF_SHARE_SWITCH_UNSUPPORTED', 'aggregate or train is true');
  if (!receives(rule, viewerId, ctx.circles, ctx.now)) return no(null, `'${String(viewerId)}' is not the receiver of ${ruleRef(rule)}`);
  const level = levelOf(node);
  if (NEVER_LEAVES_SET.has(level)) return no('DF_SHARE_CEILING_EXCEEDED', `'${node.id}' is blocked and never leaves`);
  if (!atOrBelow(level, rule.redaction.privacy_level_ceiling)) return no('DF_SHARE_CEILING_EXCEEDED', `'${node.id}' is ${level}, ceiling ${rule.redaction.privacy_level_ceiling}`);
  if (requiresOperators(level) && !list(rule.redaction.operators).length) return no('DF_SHARE_SENSITIVE_WITHOUT_OPERATORS', `'${node.id}' is sensitive and the rule has no operators`);
  const prov = isObject(node.provenance) ? node.provenance : {};
  if (typeof prov.owner_person_id === 'string' && prov.owner_person_id !== rule.grantor_person_id && prov.owner_person_id !== viewerId) {
    const origin = isObject(node.boundary) && node.boundary.rule_ref ? node.boundary.rule_ref : prov.imported_via_rule_ref;
    const g = grantOf(ctx.grants, origin);
    if (!g || g.re_share !== true) return no('DF_SHARE_RESHARE_BLOCKED', `'${node.id}' came from ${String(origin)} ${g ? 'with re_share false' : 'with no recorded grant'}`);
  }
  for (const d of list(prov.derived_from)) {
    if (!isObject(d) || d.person_id === viewerId) continue;
    const g = grantOf(ctx.grants, d.rule_ref);
    if (!g || g.re_share !== true) return no('DF_SHARE_DERIVED_RESHARE_BLOCKED', `'${node.id}' derives from ${String(d.rule_ref)} and '${String(viewerId)}' is not that grantor`);
  }
  return { allow: true, code: null, reason: `granted by ${ruleRef(rule)}`, operators: requiresOperators(level) ? [...list(rule.redaction.operators)] : [] };
}

/** rule_refs of this grantor's revoked rules that addressed `receiverId`: the next projection carries them. */
export function revokedRefs(rules, grantor, receiverId, circles = [], now) {
  return list(rules).filter((r) => isObject(r) && r.grantor_person_id === grantor && r.state === 'revoked' && receives(r, receiverId, circles, now)).map(ruleRef).sort();
}

/** Rule-level and node-level refusals as fail findings (no passes); ctx = {rooms, people, circles, nodes, grants, now, hasKey}. */
export function ruleChecks(rule, ctx = {}) {
  const out = schemaChecks(validate(loadSchema('share-rule'), rule).errors, 'share-rule');
  if (out.length) return out;
  const F = (code, path, detail) => out.push(fail(code, { path, detail }));
  const state = ruleState(rule, ctx.now);
  if (state === 'expired') F('DF_SHARE_RULE_EXPIRED', '$.dates.expires_on', `${rule.dates.expires_on} is past`);
  else if (state !== 'active') F('DF_SHARE_RULE_NOT_ACTIVE', '$.state', `state is ${state}`);
  if (rule.switches.aggregate === true) F('DF_SHARE_SWITCH_UNSUPPORTED', '$.switches.aggregate', 'true');
  if (rule.switches.train === true) F('DF_SHARE_SWITCH_UNSUPPORTED', '$.switches.train', 'true');
  if (Array.isArray(ctx.people)) {
    const known = rule.receiver.type === 'person' ? ctx.people.some((p) => p && p.person_id === rule.receiver.id) : list(ctx.circles).some((c) => c && c.circle_id === rule.receiver.id);
    if (!known) F('DF_SHARE_RECEIVER_UNKNOWN', '$.receiver.id', `${rule.receiver.type} '${rule.receiver.id}'`);
  }
  if (ctx.rooms !== undefined && ctx.rooms !== null) {
    rule.subject.selector.rooms.forEach((rid, i) => {
      const room = findRoom(ctx.rooms, rid);
      if (!room) { F('DF_SHARE_ROOM_UNKNOWN', `$.subject.selector.rooms[${i}]`, `'${rid}'`); return; }
      const rec = manifestOf(room).record || {};
      const pub = list(rec.public_fields);
      rule.redaction.fields_allowed.forEach((f, j) => {
        if (pub.includes(f)) return;
        const code = f === rec.label_field ? 'DF_SHARE_LABEL_NOT_PUBLIC' : f === rec.tag_field ? 'DF_SHARE_TAG_NOT_PUBLIC' : 'DF_SHARE_FIELD_NOT_PUBLIC';
        F(code, `$.redaction.fields_allowed[${j}]`, `'${f}' is not in room '${rid}' public_fields (${pub.join(', ') || 'none'})`);
      });
    });
  }
  if (ctx.hasKey === false) F('DF_SHARE_KEY_MISSING', '$.grantor_person_id', `no data/keys/${rule.grantor_person_id}.ed25519`);
  if (Array.isArray(ctx.nodes)) {
    const selected = ctx.nodes.map((n, i) => [n, i]).filter(([n]) => selects(rule, n));
    if (!selected.length) F('DF_SHARE_NOTHING_SELECTED', '$.subject.selector', 'no node matched');
    if (!out.some((c) => /RULE_NOT_ACTIVE|RULE_EXPIRED|SWITCH_UNSUPPORTED/.test(c.code))) {
      const seen = new Set();
      for (const rid of receiverIds(rule, ctx.circles, ctx.now)) {
        for (const [n, i] of selected) {
          const r = evaluate(rule, rid, n, ctx);
          if (r.code && !seen.has(`${r.code}:${i}`)) { seen.add(`${r.code}:${i}`); F(r.code, `$.nodes[${i}]`, r.reason); }
        }
      }
    }
  }
  return out;
}

/** Envelope-level refusals over an emitted projection (defence in depth); ctx = {rule, rooms, now}. */
export function projectionChecks(projection, ctx = {}) {
  const out = schemaChecks(validate(loadSchema('projection'), projection).errors, 'projection');
  if (out.length) return out;
  const F = (code, path, detail) => out.push(fail(code, { path, detail }));
  if (projection.switches.aggregate === true || projection.switches.train === true) F('DF_SHARE_SWITCH_UNSUPPORTED', '$.switches', 'aggregate or train is true');
  const rule = ctx.rule;
  if (!isObject(rule)) return out;
  if (ruleState(rule, ctx.now) !== 'active') F('DF_SHARE_RULE_NOT_ACTIVE', '$.rule_refs', `state is ${ruleState(rule, ctx.now)}`);
  const allowed = list(rule.redaction.fields_allowed);
  const recs = rule.subject.selector.rooms.map((rid) => { const r = findRoom(ctx.rooms ?? [], rid); return r ? manifestOf(r).record || {} : null; }).filter(Boolean);
  projection.overlay.nodes.forEach((n, i) => {
    const p = `$.overlay.nodes[${i}]`;
    Object.keys(n.fields).forEach((k) => { if (!allowed.includes(k)) F('DF_SHARE_FIELD_NOT_PUBLIC', `${p}.fields.${k}`, `'${k}' is outside fields_allowed`); });
    if (!recs.length) return;
    const labelOk = STUB_RE.test(n.label) || recs.some((r) => allowed.includes(r.label_field) && String(n.fields[r.label_field]) === n.label);
    if (!labelOk) F('DF_SHARE_LABEL_NOT_PUBLIC', `${p}.label`, `'${n.label}' is neither the stub nor an allowed label field`);
    const tagsOk = !n.tags.length || recs.some((r) => allowed.includes(r.tag_field) && n.tags.every((t) => tagsOf(n.fields[r.tag_field]).includes(t)));
    if (!tagsOk) F('DF_SHARE_TAG_NOT_PUBLIC', `${p}.tags`, 'tags are not drawn from an allowed tag field');
  });
  return out;
}

export function outDir(dataDir) { return join(dataDir, 'projections', 'out'); }
export function projectionFilename(receiverId, ruleId, now) { return `${receiverId}-${ruleId}-${compactStamp(now)}.json`; }
export function projectionId(grantor, receiverId, ruleId, now) { return `proj-${grantor}-to-${receiverId}-${ruleId}-${today(now).replace(/-/g, '')}`; }

/**
 * emitProjection({rule, nodes, edges, rooms, people, circles, disciplines, grants, rules, key, keyId, now, dataDir, root, argv})
 *   -> {ok, projections: [{receiver, projection, path}], paths, checks, receipt}
 * Writes data/projections/out/<receiver>-<rule>-<ts>.json for an active rule
 * and nothing otherwise; a circle receiver gets one signed file per member.
 */
export async function emitProjection({ rule, nodes = [], edges = [], rooms = [], people = null, circles = [], disciplines = [], grants = null, rules = [], key = null, keyId = null, grantorId = null, now, dataDir, root = null, argv = null } = {}) {
  if (now === undefined || now === null) throw new TypeError('emitProjection needs now (ctx.now)');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('emitProjection needs dataDir');
  const rootDir = root || resolve(dataDir, '..');
  const rid = isObject(rule) && typeof rule.rule_id === 'string' ? rule.rule_id : 'rule';
  const argvOut = argv ?? ['share', 'project', '--rule', rid];
  const inputs = [inlineInput('rule', rule), inlineInput('nodes', nodes.map((n) => n && n.id))];
  const command = 'share';
  const ctx = { rooms, people, circles, nodes, grants, now, hasKey: Boolean(key) };
  const checks = ruleChecks(rule, ctx);
  const receiptFor = (extra) => buildReceipt({ command, argv: argvOut, now, inputs, checks, scope: 'owner', viewer: isObject(rule) && isObject(rule.receiver) ? String(rule.receiver.id) : 'self', releaseTag: RELEASE_TAG, root: rootDir, ...extra });
  const blocking = checks.filter((c) => c.status === 'fail' && c.blocking);
  if (blocking.length) {
    const status = blocking.some((c) => c.code === 'DF_SHARE_RULE_NOT_ACTIVE') ? 'refused' : 'blocked';
    return { ok: false, projections: [], paths: [], checks, receipt: receiptFor({ status, nextAction: `${blocking[0].message} ${blocking[0].repair}` }) };
  }
  // The file names the grantor by a public person id (center.owner_person_id), never by a center's own alias "self".
  const ruleOut = typeof grantorId === 'string' && grantorId && grantorId !== rule.grantor_person_id ? { ...rule, grantor_person_id: grantorId } : rule;
  const grantor = ruleOut.grantor_person_id;
  const kid = keyId ?? `${grantor}-k1`;
  const selected = nodes.filter((n) => selects(rule, n));
  const byRoom = (n) => findRoom(rooms, n.room) ?? { id: n.room ?? 'node', record: {} };
  const rcptId = receiptId({ inputs, command, argv: argvOut, now });
  const projections = [];
  for (const receiver of receiverIds(rule, circles, now)) {
    const pid = projectionId(grantor, receiver, rid, now);
    const groups = new Map();
    const overlayNodes = selected.map((n) => { const e = envelope(n, ruleOut, byRoom(n), { now, keyId: kid, projectionId: pid, disciplines }); for (const g of e.groups) groups.set(g.id, g); return e.node; });
    const ids = new Set(selected.map((n) => n.id));
    const overlayEdges = list(edges).filter((e) => e && ids.has(e.from) && ids.has(e.to) && e.kind !== 'share' && e.kind !== 'candidate').map((e, i) => ({ id: namespaced(grantor, e.id ?? `e${i + 1}`), from: namespaced(grantor, e.from), to: namespaced(grantor, e.to), kind: e.kind, directed: e.directed === true }));
    const projection = {
      schema_version: PROJECTION_SCHEMA_VERSION, projection_id: pid, grantor_person_id: grantor, receiver: { type: 'person', id: receiver },
      rule_refs: [ruleRef(ruleOut)], switches: { ...rule.switches }, released_on: today(now), expires_on: rule.dates.expires_on ?? null,
      revoked_rule_refs: revokedRefs(rules, rule.grantor_person_id, receiver, circles, now).map((ref) => `${grantor}/${ref.slice(ref.indexOf('/') + 1)}`),
      overlay: { id: `person-${grantor}`, groups: [...groups.values()], nodes: overlayNodes, edges: overlayEdges }, receipt_id: rcptId,
    };
    projection.digest = sha256(canonical(projection));
    projection.signature = sign(projection, key, kid);
    const bad = projectionChecks(projection, { rule: ruleOut, rooms, now });
    if (bad.length) throw new Error(`emitProjection built an envelope its own gate refuses: ${bad[0].code} at ${bad[0].path}`);
    const path = writeJsonAtomic(join(outDir(dataDir), projectionFilename(receiver, rid, now)), projection);
    projections.push({ receiver, projection, path });
  }
  const outputs = projections.map((p) => { const d = refDigest(p.path, rootDir); const r = posix(relative(rootDir, p.path)); return { ref: r && !r.startsWith('..') ? r : posix(p.path), digest: d ? d.digest : null, bytes: d ? d.bytes : undefined, kind: 'projection', action: 'written' }; });
  const receipt = receiptFor({ outputs, status: 'written', ownerDecision: { state: 'approved', reviewed_summary_digest: null },
    nextAction: `Hand ${outputs.length === 1 ? 'the file' : `${outputs.length} files`} to ${receiverIds(rule, circles, now).join(', ')} by a channel you trust; the engine has no send path. Nothing already sent can be recalled.` });
  if (receipt.receipt_id !== rcptId) throw new Error('receipt id drifted between the projection and its receipt');
  return { ok: true, projections, paths: projections.map((p) => p.path), checks, receipt };
}
