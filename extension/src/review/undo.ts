import * as vscode from 'vscode';
import { minimalEdit } from './diff';

export interface UndoEntry {
  uri: vscode.Uri;
  relPath: string;
  before: string | null; // null => the file was created by this change
  after: string;
  runId: string;
  label: string;
}

/**
 * Anvil's own undo history for applied changes. Ctrl+Z in the editor also works (each apply is one
 * WorkspaceEdit), but this stack survives closing the editor and can revert a whole run at once.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  push(e: UndoEntry) {
    this.entries.push(e);
    this.emitter.fire();
  }

  forRun(runId: string) {
    return this.entries.filter((e) => e.runId === runId);
  }

  get size() {
    return this.entries.length;
  }

  last() {
    return this.entries[this.entries.length - 1];
  }

  async undoLast(): Promise<UndoEntry | undefined> {
    const e = this.entries.pop();
    if (!e) return undefined;
    await revert(e);
    this.emitter.fire();
    return e;
  }

  async revertRun(runId: string): Promise<number> {
    const mine = this.entries.filter((e) => e.runId === runId).reverse();
    for (const e of mine) await revert(e);
    this.entries = this.entries.filter((e) => e.runId !== runId);
    this.emitter.fire();
    return mine.length;
  }
}

async function revert(e: UndoEntry) {
  const edit = new vscode.WorkspaceEdit();
  if (e.before === null) {
    edit.deleteFile(e.uri, { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(edit);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(e.uri);
  const cur = doc.getText();
  if (cur.replace(/\r\n/g, '\n') !== e.after.replace(/\r\n/g, '\n')) {
    const pick = await vscode.window.showWarningMessage(
      `Anvil: ${e.relPath} was edited after this change was applied. Restore the pre-change version anyway?`,
      { modal: true },
      'Restore',
    );
    if (pick !== 'Restore') throw new Error('undo aborted by user');
  }
  const m = minimalEdit(cur, e.before);
  edit.replace(e.uri, new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), m.text);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}
