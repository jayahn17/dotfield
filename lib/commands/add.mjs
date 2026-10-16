// dotfield add room <id> --from <pack>/<room>|--blank · add person <file>
//   --fingerprint "<words>" · add rule <file>  (VISION §5, §7.1, §8.2)
// add room copies a pack template (or writes a valid minimal set and names
// the fields to fill); add person is the ONLY place a public key enters a
// center, and only when the typed fingerprint matches sign.fingerprint();
// add rule validates a share rule and proposes it (kind "rule") so it exists
// in awaiting_owner until dotfield approve makes it active. The synthetic
// rooms ruleRoom() / pairRoom() give lib/proposals.mjs a record schema and an
// id_field for rule and pair proposals; share.mjs and connect.mjs reuse them.
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { check as shareGate } from '../gates/share.mjs';
import { findPerson, loadPeopleDir, savePeopleFile } from '../overlay.mjs';
import { readJsonFile } from '../pipeline.mjs';
import { propose } from '../proposals.mjs';
import { buildReceipt, inlineInput } from '../receipt.mjs';
import { ROOM_FILES, ROOM_ID_RE, listRoomIds, loadRoom, schemaChecks, writeJsonAtomic } from '../rooms.mjs';
import { fail, pass } from '../rules.mjs';
import { ownerPersonId } from '../scope.mjs';
import { today } from '../share.mjs';
import { fingerprintMatches, hmacHandle, normalizeFingerprint, readKeyFile } from '../sign.mjs';
import { loadSchema, validate } from '../validate.mjs';
import { sha256 } from '../digest.mjs';

export const verb = 'add';
export const leaves = ['add room', 'add person', 'add rule'];
export const usage = 'add room <id> --from <pack>/<room>|--blank · add person <file> --fingerprint "<words>" · add rule <file> [--json]';
const ID_PATTERN = '^[a-z0-9][a-z0-9_.:-]{0,79}$';
const HMAC_RE = /^hmac-sha256:[0-9a-f]{64}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlocking = (c) => c.status === 'fail' && c.blocking;

/** The synthetic room a share-rule proposal is checked and summarised against (records = rules, id_field rule_id). */
export function ruleRoom() {
  return { id: 'share-rules', ok: true, files: {}, recordSchema: loadSchema('share-rule'), manifest: { id: 'share-rules', label: 'Share rules', mode: 'proposal_only', maturity: 'local_beta', blocked_actions: [], store: { scope: 'owner', namespace: 'share-rules', max_records: 2000, max_record_bytes: 16384 }, record: { id_field: 'rule_id', dates: {}, link_fields: [], public_fields: [] } } };
}
/** The synthetic room a boundary-pair proposal (connect --accept) is checked against (records = pair rows, id_field pair_id). */
export function pairRoom() {
  const recordSchema = { type: 'object', additionalProperties: false, required: ['pair_id', 'local_node', 'other_node'], properties: { pair_id: { type: 'string', pattern: '^pair-[0-9a-f]{12}$' }, local_node: { type: 'string', pattern: ID_PATTERN }, other_node: { type: 'string', pattern: ID_PATTERN }, rule_ref: { type: ['string', 'null'], maxLength: 200 }, score: { type: 'number', minimum: 0, maximum: 1 } } };
  return { id: 'boundaries', ok: true, files: {}, recordSchema, manifest: { id: 'boundaries', label: 'Boundary pairs', mode: 'proposal_only', maturity: 'local_beta', blocked_actions: [], store: { scope: 'owner', namespace: 'boundaries', max_records: 2000, max_record_bytes: 16384 }, record: { id_field: 'pair_id', dates: {}, link_fields: [], public_fields: [] } } };
}

/** A valid minimal room: {room, recordSchema, views, examples}; the owner fills label, purpose and done_definition. */
export function blankRoom(id) {
  const label = id.replace(/[-_]+/g, ' ').replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
  const deskId = `desk-${id.replace(/_/g, '-')}`;
  const room = {
    schema_version: 'dotfield.room/1', id, label, icon: 'room', pack: null, purpose: 'FILL: what one record of this room is, in one sentence.',
    mode: 'proposal_only', privacy_mode: 'private_live', maturity: 'contract_only',
    store: { scope: 'owner', namespace: id, max_records: 2000, max_record_bytes: 16384 },
    record: { schema: 'record.schema.json', id_field: 'item_id', label_field: 'title', sublabel_field: 'summary', tag_field: 'tags', dates: { happened_on: 'happened_on', remembered_on: 'logged_on' }, link_fields: [], default_privacy_level: 'private', public_fields: ['title', 'tags'] },
    views: 'views.json',
    desks: [{ id: deskId, display: `${label} desk`, tier: 'core', domain: label.toLowerCase(), primary_field: label.toLowerCase(), adjacent_fields: [], lens: 'FILL: the one sentence this desk reads every record through', keywords: [id.slice(0, 40)], challenger_for: [], influences: [], constraint: 'never reports a value without the record id as evidence', prompt: null }],
    owner_gates: { writes: 'required', external_sends: 'blocked', share: 'required', aggregate: 'blocked', train: 'blocked' },
    blocked_actions: [], proof: { test: false, expected: ['examples.json validates', 'the graph view emits one node per record'] },
    done_definition: `FILL: done as local_beta when dotfield prove ${id} exits 0 and every view renders with no DF_IR_* or DF_LAYOUT_* failure.`,
  };
  const recordSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: label, type: 'object', additionalProperties: false, required: ['item_id', 'title', 'logged_on'], properties: { item_id: { type: 'string', pattern: ID_PATTERN }, title: { type: 'string', minLength: 1, maxLength: 120 }, summary: { type: 'string', maxLength: 400 }, tags: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 40 } }, happened_on: { type: 'string', format: 'date' }, logged_on: { type: 'string', format: 'date' } } };
  const views = [
    { id: 'graph', label: `${label} web`, kind: 'graph', node: { kind: 'record', label: '$.title', sublabel: '$.summary', tags: '$.tags' }, group_by: { field: '$.tags[0]', kind: 'discipline' }, limit: { max_nodes: 600, default_lens: null }, views: { '2d': { layout: 'force', seed: 7 }, '3d': { layout: 'lift', scale_m: 6, lift: { mode: 'group-weight', amplitude_m: 1.5 } }, vr: { enabled: true, scale_m: 4 } } },
    { id: 'timeline', label: `${label} history`, kind: 'timeline', date: '$.happened_on', node: { kind: 'event', label: '$.title', sublabel: '$.summary' }, views: { '2d': { layout: 'timeline' }, '3d': { layout: 'tier-wall', scale_m: 5 }, vr: { enabled: false } } },
  ];
  const examples = [1, 2, 3].map((n) => ({ item_id: `${id}-000${n}`, title: `Example ${n}`, summary: `Synthetic example record ${n}; replace it with a real one.`, tags: ['example'], happened_on: `2026-01-0${n}`, logged_on: `2026-01-0${n}` }));
  return { room, recordSchema, views, examples };
}

/** --from <pack>/<room> -> the template folder: packs/<pack>/rooms/<room>, packs/<pack>/<room>, or an existing folder path. */
export function templateDir(from, ctx) {
  const asPath = ctx.absPath(from);
  if (existsSync(join(asPath, 'room.json'))) return asPath;
  const parts = String(from).split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const room = parts.pop();
  const pack = join(ctx.env.DOTFIELD_PACKS_DIR || join(ctx.packageRoot, 'packs'), ...parts);
  return [join(pack, 'rooms', room), join(pack, room)].find((d) => existsSync(join(d, 'room.json'))) ?? null;
}

async function addRoom(args, ctx, base) {
  const id = String(args._[1] ?? '');
  if (!ROOM_ID_RE.test(id)) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_PATTERN', { path: '$.id', detail: `'${id}' is not a room id (${ROOM_ID_RE.source})` })] });
  const dir = join(ctx.centerDir, 'rooms', id);
  if (existsSync(dir)) return buildReceipt({ ...base, status: 'refused', nextAction: `center/rooms/${id} already exists; choose another id or remove the folder first.` });
  const from = typeof args.flags.from === 'string' ? args.flags.from : null;
  const inputs = [];
  if (from) {
    const src = templateDir(from, ctx);
    if (!src) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_PACK_ROOM_MISSING', { path: `--from ${from}`, detail: 'no room template with its room.json at that pack path or folder' })] });
    for (const f of readdirSync(src)) if (statSync(join(src, f)).isFile()) inputs.push(ctx.inputRef(join(src, f)));
    cpSync(src, dir, { recursive: true });
    const read = readJsonFile(join(dir, 'room.json'));
    if (read.ok && isObject(read.doc)) { read.doc.id = id; if (isObject(read.doc.store)) read.doc.store.namespace = id; writeJsonAtomic(join(dir, 'room.json'), read.doc); }
  } else if (args.flags.blank === true) {
    const b = blankRoom(id);
    writeJsonAtomic(join(dir, 'room.json'), b.room); writeJsonAtomic(join(dir, 'record.schema.json'), b.recordSchema);
    writeJsonAtomic(join(dir, 'views.json'), b.views); writeJsonAtomic(join(dir, 'examples.json'), b.examples);
  } else return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const room = loadRoom(ctx.centerDir, id, { dotDir: ctx.dotDir, roomIds: listRoomIds(ctx.centerDir) });
  const checks = room.checks.filter((c) => c.code !== 'DF_ROOM_MATURITY_UNPROVEN');
  const outputs = ROOM_FILES.filter((f) => room.files[f]).map((f) => ({ ...ctx.inputRef(room.files[f]), kind: 'room', action: 'written' }));
  const blocked = checks.some(isBlocking);
  return buildReceipt({ ...base, inputs: inputs.filter(Boolean), checks, outputs, maturity: room.manifest ? room.manifest.maturity : null, mode: room.manifest ? room.manifest.mode : null, status: blocked ? 'blocked' : 'written',
    nextAction: blocked ? undefined : from ? `Room ${id} copied from ${from}; edit center/rooms/${id}/room.json, then dotfield validate ${id} and dotfield prove ${id}.` : `Room ${id} scaffolded; fill label, purpose and done_definition in center/rooms/${id}/room.json (and the FILL lens of its desk), then dotfield validate ${id} and dotfield prove ${id}.` });
}

async function addPerson(args, ctx, base) {
  const file = args._[1];
  if (!file) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  const path = ctx.absPath(file);
  const read = existsSync(path) ? readJsonFile(path) : { ok: false, error: 'no such file' };
  const inputs = [ctx.inputRef(path)].filter(Boolean);
  if (!read.ok || !isObject(read.doc)) return buildReceipt({ ...base, status: 'blocked', inputs, checks: [fail('DF_SCHEMA_TYPE', { path: ctx.relRef(path), detail: read.ok ? 'not a person object' : read.error })] });
  const words = typeof args.flags.fingerprint === 'string' ? args.flags.fingerprint : '';
  const owner = ownerPersonId(ctx.config);
  const person = { ...read.doc };
  const checks = [];
  if (person.kind === 'self' || person.person_id === owner || person.person_id === 'self') checks.push(fail('DF_SCHEMA_ENUM', { path: '$.kind', detail: 'exactly one kind: self exists (init writes it); add a contact, org or agent' }));
  if (typeof person.public_key !== 'string') checks.push(fail('DF_SCHEMA_REQUIRED', { path: '$.public_key', detail: 'a person is pinned by their ed25519 public key (44 base64 characters)' }));
  else if (!words.trim()) checks.push(fail('DF_OVERLAY_KEY_UNKNOWN', { path: '--fingerprint', detail: 'the fingerprint words read out of band are required; nothing was pinned' }));
  else if (!fingerprintMatches(person.public_key, words)) checks.push(fail('DF_OVERLAY_KEY_UNKNOWN', { path: '--fingerprint', detail: 'the words do not match public_key; nothing was pinned (no trust-on-first-use)' }));
  else checks.push(pass('DF_OVERLAY_KEY_UNKNOWN'));
  const salt = readKeyFile(join(ctx.dataDir, 'keys', 'handle.salt'));
  const plain = (Array.isArray(person.handles) ? person.handles : []).filter((h) => !HMAC_RE.test(String(h)));
  if (plain.length && !salt) checks.push({ ...fail('DF_ENGINE_KEYS_MISSING', { path: 'data/keys/handle.salt', detail: `${plain.length} plain handle(s) cannot be hashed without it` }), blocking: true });
  if (checks.some(isBlocking)) return buildReceipt({ ...base, status: 'blocked', inputs, checks });
  person.handles = (Array.isArray(person.handles) ? person.handles : []).map((h) => (HMAC_RE.test(String(h)) ? h : hmacHandle(salt, h)));
  person.key_id ??= `${person.person_id}-k1`;
  person.disciplines ??= [];
  person.privacy_mode ??= 'private_live';
  person.provenance ??= { introduced_by_person_id: owner, introduced_on: today(ctx.now), evidence_ref: null };
  person.verification = { method: 'fingerprint', verified_on: today(ctx.now), fingerprint_digest: sha256(normalizeFingerprint(words)) };
  delete person.schema_version;
  checks.push(...schemaChecks(validate(loadSchema('person'), person).errors, 'person'));
  if (checks.some(isBlocking)) return buildReceipt({ ...base, status: 'blocked', inputs, checks });
  const dir = loadPeopleDir(ctx.centerDir);
  const people = findPerson(dir.people, person.person_id) ? dir.people.map((p) => (p.person_id === person.person_id ? person : p)) : [...dir.people, person];
  const out = savePeopleFile(ctx.centerDir, 'people', people);
  return buildReceipt({ ...base, inputs, checks, status: 'written', outputs: [{ ...ctx.inputRef(out), kind: 'people', action: 'written' }],
    nextAction: `Pinned ${person.person_id} (key ${person.key_id}) after the fingerprint matched; ${plain.length} handle(s) hashed under data/keys/handle.salt. Projections from ${person.person_id} now import with dotfield import projection <file>.` });
}

/**
 * proposeRule({file, args, ctx, by}) -> {ok, rule, inputs, checks, result}
 * Validates the rule (schema + share gate minus the not-yet-active state) and
 * proposes it; shared by `add rule` and `share rule`.
 */
export async function proposeRule({ file, args, ctx, by = 'self' }) {
  const path = ctx.absPath(file);
  const read = existsSync(path) ? readJsonFile(path) : { ok: false, error: 'no such file' };
  const inputs = [ctx.inputRef(path)].filter(Boolean);
  if (!read.ok || !isObject(read.doc)) return { ok: false, rule: null, inputs, checks: [fail(read.ok ? 'DF_SCHEMA_TYPE' : 'DF_SCHEMA_REQUIRED', { path: ctx.relRef(path), detail: read.ok ? 'not a share rule object' : read.error })], result: null };
  const rule = { schema_version: 'dotfield.share-rule/1', ...read.doc, state: 'awaiting_owner', approval: null };
  rule.grantor_person_id ??= ownerPersonId(ctx.config);
  const pd = existsSync(join(ctx.centerDir, 'people')) ? loadPeopleDir(ctx.centerDir) : { people: [], circles: [] };
  const checks = shareGate(rule, { rooms: ctx.hasCenter ? ctx.rooms().rooms : [], people: pd.people, circles: pd.circles, now: ctx.now })
    .map((c) => (c.code === 'DF_SHARE_RULE_NOT_ACTIVE' ? pass(c.code) : c));
  if (checks.some(isBlocking)) return { ok: false, rule, inputs, checks, result: null };
  const result = await propose({ room: ruleRoom(), records: [rule], by, scope: 'owner', kind: 'rule', now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env: ctx.env, argv: args.argv, root: ctx.root });
  return { ok: result.ok, rule, inputs, checks: [...checks, ...result.checks], result };
}

/** The receipt of a rule proposal under the calling verb's name. */
export function ruleReceipt(base, r) {
  if (!r.result) return buildReceipt({ ...base, status: 'blocked', inputs: r.inputs, checks: r.checks });
  const p = r.result.receipt;
  return buildReceipt({ ...base, inputs: [...r.inputs, inlineInput('rule', r.rule)], checks: r.checks, outputs: p.outputs, status: p.status, store: p.store, ownerDecision: p.owner_decision, releaseTag: 'v1.1-provisional',
    nextAction: r.result.ok ? `Rule ${r.rule.rule_id} awaits the owner as ${r.result.proposal.proposal_id}: dotfield approve ${r.rule.rule_id} --decision approve makes it active; share project --rule ${r.rule.rule_id} emits nothing before that.` : p.next_action });
}

export async function run(args, ctx) {
  const leaf = args._[0];
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init first' })] });
  if (leaf === 'room') return addRoom(args, ctx, base);
  if (leaf === 'person') return addPerson(args, ctx, base);
  if (leaf === 'rule') {
    if (!args._[1]) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
    return ruleReceipt(base, await proposeRule({ file: args._[1], args, ctx }));
  }
  return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
}
