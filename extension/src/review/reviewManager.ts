import * as vscode from 'vscode';
import { Hunk, applyHunks, computeHunks, hunkStartIn, minimalEdit } from './diff';
import { UndoStack } from './undo';

export const PROPOSED_SCHEME = 'anvil-proposed';
export const CURRENT_SCHEME = 'anvil-current';

export interface ReviewResult {
  status: 'decided' | 'cancelled' | 'stale';
  accepted: number[];
  rejected: number[];
  total: number;
  /** Text on disk after the review (original + accepted hunks). */
  finalText: string;
  hunks: Hunk[];
}

type Decision = 'pending' | 'accepted' | 'rejected';

class Review {
  hunks: Hunk[] = [];
  decisions: Decision[] = [];
  streaming = true;
  done = false;
  resolve!: (r: ReviewResult) => void;
  readonly promise: Promise<ReviewResult>;
  proposedUri: vscode.Uri;
  currentUri: vscode.Uri;
  private _proposed: string;

  constructor(
    readonly id: number,
    readonly target: vscode.Uri,
    readonly relPath: string,
    readonly original: string,
    readonly isNewFile: boolean,
    readonly runId: string,
    readonly title: string,
  ) {
    this._proposed = original;
    this.proposedUri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + relPath, query: `id=${id}` });
    this.currentUri = vscode.Uri.from({ scheme: CURRENT_SCHEME, path: '/' + relPath, query: `id=${id}` });
    this.promise = new Promise((r) => (this.resolve = r));
  }

  setProposed(text: string) {
    this._proposed = text;
    this.hunks = computeHunks(this.original, text);
    this.decisions = this.hunks.map(() => 'pending');
  }

  get proposed() {
    return this._proposed;
  }

  set(kind: Decision, idx: number) {
    this.decisions[idx] = kind;
  }

  accepted(): Set<number> {
    return new Set(this.hunks.filter((_, i) => this.decisions[i] === 'accepted').map((h) => h.index));
  }

  shown(): Set<number> {
    return new Set(this.hunks.filter((_, i) => this.decisions[i] !== 'rejected').map((h) => h.index));
  }

  /** What is (supposed to be) on disk: original + accepted hunks. */
  currentText(): string {
    return applyHunks(this.original, this.hunks, this.accepted());
  }

  /** What the right side shows: original + accepted + still-pending hunks. */
  viewText(): string {
    if (this.streaming) return this._proposed;
    return applyHunks(this.original, this.hunks, this.shown());
  }

  pending(): Hunk[] {
    return this.hunks.filter((_, i) => this.decisions[i] === 'pending');
  }

  result(status: ReviewResult['status']): ReviewResult {
    return {
      status,
      accepted: this.hunks.filter((_, i) => this.decisions[i] === 'accepted').map((h) => h.index),
      rejected: this.hunks.filter((_, i) => this.decisions[i] !== 'accepted').map((h) => h.index),
      total: this.hunks.length,
      finalText: this.currentText(),
      hunks: this.hunks,
    };
  }
}

/**
 * Per-hunk review in a native diff editor.
 *  left  = anvil-current:  the file as it is on disk (original + hunks accepted so far)
 *  right = anvil-proposed: left + still-pending hunks, with Accept/Reject CodeLens on each hunk
 * Accepting a hunk applies exactly that hunk to the real file via one WorkspaceEdit and saves it.
 * Nothing reaches disk without an explicit accept.
 */
export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private reviews = new Map<number, Review>();
  private nextId = 1;
  private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private disposables: vscode.Disposable[] = [];
  private readonly _onStatus = new vscode.EventEmitter<{ id: number; relPath: string; text: string }>();
  readonly onStatus = this._onStatus.event;

  constructor(private undo: UndoStack, private workspaceRoot: () => vscode.Uri | undefined) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(CURRENT_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
      vscode.commands.registerCommand('anvil.acceptHunk', (id: number, idx: number) => this.decide(id, idx, 'accepted')),
      vscode.commands.registerCommand('anvil.rejectHunk', (id: number, idx: number) => this.decide(id, idx, 'rejected')),
      vscode.commands.registerCommand('anvil.acceptAll', (id?: number) => this.decideAll(typeof id === 'number' ? id : undefined, 'accepted')),
      vscode.commands.registerCommand('anvil.rejectAll', (id?: number) => this.decideAll(typeof id === 'number' ? id : undefined, 'rejected')),
      vscode.commands.registerCommand('anvil.acceptHunkAtCursor', () => this.decideAtCursor('accepted')),
      vscode.commands.registerCommand('anvil.rejectHunkAtCursor', () => this.decideAtCursor('rejected')),
    );
  }

  /** Keyboard path (works even if CodeLens is disabled): decide the hunk under / after the cursor. */
  private async decideAtCursor(kind: Decision) {
    const ed = vscode.window.activeTextEditor;
    let r = ed?.document.uri.scheme === PROPOSED_SCHEME ? this.reviews.get(idOf(ed.document.uri)) : undefined;
    if (!r) r = [...this.reviews.values()].find((x) => !x.done && !x.streaming);
    if (!r || r.done || r.streaming) return;
    const pending = r.pending();
    if (!pending.length) return;
    const cursor = ed?.document.uri.scheme === PROPOSED_SCHEME ? ed.selection.active.line : -1;
    const shown = r.shown();
    let target = pending[0];
    if (cursor >= 0) {
      for (const h of pending) {
        const s = hunkStartIn(r.hunks, shown, h);
        const e = s + Math.max(1, h.newLines.length) - 1;
        if (cursor <= e) {
          target = h;
          break;
        }
        target = h;
      }
    }
    await this.decide(r.id, target.index, kind);
    // Move the cursor to the next pending hunk so repeated keypresses walk the review.
    const next = r.done ? undefined : r.pending()[0];
    const ed2 = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === r!.proposedUri.toString());
    if (next && ed2) {
      const line = hunkStartIn(r.hunks, r.shown(), next);
      ed2.selection = new vscode.Selection(line, 0, line, 0);
      ed2.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const r = this.reviews.get(idOf(uri));
    if (!r) return '';
    return uri.scheme === PROPOSED_SCHEME ? r.viewText() : r.currentText();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.reviews.get(idOf(doc.uri));
    if (!r || r.done) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    if (r.streaming) return [new vscode.CodeLens(top, { title: '$(sync~spin) Anvil is generating… (Ctrl+Alt+Backspace to cancel)', command: 'anvil.cancel' })];
    const pending = r.pending();
    if (!pending.length) return [];
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `$(check-all) Accept all ${pending.length} pending`, command: 'anvil.acceptAll', arguments: [r.id] }),
      new vscode.CodeLens(top, { title: '$(close-all) Reject all', command: 'anvil.rejectAll', arguments: [r.id] }),
      new vscode.CodeLens(top, { title: `${r.title} — ${r.hunks.length - pending.length}/${r.hunks.length} decided · Ctrl+Alt+Y / N per hunk`, command: '' }),
    ];
    const shown = r.shown();
    for (const h of pending) {
      const line = Math.min(Math.max(0, hunkStartIn(r.hunks, shown, h)), Math.max(0, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const desc = `hunk ${h.index + 1}/${r.hunks.length}: -${h.origLines.length} +${h.newLines.length}`;
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Accept', command: 'anvil.acceptHunk', arguments: [r.id, h.index] }),
        new vscode.CodeLens(range, { title: '$(x) Reject', command: 'anvil.rejectHunk', arguments: [r.id, h.index] }),
        new vscode.CodeLens(range, { title: desc, command: '' }),
      );
    }
    return lenses;
  }

  /** Opens a diff that live-updates while the model streams. Call finish() to switch to review. */
  async openStreaming(target: vscode.Uri, original: string, opts: { runId: string; title: string; isNewFile?: boolean }) {
    const rel = this.rel(target);
    const r = new Review(this.nextId++, target, rel, original, !!opts.isNewFile, opts.runId, opts.title);
    this.reviews.set(r.id, r);
    await diffOpen(r);
    return {
      id: r.id,
      update: (text: string) => {
        r.setProposed(text);
        this.refresh(r);
      },
      /** Ends streaming and returns the review decision promise. */
      finish: (finalText: string) => {
        r.streaming = false;
        r.setProposed(finalText);
        if (!r.hunks.length) {
          this.finalize(r, 'decided');
        } else {
          void vscode.commands.executeCommand('setContext', 'anvil.reviewing', true);
          this.refresh(r);
          this._onStatus.fire({ id: r.id, relPath: rel, text: `${r.hunks.length} hunk(s) to review` });
        }
        return r.promise;
      },
      cancel: () => this.finalize(r, 'cancelled'),
    };
  }

  /** Full review of a finished proposal (agent mode). Resolves once every hunk is decided. */
  async review(target: vscode.Uri, original: string, proposed: string, opts: { runId: string; title: string; isNewFile?: boolean }): Promise<ReviewResult> {
    const s = await this.openStreaming(target, original, opts);
    return s.finish(proposed);
  }

  /** Cancels every open review (used on run cancellation). Nothing pending is applied. */
  cancelAll(runId?: string) {
    for (const r of [...this.reviews.values()]) if (!runId || r.runId === runId) this.finalize(r, 'cancelled');
  }

  get activeCount() {
    return [...this.reviews.values()].filter((r) => !r.done).length;
  }

  private async decide(id: number, idx: number, kind: Decision) {
    const r = this.reviews.get(id);
    if (!r || r.done || r.streaming || r.decisions[idx] !== 'pending') return;
    if (kind === 'accepted') {
      const ok = await this.applyAccepted(r, [idx]);
      if (!ok) return;
    } else r.set('rejected', idx);
    this.afterDecision(r);
  }

  private async decideAll(id: number | undefined, kind: Decision) {
    const r = id !== undefined ? this.reviews.get(id) : [...this.reviews.values()].find((x) => !x.done && !x.streaming);
    if (!r || r.done || r.streaming) return;
    const pend = r.pending().map((h) => h.index);
    if (kind === 'accepted') {
      if (!(await this.applyAccepted(r, pend))) return;
    } else pend.forEach((i) => r.set('rejected', i));
    this.afterDecision(r);
  }

  /** Applies hunks to the real file as one atomic, undoable WorkspaceEdit, then saves. */
  private async applyAccepted(r: Review, idxs: number[]): Promise<boolean> {
    const before = r.currentText();
    const doc = r.isNewFile && !(await exists(r.target)) ? undefined : await vscode.workspace.openTextDocument(r.target);
    if (doc && normalize(doc.getText()) !== normalize(before)) {
      vscode.window.showWarningMessage(`Anvil: ${r.relPath} changed outside the review. Re-run the request to get a fresh diff.`);
      this.finalize(r, 'stale');
      return false;
    }
    idxs.forEach((i) => r.set('accepted', i));
    const after = r.currentText();
    const edit = new vscode.WorkspaceEdit();
    if (!doc) {
      edit.createFile(r.target, { ignoreIfExists: true, contents: Buffer.from(after, 'utf8') });
    } else {
      const m = minimalEdit(doc.getText(), after);
      edit.replace(r.target, new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), m.text);
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      idxs.forEach((i) => r.set('pending', i));
      vscode.window.showErrorMessage(`Anvil: could not apply the change to ${r.relPath}.`);
      return false;
    }
    const saved = await vscode.workspace.openTextDocument(r.target);
    await saved.save();
    this.undo.push({ uri: r.target, relPath: r.relPath, before: r.isNewFile && !doc ? null : before, after, runId: r.runId, label: `${r.title} (${idxs.length} hunk${idxs.length > 1 ? 's' : ''})` });
    return true;
  }

  private afterDecision(r: Review) {
    if (!r.pending().length) this.finalize(r, 'decided');
    else this.refresh(r);
  }

  private finalize(r: Review, status: ReviewResult['status']) {
    if (r.done) return;
    r.done = true;
    if (status === 'cancelled') {
      // Anything not yet accepted is dropped.
      r.decisions = r.decisions.map((d) => (d === 'pending' ? 'rejected' : d));
    }
    this.refresh(r);
    r.resolve(r.result(status));
    void closeDiffTab(r.proposedUri);
    setTimeout(() => this.reviews.delete(r.id), 2000);
    if (!this.activeCount) void vscode.commands.executeCommand('setContext', 'anvil.reviewing', false);
  }

  private refresh(r: Review) {
    this.changeEmitter.fire(r.proposedUri);
    this.changeEmitter.fire(r.currentUri);
    this.lensEmitter.fire();
  }

  private rel(uri: vscode.Uri) {
    const root = this.workspaceRoot();
    return root ? vscode.workspace.asRelativePath(uri, false) : uri.path.split('/').pop()!;
  }

  dispose() {
    this.cancelAll();
    this.disposables.forEach((d) => d.dispose());
  }
}

async function diffOpen(r: Review) {
  await vscode.commands.executeCommand('vscode.diff', r.currentUri, r.proposedUri, `Anvil ↔ ${r.relPath} — ${r.title}`, { preview: false });
}

function idOf(uri: vscode.Uri): number {
  const m = /id=(\d+)/.exec(uri.query);
  return m ? Number(m[1]) : -1;
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n');

async function exists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function closeDiffTab(proposed: vscode.Uri) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === proposed.toString()) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}
