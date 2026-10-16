// The importer registry: every importer exports {id, detect(input), run(input,
// opts)} and returns {kind: 'records', room, records, checks} or {kind:
// 'scene', scene, checks}. detect() picks the first importer that recognises
// a loaded input; the specific shapes go before the generic row importers,
// and the sketch importer goes first of all: it keys on schema_version
// 'dotfield.sketch/1' only, so no other shape can be mistaken for a sketch.
import * as sketch from './sketch.mjs';
import * as archify from './archify.mjs';
import * as sonGraph from './son-graph.mjs';
import * as spatial from './spatial-asset-scene.mjs';
import * as markdownDir from './markdown-dir.mjs';
import * as csv from './csv.mjs';
import * as json from './json.mjs';
import { fail, importChecks, loadInput, sourceDescriptor } from './common.mjs';

export const IMPORTERS = Object.freeze([sketch, archify, sonGraph, spatial, markdownDir, csv, json]);

export function byId(id) {
  return IMPORTERS.find((i) => i.id === id) ?? null;
}

/** The first importer whose detect() accepts the input, or null. */
export function detect(input) {
  return IMPORTERS.find((i) => i.detect(input)) ?? null;
}

/** Run a named importer, or the detected one; an unrecognised input is one DF_IMPORT_FORMAT_UNKNOWN check. */
export function importInput(input, opts = {}) {
  const importer = opts.importer ? byId(opts.importer) : detect(input);
  if (!importer) {
    const detail = opts.importer ? `no importer named '${opts.importer}'` : `${input && input.name ? input.name : 'input'} matches no importer`;
    return { kind: 'unknown', importer: null, checks: importChecks([fail('DF_IMPORT_FORMAT_UNKNOWN', { path: '$', detail })]), ok: false, source: input ? sourceDescriptor(null, input) : null };
  }
  return importer.run(input, opts);
}

/** Load a file or folder from disk and import it; an unreadable path is one DF_IMPORT_FILE_UNREADABLE check. */
export function importPath(path, opts = {}) {
  let input;
  try { input = loadInput(path); } catch (e) {
    return { kind: 'unknown', importer: null, checks: importChecks([fail('DF_IMPORT_FILE_UNREADABLE', { path: String(path), detail: e && e.message ? e.message : String(e) })]), ok: false, source: null };
  }
  return importInput(input, opts);
}

export { loadInput, fromText } from './common.mjs';
