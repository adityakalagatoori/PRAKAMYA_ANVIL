import * as vscode from 'vscode';
import { TrueForge as TrueForgeClient, TrueForgeApi as TrueForge } from '@truefoundry/trueforge-sdk';
import coderTemplate from '../../../agents/anvil-coder.json';
import inlineTemplate from '../../../agents/anvil-inline.json';
import { MCP_SERVER_NAME } from '../mcp/server';
import { getConfig } from '../config';

export type AgentKind = 'coder' | 'inline';

export class TrueForgeUnreachable extends Error {}

/**
 * Everything that talks to TrueForge. The extension never calls a model provider:
 * it registers its MCP server + agent definitions with TrueForge, opens sessions and streams turns.
 */
export class TrueForgeGateway {
  private client: TrueForgeClient;
  private setupDone = new Map<string, Promise<void>>();

  constructor(private log: vscode.OutputChannel, private mcp: () => { url: string; token: string }) {
    this.client = this.makeClient();
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('anvil')) {
        this.client = this.makeClient();
        this.setupDone.clear();
      }
    });
  }

  private makeClient() {
    return new TrueForgeClient({ baseUrl: getConfig().trueforgeUrl, timeoutInSeconds: 900, maxRetries: 0 });
  }

  get baseUrl() {
    return getConfig().trueforgeUrl;
  }

  sessionUrl(sessionId: string) {
    return `${this.baseUrl}/sessions/${sessionId}`;
  }

  /** Agent name for a model slot: anvil-coder, anvil-coder-fb1, ... */
  agentName(kind: AgentKind, slot: number) {
    const base = kind === 'coder' ? coderTemplate.name : inlineTemplate.name;
    return slot === 0 ? base : `${base}-fb${slot}`;
  }

  models(): string[] {
    return getConfig().models;
  }

  // ---------- setup (raw HTTP so the committed agent JSON is sent exactly as written) ----------

  private async http(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new TrueForgeUnreachable(`TrueForge is not reachable at ${this.baseUrl} (${(e as Error).message}). Start it with scripts/start-trueforge (npx @truefoundry/trueforge@latest).`);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg = json?.error?.message ?? text.slice(0, 300);
      const err = new Error(`TrueForge ${method} /${path} → ${res.status}: ${msg}`);
      (err as any).status = res.status;
      throw err;
    }
    return json;
  }

  async ping(): Promise<void> {
    await this.http('GET', 'agents?limit=1');
  }

  /** Registers the MCP server and one agent per (kind, model slot). Idempotent; cached per config. */
  ensureSetup(force = false): Promise<void> {
    const models = this.models();
    const key = JSON.stringify([models, this.mcp().url, getConfig().modelParams]);
    if (!force && this.setupDone.has(key)) return this.setupDone.get(key)!;
    const p = this.doSetup(models).catch((e) => {
      this.setupDone.delete(key);
      throw e;
    });
    this.setupDone.set(key, p);
    return p;
  }

  private async doSetup(models: string[]) {
    if (!models.length) {
      throw new Error('No model configured. Set "anvil.models" (e.g. ["gemini/gemini-2.5-flash", "groq/llama-3.3-70b-versatile"]) to models you added in TrueForge → Settings → Models.');
    }
    const { url, token } = this.mcp();
    await this.http('PUT', 'settings/mcp-servers', {
      manifest: {
        name: MCP_SERVER_NAME,
        type: 'remote',
        url,
        description: 'Anvil VS Code editor tools: retrieval, search, symbols, read, reviewed writes, approved commands.',
        auth: { type: 'header', headers: { 'x-anvil-token': token } },
      },
    });
    this.log.appendLine(`[setup] MCP server ${MCP_SERVER_NAME} → ${url}`);
    const existing = await this.listAgents();
    for (const [kind, tpl] of [['coder', coderTemplate], ['inline', inlineTemplate]] as const) {
      for (let slot = 0; slot < models.length; slot++) {
        const name = this.agentName(kind, slot);
        const manifest = JSON.parse(JSON.stringify(tpl.manifest).replace(/\$\{MODEL\}/g, models[slot]));
        if (kind === 'coder') manifest.config.iteration_limit = getConfig().iterationLimit;
        const extra = getConfig().modelParams[models[slot]];
        if (extra) manifest.model.params = { ...manifest.model.params, ...extra };
        const description = tpl.description + (slot ? ` (fallback #${slot})` : '');
        const found = existing.find((a) => a.name === name);
        if (found) await this.http('PUT', `agents/${encodeURIComponent(found.id)}`, { description, manifest });
        else await this.http('POST', 'agents', { name, description, manifest });
        this.log.appendLine(`[setup] agent ${name} → ${models[slot]}`);
      }
    }
  }

  private async listAgents(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await this.http('GET', `agents?limit=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
      const items = res?.data ?? res?.items ?? [];
      for (const a of items) out.push({ id: a.id, name: a.name ?? a.manifest?.name });
      token = res?.pagination?.next_page_token ?? res?.next_page_token;
      if (!token) break;
    }
    return out;
  }

  // ---------- sessions & turns (TypeScript SDK) ----------

  async createSession(kind: AgentKind, slot: number, title?: string): Promise<string> {
    try {
      void title;
      const res = await this.client.sessions.create({ agent: { name: this.agentName(kind, slot) } });
      return res.data.id;
    } catch (e) {
      throw classifyTransport(e, this.baseUrl);
    }
  }

  /** Streams one turn. Resolves with the terminal state (or throws on transport failure). */
  async streamTurn(
    sessionId: string,
    input: TrueForge.TurnInputItem[],
    onEvent: (e: TrueForge.TurnStreamingEvent) => void,
    signal: AbortSignal,
  ): Promise<TrueForge.TurnDoneEventState | undefined> {
    let done: TrueForge.TurnDoneEventState | undefined;
    try {
      const stream = await this.client.sessions.createTurnStream(sessionId, { input }, { abortSignal: signal });
      for await (const ev of stream) {
        if (signal.aborted) break;
        onEvent(ev);
        if (ev.type === 'turn.done' && (ev.threadId === null || ev.threadId === undefined || ev.threadId === 'main')) done = ev.state;
      }
    } catch (e) {
      if (signal.aborted) return { status: 'cancelled', reason: 'client-cancelled', completedAt: new Date().toISOString() } as TrueForge.TurnStateCancelled;
      throw classifyTransport(e, this.baseUrl);
    }
    return done;
  }

  async cancel(sessionId: string) {
    try {
      await this.client.sessions.cancel(sessionId);
    } catch (e) {
      this.log.appendLine(`[cancel] ${(e as Error).message}`);
    }
  }
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function classifyTransport(e: unknown, baseUrl: string): Error {
  const msg = (e as Error)?.message ?? String(e);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg)) {
    return new TrueForgeUnreachable(`TrueForge is not reachable at ${baseUrl}. Start it with scripts/start-trueforge. (${msg})`);
  }
  return e instanceof Error ? e : new Error(msg);
}

/** Errors worth retrying on the same model (rate limits, timeouts, 5xx). Auth/config errors are not. */
export function isTransient(message: string): boolean {
  if (/401|403|unauthori[sz]ed|invalid.*(api[_ ]?key|key)|authentication|permission|not found|404|does not exist|unknown model|invalid model/i.test(message)) return false;
  return /429|rate.?limit|timeout|timed out|ETIMEDOUT|ECONNRESET|5\d\d|overloaded|unavailable|temporar|try again|connection|ECONNREFUSED|socket/i.test(message);
}
