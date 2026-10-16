// The local server (VISION §8.5): node:http on 127.0.0.1:4100, same-origin,
// no CORS header ever, every response the receipt envelope. Reads go through
// the one exit door (lib/project.mjs); writes are proposals (lib/proposals.mjs
// propose) until the owner decides on /inbox, and the decide route demands the
// CSRF triple plus the owner token plus a local peer (server/wall.mjs).
// No clock is read here: each request builds a context (lib/context.mjs) and
// takes ctx.now from it, or the fixed `now` a test injects.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fence, spansDigest } from '../lib/agents/fence.mjs';
import { createContext, storeTarget } from '../lib/context.mjs';
import { DIGEST_RE } from '../lib/digest.mjs';
import { applyPairDecision } from '../lib/meet.mjs';
import { applyRuleDecision, loadPeopleDir, originGrants, readOverlays } from '../lib/overlay.mjs';
import { projectDetailed, readRecords } from '../lib/project.mjs';
import { DECISIONS, decide, list, propose, readProposal } from '../lib/proposals.mjs';
import { PACKAGE_ROOT, buildReceipt, engineDigests, engineVersion, inlineInput, isoSeconds, refDigest } from '../lib/receipt.mjs';
import { buildRegistry, discoverRooms } from '../lib/rooms.mjs';
import { fail, pass } from '../lib/rules.mjs';
import { ownerPersonId, resolveScope } from '../lib/scope.mjs';
import { checkDecideGuard, checkWall, isLocalRequest, ownerTokenPath, readOwnerToken, trustedProxyWall } from './wall.mjs';

export const DEFAULT_PORT = 4100;
export const DEFAULT_HOST = '127.0.0.1';
export const INBOX_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'inbox.html');
export const MAX_DECIDE_BODY_BYTES = 4 * 1024 * 1024;
export const BODY_OVERHEAD_BYTES = 64 * 1024;
export const ROOM_RE = '[a-z0-9][a-z0-9_-]{0,39}';
export const PROPOSAL_RE = 'prop_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}';
export const SEGMENT_RE = '[A-Za-z0-9][A-Za-z0-9._-]{0,120}';
export const CONTENT_TYPES = Object.freeze({ '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' });
export const INBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** Failing codes -> HTTP status; anything else maps by exit code (2 -> 422, 3 -> 403, 4 -> 503, 5 -> 502, 1 -> 500). */
export const HTTP_BY_CODE = Object.freeze({
  DF_SERVER_ROUTE_UNKNOWN: 404, DF_SERVER_METHOD_NOT_ALLOWED: 405, DF_SERVER_BODY_INVALID: 400, DF_SERVER_BODY_TOO_LARGE: 413, DF_SERVER_ROOM_UNKNOWN: 404,
  DF_SERVER_WALL_REFUSED: 403, DF_SERVER_DECIDE_REFUSED: 403, DF_STORE_SCOPE_REFUSED: 401, DF_STORE_SCOPE_EMPTY_UID: 400, DF_STORE_FAULT: 503, DF_STORE_CORRUPT: 503,
  DF_PROPOSAL_NOT_FOUND: 404, DF_PROPOSAL_ALREADY_DECIDED: 409, DF_PROPOSAL_NOT_AWAITING: 409, DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH: 409, DF_PROPOSAL_INVALID_DECISION: 400,
  DF_PROPOSAL_MODE_REFUSED: 403, DF_ROOM_VIEW_INVALID: 404, DF_RENDER_UNPROJECTED: 422,
});
const EXIT_HTTP = Object.freeze({ 1: 500, 2: 422, 3: 403, 4: 503, 5: 502 });
export const SOURCE_KINDS = Object.freeze(['record', 'file', 'url', 'import', 'run', 'share']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFail = (c) => c && c.status === 'fail';

export function httpStatusOf(receipt, okStatus = 200) {
  if (receipt.exit_code === 0) return okStatus;
  // A proposal (or a run) waiting for the owner exits 3 on the CLI, but over HTTP the request was accepted: it keeps the route's success status (202 for propose).
  const waiting = (receipt.status === 'proposal' || receipt.status === 'awaiting_owner') && !receipt.checks.some((c) => isFail(c) && c.blocking === true);
  if (waiting) return okStatus;
  for (const c of receipt.checks) if (isFail(c) && HTTP_BY_CODE[c.code]) return HTTP_BY_CODE[c.code];
  return EXIT_HTTP[receipt.exit_code] ?? 500;
}

/** Read or create data/keys/owner.token (0600, tmp + rename); returns the token. */
export function ensureOwnerToken(dataDir) {
  const existing = readOwnerToken(dataDir);
  if (existing) return existing;
  const file = ownerTokenPath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(24).toString('base64url');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return token;
}

/** Collect a request body up to `limit` bytes; {ok, text} or {ok: false, tooLarge: true}. */
export function readBody(req, limit) {
  return new Promise((resolveBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); resolveBody({ ok: false, tooLarge: true, text: '' }); return; }
    const chunks = []; let size = 0; let done = false;
    const finish = (out) => { if (!done) { done = true; resolveBody(out); } };
    req.on('data', (chunk) => { size += chunk.length; if (size > limit) { req.destroy(); finish({ ok: false, tooLarge: true, text: '' }); return; } chunks.push(chunk); });
    req.on('end', () => finish({ ok: true, tooLarge: false, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, tooLarge: false, text: '' }));
  });
}

/** Foreign-owned nodes of a projected scene, each label fenced as data (lib/agents/fence.mjs). */
export function foreignSpansOf(scene, owner) {
  const spans = [];
  for (const n of Array.isArray(scene.nodes) ? scene.nodes : []) {
    const person = n && n.provenance ? n.provenance.owner_person_id : undefined;
    if (!person || person === owner || person === 'self') continue;
    const rule = (n.boundary && n.boundary.rule_ref) || (n.provenance.source && n.provenance.source.imported_via_rule_ref) || null;
    spans.push({ node_id: n.id, person_id: person, rule_ref: rule, text: fence(n.label, { person, rule }) });
  }
  return spans;
}

/** The parts of a proposal the inbox lists: never the records, never a token. */
export function proposalSummary(p) {
  return { proposal_id: p.proposal_id, kind: p.kind, room: p.room, scope: p.scope, by: p.by, source: p.source, status: p.status, created_at: p.created_at, decided_at: p.decided_at, record_count: Array.isArray(p.records) ? p.records.length : 0, summary: p.summary, summary_digest: p.summary_digest, split: p.split, owner_decision: p.owner_decision, receipt_ref: p.receipt_ref };
}

function checkProposeBody(doc) {
  if (!isObject(doc)) return 'DF_SCHEMA_TYPE at $: expected an object {records: [...]}';
  if (!Array.isArray(doc.records)) return 'DF_SCHEMA_REQUIRED at $.records: an array of record objects is required';
  if (doc.records.length > 10000) return 'DF_SCHEMA_MAX_ITEMS at $.records: at most 10000 records per request';
  const bad = doc.records.findIndex((r) => !isObject(r));
  if (bad >= 0) return `DF_SCHEMA_TYPE at $.records[${bad}]: a record is an object`;
  if (doc.by !== undefined && !(typeof doc.by === 'string' && /^[a-z0-9][a-z0-9_.:/-]{0,119}$/.test(doc.by))) return 'DF_SCHEMA_PATTERN at $.by: self, agent:<desk>, import:<kind> or a person id';
  if (doc.kind !== undefined && !['records', 'run'].includes(doc.kind)) return 'DF_SCHEMA_ENUM at $.kind: records | run';
  if (doc.source !== undefined && doc.source !== null) {
    const s = doc.source;
    if (!isObject(s) || !SOURCE_KINDS.includes(s.kind) || typeof s.ref !== 'string' || !s.ref.length || s.ref.length > 1024) return 'DF_SCHEMA_ONE_OF at $.source: null or {kind: record|file|url|import|run|share, ref, digest}';
    if (s.digest !== null && s.digest !== undefined && !DIGEST_RE.test(String(s.digest))) return 'DF_SCHEMA_PATTERN at $.source.digest: null or sha256:<64 hex>';
  }
  return null;
}

function checkDecideBody(doc) {
  if (!isObject(doc)) return 'DF_SCHEMA_TYPE at $: expected an object {decision, reviewed_summary_digest}';
  if (!DECISIONS.includes(doc.decision)) return 'DF_SCHEMA_ENUM at $.decision: approve | edit | reject';
  if (doc.note !== undefined && doc.note !== null && typeof doc.note !== 'string') return 'DF_SCHEMA_TYPE at $.note: a string';
  if (doc.decision === 'edit' && !Array.isArray(doc.edited)) return 'DF_SCHEMA_REQUIRED at $.edited: edit needs the edited records array';
  if (doc.reviewed_summary_digest !== undefined && doc.reviewed_summary_digest !== null && !DIGEST_RE.test(String(doc.reviewed_summary_digest))) return 'DF_SCHEMA_PATTERN at $.reviewed_summary_digest: sha256:<64 hex>';
  return null;
}

/**
 * createServer({root, env, now, ownerToken, centerDir, dataDir, dotDir, config, host, port})
 *   -> {server, handle(req, res), listen({port, host}) -> {port, host, url, inboxUrl, token}, close(), token(), root}
 * Standard layout under root (center/, data/, .dotfield/) unless the dirs are
 * given; `now` fixes the clock for every receipt (tests), else ctx.now.
 */
export function createServer(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const env = options.env ?? process.env;
  const dirs = { centerDir: options.centerDir ?? join(root, 'center'), dataDir: options.dataDir ?? join(root, 'data'), dotDir: options.dotDir ?? join(root, '.dotfield') };
  const engine = { engineDigests: engineDigests(PACKAGE_ROOT), engineVersion: engineVersion(PACKAGE_ROOT) };
  const state = { token: options.ownerToken ?? null };
  const tokenOf = () => state.token ?? readOwnerToken(dirs.dataDir);

  function makeCtx() {
    const base = createContext({ cwd: root, env });
    const memo = {};
    return {
      ...base, ...dirs, root, config: options.config ?? base.config, now: options.now ?? base.now,
      rooms() { if (!memo.rooms) memo.rooms = existsSync(join(dirs.centerDir, 'rooms')) ? discoverRooms(dirs.centerDir, { dotDir: dirs.dotDir }) : { rooms: [], checks: [], ok: true }; return memo.rooms; },
      sessionKey() { try { const t = readFileSync(join(dirs.dataDir, 'keys', 'session.key'), 'utf8').trim(); return t.length ? t : null; } catch { return null; } },
      people() { if (!memo.people) memo.people = existsSync(join(dirs.centerDir, 'people')) ? loadPeopleDir(dirs.centerDir) : { people: [], circles: [], rules: [], disciplines: [], self: null, checks: [] }; return memo.people; },
    };
  }

  const receiptFor = (c, extra = {}) => buildReceipt({
    command: 'serve', argv: ['serve', c.method, c.path], now: c.ctx.now, root, ...engine,
    inputs: [inlineInput('request', { method: c.method, path: c.path, query: c.query })], ...extra,
  });

  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }
  const reply = (c, receipt, okStatus, payload = {}, headers = {}) => send(c.res, httpStatusOf(receipt, okStatus), { ok: receipt.ok, receipt, ...payload }, headers);
  const refuse = (c, check, status = 'refused', extra = {}) => reply(c, receiptFor(c, { checks: [check], status, ...extra }), 200);

  /** The viewer for a read: local requests resolve `for` through the scope rule; remote ones get public or a 401. */
  function viewerOf(c, forParam) {
    if (c.local) { const r = resolveScope({ config: c.ctx.config, as: forParam }); return r.ok ? { ok: true, viewer: r.viewer, scope: r.scope } : { ok: false, check: r.checks.find(isFail), scope: null }; }
    if (forParam === null || forParam === 'public') return { ok: true, viewer: 'public', scope: 'public' };
    const r = resolveScope({ config: c.ctx.config, origin: 'remote', session: null });
    return { ok: false, check: r.checks.find(isFail), scope: null };
  }
  function roomOf(c, id) {
    const d = c.ctx.rooms();
    const room = d.rooms.find((r) => r.id === id && r.ok && r.manifest);
    if (!room) refuse(c, fail('DF_SERVER_ROOM_UNKNOWN', { path: c.path, detail: `no valid room '${id}' in the center` }));
    return room;
  }
  function gate(c, opts) {
    const w = checkWall({ req: c.req, env, ownerId: c.owner, path: c.path, ...opts });
    if (!w.ok) refuse(c, w.check);
    return w;
  }

  async function health(c) {
    const d = c.ctx.hasCenter ? c.ctx.rooms() : { rooms: [] };
    reply(c, receiptFor(c, { status: 'read', checks: [pass('DF_SERVER_ROUTE_UNKNOWN')], nextAction: 'The server is up; GET /api/registry lists the rooms.' }), 200,
      { engine_version: engine.engineVersion, center: c.ctx.config && c.ctx.config.center ? c.ctx.config.center.name : null, rooms: d.rooms.filter((r) => r.ok).length, local: c.local, now: isoSeconds(c.ctx.now) });
  }
  async function registry(c) {
    const w = gate(c, { viewer: 'public' }); if (!w.ok) return;
    const d = c.ctx.rooms();
    const reg = buildRegistry(d.rooms, c.ctx.config);
    if (!w.local && !w.trusted) reg.rooms = reg.rooms.filter((r) => r.privacy_mode !== 'private_live');
    reply(c, receiptFor(c, { status: 'read', checks: [w.check], viewer: c.local ? 'self' : 'public', scope: c.local ? 'owner' : 'public' }), 200, { registry: reg, invalid: reg.invalid });
  }
  async function records(c, id) {
    const room = roomOf(c, id); if (!room) return;
    const v = viewerOf(c, c.url.searchParams.get('for')); if (!v.ok) return refuse(c, v.check);
    const w = gate(c, { room, viewer: v.viewer }); if (!w.ok) return;
    const p = c.ctx.people();
    const read = await readRecords({ room, viewer: v.viewer, rules: p.rules, circles: p.circles, grants: originGrants(readOverlays(c.ctx.dataDir)), dataDir: c.ctx.dataDir, config: c.ctx.config, env, root, now: c.ctx.now });
    const receipt = receiptFor(c, { checks: [w.check, ...read.checks], status: read.ok ? 'read' : 'blocked', viewer: v.viewer, scope: v.scope, mode: room.manifest.mode, maturity: room.manifest.maturity, store: read.store ? read.store.target() : null, blockedActions: room.manifest.blocked_actions });
    reply(c, receipt, 200, { room: id, viewer: read.viewer, count: read.records.length, records: read.ok ? read.records : [] });
  }
  async function scene(c, id) {
    const room = roomOf(c, id); if (!room) return;
    const q = c.url.searchParams;
    const v = viewerOf(c, q.get('for')); if (!v.ok) return refuse(c, v.check);
    const w = gate(c, { room, viewer: v.viewer }); if (!w.ok) return;
    const views = Array.isArray(room.views) ? room.views : [];
    const want = q.get('view');
    const viewSpec = want ? views.find((x) => x.id === want) : views[0];
    if (want && !viewSpec) return refuse(c, fail('DF_ROOM_VIEW_INVALID', { path: `center/rooms/${id}/views.json`, detail: `no view '${want}'` }), 'blocked');
    const sessionKey = c.ctx.sessionKey();
    if (!sessionKey) return refuse(c, fail('DF_RENDER_UNPROJECTED', { path: 'data/keys/session.key', detail: 'absent, so nothing can be projected; run dotfield init' }), 'blocked');
    const limit = {};
    if (q.get('focus')) limit.focus = q.get('focus');
    if (q.get('reach')) limit.reach = q.get('reach');
    if (q.get('lens')) limit.lens = q.get('lens');
    if (/^[0-9]{1,6}$/.test(q.get('max_nodes') ?? '')) limit.max_nodes = Number(q.get('max_nodes'));
    const p = c.ctx.people();
    const r = await projectDetailed({ rooms: c.ctx.rooms(), viewer: v.viewer, rules: p.rules, circles: p.circles, view: { room: id, view: viewSpec ? viewSpec.id : null }, limit, now: c.ctx.now, dataDir: c.ctx.dataDir, config: c.ctx.config, env, root, sessionKey });
    const spans = foreignSpansOf(r.scene, c.owner);
    const ok = !r.checks.some((x) => isFail(x) && x.blocking);
    const receipt = receiptFor(c, { checks: [w.check, ...r.checks], status: ok ? 'read' : 'blocked', viewer: v.viewer, scope: v.scope, mode: room.manifest.mode, maturity: room.manifest.maturity, foreignSpansDigest: spansDigest(spans), blockedActions: room.manifest.blocked_actions });
    reply(c, receipt, 200, { room: id, view: viewSpec ? viewSpec.id : null, viewer: r.viewer, dropped: r.dropped, scene: ok ? r.scene : null, foreign_spans: spans });
  }
  async function proposeRoute(c, id) {
    const room = roomOf(c, id); if (!room) return;
    const scope = c.local ? resolveScope({ config: c.ctx.config }) : resolveScope({ config: c.ctx.config, origin: 'remote', session: null });
    if (!scope.ok) { c.req.resume(); return refuse(c, scope.checks.find(isFail)); }
    const max = c.ctx.config && c.ctx.config.approval && Number.isInteger(c.ctx.config.approval.max_records_per_proposal) ? c.ctx.config.approval.max_records_per_proposal : 200;
    const body = await readBody(c.req, max * (room.manifest.store.max_record_bytes || 16384) + BODY_OVERHEAD_BYTES);
    if (body.tooLarge) return refuse(c, fail('DF_SERVER_BODY_TOO_LARGE', { path: c.path, detail: `more than ${max} records of ${room.manifest.store.max_record_bytes} bytes` }), 'blocked');
    let doc; try { doc = JSON.parse(body.text); } catch (e) { return refuse(c, fail('DF_SERVER_BODY_INVALID', { path: c.path, detail: `DF_SCHEMA_TYPE at $: not JSON (${e.message})` }), 'blocked'); }
    const problem = checkProposeBody(doc);
    if (problem) return refuse(c, fail('DF_SERVER_BODY_INVALID', { path: c.path, detail: problem }), 'blocked');
    const result = await propose({ room, records: doc.records, by: doc.by ?? 'self', scope: scope.scope, kind: doc.kind ?? 'records', now: c.ctx.now, dataDir: c.ctx.dataDir, config: c.ctx.config, env, argv: ['serve', c.method, c.path], root, source: doc.source === undefined ? { kind: 'import', ref: `http:${c.path}`, digest: inlineInput('records', doc.records).digest } : doc.source });
    const first = result.proposal;
    reply(c, result.receipt, 202, { proposal_id: first ? first.proposal_id : null, proposal_ids: result.proposals.map((p) => p.proposal_id), status: result.ok ? 'awaiting_owner' : result.receipt.status, summary: first ? first.summary : null, summary_digest: first ? first.summary_digest : null,
      next_required_step: result.ok ? `The owner reviews ${first.proposal_id} on /inbox or with dotfield approve ${first.proposal_id} --decision approve|edit|reject; nothing is written until then.` : result.receipt.next_action });
  }
  async function proposals(c) {
    const w = gate(c, { viewer: 'self', ownerOnly: true }); if (!w.ok) return;
    const status = c.url.searchParams.get('status') ?? 'awaiting_owner';
    const items = list({ dataDir: c.ctx.dataDir, status: status === 'all' ? null : status, room: c.url.searchParams.get('room') }).map(proposalSummary);
    reply(c, receiptFor(c, { status: 'read', checks: [w.check], ownerDecision: { state: items.length ? 'awaiting_owner' : 'not_required' } }), 200, { count: items.length, status, proposals: items });
  }
  async function proposalOne(c, id) {
    const w = gate(c, { viewer: 'self', ownerOnly: true }); if (!w.ok) return;
    const found = readProposal(c.ctx.dataDir, id);
    if (!found.ok) return refuse(c, found.check);
    reply(c, receiptFor(c, { status: 'read', checks: [w.check, found.check] }), 200, { proposal: found.proposal });
  }
  async function decideRoute(c, id) {
    const guard = checkDecideGuard({ req: c.req, token: tokenOf() });
    if (!guard.ok) { c.req.resume(); return refuse(c, guard.check); }
    const body = await readBody(c.req, MAX_DECIDE_BODY_BYTES);
    if (body.tooLarge) return refuse(c, fail('DF_SERVER_BODY_TOO_LARGE', { path: c.path, detail: `the decide body exceeds ${MAX_DECIDE_BODY_BYTES} bytes` }), 'blocked');
    let doc; try { doc = JSON.parse(body.text); } catch (e) { return refuse(c, fail('DF_SERVER_BODY_INVALID', { path: c.path, detail: `DF_SCHEMA_TYPE at $: not JSON (${e.message})` }), 'blocked'); }
    const problem = checkDecideBody(doc);
    if (problem) return refuse(c, fail('DF_SERVER_BODY_INVALID', { path: c.path, detail: problem }), 'blocked');
    const result = await decide(id, { decision: doc.decision, note: doc.note ?? null, edited: doc.edited ?? null, reviewedDigest: doc.reviewed_summary_digest ?? null, now: c.ctx.now, dataDir: c.ctx.dataDir, dotDir: c.ctx.dotDir, rooms: c.ctx.rooms().rooms, config: c.ctx.config, env, argv: ['approve', id, '--decision', doc.decision, '--via', 'inbox'], root, by: 'self' });
    let effect = null;
    const p = result.proposal;
    if (p && !result.idempotent && ['approved', 'edited'].includes(p.status)) {
      if (p.kind === 'rule') effect = applyRuleDecision({ proposal: p, centerDir: c.ctx.centerDir, now: c.ctx.now, receiptRef: p.receipt_ref });
      if (p.kind === 'pair') effect = applyPairDecision({ proposal: p, dataDir: c.ctx.dataDir, now: c.ctx.now });
    }
    reply(c, result.receipt, 200, { proposal: p ? proposalSummary(p) : null, written: result.written, applied: result.applied, idempotent: result.idempotent, effect, receipt_path: result.receiptPath ? relative(root, result.receiptPath) : null });
  }
  async function renders(c, id, file) {
    const w = gate(c, { viewer: 'self', ownerOnly: true }); if (!w.ok) return;
    const dir = join(c.ctx.dotDir, 'renders', id);
    const abs = resolve(dir, file);
    const rel = relative(dir, abs);
    if (!rel || rel.startsWith('..') || !existsSync(abs) || !statSync(abs).isFile()) return refuse(c, fail('DF_SERVER_ROUTE_UNKNOWN', { path: c.path, detail: 'no such render file' }));
    const data = readFileSync(abs);
    c.res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(abs)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Length': data.length });
    c.res.end(data);
  }
  async function inbox(c) {
    const w = gate(c, { viewer: 'self', ownerOnly: true }); if (!w.ok) return;
    send(c.res, 200, readFileSync(INBOX_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': INBOX_CSP });
  }

  /** VISION §5: an empty store of a synthetic room is seeded from examples.json — as a proposal by 'serve:seed' that the owner's own serve approves on the spot, so the write is receipted and reversible. */
  async function seedExamples(ctx) {
    const out = [];
    for (const room of ctx.rooms().rooms) {
      const m = room.manifest;
      if (!room.ok || !m || m.privacy_mode === 'private_live' || m.mode !== 'proposal_only' || !Array.isArray(room.examples) || !room.examples.length) continue;
      const target = storeTarget(room, ctx);
      if (!target || target.backend !== 'file' || existsSync(join(root, target.target))) continue;
      const file = room.files['examples.json'];
      const source = { kind: 'file', ref: `center/rooms/${room.id}/examples.json`, digest: file ? (refDigest(file, root) || {}).digest ?? null : null };
      const common = { now: ctx.now, dataDir: ctx.dataDir, config: ctx.config, env, root, by: 'serve:seed' };
      const p = await propose({ ...common, room, records: room.examples, argv: ['serve', 'seed', room.id], source });
      if (!p.ok) { out.push({ room: room.id, seeded: false, status: p.receipt.status, proposal_id: null }); continue; }
      const d = await decide(p.proposal.proposal_id, { ...common, decision: 'approve', note: 'seeded from examples.json by dotfield serve on an empty store', reviewedDigest: p.proposal.summary_digest, dotDir: ctx.dotDir, rooms: ctx.rooms().rooms, argv: ['serve', 'seed', room.id, '--decision', 'approve'] });
      out.push({ room: room.id, seeded: d.ok, status: d.receipt.status, proposal_id: p.proposal.proposal_id, count: d.written ? d.written.count : 0 });
    }
    return out;
  }

  const routes = [
    { method: 'GET', re: /^\/health$/, run: health }, { method: 'GET', re: /^\/api\/registry$/, run: registry },
    { method: 'GET', re: new RegExp(`^/api/rooms/(${ROOM_RE})/records$`), run: records }, { method: 'GET', re: new RegExp(`^/api/rooms/(${ROOM_RE})/scene$`), run: scene },
    { method: 'POST', re: new RegExp(`^/api/rooms/(${ROOM_RE})/propose$`), run: proposeRoute },
    { method: 'GET', re: /^\/api\/proposals$/, run: proposals }, { method: 'GET', re: new RegExp(`^/api/proposals/(${PROPOSAL_RE})$`), run: proposalOne },
    { method: 'POST', re: new RegExp(`^/api/proposals/(${PROPOSAL_RE})/decide$`), run: decideRoute },
    { method: 'GET', re: new RegExp(`^/renders/(${SEGMENT_RE})/(${SEGMENT_RE})$`), run: renders }, { method: 'GET', re: /^\/inbox\/?$/, run: inbox },
  ];

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = String(req.method ?? 'GET').toUpperCase();
    const c = { req, res, url, method, path: url.pathname, query: Object.fromEntries(url.searchParams), ctx: null, local: isLocalRequest(req), owner: 'self' };
    try {
      c.ctx = makeCtx();
      c.owner = ownerPersonId(c.ctx.config);
      const matching = routes.map((r) => ({ r, m: r.re.exec(c.path) })).filter((x) => x.m);
      if (!matching.length) { req.resume(); return refuse(c, fail('DF_SERVER_ROUTE_UNKNOWN', { path: c.path })); }
      const hit = matching.find((x) => x.r.method === method);
      if (!hit) { req.resume(); return reply(c, receiptFor(c, { checks: [fail('DF_SERVER_METHOD_NOT_ALLOWED', { path: c.path, detail: `${method} is not allowed; no CORS preflight is answered` })], status: 'refused' }), 200, {}, { Allow: [...new Set(matching.map((x) => x.r.method))].join(', ') }); }
      await hit.r.run(c, ...hit.m.slice(1));
    } catch (e) {
      const code = e && typeof e.code === 'string' && e.code.startsWith('DF_STORE_') ? e.code : null;
      const check = code ? (e.check ?? fail(code, { path: c.path, detail: e.message })) : { code: 'DF_SERVER_ROUTE_UNKNOWN', gate: 'server', blocking: true, status: 'fail', path: c.path, message: `unexpected error: ${e && e.message ? e.message : String(e)}`, repair: 'Read the server log and run the request again.' };
      if (!res.headersSent) reply(c, receiptFor(c, { checks: [check], status: code ? 'blocked' : 'error' }), 200);
      else res.end();
    }
  }

  const server = httpServer((req, res) => { handle(req, res); });
  const api = {
    server, handle, root, dirs, token: () => tokenOf(), trusted: () => trustedProxyWall(env), seed: () => seedExamples(makeCtx()),
    async listen({ port = options.port ?? DEFAULT_PORT, host = options.host ?? DEFAULT_HOST, seed = options.seed === true } = {}) {
      state.token = state.token ?? ensureOwnerToken(dirs.dataDir);
      const seeded = seed ? await seedExamples(makeCtx()) : [];
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          const a = server.address();
          const h = a.address.includes(':') ? `[${a.address}]` : a.address;
          const base = `http://${h}:${a.port}`;
          resolveListen({ port: a.port, host: a.address, url: base, inboxUrl: `${base}/inbox?t=${encodeURIComponent(state.token)}`, token: state.token, seeded });
        });
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
  };
  return api;
}

/** `node server/serve.mjs [--port N] [--host H]`: the inbox URL carries the token only on a TTY. */
export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, cwd = process.cwd() } = {}) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1]; };
  const ctx = createContext({ cwd, env });
  const cfg = ctx.config && ctx.config.server ? ctx.config.server : {};
  const port = Number(flag('port') || cfg.port || DEFAULT_PORT);
  const host = flag('host') || cfg.host || DEFAULT_HOST;
  const app = createServer({ root: ctx.root, env, seed: !argv.includes('--no-seed') });
  const info = await app.listen({ port, host });
  for (const s of info.seeded) stdout.write(`seeded ${s.room}: ${s.seeded ? `${s.count} example record(s) via ${s.proposal_id}` : s.status}\n`);
  stdout.write(`dotfield serve: ${info.url} (center ${ctx.hasCenter ? ctx.root : 'absent'}; owner token ${relative(ctx.root, ownerTokenPath(ctx.dataDir))})\n`);
  stdout.write(stdout.isTTY ? `inbox: ${info.inboxUrl}\n` : 'inbox: /inbox?t=<owner token> — the URL with the token is printed only on a TTY\n');
  return app;
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  main().catch((e) => { process.stderr.write(`dotfield serve failed: ${e && e.message ? e.message : String(e)}\n`); process.exitCode = 1; });
}
