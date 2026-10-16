// The template imports nothing from outside dotfield/: no ../server, ../api,
// ../mcp, no absolute path, no third-party package except the optional MCP SDK
// (only under mcp/) and three (only as browser code under renderers/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import {
  ROOT, CODE_EXTS, SKIP_DIRS, walk, read, imports, resolveSpecifier, isInsideRoot,
} from './helpers/scan.mjs';
import { dirname, resolve } from 'node:path';

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const FORBIDDEN_PACKAGES = /^(zod|aframe|a-frame|@?three(?!$|\/)|express|react|vue|svelte)/i;
const allCode = () => walk('.', { exts: CODE_EXTS, skip: new Set([...SKIP_DIRS, 'vendor']) });

function classify(rel, spec) {
  if (BUILTINS.has(spec)) return null;
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const abs = resolveSpecifier(rel, spec);
    return isInsideRoot(abs) ? null : `escapes the template root: ${spec}`;
  }
  if (spec.startsWith('@modelcontextprotocol/sdk')) return rel.startsWith('mcp/') ? null : `MCP SDK outside mcp/: ${spec}`;
  if (spec === 'three' || spec.startsWith('three/')) return rel.startsWith('renderers/') ? null : `three outside renderers/: ${spec}`;
  if (FORBIDDEN_PACKAGES.test(spec)) return `forbidden package: ${spec}`;
  return `unknown bare specifier (dependencies are {}): ${spec}`;
}

test('no module under dotfield/ imports from outside dotfield/ or from a package', () => {
  const bad = [];
  for (const rel of allCode()) {
    for (const spec of imports(read(rel))) {
      const why = classify(rel, spec);
      if (why) bad.push(`  ${rel}: ${why}`);
    }
  }
  assert.deepEqual(bad, [], `son is never imported:\n${bad.join('\n')}`);
});

test('no file names ../server, ../api, ../mcp, ../src or ../scripts of the parent repo', () => {
  const bad = [];
  const exts = new Set(['.mjs', '.js', '.cjs', '.json', '.sh', '.yml', '.yaml', '.md']);
  for (const rel of walk('.', { exts, skip: new Set([...SKIP_DIRS, 'vendor']) })) {
    if (rel === 'VISION.md' || rel === 'references/PROVENANCE.md' || rel === 'references/BUILD_CONTRACT.md') continue;
    const text = read(rel);
    // a bare "../../" names nothing; a path segment after the dots is a reference
    for (const m of text.matchAll(/(?:^|[\s"'`(=:])((?:\.\.\/)+[\w-][\w./-]*)/g)) {
      const target = resolve(ROOT, dirname(rel), m[1]);
      if (!isInsideRoot(target.split('\\').join('/'))) bad.push(`  ${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `paths must stay inside dotfield/:\n${bad.join('\n')}`);
});

test('package.json declares no runtime dependency and only the MCP SDK as optional', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), ['@modelcontextprotocol/sdk']);
  assert.equal(pkg.devDependencies, undefined, 'tests are node:test; no dev dependencies');
  assert.equal(pkg.type, 'module');
});
