// Centers for tests, always inside a temp dir from test/helpers/tmp.mjs and
// never the folder's own center/ (a fork has customised that one, and the
// template ships none): scaffoldCenter(dir) copies test/fixtures/rooms/
// center-min/ (center.config.json, brand.json, people/ with one kind: self
// person, one room "notes" with its four files) into <dir>/center/ and
// creates <dir>/data/ and <dir>/.dotfield/; initCenter(dir, {pack, name})
// runs the real `dotfield init` there, so a test gets exactly what a fresh
// fork gets from a shipped pack (keys under <dir>/data/keys/ included).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { runCli } from './cli.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CENTER_MIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rooms', 'center-min');
/** One clock for deterministic receipts: 2026-10-01T10:15:00Z. */
export const EPOCH_ENV = Object.freeze({ SOURCE_DATE_EPOCH: '1790849700' });
export const NOW = new Date('2026-10-01T10:15:00Z');
export const NOW_ISO = '2026-10-01T10:15:00Z';

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** Read a JSON file, apply fn(doc) (mutating or returning a new doc), write it back. */
export function patchJson(file, fn) {
  const doc = readJson(file);
  const out = fn(doc);
  writeJson(file, out === undefined ? doc : out);
}

/**
 * scaffoldCenter(dir, {name}) -> {root, centerDir, dataDir, dotDir, config, configPath, roomDir(id), roomFile(id, name)}
 * `dir` is a temp dir; the copy is independent of the fixture, so tests may
 * edit or delete any file in it.
 */
export function scaffoldCenter(dir, { name = null } = {}) {
  const root = resolve(dir);
  const centerDir = join(root, 'center');
  const dataDir = join(root, 'data');
  const dotDir = join(root, '.dotfield');
  cpSync(CENTER_MIN, centerDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dotDir, { recursive: true });
  const configPath = join(centerDir, 'center.config.json');
  const config = readJson(configPath);
  if (name) { config.center.name = name; writeJson(configPath, config); }
  const roomDir = (id) => join(centerDir, 'rooms', id);
  return { root, centerDir, dataDir, dotDir, config, configPath, roomDir, roomFile: (id, file) => join(roomDir(id), file) };
}

/** Copy the notes room to a new id (same files, manifest id and namespace renamed). */
export function cloneRoom(center, from, to, patch = null) {
  cpSync(center.roomDir(from), center.roomDir(to), { recursive: true });
  patchJson(center.roomFile(to, 'room.json'), (doc) => {
    doc.id = to;
    doc.store.namespace = to;
    if (patch) patch(doc);
  });
  return center.roomDir(to);
}

/**
 * initCenter(dir, {pack, name, keepData}) -> scaffoldCenter's shape plus {receipt}
 * The real CLI: `dotfield init --pack <pack> --name <name>` with DOTFIELD_ROOT=<dir>.
 * keepData: false removes <dir>/data/ afterwards (keys included), the state of
 * a center whose owner has not run anything yet.
 */
export function initCenter(dir, { pack = 'starter', name = 'Dotfield', keepData = true } = {}) {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const r = runCli(['init', '--pack', pack, '--name', name, '--json'], { cwd: root, env: { ...EPOCH_ENV, DOTFIELD_ROOT: root } });
  if (r.code !== 0) throw new Error(`initCenter: init --pack ${pack} exited ${r.code}: ${r.stdout || r.stderr}`);
  const centerDir = join(root, 'center');
  const dataDir = join(root, 'data');
  if (!keepData) rmSync(dataDir, { recursive: true, force: true });
  const configPath = join(centerDir, 'center.config.json');
  const roomDir = (id) => join(centerDir, 'rooms', id);
  return { root, centerDir, dataDir, dotDir: join(root, '.dotfield'), config: readJson(configPath), configPath, roomDir, roomFile: (id, file) => join(roomDir(id), file), receipt: r.json };
}
