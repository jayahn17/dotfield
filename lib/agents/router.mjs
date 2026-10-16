// route(task, roster, opts): deterministic keyword/domain scoring shared by
// plan, run and the MCP dotfield_plan tool (DF_RUN_ROUTE_PARITY holds because
// there is one function). Integer weights, stable tie-breaks by id, no clock,
// no randomness; routing is keyword-shallow by design (VISION 13).
import { fail, pass } from '../rules.mjs';
import { desksForRooms } from './roster.mjs';

export const MAX_SPECIALISTS = 5;
export const MAX_TOKENS = 64;
export const WEIGHTS = Object.freeze({ keyword: 3, keyword_prefix: 2, domain: 2, primary_field: 2, adjacent_field: 1, name: 1 });
export const STOPWORDS = Object.freeze(new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'this', 'that', 'these', 'those', 'it', 'its', 'my', 'our', 'your', 'me', 'we', 'you', 'i', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'what', 'which', 'who', 'how', 'why', 'when', 'where', 'please', 'about', 'into', 'over', 'last', 'next',
  'week', 'weeks', 'day', 'days', 'all', 'any', 'some', 'more', 'most', 'than', 'then', 'not', 'no', 'yes', 'up', 'out', 'if', 'so',
]));

/** Lower-case word tokens, stopwords and one-character tokens dropped, order kept, de-duplicated, capped at MAX_TOKENS. */
export function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

function matchTerm(term, tokens) {
  const parts = tokenize(term);
  if (!parts.length) return 0;
  let hit = 0;
  for (const p of parts) if (tokens.includes(p)) hit += 1;
  return hit === parts.length ? 2 : hit ? 1 : 0;
}

function prefixHit(keyword, tokens) {
  const k = keyword.toLowerCase();
  if (k.length < 4) return false;
  return tokens.some((t) => t.length >= 4 && (t.startsWith(k) || k.startsWith(t)));
}

/** scoreDesk(desk, tokens) -> {score, matched[]}: integer score and the terms that matched, sorted. */
export function scoreDesk(desk, tokens) {
  let score = 0;
  const matched = new Set();
  for (const kw of desk.keywords || []) {
    const m = matchTerm(kw, tokens);
    if (m === 2) { score += WEIGHTS.keyword; matched.add(`keyword:${kw}`); } else if (m === 1 || prefixHit(kw, tokens)) { score += WEIGHTS.keyword_prefix; matched.add(`keyword~${kw}`); }
  }
  if (matchTerm(desk.domain, tokens)) { score += WEIGHTS.domain; matched.add(`domain:${desk.domain}`); }
  if (matchTerm(desk.primary_field, tokens)) { score += WEIGHTS.primary_field; matched.add(`primary_field:${desk.primary_field}`); }
  for (const f of desk.adjacent_fields || []) if (matchTerm(f, tokens)) { score += WEIGHTS.adjacent_field; matched.add(`adjacent_field:${f}`); }
  if (matchTerm(desk.id.replace(/-/g, ' '), tokens) || matchTerm(desk.display, tokens)) { score += WEIGHTS.name; matched.add(`name:${desk.id}`); }
  return { score, matched: [...matched].sort() };
}

const byScoreThenId = (a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const entry = (d, s, extra = {}) => ({ id: d.id, room: d.room ?? null, tier: d.tier, score: s.score, matched: s.matched, ...extra });

function pickChallenger(desks, scored, specialistIds) {
  const taken = new Set(specialistIds);
  const free = desks.filter((d) => !taken.has(d.id));
  const sc = (d) => scored.find((s) => s.id === d.id).score;
  const overlap = free.map((d) => ({ d, n: (d.challenger_for || []).filter((x) => taken.has(x)).length })).filter((x) => x.n > 0)
    .sort((a, b) => (b.n - a.n) || (sc(b.d) - sc(a.d)) || (a.d.id < b.d.id ? -1 : 1));
  if (overlap.length) return entry(overlap[0].d, { score: sc(overlap[0].d), matched: [] }, { reason: `challenger_for ${overlap[0].d.challenger_for.filter((x) => taken.has(x)).sort().join(',')}` });
  const tiered = free.filter((d) => d.tier === 'challenger').map((d) => ({ d, score: sc(d) })).sort((a, b) => (b.score - a.score) || (a.d.id < b.d.id ? -1 : 1));
  if (tiered.length) return entry(tiered[0].d, { score: tiered[0].score, matched: [] }, { reason: 'tier challenger' });
  const declared = free.filter((d) => (d.challenger_for || []).length).map((d) => ({ d, score: sc(d) })).sort((a, b) => (b.score - a.score) || (a.d.id < b.d.id ? -1 : 1));
  if (declared.length) return entry(declared[0].d, { score: declared[0].score, matched: [] }, { reason: 'declares challenger_for' });
  return null;
}

/**
 * route(task, roster, {rooms, terms, desks}) ->
 *   {task, tokens, specialists[], challenger, scored[], checks, ok}
 * rooms: restrict to desks of these room ids (--rooms / --between);
 * terms: extra scoring terms (discipline labels of a --with person);
 * desks: explicit specialist ids (DF_RUN_DESK_UNKNOWN / DF_RUN_TOO_MANY_DESKS).
 * Specialists: the top five scoring non-challenger-tier desks (when the task
 * matches only challenger-tier desks, the best of them is promoted); the challenger
 * is a desk outside them whose challenger_for names one of them, else a
 * challenger-tier desk, else any desk declaring challenger_for.
 */
export function route(task, roster, { rooms = null, terms = [], desks: explicit = null } = {}) {
  const checks = [];
  const tokens = tokenize([String(task ?? ''), ...(Array.isArray(terms) ? terms : [])].join(' '));
  const desks = desksForRooms(roster, rooms);
  const scored = desks.map((d) => entry(d, scoreDesk(d, tokens))).sort(byScoreThenId);
  let specialists;
  if (Array.isArray(explicit)) {
    const unknown = explicit.filter((id) => !desks.some((d) => d.id === id));
    unknown.forEach((id) => checks.push(fail('DF_RUN_DESK_UNKNOWN', { path: `$.desks[${explicit.indexOf(id)}]`, detail: `'${id}' is not in the merged roster${rooms ? ` for rooms ${rooms.join(',')}` : ''}` })));
    if (!unknown.length) checks.push(pass('DF_RUN_DESK_UNKNOWN'));
    specialists = scored.filter((s) => explicit.includes(s.id));
    if (specialists.length > MAX_SPECIALISTS) checks.push(fail('DF_RUN_TOO_MANY_DESKS', { path: '$.desks', detail: `${specialists.length} desks named` }));
    else checks.push(pass('DF_RUN_TOO_MANY_DESKS'));
  } else {
    checks.push(pass('DF_RUN_DESK_UNKNOWN'));
    specialists = scored.filter((s) => s.score > 0 && s.tier !== 'challenger').slice(0, MAX_SPECIALISTS);
    if (!specialists.length) {
      // A room whose only desk is a challenger (a pack's skeptic) would refuse every task about it: the best-matching challenger acts as the specialist for this run, and pickChallenger finds another desk to challenge it.
      const top = scored.find((s) => s.score > 0 && s.tier === 'challenger');
      if (top) specialists = [{ ...top, reason: 'promoted: the task matched only challenger desks' }];
    }
    checks.push(pass('DF_RUN_TOO_MANY_DESKS'));
  }
  if (specialists.length) checks.push(pass('DF_RUN_NO_SPECIALISTS'));
  else checks.push(fail('DF_RUN_NO_SPECIALISTS', { path: '$.task', detail: `no desk keyword, domain or field matched [${tokens.slice(0, 8).join(' ')}]` }));
  const challenger = pickChallenger(desks, scored, specialists.map((s) => s.id));
  if (challenger) checks.push(pass('DF_RUN_NO_CHALLENGER'));
  else checks.push(fail('DF_RUN_NO_CHALLENGER', { path: '$.routing.challenger', detail: `${desks.length} desk(s) in scope, none outside the specialists declares challenger_for or tier challenger` }));
  return { task: String(task ?? ''), tokens, specialists, challenger, scored, checks, ok: !checks.some((c) => c.status === 'fail' && c.blocking) };
}

/** The specialist ids plus the challenger id, in run order: what plan prints and run must reproduce. */
export function routedDesks(routing) {
  const ids = routing.specialists.map((s) => s.id);
  if (routing.challenger) ids.push(routing.challenger.id);
  return ids;
}

/**
 * plan(task, roster, opts) -> {task, tokens, specialists[ids], challenger, desks[ids], scored[{id, room, tier, score, matched}], checks, ok}
 * What `dotfield plan` prints and the MCP dotfield_plan tool returns: the
 * same route() call run() makes, reduced to ids. No tokens are spent.
 */
export function plan(task, roster, opts = {}) {
  const r = route(task, roster, opts);
  return {
    task: r.task, tokens: r.tokens,
    specialists: r.specialists.map((s) => s.id),
    challenger: r.challenger ? r.challenger.id : null,
    desks: routedDesks(r),
    scored: r.scored.map((s) => ({ id: s.id, room: s.room, tier: s.tier, score: s.score, matched: s.matched })),
    checks: r.checks, ok: r.ok,
  };
}
