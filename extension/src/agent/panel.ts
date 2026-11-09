import * as vscode from 'vscode';
import { AgentRunner, RunSink, UiEvent } from '../trueforge/runner';
import { WorkspaceIndex } from '../context/workspaceIndex';
import { assembleContext, parseMentions, renderPack, summarizePack } from '../context/assembler';
import { sanitizeForModel } from '../security/policy';
import { UndoStack } from '../review/undo';
import { getConfig } from '../config';
import { randomBytes } from 'node:crypto';
import { resolvePath } from '../mcp/tools';
import { computeHunks } from '../review/diff';

function lineDelta(a: string, b: string) {
  let added = 0;
  let removed = 0;
  for (const h of computeHunks(a, b)) {
    added += h.newLines.length;
    removed += h.origLines.length;
  }
  return { added, removed };
}

/** Webview panel for agent mode. Pure renderer + input; the loop runs on TrueForge. */
export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'anvil.agentPanel';
  private view: vscode.WebviewView | undefined;
  private pendingCommandApprovals = new Map<string, (ok: boolean) => void>();
  private lastRunId: string | undefined;
  private backlog: unknown[] = [];
  /** Recording mode only: low-risk command cards are approved after a visible pause. */
  demoAutoApprove = false;

  constructor(
    private ctx: vscode.ExtensionContext,
    private runner: AgentRunner,
    private index: WorkspaceIndex,
    private undo: UndoStack,
    private log: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
    for (const m of this.backlog.splice(0)) void view.webview.postMessage(m);
  }

  post(msg: unknown) {
    if (this.view) void this.view.webview.postMessage(msg);
    else this.backlog.push(msg);
  }

  /** Mirror events from other entry points (e.g. inline edit) into the panel log. */
  mirror(e: UiEvent) {
    this.post({ type: 'ui', event: e });
  }

  /** Demo/recording mode: types a request into the panel input visibly, then sends it. */
  demoType(text: string) {
    this.post({ type: 'demoType', text });
  }

  async reveal() {
    await vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'config', models: getConfig().models, trueforgeUrl: getConfig().trueforgeUrl });
        break;
      case 'send':
        await this.send(String(m.text ?? ''));
        break;
      case 'cancel':
        await this.runner.cancel();
        break;
      case 'new':
        this.runner.resetConversation();
        this.post({ type: 'cleared' });
        break;
      case 'mention': {
        const idx = this.index.current;
        const q = String(m.q ?? '').toLowerCase();
        const files = [...idx.files.keys()].filter((p) => p.toLowerCase().includes(q)).slice(0, 8).map((p) => ({ label: p, kind: 'file' }));
        const syms: { label: string; kind: string; detail: string }[] = [];
        if (q.length >= 2) {
          for (const [k, defs] of idx.symbols) {
            if (k.includes(q) && defs[0].kind !== 'section') syms.push({ label: defs[0].qualified, kind: 'symbol', detail: `${defs[0].path}:${defs[0].line}` });
            if (syms.length >= 8) break;
          }
        }
        this.post({ type: 'mentionResults', items: [...files, ...syms] });
        break;
      }
      case 'approveCommand':
        this.pendingCommandApprovals.get(m.id)?.(!!m.ok);
        this.pendingCommandApprovals.delete(m.id);
        break;
      case 'open':
        if (m.url) {
          // Only ever open the configured TrueForge origin (webview messages are treated as untrusted).
          const tf = vscode.Uri.parse(getConfig().trueforgeUrl);
          const target = vscode.Uri.parse(String(m.url));
          if ((target.scheme === 'http' || target.scheme === 'https') && target.authority === tf.authority) void vscode.env.openExternal(target);
          else this.log.appendLine(`[panel] refused to open ${m.url}`);
        } else if (m.path) {
          let uri: vscode.Uri;
          try {
            uri = resolvePath(String(m.path)).uri;
          } catch {
            return;
          }
          const doc = await vscode.workspace.openTextDocument(uri);
          const line = Math.max(0, (Number(m.line) || 1) - 1);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
        }
        break;
      case 'undoLast':
        await vscode.commands.executeCommand('anvil.undoLast');
        break;
      case 'revertRun':
        await vscode.commands.executeCommand('anvil.revertRun', this.lastRunId);
        break;
    }
  }

  async send(text: string) {
    if (!text.trim()) return;
    if (this.runner.isRunning) {
      vscode.window.showWarningMessage('Anvil: a run is in progress. Stop it first.');
      return;
    }
    const idx = await this.index.ready();
    const mentions = parseMentions(text, idx);
    const pack = assembleContext(idx, text, { budget: getConfig().contextBudgetTokens, mentions });
    this.post({ type: 'user', text });
    this.post({ type: 'ui', event: { t: 'context', summary: summarizePack(pack) } });
    // Workspace content is untrusted data: redact secrets and reveal hidden Unicode before it reaches the model.
    const safe = sanitizeForModel(renderPack(pack));
    if (safe.redactions || safe.hidden) {
      this.post({ type: 'ui', event: { t: 'notice', level: 'warn', text: `Context sanitised: ${safe.redactions} secret(s) redacted, ${safe.hidden} hidden Unicode character(s) revealed.` } });
    }
    const message = `${text}\n\n${safe.text}`;
    const sink: RunSink = {
      emit: (e) => {
        if (e.t === 'run.start') this.lastRunId = e.runId;
        this.post({ type: 'ui', event: e });
        if (e.t === 'run.end') {
          const entries = this.undo.forRun(e.runId);
          this.post({ type: 'undoState', count: entries.length, runId: e.runId });
          // Per-file summary of what actually landed on disk in this run.
          const byFile = new Map<string, { added: number; removed: number; applies: number; created: boolean }>();
          for (const en of entries) {
            const f = byFile.get(en.relPath) ?? { added: 0, removed: 0, applies: 0, created: false };
            const d = lineDelta(en.before ?? '', en.after);
            f.added += d.added;
            f.removed += d.removed;
            f.applies++;
            f.created ||= en.before === null;
            byFile.set(en.relPath, f);
          }
          if (byFile.size) this.post({ type: 'changes', files: [...byFile.entries()].map(([path, v]) => ({ path, ...v })) });
        }
      },
      approveCommand: (id, command, risk) =>
        new Promise<boolean>((resolve) => {
          this.pendingCommandApprovals.set(id, resolve);
          const settle = (ok: boolean) => {
            if (!this.pendingCommandApprovals.has(id)) return;
            this.pendingCommandApprovals.get(id)!(ok);
            this.pendingCommandApprovals.delete(id);
            this.post({ type: 'commandDecided', id });
          };
          if (this.demoAutoApprove && risk.risk === 'low') {
            setTimeout(() => settle(true), 1800);
            return;
          }
          if (risk.risk === 'high') {
            // High-risk commands need a deliberate, modal decision (no one-click approval from the panel).
            this.post({ type: 'commandDecided', id });
            void vscode.window
              .showWarningMessage(
                `Anvil agent wants to run a HIGH-RISK command`,
                {
                  modal: true,
                  detail: `${command}\n\nWhy this is flagged:\n${risk.reasons.map((r) => '• ' + r).join('\n')}\n\nPrompt injection in repository files can make an agent propose commands like this.`,
                },
                'Run anyway',
              )
              .then((pick) => settle(pick === 'Run anyway'));
            return;
          }
          // Also offer it as a notification so it is visible when the panel is hidden.
          const label = risk.risk === 'medium' ? `⚠ ${risk.reasons.join(', ')}: ` : '';
          void vscode.window.showInformationMessage(`Anvil agent wants to run: ${label}${command}`, 'Run', 'Deny').then((pick) => {
            if (pick !== undefined) settle(pick === 'Run');
          });
        }),
    };
    const observations = pack.items.map((i) => ({ path: i.path, line: i.startLine, text: i.text }));
    const res = await this.runner.run('coder', message, sink, { continueConversation: true, title: text.slice(0, 80), observations });
    for (const [, r] of this.pendingCommandApprovals) r(false);
    this.pendingCommandApprovals.clear();
    if (res.status === 'cancelled') {
      const n = this.lastRunId ? this.undo.forRun(this.lastRunId).length : 0;
      const msg = n
        ? `Anvil: run cancelled. ${n} change(s) you had already accepted were kept; nothing pending was applied.`
        : 'Anvil: run cancelled. No changes were made.';
      void vscode.window.showInformationMessage(msg, ...(n ? ['Revert this run'] : [])).then((p) => {
        if (p) void vscode.commands.executeCommand('anvil.revertRun', this.lastRunId);
      });
    }
    if (res.status === 'error') {
      void vscode.window.showErrorMessage(`Anvil: ${res.message}`, 'Show log').then((p) => p && this.log.show());
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri) {
    const nonce = randomBytes(18).toString('base64url');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body>
<header id="hdr">
  <div class="row"><span id="status" class="pill">idle</span><span id="model" class="muted"></span><span class="spacer"></span><span id="usage" class="muted" title="Tokens used in this conversation (all turns)"></span></div>
  <div class="row"><a id="session" class="muted" href="#"></a><span class="spacer"></span>
    <button id="undo" title="Undo last applied change">Undo</button>
    <button id="revert" title="Revert every change from the last run" disabled>Revert run</button>
    <button id="new" title="New conversation">New</button></div>
</header>
<main id="log"><div class="empty">Ask Anvil to change the codebase. It finds the files itself; use <code>@file</code> or <code>@symbol</code> to point at something specific. Every edit is shown as a diff for you to accept or reject per hunk.</div></main>
<footer>
  <div id="mentions" class="mentions hidden"></div>
  <textarea id="input" rows="3" placeholder="Describe the change…  (Enter to send, Shift+Enter for newline, @ to mention)"></textarea>
  <div class="row"><span class="muted" id="hint">Agent runs on TrueForge</span><span class="spacer"></span>
  <button id="stop" class="danger" disabled>Stop</button><button id="send" class="primary">Send</button></div>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
