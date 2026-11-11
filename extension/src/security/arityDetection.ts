/**
 * Parameter arity detection: catches when function signatures change in ways that break existing calls.
 * Specifically detects when a function gains a required parameter that existing code doesn't provide.
 */

export interface ArityIssue {
  name: string;
  line: number;
  originalArity: number;
  newArity: number;
  requiredParams: string[];
  detail: string;
}

/**
 * Extract function definitions from Python code.
 * Returns {functionName, line, argsCount, requiredArgs}
 */
export function extractPythonFunctions(code: string): Array<{
  name: string;
  line: number;
  totalParams: number;
  requiredParams: number;
}> {
  const functions: Array<{ name: string; line: number; totalParams: number; requiredParams: number }> = [];

  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match function definitions: def name(args):
    // Handles indentation (methods inside classes)
    const match = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\((.*?)\)\s*:/);
    if (match) {
      const name = match[1];
      const argStr = match[2].trim();

      // Count parameters
      let totalParams = 0;
      let requiredParams = 0;

      if (argStr === '' || argStr === 'self') {
        // No parameters (or just self)
        totalParams = argStr === 'self' ? 1 : 0;
        requiredParams = 0;
      } else {
        // Split args by comma, handling defaults
        const args = argStr.split(',').map((a) => a.trim());
        totalParams = args.length;

        // Count required params (those without defaults and without * or **)
        for (const arg of args) {
          if (arg.startsWith('*')) {
            // *args or **kwargs don't count toward arity
            continue;
          }
          if (!arg.includes('=')) {
            // No default value = required
            requiredParams++;
          }
        }
      }

      functions.push({ name, line: i + 1, totalParams, requiredParams });
    }
  }

  return functions;
}

/**
 * Detect arity issues by comparing original and proposed function signatures.
 * Returns issues where required parameters were added.
 */
export function detectArityIssues(original: string, proposed: string): ArityIssue[] {
  const issues: ArityIssue[] = [];

  const originalFuncs = new Map(extractPythonFunctions(original).map((f) => [f.name, f]));
  const proposedFuncs = new Map(extractPythonFunctions(proposed).map((f) => [f.name, f]));

  // Check each function that exists in both versions
  for (const [name, origFunc] of originalFuncs) {
    const newFunc = proposedFuncs.get(name);
    if (!newFunc) continue; // Function removed (different issue)

    // Check if required parameters increased
    if (newFunc.requiredParams > origFunc.requiredParams) {
      issues.push({
        name,
        line: newFunc.line,
        originalArity: origFunc.requiredParams,
        newArity: newFunc.requiredParams,
        requiredParams: [], // Would need more parsing to extract actual param names
        detail: `Function ${name}() gained ${newFunc.requiredParams - origFunc.requiredParams} required parameter(s). Existing calls with ${origFunc.requiredParams} argument(s) will fail.`,
      });
    }
  }

  return issues;
}

/**
 * Format arity issues for user display.
 */
export function formatArityMessage(issues: ArityIssue[]): string {
  if (issues.length === 0) return '';

  const lines = [
    `Parameter arity issue(s) detected: ${issues.length} function(s) gained required parameter(s).`,
  ];

  for (const issue of issues.slice(0, 3)) {
    lines.push(`  • ${issue.name}() (line ${issue.line}): required parameters increased from ${issue.originalArity} to ${issue.newArity}`);
    lines.push(`    ${issue.detail}`);
  }

  if (issues.length > 3) {
    lines.push(`  … and ${issues.length - 3} more function(s)`);
  }

  return lines.join('\n');
}
