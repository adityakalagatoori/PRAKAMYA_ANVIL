import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOLS, ToolDeps } from './tools';

export const MCP_SERVER_NAME = 'anvil-editor';

/**
 * Exposes the editor's capabilities to TrueForge as an MCP server over streamable HTTP.
 * TrueForge only supports remote MCP servers, so the extension hosts one on 127.0.0.1 and
 * TrueForge (also local) connects to it. Requests must carry the per-install token header.
 */
export class AnvilMcpServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private listeners = new Set<(e: { tool: string; args: unknown; phase: 'start' | 'end'; ok?: boolean; ms?: number }) => void>();

  constructor(private deps: ToolDeps, private token: string, private log: vscode.OutputChannel) {}

  onToolCall(fn: (e: { tool: string; args: unknown; phase: 'start' | 'end'; ok?: boolean; ms?: number }) => void) {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private build(): McpServer {
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });
    for (const t of TOOLS) {
      mcp.registerTool(
        t.name,
        {
          description: t.description,
          inputSchema: t.schema,
          annotations: {
            readOnlyHint: t.kind === 'read',
            destructiveHint: t.kind !== 'read',
            idempotentHint: t.kind === 'read',
            openWorldHint: t.kind === 'exec',
          },
        },
        (async (args: unknown) => {
          const t0 = Date.now();
          this.listeners.forEach((l) => l({ tool: t.name, args, phase: 'start' }));
          try {
            const text = await t.run(args, this.deps);
            this.log.appendLine(`[mcp] ${t.name} ok (${Date.now() - t0}ms)`);
            this.listeners.forEach((l) => l({ tool: t.name, args, phase: 'end', ok: true, ms: Date.now() - t0 }));
            return { content: [{ type: 'text' as const, text }] };
          } catch (e) {
            const msg = (e as Error).message ?? String(e);
            this.log.appendLine(`[mcp] ${t.name} error: ${msg}`);
            this.listeners.forEach((l) => l({ tool: t.name, args, phase: 'end', ok: false, ms: Date.now() - t0 }));
            return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
          }
        }) as any,
      );
    }
    return mcp;
  }

  async start(port: number): Promise<number> {
    this.server = http.createServer(async (req, res) => {
      try {
        if (!req.url?.startsWith('/mcp')) {
          res.writeHead(req.url === '/health' ? 200 : 404).end(req.url === '/health' ? 'ok' : 'not found');
          return;
        }
        if (req.headers['x-anvil-token'] !== this.token) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad or missing x-anvil-token' }));
          return;
        }
        if (req.method !== 'POST') {
          // Stateless server: no standalone SSE stream / session deletion.
          res.writeHead(405, { allow: 'POST' }).end();
          return;
        }
        const body = await readBody(req);
        const mcp = this.build();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        this.log.appendLine(`[mcp] request failed: ${(e as Error).stack ?? e}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    const bound = typeof addr === 'object' && addr ? addr.port : port;
    this.log.appendLine(`[mcp] ${MCP_SERVER_NAME} listening on http://127.0.0.1:${bound}/mcp`);
    return bound;
  }

  dispose() {
    this.server?.close();
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
