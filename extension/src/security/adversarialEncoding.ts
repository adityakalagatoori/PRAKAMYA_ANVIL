/**
 * P5: Adversarial encoding detection
 * Detects obfuscated commands and dangerous function calls using encoding tricks:
 * - Character reversal/splitting
 * - Hex/octal encoding
 * - Unicode normalization attacks
 * - Dangerous function usage (eval, exec, subprocess with user input)
 */

export interface EncodingIssue {
  kind: 'reversed_string' | 'hex_encoded' | 'octal_encoded' | 'unicode_normalization' | 'dangerous_function';
  line: number;
  pattern: string;
  severity: 'medium' | 'high';
  detail: string;
}

/**
 * Dangerous function patterns that need validation
 */
const DANGEROUS_FUNCTIONS = [
  /\b(eval|exec|compile|__import__|execfile|load_source)\s*\(/gi,
  /\b(subprocess|os\.system|os\.popen|commands\.getoutput)\s*\(/gi,
  /\b(pickle\.loads|pickle\.load)\s*\(/gi,
  /\b(marshal\.loads)\s*\(/gi,
  /\b(yaml\.load|yaml\.unsafe_load)\s*\(/gi,
];

/**
 * Detect hex-encoded strings (\\x... patterns)
 */
const HEX_ENCODED = /\\x[0-9a-f]{2}|0x[0-9a-f]+/gi;

/**
 * Detect octal-encoded characters (\\0... patterns)
 */
const OCTAL_ENCODED = /\\[0-7]{2,3}/g;

/**
 * Detect Unicode normalization forms that can be used for evasion
 */
const UNICODE_SUSPICIOUS = [
  /[​-‍﻿]/g, // Zero-width characters
  /[̀-ͯ]+/g, // Combining diacriticals
  /[︀-️]+/g, // Variation selectors
  /[‪-‮]/g, // Bidirectional override characters
];

/**
 * Check if a string appears to be reversed (simple heuristic)
 */
export function hasReversedString(code: string): boolean {
  // Look for patterns like: [::-1] or .reverse() or reversal patterns
  const reversePatterns = [
    /\[::-1\]/g, // Python slice reversal
    /\.reverse\s*\(/gi, // JavaScript/Python reverse()
    /reversed\s*\(/gi, // Python reversed()
  ];

  return reversePatterns.some((p) => p.test(code));
}

/**
 * Detect hex-encoded command strings
 */
export function findHexEncodedPatterns(code: string): { line: number; pattern: string }[] {
  const results: { line: number; pattern: string }[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hexMatches = line.match(HEX_ENCODED);

    if (hexMatches) {
      for (const match of hexMatches) {
        results.push({ line: i + 1, pattern: match });
      }
    }
  }

  return results;
}

/**
 * Detect octal-encoded patterns
 */
export function findOctalEncodedPatterns(code: string): { line: number; pattern: string }[] {
  const results: { line: number; pattern: string }[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const octalMatches = line.match(OCTAL_ENCODED);

    if (octalMatches) {
      for (const match of octalMatches) {
        results.push({ line: i + 1, pattern: match });
      }
    }
  }

  return results;
}

/**
 * Detect suspicious Unicode characters
 */
export function findUnicodeSuspicious(code: string): { line: number; charCode: string }[] {
  const results: { line: number; charCode: string }[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of UNICODE_SUSPICIOUS) {
      pattern.lastIndex = 0; // global regexes keep state between .test() calls
      if (pattern.test(line)) {
        results.push({ line: i + 1, charCode: `Unicode pattern matched` });
      }
    }
  }

  return results;
}

/**
 * Detect dangerous function calls without validation
 */
export function findDangerousFunctions(code: string): {
  line: number;
  function: string;
  hasValidation: boolean;
}[] {
  const results: {
    line: number;
    function: string;
    hasValidation: boolean;
  }[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of DANGEROUS_FUNCTIONS) {
      const matches = [...line.matchAll(pattern)];

      for (const match of matches) {
        const funcName = match[1] || match[0];

        // Simple heuristic: check if there's validation before the call
        // (not foolproof, but catches obvious cases)
        const prevLines = lines.slice(Math.max(0, i - 5), i).join('\n');
        const hasValidation =
          /\b(if|assert|isinstance|type|validate|check|verify|sanitize)\b/i.test(prevLines) ||
          /\b(isinstance|type)\s*\(.*?,\s*(str|bytes)\s*\)/i.test(prevLines);

        results.push({
          line: i + 1,
          function: funcName,
          hasValidation,
        });
      }
    }
  }

  return results;
}

/** Lines present in `proposed` that `original` did not have (so pre-existing code never triggers a hold). */
export function addedText(original: string, proposed: string): string {
  const before = new Set(original.replace(/\r\n/g, '\n').split('\n'));
  return proposed.replace(/\r\n/g, '\n').split('\n').filter((l) => !before.has(l)).join('\n');
}

/**
 * Comprehensive adversarial encoding detection
 */
export function detectAdversarialEncodings(code: string): EncodingIssue[] {
  const issues: EncodingIssue[] = [];

  // Check for reversed strings
  if (hasReversedString(code)) {
    issues.push({
      kind: 'reversed_string',
      line: 1,
      pattern: 'String reversal detected',
      severity: 'medium',
      detail: 'Code uses string reversal operations ([::-1], .reverse(), etc.). This may be obfuscation.',
    });
  }

  // Check for hex encoding
  const hexPatterns = findHexEncodedPatterns(code);
  for (const { line, pattern } of hexPatterns.slice(0, 3)) {
    issues.push({
      kind: 'hex_encoded',
      line,
      pattern,
      severity: 'medium',
      detail: `Hex-encoded string found: ${pattern}. May be obfuscated command or data.`,
    });
  }

  // Check for octal encoding
  const octalPatterns = findOctalEncodedPatterns(code);
  for (const { line, pattern } of octalPatterns.slice(0, 3)) {
    issues.push({
      kind: 'octal_encoded',
      line,
      pattern,
      severity: 'medium',
      detail: `Octal-encoded string found: ${pattern}. May be obfuscated command.`,
    });
  }

  // Check for suspicious Unicode
  const unicodeIssues = findUnicodeSuspicious(code);
  for (const { line } of unicodeIssues.slice(0, 3)) {
    issues.push({
      kind: 'unicode_normalization',
      line,
      pattern: 'Suspicious Unicode',
      severity: 'high',
      detail: 'Code contains suspicious Unicode characters (zero-width, bidirectional, etc.). This is a strong indicator of obfuscation or injection attack.',
    });
  }

  // Check for dangerous functions
  const dangerousFuncs = findDangerousFunctions(code);
  for (const { line, function: func, hasValidation } of dangerousFuncs) {
    if (!hasValidation) {
      issues.push({
        kind: 'dangerous_function',
        line,
        pattern: func,
        severity: 'high',
        detail: `Dangerous function ${func}() used without apparent validation. Verify input is sanitized.`,
      });
    }
  }

  return issues;
}

/**
 * Format adversarial encoding issues for user display
 */
export function formatAdversarialMessage(issues: EncodingIssue[]): string {
  if (issues.length === 0) return '';

  const highSeverity = issues.filter((i) => i.severity === 'high');
  const mediumSeverity = issues.filter((i) => i.severity === 'medium');

  const lines = [];

  if (highSeverity.length > 0) {
    lines.push(`⚠ HIGH SEVERITY: ${highSeverity.length} adversarial encoding issue(s) detected`);
    for (const issue of highSeverity.slice(0, 3)) {
      lines.push(`  Line ${issue.line}: ${issue.detail}`);
    }
  }

  if (mediumSeverity.length > 0) {
    lines.push(`⚠ MEDIUM: ${mediumSeverity.length} potential encoding issue(s)`);
    for (const issue of mediumSeverity.slice(0, 3)) {
      lines.push(`  Line ${issue.line}: ${issue.detail}`);
    }
  }

  if (issues.length > 6) {
    lines.push(`… and ${issues.length - 6} more issue(s)`);
  }

  return lines.join('\n');
}
