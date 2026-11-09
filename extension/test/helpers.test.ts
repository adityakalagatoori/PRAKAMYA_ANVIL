import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeChangeRequest, looksLikeTextToolCall, rateLimitDelayMs, rateLimitWaitMs } from '../src/trueforge/runner';
import { closestMatchHint } from '../src/review/diff';

test('rateLimitWaitMs: provider hint first, then escalates to >=15s/30s/60s on consecutive rate limits', () => {
  const msg = '429 Too Many Requests. Please retry in 0.5s.';
  const hint = rateLimitDelayMs(msg)!;
  assert.equal(hint, 2000);
  assert.equal(rateLimitWaitMs(msg, 0), hint, '1st rate limit honours the hint');
  assert.equal(rateLimitWaitMs(msg, 1), 15_000, '2nd consecutive: at least 15s');
  assert.equal(rateLimitWaitMs(msg, 2), 30_000);
  assert.equal(rateLimitWaitMs(msg, 3), 60_000);
  assert.equal(rateLimitWaitMs(msg, 39), 60_000, 'capped at 60s');
  // A larger provider hint wins over the escalation floor.
  assert.equal(rateLimitWaitMs('429. Please retry in 40s.', 1), 41_000);
  // Not a rate limit / daily cap → no rate-limit wait (normal backoff or fallback applies).
  assert.equal(rateLimitWaitMs('401 invalid api key', 1), undefined);
  assert.equal(rateLimitWaitMs('429: requests per day limit exceeded. Please retry in 30s.', 0), undefined);
});

test('looksLikeChangeRequest: imperative edits yes, questions no, ignores attached context', () => {
  for (const t of ['Add a --port flag to the CLI', 'fix the failing test in test_basic.py', 'Rename get_debug_flag to debug_flag', 'please refactor helpers']) {
    assert.ok(looksLikeChangeRequest(t), t);
  }
  for (const t of ['How does routing work?', 'Explain what url_for does', 'Where is the app context pushed?']) {
    assert.ok(!looksLikeChangeRequest(t), t);
  }
  // Verbs inside the attached <anvil_context> block must not turn a question into a change request.
  assert.ok(!looksLikeChangeRequest('What does this do?\n<anvil_context>def add(): update(); remove()</anvil_context>'));
});

test('looksLikeTextToolCall: JSON, <tool_call> and name({ forms detected; ordinary Python is not', () => {
  assert.ok(looksLikeTextToolCall('<tool_call>\n{"name": "search_code", "arguments": {"query": "url_for"}}\n</tool_call>'));
  assert.ok(looksLikeTextToolCall('read_file({"path": "src/flask/helpers.py"})'));
  assert.ok(looksLikeTextToolCall('{"name": "edit_file", "arguments": {}}'));
  assert.ok(looksLikeTextToolCall('{"tool": "anvil__find_symbol", "args": {"name": "Flask"}}'));
  const python = [
    'def get_debug_flag() -> bool:',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no"})',
    '',
    'data = {"name": "flask", "version": "3.1.3"}',
    'print(read(path))',
  ].join('\n');
  assert.ok(!looksLikeTextToolCall(python));
  assert.ok(!looksLikeTextToolCall('I changed `read_file` handling in the loader; the tests now pass.'));
});

test('closestMatchHint: unrelated text → "No similar region found"', () => {
  const file = ['import os', '', 'def get_debug_flag() -> bool:', '    return True', ''];
  const hint = closestMatchHint(file, ['class Totally:', '    unrelated = 42']);
  assert.match(hint, /No similar region found/);
  assert.doesNotMatch(hint, /closest region/);
  // Empty inputs fall back to the re-read advice.
  assert.match(closestMatchHint([], ['x']), /Re-read the file/);
});
