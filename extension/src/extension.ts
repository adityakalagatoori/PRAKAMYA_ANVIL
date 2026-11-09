import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { WorkspaceIndex } from './context/workspaceIndex';
import { assembleContext, parseMentions, renderPack } from './context/assembler';
import { ReviewManager } from './review/reviewManager';
import { UndoStack } from './review/undo';
import { RunState } from './runState';
import { AnvilMcpServer } from './mcp/server';
import { CommandTerminal, workspaceRoot, workspaceTrusted } from './mcp/tools';
import { audit } from './security/audit';
import { analyzeCommand } from './security/policy';
import { TrueForgeGateway } from './trueforge/gateway';
import { AgentRunner } from './trueforge/runner';
import { AgentPanel } from './agent/panel';
import { inlineEdit } from './inline/inlineEdit';
import { getConfig } from './config';

export async function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Anvil');
  ctx.subscriptions.push(log);
  log.appendLine('Anvil activating…');

  // Per-hunk Accept/Reject CodeLens lives in the diff editor, where CodeLens is off by default.
  // Turn it on unless the user explicitly chose otherwise (keyboard/title-bar actions work regardless).
  const diffCfg = vscode.workspace.getConfiguration('diffEditor');
  const lensSetting = diffCfg.inspect<boolean>('codeLens');
  if (lensSetting && lensSetting.globalValue === undefined && lensSetting.workspaceValue === undefined && !diffCfg.get<boolean>('codeLens')) {
    await diffCfg.update('codeLens', true, vscode.ConfigurationTarget.Global).then(
      () => log.appendLine('Enabled diffEditor.codeLens for per-hunk review'),
      () => undefined,
    );
  }

  const undo = new UndoStack();
  const index = new WorkspaceIndex(log);
  const reviews = new ReviewManager(undo, workspaceRoot);
  const runs = new RunState();
  const terminal = new CommandTerminal();
  ctx.subscriptions.push(index, reviews, terminal);

  // Audit trail lives in per-workspace extension storage (never in the repo).
  audit.configure(ctx.storageUri?.fsPath ?? ctx.globalStorageUri.fsPath);
  audit.record('session.start', { trusted: workspaceTrusted() });

  // Per-install secret so only TrueForge (which we hand it to) can call the editor's tools.
  // Kept in the OS keychain via SecretStorage (migrated from older globalState storage).
  let token = await ctx.secrets.get('anvil.mcpToken');
  if (!token) {
    token = ctx.globalState.get<string>('anvil.mcpToken') ?? randomBytes(32).toString('hex');
    await ctx.secrets.store('anvil.mcpToken', token);
    await ctx.globalState.update('anvil.mcpToken', undefined);
  }

  // Fallback approval for a command that reached the MCP server without a TrueForge approval.
  const confirmCommand = async (command: string) => {
    const risk = analyzeCommand(command);
    const pick = await vscode.window.showWarningMessage(
      'Anvil agent wants to run a command that was not approved through TrueForge',
      { modal: true, detail: `${command}\n\nRisk: ${risk.risk.toUpperCase()}${risk.reasons.length ? ' — ' + risk.reasons.join(', ') : ''}` },
      'Run',
    );
    return pick === 'Run';
  };

  const mcp = new AnvilMcpServer({ index, reviews, runs, log, terminal, confirmCommand }, token, log);
  const publicHost = getConfig().mcpPublicHost;
  if (!/^(127\.0\.0\.1|localhost)$/i.test(publicHost)) mcp.extraHosts = [publicHost];
  ctx.subscriptions.push(mcp);
  let mcpPort = getConfig().mcpPort;
  for (let i = 0; i < 10; i++) {
    try {
      mcpPort = await mcp.start(getConfig().mcpPort + i);
      break;
    } catch (e) {
      log.appendLine(`[mcp] port ${getConfig().mcpPort + i} unavailable: ${(e as Error).message}`);
    }
  }
  const mcpInfo = () => ({ url: `http://${getConfig().mcpPublicHost}:${mcpPort}/mcp`, token: token! });

  const gateway = new TrueForgeGateway(log, mcpInfo);
  const runner = new AgentRunner(gateway, reviews, undo, runs, log, index);
  const panel = new AgentPanel(ctx, runner, index, undo, log);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));

  // Status bar: shows running state; click to cancel.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'anvil.openPanel';
  const paint = () => {
    status.text = runner.isRunning ? '$(sync~spin) Anvil' : reviews.activeCount ? `$(diff) Anvil: review` : '$(tools) Anvil';
    status.tooltip = runner.isRunning ? 'Anvil is generating — Ctrl+Alt+Backspace to cancel' : `Anvil (TrueForge at ${getConfig().trueforgeUrl})`;
    status.command = runner.isRunning ? 'anvil.cancel' : 'anvil.openPanel';
  };
  paint();
  status.show();
  const ticker = setInterval(paint, 500);
  ctx.subscriptions.push(status, { dispose: () => clearInterval(ticker) });

  ctx.subscriptions.push(
    vscode.commands.registerCommand('anvil.inlineEdit', (preset?: { instruction?: string; animate?: boolean }) => inlineEdit(runner, reviews, index, log, (e) => panel.mirror(e), preset)),
    vscode.commands.registerCommand('anvil.openPanel', () => panel.reveal()),
    vscode.commands.registerCommand('anvil.cancel', async () => {
      if (!runner.isRunning) return;
      await runner.cancel();
    }),
    vscode.commands.registerCommand('anvil.setup', async () => {
      try {
        await gateway.ensureSetup(true);
        vscode.window.showInformationMessage(`Anvil: registered MCP server (${mcpInfo().url}) and agents for ${gateway.models().join(', ')} with TrueForge.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Anvil setup failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('anvil.undoLast', async () => {
      try {
        const e = await undo.undoLast();
        vscode.window.showInformationMessage(e ? `Anvil: undid "${e.label}" in ${e.relPath}.` : 'Anvil: nothing to undo.');
      } catch (err) {
        vscode.window.showWarningMessage(`Anvil: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('anvil.revertRun', async (runId?: string) => {
      const id = runId ?? undo.last()?.runId;
      if (!id) return vscode.window.showInformationMessage('Anvil: nothing to revert.');
      try {
        const n = await undo.revertRun(id);
        vscode.window.showInformationMessage(`Anvil: reverted ${n} change(s) from the run.`);
      } catch (err) {
        vscode.window.showWarningMessage(`Anvil: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('anvil.openAuditLog', async () => {
      await audit.flush();
      const f = audit.file;
      if (!f) return vscode.window.showInformationMessage('Anvil: no audit log for this session yet.');
      try {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(f)), { preview: true });
      } catch {
        vscode.window.showInformationMessage('Anvil: the audit log is empty so far.');
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => audit.record('workspace.trusted')),
    vscode.commands.registerCommand('anvil.reindex', async () => {
      await index.rebuild();
      vscode.window.showInformationMessage(`Anvil: indexed ${index.current.files.size} files.`);
    }),
    vscode.commands.registerCommand('anvil.showContext', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Query to assemble context for' });
      if (!q) return;
      const idx = await index.ready();
      const pack = assembleContext(idx, q, { budget: getConfig().contextBudgetTokens, mentions: parseMentions(q, idx) });
      const doc = await vscode.workspace.openTextDocument({ content: renderPack(pack), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  // Index in the background; register with TrueForge opportunistically (non-blocking).
  void index.ready();
  void gateway
    .ensureSetup()
    .then(() => log.appendLine('[setup] TrueForge ready'))
    .catch((e) => log.appendLine(`[setup] deferred: ${(e as Error).message}`));
  log.appendLine(`Anvil ready. MCP: ${mcpInfo().url} · TrueForge: ${getConfig().trueforgeUrl} · models: ${getConfig().models.join(' → ') || '(none)'}`);
  // Exposed for integration tests.
  return { reviews, undo, index, runner, gateway, mcpInfo, panel };
}

export function deactivate() {}
