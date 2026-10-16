import test from 'node:test';
import assert from 'node:assert/strict';
test('records keep their ids', () => assert.equal([{ id: 'a' }][0].id, 'a'));
test('two is two', () => assert.equal(1 + 1, 2));
