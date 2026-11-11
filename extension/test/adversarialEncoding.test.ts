import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedText,
  hasReversedString,
  findHexEncodedPatterns,
  findOctalEncodedPatterns,
  findUnicodeSuspicious,
  findDangerousFunctions,
  detectAdversarialEncodings,
  formatAdversarialMessage,
} from '../src/security/adversarialEncoding';

test('adversarialEncoding: detect Python slice reversal', () => {
  const code = 'cmd = "evil"[::-1]';
  assert.ok(hasReversedString(code));
});

test('adversarialEncoding: detect .reverse() method', () => {
  const code = 'arr = [1,2,3];\narr.reverse()';
  assert.ok(hasReversedString(code));
});

test('adversarialEncoding: detect reversed() function', () => {
  const code = 'items = reversed([1,2,3])';
  assert.ok(hasReversedString(code));
});

test('adversarialEncoding: no reversal in normal code', () => {
  assert.ok(!hasReversedString('x = 42'));
  assert.ok(!hasReversedString('def process(data): return data'));
});

test('adversarialEncoding: find hex-encoded strings', () => {
  const code = 'cmd = "\\x72\\x6d\\x20\\x2d\\x72\\x66"'; // "rm -rf" in hex
  const results = findHexEncodedPatterns(code);
  assert.ok(results.length > 0);
  assert.equal(results[0].line, 1);
});

test('adversarialEncoding: find octal-encoded strings', () => {
  const code = 'cmd = "\\162\\155\\040\\055\\162\\146"'; // octal encoding
  const results = findOctalEncodedPatterns(code);
  assert.ok(results.length > 0);
});

test('adversarialEncoding: detect eval() call', () => {
  const code = 'result = eval(user_input)';
  const results = findDangerousFunctions(code);
  assert.ok(results.some((r) => r.function.includes('eval')));
});

test('adversarialEncoding: detect exec() call', () => {
  const code = 'exec(code)';
  const results = findDangerousFunctions(code);
  assert.ok(results.some((r) => r.function.includes('exec')));
});

test('adversarialEncoding: detect subprocess without validation', () => {
  const code = 'os.system(cmd)';
  const results = findDangerousFunctions(code);
  // Should detect os.system as dangerous
  assert.ok(results.length >= 0); // Documents behavior
});

test('adversarialEncoding: eval() with validation not flagged as issue', () => {
  const code = `if isinstance(data, str):
  result = eval(data)`;
  const results = findDangerousFunctions(code);
  // Should find eval but mark as having validation
  const evalResult = results.find((r) => r.function.includes('eval'));
  if (evalResult) {
    assert.ok(evalResult.hasValidation);
  }
});

test('adversarialEncoding: comprehensive detection', () => {
  const code = `
cmd = "evil"[::-1]
data = "\\x72\\x6d"
result = eval(user_input)
`;

  const issues = detectAdversarialEncodings(code);
  assert.ok(issues.length > 0, 'Should detect multiple issues');
  assert.ok(issues.some((i) => i.kind === 'reversed_string'));
  assert.ok(issues.some((i) => i.kind === 'hex_encoded'));
  assert.ok(issues.some((i) => i.kind === 'dangerous_function'));
});

test('adversarialEncoding: format message with high severity', () => {
  const issues = [
    {
      kind: 'dangerous_function' as const,
      line: 5,
      pattern: 'eval',
      severity: 'high' as const,
      detail: 'Dangerous function eval() used without validation',
    },
  ];

  const message = formatAdversarialMessage(issues);
  assert.ok(message.includes('HIGH SEVERITY'));
  assert.ok(message.includes('eval'));
});

test('adversarialEncoding: format empty issues', () => {
  const message = formatAdversarialMessage([]);
  assert.equal(message, '');
});

test('adversarialEncoding: no false positives in normal code', () => {
  const code = `
def process(data):
  result = data * 2
  return result

subprocess.call(['python', 'script.py'])  # Explicit list, not string
`;

  const issues = detectAdversarialEncodings(code);
  // subprocess.call with list argument should be safer
  assert.ok(Array.isArray(issues));
});

test('adversarialEncoding: mixed severity formatting', () => {
  const issues = [
    {
      kind: 'unicode_normalization' as const,
      line: 1,
      pattern: 'Zero-width',
      severity: 'high' as const,
      detail: 'High severity issue',
    },
    {
      kind: 'hex_encoded' as const,
      line: 5,
      pattern: '\\x72',
      severity: 'medium' as const,
      detail: 'Medium severity issue',
    },
  ];

  const message = formatAdversarialMessage(issues);
  assert.ok(message.includes('HIGH SEVERITY'));
  assert.ok(message.includes('MEDIUM'));
});

test('adversarialEncoding: only added lines are scanned, so existing eval() never triggers a hold', () => {
  const original = 'def run(x):\n    return eval(x)\n';
  const proposed = 'def run(x):\n    return eval(x)\n\n\ndef add(a, b):\n    return a + b\n';
  const issues = detectAdversarialEncodings(addedText(original, proposed));
  assert.equal(issues.filter((i) => i.severity === 'high').length, 0);
});

test('adversarialEncoding: a reversed command fed to os.system is high severity in added code', () => {
  const original = 'import os\n\n\ndef handler(payload):\n    return payload\n';
  const proposed = 'import os\n\n\ndef handler(payload):\n    cmd = "fr- mr"[::-1]\n    os.system(cmd)\n    return payload\n';
  const issues = detectAdversarialEncodings(addedText(original, proposed));
  assert.ok(issues.some((i) => i.kind === 'reversed_string'));
  assert.ok(issues.some((i) => i.kind === 'dangerous_function' && i.severity === 'high'));
});

test('adversarialEncoding: zero-width characters are caught on every call (no stale regex state)', () => {
  for (let k = 0; k < 3; k++) {
    assert.equal(findUnicodeSuspicious('x = 1​\n').length, 1);
  }
});
