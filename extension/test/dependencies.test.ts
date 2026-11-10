import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestNames, unanchoredDependencies } from '../src/security/dependencies';

const memWs = (files: Record<string, string>, installedNames: Set<string> = new Set()) => ({
  read: (p: string) => files[p],
  installed: (name: string) => installedNames.has(name),
});

test('dependency guard: a hallucinated/unanchored package import is held; stdlib, manifest and installed names are not', () => {
  const original = 'import os\n\ndef f():\n    return 1\n';
  const proposed = 'import os\nimport requests\nimport fastnonexistentpkg123\nfrom numpy import array\n\ndef f():\n    return 1\n';
  const ws = memWs({ 'requirements.txt': 'requests==2.31.0\n' }, new Set(['numpy']));
  const issues = unanchoredDependencies('a.py', original, proposed, ws, '');
  assert.deepEqual(issues.map((i) => i.name), ['fastnonexistentpkg123']);
});

test('dependency guard: a name the user explicitly asked for is never held', () => {
  const original = '';
  const proposed = 'import weirdlib\n';
  const ws = memWs({});
  assert.deepEqual(unanchoredDependencies('a.py', original, proposed, ws, 'please use weirdlib for this'), []);
  assert.equal(unanchoredDependencies('a.py', original, proposed, ws, 'no mention here').length, 1);
});

test('dependency guard: JS require/import checked against package.json + node_modules; relative imports ignored', () => {
  const proposed = "const x = require('left-pad');\nimport y from './local';\nimport z from 'lodash';\n";
  const ws = memWs({ 'package.json': JSON.stringify({ dependencies: { lodash: '^4.0.0' } }) }, new Set());
  const issues = unanchoredDependencies('a.ts', '', proposed, ws, '');
  assert.deepEqual(issues.map((i) => i.name), ['left-pad']);
});

test('manifestNames parses requirements.txt, pyproject deps array and package.json', () => {
  const ws = memWs({
    'requirements.txt': 'Flask>=3.0\n# comment\nclick\n',
    'package.json': JSON.stringify({ dependencies: { express: '1.0.0' } }),
  });
  const m = manifestNames(ws);
  assert.ok(m.py.has('flask') && m.py.has('click'));
  assert.ok(m.js.has('express'));
});

test('dependency guard: stdlib and already-present imports are never flagged', () => {
  const proposed = 'import sys\nimport json\n';
  assert.deepEqual(unanchoredDependencies('a.py', '', proposed, memWs({}), ''), []);
  const original = 'import requests\n';
  assert.deepEqual(unanchoredDependencies('a.py', original, original, memWs({}), ''), [], 'unchanged import is not newly introduced');
});
