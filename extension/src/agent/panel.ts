import * as vscode from 'vscode';
import { AgentRunner, RunSink, UiEvent } from '../trueforge/runner';
import { WorkspaceIndex } from '../context/workspaceIndex';
import { assembleContext, parseMentions, renderPack, summarizePack } from '../context/assembler';
import { UndoStack } from '../review/undo';
import { getConfig } from '../config';

/** Webview panel for agent mode. Pure renderer + input; the loop runs on TrueForge. */
export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'anvil.agentPanel';
  private view: vscode.WebviewView | undefined;
  private pendingCommandApprovals = new Map<string, (ok: boolean) => void>();
  private lastRunId: string | undefined;
  private backlog: unknown[] = [];

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
        if (m.url) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        else if (m.path) {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (!root) return;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, m.path));
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
    const message = `${text}\n\n${renderPack(pack)}`;
    const sink: RunSink = {
      emit: (e) => {
        if (e.t === 'run.start') this.lastRunId = e.runId;
        this.post({ type: 'ui', event: e });
        if (e.t === 'run.end') this.post({ type: 'undoState', count: this.undo.forRun(e.runId).length, runId: e.runId });
      },
      approveCommand: (id, command) =>
        new Promise<boolean>((resolve) => {
          this.pendingCommandApprovals.set(id, resolve);
          // Also offer it as a notification so it is visible when the panel is hidden.
          void vscode.window.showInformationMessage(`Anvil agent wants to run: ${command}`, 'Run', 'Deny').then((pick) => {
            if (!this.pendingCommandApprovals.has(id) || pick === undefined) return;
            this.pendingCommandApprovals.get(id)!(pick === 'Run');
            this.pendingCommandApprovals.delete(id);
            this.post({ type: 'commandDecided', id });
          });
        }),
    };
    const res = await this.runner.run('coder', message, sink, { continueConversation: true, title: text.slice(0, 80) });
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
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body>
<header id="hdr">
  <div class="row"><span id="status" class="pill">idle</span><span id="model" class="muted"></span></div>
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
