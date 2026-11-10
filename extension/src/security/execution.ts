import { createHash } from 'node:crypto';

/**
 * Edit-to-execution binding.
 *
 * A command string says little about what it runs: `npm test` runs whatever package.json says,
 * `pytest` imports every conftest.py and the code under test, `git commit` runs hooks. An agent
 * (or an injection steering it) can therefore edit code and then ask for an innocent-looking
 * command that executes it. Anvil resolves the command's *transitive execution set* from the
 * workspace's own build/test/hook configuration, intersects it with the files the agent modified
 * in this conversation, escalates the approval with the modified code that will run (and what it
 * does: network, processes, dynamic code), and binds the approval to the content hashes of those
 * files: if any changes before the command executes, the approval is void.
 * Pure (no vscode).
 */

export interface WorkspaceView {
  files(): string[];
  read(path: string): string | undefined;
}

export interface ExecutionSet {
  /** Workspace files whose code the command will (or may) execute. */
  files: Set<string>;
  /** Why each file is in the set (first reason). */
  why: Map<string, string>;
}

/** Files that run code merely by being present for a build/test/VCS action. */
export const EXEC_CONFIG = /(^|\/)(conftest\.py|setup\.py|noxfile\.py|package\.json|Makefile|makefile|GNUmakefile|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|\.pre-commit-config\.ya?ml|\.envrc)$|(^|\/)(\.husky|\.githooks)\/|\.(sh|ps1|bat|cmd)$/;

export const sha = (s: string) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

function splitSegments(cmd: string): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [];
  let tok = '';
  let q: string | null = null;
  const push = () => {
    if (tok) cur.push(tok);
    tok = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else tok += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === ';' || c === '|' || c === '&') {
      push();
      if (cur.length) segs.push(cur);
      cur = [];
      continue;
    }
    tok += c;
  }
  push();
  if (cur.length) segs.push(cur);
  return segs;
}

function pyLocalImports(path: string, text: string, all: Set<string>): string[] {
  const out: string[] = [];
  const dir = path.split('/').slice(0, -1);
  const resolve = (mod: string): string | undefined => {
    let base: string[];
    if (mod.startsWith('.')) {
      const dots = mod.match(/^\.+/)![0].length;
      base = dir.slice(0, dir.length - (dots - 1));
      base.push(...mod.slice(dots).split('.').filter(Boolean));
    } else base = mod.split('.');
    const b = base.join('/');
    for (const c of [`${b}.py`, `${b}/__init__.py`]) {
      if (all.has(c)) return c;
      for (const p of all) if (p.endsWith('/' + c)) return p;
    }
    return undefined;
  };
  for (const m of text.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm)) {
    const r = resolve(m[1] ?? m[2]);
    if (r) out.push(r);
  }
  return out;
}

function jsLocalImports(path: string, text: string, all: Set<string>): string[] {
  const out: string[] = [];
  const dir = path.split('/').slice(0, -1);
  for (const m of text.matchAll(/(?:require\(\s*|from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const parts = [...dir];
    for (const seg of m[1].split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    const b = parts.join('/');
    for (const c of [b, `${b}.js`, `${b}.ts`, `${b}.mjs`, `${b}.cjs`, `${b}/index.js`, `${b}/index.ts`]) if (all.has(c)) out.push(c);
  }
  return out;
}

/** Resolves the workspace files a shell command will execute (conservatively). */
export function resolveExecutionSet(command: string, ws: WorkspaceView): ExecutionSet {
  const all = new Set(ws.files());
  const set: ExecutionSet = { files: new Set(), why: new Map() };
  const add = (p: string, why: string) => {
    if (!all.has(p)) return false;
    if (!set.files.has(p)) {
      set.files.add(p);
      set.why.set(p, why);
      return true;
    }
    return false;
  };
  const addWithImports = (p: string, why: string, depth = 0) => {
    if (!add(p, why) || depth > 6) return;
    const t = ws.read(p) ?? '';
    const deps = p.endsWith('.py') ? pyLocalImports(p, t, all) : /\.[cm]?[jt]s$/.test(p) ? jsLocalImports(p, t, all) : [];
    for (const d of deps) addWithImports(d, `imported by ${p}`, depth + 1);
  };
  const pyFiles = [...all].filter((p) => p.endsWith('.py'));
  const pkgScripts = (): Record<string, string> => {
    try {
      return JSON.parse(ws.read('package.json') ?? '{}').scripts ?? {};
    } catch {
      return {};
    }
  };
  const visit = (cmd: string, depth: number) => {
    if (depth > 4) return;
    for (let seg of splitSegments(cmd)) {
      while (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0])) seg = seg.slice(1); // FOO=1 cmd
      if (!seg.length) continue;
      let [exe, ...args] = seg;
      exe = exe.replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '').toLowerCase();
      if (['sudo', 'env', 'time', 'nice', 'uv', 'poetry', 'pipenv', 'hatch', 'pdm'].includes(exe) && args.length) {
        if (['run', 'exec'].includes(args[0])) args = args.slice(1);
        [exe, ...args] = args;
        exe = (exe ?? '').toLowerCase();
      }
      const fileArgs = args.map((a) => a.replace(/\\/g, '/').replace(/^\.\//, '').replace(/::.*$/, ''));
      // npm / pnpm / yarn scripts (with pre/post hooks), recursively.
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(exe)) {
        const scripts = pkgScripts();
        let name: string | undefined;
        if (['run', 'run-script'].includes(args[0])) name = args[1];
        else if (['test', 'start', 'stop', 'restart', 't'].includes(args[0])) name = args[0] === 't' ? 'test' : args[0];
        else if (exe !== 'npm' && args[0] && scripts[args[0]]) name = args[0];
        else if (['install', 'i', 'ci', 'add'].includes(args[0])) name = 'install';
        if (name) {
          add('package.json', `defines the "${name}" script`);
          for (const n of [`pre${name}`, name, `post${name}`, ...(name === 'install' ? ['preinstall', 'postinstall', 'prepare'] : [])]) if (scripts[n]) visit(scripts[n], depth + 1);
        }
        continue;
      }
      if (exe === 'npx' || exe === 'pnpx') continue;
      // Python test runners execute conftest.py files, config, the tests and the code they import.
      const isPytest = exe === 'pytest' || exe === 'py.test' || (exe.startsWith('python') && args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) || exe === 'tox' || exe === 'nox';
      if (isPytest) {
        for (const c of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'noxfile.py', 'conftest.py']) add(c, `${exe === 'python' ? 'pytest' : exe} configuration`);
        for (const p of pyFiles) if (/(^|\/)conftest\.py$/.test(p)) add(p, 'pytest loads every conftest.py');
        const targets = fileArgs.filter((a) => !a.startsWith('-') && a !== 'pytest' && a !== 'unittest' && a !== '-m');
        const tests = pyFiles.filter((p) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p) && (!targets.length || targets.some((t) => p === t || p.startsWith(t.replace(/\/$/, '') + '/'))));
        for (const t of tests) addWithImports(t, 'test module run by the test runner');
        continue;
      }
      if (exe.startsWith('python') || exe === 'py') {
        const mIdx = args.indexOf('-m');
        if (mIdx >= 0 && args[mIdx + 1]) {
          const mod = args[mIdx + 1].split('.').join('/');
          for (const c of [`${mod}.py`, `${mod}/__main__.py`, `${mod}/__init__.py`]) for (const p of all) if (p === c || p.endsWith('/' + c)) addWithImports(p, `python -m ${args[mIdx + 1]}`);
          continue;
        }
        const script = fileArgs.find((a) => a.endsWith('.py'));
        if (script) addWithImports(script, 'script run by python');
        continue;
      }
      if (['node', 'deno', 'tsx', 'ts-node', 'bun'].includes(exe)) {
        const script = fileArgs.find((a) => /\.[cm]?[jt]s$/.test(a));
        if (script) addWithImports(script, `script run by ${exe}`);
        continue;
      }
      if (['make', 'gmake', 'nmake'].includes(exe)) {
        for (const m of ['Makefile', 'makefile', 'GNUmakefile']) add(m, 'make reads the Makefile');
        continue;
      }
      if (exe === 'git' && ['commit', 'merge', 'push', 'rebase', 'checkout', 'switch', 'am', 'pull', 'cherry-pick'].includes(args.find((a) => !a.startsWith('-')) ?? '')) {
        add('.pre-commit-config.yaml', 'git hooks (pre-commit)');
        for (const p of all) if (/^(\.husky|\.githooks)\//.test(p)) add(p, 'git hook');
        continue;
      }
      if (['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd'].includes(exe)) {
        const script = fileArgs.find((a) => /\.(sh|ps1|bat|cmd)$/i.test(a));
        if (script) add(script, `script run by ${exe}`);
        continue;
      }
      // Console entry points declared by the project (e.g. `flask`) run the project's package.
      const pyproject = ws.read('pyproject.toml') ?? '';
      const ep = pyproject.match(new RegExp(`^\\s*${exe.replace(/[^\w-]/g, '')}\\s*=\\s*["']([\\w.]+)`, 'm'));
      if (ep) {
        const mod = ep[1].split('.').join('/');
        for (const p of all) if (p.endsWith(`${mod}.py`) || p.endsWith(`${mod}/__init__.py`)) addWithImports(p, `\`${exe}\` entry point (${ep[1]})`);
        continue;
      }
      // Direct script execution (./run.sh, scripts/x.py).
      const direct = fileArgs.length ? [exe, ...fileArgs] : [exe];
      for (const a of [seg[0].replace(/\\/g, '/').replace(/^\.\//, ''), ...direct]) if (all.has(a)) addWithImports(a, 'executed directly');
    }
  };
  visit(command, 0);
  return set;
}

export interface Effect {
  kind: 'network' | 'process' | 'dynamic-code' | 'filesystem' | 'environment';
  evidence: string;
}

const EFFECTS: [RegExp, Effect['kind']][] = [
  [/\b(requests|httpx|urllib\d?|http\.client|aiohttp|socket|smtplib|ftplib)\b|\bfetch\(|\baxios\b|\bXMLHttpRequest\b|\bhttps?\.(request|get)\(|\bnet\.connect\b|\bcurl\b|\bwget\b|Invoke-WebRequest/, 'network'],
  [/\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\b|\bchild_process\b|\bexecSync\(|\bspawn\(|\bStart-Process\b/, 'process'],
  [/\beval\(|\bexec\(|\b__import__\(|\bcompile\(|\bnew Function\(|\bimportlib\.import_module\(|\bmarshal\.loads\(|\bpickle\.loads\(|\bbase64\.b64decode\(/, 'dynamic-code'],
  [/\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir)\b|\bfs\.(rm|unlink|rmdir)\w*\(|\brm\s+-rf\b|\bRemove-Item\b/, 'filesystem'],
  [/\bos\.environ\b|\bprocess\.env\b|\bgetenv\(/, 'environment'],
];

/** What a piece of (agent-written) code can do when executed. */
export function effectsOf(code: string): Effect[] {
  const out: Effect[] = [];
  for (const line of code.split(/\r?\n/)) {
    const l = line.replace(/#.*$|\/\/.*$/, '');
    for (const [re, kind] of EFFECTS) {
      if (re.test(l) && !out.some((e) => e.kind === kind)) out.push({ kind, evidence: line.trim().slice(0, 120) });
    }
  }
  return out;
}

export interface ExecutionReview {
  /** Agent-modified files the command will execute. */
  modified: { path: string; why: string; config: boolean; effects: Effect[] }[];
  /** Content hashes the approval is bound to. */
  binding: Record<string, string>;
  risk: 'none' | 'medium' | 'high';
  reasons: string[];
}

/**
 * @param agentWrites path → code the agent added to that file in this conversation (for effect analysis)
 */
export function reviewExecution(command: string, ws: WorkspaceView, agentWrites: Map<string, string>): ExecutionReview {
  const set = resolveExecutionSet(command, ws);
  const modified: ExecutionReview['modified'] = [];
  const binding: Record<string, string> = {};
  for (const [p, added] of agentWrites) {
    if (!set.files.has(p)) continue;
    const cur = ws.read(p);
    if (cur !== undefined) binding[p] = sha(cur);
    modified.push({ path: p, why: set.why.get(p) ?? '', config: EXEC_CONFIG.test(p), effects: effectsOf(added) });
  }
  const reasons: string[] = [];
  let risk: ExecutionReview['risk'] = 'none';
  if (modified.length) {
    risk = 'medium';
    reasons.push(`runs code the agent wrote: ${modified.map((m) => m.path).join(', ')}`);
    for (const m of modified) {
      if (m.config) {
        risk = 'high';
        reasons.push(`${m.path} was modified by the agent and is executed automatically (${m.why})`);
      }
      for (const e of m.effects) {
        if (e.kind !== 'environment' || m.effects.some((x) => x.kind === 'network')) risk = 'high';
        reasons.push(`agent-written code in ${m.path} has ${e.kind} effects: ${e.evidence}`);
      }
    }
  }
  return { modified, binding, risk, reasons };
}

/** Workspace as it is on disk now: given files plus build/test/hook config the code index may skip. */
export function diskView(root: string, files: Iterable<string>): WorkspaceView {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  const read = (rel: string) => {
    try {
      return fs.readFileSync(p.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const set = new Set(files);
  for (const extra of ['Makefile', 'makefile', 'GNUmakefile', '.envrc', 'package.json', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', 'conftest.py', '.pre-commit-config.yaml']) {
    if (root && fs.existsSync(p.join(root, extra))) set.add(extra);
  }
  return { files: () => [...set], read };
}

/**
 * Use-time re-derivation: recomputes, immediately before the process is spawned, which
 * agent-written files the command will execute, and compares with what the user approved.
 * Catches (a) bound files whose content changed and (b) agent-written files that entered the
 * execution set after approval (e.g. a conftest.py the agent created later).
 */
export function verifyAtUse(
  command: string,
  ws: WorkspaceView,
  agentWrites: Map<string, string>,
  approved: Record<string, string>,
): { ok: boolean; changed: string[]; added: string[] } {
  const now = reviewExecution(command, ws, agentWrites);
  const changed = Object.entries(approved)
    .filter(([path, h]) => {
      const cur = ws.read(path);
      return cur === undefined || sha(cur) !== h;
    })
    .map(([path]) => path);
  const added = now.modified.map((m) => m.path).filter((path) => !(path in approved));
  return { ok: !changed.length && !added.length, changed, added };
}

/** Cheap fingerprint of files (mtime+size) to find what a command modified. */
export function fingerprint(root: string, files: Iterable<string>): Map<string, string> {
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  const out = new Map<string, string>();
  for (const f of files) {
    try {
      const st = fs.statSync(p.join(root, f));
      if (st.isFile()) out.set(f, `${st.mtimeMs}:${st.size}`);
    } catch {
      /* missing */
    }
  }
  return out;
}

/** True if every bound file still has the hash it had when the command was approved. */
export function bindingHolds(binding: Record<string, string>, read: (path: string) => string | undefined): { ok: boolean; changed: string[] } {
  const changed = Object.entries(binding)
    .filter(([p, h]) => {
      const cur = read(p);
      return cur === undefined || sha(cur) !== h;
    })
    .map(([p]) => p);
  return { ok: !changed.length, changed };
}
