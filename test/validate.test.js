// lib/validate.mjs: the vendored official JSON-Schema-Test-Suite for the
// supported keywords (skips listed by name and reason), conformance fixtures
// that raise every DF_SCHEMA_* code, the exact open paths of a schema, the
// never-throws promise, loadSchema, and every shipped schema against its
// own examples. node:test, no network, no temp files needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_FORMATS, SUPPORTED_KEYWORDS, deepEqual, inspectSchema, isDate, isDateTime, loadSchema,
  openPaths, resolvePointer, schemaPath, tryLoadSchema, validate, validateAgainst,
} from '../lib/validate.mjs';
import { codesForFamily } from '../lib/rules.mjs';
import { base } from './fixtures/ir/build-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSTS = join(ROOT, 'test', 'fixtures', 'jsts');
const FIX = join(ROOT, 'test', 'fixtures', 'validate');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const manifest = readJson(join(JSTS, 'manifest.json'));
const ERROR_KEYS = ['code', 'message', 'path', 'repair'];

test('JSTS: the vendored files, LICENSE and manifest agree', () => {
  assert.ok(existsSync(join(JSTS, 'LICENSE')), 'LICENSE is vendored with the suite');
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  const onDisk = readdirSync(JSTS).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  assert.deepEqual(onDisk, [...manifest.files].sort(), 'every vendored keyword file is listed and vice versa');
  for (const f of manifest.optional_files) assert.ok(existsSync(join(JSTS, f)), `${f} is vendored`);
  const keywordFiles = manifest.files.filter((f) => f !== 'ref.json' && f !== 'format.json').map((f) => f.replace(/\.json$/, ''));
  for (const kw of keywordFiles) assert.ok(SUPPORTED_KEYWORDS.includes(kw), `${kw} is a supported keyword`);
});

test('JSTS draft2020-12: every runnable case of the supported keywords passes; skips are listed', (t) => {
  const skipped = [];
  let groupsRun = 0;
  let casesRun = 0;
  let skippedGroups = 0;
  for (const file of [...manifest.files, ...manifest.optional_files]) {
    for (const group of readJson(join(JSTS, file))) {
      const problems = inspectSchema(group.schema);
      if (problems.length) {
        skippedGroups += 1;
        skipped.push(`${file} :: ${group.description} :: ${problems.map((p) => `${p.code} ${p.detail}`).join('; ')}`);
        continue;
      }
      groupsRun += 1;
      for (const c of group.tests) {
        if (/only an annotation by default/.test(c.description)) {
          skipped.push(`${file} :: ${group.description} :: ${c.description} :: dotfield asserts format`);
          continue;
        }
        const r = validate(group.schema, c.data);
        casesRun += 1;
        assert.equal(r.ok, c.valid, `${file} :: ${group.description} :: ${c.description} -> ${JSON.stringify(r.errors)}`);
        for (const e of r.errors) {
          assert.deepEqual(Object.keys(e).sort(), ERROR_KEYS, 'error shape');
          assert.match(e.code, /^DF_SCHEMA_[A-Z_]+$/);
          assert.ok(e.repair.length > 0 && e.message.length > 0);
        }
      }
    }
  }
  t.diagnostic(`JSTS: ${casesRun} cases over ${groupsRun} groups passed; ${skipped.length} skipped`);
  for (const s of skipped) t.diagnostic(`skipped ${s}`);
  for (const s of skipped) assert.match(s, /DF_SCHEMA_UNSUPPORTED_KEYWORD|dotfield asserts format/, `a skip is only ever an unsupported keyword or the format assertion: ${s}`);
  assert.deepEqual(
    { groups_run: groupsRun, cases_run: casesRun, skipped_groups: skippedGroups, skipped_cases: skipped.length - skippedGroups },
    { groups_run: manifest.expected.groups_run, cases_run: manifest.expected.cases_run, skipped_groups: manifest.expected.skipped_groups, skipped_cases: manifest.expected.skipped_cases },
    'coverage counts are pinned in test/fixtures/jsts/manifest.json',
  );
});

test('format: date and date-time are asserted per RFC 3339', () => {
  assert.deepEqual(SUPPORTED_FORMATS, ['date', 'date-time']);
  assert.ok(isDate('2020-02-29') && !isDate('2021-02-29') && !isDate('2100-02-29') && isDate('2000-02-29'));
  assert.ok(!isDate(' 2024-01-15') && !isDate('2024-01-15 ') && !isDate('20240115') && !isDate(''));
  assert.ok(isDateTime('1998-12-31T23:59:60Z') && isDateTime('1998-12-31T15:59:60.123-08:00'));
  assert.ok(!isDateTime('1998-12-31T23:58:60Z') && !isDateTime('1998-12-31T23:59:61Z') && !isDateTime('1990-12-31T15:59:59-24:00'));
  assert.ok(isDateTime('1963-06-19t08:30:06.283185z') && !isDateTime('1985-04-12T23:20:50Z\n') && !isDateTime('1985-04-12T23:20Z'));
  assert.equal(validate({ format: 'date' }, 12).ok, true, 'format ignores non-strings');
  assert.equal(validate({ type: 'string', format: 'date-time' }, '2026-10-01T10:15:00Z').ok, true);
});

test('unsupported keywords are refused with DF_SCHEMA_UNSUPPORTED_KEYWORD and the document is not examined', () => {
  const r = validate({ type: 'string', allOf: [{ minLength: 1 }] }, 42);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.code), ['DF_SCHEMA_UNSUPPORTED_KEYWORD'], 'the type mismatch of 42 is not reported');
  assert.match(r.errors[0].message, /'allOf'/);
  assert.equal(validate({ properties: { a: { $id: 'nested' } } }, {}).errors[0].code, 'DF_SCHEMA_UNSUPPORTED_KEYWORD');
  assert.equal(validate({ $ref: '#anchor' }, {}).errors[0].code, 'DF_SCHEMA_UNSUPPORTED_KEYWORD');
  assert.equal(validate({ format: 'email' }, 'x').errors[0].code, 'DF_SCHEMA_UNSUPPORTED_KEYWORD');
  assert.equal(validate({ $schema: 'x', $id: 'dotfield.x/1', title: 't', description: 'd', $comment: 'c', default: 1, examples: [1], type: 'number' }, 1).ok, true, 'annotations are allowed');
});

test('conformance fixtures raise every DF_SCHEMA_* code with the expected paths', () => {
  const raised = new Set();
  for (const f of readJson(join(FIX, 'conformance.json'))) {
    const r = validate(f.schema, f.doc);
    const codes = r.errors.map((e) => e.code);
    assert.equal(r.ok, f.expect.length === 0, `${f.name}: ok -> ${JSON.stringify(r.errors)}`);
    for (const code of f.expect) assert.ok(codes.includes(code), `${f.name} raises ${code}; got ${codes}`);
    for (const p of f.paths ?? []) assert.ok(r.errors.some((e) => e.path === p), `${f.name} reports path ${p}; got ${r.errors.map((e) => e.path)}`);
    for (const e of r.errors) { assert.deepEqual(Object.keys(e).sort(), ERROR_KEYS); raised.add(e.code); }
  }
  const missing = validateAgainst('does-not-exist', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, 'DF_SCHEMA_NOT_FOUND');
  raised.add('DF_SCHEMA_NOT_FOUND');
  assert.deepEqual([...raised].sort(), [...codesForFamily('schema')].sort(), 'every schema-family code is raised by a fixture');
});

test('validate never throws, whatever it is given', () => {
  const circular = {}; circular.self = circular;
  for (const [schema, doc] of [[undefined, undefined], [null, 1], [5, 5], ['x', {}], [[], []], [{ type: 'string' }, undefined], [{ type: 'object' }, circular],
    [{ $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/a' } } }, 1], [{ type: 'object', properties: { a: { $ref: '#' } } }, { a: { a: { a: 1 } } }],
    [{ type: 'string', pattern: '(' }, 'x'], [{ enum: 'not-an-array' }, 1], [{ oneOf: [] }, 1], [{ required: 'id' }, {}], [{ minLength: 'x' }, 'a']]) {
    const r = validate(schema, doc);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.errors));
    for (const e of r.errors) assert.deepEqual(Object.keys(e).sort(), ERROR_KEYS);
  }
  assert.equal(validate(true, 'anything').ok, true);
  assert.equal(validate(false, 'anything').errors[0].code, 'DF_SCHEMA_NOT_ALLOWED');
  assert.equal(validate({ type: 'object', properties: { a: { $ref: '#' } } }, { a: { a: { a: {} } } }).ok, true, 'recursion through $ref is bounded by the instance');
});

test('error detail names what to change', () => {
  const r = validate({ type: 'object', properties: { id: {}, label: {} }, additionalProperties: false, required: ['label'] }, { id: 1, labl: 'x' });
  const unknown = r.errors.find((e) => e.code === 'DF_SCHEMA_UNKNOWN_FIELD');
  assert.equal(unknown.path, '$.labl');
  assert.match(unknown.message, /'labl' is not declared; declared: id, label/);
  const req = r.errors.find((e) => e.code === 'DF_SCHEMA_REQUIRED');
  assert.equal(req.path, '$.label');
  assert.equal(validate({ properties: { 'a b': { type: 'number' } } }, { 'a b': 'x' }).errors[0].path, '$["a b"]');
  assert.equal(validate({ type: 'string', maxLength: 2 }, '\u{1F4A9}\u{1F4A9}\u{1F4A9}').errors[0].message.includes('length 3'), true, 'length counts code points');
});

test('openPaths lists exactly the open maps of a schema', () => {
  const schema = readJson(join(FIX, 'open-paths.schema.json'));
  assert.deepEqual(openPaths(schema), readJson(join(FIX, 'open-paths.expected.json')));
  assert.equal(validate(schema, readJson(join(FIX, 'open-paths.valid.json'))).ok, true, 'the open maps admit unlisted keys');
  assert.equal(validate(schema, { schema_version: 'dotfield.open-paths-fixture/1', nodes: [], positions: { 'Bad Key': [1, 2] }, views: { interactive: {} } }).errors[0].code, 'DF_SCHEMA_UNKNOWN_FIELD', 'a pattern-keyed map still refuses keys off the pattern');
  assert.deepEqual(openPaths(loadSchema('receipt')), [], 'the receipt schema is closed');
  assert.deepEqual(openPaths({ type: 'object' }), ['$']);
  assert.deepEqual(openPaths({ type: 'object', additionalProperties: false }), []);
  assert.deepEqual(openPaths(true), []);
});

test('loadSchema resolves names, ids and file names; a missing schema is one error or one typed throw', () => {
  const s = loadSchema('receipt');
  assert.equal(s.$id, 'dotfield.receipt/1');
  assert.equal(loadSchema('dotfield.receipt/1'), s);
  assert.equal(loadSchema('receipt.schema.json'), s, 'cached by file');
  assert.equal(schemaPath('../package'), null);
  assert.equal(schemaPath('Receipt'), null);
  assert.equal(tryLoadSchema('nope').ok, false);
  assert.equal(tryLoadSchema('nope').error.code, 'DF_SCHEMA_NOT_FOUND');
  assert.throws(() => loadSchema('nope'), (e) => e.code === 'DF_SCHEMA_NOT_FOUND');
});

test('every shipped schema uses only the supported subset and validates its own examples', (t) => {
  const schemasDir = join(ROOT, 'schemas');
  const examplesDir = join(ROOT, 'examples');
  const files = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const name = file.replace(/\.schema\.json$/, '');
    const schema = readJson(join(schemasDir, file));
    assert.deepEqual(inspectSchema(schema), [], `${file} uses only supported keywords`);
    assert.equal(schema.$id, `dotfield.${name}/1`, `${file} carries its dotfield id`);
    const examples = existsSync(examplesDir)
      ? readdirSync(examplesDir).filter((f) => f === `${name}.example.json` || (f.startsWith(`${name}-`) && f.endsWith('.json')))
      : [];
    if (!examples.length) { t.diagnostic(`${file}: no example under examples/ yet`); continue; }
    for (const ex of examples) {
      const r = validate(schema, readJson(join(examplesDir, ex)));
      assert.equal(r.ok, true, `${ex} validates against ${file}: ${JSON.stringify(r.errors)}`);
    }
  }
});

test('deepEqual and resolvePointer follow JSON semantics', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }) && deepEqual(1, 1.0) && !deepEqual(1, true) && !deepEqual([0], [false]) && !deepEqual({ a: 1 }, { a: 1, b: 2 }));
  const root = { $defs: { 'a/b': { x: 1 }, 'c~d': { y: 2 }, list: [{ z: 3 }] } };
  assert.deepEqual(resolvePointer(root, '#/$defs/a~1b'), { x: 1 });
  assert.deepEqual(resolvePointer(root, '#/$defs/c~0d'), { y: 2 });
  assert.deepEqual(resolvePointer(root, '#/$defs/list/0'), { z: 3 });
  assert.equal(resolvePointer(root, '#/$defs/list/01'), undefined);
  assert.equal(resolvePointer(root, '#/$defs/%ZZ'), undefined);
  assert.equal(resolvePointer(root, '#'), root);
});

test('scene views.time and steps[].playhead: a date or an integer per axis; a malformed date is FORMAT, a negative integer MINIMUM', () => {
  const schema = loadSchema('scene');
  const withTime = (time) => { const s = base(); s.views.time = time; return validate(schema, s); };
  assert.equal(withTime({ axis: 'order', from: 12 }).ok, true, 'from: 12 passes');
  assert.equal(withTime({ axis: 'date', from: '2026-10-07', to: null, playhead: null }).ok, true);
  const bad = withTime({ axis: 'date', from: '2026-13-40' });
  assert.deepEqual(bad.errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_FORMAT $.views.time.from'], 'a malformed date is a format error, not a oneOf miss');
  const negative = withTime({ axis: 'order', from: -1 });
  assert.deepEqual(negative.errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_MINIMUM $.views.time.from']);
  assert.deepEqual(withTime({ axis: 'order', playhead: 1.5 }).errors.map((e) => e.code), ['DF_SCHEMA_TYPE'], 'a fraction is no beat');
  assert.deepEqual(withTime({ axis: 'order', to: true }).errors.map((e) => e.code), ['DF_SCHEMA_TYPE']);
  assert.deepEqual(withTime({ from: 1 }).errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_REQUIRED $.views.time.axis']);
  assert.deepEqual(withTime({ axis: 'date', step: 'hour' }).errors.map((e) => e.code), ['DF_SCHEMA_ENUM']);
  assert.deepEqual(withTime({ axis: 'date', trace: { trail: 0.01 } }).errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_MINIMUM $.views.time.trace.trail']);
  assert.deepEqual(withTime({ axis: 'date', loop: true }).errors.map((e) => e.code), ['DF_SCHEMA_UNKNOWN_FIELD'], 'the time block is closed');
  const steps = (list) => { const s = base(); s.views.interactive.steps = list; return validate(schema, s); };
  assert.equal(steps([{ id: 's1', label: 'One', nodes: ['n-1'], edges: ['e1'], playhead: '2026-09-01' }, { id: 's2', nodes: [], playhead: 3 }]).ok, true);
  assert.deepEqual(steps([{ id: 's1', nodes: ['n-1'], playhead: '2026-02-30' }]).errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_FORMAT $.views.interactive.steps[0].playhead']);
  assert.deepEqual(steps([{ id: 's1', nodes: ['n-1'], playhead: -2 }]).errors.map((e) => e.code), ['DF_SCHEMA_MINIMUM']);
  assert.deepEqual(steps([{ id: 's1' }]).errors.map((e) => `${e.code} ${e.path}`), ['DF_SCHEMA_REQUIRED $.views.interactive.steps[0].nodes']);
  assert.deepEqual(steps([{ id: 's1', nodes: [], target: 'x' }]).errors.map((e) => e.code), ['DF_SCHEMA_UNKNOWN_FIELD'], 'a step is closed');
  const vr = base(); vr.views.vr = { enabled: true, snap_turn_deg: 60 };
  assert.deepEqual(validate(schema, vr).errors.map((e) => e.code), ['DF_SCHEMA_ENUM'], 'snap turn is 0, 30, 45 or 90');
  const edge = base(); Object.assign(edge.edges[0], { kind: 'message', order: 1, at: '2026-09-01', from_side: 'right', to_side: 'left' });
  assert.equal(validate(schema, edge).ok, true, 'message edges carry at and port hints');
  edge.edges[0].from_side = 'middle';
  assert.deepEqual(validate(schema, edge).errors.map((e) => e.code), ['DF_SCHEMA_ENUM']);
  const themed = base(); themed.meta.theme = 'editorial';
  assert.equal(validate(schema, themed).ok, true, 'editorial and blueprint landed with the themes-presets ticket');
  themed.meta.theme = 'neon';
  assert.deepEqual(validate(schema, themed).errors.map((e) => e.code), ['DF_SCHEMA_ENUM'], 'a theme tokens.css does not declare is refused');
});
