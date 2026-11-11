/**
 * Parses tool calls that are printed as text/JSON instead of using real function calling.
 * Handles formats like: {"name": "edit_file", "arguments": {...}} and <tool_call>...</tool_call>
 */

export interface ParsedPrintedCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Try to parse a printed tool call from text.
 * Returns the parsed call or null if parsing fails.
 * Only accepts calls from the model's own response; prevents injection.
 */
export function parsePrintedToolCall(text: string): ParsedPrintedCall | null {
  if (!text || text.length === 0) return null;

  // Pattern 1: JSON object with "name" and "arguments" fields
  // Examples:
  // {"name": "edit_file", "arguments": {...}}
  // {'name': 'edit_file', 'arguments': {...}}
  // { "name" : "edit_file" , "arguments" : {...} }

  // Try to extract the first JSON-like object
  const jsonMatch = text.match(/\{\s*["']?(name|tool|function|arguments)["']?\s*:/);
  if (jsonMatch) {
    // Find the matching closing brace
    let braceCount = 0;
    let inString = false;
    let stringChar = '';
    let endIdx = -1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (!inString) {
        if (char === '"' || char === "'") {
          inString = true;
          stringChar = char;
        } else if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIdx = i;
            break;
          }
        }
      } else {
        if (char === stringChar && text[i - 1] !== '\\') {
          inString = false;
        }
      }
    }

    if (endIdx > 0) {
      const jsonStr = text.substring(0, endIdx + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        // Extract name and arguments
        let name = parsed.name || parsed.tool || parsed.function;
        let args = parsed.arguments || parsed.args || parsed.params;

        if (name && typeof name === 'string' && isValidToolName(name) && args && typeof args === 'object') {
          return { name, arguments: args };
        }
      } catch {
        // Parsing failed, continue
      }
    }
  }

  // Pattern 2: <tool_call name="..." arguments={...}></tool_call>
  const tagMatch = text.match(/<tool_call\s+name=["']([^"']+)["']\s+arguments=(\{[^]*?\})>\s*<\/tool_call>/i);
  if (tagMatch) {
    try {
      const name = tagMatch[1];
      const argsStr = tagMatch[2];
      if (!isValidToolName(name)) return null;
      const args = JSON.parse(argsStr);
      if (typeof args !== 'object' || args === null) return null;
      return { name, arguments: args };
    } catch {
      // Parsing failed
    }
  }

  // Pattern 3: Function call syntax
  // edit_file({ rel: "file.py", ... })
  const funcMatch = text.match(/\b([a-z_]+)\s*\(\s*(\{[^]*?\})\s*\)/i);
  if (funcMatch) {
    try {
      const name = funcMatch[1];
      if (!isValidToolName(name)) return null;
      const argsStr = funcMatch[2];
      const args = JSON.parse(argsStr);
      if (typeof args !== 'object' || args === null) return null;
      return { name, arguments: args };
    } catch {
      // Parsing failed
    }
  }

  return null;
}

/**
 * Check if a tool name is one of the valid Anvil tools.
 */
function isValidToolName(name: string): boolean {
  const validTools = new Set([
    'retrieve_context',
    'search_code',
    'find_symbol',
    'read_file',
    'list_files',
    'repo_map',
    'get_diagnostics',
    'edit_file',
    'create_file',
    'run_command',
    'list_tools',
    'get_tool_info',
    'call_tool',
    'create_sub_agent',
  ]);
  return validTools.has(name);
}

/**
 * Extract all printed tool calls from text.
 * Returns array of all successfully parsed calls found.
 */
export function extractPrintedToolCalls(text: string): ParsedPrintedCall[] {
  const calls: ParsedPrintedCall[] = [];

  // Try to find JSON objects that look like tool calls
  const jsonRegex = /\{\s*["']?(?:function|tool|name)["']?\s*:\s*["']([^"']+)["']/g;
  let match;
  while ((match = jsonRegex.exec(text)) !== null) {
    // Try to parse from this position
    const subset = text.substring(match.index);
    const parsed = parsePrintedToolCall(subset);
    if (parsed) {
      calls.push(parsed);
    }
  }

  return calls;
}

/**
 * Check if text might contain a printed tool call (quick heuristic).
 * Used for deciding whether to attempt parsing.
 */
export function mightContainPrintedToolCall(text: string): boolean {
  const tools = 'retrieve_context|search_code|find_symbol|read_file|list_files|repo_map|get_diagnostics|edit_file|create_file|run_command|list_tools|get_tool_info|call_tool|create_sub_agent';
  const pattern = new RegExp(`["'](${tools})["']|<tool_call`);
  return pattern.test(text);
}
