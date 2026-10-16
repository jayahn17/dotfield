// The skill's allow-list is the agent's whole reach into the CLI. It must be
// enumerated per verb, never a wildcard, and no pattern may match the verbs
// that close the loop or move data out of the center.
import test from 'node:test';
import assert from 'node:assert/strict';
import { read, globToRegExp } from './helpers/scan.mjs';

const SKILL = '.claude/skills/dotfield/SKILL.md';
/** Inside a fork the skill runs the checkout's bin; outside one, the public repository through npx, pinned to this release's tag. */
const VERSION = JSON.parse(read('package.json')).version;
const PREFIXES = ['node bin/dotfield.mjs', `npx -y github:jayahn17/dotfield#v${VERSION}`];
const PREFIX_RE = /^(node bin\/dotfield\.mjs|npx -y github:jayahn17\/dotfield#v\d+\.\d+\.\d+) /;
const ALLOWED_VERBS = ['validate', 'render', 'plan', 'run', 'import', 'share rule', 'connect', 'verify', 'doctor', 'prove', 'add', 'theme'];
const FORBIDDEN_TAILS = [
  'node bin/dotfield.mjs approve prop-1 --decision approve',
  'node bin/dotfield.mjs approve run-1 --decision approve --token-file data/keys/owner.token',
  'node bin/dotfield.mjs share project --rule rule-01',
  'node bin/dotfield.mjs share revoke rule-01',
  'node bin/dotfield.mjs export -o out',
  'node bin/dotfield.mjs export',
  'node bin/dotfield.mjs delete notes --all',
  'node bin/dotfield.mjs delete notes --records n1',
  'node bin/dotfield.mjs serve',
  'node bin/dotfield.mjs serve --port 4100',
  'node bin/dotfield.mjs migrate',
  'node bin/dotfield.mjs migrate --dry-run',
  'node bin/dotfield.mjs init --pack starter',
].map((c) => c.replace(/^node bin\/dotfield\.mjs /, ''));
const FORBIDDEN_COMMANDS = PREFIXES.flatMap((p) => FORBIDDEN_TAILS.map((t) => `${p} ${t}`));

/** Parse the YAML-ish frontmatter: `key: value` with indented continuation lines. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2];
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`;
    }
  }
  return out;
}

/** Split "Bash(a *), Bash(b *)" into its patterns, respecting the parentheses. */
export function splitAllowedTools(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function bashPatterns(tools) {
  return tools.map((t) => t.match(/^Bash\((.*)\)$/)).filter(Boolean).map((m) => m[1]);
}

const text = read(SKILL);
const fm = parseFrontmatter(text);
const tools = splitAllowedTools(fm?.['allowed-tools'] ?? '');
const patterns = bashPatterns(tools);

test('SKILL.md has frontmatter with name, description and allowed-tools', () => {
  assert.ok(fm, 'frontmatter block missing');
  assert.equal(fm.name, 'dotfield');
  assert.ok(fm.description?.length > 20);
  assert.equal(tools.length, 24, `expected the 12 enumerated verbs under both prefixes, got ${tools.length}`);
});

test('every allowed tool is a Bash(<prefix> <verb> *) pattern — no bare wildcard, the npx prefix pinned to this release', () => {
  for (const t of tools) assert.match(t, /^Bash\(/, `only Bash patterns are enumerated: ${t}`);
  for (const p of patterns) {
    assert.notEqual(p.trim(), '*', 'Bash(*) is a wildcard');
    assert.notEqual(p.trim(), '', 'bare Bash is a wildcard');
    assert.ok(!/^node bin\/dotfield\.mjs\s*\*$/.test(p.trim()) && !/dotfield(#\S+)?\s*\*$/.test(p.trim()), `a bare prefix with * is a wildcard: ${p}`);
    assert.match(p, new RegExp(`${PREFIX_RE.source}[a-z][a-z ]*\\*$`), `pattern must name a verb: ${p}`);
    if (p.startsWith('npx')) assert.ok(p.startsWith(`${PREFIXES[1]} `), `the npx pattern pins v${VERSION} (package.json): ${p}`);
  }
});

test('the twelve allowed verbs are each present exactly once per prefix', () => {
  for (const prefix of PREFIXES) {
    const verbs = patterns.filter((p) => p.startsWith(`${prefix} `)).map((p) => p.slice(prefix.length + 1).replace(/\s*\*$/, '').trim()).sort();
    assert.deepEqual(verbs, [...ALLOWED_VERBS].sort(), prefix);
  }
});

test('no allowed pattern matches approve, share project, share revoke, export, delete, serve, migrate or init', () => {
  const regs = patterns.map((p) => ({ p, re: globToRegExp(p) }));
  const leaks = [];
  for (const cmd of FORBIDDEN_COMMANDS) for (const { p, re } of regs) if (re.test(cmd)) leaks.push(`${p}  matches  ${cmd}`);
  assert.deepEqual(leaks, [], `the skill can reach a forbidden verb:\n  ${leaks.join('\n  ')}`);
});

test('the allowed patterns do match their own verbs (the glob is not vacuous)', () => {
  const regs = patterns.map(globToRegExp);
  for (const cmd of PREFIXES.flatMap((p) => [`${p} validate all --json`, `${p} share rule r.json`, `${p} render s.json o.html --view 2d`])) {
    assert.ok(regs.some((re) => re.test(cmd)), `expected an allowed pattern to match: ${cmd}`);
  }
});

test('the body carries the six steps, the stop rule and the report format with release_tag', () => {
  for (const needle of ['Pick the kind of work', 'Author complete JSON', 'Validate:', 'Act:', 'Stop at `awaiting_owner`', 'Report truthfully']) {
    assert.ok(text.includes(needle), `missing step: ${needle}`);
  }
  for (const needle of ['release_tag', 'provisional', 'never read `data/keys/`', 'Never claim success on a non-zero exit', 'fenced data', 'never type a `projected` block']) {
    assert.ok(text.toLowerCase().includes(needle.toLowerCase()), `missing rule: ${needle}`);
  }
});

test('step 0 starts from a sketch written under .dotfield/sketches/, the write rule stays, and the report names the importer', () => {
  const plain = text.replace(/`/g, '');
  for (const needle of ['Start from a sketch', 'author a sketch from templates/<type>.sketch.json into .dotfield/sketches/<name>.sketch.json, then render it', 'DF_IMPORT_SKETCH_INVALID']) {
    assert.ok(plain.includes(needle), `missing step 0 text: ${needle}`);
  }
  assert.ok(plain.includes('.dotfield/sketches/'), 'agent-authored sketches live under .dotfield/sketches/');
  assert.ok(plain.includes('Never write outside .dotfield/ and data/proposals/'), 'the write-location rule is unchanged');
  assert.ok(plain.indexOf('0. **Start from a sketch**') < plain.indexOf('1. **Pick the kind of work:**'), 'step 0 comes before step 1');
  assert.match(text, /^importer:\s+<sketch .*\| ->$/m, 'the report format carries an importer line');
});

test('outside a fork: the npx section names the pinned release, writes only to .dotfield/, and leaves init to the owner', () => {
  const plain = text.replace(/`/g, '');
  assert.ok(plain.includes('## Outside a fork'));
  assert.ok(plain.includes(`npx -y github:jayahn17/dotfield#v${VERSION} <verb>`), 'the section shows the pinned command');
  assert.ok(/init\) is the owner's step/.test(plain), 'creating a center stays with the owner');
});
