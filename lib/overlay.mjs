// The inbound half of sharing (VISION §7.3) and the people directory:
// loadPeopleDir() reads center/people/*.json, importProjection() verifies a
// projection (pinned key, receiver, ed25519 signature, schema), namespaces
// and sanitises it, refuses overwrites of local nodes, drops dangling links,
// honours revocations and merges it into data/overlays/<grantor>.json; the
// projector reads overlays back through readOverlays()/liveOverlayNodes()
// and computes taint with computeTaint(). Imported content is fenced data:
// it is never executed, never trusted, and control characters and fence
// sequences never survive the import.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { canonical, sha256 } from './digest.mjs';
import { buildReceipt, inlineInput, isoSeconds, refDigest } from './receipt.mjs';
import { schemaChecks, writeJsonAtomic } from './rooms.mjs';
import { codesForFamily, fail, pass } from './rules.mjs';
import { RELEASE_TAG, today } from './share.mjs';
import { verify } from './sign.mjs';
import { loadSchema, validate } from './validate.mjs';

export const OVERLAY_SCHEMA_VERSION = 'dotfield.overlay/1';
export const PEOPLE_FILES = Object.freeze({ people: 'people.json', circles: 'circles.json', rules: 'share-rules.json', disciplines: 'disciplines.json' });
export const PEOPLE_KEYS = Object.freeze({ people: 'people', circles: 'circles', rules: 'rules', disciplines: 'disciplines' });
export const PEOPLE_VERSIONS = Object.freeze({ people: 'dotfield.people/1', circles: 'dotfield.circles/1', rules: 'dotfield.share-rules/1', disciplines: 'dotfield.disciplines/1' });
const ITEM_SCHEMA = Object.freeze({ people: 'person', circles: 'circle', rules: 'share-rule' });
/** C0/C1 control characters except tab, newline and carriage return. */
export const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Fence sequences: code fences and the <foreign> fence the agent loop uses; neither may arrive from outside. */
export const FENCE_RE = /```+|<\/?foreign\b[^>]*>?/gi;
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posix = (p) => p.split(sep).join('/');
/** The id namespace one grantor may write into: person-<grantor>-... (ids are sanitised, so a prefix test is exact). */
const nsRe = (grantor) => ({ test: (id) => typeof id === 'string' && id.startsWith(`person-${grantor}-`) });

function readJson(file) {
  try { return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** loadPeopleDir(centerDir) -> {people, circles, rules, disciplines, self, checks, paths}; every entry validated, exactly one kind: self. */
export function loadPeopleDir(centerDir) {
  const out = { people: [], circles: [], rules: [], disciplines: [], self: null, checks: [], paths: {} };
  for (const [key, file] of Object.entries(PEOPLE_FILES)) {
    const path = join(centerDir, 'people', file);
    out.paths[key] = path;
    if (!existsSync(path)) { out.checks.push(fail('DF_SCHEMA_REQUIRED', { path: `people/${file}`, detail: 'file is absent' })); continue; }
    const r = readJson(path);
    if (!r.ok) { out.checks.push(fail('DF_SCHEMA_TYPE', { path: `people/${file}`, detail: r.error })); continue; }
    const items = isObject(r.doc) ? r.doc[PEOPLE_KEYS[key]] : undefined;
    if (!isObject(r.doc) || r.doc.schema_version !== PEOPLE_VERSIONS[key] || !Array.isArray(items)) { out.checks.push(fail('DF_SCHEMA_CONST', { path: `people/${file}#$`, detail: `expected {schema_version: '${PEOPLE_VERSIONS[key]}', ${PEOPLE_KEYS[key]}: []}` })); continue; }
    const schema = ITEM_SCHEMA[key] ? loadSchema(ITEM_SCHEMA[key]) : null;
    items.forEach((item, i) => { if (schema) out.checks.push(...schemaChecks(validate(schema, item).errors, `people/${file}#$.${PEOPLE_KEYS[key]}[${i}]`)); });
    out[key] = items;
  }
  const selves = out.people.filter((p) => isObject(p) && p.kind === 'self');
  if (selves.length !== 1) out.checks.push(fail('DF_SCHEMA_REQUIRED', { path: 'people/people.json#$.people', detail: `exactly one kind: self person is required, found ${selves.length}` }));
  out.self = selves[0] ?? null;
  return out;
}
export function findPerson(people, id) { return list(people).find((p) => isObject(p) && p.person_id === id) ?? null; }
/** Rewrite one people file atomically with its wrapper; returns the path. */
export function savePeopleFile(centerDir, key, items) {
  if (!PEOPLE_FILES[key]) throw new TypeError(`unknown people file ${String(key)}`);
  return writeJsonAtomic(join(centerDir, 'people', PEOPLE_FILES[key]), { schema_version: PEOPLE_VERSIONS[key], [PEOPLE_KEYS[key]]: items });
}

/**
 * applyRuleDecision({proposal, centerDir, now, receiptRef}) -> {applied, rule, path}
 * After proposals.decide() returned a kind "rule" proposal, write the effect:
 * approved or edited -> the rule (proposal.records[0]) becomes active in
 * center/people/share-rules.json with dates.released_on and the approval
 * block; rejected -> nothing changes. decide() itself never writes this file.
 */
export function applyRuleDecision({ proposal, centerDir, now, receiptRef = null } = {}) {
  if (now === undefined || now === null) throw new TypeError('applyRuleDecision needs now (ctx.now)');
  if (!isObject(proposal) || proposal.kind !== 'rule') return { applied: false, rule: null, path: null, reason: 'not a rule proposal' };
  const rule = list(proposal.records).find(isObject);
  if (!['approved', 'edited'].includes(proposal.status) || !rule) return { applied: false, rule: rule ?? null, path: null, reason: `status is ${String(proposal.status)}` };
  const dir = loadPeopleDir(centerDir);
  const active = { ...rule, state: 'active', dates: { ...rule.dates, released_on: today(now) }, approval: { proposal_id: proposal.proposal_id, decided_at: proposal.decided_at ?? isoSeconds(now), receipt_ref: receiptRef ?? proposal.receipt_ref ?? null } };
  const idx = dir.rules.findIndex((r) => isObject(r) && r.rule_id === rule.rule_id);
  const rules = idx < 0 ? [...dir.rules, active] : dir.rules.map((r, i) => (i === idx ? active : r));
  return { applied: true, rule: active, path: savePeopleFile(centerDir, 'rules', rules) };
}

/** revokeRule({ruleId, centerDir, now}) -> {ok, rule, path} | {ok: false, check}: state -> revoked; future emits stop, files already sent are not recalled. */
export function revokeRule({ ruleId, centerDir, now } = {}) {
  if (now === undefined || now === null) throw new TypeError('revokeRule needs now (ctx.now)');
  const dir = loadPeopleDir(centerDir);
  const idx = dir.rules.findIndex((r) => isObject(r) && r.rule_id === ruleId);
  if (idx < 0) return { ok: false, rule: null, path: null, check: fail('DF_SHARE_RULE_NOT_FOUND', { path: 'people/share-rules.json', detail: `'${String(ruleId)}'` }) };
  const prev = dir.rules[idx];
  const rule = { ...prev, state: 'revoked', approval: isObject(prev.approval) ? { ...prev.approval, revoked_at: isoSeconds(now) } : prev.approval };
  return { ok: true, rule, path: savePeopleFile(centerDir, 'rules', dir.rules.map((r, i) => (i === idx ? rule : r))) };
}

/** Strip control characters and fence sequences; returns {text, changed}. */
export function sanitizeText(value) {
  const text = String(value);
  const clean = text.replace(CONTROL_RE, '').replace(FENCE_RE, '');
  return { text: clean, changed: clean !== text };
}
function sanitizeDeep(value, hits, path) {
  if (typeof value === 'string') { const r = sanitizeText(value); if (r.changed) hits.push(path); return r.text; }
  if (Array.isArray(value)) return value.map((v, i) => sanitizeDeep(v, hits, `${path}[${i}]`));
  if (isObject(value)) { const o = {}; for (const [k, v] of Object.entries(value)) o[k] = sanitizeDeep(v, hits, `${path}.${k}`); return o; }
  return value;
}

export function overlaysDir(dataDir) { return join(dataDir, 'overlays'); }
export function overlayPath(dataDir, grantor) { return join(overlaysDir(dataDir), `${grantor}.json`); }
export function emptyOverlay(grantor) { return { schema_version: OVERLAY_SCHEMA_VERSION, grantor_person_id: grantor, imported_at: null, grants: {}, groups: [], nodes: [], edges: [] }; }
export function readOverlay(dataDir, grantor) {
  const r = existsSync(overlayPath(dataDir, grantor)) ? readJson(overlayPath(dataDir, grantor)) : null;
  return r && r.ok && isObject(r.doc) && r.doc.schema_version === OVERLAY_SCHEMA_VERSION ? r.doc : emptyOverlay(grantor);
}
/** Every data/overlays/<grantor>.json, sorted by grantor; unreadable files are skipped. */
export function readOverlays(dataDir) {
  const dir = overlaysDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readOverlay(dataDir, basename(f, '.json'))).filter((o) => o.nodes.length || Object.keys(o.grants).length);
}
/** rule_ref -> {re_share, person_id, key_id, expires_on} over every overlay: what evaluate() consults for re-share. */
export function originGrants(overlays) {
  const out = new Map();
  for (const o of list(overlays)) for (const [ref, g] of Object.entries(isObject(o.grants) ? o.grants : {})) out.set(ref, { re_share: g.re_share === true, person_id: o.grantor_person_id, key_id: g.key_id ?? null, expires_on: g.expires_on ?? null });
  return out;
}
/** Overlay nodes still inside expires_on at `now`: {nodes, expired: [ids]}. */
export function liveOverlayNodes(overlay, now) {
  const day = today(now);
  const expired = [];
  const nodes = list(overlay && overlay.nodes).filter((n) => { const e = isObject(n.boundary) ? n.boundary.expires_on : null; if (typeof e === 'string' && e < day) { expired.push(n.id); return false; } return true; });
  return { nodes, expired };
}

/** The stored overlay node: the projection node plus the scene defaults the envelope leaves out. */
function toOverlayNode(n) {
  return { ...n, kind: 'boundary', weight: 0.3, color_token: 'foreign', status: 'accepted', evidence_ids: [] };
}

/**
 * importProjection(file | doc, {people, self, dataDir, now, root, argv, localIds, boundaryIds, reciprocalIds})
 *   -> {ok, overlay, path, dropped: [{edge, why}], removed: [ids], sanitized: [paths], checks, receipt}
 * Refuses (nothing written) on an unpinned key, a wrong receiver, a bad
 * signature, a schema failure, an id outside person-<grantor>-, an overlay
 * node that would overwrite a local one, an undeclared group, or an edge into
 * a local node that is neither a boundary node nor shared back.
 */
export function importProjection(input, { people = [], self, dataDir, now, root = null, argv = null, localIds = [], boundaryIds = [], reciprocalIds = [] } = {}) {
  if (now === undefined || now === null) throw new TypeError('importProjection needs now (ctx.now)');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('importProjection needs dataDir');
  const rootDir = root || resolve(dataDir, '..');
  const selfId = typeof self === 'string' ? self : self && self.person_id;
  const fromFile = typeof input === 'string';
  const read = fromFile ? readJson(input) : { ok: isObject(input), doc: input, error: 'not an object' };
  const doc = read.ok ? read.doc : {};
  const relIn = fromFile ? (() => { const r = posix(relative(rootDir, input)); return r && !r.startsWith('..') ? r : posix(input); })() : 'inline';
  const fileDigest = fromFile ? refDigest(input, rootDir) : null;
  const inputs = fromFile ? [fileDigest ? { ref: relIn, digest: fileDigest.digest, bytes: fileDigest.bytes } : { ref: relIn, digest: sha256('') }] : [inlineInput('projection', input)];
  const argvOut = argv ?? ['import', 'projection', relIn];
  const checks = [];
  const F = (code, path, detail) => checks.push(fail(code, { path, detail }));
  if (!read.ok) F('DF_SCHEMA_TYPE', '$', `the projection is not a JSON object: ${read.error}`);
  const grantor = typeof doc.grantor_person_id === 'string' ? doc.grantor_person_id : null;
  const person = grantor ? findPerson(people, grantor) : null;
  if (!person || typeof person.public_key !== 'string') F('DF_OVERLAY_KEY_UNKNOWN', '$.grantor_person_id', `'${String(grantor)}' has no pinned public key in center/people/people.json`);
  else if (grantor === 'self' || grantor === selfId) F('DF_OVERLAY_KEY_UNKNOWN', '$.grantor_person_id', `'${grantor}' is this center's own name for its owner; a grantor exports under a public person id (emitProjection grantorId / center.owner_person_id)`);
  if (!isObject(doc.receiver) || doc.receiver.id !== selfId) F('DF_OVERLAY_WRONG_RECEIVER', '$.receiver.id', `addressed to '${isObject(doc.receiver) ? String(doc.receiver.id) : 'nobody'}', this center is '${String(selfId)}'`);
  if (person && typeof person.public_key === 'string') {
    const keyMatches = !person.key_id || !isObject(doc.signature) || doc.signature.key_id === person.key_id;
    const { signature, digest, ...body } = doc;
    if (!verify(doc, signature, person.public_key) || !keyMatches) F('DF_OVERLAY_BAD_SIGNATURE', '$.signature.sig', keyMatches ? `does not verify under the pinned key of '${grantor}'` : `signed with key_id '${String(doc.signature.key_id)}', pinned key_id is '${person.key_id}'`);
    else if (digest !== sha256(canonical(body))) F('DF_OVERLAY_BAD_SIGNATURE', '$.digest', 'the digest does not match the body');
  }
  if (read.ok) checks.push(...schemaChecks(validate(loadSchema('projection'), doc).errors, 'projection'));
  const ns = grantor ? nsRe(grantor) : null;
  if (ns && isObject(doc.overlay)) {
    for (const key of ['groups', 'nodes', 'edges']) list(doc.overlay[key]).forEach((x, i) => { if (isObject(x) && typeof x.id === 'string' && !ns.test(x.id)) F('DF_OVERLAY_ID_NOT_NAMESPACED', `$.overlay.${key}[${i}].id`, `'${x.id}' is not prefixed person-${grantor}-`); });
  }
  const refuse = () => ({ ok: false, overlay: null, path: null, dropped: [], removed: [], sanitized: [], checks: finish(checks), receipt: receiptFor('blocked') });
  const receiptFor = (status, outputs = [], next) => buildReceipt({ command: 'import', argv: argvOut, now, inputs, checks: finish(checks), outputs, status, scope: 'owner', viewer: String(selfId ?? 'self'), releaseTag: RELEASE_TAG, root: rootDir, nextAction: next });
  if (checks.some((c) => c.blocking)) return refuse();
  const local = new Set(list(localIds));
  const overlay = doc.overlay;
  const groupIds = new Set(overlay.groups.map((g) => g.id));
  overlay.nodes.forEach((n, i) => {
    if (local.has(n.id)) F('DF_OVERLAY_OVERWRITES_LOCAL', `$.overlay.nodes[${i}].id`, `'${n.id}' is a local node`);
    if (n.group !== undefined && !groupIds.has(n.group)) F('DF_OVERLAY_GROUP_UNDECLARED', `$.overlay.nodes[${i}].group`, `'${n.group}' is not in overlay.groups`);
  });
  const nodeIds = new Set(overlay.nodes.map((n) => n.id));
  const attachable = new Set([...list(boundaryIds), ...list(reciprocalIds)]);
  const dropped = [];
  const edges = [];
  overlay.edges.forEach((e, i) => {
    const ends = [e.from, e.to];
    const bad = ends.find((x) => local.has(x) && !nodeIds.has(x) && !attachable.has(x));
    if (bad) { F('DF_OVERLAY_LINK_TARGET_NOT_BOUNDARY', `$.overlay.edges[${i}]`, `'${bad}' is a local node that is neither a boundary node nor shared back to '${grantor}'`); return; }
    const missing = ends.find((x) => !nodeIds.has(x) && !local.has(x));
    if (missing) { dropped.push({ edge: e.id, why: `'${missing}' is not an overlay node and not a local node` }); return; }
    edges.push(e);
  });
  if (dropped.length) F('DF_OVERLAY_LINK_DROPPED', '$.overlay.edges', dropped.map((d) => `${d.edge}: ${d.why}`).join('; '));
  if (checks.some((c) => c.blocking)) return refuse();
  const sanitized = [];
  const cleanNodes = overlay.nodes.map((n, i) => sanitizeDeep(n, sanitized, `$.overlay.nodes[${i}]`)).map(toOverlayNode);
  const cleanGroups = overlay.groups.map((g, i) => sanitizeDeep(g, sanitized, `$.overlay.groups[${i}]`));
  const cleanEdges = edges.map((e, i) => sanitizeDeep(e, sanitized, `$.overlay.edges[${i}]`));
  if (sanitized.length) F('DF_OVERLAY_CONTENT_SANITIZED', '$.overlay', `${sanitized.length} string(s) carried control characters or fence sequences`);
  const live = liveOverlayNodes({ nodes: cleanNodes }, now);
  if (live.expired.length) F('DF_OVERLAY_EXPIRED', '$.expires_on', `${live.expired.length} node(s) past expires_on were not imported`);
  const existing = readOverlay(dataDir, grantor);
  const revoked = new Set(doc.revoked_rule_refs);
  const refOf = (n) => (isObject(n.boundary) ? n.boundary.rule_ref : n.provenance && n.provenance.imported_via_rule_ref);
  const removed = existing.nodes.filter((n) => revoked.has(refOf(n))).map((n) => n.id);
  if (removed.length) F('DF_OVERLAY_REVOKED', '$.revoked_rule_refs', `${removed.length} node(s) under ${[...revoked].join(', ')} were deleted`);
  // The grantor's latest word replaces every node the file names, expired copies included.
  const incoming = new Set(cleanNodes.map((n) => n.id));
  const keptNodes = existing.nodes.filter((n) => !revoked.has(refOf(n)) && !incoming.has(n.id));
  const keptIds = new Set([...keptNodes.map((n) => n.id), ...live.nodes.map((n) => n.id)]);
  const endOk = (x) => keptIds.has(x) || local.has(x);
  const keptEdges = existing.edges.filter((e) => !cleanEdges.some((c) => c.id === e.id) && endOk(e.from) && endOk(e.to));
  const groups = new Map(existing.groups.map((g) => [g.id, g]));
  for (const g of cleanGroups) groups.set(g.id, g);
  const grants = { ...existing.grants };
  for (const ref of revoked) delete grants[ref];
  for (const ref of doc.rule_refs) grants[ref] = { re_share: doc.switches.re_share === true, switches: { ...doc.switches }, released_on: doc.released_on, expires_on: doc.expires_on, key_id: doc.signature.key_id, projection_id: doc.projection_id, receipt_id: doc.receipt_id };
  const merged = { schema_version: OVERLAY_SCHEMA_VERSION, grantor_person_id: grantor, imported_at: isoSeconds(now), grants, groups: [...groups.values()], nodes: [...keptNodes, ...live.nodes], edges: [...keptEdges, ...cleanEdges.filter((e) => endOk(e.from) && endOk(e.to))] };
  const path = writeJsonAtomic(overlayPath(dataDir, grantor), merged);
  const d = refDigest(path, rootDir);
  const outputs = [{ ref: posix(relative(rootDir, path)), digest: d ? d.digest : null, bytes: d ? d.bytes : undefined, kind: 'overlay', action: 'written' }];
  const next = `${live.nodes.length} boundary node(s) from '${grantor}' now overlay your scenes${removed.length ? `; ${removed.length} revoked entr${removed.length === 1 ? 'y was' : 'ies were'} deleted` : ''}. Render a room view to see them; annotate with a new annotation node, never by editing the stub.`;
  return { ok: true, overlay: merged, path, dropped, removed, sanitized, checks: finish(checks), receipt: receiptFor('written', outputs, next) };
}

/** One check per DF_OVERLAY_* code (pass unless a fail was recorded), followed by any schema findings. */
function finish(checks) {
  const codes = codesForFamily('overlay');
  const out = [];
  for (const code of codes) { const f = checks.filter((c) => c.code === code); out.push(...(f.length ? f : [pass(code)])); }
  return [...out, ...checks.filter((c) => !codes.includes(c.code))];
}

/**
 * computeTaint(scene, {owner}) -> scene copy whose local nodes carry
 * provenance.derived_from for every foreign origin they reach: directly (the
 * privacy gate's one hop: shared evidence with a stub, run-sourced adjacency,
 * annotates) and transitively through other tainted local nodes by the same
 * relations. Existing derived_from entries are kept and merged.
 */
export function computeTaint(scene, { owner = 'self' } = {}) {
  const own = (pid) => pid === 'self' || pid === owner;
  const nodes = list(scene.nodes).filter(isObject);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isStub = (n) => n.kind === 'boundary' && isObject(n.provenance) && !own(n.provenance.owner_person_id);
  const originOf = (s) => { const b = isObject(s.boundary) ? s.boundary : {}; return { person_id: b.shared_by ?? s.provenance.owner_person_id, rule_ref: b.rule_ref ?? s.provenance.imported_via_rule_ref, key_id: b.key_id ?? `${b.shared_by ?? s.provenance.owner_person_id}-k1` }; };
  const taint = new Map(nodes.map((n) => [n.id, new Map()]));
  const add = (id, o) => { if (o && typeof o.rule_ref === 'string') taint.get(id).set(o.rule_ref, o); };
  for (const n of nodes) if (isStub(n)) add(n.id, originOf(n)); else for (const d of list(isObject(n.provenance) ? n.provenance.derived_from : [])) add(n.id, d);
  const stubEvidence = new Map();
  for (const n of nodes) if (isStub(n)) for (const ev of list(n.evidence_ids)) { if (!stubEvidence.has(ev)) stubEvidence.set(ev, []); stubEvidence.get(ev).push(n.id); }
  const links = [];
  for (const n of nodes) {
    if (!isObject(n.provenance) || !own(n.provenance.owner_person_id)) continue;
    // Shared evidence taints one hop from a stub only; run adjacency and annotates carry taint onward.
    for (const ev of list(n.evidence_ids)) for (const other of stubEvidence.get(ev) ?? []) links.push([n.id, other]);
    const viaRun = isObject(n.provenance.source) && n.provenance.source.kind === 'run';
    for (const e of list(scene.edges).filter(isObject)) {
      if (viaRun && (e.from === n.id || e.to === n.id)) links.push([n.id, e.from === n.id ? e.to : e.from]);
      if (e.kind === 'annotates' && e.from === n.id) links.push([n.id, e.to]);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of links) {
      if (!byId.has(b)) continue;
      for (const [ref, o] of taint.get(b)) if (!taint.get(a).has(ref)) { taint.get(a).set(ref, o); changed = true; }
    }
  }
  const outNodes = nodes.map((n) => {
    if (isStub(n) || !isObject(n.provenance) || !own(n.provenance.owner_person_id) || !taint.get(n.id).size) return n;
    const derived_from = [...taint.get(n.id).values()].map((o) => ({ person_id: o.person_id, rule_ref: o.rule_ref, key_id: o.key_id })).sort((x, y) => (x.rule_ref < y.rule_ref ? -1 : 1));
    return { ...n, provenance: { ...n.provenance, derived_from } };
  });
  return { ...scene, nodes: outNodes };
}
