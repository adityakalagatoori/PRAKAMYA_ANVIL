import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks } from '../src/review/diff';
import { closureOf, danglingNames, dependentsOf, hunkGraph } from '../src/review/closure';

const filler = (n: number) => Array.from({ length: n }, (_, i) => `x${i} = ${i}`).join('\n');

const ORIGINAL = ['import json', '', filler(12), '', 'def run():', '    return 1', '', filler(12), '', 'def main():', '    run()', ''].join('\n');
const PROPOSED = [
  'import json',
  '',
  'SECRET_WORDS = ("SECRET", "PASSWORD", "TOKEN", "KEY")',
  '',
  'def _mask(key, value):',
  '    return "***" if any(w in key.upper() for w in SECRET_WORDS) else value',
  '',
  filler(12),
  '',
  'def run():',
  '    return 1',
  '',
  filler(12),
  '',
  'def config_command(cfg):',
  '    print(json.dumps({k: _mask(k, v) for k, v in cfg.items()}))',
  '',
  'def main():',
  '    run()',
  '',
].join('\n');

test('closure: a hunk that calls a helper requires the hunk that defines it', () => {
  const hunks = computeHunks(ORIGINAL, PROPOSED);
  assert.equal(hunks.length, 2, JSON.stringify(hunks.map((h) => h.newLines)));
  const g = hunkGraph('cli.py', ORIGINAL, hunks);
  assert.deepEqual([...(g.requires.get(1) ?? [])], [0], 'config_command (hunk 2) needs _mask (hunk 1)');
  assert.ok(!g.requires.get(0)?.size, 'the helper stands alone');
  assert.match(g.why.get('1->0')!, /_mask/);
  assert.deepEqual([...closureOf(g, [1], new Set([0]))], [0], 'accepting hunk 2 offers hunk 1 with it');
  assert.deepEqual([...dependentsOf(g, [0], new Set([1]))], [1], 'rejecting hunk 1 affects hunk 2');
});

test('closure: the exact accepted subset is checked counterfactually', () => {
  const hunks = computeHunks(ORIGINAL, PROPOSED);
  assert.deepEqual(danglingNames('cli.py', ORIGINAL, hunks, new Set([0, 1])), []);
  assert.deepEqual(danglingNames('cli.py', ORIGINAL, hunks, new Set([0])), [], 'helper alone is harmless');
  const d = danglingNames('cli.py', ORIGINAL, hunks, new Set([1]));
  assert.deepEqual(d.map((x) => x.name), ['_mask'], 'command without its helper leaves _mask undefined');
});

test('closure: a signature change and its call-site update are coupled both ways; a rename needs its callers', () => {
  const orig = ['def area(w):', '    return w * w', '', filler(12), '', 'def main():', '    print(area(3))', ''].join('\n');
  const prop = ['def area(w, h):', '    return w * h', '', filler(12), '', 'def main():', '    print(area(3, 4))', ''].join('\n');
  const hunks = computeHunks(orig, prop);
  assert.equal(hunks.length, 2);
  const g = hunkGraph('geo.py', orig, hunks);
  assert.ok(g.requires.get(0)?.has(1) && g.requires.get(1)?.has(0));
  const ren = ['def surface(w):', '    return w * w', '', filler(12), '', 'def main():', '    print(surface(3))', ''].join('\n');
  const rh = computeHunks(orig, ren);
  const rg = hunkGraph('geo.py', orig, rh);
  assert.ok(rg.requires.get(0)?.has(1), 'removing area() requires updating its caller');
  assert.deepEqual(danglingNames('geo.py', orig, rh, new Set([0])).map((x) => x.name), ['area']);
});

test('closure: JS/TS imports and helpers; unrelated files have no dependencies', () => {
  const orig = ['export function a() { return 1; }', '', filler(12).replace(/x(\d+) = /g, 'const y$1 = '), '', 'export function b() { return a(); }', ''].join('\n');
  const prop = ['export function a() { return 1; }', 'function helper(n) { return n * 2; }', '', filler(12).replace(/x(\d+) = /g, 'const y$1 = '), '', 'export function b() { return helper(a()); }', ''].join('\n');
  const hunks = computeHunks(orig, prop);
  const g = hunkGraph('m.ts', orig, hunks);
  assert.ok(g.requires.get(1)?.has(0));
  assert.deepEqual(danglingNames('m.ts', orig, hunks, new Set([1])).map((x) => x.name), ['helper']);
  assert.equal(hunkGraph('README.md', 'a\n', computeHunks('a\n', 'b\n')).requires.size, 0);
});
