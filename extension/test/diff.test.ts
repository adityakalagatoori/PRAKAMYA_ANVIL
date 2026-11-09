import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, applySearchReplace, computeHunks, hunkStartIn, minimalEdit } from '../src/review/diff';

const A = 'a\nb\nc\nd\ne\nf\ng\n';
const B = 'a\nB\nc\nd\ne\nF1\nF2\ng\nh\n';

test('hunks: all accepted == proposed, none accepted == original', () => {
  const hs = computeHunks(A, B);
  assert.equal(hs.length, 3);
  assert.equal(applyHunks(A, hs, new Set(hs.map((h) => h.index))), B);
  assert.equal(applyHunks(A, hs, new Set()), A);
});

test('hunks: any subset applies independently', () => {
  const hs = computeHunks(A, B);
  assert.equal(applyHunks(A, hs, new Set([1])), 'a\nb\nc\nd\ne\nF1\nF2\ng\n');
  assert.equal(applyHunks(A, hs, new Set([0, 2])), 'a\nB\nc\nd\ne\nf\ng\nh\n');
});

test('hunk start positions shift with earlier shown hunks', () => {
  const hs = computeHunks(A, B);
  const all = new Set([0, 1, 2]);
  assert.equal(hunkStartIn(hs, all, hs[2]), 8); // after F1,F2 insertion (+1)
});

test('CRLF preserved', () => {
  const a = 'x\r\ny\r\n';
  const hs = computeHunks(a, 'x\r\nY\r\n');
  assert.equal(applyHunks(a, hs, new Set([0])), 'x\r\nY\r\n');
});

test('minimalEdit', () => {
  assert.deepEqual(minimalEdit('hello world', 'hello brave world'), { start: 6, end: 6, text: 'brave ' });
});

test('search/replace: exact, ambiguous, missing, whitespace-tolerant, CRLF', () => {
  assert.deepEqual(applySearchReplace('a\nb\nc\n', 'b\n', 'B\n'), { ok: true, result: 'a\nB\nc\n' });
  assert.equal(applySearchReplace('x\nx\n', 'x', 'y').ok, false);
  assert.equal(applySearchReplace('x\n', 'zzz', 'y').ok, false);
  assert.deepEqual(applySearchReplace('def f():   \n    pass\n', 'def f():\n    pass', 'def g():\n    pass'), { ok: true, result: 'def g():\n    pass\n' });
  assert.deepEqual(applySearchReplace('a\r\nb\r\n', 'a\nb', 'a\nc'), { ok: true, result: 'a\r\nc\r\n' });
});

test('search/replace miss returns the closest region with line numbers (diff-edit-failed loops)', async () => {
  const { applySearchReplace } = await import('../src/review/diff');
  const file = 'import os\n\ndef get_debug_flag() -> bool:\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n';
  const r = applySearchReplace(file, 'def get_debug_flag():\n    val = os.environ.get("FLASK_DEBUG")', 'x');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /closest region is lines 2-/);
    assert.match(r.error, /\s3\| def get_debug_flag\(\) -> bool:/);
  }
  const multi = applySearchReplace('a\nb\na\nb\n', 'a\nb', 'z');
  assert.ok(!multi.ok && /matches 2 locations \(lines 1, 3\)/.test(multi.error));
});
