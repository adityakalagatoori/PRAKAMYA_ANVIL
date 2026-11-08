// Minimal stand-in for the `vscode` module so MCP/tool code can run under node:test.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class Uri {
  constructor(public fsPath: string, public scheme = 'file', public path = fsPath.replace(/\\/g, '/'), public query = '') {}
  static file(p: string) {
    return new Uri(p);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(join(base.fsPath, ...parts));
  }
  toString() {
    return 'file://' + this.path;
  }
}
const root = process.env.STUB_WORKSPACE ?? process.cwd();
export const workspace = {
  workspaceFolders: [{ uri: Uri.file(root) }],
  textDocuments: [] as any[],
  fs: {
    readFile: async (u: Uri) => new Uint8Array(readFileSync(u.fsPath)),
    stat: async (u: Uri) => statSync(u.fsPath),
  },
  asRelativePath: (u: Uri) => u.fsPath.slice(root.length + 1).replace(/\\/g, '/'),
  getConfiguration: () => ({ get: () => undefined }),
};
export enum DiagnosticSeverity { Error, Warning, Information, Hint }
export const languages = { getDiagnostics: () => [] };
export class EventEmitter<T> {
  private l: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void) => {
    this.l.push(fn);
    return { dispose() {} };
  };
  fire(e: T) {
    this.l.forEach((f) => f(e));
  }
}
export const window = {};
export const commands = { executeCommand: async () => undefined };
