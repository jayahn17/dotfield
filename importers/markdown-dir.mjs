// A folder of markdown notes → records for a notes-shaped room plus link
// edges: [[wiki-links]] and [text](other.md) become links, #tags become tags,
// a small front-matter subset (title, date, tags, score, happened_on,
// logged_on) is honoured, the first heading or the file name is the title.
// Field names come from the room manifest (id/label/sublabel/tag/link/date
// fields); without a room the starter notes shape is used.
import { checkRecords } from '../lib/proposals.mjs';
import { clip, dateOf, fail, hasBlocking, idMinter, importChecks, isObject, slug, sourceDescriptor, tagList } from './common.mjs';
import { coerceDate, roomOf } from './records.mjs';

export const id = 'markdown-dir';
const WIKI_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;
const TAG_RE = /(?:^|[\s(])#([a-z][a-z0-9_/-]*)/gi;
const DEFAULT_FIELDS = { id: 'note_id', label: 'title', sublabel: 'body', tags: 'tags', links: 'links', remembered_on: 'logged_on', happened_on: 'happened_on', weight: 'score' };

export function detect(input) {
  return !!(input && Array.isArray(input.files) && input.files.some((f) => /\.(md|markdown)$/i.test(f.rel)));
}

/** {meta, body}: a leading --- block of key: value lines (tags as [a, b], "a, b" or - items). */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let current = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && current) { meta[current] = [...(Array.isArray(meta[current]) ? meta[current] : []), item[1].trim()]; continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    current = kv[1].toLowerCase();
    let v = kv[2].trim();
    if (v === '') { meta[current] = []; continue; }
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    meta[current] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

const normalizeName = (s) => String(s).toLowerCase().replace(/\.(md|markdown)$/i, '').replace(/^.*\//, '').replace(/[\s_]+/g, '-').trim();

function fieldsOf(manifest) {
  const r = manifest && isObject(manifest.record) ? manifest.record : null;
  if (!r) return { ...DEFAULT_FIELDS };
  const link = Array.isArray(r.link_fields) && r.link_fields[0] && typeof r.link_fields[0].field === 'string' ? r.link_fields[0].field : null;
  return {
    id: r.id_field, label: r.label_field ?? null, sublabel: r.sublabel_field ?? null, tags: r.tag_field ?? null, links: link,
    remembered_on: r.dates && r.dates.remembered_on ? r.dates.remembered_on : null, happened_on: r.dates && r.dates.happened_on ? r.dates.happened_on : null,
    weight: r.weight_field ?? null,
  };
}

function maxLengthOf(recordSchema, field, fallback) {
  const p = recordSchema && isObject(recordSchema.properties) && isObject(recordSchema.properties[field]) ? recordSchema.properties[field] : null;
  return p && Number.isInteger(p.maxLength) ? p.maxLength : fallback;
}

export function run(input, opts = {}) {
  const files = (input && Array.isArray(input.files) ? input.files : []).filter((f) => /\.(md|markdown)$/i.test(f.rel));
  const fails = [];
  if (!input || !Array.isArray(input.files)) fails.push(fail('DF_IMPORT_FILE_UNREADABLE', { path: '$', detail: 'expected a folder of markdown files' }));
  else if (!files.length) fails.push(fail('DF_IMPORT_EMPTY', { path: '$', detail: `${input.name} holds no .md files` }));
  const checks = importChecks(fails);
  const { manifest, recordSchema } = roomOf(opts);
  const room = manifest ? manifest.id : 'notes';
  if (hasBlocking(checks)) return { kind: 'records', importer: id, room, records: [], edges: [], unresolved: [], checks, ok: false, source: sourceDescriptor(id, input) };

  const today = dateOf(opts.now);
  const F = fieldsOf(manifest);
  const ids = idMinter();
  const notes = files.map((f) => {
    const { meta, body } = frontMatter(f.text.replace(/^﻿/, ''));
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(body);
    const title = clip(meta.title ?? (heading ? heading[1] : f.rel.replace(/\.(md|markdown)$/i, '').replace(/^.*\//, '')), 120) || 'untitled';
    const noteId = ids.mint(f.rel.replace(/\.(md|markdown)$/i, ''), 'note');
    return { rel: f.rel, id: noteId, title, meta, body, names: new Set([normalizeName(f.rel), normalizeName(title)]) };
  });
  const byName = new Map();
  for (const n of notes) for (const name of n.names) if (!byName.has(name)) byName.set(name, n.id);

  const edges = [];
  const unresolved = [];
  const records = notes.map((n) => {
    const prose = n.body.replace(/```[\s\S]*?```/g, '');
    const targets = [];
    for (const m of prose.matchAll(WIKI_RE)) targets.push(m[1].trim());
    for (const m of prose.matchAll(MD_LINK_RE)) targets.push(decodeURIComponent(m[1]));
    const links = [];
    for (const t of targets) {
      const hit = byName.get(normalizeName(t));
      const target = hit ?? slug(normalizeName(t), 'note');
      if (!hit && !unresolved.some((u) => u.from === n.id && u.target === t)) unresolved.push({ from: n.id, target: t, id: target });
      if (target !== n.id && !links.includes(target)) links.push(target);
    }
    for (const to of links) edges.push({ id: `e${edges.length + 1}`, from: n.id, to, kind: 'link', directed: true, variant: 'solid', route: 'auto' });
    const tags = tagList([...(Array.isArray(n.meta.tags) ? n.meta.tags : (typeof n.meta.tags === 'string' ? n.meta.tags.split(',') : [])), ...[...prose.matchAll(TAG_RE)].map((m) => m[1])], 16);
    const rec = { [F.id]: n.id };
    if (F.label) rec[F.label] = n.title;
    if (F.sublabel) { const body = clip(prose.replace(/^\s*#.*$/m, ''), maxLengthOf(recordSchema, F.sublabel, 4000)); if (body) rec[F.sublabel] = body; }
    if (F.tags) rec[F.tags] = tags;
    if (F.links) rec[F.links] = links;
    if (F.remembered_on) rec[F.remembered_on] = coerceDate(n.meta.logged_on ?? n.meta.date ?? today);
    if (F.happened_on && (n.meta.happened_on ?? n.meta.date)) rec[F.happened_on] = coerceDate(n.meta.happened_on ?? n.meta.date);
    if (F.weight && n.meta.score !== undefined && Number.isFinite(Number(n.meta.score))) rec[F.weight] = Number(n.meta.score);
    return rec;
  });
  if (manifest && recordSchema) checks.push(...checkRecords({ manifest, recordSchema }, records));
  return { kind: 'records', importer: id, room, records, edges, unresolved, checks, ok: !hasBlocking(checks), source: sourceDescriptor(id, input) };
}
