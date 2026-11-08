import * as vscode from 'vscode';
import { CodeIndex } from './index';

const INCLUDE = '**/*.{py,pyi,rst,md,txt,toml,cfg,ini,json,yaml,yml,js,jsx,ts,tsx,mjs,cjs,go,rs,java,kt,rb,php,c,h,cc,cpp,hpp,cs,swift,sh,html,css,scss,sql}';
const EXCLUDE = '**/{.git,node_modules,.venv,venv,env,.tox,.nox,__pycache__,dist,build,out,.mypy_cache,.pytest_cache,.ruff_cache,site-packages,.idea,.vscode-test,coverage,htmlcov}/**';
const MAX_BYTES = 512 * 1024;

/** Keeps a CodeIndex in sync with the workspace (initial scan + file watcher, debounced rebuilds). */
export class WorkspaceIndex implements vscode.Disposable {
  private index: CodeIndex = new CodeIndex();
  private building: Promise<void> | undefined;
  private dirty = new Map<string, 'change' | 'delete'>();
  private timer: NodeJS.Timeout | undefined;
  private watcher: vscode.FileSystemWatcher;
  private emitter = new vscode.EventEmitter<CodeIndex>();
  readonly onDidUpdate = this.emitter.event;

  constructor(private log: vscode.OutputChannel) {
    this.watcher = vscode.workspace.createFileSystemWatcher(INCLUDE);
    this.watcher.onDidChange((u) => this.mark(u, 'change'));
    this.watcher.onDidCreate((u) => this.mark(u, 'change'));
    this.watcher.onDidDelete((u) => this.mark(u, 'delete'));
  }

  get current(): CodeIndex {
    return this.index;
  }

  async ready(): Promise<CodeIndex> {
    if (!this.building) this.building = this.rebuild();
    await this.building;
    return this.index;
  }

  async rebuild(): Promise<void> {
    const t0 = Date.now();
    const uris = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, 20000);
    const files: { path: string; text: string }[] = [];
    const decoder = new TextDecoder('utf-8');
    await Promise.all(
      uris.map(async (u) => {
        try {
          const stat = await vscode.workspace.fs.stat(u);
          if (stat.size > MAX_BYTES) return;
          const bytes = await vscode.workspace.fs.readFile(u);
          if (bytes.includes(0)) return; // binary
          files.push({ path: vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'), text: decoder.decode(bytes) });
        } catch {
          /* unreadable: skip */
        }
      }),
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.index = CodeIndex.build(files);
    this.log.appendLine(`[index] ${files.length} files, ${this.index.chunks.length} chunks, ${this.index.symbols.size} symbol keys in ${Date.now() - t0}ms`);
    this.emitter.fire(this.index);
  }

  private mark(uri: vscode.Uri, kind: 'change' | 'delete') {
    if (/[\\/](\.git|node_modules|__pycache__|\.venv|venv)[\\/]/.test(uri.fsPath)) return;
    this.dirty.set(uri.toString(), kind);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  private async flush() {
    const batch = [...this.dirty.entries()];
    this.dirty.clear();
    let idx = this.index;
    for (const [s, kind] of batch) {
      const uri = vscode.Uri.parse(s);
      const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      if (kind === 'delete') idx = idx.withFile(rel, undefined);
      else {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.length > MAX_BYTES || bytes.includes(0)) continue;
          idx = idx.withFile(rel, new TextDecoder().decode(bytes));
        } catch {
          idx = idx.withFile(rel, undefined);
        }
      }
    }
    this.index = idx;
    this.emitter.fire(idx);
  }

  dispose() {
    clearTimeout(this.timer);
    this.watcher.dispose();
  }
}
