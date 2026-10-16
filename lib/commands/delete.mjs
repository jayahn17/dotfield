// dotfield delete <room> --records <ids>|--all [--token-file <path>]
// (VISION §1, §8.2): delete is a right, and owner-only (the approve owner
// gate: TTY, or the owner token file). It removes the records from the store
// through store.write({approved: true}) and then SWEEPS every derived or
// dependent copy so no file under data/ or .dotfield/ still names them: the
// store .bak, link fields in this and other rooms, renders (scene.json,
// out.html, out.svg), compares (the same plus delta.json), the template demo,
// connect and import scenes, run transcripts and
// run.json, proposals (records and sample rows), overlays' outbound
// projections and any other text file, each listed in outputs[] with
// action removed | redacted. The receipt itself never carries a deleted id
// (argv is recorded with the id list replaced by its digest). One of the
// four allowed importers of lib/store.mjs.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { canonical, sha256, sha256Hex } from '../digest.mjs';
import { buildReceipt, inlineInput } from '../receipt.mjs';
import { fail, pass } from '../rules.mjs';
import { createStore } from '../store.mjs';
import { ownerGate } from './approve.mjs';

export const verb = 'delete';
export const leaves = ['delete'];
export const usage = 'delete <room> --records <id,...>|--all [--token-file <path>] [--json]';
export const REDACTED = '[deleted]';
/** Derived copies a sweep removes outright: renders, compares (dotfield compare), import and connect scenes, the template demo (npm run demo), outbound projections. Authored sketches (.dotfield/sketches/) are redacted like any other file, never removed. */
export const DERIVED_RE = /^(?:\.dotfield\/(?:renders|compares|imports|connect|demo)\/|data\/projections\/)/;
const TEXT_EXT = new Set(['.json', '.html', '.svg', '.md', '.bak', '.csv', '.txt', '.tmp', '.css', '.mjs', '.js']);
const posix = (p) => p.split(sep).join('/');
const BS = String.fromCharCode(92);
const escapeRe = (s) => s.split(BS).join(BS + BS).replace(/[.*+?^${}()|[\]]/g, (c) => BS + c);

/** One regex over every id: an id is matched only when no letter or digit touches it (so note-1 never matches note-10). */
export function idPattern(ids) {
  return new RegExp(`(?<![A-Za-z0-9])(?:${[...ids].map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'g');
}
const mentions = (text, re) => { re.lastIndex = 0; return re.test(text); };

/** Deep-replace the ids inside a record's strings and drop them from the link fields that point at the room. */
export function scrubRecord(record, { re, linkFields, ids }) {
  const walk = (v) => (typeof v === 'string' ? v.replace(re, REDACTED) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  const out = { ...record };
  for (const f of linkFields) {
    if (Array.isArray(out[f])) out[f] = out[f].filter((x) => !ids.has(String(x)));
    else if (out[f] !== undefined && ids.has(String(out[f]))) out[f] = null;
  }
  return walk(out);
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'keys') walkFiles(p, out); } else if (e.isFile() && TEXT_EXT.has(extname(e.name))) out.push(p);
  }
  return out;
}

function writeText(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** Redact one proposal structurally — rows of the deleted room dropped by its id_field, links scrubbed by that room's link fields — then textually. */
function redactProposal(text, re, ids, { roomId, idField, linkFieldsOf }) {
  try {
    const doc = JSON.parse(text);
    const own = doc.room === roomId;
    const fields = linkFieldsOf(doc.room);
    const keep = (r) => !(own && r && typeof r === 'object' && ids.has(String(r[idField])));
    const clean = (r) => (r && typeof r === 'object' ? scrubRecord(r, { re, linkFields: fields, ids }) : r);
    if (Array.isArray(doc.records)) doc.records = doc.records.filter(keep).map(clean);
    if (doc.summary && Array.isArray(doc.summary.sample_rows)) doc.summary.sample_rows = doc.summary.sample_rows.filter(keep).map(clean);
    doc.ext = { ...(doc.ext && typeof doc.ext === 'object' ? doc.ext : {}), redacted_by_delete: { ids: ids.size } };
    return `${JSON.stringify(doc, null, 2)}\n`.replace(re, REDACTED);
  } catch { return text.replace(re, REDACTED); }
}

/** Remove or redact every derived file under data/ and .dotfield/ that still names an id; returns receipt outputs. */
export function sweep(ctx, ids, { skip = new Set(), roomId = null, idField = null, linkFieldsOf = () => [] } = {}) {
  const re = idPattern(ids);
  const outputs = [];
  for (const file of [...walkFiles(ctx.dataDir), ...walkFiles(ctx.dotDir)]) {
    if (skip.has(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!mentions(text, re)) continue;
    const rel = posix(relative(ctx.root, file));
    const derived = DERIVED_RE.test(rel) || file.endsWith('.bak') || file.endsWith('.tmp');
    if (derived) { rmSync(file, { force: true }); outputs.push({ ref: rel, digest: null, kind: 'derived', action: 'removed' }); continue; }
    writeText(file, /^data\/proposals\//.test(rel) ? redactProposal(text, re, ids, { roomId, idField, linkFieldsOf }) : text.replace(re, REDACTED));
    outputs.push({ ...ctx.inputRef(file), kind: /^data\/proposals\//.test(rel) ? 'proposal' : 'derived', action: 'redacted' });
  }
  return outputs;
}

export async function run(args, ctx) {
  const roomId = args._[0];
  const ids = new Set(typeof args.flags.records === 'string' ? args.flags.records.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const all = args.flags.all === true;
  const argv = args.argv.map((a) => (a === args.flags.records && ids.size ? `redacted:${sha256Hex(canonical([...ids].sort())).slice(0, 8)}` : a));
  const base = { command: verb, argv, now: ctx.now, scope: ctx.scope ?? 'owner', viewer: ctx.viewer, root: ctx.packageRoot };
  if (!roomId || (!ids.size && !all)) return buildReceipt({ ...base, status: 'error', nextAction: `usage: dotfield ${usage}` });
  if (!ctx.hasCenter) return buildReceipt({ ...base, status: 'blocked', checks: [fail('DF_SCHEMA_REQUIRED', { path: 'center/center.config.json', detail: 'no center here; run dotfield init' })] });
  const gate = ownerGate(args, ctx);
  if (!gate.ok) return buildReceipt({ ...base, status: 'refused', checks: gate.checks });
  if (ctx.scope !== 'owner') return buildReceipt({ ...base, status: 'refused', checks: [...gate.checks, fail('DF_STORE_SCOPE_REFUSED', { path: '--as', detail: `delete is the owner's right; scope ${ctx.scope} deletes nothing` })] });
  const rooms = ctx.rooms().rooms.filter((r) => r.manifest);
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return buildReceipt({ ...base, status: 'blocked', checks: [...gate.checks, fail('DF_ROOM_FILE_MISSING', { path: `center/rooms/${roomId}`, detail: 'no such valid room' })] });
  const idField = room.manifest.record.id_field;
  const store = createStore({ room, dataDir: ctx.dataDir, scope: 'owner', config: ctx.config, env: ctx.env, root: ctx.root });
  const existing = await store.read();
  if (all) for (const r of existing) if (r[idField] !== undefined && r[idField] !== null) ids.add(String(r[idField]));
  const hit = existing.filter((r) => ids.has(String(r[idField])));
  const checks = [...gate.checks, ...store.checks];
  if (!hit.length) return buildReceipt({ ...base, checks, status: 'read', store: store.target(), maturity: room.manifest.maturity, mode: room.manifest.mode, nextAction: `No record of ${roomId} matched the ${ids.size} id(s); nothing was changed.` });
  const re = idPattern(ids);
  const outputs = [];
  const touched = new Set();
  const rewrite = async (r, s, records) => {
    const w = await s.write(records, { approved: true, now: ctx.now, by: 'delete' });
    if (s.backend === 'file') { touched.add(s.path()); const bak = `${s.path()}.bak`; if (existsSync(bak)) { rmSync(bak, { force: true }); outputs.push({ ref: ctx.relRef(bak), digest: null, kind: 'backup', action: 'removed' }); } }
    outputs.push({ ...(s.backend === 'file' ? ctx.inputRef(s.path()) : { ref: w.target, digest: null }), kind: 'store', action: 'redacted' });
  };
  const linkFieldsTo = (m, target) => m.record.link_fields.filter((l) => l.to_room === target).map((l) => l.field);
  await rewrite(room, store, existing.filter((r) => !ids.has(String(r[idField]))).map((r) => scrubRecord(r, { re, linkFields: linkFieldsTo(room.manifest, roomId), ids })));
  for (const other of rooms.filter((r) => r.id !== roomId && linkFieldsTo(r.manifest, roomId).length)) {
    const s = createStore({ room: other, dataDir: ctx.dataDir, scope: 'owner', config: ctx.config, env: ctx.env, root: ctx.root });
    const before = await s.read();
    const after = before.map((r) => scrubRecord(r, { re, linkFields: linkFieldsTo(other.manifest, roomId), ids }));
    if (canonical(before) !== canonical(after)) await rewrite(other, s, after);
  }
  outputs.push(...sweep(ctx, ids, { skip: touched, roomId, idField, linkFieldsOf: (id) => { const r = rooms.find((x) => x.id === id); return r ? linkFieldsTo(r.manifest, roomId) : []; } }));
  checks.push(pass('DF_STORE_WRITE_WITHOUT_APPROVAL'), pass('DF_STORE_SCOPE_REFUSED'));
  const removed = outputs.filter((o) => o.action === 'removed').length;
  const redacted = outputs.filter((o) => o.action === 'redacted').length;
  return buildReceipt({ ...base, inputs: [inlineInput('deleted', { room: roomId, count: hit.length, digest: sha256(canonical([...ids].sort())) })], checks, outputs, status: 'written', store: store.target(), maturity: room.manifest.maturity, mode: room.manifest.mode,
    nextAction: `${hit.length} record(s) removed from ${store.target().target}; ${removed} derived file(s) removed and ${redacted} redacted so nothing under data/ or .dotfield/ names them. Renders already sent cannot be recalled.` });
}
