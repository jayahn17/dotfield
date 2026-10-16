// dotfield export [--room <id>] [-o <dir>] (VISION §1, §8.2): export is a
// right. Every record (owner scope), every proposal, the people directory
// with handles excluded, the share rules, accepted boundary pairs and every
// receipt leave as plain JSON under one folder (default
// .dotfield/export-<ts>/) with an export.json manifest and a receipt beside
// them. Owner-only: a person scope never exports the owner's stores. This is
// one of the four allowed importers of lib/store.mjs (structure.test.js).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPeopleDir } from '../overlay.mjs';
import { readBoundaries } from '../meet.mjs';
import { readJsonFile } from '../pipeline.mjs';
import { list } from '../proposals.mjs';
import { buildReceipt, compactStamp, inlineInput, isoSeconds } from '../receipt.mjs';
import { writeJsonAtomic } from '../rooms.mjs';
import { fail, pass } from '../rules.mjs';
import { ownerPersonId } from '../scope.mjs';
import { fingerprint, loadKey } from '../sign.mjs';
import { createStore } from '../store.mjs';

export const verb = 'export';
export const leaves = ['export'];
export const usage = 'export [--room <id>] [-o <dir>] [--json]';
export const EXPORT_SCHEMA_VERSION = 'dotfield.export/1';
const PEOPLE_FILES = Object.freeze({ people: 'people.json', circles: 'circles.json', rules: 'share-rules.json', disciplines: 'disciplines.json' });
const PEOPLE_VERSIONS = Object.freeze({ people: 'dotfield.people/1', circles: 'dotfield.circles/1', rules: 'dotfield.share-rules/1', disciplines: 'dotfield.disciplines/1' });

/** A person as it may leave the center: every field but the HMAC handles (owner-only, never exported). */
export function exportablePerson(p) {
  const { handles, ...rest } = p;
  return { ...rest, handles: [] };
}

/** The owner's card for a receiver's `add person <file> --fingerprint "<words>"`: public key and key id, never the private key; null without a key. */
export function selfCard(ctx, self) {
  const owner = ownerPersonId(ctx.config);
  const key = loadKey(ctx.dataDir, owner);
  if (!key.ok) return null;
  const base = self ?? { display_name: owner, disciplines: [], privacy_mode: 'private_live' };
  return { card: { person_id: owner, kind: 'contact', display_name: base.display_name, handles: [], disciplines: base.disciplines ?? [], public_key: key.publicKey, key_id: typeof base.key_id === 'string' ? base.key_id : `${owner}-k1`, privacy_mode: base.privacy_mode ?? 'private_live' }, fingerprint: fingerprint(key.publicKey) };
}

export async function run(args, ctx) {
  const base = { command: verb, argv: args.argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  if (ctx.scope !== 'owner') return buildReceipt({ ...base, status: 'refused', checks: [fail('DF_STORE_SCOPE_REFUSED', { path: '--as', detail: `export is the owner's right; scope ${ctx.scope} exports nothing` })] });
  const only = typeof args.flags.room === 'string' && args.flags.room ? args.flags.room : null;
  const rooms = ctx.rooms().rooms.filter((r) => r.manifest && (!only || r.id === only));
  if (only && !rooms.length) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_ROOM_FILE_MISSING', { path: `center/rooms/${only}`, detail: 'no such room' })] });
  const outDir = typeof args.flags.o === 'string' && args.flags.o ? ctx.absPath(args.flags.o) : join(ctx.dotDir, `export-${compactStamp(ctx.now)}`);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const put = (rel, doc) => { const p = join(outDir, rel); writeJsonAtomic(p, doc); files.push({ rel, path: p }); };
  const checks = [];
  const inputs = [];
  let records = 0;
  for (const room of rooms) {
    const store = createStore({ room, dataDir: ctx.dataDir, scope: 'owner', config: ctx.config, env: ctx.env, root: ctx.root });
    checks.push(...store.checks);
    const rows = await store.read();
    if (store.backend === 'file' && store.exists()) inputs.push(ctx.inputRef(store.path()));
    records += rows.length;
    put(`rooms/${room.id}.json`, { schema_version: EXPORT_SCHEMA_VERSION, room: room.id, namespace: store.namespace, exported_at: isoSeconds(ctx.now), count: rows.length, records: rows });
  }
  const proposals = only ? list({ dataDir: ctx.dataDir, room: only }) : list({ dataDir: ctx.dataDir });
  for (const p of proposals) put(`proposals/${p.proposal_id}.json`, p);
  if (existsSync(join(ctx.centerDir, 'people'))) {
    const pd = loadPeopleDir(ctx.centerDir);
    checks.push(...pd.checks.filter((c) => c.status === 'fail'));
    put(`people/${PEOPLE_FILES.people}`, { schema_version: PEOPLE_VERSIONS.people, people: pd.people.map(exportablePerson) });
    for (const key of ['circles', 'rules', 'disciplines']) put(`people/${PEOPLE_FILES[key]}`, { schema_version: PEOPLE_VERSIONS[key], [key]: pd[key] });
    const card = selfCard(ctx, pd.self);
    if (card) put('people/self-card.json', { schema_version: 'dotfield.person/1', ...card.card, ext: { fingerprint: card.fingerprint, note: 'hand this file and read the fingerprint words out of band; the receiver runs dotfield add person self-card.json --fingerprint "<words>"' } });
  }
  const boundaries = readBoundaries(ctx.dataDir);
  if (boundaries.pairs.length) put('boundaries.json', boundaries);
  const receiptsDir = join(ctx.dotDir, 'receipts');
  let receipts = 0;
  if (existsSync(receiptsDir)) {
    mkdirSync(join(outDir, 'receipts'), { recursive: true });
    for (const f of readdirSync(receiptsDir).filter((x) => x.endsWith('.json')).sort()) {
      const r = readJsonFile(join(receiptsDir, f));
      if (!r.ok) continue;
      copyFileSync(join(receiptsDir, f), join(outDir, 'receipts', f));
      files.push({ rel: `receipts/${f}`, path: join(outDir, 'receipts', f) });
      receipts += 1;
    }
  }
  const entries = files.map((f) => ({ ...ctx.inputRef(f.path), rel: f.rel }));
  put('export.json', { schema_version: EXPORT_SCHEMA_VERSION, exported_at: isoSeconds(ctx.now), center: ctx.config.center.name, rooms: rooms.map((r) => r.id), records, proposals: proposals.length, receipts, handles_excluded: true, files: entries.map(({ rel, digest, bytes }) => ({ path: rel, digest, bytes })) });
  checks.push(pass('DF_STORE_SCOPE_REFUSED'));
  const outputs = files.map((f) => ({ ...ctx.inputRef(f.path), kind: f.rel.split('/')[0].replace(/\.json$/, '') === 'export' ? 'manifest' : f.rel.split('/')[0].replace(/\.json$/, ''), action: 'written' }));
  const receipt = buildReceipt({ ...base, inputs: [...inputs.filter(Boolean), inlineInput('export', { rooms: rooms.map((r) => r.id), proposals: proposals.length, receipts })], checks, outputs, status: 'written', store: { target: 'data/rooms', backend: 'file' },
    nextAction: `${records} record(s) from ${rooms.length} room(s), ${proposals.length} proposal(s), the people directory without handles, the share rules and ${receipts} receipt(s) are under ${ctx.relRef(outDir)} (export.json lists every file). Private keys were not exported${files.some((f) => f.rel === 'people/self-card.json') ? '; people/self-card.json carries your public key for a receiver\'s add person' : ''}.` });
  try { ctx.persistReceipt(receipt, { dir: outDir, index: false }); } catch { /* the index copy is written by bin */ }
  return receipt;
}
