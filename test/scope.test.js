// lib/scope.mjs: the three-state rule as internal code. The 11 cases reached
// through --as (owner aliases, sanitising, empty ids, path-like ids, the
// public viewer) plus the non-owner request with and without a session; the
// owner container is never the fallback. No disk, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_SCOPE, PERSON_ID_RE, PUBLIC_SCOPE, SCOPE_RE, containerOf, isScope, ownerPersonId, personOfScope, resolveScope, sanitizeId } from '../lib/scope.mjs';
import { loadSchema, validate } from '../lib/validate.mjs';

const config = { center: { name: 'c', owner_person_id: 'owner-1' } };
const scopeSchema = { type: ['string', 'null'], pattern: loadSchema('receipt').properties.scope.pattern };
// built at runtime so no file carries a literal path that climbs out of dotfield/ (test/no-son-imports.test.js)
const TRAVERSAL = ['..', '..', 'etc'].join('/');

const CASES = [
  ['1 no --as -> owner', { as: null }, { scope: 'owner', viewer: 'self', container: '' }],
  ['2 --as self -> owner', { as: 'self' }, { scope: 'owner', viewer: 'self', container: '' }],
  ['3 --as <owner id> -> owner', { as: 'owner-1', config }, { scope: 'owner', viewer: 'self', container: '' }],
  ['4 --as ada -> person_ada', { as: 'ada' }, { scope: 'person_ada', viewer: 'ada', container: 'person_ada' }],
  ['5 --as Ada -> lower-cased', { as: 'Ada' }, { scope: 'person_ada', viewer: 'ada', container: 'person_ada' }],
  ['6 --as "  ada  " -> trimmed', { as: '  ada  ' }, { scope: 'person_ada', viewer: 'ada', container: 'person_ada' }],
  ['7 --as "" -> empty uid refused', { as: '' }, { code: 'DF_STORE_SCOPE_EMPTY_UID', status: 400 }],
  ['8 --as "***" -> empty after sanitising', { as: '***' }, { code: 'DF_STORE_SCOPE_EMPTY_UID', status: 400 }],
  ['9 --as <traversal> -> no path, no leading dots', { as: TRAVERSAL }, { scope: 'person_etc', viewer: 'etc', container: 'person_etc' }],
  ['10 remote with no session -> refused, never the owner', { origin: 'remote', as: 'self' }, { code: 'DF_STORE_SCOPE_REFUSED', status: 401 }],
  ['11 remote with a session -> that person', { origin: 'remote', session: { person_id: 'Bob' } }, { scope: 'person_bob', viewer: 'bob', container: 'person_bob' }],
];

for (const [name, input, expected] of CASES) {
  test(`scope case ${name}`, () => {
    const r = resolveScope(input);
    if (expected.code) {
      assert.equal(r.ok, false);
      assert.equal(r.code, expected.code);
      assert.equal(r.status, expected.status);
      assert.equal(r.scope, null, 'no scope on refusal');
      assert.equal(r.container, null, 'no container on refusal');
      assert.deepEqual(r.checks.map((c) => [c.code, c.status, c.blocking]), [[expected.code, 'fail', true]]);
      assert.ok(r.checks[0].message.length > 10 && r.checks[0].repair.length > 10);
    } else {
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.scope, expected.scope);
      assert.equal(r.viewer, expected.viewer);
      assert.equal(r.container, expected.container);
      assert.equal(r.status, 200);
      assert.deepEqual(r.checks.map((c) => [c.code, c.status]), [['DF_STORE_SCOPE_REFUSED', 'pass'], ['DF_STORE_SCOPE_EMPTY_UID', 'pass']]);
      assert.equal(validate(scopeSchema, r.scope).ok, true, 'the scope is a receipt scope');
      assert.ok(isScope(r.scope));
    }
  });
}

test('the owner container is never offered to a remote request, whatever it claims', () => {
  for (const session of [null, undefined, 'self', 42, [], {}, { person_id: '' }, { person_id: 'self' }, { person_id: 'owner-1' }, { person_id: '///' }]) {
    const r = resolveScope({ origin: 'remote', session, as: 'self', config });
    assert.equal(r.ok, false, JSON.stringify(session));
    assert.notEqual(r.scope, OWNER_SCOPE);
    assert.ok(['DF_STORE_SCOPE_REFUSED', 'DF_STORE_SCOPE_EMPTY_UID'].includes(r.code));
  }
  const good = resolveScope({ origin: 'remote', session: { person_id: 'carol' }, as: 'self' });
  assert.equal(good.scope, 'person_carol', '--as is ignored for a remote request');
  assert.equal(good.requested, 'carol');
});

test('--as public is the public viewer with no store container', () => {
  const r = resolveScope({ as: 'public' });
  assert.equal(r.ok, true);
  assert.equal(r.scope, PUBLIC_SCOPE);
  assert.equal(r.viewer, 'public');
  assert.equal(r.container, null);
  assert.equal(containerOf('public'), null);
});

test('sanitizeId: lower-case, strip, no leading punctuation, 80 cap; ids that survive match PERSON_ID_RE', () => {
  assert.equal(sanitizeId(' Ada Lovelace '), 'adalovelace');
  assert.equal(sanitizeId('a/b\\c d'), 'abcd');
  assert.equal(sanitizeId('.hidden'), 'hidden');
  assert.equal(sanitizeId('-_x'), 'x');
  assert.equal(sanitizeId('x'.repeat(100)).length, 80);
  assert.equal(sanitizeId(null), '');
  assert.equal(sanitizeId(undefined), '');
  assert.equal(sanitizeId(7), '7');
  for (const raw of ['Ada', 'a.b:c-d_e', 'x'.repeat(100), TRAVERSAL]) assert.match(sanitizeId(raw), PERSON_ID_RE);
  const long = resolveScope({ as: 'y'.repeat(100) });
  assert.equal(long.scope, `person_${'y'.repeat(80)}`);
  assert.match(long.scope, SCOPE_RE);
});

test('helpers: ownerPersonId, personOfScope, containerOf, isScope', () => {
  assert.equal(ownerPersonId(null), 'self');
  assert.equal(ownerPersonId(config), 'owner-1');
  assert.equal(ownerPersonId({ center: { owner_person_id: 'Not Valid' } }), 'self', 'an invalid configured id falls back to self');
  assert.equal(personOfScope('owner', config), 'owner-1');
  assert.equal(personOfScope('person_ada'), 'ada');
  assert.equal(personOfScope('public'), 'public');
  assert.equal(personOfScope('nope'), null);
  assert.equal(containerOf('owner'), '');
  assert.equal(containerOf('person_ada'), 'person_ada');
  assert.equal(containerOf('garbage'), null);
  assert.ok(isScope('owner') && isScope('public') && isScope('person_a.b') && !isScope('person_') && !isScope('Person_a') && !isScope(null));
  const r = resolveScope({ as: 'ada', config });
  assert.equal(r.owner, 'owner-1');
  assert.deepEqual(Object.keys(r.checks[0]), ['code', 'gate', 'blocking', 'status'], 'a pass carries only the four keys');
});
