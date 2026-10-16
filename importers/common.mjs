// Shared helpers for importers/*.mjs: loading a source (file or folder),
// ids and dates, the scene skeleton every scene importer fills, evidence
// entries, and the one check shape. Importers never read a store, never
// write a file and never look at a clock: callers pass `now`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ABSOLUTE_PATH_RE, codesForFamily, fail, pass } from '../lib/rules.mjs';
import { HMAC_RE, canonical, isDigest, sha256 } from '../lib/digest.mjs';
import { HANDLE_KEYS, KEY_MATERIAL_KEYS } from '../lib/gates/privacy.mjs';

export const SCHEMA_VERSION = 'dotfield.scene/1';
export const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
export const SERIES = Object.freeze(['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6']);
export const IMPORT_CODES = Object.freeze(codesForFamily('import'));
export const MAX_LABEL = 120;
export const MAX_SUBLABEL = 200;
export const MAX_TAG = 40;
export const MAX_TAGS = 32;

/** The DF_IMPORT_* list with one pass entry per code the fails list does not name. */
export function importChecks(fails = []) {
  const out = [...fails];
  for (const code of IMPORT_CODES) if (!out.some((c) => c.code === code)) out.push(pass(code));
  return out;
}

export function hasBlocking(checks) {
  return checks.some((c) => c.status === 'fail' && c.blocking);
}

/** A loaded source: {path, name, ext, text?, doc?, files?} (files for a folder: [{rel, text}]). */
export function loadInput(path) {
  const st = statSync(path);
  const name = basename(path);
  if (st.isDirectory()) {
    const files = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), relPath);
        else if (e.isFile()) files.push({ rel: relPath, text: readFileSync(join(dir, e.name), 'utf8') });
      }
    };
    walk(path, '');
    return { path, name, ext: '', files };
  }
  const text = readFileSync(path, 'utf8');
  return fromText(text, { path, name });
}

/** Build an input from text already in memory; JSON is parsed into doc when it parses. */
export function fromText(text, { path = null, name = 'input' } = {}) {
  const input = { path, name, ext: extname(name).toLowerCase(), text };
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { input.doc = JSON.parse(trimmed); } catch { input.doc = undefined; }
  }
  return input;
}

export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The digest of the source bytes (text) or of a folder's files map. */
export function sourceDigest(input) {
  if (typeof input.text === 'string') return sha256(input.text);
  if (Array.isArray(input.files)) return sha256(canonical(input.files.map((f) => [f.rel, sha256(f.text)])));
  return sha256(canonical(input.doc ?? null));
}

/** YYYY-MM-DD of a Date or ISO string; a missing `now` is a programming error, never a clock read. */
export function dateOf(now) {
  if (now === undefined || now === null) throw new TypeError('importers need opts.now (a Date or ISO string); they never read the clock');
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError(`opts.now is not a date: ${String(now)}`);
  return d.toISOString().slice(0, 10);
}

/** Lower-case id within the scene id pattern; invalid runs become '-', nothing survives → fallback. */
export function slug(value, fallback = 'item') {
  let s = String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9_.:-]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[-.]+$/, '');
  if (!s) s = fallback;
  if (s.length > 80) s = `${s.slice(0, 63)}-${sha256(value).slice(7, 23)}`;
  return s;
}

/** Hands out unique ids: the slug, then slug-2, slug-3 … ; remembers source → id. */
export function idMinter() {
  const used = new Set();
  const bySource = new Map();
  return {
    mint(source, fallback = 'item') {
      const key = String(source);
      if (bySource.has(key)) return bySource.get(key);
      const base = slug(key, fallback);
      let id = base; let n = 2;
      while (used.has(id)) { id = `${base.slice(0, 76)}-${n}`; n += 1; }
      used.add(id);
      bySource.set(key, id);
      return id;
    },
    has(source) { return bySource.has(String(source)); },
    get(source) { return bySource.get(String(source)); },
    entries() { return [...bySource.entries()]; },
  };
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

export function label(text, fallback = 'untitled') {
  const s = clip(text, MAX_LABEL);
  return s || fallback;
}

export function tagList(values, max = MAX_TAGS) {
  const out = [];
  for (const v of Array.isArray(values) ? values : (typeof values === 'string' ? values.split(/[,;]/) : [])) {
    const t = clip(String(v).replace(/^#/, ''), MAX_TAG).toLowerCase();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Deterministic series colour for a group id (hash over series-1..6, as the layout does). */
export function seriesFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  return SERIES[h % SERIES.length];
}

export function unit(v, fallback = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export function vec3(v, fallback = [0, 0, 0]) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(Number(x)))) return fallback;
  return v.map(Number);
}

/** An absolute home path never enters a scene: keep the basename and say so. */
export function relativize(ref) {
  const s = String(ref ?? '');
  const bare = s.replace(/^file:\/\//, '');
  if (!ABSOLUTE_PATH_RE.test(bare) && !ABSOLUTE_PATH_RE.test(s)) return { ref: s, relativized: false };
  return { ref: basename(bare.replace(/\\/g, '/')), relativized: true };
}

/** A digest field: the source's own sha256 when it carries one, else the digest of the descriptor. */
export function digestOf(descriptor, own = null) {
  if (typeof own === 'string' && isDigest(own)) return own;
  if (typeof own === 'string' && /^[0-9a-f]{64}$/.test(own)) return `sha256:${own}`;
  return sha256(canonical(descriptor));
}

/** The {kind, ref, digest} a proposal's `source` and a node's provenance.source both carry. */
export function sourceDescriptor(importer, input) {
  return { kind: 'import', ref: `import:${importer}/${input && input.name ? input.name : 'input'}`, digest: sourceDigest(input ?? {}) };
}

/** The provenance block every imported node carries. */
export function provenanceFor({ importer, name, digest, owner = 'self', capturedOn, happenedOn = null }) {
  const p = { owner_person_id: owner, source: { kind: 'import', ref: `import:${importer}/${name}`, digest }, captured_on: capturedOn };
  if (happenedOn) p.happened_on = happenedOn;
  return p;
}

/** Scene skeleton: everything the schema requires at the root, filled by the importer. */
export function sceneSkeleton({ kind, id, title, layout, importer, name, digest, opts = {} }) {
  const viewBox = kind === 'room' ? [0, 0, 1200, 800] : [0, 0, 1600, 1000];
  return {
    schema_version: SCHEMA_VERSION,
    kind,
    meta: {
      id, title: label(title), output: `${id}.html`, theme: opts.theme ?? 'studio', quality: 'checked',
      units: 'm', up_axis: 'y', privacy_mode: opts.privacy_mode ?? 'private_live', maturity: 'prototype', legend: true,
    },
    viewer: { person_id: 'self', mode: 'self', rule_refs: [] },
    groups: [],
    nodes: [],
    edges: [],
    views: {
      '2d': { layout, seed: opts.seed ?? 7, viewBox },
      '3d': kind === 'room'
        ? { layout: 'metric', scale_m: 1, camera: { position: [0, 3, 6], target: [0, 0.5, 0] } }
        : { layout: 'lift', scale_m: 6, camera: { position: [0, 2.5, 8], target: [0, 0, 0] }, lift: { mode: 'group-weight', amplitude_m: 1.5 } },
      vr: { enabled: true, scale_m: kind === 'room' ? 1 : 4, floor_y: 0, eye_height_m: 1.6, label_budget: 64 },
      interactive: { focus: null, reach: 'both', lenses: [], presentation: [], deep_link: true },
    },
    evidence: [{ id: 'ev-1', kind: 'import', ref: `import:${importer}/${name}`, digest, label: 'SRC 1' }],
    ext: {},
  };
}

const DROP_KEYS = new Set([...HANDLE_KEYS, ...KEY_MATERIAL_KEYS]);
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEYS_DIR_RE = /(^|\/)data\/keys\//;

/**
 * What the privacy gate refuses never enters a scene: absolute home paths
 * become their basename, handle / key-material keys are dropped, HMAC values,
 * PEM blocks and data/keys/ references are replaced. Returns {value, strings, keys}.
 */
export function scrub(value) {
  const stats = { strings: 0, keys: 0 };
  const walk = (v) => {
    if (typeof v === 'string') {
      if (ABSOLUTE_PATH_RE.test(v) || ABSOLUTE_PATH_RE.test(v.replace(/^file:\/\//, ''))) { stats.strings += 1; return relativize(v).ref; }
      if (HMAC_RE.test(v) || PEM_RE.test(v) || KEYS_DIR_RE.test(v)) { stats.strings += 1; return '[removed]'; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (DROP_KEYS.has(k.toLowerCase()) || ABSOLUTE_PATH_RE.test(k)) { stats.keys += 1; continue; }
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), ...stats };
}

/** Points focus, entry node and presentation at real nodes once they exist; scrubs the whole scene last. */
export function finishScene(scene, { presentation = 3 } = {}) {
  const first = scene.nodes[0] ? scene.nodes[0].id : null;
  scene.views.interactive.focus = first;
  if (first) scene.views.vr.entry_node = first;
  scene.views.interactive.presentation = scene.nodes.slice(0, presentation).map((n) => n.id);
  scene.views.interactive.lenses = scene.groups.slice(0, 32).map((g) => ({ id: `lens-${g.id}`.slice(0, 80), label: label(g.label), match: { groups: [g.id] } }));
  const { value, strings, keys } = scrub(scene);
  if (strings || keys) value.ext.scrubbed = { strings, keys };
  return value;
}

/** Adds an evidence row for a source descriptor once; returns its id. */
export function evidenceMinter(scene) {
  const byRef = new Map();
  return (kind, ref, own = null) => {
    const r = relativize(ref);
    const key = `${kind}|${r.ref}`;
    if (byRef.has(key)) return byRef.get(key);
    const id = `ev-${scene.evidence.length + 1}`;
    scene.evidence.push({ id, kind, ref: r.ref.slice(0, 512), digest: digestOf({ kind, ref: r.ref }, own), label: `SRC ${scene.evidence.length + 1}` });
    byRef.set(key, id);
    return id;
  };
}

export { fail, pass, sha256, canonical };
