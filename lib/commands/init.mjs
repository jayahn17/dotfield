// dotfield init [--pack <id>] [--name "<Center>"] [--force] (VISION §6, §8.2):
// writes center/ from a shipped pack — rooms, people (disciplines from the
// pack, one kind: self person carrying the new public key), brand.json from
// the pack theme, center.config.json with installed_packs digests, the
// customer docs (templates/center-docs/), center/pack-lock.json (the digest
// of every pack file copied, so `dotfield migrate` can later tell a file the
// owner changed from one only the pack changed) — plus the keys under
// data/keys/ (session.key, owner.token 0600, handle.salt, the self ed25519
// key; created once, never printed), then runs prove all and validate all so
// the first thing the owner sees is a receipt. The template ships no
// center/: a fresh clone has none, so the first `init` needs no flag, and
// upstream never touches the folder a fork customises. A pack from a URL is
// refused, packs/draft/* is refused (DF_PACK_DRAFT). A center that already
// exists needs --force. Re-initialising writes center/ from ONE pack: rooms
// whose room.json names another pack are removed (their stores under data/
// stay; a room with pack: null is yours and stays), keys and data/ are kept,
// people and config are merged. A pack whose pack.json says release_tag
// v1.1-provisional (research-lab) yields a provisional receipt.
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createContext } from '../context.mjs';
import { digestTree } from '../digest.mjs';
import { RELEASE_PROVISIONAL, RELEASE_V1, dedupeChecks, isBlockingFail, readJsonFile } from '../pipeline.mjs';
import { buildReceipt } from '../receipt.mjs';
import { ROOM_FILES, listRoomIds, schemaChecks, writeJsonAtomic } from '../rooms.mjs';
import { fail, pass } from '../rules.mjs';
import { today } from '../share.mjs';
import { PACK_LOCK, lockEntry, resolvePack, writeLock } from '../packs.mjs';
import { generateKeyPair, keyPath, loadKey, writeKeyFile } from '../sign.mjs';
import { tryLoadSchema, validate } from '../validate.mjs';
import * as proveCmd from './prove.mjs';
import * as validateCmd from './validate.mjs';

export const verb = 'init';
export const leaves = ['init'];
export const usage = 'init [--pack <id>] [--name "<Center>"] [--force] [--json]';
export const DEFAULT_PACK = 'starter';
export const DEFAULT_NAME = 'Dotfield';
/** The customer docs init copies into center/docs/ (a pack may ship its own docs/ instead). */
export const CENTER_DOCS = 'templates/center-docs';
export const PACK_CODES = Object.freeze(['DF_PACK_URL_REFUSED', 'DF_PACK_DRAFT', 'DF_PACK_NOT_FOUND', 'DF_PACK_CODE_IN_PACK', 'DF_PACK_ROOM_MISSING', 'DF_PACK_CONDUCTOR_IN_PACK']);
export const PEOPLE_VERSIONS = Object.freeze({ people: 'dotfield.people/1', circles: 'dotfield.circles/1', rules: 'dotfield.share-rules/1', disciplines: 'dotfield.disciplines/1' });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posix = (p) => p.split(sep).join('/');
const SEP_RE = /[/\u005C]/;
const DRAFT_RE = /(^|[/\u005C])draft([/\u005C]|$)/;
const clampWeight = (w) => (typeof w === 'number' && Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 1);

function walkFiles(dir, out = [], rel = '') {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(join(dir, e.name), out, r); else if (e.isFile()) out.push(r);
  }
  return out;
}

/** --pack <id> | <folder> -> {dir, id, checks}: shipped packs by id, local packs by path; URLs and drafts refused. */
export function resolvePackDir(spec, ctx) {
  const packsDir = ctx.env.DOTFIELD_PACKS_DIR || join(ctx.packageRoot, 'packs');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) return { dir: null, id: spec, checks: [fail('DF_PACK_URL_REFUSED', { path: '--pack', detail: spec })] };
  if (SEP_RE.test(spec)) {
    const dir = ctx.absPath(spec);
    if (DRAFT_RE.test(spec)) return { dir, id: basename(dir), checks: [fail('DF_PACK_DRAFT', { path: '--pack', detail: spec })] };
    return { dir, id: basename(dir), checks: existsSync(join(dir, 'pack.json')) ? [] : [fail('DF_PACK_NOT_FOUND', { path: '--pack', detail: `${spec} holds no pack.json` })] };
  }
  if (!ctx.env.DOTFIELD_PACKS_DIR) { const r = resolvePack(spec, { root: ctx.packageRoot }); return { dir: r.dir, id: r.id, checks: r.checks }; }
  const dir = join(packsDir, spec);
  if (existsSync(join(dir, 'pack.json'))) return { dir, id: spec, checks: [] };
  if (existsSync(join(packsDir, 'draft', spec, 'pack.json'))) return { dir: join(packsDir, 'draft', spec), id: spec, checks: [fail('DF_PACK_DRAFT', { path: '--pack', detail: `${spec} lives under packs/draft/` })] };
  return { dir, id: spec, checks: [fail('DF_PACK_NOT_FOUND', { path: '--pack', detail: `no packs/${spec}/pack.json` })] };
}

/** readPack(dir) -> {ok, id, dir, pack, rooms: [{id, dir}], roster, disciplines, theme, docsDir, digest, checks}. */
export function readPack(dir) {
  const checks = [];
  const read = readJsonFile(join(dir, 'pack.json'));
  if (!read.ok || !isObject(read.doc)) return { ok: false, dir, pack: null, rooms: [], checks: [fail('DF_PACK_NOT_FOUND', { path: posix(join(basename(dir), 'pack.json')), detail: read.ok ? 'not an object' : read.error })] };
  const pack = read.doc;
  const schema = tryLoadSchema('pack');
  if (schema.ok) checks.push(...schemaChecks(validate(schema.schema, pack).errors, 'pack.json'));
  const files = walkFiles(dir);
  for (const f of files) if (/\.(mjs|cjs|js)$/.test(f)) checks.push(fail('DF_PACK_CODE_IN_PACK', { path: f, detail: 'packs carry no code (JSON, a README and example CSV only)' }));
  const declared = Array.isArray(pack.rooms) ? pack.rooms.map((r) => (isObject(r) ? r.id : r)).filter((r) => typeof r === 'string') : null;
  const ids = declared ?? [...new Set(files.map((f) => /^rooms\/([^/]+)\/room\.json$/.exec(f)).filter(Boolean).map((m) => m[1]))];
  const rooms = [];
  for (const id of ids) {
    const roomDir = [join(dir, 'rooms', id), join(dir, id)].find((d) => existsSync(join(d, 'room.json')));
    const missing = roomDir ? ROOM_FILES.filter((f) => !existsSync(join(roomDir, f))) : ROOM_FILES;
    if (!roomDir || missing.length) checks.push(fail('DF_PACK_ROOM_MISSING', { path: `pack.json#$.rooms[${ids.indexOf(id)}]`, detail: `${id}: ${roomDir ? `${missing.join(', ')} absent` : 'no folder'}` }));
    else rooms.push({ id, dir: roomDir });
  }
  const file = (key, fallback) => { const f = typeof pack[key] === 'string' ? pack[key] : fallback; const p = join(dir, f); return existsSync(p) ? readJsonFile(p).doc ?? null : null; };
  const roster = file('roster', 'roster.json');
  if (isObject(roster) && (roster.conductor || (Array.isArray(roster.desks) && roster.desks.some((d) => d && d.id === 'conductor')))) checks.push(fail('DF_PACK_CONDUCTOR_IN_PACK', { path: 'roster.json', detail: 'the conductor is defined once, in center.config.json' }));
  const disciplinesDoc = file('disciplines', 'disciplines.json');
  const disciplines = Array.isArray(disciplinesDoc) ? disciplinesDoc : isObject(disciplinesDoc) && Array.isArray(disciplinesDoc.disciplines) ? disciplinesDoc.disciplines : [];
  const theme = file('theme', 'theme.json');
  for (const code of PACK_CODES) if (!checks.some((c) => c.code === code)) checks.push(pass(code));
  const docsDir = existsSync(join(dir, 'docs')) ? join(dir, 'docs') : null;
  return { ok: !checks.some(isBlockingFail), id: typeof pack.id === 'string' ? pack.id : basename(dir), dir, pack, rooms, roster, disciplines, theme: isObject(theme) ? theme : null, docsDir, digest: digestTree(dir).digest, checks };
}

/** The four key files under data/keys/ (created only when absent; 0600); returns the self public key. */
export function ensureKeys(dataDir, owner) {
  const dir = join(dataDir, 'keys');
  mkdirSync(dir, { recursive: true });
  const created = [];
  const put = (name, text) => { const p = join(dir, name); if (existsSync(p)) return; writeFileSync(p, text, { encoding: 'utf8', mode: 0o600 }); chmodSync(p, 0o600); created.push(name); };
  put('session.key', `${randomBytes(32).toString('hex')}\n`);
  put('owner.token', `${randomBytes(32).toString('hex')}\n`);
  put('handle.salt', `base64:${randomBytes(32).toString('base64')}\n`);
  let key = loadKey(dataDir, owner);
  if (!key.ok) { const pair = generateKeyPair(); writeKeyFile(keyPath(dataDir, owner), pair.privateKey); created.push(`${owner}.ed25519`); key = { ok: true, publicKey: pair.publicKey }; }
  return { created, publicKey: key.publicKey, keyId: `${owner}-k1` };
}

/** The new owner: kind self, no handles and no key material (the key lives in data/keys/; scripts/pack-init-check.mjs asserts this). */
function selfPerson({ owner, disciplines, now, existing }) {
  if (existing) return existing;
  const first = disciplines.find((d) => isObject(d) && typeof d.label === 'string');
  return { person_id: owner, kind: 'self', display_name: 'Owner', handles: [], disciplines: first ? [{ label: first.label.slice(0, 80), source: 'self', weight: clampWeight(first.weight) }] : [], provenance: { introduced_by_person_id: owner, introduced_on: today(now), evidence_ref: null }, privacy_mode: 'private_live' };
}

function defaultConfig({ name, read }) {
  return {
    schema_version: 'dotfield.center-config/1',
    center: { name, tagline: `A private center shipped from the ${read.id} pack; rename it here, then run dotfield validate all.`, owner_person_id: 'self', locale: 'en' },
    installed_packs: [], provider: { adapter: 'dry', model: null, max_tokens_per_run: 8000, allow_nested: false }, server: { port: 4100, host: '127.0.0.1' },
    privacy: { default_privacy_level: 'private' }, connect: { threshold: 0.35 }, approval: { max_records_per_proposal: 200 }, store: { allow_env_pins: false, object_store_url: null },
    conductor: { display: 'Conductor', lens: 'turn one question into a mission brief, route it to at most five desks and one challenger, and stop at awaiting_owner' },
  };
}

/** Rooms of other packs (room.json `pack` set and not the chosen pack) leave center/ on a re-init; their stores under data/ stay. Returns the removed room ids. */
export function removeForeignRooms(read, ctx) {
  const removed = [];
  for (const id of listRoomIds(ctx.centerDir)) {
    const dir = join(ctx.centerDir, 'rooms', id);
    const r = readJsonFile(join(dir, 'room.json'));
    const pack = r.ok && isObject(r.doc) && typeof r.doc.pack === 'string' ? r.doc.pack : null;
    if (pack === null || pack === read.id) continue;
    removed.push({ id, pack, files: walkFiles(dir).map((f) => `center/rooms/${id}/${f}`) });
    rmSync(dir, { recursive: true, force: true });
  }
  return removed;
}

/** Write center/ from the pack; returns the files written (absolute). Existing config/people are merged, not replaced; installed_packs becomes the one pack written. */
export function writeCenter(read, { ctx, name }) {
  const c = ctx.centerDir;
  const written = [];
  const put = (file, doc) => { writeJsonAtomic(file, doc); written.push(file); };
  for (const r of read.rooms) { const dir = join(c, 'rooms', r.id); cpSync(r.dir, dir, { recursive: true }); for (const f of walkFiles(dir)) written.push(join(dir, f)); }
  const existingConfig = readJsonFile(join(c, 'center.config.json'));
  const config = existingConfig.ok && isObject(existingConfig.doc) ? existingConfig.doc : defaultConfig({ name, read });
  if (name && existingConfig.ok) config.center = { ...config.center, name };
  config.installed_packs = [{ id: read.id, version: typeof read.pack.version === 'string' ? read.pack.version : '0.0.0', digest: read.digest }];
  put(join(c, 'center.config.json'), config);
  if (read.theme) {
    const existingBrand = readJsonFile(join(c, 'brand.json'));
    const { schema_version, name: themeName, ...theme } = read.theme;
    const prev = existingBrand.ok && isObject(existingBrand.doc) ? existingBrand.doc : {};
    put(join(c, 'brand.json'), { schema_version: 'dotfield.brand/1', name: prev.name ?? config.center.name, ...prev, ...theme });
  }
  const owner = config.center.owner_person_id;
  const keys = ensureKeys(ctx.dataDir, owner);
  const peopleFile = join(c, 'people', 'people.json');
  const existingPeople = readJsonFile(peopleFile);
  const people = existingPeople.ok && isObject(existingPeople.doc) && Array.isArray(existingPeople.doc.people) ? existingPeople.doc.people : [];
  const self = selfPerson({ owner, disciplines: read.disciplines, now: ctx.now, existing: people.find((p) => isObject(p) && p.kind === 'self') ?? null });
  put(peopleFile, { schema_version: PEOPLE_VERSIONS.people, people: [self, ...people.filter((p) => !(isObject(p) && p.kind === 'self'))] });
  const discSrc = join(read.dir, typeof read.pack.disciplines === 'string' ? read.pack.disciplines : 'disciplines.json');
  const discDst = join(c, 'people', 'disciplines.json');
  if (existsSync(discSrc)) { mkdirSync(join(c, 'people'), { recursive: true }); cpSync(discSrc, discDst); written.push(discDst); } else put(discDst, { schema_version: PEOPLE_VERSIONS.disciplines, disciplines: read.disciplines });
  for (const [key, file] of [['circles', 'circles.json'], ['rules', 'share-rules.json']]) { const p = join(c, 'people', file); if (!existsSync(p)) put(p, { schema_version: PEOPLE_VERSIONS[key], [key]: [] }); }
  const docsSrc = read.docsDir ?? (existsSync(join(ctx.packageRoot, CENTER_DOCS)) ? join(ctx.packageRoot, CENTER_DOCS) : null);
  const docsDst = join(c, 'docs');
  if (docsSrc && resolve(docsSrc) !== resolve(docsDst)) { cpSync(docsSrc, docsDst, { recursive: true }); for (const f of walkFiles(docsDst)) written.push(join(docsDst, f)); }
  for (const recipe of Array.isArray(read.pack.recipes) ? read.pack.recipes : []) {
    const src = join(ctx.packageRoot, 'recipes', String(recipe).endsWith('.md') ? String(recipe) : `${recipe}.md`);
    const dst = join(docsDst, 'recipes', basename(src));
    if (existsSync(src) && !existsSync(dst)) { mkdirSync(join(docsDst, 'recipes'), { recursive: true }); cpSync(src, dst); written.push(dst); }
  }
  writeLock(c, { packs: { [read.id]: lockEntry(read.dir, { version: config.installed_packs[0].version }) } });
  written.push(join(c, PACK_LOCK));
  return { written, keys, owner, config };
}

const args0 = (verbName) => ({ verb: verbName, _: ['all'], flags: {}, json: false, as: null, argv: [verbName, 'all'] });

/** The release tag a pack's receipts carry: pack.json release_tag (VISION §13 tags research-lab v1.1), else v1.0. */
export const packReleaseTag = (pack) => (isObject(pack) && pack.release_tag === RELEASE_PROVISIONAL ? RELEASE_PROVISIONAL : RELEASE_V1);

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  const spec = typeof args.flags.pack === 'string' && args.flags.pack ? args.flags.pack : DEFAULT_PACK;
  const where = resolvePackDir(spec, ctx);
  if (where.checks.length) return buildReceipt({ ...base, status: 'blocked', checks: [...where.checks, ...PACK_CODES.filter((c) => !where.checks.some((x) => x.code === c)).map(pass)] });
  const read = readPack(where.dir);
  base.releaseTag = packReleaseTag(read.pack);
  const packRef = (p) => { const r = posix(relative(ctx.packageRoot, p)); return r && !r.startsWith('..') ? r : ctx.relRef(p); };
  const inputs = ['pack.json', 'theme.json', 'roster.json', 'disciplines.json'].map((f) => join(where.dir, f)).filter(existsSync).map((p) => ({ ...ctx.inputRef(p), ref: packRef(p) }));
  if (!read.ok) return buildReceipt({ ...base, status: 'blocked', inputs, checks: read.checks });
  const existing = existsSync(join(ctx.centerDir, 'center.config.json'));
  if (existing && args.flags.force !== true) {
    return buildReceipt({ ...base, status: 'refused', inputs, checks: read.checks, nextAction: `center/center.config.json already exists at ${ctx.root}; pass --force to re-initialise from pack ${read.id} (keys and data/ are kept, people and config are merged, the pack's rooms are rewritten, rooms whose room.json names another pack are removed — set pack: null to keep one).` });
  }
  const name = typeof args.flags.name === 'string' && args.flags.name ? args.flags.name : DEFAULT_NAME;
  const removed = existing ? removeForeignRooms(read, ctx) : [];
  const center = writeCenter(read, { ctx, name });
  const checks = [...read.checks];
  const outputs = removed.flatMap((r) => r.files.map((ref) => ({ ref, digest: null, kind: 'center', action: 'removed' })));
  outputs.push(...center.written.filter((f) => statSync(f).isFile()).map((f) => ({ ...ctx.inputRef(f), kind: f.endsWith('.md') ? 'docs' : 'center', action: 'written' })));
  const proved = await proveCmd.run(args0('prove'), createContext({ cwd: ctx.root, env: ctx.env, stdin: ctx.stdin, stdout: ctx.stdout }));
  checks.push(...proved.checks); outputs.push(...proved.outputs);
  const validated = await validateCmd.run(args0('validate'), createContext({ cwd: ctx.root, env: ctx.env, stdin: ctx.stdin, stdout: ctx.stdout }));
  checks.push(...validated.checks); outputs.push(...validated.outputs);
  const blocked = checks.some(isBlockingFail);
  const removedLine = removed.length ? `; removed ${removed.map((r) => `${r.id} (pack ${r.pack})`).join(', ')} from center/rooms (stores under data/ kept)` : '';
  return buildReceipt({ ...base, inputs, checks: dedupeChecks(checks), outputs, maturity: validated.maturity, status: blocked ? 'blocked' : 'written',
    nextAction: blocked ? undefined : `Center "${name}" initialised from pack ${read.id} v${center.config.installed_packs.at(-1).version} with ${read.rooms.length} room(s)${removedLine}; ${center.keys.created.length} key file(s) created under data/keys (0600, never printed); prove all → ${proved.status}, validate all → ${validated.status}. Next: dotfield doctor, then dotfield serve.` });
}
