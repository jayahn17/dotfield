// GOVERNANCE.md may be extended in a fork and never reduced. The sentences
// below are the canonical text; the test fails the moment one drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers/scan.mjs';

export const COMMITMENTS = [
  '**No attention resale.** Nothing in Dotfield measures, ranks or sells your attention; there is no feed, no engagement metric and no telemetry.',
  '**No ads.** No surface in a center, a render or a projection ever carries advertising, and no fork may add one and still call itself Dotfield.',
  '**Export is a right.** `dotfield export` writes every record, proposal, rule and receipt as plain JSON, at any time, with a receipt.',
  '**Delete is a right.** `dotfield delete` removes records and sweeps every derived copy (`.bak`, renders, run transcripts, proposals), listing each in the receipt.',
  '**No training without a grant.** No record, projection or run transcript is used to train anything unless a share rule the owner approved says `train: true` — and in v1 the projector refuses such a rule.',
];

export const SENTENCES = {
  switches: 'recorded in receipts and shown on the node card; the projector refuses a rule that sets either to true in v1 (`DF_SHARE_SWITCH_UNSUPPORTED`).',
  threat: 'an agent with shell access as the owner can read that file; the hop is a permission discipline enforced by tests and allow-lists, not cryptography.',
  plaintext: 'data is plaintext JSON on the owner\'s disk, use OS disk encryption',
  recall: 'renders already sent cannot be recalled',
  pseudonyms: 'pseudonyms are linkable within one rule, not anonymous',
  matchRelease: '`match_release` detects unintended local edits, not tamper evidence',
};

const text = read('GOVERNANCE.md');

test('the five commitments appear verbatim and in order', () => {
  let cursor = 0;
  COMMITMENTS.forEach((c, i) => {
    const at = text.indexOf(c, cursor);
    assert.ok(at >= 0, `commitment ${i + 1} missing or altered:\n  ${c}`);
    cursor = at + c.length;
  });
  assert.match(text, /^1\. \*\*No attention resale/m);
  assert.match(text, /^5\. \*\*No training without a grant/m);
});

test('the one aggregate/train sentence, the threat model and the four honesty statements are verbatim', () => {
  for (const [name, s] of Object.entries(SENTENCES)) assert.ok(text.includes(s), `${name} sentence missing or altered:\n  ${s}`);
});

test('the threat model names the token file, the env guards and the TTY rule', () => {
  for (const needle of ['data/keys/owner.token', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'DF_APPROVE_NOT_OWNER', '--token-file', 'TTY']) {
    assert.ok(text.includes(needle), `missing: ${needle}`);
  }
});

test('the root pointers restate the hop and the customer docs do not contradict it', () => {
  const claude = read('CLAUDE.md');
  assert.equal(claude.trimEnd().split('\n').length, 10, 'CLAUDE.md is exactly ten lines');
  for (const needle of ['VISION.md', 'AGENTS.md', 'SKILL.md', 'npm test', 'center/', 'approve']) assert.ok(claude.includes(needle), `CLAUDE.md missing ${needle}`);
  const agents = read('AGENTS.md');
  assert.ok(agents.includes('center/docs/AGENTS.md') && agents.includes('provisional'));
  const readme = read('README.md');
  assert.ok(readme.includes('center/docs/README.md') && readme.includes('not yet timed'));
  assert.ok(read('templates/center-docs/README.md').includes('not yet timed'));
  for (const rel of ['templates/center-docs/AGENTS.md', 'templates/center-docs/README.md']) {
    assert.ok(!/approve[^.]*(?:MCP tool|allowed-tools)/i.test(read(rel)), `${rel} must not describe an approve tool`);
  }
});

test('LICENSE is MIT for the named holder', () => {
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License/);
  assert.ok(lic.includes('Copyright (c) 2026 SeongJae Ahn'));
});
