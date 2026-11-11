import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrintedToolCall,
  extractPrintedToolCalls,
  mightContainPrintedToolCall,
} from '../src/mcp/printedToolParser';

test('printedToolParser: parse JSON format with double quotes', () => {
  const text = '{"name": "edit_file", "arguments": {"rel": "file.py", "original": "x = 1", "new_string": "x = 2"}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'edit_file');
  assert.equal(result?.arguments.rel, 'file.py');
  assert.equal(result?.arguments.original, 'x = 1');
});

test('printedToolParser: parse JSON format with single quotes (should return null - JSON requires double quotes)', () => {
  const text = "{'name': 'read_file', 'arguments': {'rel': 'test.py'}}";
  const result = parsePrintedToolCall(text);
  // JSON.parse doesn't accept single quotes, so this should fail
  // Models that output JSON would use proper double quotes
  assert.equal(result, null);
});

test('printedToolParser: parse JSON with "tool" field instead of "name"', () => {
  const text = '{"tool": "search_code", "arguments": {"pattern": "def foo"}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'search_code');
  assert.equal(result?.arguments.pattern, 'def foo');
});

test('printedToolParser: parse JSON with whitespace variation', () => {
  const text = '{  "name"  :  "edit_file"  ,  "arguments"  :  {"rel": "x.py"}  }';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'edit_file');
  assert.equal(result?.arguments.rel, 'x.py');
});

test('printedToolParser: parse function call syntax in JSON format', () => {
  // Models print tool calls as JSON, not as JavaScript function syntax
  const text = '{"name": "edit_file", "arguments": {"rel": "file.py", "original": "old", "new_string": "new"}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'edit_file');
  assert.equal(result?.arguments.rel, 'file.py');
  assert.equal(result?.arguments.original, 'old');
});

test('printedToolParser: parse tag format', () => {
  const text = '<tool_call name="read_file" arguments={"rel": "test.py"}></tool_call>';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'read_file');
  assert.equal(result?.arguments.rel, 'test.py');
});

test('printedToolParser: reject invalid tool names', () => {
  const text = '{"name": "invalid_tool", "arguments": {}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result, null);
});

test('printedToolParser: reject malformed JSON', () => {
  const text = '{"name": "edit_file", "arguments": {incomplete}';
  const result = parsePrintedToolCall(text);
  assert.equal(result, null);
});

test('printedToolParser: reject empty text', () => {
  const result = parsePrintedToolCall('');
  assert.equal(result, null);
});

test('printedToolParser: handle nested JSON in arguments', () => {
  const text = '{"name": "edit_file", "arguments": {"rel": "file.py", "original": "{\\"nested\\": true}", "new_string": "updated"}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'edit_file');
  assert.equal(result?.arguments.rel, 'file.py');
});

test('printedToolParser: extract multiple printed calls', () => {
  const text = `
First call:
{"name": "read_file", "arguments": {"rel": "file.py"}}

Second call:
{"name": "edit_file", "arguments": {"rel": "file.py", "original": "x", "new_string": "y"}}
  `;
  const results = extractPrintedToolCalls(text);
  assert.equal(results.length, 2);
  assert.equal(results[0].name, 'read_file');
  assert.equal(results[1].name, 'edit_file');
});

test('printedToolParser: heuristic detection catches tool names', () => {
  assert.ok(mightContainPrintedToolCall('{"name": "edit_file"}'));
  assert.ok(mightContainPrintedToolCall("{'tool': 'read_file'}"));
  assert.ok(mightContainPrintedToolCall('<tool_call name="search_code"'));
  assert.ok(!mightContainPrintedToolCall('just some text about editing'));
});

test('printedToolParser: all valid tool names accepted', () => {
  const validTools = [
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
  ];

  for (const tool of validTools) {
    const text = `{"name": "${tool}", "arguments": {}}`;
    const result = parsePrintedToolCall(text);
    assert.equal(result?.name, tool, `Failed to parse ${tool}`);
  }
});

test('printedToolParser: complex arguments with arrays', () => {
  const text = '{"name": "run_command", "arguments": {"command": "pytest", "args": ["tests/test_foo.py", "-v"]}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'run_command');
  assert.equal(result?.arguments.command, 'pytest');
  assert.deepEqual(result?.arguments.args, ['tests/test_foo.py', '-v']);
});

test('printedToolParser: handles "arguments" field correctly', () => {
  const text = '{"name": "read_file", "arguments": {"rel": "file.py", "max_lines": 100}}';
  const result = parsePrintedToolCall(text);
  assert.equal(result?.name, 'read_file');
  assert.equal(result?.arguments.rel, 'file.py');
  assert.equal(result?.arguments.max_lines, 100);
});
