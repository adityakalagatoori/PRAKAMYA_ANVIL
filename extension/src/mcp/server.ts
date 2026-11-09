import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'node:crypto';
import { TOOLS, ToolDeps } from './tools';
import { sanitizeForModel } from '../security/policy';
import { audit } from '../security/audit';

const MAX_BODY = 4 * 1024 * 1024;

function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * DNS-rebinding / CSRF defence (MCP Inspector CVE-2025-49596 class): only loopback Host headers are
 * accepted, and any request carrying a browser Origin is refused. TrueForge is a server-side client
 * and sends no Origin.
 */
export function requestAllowed(headers: http.IncomingHttpHeaders, port: number, extraHosts: string[] = []): string | undefined {
  const host = String(headers.host ?? '').toLowerCase();
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extraHosts.map((h) => `${h.toLowerCase()}:${port}`)]);
  if (!allowed.has(host)) return `host ${host || '(none)'} not allowed`;
  if (headers.origin !== undefined) return 'browser origin not allowed';
  const site = headers['sec-fetch-site'];
  if (site && site !== 'none' && site !== 'same-origin') return 'cross-site request';
  return undefined;
}

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
          audit.record('tool.call', { tool: t.name, args: summarizeArgs(args), runId: this.deps.runs.active?.id });
          // Circuit breaker: identical repeated calls / runaway runs get a corrective message instead.
          const loop = this.deps.runs.loopGuard.check(t.name, args);
          if (loop) {
            audit.record('tool.loop_blocked', { tool: t.name });
            return { content: [{ type: 'text' as const, text: loop }], isError: true };
          }
          try {
            const raw = await t.run(args, this.deps);
            // Everything returned to the model is sanitised: secrets redacted, hidden Unicode revealed.
            const clean = sanitizeForModel(raw);
            if (clean.redactions || clean.hidden) audit.record('tool.sanitized', { tool: t.name, redactions: clean.redactions, hidden: clean.hidden });
            const text = clean.text;
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

  private port = 0;
  /** Extra Host names allowed (e.g. host.docker.internal when TrueForge runs in Docker). */
  extraHosts: string[] = [];

  async start(port: number): Promise<number> {
    this.server = http.createServer(async (req, res) => {
      try {
        if (!req.url?.startsWith('/mcp')) {
          res.writeHead(req.url === '/health' ? 200 : 404).end(req.url === '/health' ? 'ok' : 'not found');
          return;
        }
        const why = requestAllowed(req.headers, this.port, this.extraHosts);
        if (why) {
          audit.record('mcp.rejected', { reason: why });
          res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: why }));
          return;
        }
        if (!tokenOk(req.headers['x-anvil-token'], this.token)) {
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
    this.port = bound;
    this.server.requestTimeout = 15 * 60_000;
    this.server.headersTimeout = 30_000;
    this.log.appendLine(`[mcp] ${MCP_SERVER_NAME} listening on http://127.0.0.1:${bound}/mcp`);
    return bound;
  }

  dispose() {
    this.server?.close();
  }
}

function summarizeArgs(args: unknown): unknown {
  // Audit entries keep paths/queries/commands but not whole file contents.
  if (!args || typeof args !== 'object') return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  return out;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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
