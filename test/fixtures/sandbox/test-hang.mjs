import test from 'node:test';
test('never finishes', () => new Promise(() => { setInterval(() => {}, 1000); }));
