import * as vscode from 'vscode';
import { TrueForgeApi as TrueForge, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { AgentKind, TrueForgeGateway, TrueForgeUnreachable, isTransient } from './gateway';
import { ReviewManager } from '../review/reviewManager';
import { UndoStack } from '../review/undo';
import { RunState, canonicalKey } from '../runState';
import { WRITE_TOOLS, describeReview, prepareWrite, workspaceTrusted } from '../mcp/tools';
import { CommandRisk, analyzeCommand } from '../security/policy';
import { audit } from '../security/audit';
import { getConfig } from '../config';

/** UI-facing events (rendered by the agent panel; the inline editor listens to a subset). */
export type UiEvent =
  | { t: 'run.start'; runId: string; kind: AgentKind; request: string }
  | { t: 'session'; sessionId: string; url: string; agent: string; model: string; slot: number }
  | { t: 'context'; summary: unknown }
  | { t: 'delta'; threadId: string; text: string }
  | { t: 'reasoning'; threadId: string; text: string }
  | { t: 'message.done'; threadId: string }
  | { t: 'tool.start'; id: string; threadId: string; name: string; args: unknown }
  | { t: 'tool.result'; id: string; content: string; ok: boolean }
  | { t: 'approval'; id: string; name: string; summary: string; risk?: CommandRisk; warnings?: string[] }
  | { t: 'usage'; inputTokens: number; outputTokens: number }
  | { t: 'approval.resolved'; id: string; allowed: boolean; summary: string }
  | { t: 'thread'; threadId: string; title: string; input: string }
  | { t: 'thread.done'; threadId: string; status: string }
  | { t: 'compaction'; phase: 'start' | 'end'; detail: string }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'fallback'; from: string; to: string; reason: string }
  | { t: 'run.end'; runId: string; status: 'done' | 'cancelled' | 'error'; message?: string; output?: string };

export interface RunSink {
  emit(e: UiEvent): void;
  /** Ask the user to approve a shell command. */
  approveCommand(id: string, command: string, risk: CommandRisk): Promise<boolean>;
}

export interface RunResult {
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  output: string; // final assistant text (main thread)
  sessionId?: string;
  slot: number;
}

interface ToolCallInfo {
  id: string;
  threadId: string;
  rawName: string;
  name: string; // normalised tool name
  args: any; // normalised (unwrapped) args
}

const BACKOFF_MS = [1000, 3000, 6000];

/**
 * Drives TrueForge turns for one user request: streaming, approvals (→ diff review), cancellation,
 * retry with backoff, and automatic fallback across the configured models.
 */
export class AgentRunner {
  private current: { runId: string; sessionId?: string } | undefined;
  /** Panel conversations continue on the same session/model slot. */
  private conversation: { sessionId: string; slot: number } | undefined;

  constructor(
    private gw: TrueForgeGateway,
    private reviews: ReviewManager,
    private undo: UndoStack,
    private runs: RunState,
    private log: vscode.OutputChannel,
  ) {}

  get isRunning() {
    return !!this.current;
  }

  resetConversation() {
    this.conversation = undefined;
  }

  async cancel() {
    const cur = this.current;
    if (!cur) return;
    this.log.appendLine(`[run ${cur.runId}] cancel requested`);
    this.runs.cancel(); // aborts the stream + running commands, blocks MCP writes
    this.reviews.cancelAll(cur.runId); // pending hunks are dropped, never applied
    if (cur.sessionId) await this.gw.cancel(cur.sessionId);
  }

  async run(kind: AgentKind, input: string, sink: RunSink, opts: { continueConversation?: boolean; title?: string } = {}): Promise<RunResult> {
    if (this.current) throw new Error('A run is already in progress. Cancel it first.');
    const runId = `${kind}-${Date.now().toString(36)}`;
    const run = this.runs.start(runId);
    this.current = { runId };
    void vscode.commands.executeCommand('setContext', 'anvil.running', true);
    sink.emit({ t: 'run.start', runId, kind, request: opts.title ?? input.slice(0, 200) });
    try {
      await this.gw.ensureSetup();
      const models = this.gw.models();
      const retries = Math.max(0, getConfig().retries);
      let lastError = '';
      const startSlot = opts.continueConversation && this.conversation ? this.conversation.slot : 0;
      for (let slot = startSlot; slot < models.length; slot++) {
        if (slot > startSlot) {
          sink.emit({ t: 'fallback', from: models[slot - 1], to: models[slot], reason: lastError });
          this.log.appendLine(`[run ${runId}] falling back to ${models[slot]}: ${lastError}`);
        }
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (run.cancelled) return this.finish(sink, runId, { status: 'cancelled', output: '', slot });
          if (attempt > 0) {
            const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
            sink.emit({ t: 'notice', level: 'warn', text: `Model error on ${models[slot]}: ${short(lastError)} — retry ${attempt}/${retries} in ${wait / 1000}s` });
            if (!(await sleep(wait, run.abort.signal))) return this.finish(sink, runId, { status: 'cancelled', output: '', slot });
          }
          // Fresh session per attempt; continue the panel conversation only on its first attempt.
          let sessionId: string;
          let turnInput = input;
          if (opts.continueConversation && this.conversation && slot === this.conversation.slot && attempt === 0) {
            sessionId = this.conversation.sessionId;
          } else {
            sessionId = await this.gw.createSession(kind, slot, opts.title);
            const applied = this.undo.forRun(runId);
            if (applied.length) {
              turnInput = `${input}\n\n<note>A previous attempt in this run already applied changes to: ${[...new Set(applied.map((a) => a.relPath))].join(', ')}. Re-read those files and continue from their current state; do not redo applied changes.</note>`;
            }
          }
          this.current.sessionId = sessionId;
          sink.emit({ t: 'session', sessionId, url: this.gw.sessionUrl(sessionId), agent: this.gw.agentName(kind, slot), model: models[slot], slot });
          const res = await this.loop(sessionId, [{ type: 'user.message', content: turnInput }], sink, run.abort.signal, kind === 'coder' && looksLikeChangeRequest(input));
          if (res.status === 'done') {
            if (kind === 'coder') this.conversation = { sessionId, slot };
            return this.finish(sink, runId, { ...res, sessionId, slot });
          }
          if (res.status === 'cancelled' || run.cancelled) return this.finish(sink, runId, { status: 'cancelled', output: res.output, sessionId, slot });
          lastError = res.message ?? 'unknown error';
          this.log.appendLine(`[run ${runId}] ${models[slot]} attempt ${attempt + 1} failed: ${lastError}`);
          if (!isTransient(lastError)) break; // auth / config errors: go straight to the next model
        }
      }
      return this.finish(sink, runId, {
        status: 'error',
        message: models.length > 1 ? `All configured models failed. Last error: ${lastError}` : `Model call failed: ${lastError}`,
        output: '',
        slot: models.length - 1,
      });
    } catch (e) {
      const msg = e instanceof TrueForgeUnreachable ? e.message : `Anvil error: ${(e as Error).message}`;
      return this.finish(sink, runId, { status: run.cancelled ? 'cancelled' : 'error', message: msg, output: '', slot: 0 });
    }
  }

  /** Last finished run (status, model slot used) — for tests and the status bar. */
  lastResult: RunResult | undefined;

  private finish(sink: RunSink, runId: string, r: RunResult): RunResult {
    this.lastResult = r;
    sink.emit({ t: 'run.end', runId, status: r.status, message: r.message, output: r.output });
    this.runs.end(runId);
    this.current = undefined;
    void vscode.commands.executeCommand('setContext', 'anvil.running', false);
    if (r.status === 'cancelled') this.reviews.cancelAll(runId);
    return r;
  }

  /** One request: turn → (approvals → turn)* until the agent is done, errors, or is cancelled. */
  private async loop(sessionId: string, input: TrueForge.TurnInputItem[], sink: RunSink, signal: AbortSignal, expectEdits = false): Promise<{ status: 'done' | 'cancelled' | 'error'; message?: string; output: string }> {
    const calls = new Map<string, ToolCallInfo>();
    let output = '';
    let nudges = 0;
    let continues = 0;
    let wroteAnything = false;
    for (let round = 0; round < 200; round++) {
      const approvals: { id: string; threadId: string }[] = [];
      let mainText = '';
      let roundToolCalls = 0;
      // Live streams carry most model output only as deltas (tool-call fragments included), so we
      // rebuild each message with the SDK's mergeEventDelta and finalise it on finish_reason.
      const bases = new Map<string, TrueForge.ModelMessageEvent>();
      const finalised = new Set<string>();
      // Idempotent: may run several times per message (finish_reason, approval, turn end); each
      // tool call is surfaced once, message.done once.
      const finalise = (msg: TrueForge.ModelMessageEvent) => {
        const threadId = msg.threadId ?? 'main';
        const text = messageText(msg.content);
        if ((text || msg.toolCalls?.length) && !finalised.has(msg.id)) {
          finalised.add(msg.id);
          sink.emit({ t: 'message.done', threadId });
        }
        if (isMain(threadId) && text) output = text;
        for (const tc of msg.toolCalls ?? []) {
          if (!tc?.id || calls.has(tc.id)) continue;
          roundToolCalls++;
          const info = normaliseCall(tc, threadId);
          calls.set(tc.id, info);
          if (WRITE_TOOLS.has(info.name)) wroteAnything = true;
          sink.emit({ t: 'tool.start', id: tc.id, threadId: info.threadId, name: info.name, args: info.args });
        }
      };
      const flushAll = () => bases.forEach((b) => finalise(b));
      const onEvent = (ev: TrueForge.TurnStreamingEvent) => {
        switch (ev.type) {
          case 'model.message.delta': {
            if (ev.reasoningContent) sink.emit({ t: 'reasoning', threadId: ev.threadId ?? 'main', text: ev.reasoningContent });
            if (ev.content) {
              if (isMain(ev.threadId)) mainText += ev.content;
              sink.emit({ t: 'delta', threadId: ev.threadId ?? 'main', text: ev.content });
            }
            let base = bases.get(ev.id);
            if (!base) {
              base = { type: 'model.message', id: ev.id, threadId: ev.threadId, createdAt: ev.createdAt ?? new Date().toISOString(), content: '' } as TrueForge.ModelMessageEvent;
              bases.set(ev.id, base);
            }
            mergeEventDelta(base, ev);
            if (ev.usage && (ev.usage as any).inputTokens !== undefined) sink.emit({ t: 'usage', inputTokens: (ev.usage as any).inputTokens ?? 0, outputTokens: (ev.usage as any).outputTokens ?? 0 });
            if (ev.finishReason) finalise(base);
            break;
          }
          case 'model.message': {
            // Either the (empty) base that precedes a streamed message's deltas, or a complete
            // message from a non-streaming provider.
            const prev = bases.get(ev.id);
            const text = messageText(ev.content);
            if (text && !prev) {
              if (isMain(ev.threadId)) mainText += text;
              sink.emit({ t: 'delta', threadId: ev.threadId ?? 'main', text });
            }
            if (!prev || text || ev.toolCalls?.length) bases.set(ev.id, prev && !text && !ev.toolCalls?.length ? prev : ev);
            if (ev.finishReason || text || ev.toolCalls?.length) finalise(bases.get(ev.id)!);
            break;
          }
          case 'tool.approval_required':
          case 'tool.response_required':
            flushAll(); // make sure every call's arguments are known before reviewing
            for (const tc of ev.toolCalls) approvals.push({ id: tc.id, threadId: ev.threadId ?? 'main', ...(ev.type === 'tool.response_required' ? { question: true } : {}) } as any);
            break;
          case 'tool.response':
            sink.emit({ t: 'tool.result', id: ev.toolCallId, content: ev.content, ok: !/^Error:/.test(ev.content) });
            break;
          case 'thread.created':
            sink.emit({ t: 'thread', threadId: ev.threadId, title: ev.title, input: ev.agentInfo?.input ?? '' });
            break;
          case 'thread.done':
            sink.emit({ t: 'thread.done', threadId: ev.threadId, status: (ev as any).state?.status ?? 'done' });
            break;
          case 'thread.context_compaction_started':
            sink.emit({ t: 'compaction', phase: 'start', detail: JSON.stringify((ev as any).trigger ?? {}) });
            break;
          case 'thread.context_compaction_finished':
            sink.emit({ t: 'compaction', phase: 'end', detail: `${(ev as any).durationMs ?? '?'}ms` });
            break;
          case 'mcp.initialize': {
            const servers = ((ev as any).mcpServers ?? []).map((s: any) => `${s.name} (${s.transportType ?? 'http'})`).join(', ');
            if (servers) sink.emit({ t: 'notice', level: 'info', text: `TrueForge connected to MCP: ${servers}` });
            break;
          }
          case 'mcp.auth_required':
            sink.emit({ t: 'notice', level: 'error', text: 'TrueForge reports the anvil-editor MCP server needs auth. Run "Anvil: Register Agents & MCP Server with TrueForge".' });
            break;
        }
      };
      const state = await this.gw.streamTurn(sessionId, input, onEvent, signal);
      flushAll();
      if (signal.aborted) return { status: 'cancelled', output };
      if (!state) return { status: 'error', message: 'Stream ended without a turn.done event', output };
      if (state.status === 'cancelled') return { status: 'cancelled', output };
      if (state.status === 'error') return { status: 'error', message: state.message, output };
      if (mainText) output = mainText;

      // Required actions may arrive as events and/or on turn.done.
      for (const ra of (state as TrueForge.TurnStateDone).requiredActions ?? []) {
        for (const tc of (ra as any).toolCalls ?? []) if (!approvals.some((a) => a.id === tc.id)) approvals.push({ id: tc.id, threadId: (ra as any).threadId ?? 'main' });
      }
      if (!approvals.length) {
        // Some local models (e.g. qwen2.5-coder via Ollama) print a tool call as JSON text instead of
        // using function calling, which silently ends the loop. Detect it and nudge, at most twice.
        if (!roundToolCalls && nudges < 2 && looksLikeTextToolCall(mainText)) {
          nudges++;
          sink.emit({ t: 'notice', level: 'warn', text: 'The model wrote a tool call as plain text; asking it to use real function calling…' });
          input = [{ type: 'user.message', content: TEXT_TOOL_CALL_NUDGE }];
          continue;
        }
        // Small models sometimes stop after exploring and report findings instead of making the
        // change. If a change was requested and no write was even attempted, continue (max 2x).
        if (expectEdits && !wroteAnything && continues < 2) {
          continues++;
          sink.emit({ t: 'notice', level: 'info', text: `No edits proposed yet — asking the agent to continue and implement the change (${continues}/2)…` });
          input = [{ type: 'user.message', content: CONTINUE_NUDGE }];
          continue;
        }
        return { status: 'done', output };
      }

      // ---- approvals: this is where TrueForge's approval gate drives Anvil's diff review ----
      const decisions: TrueForge.TurnInputItem[] = [];
      for (const ap of approvals) {
        if (signal.aborted) return { status: 'cancelled', output };
        const info = calls.get(ap.id);
        if ((ap as any).question) {
          decisions.push({ type: 'user.tool_response', threadId: ap.threadId, toolCallId: ap.id, content: 'The user is not available for questions; make a reasonable assumption and continue.' } as any);
          continue;
        }
        const decision = await this.decide(info, ap.id, sink, signal);
        if (signal.aborted) return { status: 'cancelled', output };
        decisions.push({ type: 'user.tool_approval', threadId: ap.threadId, toolCallId: ap.id, approval: decision });
      }
      input = decisions;
    }
    return { status: 'error', message: 'Too many approval rounds', output };
  }

  private async decide(info: ToolCallInfo | undefined, id: string, sink: RunSink, signal: AbortSignal): Promise<TrueForge.ApprovalDecision> {
    const runId = this.runs.active?.id ?? 'none';
    if (!info) return { status: 'allow' };
    if (WRITE_TOOLS.has(info.name)) {
      const prepared = await prepareWrite(info.name, info.args);
      if ('error' in prepared) {
        audit.record('approval.auto_deny', { tool: info.name, reason: prepared.error });
        sink.emit({ t: 'approval.resolved', id, allowed: false, summary: prepared.error });
        return { status: 'deny', reason: `Anvil could not build a diff: ${prepared.error}` };
      }
      sink.emit({ t: 'approval', id, name: info.name, summary: `Review ${prepared.rel} in the diff editor (accept/reject each hunk)`, warnings: prepared.warnings });
      const review = await this.reviews.review(prepared.uri, prepared.original, prepared.proposed, { runId, title: `${info.name} ${prepared.rel}`, isNewFile: prepared.isNewFile, warnings: prepared.warnings });
      const summary = describeReview(prepared.rel, review);
      if (signal.aborted || review.status === 'cancelled') return { status: 'deny', reason: 'Run cancelled by the user.' };
      this.runs.recordDecision(canonicalKey(info.name, info.args), { tool: info.name, path: prepared.rel, review, createdAt: Date.now() });
      const allowed = review.accepted.length > 0;
      audit.record('approval', { tool: info.name, path: prepared.rel, allowed, accepted: review.accepted.length, total: review.total });
      sink.emit({ t: 'approval.resolved', id, allowed, summary });
      return allowed ? { status: 'allow' } : { status: 'deny', reason: summary };
    }
    if (info.name === 'run_command') {
      const cmd = String(info.args?.command ?? '');
      if (!workspaceTrusted()) return { status: 'deny', reason: 'Workspace is not trusted; commands are disabled.' };
      const risk = analyzeCommand(cmd);
      sink.emit({ t: 'approval', id, name: info.name, summary: `Run: ${cmd}`, risk });
      const ok = await this.raceAbort(sink.approveCommand(id, cmd, risk), signal, false);
      audit.record('approval', { tool: 'run_command', command: cmd, risk: risk.risk, reasons: risk.reasons, allowed: ok });
      if (ok) this.runs.approveCommand(cmd);
      sink.emit({ t: 'approval.resolved', id, allowed: ok, summary: ok ? `Approved: ${cmd}` : `Denied: ${cmd}` });
      return ok ? { status: 'allow' } : { status: 'deny', reason: 'The user declined to run this command.' };
    }
    // Read-only or harness tools that ended up gated: allow.
    return { status: 'allow' };
  }

  private raceAbort<T>(p: Promise<T>, signal: AbortSignal, onAbort: T): Promise<T> {
    if (signal.aborted) return Promise.resolve(onAbort);
    return new Promise((resolve) => {
      const h = () => resolve(onAbort);
      signal.addEventListener('abort', h, { once: true });
      p.then((v) => {
        signal.removeEventListener('abort', h);
        resolve(v);
      });
    });
  }
}

const isMain = (t: string | null | undefined) => !t || t === 'main';

const TOOL_NAMES = 'retrieve_context|search_code|find_symbol|read_file|list_files|repo_map|get_diagnostics|edit_file|create_file|run_command|list_tools|get_tool_info|call_tool|create_sub_agent';
const TEXT_CALL_RE = new RegExp(String.raw`["']?(name|tool|function)["']?\s*:\s*["'](?:[\w-]+__)?(${TOOL_NAMES})["']|<tool_call>|\b(${TOOL_NAMES})\s*\(\s*\{`);
export function looksLikeTextToolCall(text: string): boolean {
  return TEXT_CALL_RE.test(text.slice(0, 4000));
}
const CONTINUE_NUDGE =
  'You have only explored so far; no change has been made. Now implement the requested change yourself: read_file the exact regions, ' +
  'then call edit_file (or create_file) for every file that must change — implementation, tests and docs. Do not just describe the change.';
export function looksLikeChangeRequest(text: string): boolean {
  const req = text.split('<anvil_context')[0].toLowerCase();
  return /\b(add|implement|create|fix|change|update|modify|refactor|rename|remove|delete|replace|write|make|support|introduce|extend|convert|migrate|document)\b/.test(req);
}
const TEXT_TOOL_CALL_NUDGE =
  'Your last reply printed a tool call as text, so nothing was executed. Do not write tool calls as JSON or code in your message. ' +
  'Invoke the tools through the function-calling interface (for example call read_file / search_code / edit_file directly), then continue the task.';

function messageText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  return '';
}

/** Normalises tool names (server prefixes, deferred-loading call_tool wrapper) and parses args. */
export function normaliseCall(tc: TrueForge.ToolCall, threadId: string): ToolCallInfo {
  const rawName = tc.function?.name ?? '';
  let args: any = parseArgs(tc.function?.arguments);
  let name = (tc.toolInfo as any)?.type === 'mcp' ? (tc.toolInfo as any).name : rawName;
  name = name.replace(/^.*(__|\.|\/)/, '');
  if (name === 'call_tool') {
    const inner = args?.tool_name ?? args?.name ?? args?.tool;
    const innerArgs = args?.arguments ?? args?.args ?? args?.input ?? args?.parameters;
    if (inner) {
      name = String(inner).replace(/^.*(__|\.|\/)/, '');
      args = parseArgs(innerArgs);
    }
  }
  return { id: tc.id, threadId, rawName, name, args };
}

function parseArgs(a: unknown): any {
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return { _raw: a };
    }
  }
  return a ?? {};
}

function short(s: string) {
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve(false);
    }, { once: true });
  });
}
