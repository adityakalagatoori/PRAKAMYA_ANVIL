/**
 * Executable intent contract.
 *
 * Before changing code, the agent compiles the user's request into typed, machine-checkable
 * clauses ("`flask --help` lists `config`", "tests/test_cli.py passes", "docs mention `flask
 * config`", "tests/conftest.py is not modified"). The user approves the contract (including the
 * exact commands its checks will run). Then:
 *  - every edit is tied to the clauses it serves (`clauses` argument of edit_file/create_file);
 *  - negative-scope clauses are enforced at the write gate (a forbidden edit never reaches review);
 *  - file/symbol clauses are re-evaluated live after each accepted or rejected hunk;
 *  - the run cannot finish while a required clause fails: the harness withholds completion and
 *    hands the agent the failing checks' output (at most twice), then reports the final state.
 * Pure: command execution, file reads and symbol lookup are injected.
 */

export type Check =
  | { type: 'command_succeeds'; command: string }
  | { type: 'command_output'; command: string; pattern: string; absent?: boolean }
  | { type: 'file_contains'; path: string; pattern: string; absent?: boolean }
  | { type: 'symbol_exists'; name: string }
  | { type: 'not_modified'; path_glob: string };

export interface Clause {
  id: string;
  text: string;
  check: Check;
  required: boolean;
}

export type ClauseState = 'pending' | 'pass' | 'fail';

export interface ClauseResult {
  id: string;
  state: ClauseState;
  detail: string;
}

export interface Contract {
  clauses: Clause[];
  results: Map<string, ClauseResult>;
  /** Hunk-level traceability: clause id → files/edits that claimed to serve it. */
  servedBy: Map<string, string[]>;
  /**
   * Verifier integrity: the files the approved check commands execute, pinned at approval.
   * "config" verifiers (conftest.py, pytest/tox/npm config, scripts) must stay byte-identical;
   * "test" verifiers may only grow (existing lines kept), so a check cannot be passed by weakening it.
   */
  verifiers?: Map<string, { role: 'config' | 'test'; text: string; clauses: string[] }>;
}

import { EXEC_CONFIG, WorkspaceView, resolveExecutionSet } from '../security/execution';

const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*\.(test|spec)\.[cm]?[jt]sx?)$/;

/** Pins every config/test file the contract's commands execute (called when the user approves it). */
export function pinVerifiers(c: Contract, ws: WorkspaceView) {
  const pins = new Map<string, { role: 'config' | 'test'; text: string; clauses: string[] }>();
  for (const cl of c.clauses) {
    if (cl.check.type !== 'command_succeeds' && cl.check.type !== 'command_output') continue;
    const set = resolveExecutionSet(cl.check.command, ws);
    for (const p of set.files) {
      const role = EXEC_CONFIG.test(p) ? 'config' : TEST_FILE.test(p) ? 'test' : undefined;
      if (!role) continue;
      const text = ws.read(p);
      if (text === undefined) continue;
      const prev = pins.get(p);
      if (prev) prev.clauses.push(cl.id);
      else pins.set(p, { role, text: text.replace(/\r\n/g, '\n'), clauses: [cl.id] });
    }
  }
  c.verifiers = pins;
}

/** Original lines (non-blank) that are no longer present in `current` (multiset semantics). */
function removedLines(original: string, current: string): string[] {
  const have = new Map<string, number>();
  for (const l of current.replace(/\r\n/g, '\n').split('\n')) {
    const k = l.trim();
    if (k) have.set(k, (have.get(k) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const l of original.split('\n')) {
    const k = l.trim();
    if (!k) continue;
    const n = have.get(k) ?? 0;
    if (n > 0) have.set(k, n - 1);
    else out.push(k);
  }
  return out;
}

/** Verifier files whose integrity is broken in the current workspace. */
export function verifierViolations(c: Contract, read: (p: string) => string | undefined): { path: string; clauses: string[]; detail: string }[] {
  const out: { path: string; clauses: string[]; detail: string }[] = [];
  for (const [p, v] of c.verifiers ?? []) {
    const cur = read(p);
    if (cur === undefined) {
      out.push({ path: p, clauses: v.clauses, detail: `${p} (a file the approved check runs) was deleted` });
      continue;
    }
    if (v.role === 'config') {
      if (cur.replace(/\r\n/g, '\n') !== v.text) out.push({ path: p, clauses: v.clauses, detail: `${p} (test/build configuration the check runs) was modified` });
    } else {
      const gone = removedLines(v.text, cur);
      if (gone.length) out.push({ path: p, clauses: v.clauses, detail: `existing test code in ${p} was changed or removed (e.g. "${gone[0].slice(0, 80)}") — tests may be added, not weakened` });
    }
  }
  return out;
}

/** Write-gate check: would this proposed content break a pinned verifier? */
export function verifierWriteViolation(c: Contract | undefined, rel: string, proposed: string): string | undefined {
  const v = c?.verifiers?.get(rel);
  if (!v) return undefined;
  if (v.role === 'config') return `${rel} is executed by the approved checks (${v.clauses.join(', ')}); changing it could make them pass without the behaviour being right`;
  const gone = removedLines(v.text, proposed);
  return gone.length ? `this edit changes or removes existing test code in ${rel} ("${gone[0].slice(0, 80)}"), which the approved checks (${v.clauses.join(', ')}) rely on; add new tests instead of altering existing ones` : undefined;
}

export interface ContractEnv {
  run(command: string): Promise<{ code: number | null; output: string }>;
  read(path: string): string | undefined;
  symbolExists(name: string): boolean;
  /** Files the agent modified in this run. */
  modified(): string[];
}

export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?');
  return new RegExp('^' + re + '$', 'i');
}

const safeRe = (p: string) => {
  try {
    return new RegExp(p, 'i');
  } catch {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
};

/** Validates and normalises clauses proposed by the model. */
export function parseContract(raw: unknown): { contract?: Contract; error?: string } {
  const list = (raw as any)?.clauses;
  if (!Array.isArray(list) || !list.length) return { error: 'clauses must be a non-empty array' };
  if (list.length > 20) return { error: 'at most 20 clauses' };
  const clauses: Clause[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] ?? {};
    const ck = c.check ?? {};
    const id = String(c.id ?? `C${i + 1}`).slice(0, 12);
    const text = String(c.text ?? '').slice(0, 300);
    let check: Check | undefined;
    switch (ck.type) {
      case 'command_succeeds':
        if (ck.command) check = { type: 'command_succeeds', command: String(ck.command) };
        break;
      case 'command_output':
        if (ck.command && ck.pattern) check = { type: 'command_output', command: String(ck.command), pattern: String(ck.pattern), absent: !!ck.absent };
        break;
      case 'file_contains':
        if (ck.path && ck.pattern) check = { type: 'file_contains', path: String(ck.path).replace(/\\/g, '/').replace(/^\.\//, ''), pattern: String(ck.pattern), absent: !!ck.absent };
        break;
      case 'symbol_exists':
        if (ck.name) check = { type: 'symbol_exists', name: String(ck.name) };
        break;
      case 'not_modified':
        if (ck.path_glob) check = { type: 'not_modified', path_glob: String(ck.path_glob) };
        break;
    }
    if (!check) return { error: `clause ${id}: invalid check ${JSON.stringify(ck).slice(0, 200)}` };
    if (!text) return { error: `clause ${id}: text is required` };
    clauses.push({ id, text, check, required: c.required !== false });
  }
  const ids = new Set(clauses.map((c) => c.id));
  if (ids.size !== clauses.length) return { error: 'clause ids must be unique' };
  return { contract: { clauses, results: new Map(clauses.map((c) => [c.id, { id: c.id, state: 'pending', detail: '' }])), servedBy: new Map() } };
}

export function contractCommands(c: Contract): string[] {
  return [...new Set(c.clauses.flatMap((x) => (x.check.type === 'command_succeeds' || x.check.type === 'command_output' ? [x.check.command] : [])))];
}

/** Negative-scope clause that forbids writing `path`, if any. */
export function forbiddenBy(c: Contract | undefined, path: string): Clause | undefined {
  return c?.clauses.find((x) => x.check.type === 'not_modified' && globToRegExp(x.check.path_glob).test(path));
}

export async function evaluate(c: Contract, env: ContractEnv, opts: { commands: boolean }): Promise<ClauseResult[]> {
  const out: ClauseResult[] = [];
  for (const cl of c.clauses) {
    const k = cl.check;
    let r: ClauseResult = { id: cl.id, state: 'pending', detail: '' };
    if (k.type === 'file_contains') {
      const t = env.read(k.path);
      const hit = t !== undefined && safeRe(k.pattern).test(t);
      r = t === undefined && !k.absent ? { id: cl.id, state: 'fail', detail: `${k.path} does not exist` } : { id: cl.id, state: hit !== !!k.absent ? 'pass' : 'fail', detail: `${k.path} ${hit ? 'matches' : 'does not match'} /${k.pattern}/` };
    } else if (k.type === 'symbol_exists') {
      const ok = env.symbolExists(k.name);
      r = { id: cl.id, state: ok ? 'pass' : 'fail', detail: ok ? `${k.name} is defined` : `${k.name} is not defined anywhere` };
    } else if (k.type === 'not_modified') {
      const re = globToRegExp(k.path_glob);
      const bad = env.modified().filter((p) => re.test(p));
      r = { id: cl.id, state: bad.length ? 'fail' : 'pass', detail: bad.length ? `modified: ${bad.join(', ')}` : `nothing matching ${k.path_glob} was modified` };
    } else if (opts.commands) {
      const res = await env.run(k.command);
      const tail = res.output.length > 1500 ? '…' + res.output.slice(-1500) : res.output;
      if (k.type === 'command_succeeds') r = { id: cl.id, state: res.code === 0 ? 'pass' : 'fail', detail: `\`${k.command}\` exited ${res.code}${res.code === 0 ? '' : '\n' + tail}` };
      else {
        const hit = safeRe(k.pattern).test(res.output);
        r = { id: cl.id, state: hit !== !!k.absent ? 'pass' : 'fail', detail: `\`${k.command}\` output ${hit ? 'matches' : 'does not match'} /${k.pattern}/${hit !== !!k.absent ? '' : '\n' + tail}` };
      }
    } else r = c.results.get(cl.id) ?? r; // command checks keep their last result between edits
    // Verifier integrity outranks the exit code: a check that passes because its own test or
    // configuration was altered does not count.
    const broken = verifierViolations(c, env.read).filter((v) => v.clauses.includes(cl.id));
    if (broken.length) r = { id: cl.id, state: 'fail', detail: `verifier changed: ${broken.map((b) => b.detail).join('; ')}` };
    c.results.set(cl.id, r);
    out.push(r);
  }
  return out;
}

export function failing(c: Contract): Clause[] {
  return c.clauses.filter((x) => x.required && c.results.get(x.id)?.state !== 'pass');
}

export function contractCard(c: Contract) {
  return c.clauses.map((x) => ({ id: x.id, text: x.text, type: x.check.type, required: x.required, state: c.results.get(x.id)?.state ?? 'pending', detail: c.results.get(x.id)?.detail ?? '', servedBy: c.servedBy.get(x.id) ?? [] }));
}

export function describeCheck(k: Check): string {
  switch (k.type) {
    case 'command_succeeds':
      return `\`${k.command}\` exits 0`;
    case 'command_output':
      return `\`${k.command}\` output ${k.absent ? 'does not match' : 'matches'} /${k.pattern}/`;
    case 'file_contains':
      return `${k.path} ${k.absent ? 'does not contain' : 'contains'} /${k.pattern}/`;
    case 'symbol_exists':
      return `${k.name} is defined`;
    case 'not_modified':
      return `nothing matching ${k.path_glob} is modified`;
  }
}

export function finishGateMessage(c: Contract, round: number): string {
  const lines = failing(c).map((x) => `- ${x.id} "${x.text}" — ${describeCheck(x.check)}\n  ${(c.results.get(x.id)?.detail ?? 'not checked').split('\n').join('\n  ')}`);
  return [
    `Anvil finish gate (${round}/2): you tried to finish, but the intent contract the user approved is not yet satisfied:`,
    ...lines,
    'Fix what is needed (read the output above), then finish. If a clause cannot be satisfied, explain exactly why in your final message.',
  ].join('\n');
}
