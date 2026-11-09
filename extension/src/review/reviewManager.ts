import * as vscode from 'vscode';
import { Hunk, applyHunks, computeHunks, hunkStartIn, minimalEdit } from './diff';
import { UndoStack } from './undo';
import { audit } from '../security/audit';
import { Dangling, HunkGraph, closureOf, danglingNames, dependentsOf, hunkGraph } from './closure';

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
  /** Names the accepted subset references but no longer defines (partial acceptance broke it). */
  dangling?: Dangling[];
}

type Decision = 'pending' | 'accepted' | 'rejected';

class Review {
  hunks: Hunk[] = [];
  decisions: Decision[] = [];
  streaming = true;
  done = false;
  /** Security warnings must be confirmed (modal) once before any hunk is applied. */
  warningsConfirmed = false;
  /** Dependencies between this proposal's hunks (acceptance closure). */
  graph: HunkGraph = { requires: new Map(), why: new Map() };
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
    readonly warnings: string[] = [],
    /** Informational lines (e.g. the grounding badge); unlike warnings they need no confirmation. */
    readonly notes: string[] = [],
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
    const acc = this.accepted();
    const partial = acc.size > 0 && acc.size < this.hunks.length;
    return {
      dangling: partial ? danglingNames(this.relPath, this.original, this.hunks, acc) : [],
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
      ...r.warnings.map((w) => new vscode.CodeLens(top, { title: `$(warning) ${w}`, command: '' })),
      ...r.notes.map((n) => new vscode.CodeLens(top, { title: `$(shield) ${n}`, command: '' })),
      new vscode.CodeLens(top, { title: `$(check-all) Accept all ${pending.length} pending`, command: 'anvil.acceptAll', arguments: [r.id] }),
      new vscode.CodeLens(top, { title: '$(close-all) Reject all', command: 'anvil.rejectAll', arguments: [r.id] }),
      new vscode.CodeLens(top, { title: `${r.title} — ${r.hunks.length - pending.length}/${r.hunks.length} decided · Ctrl+Alt+Y / N per hunk`, command: '' }),
    ];
    const shown = r.shown();
    for (const h of pending) {
      const line = Math.min(Math.max(0, hunkStartIn(r.hunks, shown, h)), Math.max(0, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const desc = `hunk ${h.index + 1}/${r.hunks.length}: -${h.origLines.length} +${h.newLines.length}`;
      const needs = [...(r.graph.requires.get(h.index) ?? [])].filter((i) => r.decisions[i] !== 'accepted');
      if (needs.length) {
        lenses.push(new vscode.CodeLens(range, { title: `$(link) needs hunk ${needs.map((i) => i + 1).join(', ')}`, tooltip: needs.map((i) => r.graph.why.get(`${h.index}->${i}`)).join('\n'), command: '' }));
      }
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Accept', command: 'anvil.acceptHunk', arguments: [r.id, h.index] }),
        new vscode.CodeLens(range, { title: '$(x) Reject', command: 'anvil.rejectHunk', arguments: [r.id, h.index] }),
        new vscode.CodeLens(range, { title: desc, command: '' }),
      );
    }
    return lenses;
  }

  /** Opens a diff that live-updates while the model streams. Call finish() to switch to review. */
  async openStreaming(target: vscode.Uri, original: string, opts: { runId: string; title: string; isNewFile?: boolean; warnings?: string[]; notes?: string[] }) {
    const rel = this.rel(target);
    const r = new Review(this.nextId++, target, rel, original, !!opts.isNewFile, opts.runId, opts.title, opts.warnings ?? [], opts.notes ?? []);
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
        r.graph = hunkGraph(rel, r.original, r.hunks);
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
  async review(target: vscode.Uri, original: string, proposed: string, opts: { runId: string; title: string; isNewFile?: boolean; warnings?: string[]; notes?: string[] }): Promise<ReviewResult> {
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
    const pendingSet = new Set(r.pending().map((h) => h.index));
    if (kind === 'accepted') {
      // Acceptance closure: hunks this one needs are offered with it and applied atomically.
      const need = [...closureOf(r.graph, [idx], pendingSet)];
      let idxs = [idx];
      if (need.length) {
        const why = need.map((i) => `• ${r.graph.why.get(`${idx}->${i}`) ?? `needs hunk ${i + 1}`}`).join('\n');
        const pick = await this.ask(
          `Hunk ${idx + 1} depends on hunk ${need.map((i) => i + 1).join(', ')}.`,
          `${why}\n\nAccepting it alone would leave ${r.relPath} in a state nobody proposed.`,
          ['Accept together', 'Accept only this hunk'],
        );
        if (!pick) return;
        if (pick === 'Accept together') idxs = [idx, ...need];
        audit.record('review.closure', { path: r.relPath, hunk: idx + 1, needs: need.map((i) => i + 1), choice: pick });
      }
      const ok = await this.applyAccepted(r, idxs);
      if (!ok) return;
    } else {
      // Counterfactual: what would the remaining hunks (accepted + still pending) lack without this one?
      const remaining = new Set([...r.accepted(), ...pendingSet]);
      remaining.delete(idx);
      const dependents = [...dependentsOf(r.graph, [idx], remaining)];
      let rejectAlso: number[] = [];
      if (dependents.length) {
        const broken = danglingNames(r.relPath, r.original, r.hunks, remaining);
        const applied = dependents.filter((i) => r.decisions[i] === 'accepted');
        const pend = dependents.filter((i) => r.decisions[i] === 'pending');
        const detail =
          (broken.length ? `Without it, ${r.relPath} would reference ${broken.map((b) => `${b.name} (line ${b.line})`).join(', ')} with no definition.\n` : '') +
          dependents.map((i) => `• hunk ${i + 1} ${r.decisions[i] === 'accepted' ? '(already applied) ' : ''}${r.graph.why.get(`${i}->${idx}`) ?? 'depends on it'}`).join('\n');
        const options = [...(pend.length ? [`Reject with hunk ${pend.map((i) => i + 1).join(', ')}`] : []), ...(applied.length ? ['Accept this hunk instead'] : []), 'Reject only this hunk'];
        const pick = await this.ask(`Hunk ${dependents.map((i) => i + 1).join(', ')} depend${dependents.length === 1 ? 's' : ''} on hunk ${idx + 1}.`, detail, options);
        if (!pick) return;
        audit.record('review.closure', { path: r.relPath, reject: idx + 1, dependents: dependents.map((i) => i + 1), choice: pick });
        if (pick === 'Accept this hunk instead') {
          if (await this.applyAccepted(r, [idx])) this.afterDecision(r);
          return;
        }
        if (pick.startsWith('Reject with')) rejectAlso = pend;
      }
      r.set('rejected', idx);
      rejectAlso.forEach((i) => r.set('rejected', i));
    }
    this.afterDecision(r);
  }

  /** Modal choice; automation (tests, recorded demos) takes the first option without blocking. */
  private async ask(message: string, detail: string, options: string[]): Promise<string | undefined> {
    if (process.env.ANVIL_AUTOMATION) return options[0];
    return vscode.window.showWarningMessage(`Anvil: ${message}`, { modal: true, detail }, ...options);
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
    if (r.warnings.length && !r.warningsConfirmed) {
      const pick = await vscode.window.showWarningMessage(
        `Anvil: this change to ${r.relPath} needs extra care`,
        { modal: true, detail: r.warnings.map((w) => '• ' + w).join('\n') + '\n\nOnly apply it if you expected the agent to change this.' },
        'Apply anyway',
      );
      if (pick !== 'Apply anyway') {
        audit.record('review.warning_declined', { path: r.relPath, warnings: r.warnings });
        return false;
      }
      r.warningsConfirmed = true;
      audit.record('review.warning_confirmed', { path: r.relPath, warnings: r.warnings });
    }
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
    audit.record('write.applied', { path: r.relPath, runId: r.runId, hunks: idxs.map((i) => i + 1), created: r.isNewFile && !doc, bytes: after.length });
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
    audit.record('review.done', { path: r.relPath, runId: r.runId, status, decisions: r.decisions });
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
    this.revealFirstChange(r);
  }

  /** Keep the first pending hunk in view (diffs otherwise open at line 1, far from the change). */
  private revealFirstChange(r: Review) {
    const first = r.streaming ? r.hunks[0] : r.pending()[0];
    if (!first) return;
    const line = r.streaming ? first.origStart : hunkStartIn(r.hunks, r.shown(), first);
    if ((r as any).lastRevealed === line) return;
    (r as any).lastRevealed = line;
    setTimeout(() => {
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === r.proposedUri.toString());
      if (ed) ed.revealRange(new vscode.Range(Math.max(0, line - 3), 0, line + 8, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }, 60);
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
