import * as vscode from 'vscode';
import { AgentRunner, RunSink, UiEvent } from '../trueforge/runner';
import { ReviewManager } from '../review/reviewManager';
import { WorkspaceIndex } from '../context/workspaceIndex';
import { assembleContext, renderPack, parseMentions } from '../context/assembler';
import { getConfig } from '../config';
import { sanitizeForModel } from '../security/policy';

/**
 * Inline edit: select code → Ctrl+Alt+K → instruction → streamed diff in the editor → per-hunk review.
 * The model runs on TrueForge (agent anvil-inline); the extension only renders and applies.
 */
export async function inlineEdit(runner: AgentRunner, reviews: ReviewManager, index: WorkspaceIndex, log: vscode.OutputChannel, onEvent?: (e: UiEvent) => void, preset?: { instruction?: string }) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('Anvil: open a file and select the code to edit.');
    return;
  }
  if (runner.isRunning) {
    vscode.window.showWarningMessage('Anvil: a generation is already running. Cancel it first (Ctrl+Alt+Backspace).');
    return;
  }
  const doc = editor.document;
  const idx = await index.ready();
  const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');

  // Expand the selection to whole lines; with no selection, use the enclosing definition.
  let startLine = editor.selection.start.line;
  let endLine = editor.selection.end.line;
  if (editor.selection.end.character === 0 && endLine > startLine) endLine--;
  if (editor.selection.isEmpty) {
    const c = idx.chunkAt(rel, startLine + 1);
    if (c) {
      startLine = c.startLine - 1;
      endLine = c.endLine - 1;
    }
  }
  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  editor.selection = new vscode.Selection(range.start, range.end);

  const instruction = preset?.instruction ?? await vscode.window.showInputBox({
    title: `Anvil inline edit — ${rel}:${startLine + 1}-${endLine + 1}`,
    prompt: 'Describe the change (use @file or @symbol to pull in more context)',
    placeHolder: 'e.g. Treat "off" and "n" as false as well, and update the docstring',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const original = doc.getText();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), range.start));
  const after = doc.getText(new vscode.Range(range.end, doc.lineAt(doc.lineCount - 1).range.end));
  const selected = doc.getText(range);

  const prompt = sanitizeForModel(buildPrompt(idx, rel, doc, startLine, endLine, selected, instruction, getConfig().contextBudgetTokens)).text;
  log.appendLine(`[inline] ${rel}:${startLine + 1}-${endLine + 1} "${instruction}"`);

  const stream = await reviews.openStreaming(doc.uri, original, { runId: 'inline', title: `inline: ${instruction.slice(0, 40)}` });
  let raw = '';
  let lastPaint = 0;
  let tokens = 0;
  const paint = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPaint < 80) return;
    lastPaint = now;
    const code = extractCode(raw, selected);
    stream.update(before + code + after);
  };

  const sink: RunSink = {
    emit: (e) => {
      onEvent?.(e);
      if (e.t === 'delta' && e.threadId === 'main') {
        raw += e.text;
        tokens++;
        paint();
      }
      if (e.t === 'fallback') vscode.window.showWarningMessage(`Anvil: ${e.from} failed — falling back to ${e.to} automatically.`);
      if (e.t === 'notice' && e.level !== 'info') log.appendLine(`[inline] ${e.text}`);
    },
    approveCommand: async () => false,
  };

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Anvil inline edit', cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => void runner.cancel());
      const tick = setInterval(() => progress.report({ message: tokens ? `streaming… ${tokens} chunks` : 'waiting for model…' }), 250);
      try {
        return await runner.run('inline', prompt, sink, { title: `inline: ${rel}` });
      } finally {
        clearInterval(tick);
      }
    },
  );

  if (result.status !== 'done') {
    stream.cancel(); // closes the preview; the file was never touched
    if (result.status === 'cancelled') vscode.window.showInformationMessage('Anvil: inline edit cancelled. No changes were made.');
    else vscode.window.showErrorMessage(`Anvil: inline edit failed — ${result.message ?? 'unknown error'}. No changes were made.`, 'Show log').then((p) => p && log.show());
    return;
  }

  const finalRaw = raw || result.output;
  const code = normaliseIndent(extractCode(finalRaw, selected), selected).replace(/\r?\n/g, eol);
  const review = await stream.finish(before + code + after);
  lastInlineResult = review;
  if (review.status === 'decided') {
    const msg = review.total === 0 ? 'Anvil: the model proposed no changes.' : `Anvil: applied ${review.accepted.length}/${review.total} hunk(s). Undo with Ctrl+Z or "Anvil: Undo Last Applied Change".`;
    vscode.window.showInformationMessage(msg);
  }
}

function buildPrompt(idx: ReturnType<WorkspaceIndex['current']['withFile']>, rel: string, doc: vscode.TextDocument, s: number, e: number, selected: string, instruction: string, budget: number): string {
  const lines = doc.getText().split(/\r?\n/);
  const header = lines.slice(0, Math.min(lines.length, 40)).join('\n');
  const ctxBefore = lines.slice(Math.max(0, s - 25), s).join('\n');
  const ctxAfter = lines.slice(e + 1, Math.min(lines.length, e + 26)).join('\n');
  // enclosing class header if the selection is a method
  const chunk = idx.chunkAt(rel, s + 1);
  let classHdr = '';
  if (chunk?.symbol?.includes('.')) {
    const cls = chunk.symbol.split('.')[0];
    const def = idx.findSymbol(cls).find((d) => d.path === rel);
    if (def) classHdr = lines.slice(def.line - 1, def.line + 4).join('\n');
  }
  const pack = assembleContext(idx, instruction + '\n' + selected.slice(0, 1500), {
    budget: Math.round(budget / 3),
    mentions: parseMentions(instruction, idx),
    maxRepoMapTokens: 0,
    exclude: (p) => p === rel,
  });
  const lang = doc.languageId;
  return [
    `File: ${rel} (language: ${lang}); selected lines ${s + 1}-${e + 1}.`,
    `\n<file_header>\n${header}\n</file_header>`,
    classHdr ? `\n<enclosing_class>\n${classHdr}\n</enclosing_class>` : '',
    `\n<code_before_selection>\n${ctxBefore}\n</code_before_selection>`,
    `\n<selection>\n${selected}\n</selection>`,
    `\n<code_after_selection>\n${ctxAfter}\n</code_after_selection>`,
    pack.items.length ? '\n' + renderPack(pack) : '',
    `\nInstruction: ${instruction}`,
    `\nReturn ONLY the replacement for the <selection> in one \`\`\`${lang} code block.`,
  ].join('\n');
}

/** Last inline review result (for tests / telemetry). */
export let lastInlineResult: unknown;

/** Pulls code out of a (possibly still streaming) fenced block. */
export function extractCode(raw: string, fallback: string): string {
  const open = raw.indexOf('```');
  if (open < 0) return raw.trim() ? raw.replace(/^\n+/, '') : fallback;
  const nl = raw.indexOf('\n', open);
  if (nl < 0) return fallback;
  const close = raw.indexOf('\n```', nl);
  const body = close < 0 ? raw.slice(nl + 1) : raw.slice(nl + 1, close);
  return body.replace(/\n$/, '');
}

/** Models often drop the selection's base indentation; restore it. */
export function normaliseIndent(code: string, selected: string): string {
  const ind = (s: string) => (/^[ \t]*/.exec(s.split(/\r?\n/).find((l) => l.trim()) ?? '')?.[0] ?? '');
  const want = ind(selected);
  const have = ind(code);
  if (want.length > have.length && want.startsWith(have)) {
    const add = want.slice(have.length);
    return code.split('\n').map((l) => (l.trim() ? add + l : l)).join('\n');
  }
  return code;
}
