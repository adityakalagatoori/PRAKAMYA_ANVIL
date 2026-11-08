import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { WorkspaceIndex } from '../context/workspaceIndex';
import { assembleContext, buildRepoMap, renderPack, summarizePack } from '../context/assembler';
import { applySearchReplace } from '../review/diff';
import { ReviewManager, ReviewResult } from '../review/reviewManager';
import { RunState, canonicalKey } from '../runState';
import { getConfig } from '../config';

export interface ToolDeps {
  index: WorkspaceIndex;
  reviews: ReviewManager;
  runs: RunState;
  log: vscode.OutputChannel;
  terminal: CommandTerminal;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  kind: 'read' | 'write' | 'exec';
  run: (args: any, deps: ToolDeps) => Promise<string>;
}

export const WRITE_TOOLS = new Set(['edit_file', 'create_file']);

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Resolves a model-supplied path inside the workspace; refuses anything that escapes it. */
export function resolvePath(p: string): { uri: vscode.Uri; rel: string } {
  const root = workspaceRoot();
  if (!root) throw new Error('No workspace folder is open.');
  const clean = String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error(`Path escapes the workspace: ${p}`);
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) throw new Error('Empty path.');
  return { uri: vscode.Uri.joinPath(root, ...parts), rel: parts.join('/') };
}

export async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export interface PreparedWrite {
  tool: string;
  uri: vscode.Uri;
  rel: string;
  original: string;
  proposed: string;
  isNewFile: boolean;
}

/** Turns a write tool call into (original, proposed) without touching disk. */
export async function prepareWrite(tool: string, args: any): Promise<PreparedWrite | { error: string }> {
  try {
    const { uri, rel } = resolvePath(args?.path);
    const current = await readText(uri);
    if (tool === 'create_file') {
      if (current !== undefined) return { error: `${rel} already exists. Use edit_file to change it.` };
      return { tool, uri, rel, original: '', proposed: String(args?.content ?? ''), isNewFile: true };
    }
    if (tool === 'edit_file') {
      if (current === undefined) return { error: `${rel} does not exist. Use create_file for new files.` };
      const r = applySearchReplace(current, String(args?.old_string ?? ''), String(args?.new_string ?? ''));
      if (!r.ok) return { error: `${rel}: ${r.error}` };
      if (r.result === current) return { error: `${rel}: old_string and new_string are identical; nothing to change.` };
      return { tool, uri, rel, original: current, proposed: r.result, isNewFile: false };
    }
    return { error: `Unknown write tool ${tool}` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function describeReview(rel: string, r: ReviewResult): string {
  if (r.status === 'cancelled') return `Run cancelled during review of ${rel}. No pending hunks were applied.`;
  if (r.status === 'stale') return `${rel} changed on disk during review; nothing more applied. Re-read the file and try again.`;
  if (!r.accepted.length) return `The user REJECTED all ${r.total} hunk(s) for ${rel}. The file is unchanged. Do not retry the same edit; ask or try a different approach.`;
  if (r.accepted.length === r.total) return `Applied all ${r.total} hunk(s) to ${rel} (user accepted).`;
  const rej = r.rejected.map((i) => i + 1).join(', ');
  return `Applied ${r.accepted.length}/${r.total} hunk(s) to ${rel}. The user rejected hunk(s) ${rej}; those parts were NOT applied. Re-read the file before further edits.`;
}

const MAX_READ_LINES = 400;

export const TOOLS: ToolDef[] = [
  {
    name: 'retrieve_context',
    kind: 'read',
    description:
      'Ranked retrieval over the whole repository (BM25 over function/class/section chunks + test/docs counterparts) under a token budget. Returns the most relevant code with the reason each piece was chosen. Use this first when you do not know where something lives.',
    schema: { query: z.string().describe('Natural-language description of what you are looking for'), budget_tokens: z.number().optional().describe('Token budget, 300-8000 (default 2500)') },
    async run(a, d) {
      const idx = await d.index.ready();
      const budget = Math.min(8000, Math.max(300, Math.round(Number(a.budget_tokens) || 2500)));
      const pack = assembleContext(idx, a.query, { budget, maxRepoMapTokens: 300 });
      const s = summarizePack(pack);
      const header = [`Retrieved ${s.items.length} chunks from ${new Set(s.items.map((i) => i.path)).size} files (${s.used}/${s.budget} tokens):`, ...s.items.map((i) => `- ${i.path}:${i.lines}${i.symbol ? ' ' + i.symbol : ''} — ${i.reason}`)].join('\n');
      return header + '\n\n' + renderPack(pack);
    },
  },
  {
    name: 'search_code',
    kind: 'read',
    description: 'Search file contents (like grep). Returns matching lines as path:line: text. Use for exact identifiers or strings.',
    schema: {
      pattern: z.string(),
      is_regex: z.boolean().optional(),
      path_glob: z.string().optional().describe('Restrict to paths containing this substring or matching this glob, e.g. "tests/" or "*.rst"'),
      max_results: z.number().int().min(1).max(200).optional(),
    },
    async run(a, d) {
      const idx = await d.index.ready();
      let re: RegExp;
      try {
        re = a.is_regex ? new RegExp(a.pattern, 'i') : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch (e) {
        return `Invalid regex: ${(e as Error).message}`;
      }
      const glob = a.path_glob ? globToRe(a.path_glob) : undefined;
      const max = a.max_results ?? 60;
      const out: string[] = [];
      let total = 0;
      for (const f of idx.files.values()) {
        if (glob && !glob.test(f.path)) continue;
        const lines = f.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            total++;
            if (out.length < max) out.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }
      if (!out.length) return 'No matches.';
      return out.join('\n') + (total > out.length ? `\n… ${total - out.length} more matches (narrow with path_glob)` : '');
    },
  },
  {
    name: 'find_symbol',
    kind: 'read',
    description: 'Find where a function, class, method (Class.method) or docs section is defined. Returns locations and the first lines of each definition.',
    schema: { name: z.string() },
    async run(a, d) {
      const idx = await d.index.ready();
      const defs = idx.findSymbol(a.name);
      if (!defs.length) return `No definition found for "${a.name}". Try search_code.`;
      return defs
        .slice(0, 10)
        .map((s) => {
          const c = idx.chunkAt(s.path, s.line);
          const preview = c ? c.text.split('\n').slice(0, 6).join('\n') : '';
          return `${s.kind} ${s.qualified} — ${s.path}:${s.line}${c ? ` (lines ${c.startLine}-${c.endLine})` : ''}\n${preview}`;
        })
        .join('\n\n');
    },
  },
  {
    name: 'read_file',
    kind: 'read',
    description: `Read a file (or a line range). Returns at most ${MAX_READ_LINES} lines per call; the header says the total line count. Always read before editing.`,
    schema: { path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() },
    async run(a) {
      const { uri, rel } = resolvePath(a.path);
      const text = await readText(uri);
      if (text === undefined) return `File not found: ${rel}`;
      const lines = text.split(/\r?\n/);
      const s = Math.max(1, a.start_line ?? 1);
      const e = Math.min(lines.length, a.end_line ?? s + MAX_READ_LINES - 1, s + MAX_READ_LINES - 1);
      const more = e < lines.length ? `\n[… ${lines.length - e} more lines; call read_file with start_line=${e + 1}]` : '';
      return `${rel} (lines ${s}-${e} of ${lines.length})\n${lines.slice(s - 1, e).join('\n')}${more}`;
    },
  },
  {
    name: 'list_files',
    kind: 'read',
    description: 'List files under a directory (relative to the workspace root), optionally filtered by a glob.',
    schema: { dir: z.string().optional(), glob: z.string().optional() },
    async run(a, d) {
      const idx = await d.index.ready();
      const dir = String(a.dir ?? '').replace(/\\/g, '/').replace(/^\.?\/?/, '').replace(/\/$/, '');
      const g = a.glob ? globToRe(a.glob) : undefined;
      const all = [...idx.files.keys()];
      let base = dir;
      let note = '';
      if (dir && !all.some((p) => p.startsWith(dir + '/'))) {
        // Small models often drop a prefix ("flask" for "src/flask"): resolve by suffix.
        const dirs = [...new Set(all.map((p) => p.split('/').slice(0, -1).join('/')))];
        const cand = dirs.filter((d) => d.endsWith('/' + dir)).sort((a, b) => a.length - b.length)[0];
        if (!cand) return `No directory "${dir}". Top-level directories: ${[...new Set(all.map((p) => p.split('/')[0]))].sort().join(', ')}`;
        base = cand;
        note = `(resolved "${dir}" → "${cand}")\n`;
      }
      const files = all.filter((p) => (!base || p.startsWith(base + '/')) && (!g || g.test(p))).sort();
      if (!files.length) return note + 'No files.';
      return note + files.slice(0, 300).join('\n') + (files.length > 300 ? `\n… ${files.length - 300} more` : '');
    },
  },
  {
    name: 'repo_map',
    kind: 'read',
    description: 'Compact map of the repository: directories, files and their top-level classes/functions. Focus on a directory to expand it.',
    schema: { dir: z.string().optional() },
    async run(a, d) {
      const idx = await d.index.ready();
      const focus = a.dir ? [...idx.files.keys()].filter((p) => p.startsWith(String(a.dir).replace(/\/$/, '') + '/')) : [];
      return buildRepoMap(idx, focus, 2500);
    },
  },
  {
    name: 'get_diagnostics',
    kind: 'read',
    description: 'Editor diagnostics (errors/warnings from language servers) for a file or the whole workspace.',
    schema: { path: z.string().optional() },
    async run(a) {
      const all = a.path ? [[resolvePath(a.path).uri, vscode.languages.getDiagnostics(resolvePath(a.path).uri)] as const] : vscode.languages.getDiagnostics();
      const out: string[] = [];
      for (const [uri, diags] of all) {
        for (const dg of diags) {
          if (dg.severity > vscode.DiagnosticSeverity.Warning) continue;
          out.push(`${vscode.workspace.asRelativePath(uri)}:${dg.range.start.line + 1}: ${vscode.DiagnosticSeverity[dg.severity]}: ${dg.message}`);
        }
      }
      return out.slice(0, 100).join('\n') || 'No errors or warnings.';
    },
  },
  {
    name: 'edit_file',
    kind: 'write',
    description:
      'Propose an edit: replace old_string (must match the file exactly once, including indentation; include a few surrounding lines to make it unique) with new_string. The user reviews every hunk in a diff before anything is written; the result tells you which hunks were accepted.',
    schema: { path: z.string(), old_string: z.string(), new_string: z.string() },
    run: (a, d) => runWrite('edit_file', a, d),
  },
  {
    name: 'create_file',
    kind: 'write',
    description: 'Propose a new file with the given content. The user reviews it before it is written. Fails if the file exists (use edit_file).',
    schema: { path: z.string(), content: z.string() },
    run: (a, d) => runWrite('create_file', a, d),
  },
  {
    name: 'run_command',
    kind: 'exec',
    description:
      'Run a shell command in the workspace root (e.g. tests: "python -m pytest tests/test_cli.py -q"). Requires user approval. Returns exit code and the tail of stdout/stderr.',
    schema: { command: z.string(), timeout_s: z.number().int().min(1).max(600).optional() },
    async run(a, d) {
      const run = d.runs.active;
      if (!run || run.cancelled) return 'No active run (cancelled). Command not executed.';
      return d.terminal.run(a.command, (a.timeout_s ?? 120) * 1000, run.abort.signal);
    },
  },
];

async function runWrite(tool: string, args: any, d: ToolDeps): Promise<string> {
  const run = d.runs.active;
  if (!run || run.cancelled) return 'The run was cancelled by the user. No changes were made.';
  const prepared = await prepareWrite(tool, args);
  let rel: string;
  try {
    rel = resolvePath(args?.path).rel;
  } catch (e) {
    return (e as Error).message;
  }
  // Normal path: the review already happened when TrueForge asked for approval.
  const decided = d.runs.takeDecision(canonicalKey(tool, args), tool, rel);
  if (decided) return describeReview(rel, decided.review);
  if ('error' in prepared) return `Error: ${prepared.error}`;
  // Safety net: a write arrived without an approval-time review (e.g. approval not configured).
  // Review it now. There is no code path that writes without the user seeing the diff.
  d.log.appendLine(`[mcp] ${tool} ${rel}: no approval-time review found; reviewing inline`);
  const res = await d.reviews.review(prepared.uri, prepared.original, prepared.proposed, { runId: run.id, title: `${tool} ${rel}`, isNewFile: prepared.isNewFile });
  if (run.cancelled) return 'The run was cancelled by the user. Pending hunks were discarded.';
  return describeReview(rel, res);
}

function globToRe(glob: string): RegExp {
  if (!/[*?]/.test(glob)) return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i');
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?');
  return new RegExp('(^|/)' + re + '$', 'i');
}

/** Pseudo-terminal that shows agent commands and their output, and runs them with cancellation. */
export class CommandTerminal implements vscode.Disposable {
  private writeEmitter = new vscode.EventEmitter<string>();
  private terminal: vscode.Terminal | undefined;
  private procs = new Set<ChildProcess>();

  private ensure() {
    if (this.terminal && vscode.window.terminals.includes(this.terminal)) return this.terminal;
    const pty: vscode.Pseudoterminal = { onDidWrite: this.writeEmitter.event, open: () => {}, close: () => (this.terminal = undefined) };
    this.terminal = vscode.window.createTerminal({ name: 'Anvil agent', pty });
    return this.terminal;
  }

  run(command: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    const root = workspaceRoot();
    if (!root) return Promise.resolve('No workspace.');
    const term = this.ensure();
    term.show(true);
    const w = (s: string) => this.writeEmitter.fire(s.replace(/\r?\n/g, '\r\n'));
    w(`\x1b[1;36m$ ${command}\x1b[0m\n`);
    return new Promise((resolve) => {
      const env = commandEnv(root.fsPath);
      if (env.VIRTUAL_ENV) w(`[2m(using ${env.VIRTUAL_ENV})[0m
`);
      const p = spawn(command, { cwd: root.fsPath, shell: true, env, windowsHide: true });
      this.procs.add(p);
      let out = '';
      const onData = (b: Buffer) => {
        const s = b.toString();
        out += s;
        if (out.length > 200_000) out = out.slice(-100_000);
        w(s);
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      const kill = (why: string) => {
        out += `\n[${why}]`;
        killTree(p);
      };
      const timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
      const onAbort = () => kill('cancelled by user');
      signal.addEventListener('abort', onAbort, { once: true });
      p.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.procs.delete(p);
        w(`\x1b[2m[exit ${code}]\x1b[0m\n\n`);
        const tail = out.length > 8000 ? '…' + out.slice(-8000) : out;
        resolve(`exit code: ${code}\n${tail}`);
      });
      p.on('error', (e) => resolve(`Failed to start: ${e.message}`));
    });
  }

  killAll() {
    for (const p of this.procs) killTree(p);
  }

  dispose() {
    this.killAll();
    this.terminal?.dispose();
  }
}

/** Environment for agent commands: activates the workspace virtualenv (.venv / venv / env) if present. */
export function commandEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of ['.venv', 'venv', 'env']) {
    const dir = path.join(root, name);
    const bin = path.join(dir, process.platform === 'win32' ? 'Scripts' : 'bin');
    if (existsSync(path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'))) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[key] = bin + path.delimiter + (env[key] ?? '');
      env.VIRTUAL_ENV = dir;
      delete env.PYTHONHOME;
      break;
    }
  }
  return env;
}

function killTree(p: ChildProcess) {
  if (p.exitCode !== null || !p.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
  else p.kill('SIGTERM');
}

export { getConfig };
