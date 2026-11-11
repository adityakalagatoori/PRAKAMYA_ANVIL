/**
 * License-contamination check: detects when proposed hunks closely match license/copyright
 * text observed in the session's ledger.
 *
 * This is session-scoped (not external corpus) and only flags close matches to ensure
 * the model didn't inadvertently copy license text from code it read.
 */

import { ObservationLedger } from '../context/observation';

export interface LicenseContaminationIssue {
  kind: 'matches_observed_license';
  line: number;
  pattern: string;
  observedIn: { path: string; line: number };
}

/**
 * Common license and copyright headers/patterns to detect.
 * These are markers that indicate a file is likely to contain license text.
 */
const LICENSE_PATTERNS = [
  /Copyright\s+.*?\d{4}/i,
  /\(c\)\s*\d{4}/i,
  /©\s*\d{4}/,
  /License\s*:/i,
  /This file is part of/i,
  /This software is licensed under/i,
  /Licensed under the/i,
  /Permission is hereby granted/i,
  /SPDX-License-Identifier/i,
  /Apache\s+License/i,
  /MIT\s+License/i,
  /BSD\s+License/i,
  /GNU\s+(?:General\s+)?Public\s+License/i,
  /GPL\s+v\d/i,
  /LGPL/i,
  /Creative Commons/i,
  /All rights reserved/i,
  /Proprietary\s+and\s+Confidential/i,
];

/**
 * Check if text contains license/copyright markers.
 */
export function hasLicenseText(text: string): boolean {
  return LICENSE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Find similarity between two strings using a simple algorithm.
 * Returns 0-1, where 1 is an exact match.
 */
function stringSimilarity(a: string, b: string): number {
  const aLines = a.split('\n').filter((l) => l.trim());
  const bLines = b.split('\n').filter((l) => l.trim());

  if (aLines.length === 0 || bLines.length === 0) return 0;

  let matches = 0;
  for (const aLine of aLines) {
    for (const bLine of bLines) {
      if (aLine.trim() === bLine.trim()) {
        matches++;
        break;
      }
    }
  }

  return matches / Math.max(aLines.length, bLines.length);
}

/**
 * Check proposed text for license contamination against session observations.
 * Returns issues for any close matches found.
 */
export function licenseContaminationIssues(
  proposed: string,
  ledger: ObservationLedger
): LicenseContaminationIssue[] {
  const issues: LicenseContaminationIssue[] = [];

  // Extract lines that contain license/copyright text
  const proposedLines = proposed.split('\n').map((text, idx) => ({ line: idx + 1, text }));
  const licenseLinesInProposed = proposedLines.filter(({ text }) => hasLicenseText(text));

  // If no license text in proposed, no issues
  if (licenseLinesInProposed.length === 0) {
    return issues;
  }

  // Check each license line in proposed against all observations
  for (const { line, text } of licenseLinesInProposed) {
    for (const obsPath of ledger.paths()) {
      const observations = ledger.all(obsPath);

      for (const obs of observations) {
        // Skip if observation itself is not license-related
        if (!hasLicenseText(obs.text)) continue;

        // Check for close match (similarity > 0.7)
        const similarity = stringSimilarity(text, obs.text);
        if (similarity > 0.7) {
          issues.push({
            kind: 'matches_observed_license',
            line,
            pattern: text.trim().slice(0, 80), // First 80 chars
            observedIn: { path: obsPath, line: obs.line },
          });
          // Don't report multiple issues for the same line
          break;
        }
      }
    }
  }

  return issues;
}

/**
 * Format license contamination issues for user display.
 */
export function formatLicenseContaminationMessage(issues: LicenseContaminationIssue[]): string {
  if (issues.length === 0) return '';

  const lines = [
    `License/copyright contamination check: ${issues.length} potential match(es) found.`,
    'The following proposed text matches license/copyright blocks this session has observed:',
  ];

  for (const issue of issues.slice(0, 5)) {
    lines.push(
      `  Line ${issue.line}: "${issue.pattern}${issue.pattern.length >= 80 ? '…' : ''}"`,
      `    Observed in: ${issue.observedIn.path}:${issue.observedIn.line}`,
    );
  }

  if (issues.length > 5) {
    lines.push(`  … and ${issues.length - 5} more`);
  }

  lines.push('');
  lines.push(
    'License/copyright text should not be copied from observed code. If this is intentional, you can override this hold.',
  );

  return lines.join('\n');
}
