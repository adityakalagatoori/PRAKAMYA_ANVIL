import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AnvilMcpServer } from '../src/mcp/server';
import { CodeIndex } from '../src/context/index';
import { RunState } from '../src/runState';

const FLASK = process.env.STUB_WORKSPACE!;
const have = !!FLASK && existsSync(join(FLASK, 'src', 'flask', 'cli.py'));

function load(): CodeIndex {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.') || n === '__pycache__') continue;
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(py|rst)$/.test(n)) out.push({ path: relative(FLASK, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') });
    }
  };
  walk(FLASK);
  return CodeIndex.build(out);
}

test('MCP server: auth, tool listing, read tools, write blocked without run', { skip: !have }, async () => {
  const idx = load();
  const log = { appendLine: () => {} } as any;
  const runs = new RunState();
  const server = new AnvilMcpServer({ index: { ready: async () => idx } as any, reviews: {} as any, runs, log, terminal: {} as any }, 'secret', log);
  const port = await server.start(0);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  try {
    // unauthorised
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401);

    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-anvil-token': 'secret' } } }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['create_file', 'edit_file', 'find_symbol', 'get_diagnostics', 'list_files', 'read_file', 'repo_map', 'retrieve_context', 'run_command', 'search_code']);
    const edit = tools.find((t) => t.name === 'edit_file')!;
    assert.equal(edit.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'read_file')!.annotations?.readOnlyHint, true);

    const text = (r: any) => r.content[0].text as string;
    const sym = text(await client.callTool({ name: 'find_symbol', arguments: { name: 'get_debug_flag' } }));
    assert.match(sym, /src\/flask\/helpers\.py:\d+/);
    const grep = text(await client.callTool({ name: 'search_code', arguments: { pattern: 'def routes_command', path_glob: 'src/' } }));
    assert.match(grep, /src\/flask\/cli\.py:\d+: def routes_command/);
    const rc = text(await client.callTool({ name: 'retrieve_context', arguments: { query: 'built-in flask CLI commands like routes and shell', budget_tokens: 2000 } }));
    assert.match(rc, /src\/flask\/cli\.py/);
    const rf = text(await client.callTool({ name: 'read_file', arguments: { path: 'src/flask/helpers.py', start_line: 1, end_line: 5 } }));
    assert.match(rf, /lines 1-5 of \d+/);
    const esc = await client.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
    assert.equal(esc.isError, true);
    // No active run => writes refused, nothing touched.
    const w = text(await client.callTool({ name: 'edit_file', arguments: { path: 'src/flask/helpers.py', old_string: 'x', new_string: 'y' } }));
    assert.match(w, /cancelled|No changes/);
    await client.close();
  } finally {
    server.dispose();
  }
});
