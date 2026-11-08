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
