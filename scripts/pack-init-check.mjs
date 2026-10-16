// The template ships packs, not a center (VISION §2.1): `dotfield init` writes
// center/ from a pack, and the fork owns it from then on. This script proves
// every shipped pack instantiates cleanly, by running the real init in a
// temp folder per pack and stating STRUCTURALLY what it must have written:
//   rooms/             byte-identical to packs/<id>/rooms/ (no extra, no missing file)
//   brand.json         packs/<id>/theme.json plus the center name
//   center.config.json valid; installed_packs = [{id, version, digest of the pack folder}]
//   pack-lock.json     the digest of every pack file copied (rooms/**, people/disciplines.json)
//   people/            disciplines.json byte-identical to the pack's; exactly one kind: self
//                      person named by center.owner_person_id, no handles, no key material;
//                      circles.json and share-rules.json empty wrappers
//   nothing else       no keys and no code under center/ (docs/ is free prose)
// and that init exited 0 (its prove all and validate all are part of the run).
// With DOTFIELD_TEMPLATE_REPO=1 (the template's own CI sets it) it also
// refuses a tracked center/: upstream must never ship a center a fork would
// have to merge.
//   node scripts/pack-init-check.mjs [--json] [--pack <id>]   exit 0 when every pack instantiates, 1 otherwise
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, listFiles, sha256File } from '../lib/digest.mjs';
import { PACKAGE_ROOT, PACK_LOCK_VERSION, listPacks, lockEntry, packDigest } from '../lib/packs.mjs';
import { fail } from '../lib/rules.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';

export const PEOPLE_FILES = Object.freeze(['people.json', 'circles.json', 'share-rules.json', 'disciplines.json']);
export const CODE_RE = /\.(mjs|cjs|js|sh|py)$/;
export const KEY_RE = /(\.key|\.token|\.ed25519|\.pem)$/;
const CHECK_NAME = 'Pack Check';
const EPOCH = '1790849700';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try { return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** checkInstantiated({centerDir, packDir, packId, name}) -> [{code, path, message}]: what init must have written for this pack; never throws on a broken center. */
export function checkInstantiated({ centerDir, packDir, packId, name }) {
  const findings = [];
  const F = (code, path, detail) => { const c = fail(code, { path, detail }); findings.push({ code: c.code, path: c.path, message: c.message }); };
  const at = (rel) => `${packId}: center/${rel}`;
  const pack = readJson(join(packDir, 'pack.json')).doc ?? {};
  const theme = readJson(join(packDir, 'theme.json'));
  const cfg = readJson(join(centerDir, 'center.config.json'));
  if (!cfg.ok) { F('DF_SCHEMA_REQUIRED', at('center.config.json'), cfg.error); return findings; }
  for (const e of validate(loadSchema('center-config'), cfg.doc).errors) F(e.code, `${at('center.config.json')}#${e.path}`, e.message);
  const owner = isObject(cfg.doc.center) && typeof cfg.doc.center.owner_person_id === 'string' ? cfg.doc.center.owner_person_id : 'self';
  const installed = { id: packId, version: pack.version, digest: packDigest(packDir) };
  const packs = Array.isArray(cfg.doc.installed_packs) ? cfg.doc.installed_packs : [];
  if (packs.length !== 1 || canonical(packs[0]) !== canonical(installed)) F('DF_PACK_VERSION_DRIFT', `${at('center.config.json')}#$.installed_packs`, `expected exactly ${JSON.stringify(installed)}`);
  const packFiles = existsSync(join(packDir, 'rooms')) ? listFiles(join(packDir, 'rooms')) : [];
  const centerFiles = existsSync(join(centerDir, 'rooms')) ? listFiles(join(centerDir, 'rooms')) : [];
  for (const rel of packFiles) {
    const c = join(centerDir, 'rooms', rel);
    if (!existsSync(c)) F('DF_PACK_ROOM_MISSING', at(`rooms/${rel}`), `present in packs/${packId}/rooms, absent from center/rooms`);
    else if (sha256File(c) !== sha256File(join(packDir, 'rooms', rel))) F('DF_SCHEMA_CONST', at(`rooms/${rel}`), `differs from packs/${packId}/rooms`);
  }
  for (const rel of centerFiles) if (!packFiles.includes(rel)) F('DF_SCHEMA_CONST', at(`rooms/${rel}`), `not part of packs/${packId}/rooms`);
  const brand = readJson(join(centerDir, 'brand.json'));
  if (theme.ok) {
    const { schema_version: _v, name: _n, ...rest } = theme.doc;
    const want = { schema_version: 'dotfield.brand/1', name, ...rest };
    if (!brand.ok) F('DF_SCHEMA_REQUIRED', at('brand.json'), brand.error);
    else if (canonical(brand.doc) !== canonical(want)) F('DF_SCHEMA_CONST', at('brand.json'), `is not packs/${packId}/theme.json plus center.name`);
  }
  const lock = readJson(join(centerDir, 'pack-lock.json'));
  const wantLock = { schema_version: PACK_LOCK_VERSION, packs: { [packId]: lockEntry(packDir, { version: pack.version }) } };
  if (!lock.ok) F('DF_SCHEMA_REQUIRED', at('pack-lock.json'), lock.error);
  else if (canonical(lock.doc) !== canonical(wantLock)) F('DF_SCHEMA_CONST', at('pack-lock.json'), 'does not record the digest of every pack file init copied');
  for (const f of PEOPLE_FILES) if (!existsSync(join(centerDir, 'people', f))) F('DF_SCHEMA_REQUIRED', at(`people/${f}`), 'absent');
  const disc = join(centerDir, 'people', 'disciplines.json');
  if (existsSync(disc) && existsSync(join(packDir, 'disciplines.json')) && !readFileSync(disc).equals(readFileSync(join(packDir, 'disciplines.json')))) F('DF_SCHEMA_CONST', at('people/disciplines.json'), `differs from packs/${packId}/disciplines.json`);
  const people = readJson(join(centerDir, 'people', 'people.json'));
  if (people.ok) {
    const list = isObject(people.doc) && Array.isArray(people.doc.people) ? people.doc.people : [];
    const selves = list.filter((p) => isObject(p) && p.kind === 'self');
    if (list.length !== 1 || selves.length !== 1) F('DF_SCHEMA_CONST', `${at('people/people.json')}#$.people`, `init writes exactly one person, the kind: self owner (found ${list.length}, ${selves.length} self)`);
    const self = selves[0];
    if (self && self.person_id !== owner) F('DF_SCHEMA_CONST', `${at('people/people.json')}#$.people[0].person_id`, `'${self.person_id}' is not center.owner_person_id '${owner}'`);
    if (self && (!Array.isArray(self.handles) || self.handles.length)) F('DF_PRIVACY_HANDLE_PRESENT', `${at('people/people.json')}#$.people[0].handles`, 'a new owner carries no handles');
    if (self && (self.public_key !== undefined || self.key_id !== undefined)) F('DF_PRIVACY_KEY_MATERIAL', `${at('people/people.json')}#$.people[0]`, 'the self key lives in data/keys/, not in people.json');
  }
  for (const [f, key] of [['circles.json', 'circles'], ['share-rules.json', 'rules']]) {
    const r = readJson(join(centerDir, 'people', f));
    if (r.ok && !(isObject(r.doc) && Array.isArray(r.doc[key]) && r.doc[key].length === 0)) F('DF_SCHEMA_CONST', at(`people/${f}`), 'init writes the empty wrapper');
  }
  const allowed = (rel) => ['center.config.json', 'brand.json', 'pack-lock.json', 'brand/tokens.generated.css'].includes(rel) || rel.startsWith('rooms/') || rel.startsWith('docs/') || PEOPLE_FILES.some((f) => rel === `people/${f}`);
  for (const rel of listFiles(centerDir)) {
    if (KEY_RE.test(rel) || rel.startsWith('keys/')) F('DF_PRIVACY_KEY_MATERIAL', at(rel), 'keys never live under center/');
    else if (CODE_RE.test(rel) && !rel.startsWith('docs/')) F('DF_PACK_CODE_IN_PACK', at(rel), 'a center carries no code');
    else if (!allowed(rel)) F('DF_SCHEMA_CONST', at(rel), 'not a file init writes');
  }
  return findings;
}

/** initInto(dir, packId) -> {code, receipt}: the real CLI, run as a fresh fork would run it. */
export function initInto(dir, packId, { name = CHECK_NAME, root = PACKAGE_ROOT } = {}) {
  const r = spawnSync(process.execPath, [join(root, 'bin', 'dotfield.mjs'), 'init', '--pack', packId, '--name', name, '--json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, DOTFIELD_ROOT: dir, SOURCE_DATE_EPOCH: EPOCH, CLAUDECODE: '' },
  });
  let receipt = null;
  try { receipt = JSON.parse(r.stdout); } catch { /* reported below */ }
  return { code: r.status, receipt, stderr: r.stderr };
}

/** Tracked files under center/ (empty outside a git checkout). */
export function trackedCenter(root = PACKAGE_ROOT) {
  try { return execFileSync('git', ['ls-files', '--', 'center'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; }
}

/** checkPacks({root, only, template}) -> {ok, packs: [ids], findings}. */
export function checkPacks({ root = PACKAGE_ROOT, only = null, template = false } = {}) {
  const findings = [];
  const ids = [];
  if (template) for (const rel of trackedCenter(root)) findings.push({ code: 'DF_SCHEMA_CONST', path: rel, message: 'the template ships packs, not a center: git rm --cached it (DOTFIELD_TEMPLATE_REPO=1)' });
  for (const p of listPacks(root).filter((x) => !x.draft && (!only || x.id === only))) {
    ids.push(p.id);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `dotfield-pack-${p.id}-`)));
    try {
      const r = initInto(dir, p.id, { root });
      if (r.code !== 0 || !r.receipt) {
        const fails = r.receipt ? r.receipt.checks.filter((c) => c.status === 'fail').map((c) => `${c.code} ${c.path ?? ''}`).join('; ') : (r.stderr || 'no receipt').trim();
        findings.push({ code: 'DF_PACK_ROOM_MISSING', path: `packs/${p.id}`, message: `init --pack ${p.id} exited ${r.code}: ${fails}` });
      }
      findings.push(...checkInstantiated({ centerDir: join(dir, 'center'), packDir: p.dir, packId: p.id, name: CHECK_NAME }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (!ids.length) findings.push({ code: 'DF_PACK_NOT_FOUND', path: 'packs/', message: only ? `no shipped pack ${only}` : 'no shipped pack' });
  return { ok: findings.length === 0, packs: ids, findings };
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const i = argv.indexOf('--pack');
  const r = checkPacks({ only: i >= 0 ? argv[i + 1] : null, template: process.env.DOTFIELD_TEMPLATE_REPO === '1' });
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.ok) process.stdout.write(`every shipped pack instantiates (${r.packs.join(', ')}): rooms byte-identical, brand = theme + name, installed_packs digest and pack-lock current, people minimal, no keys or code.\n`);
  else for (const f of r.findings) process.stderr.write(`${f.code} ${f.path}: ${f.message}\n`);
  return r.ok ? 0 : 1;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) process.exitCode = main();
