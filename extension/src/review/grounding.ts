import { CodeIndex } from '../context/index';
import { ObservationLedger } from '../context/observation';
import { computeHunks, hunkStartIn } from './diff';

/**
 * Observation-grounded admission check for a proposed edit, run before the hunk reaches the human.
 *
 *  - Grounding: every program name the new code relies on must be backed by something the model
 *    actually saw in this conversation (and that is still current), be defined by the change
 *    itself, or be a language builtin. Otherwise it is "unread" (exists in the repo, never shown),
 *    "stale" (the model saw an older version of its definition) or "unknown" (exists nowhere:
 *    likely hallucinated).
 *  - Blind spots: for every function whose signature the change alters or removes, the call sites,
 *    tests and docs that reference it which the model has not seen.
 *
 * Pure (no vscode). Python gets the full analysis; other languages get blind-spot analysis only
 * when Python-style definitions are present (i.e. none), so they pass through untouched.
 */

export type IssueKind = 'unknown' | 'stale' | 'unread';

export interface GroundingIssue {
  kind: IssueKind;
  name: string;
  /** 1-based line in the proposed file where the name is used. */
  line: number;
  detail: string;
  /** Where the definition lives (for unread/stale), so the harness can show it to the model. */
  def?: { path: string; line: number };
}

export interface BlindSpot {
  symbol: string;
  change: 'signature' | 'removed';
  path: string;
  line: number;
  text: string;
  relation: 'caller' | 'test' | 'docs';
}

export interface AdmissionReport {
  language: 'python' | 'other';
  checked: number;
  grounded: number;
  issues: GroundingIssue[];
  blindSpots: BlindSpot[];
  /** References to changed signatures that the model had seen. */
  seenReferences: number;
}

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print'.split(' '),
);
const PY_BUILTINS = new Set(
  (
    'abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ ' +
    'BaseException Exception ArithmeticError AssertionError AttributeError BlockingIOError BrokenPipeError BufferError ConnectionError EOFError EnvironmentError FileExistsError FileNotFoundError FloatingPointError GeneratorExit ImportError IndentationError IndexError InterruptedError IOError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError NotADirectoryError NotImplemented NotImplementedError OSError OverflowError PermissionError ProcessLookupError RecursionError ReferenceError RuntimeError StopAsyncIteration StopIteration SyntaxError SystemError SystemExit TabError TimeoutError TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError ValueError Warning DeprecationWarning UserWarning RuntimeWarning FutureWarning ZeroDivisionError Ellipsis self cls __name__ __file__ __class__'
  ).split(' '),
);
/** Method names too generic to say anything about grounding (dict.get, str.join, click's decorators…). */
const GENERIC_ATTRS = new Set(
  'get set items keys values append extend insert remove pop clear copy update setdefault add discard join split rsplit strip lstrip rstrip replace format lower upper title startswith endswith encode decode read write readline readlines close open seek flush find index count sort sorted reverse run send call invoke echo secho command option argument group fixture parametrize raises mark exit exists is_file is_dir mkdir resolve sub match search compile dumps loads dump load isoformat total_seconds'.split(
    ' ',
  ),
);

/** Python source with comments removed and string contents blanked (line structure preserved). */
export function pythonCode(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let q: string | null = null; // quote char
  let triple = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (q) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (triple ? text.startsWith(q.repeat(3), i) : ch === q) {
        cur += q;
        i += triple ? 3 : 1;
        q = null;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      triple = text.startsWith(ch.repeat(3), i);
      q = ch;
      cur += ch;
      i += triple ? 3 : 1;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out;
}

const word = (n: string) => new RegExp(`(?<![\\w.])${n.replace(/[$]/g, '\\$')}(?!\\w)`);

/** Names bound anywhere in the (masked) Python file: defs, classes, params, assignments, imports, loop/with/except targets. */
export function pythonBindings(code: string[]): { names: Set<string>; star: boolean; imports: { module: string; name: string; line: number }[] } {
  const names = new Set<string>();
  const imports: { module: string; name: string; line: number }[] = [];
  let star = false;
  const all = code.join('\n');
  const addAll = (s: string) => {
    for (const m of s.matchAll(/(?<![.\w])([A-Za-z_]\w*)/g)) names.add(m[1]);
  };
  code.forEach((l) => {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)/))) {
      names.add(m[1]);
      for (const p of m[2].split(',')) {
        const n = p.split(/[:=]/)[0].replace(/\*/g, '').trim();
        if (/^\w+$/.test(n)) names.add(n);
      }
    }
    if ((m = l.match(/^\s*class\s+(\w+)/))) names.add(m[1]);
    for (const a of l.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*(?::[^=\n]+)?(?:[-+*/%&|^@]|\/\/|\*\*|>>|<<)?=(?!=)/g)) names.add(a[1]);
    for (const a of l.matchAll(/\bfor\s+([\w\s,()\[\]*]+?)\s+in\b/g)) addAll(a[1]);
    for (const a of l.matchAll(/\bas\s+(\w+)/g)) names.add(a[1]);
    for (const a of l.matchAll(/\blambda\s+([^:]*):/g)) addAll(a[1]);
    for (const a of l.matchAll(/\b(?:global|nonlocal)\s+([\w\s,]+)/g)) addAll(a[1]);
    if ((m = l.match(/^\s*import\s+(.+)/))) {
      for (const part of m[1].split(',')) {
        const [mod, alias] = part.trim().split(/\s+as\s+/);
        if (mod) names.add((alias ?? mod.split('.')[0]).trim());
      }
    }
  });
  // def lines whose parameter list spans lines
  for (const m of all.matchAll(/\bdef\s+\w+\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const n = p.split(/[:=]/)[0].replace(/\*/g, '').trim();
      if (/^\w+$/.test(n)) names.add(n);
    }
  }
  for (const m of all.matchAll(/^[ \t]*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    const line = all.slice(0, m.index).split('\n').length;
    const body = m[2].replace(/[()]/g, '');
    if (body.trim() === '*') star = true;
    for (const part of body.split(',')) {
      const [nm, alias] = part.trim().split(/\s+as\s+/);
      if (!nm || nm === '*') continue;
      names.add((alias ?? nm).trim());
      imports.push({ module: m[1], name: nm.trim(), line });
    }
  }
  return { names, star, imports };
}

/** Resolves a Python import to a workspace file (`.helpers` relative to `fromPath`, or `flask.helpers`). */
export function resolvePyModule(idx: CodeIndex, fromPath: string, module: string): string | undefined {
  let base: string;
  if (module.startsWith('.')) {
    const dots = module.match(/^\.+/)![0].length;
    const dir = fromPath.split('/').slice(0, -1);
    for (let i = 1; i < dots; i++) dir.pop();
    base = [...dir, ...module.slice(dots).split('.').filter(Boolean)].join('/');
  } else base = module.split('.').join('/');
  const cands = [`${base}.py`, `${base}/__init__.py`];
  for (const c of cands) if (idx.files.has(c)) return c;
  if (!module.startsWith('.')) {
    for (const p of idx.files.keys()) if (cands.some((c) => p.endsWith('/' + c))) return p;
  }
  return undefined;
}

function moduleDefines(text: string, name: string): boolean {
  const n = name.replace(/[$]/g, '\\$');
  return new RegExp(`(^|\\n)\\s*(?:async\\s+)?(?:def|class)\\s+${n}\\b|(^|\\n)${n}\\s*[:=]|\\bimport\\b[^\\n]*\\b${n}\\b|(^|\\n)\\s*${n}\\s*=|__all__[^\\]]*['"]${n}['"]`).test(text);
}

interface DefSig {
  name: string;
  sig: string;
}
/** Defs in `lines`, including signatures that span multiple lines (matched by paren balance, not a single-line regex). */
function defsIn(lines: string[]): DefSig[] {
  const out: DefSig[] = [];
  const text = lines.join('\n');
  for (const m of text.matchAll(/^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    out.push({ name: m[1], sig: text.slice(start, i - 1).replace(/\s+/g, '') });
  }
  return out;
}

export function assessAdmission(
  idx: CodeIndex,
  ledger: ObservationLedger,
  rel: string,
  original: string,
  proposed: string,
  opts: { maxBlindSpots?: number } = {},
): AdmissionReport {
  const report: AdmissionReport = { language: rel.endsWith('.py') ? 'python' : 'other', checked: 0, grounded: 0, issues: [], blindSpots: [], seenReferences: 0 };
  if (report.language !== 'python') return report;
  const hunks = computeHunks(original, proposed);
  if (!hunks.length) return report;
  const shown = new Set(hunks.map((h) => h.index));
  const code = pythonCode(proposed);
  const binds = pythonBindings(code);
  const current = (p: string) => (p === rel ? original : idx.files.get(p)?.text);

  // What the model demonstrably knows: still-valid observations everywhere, plus the text it is
  // replacing (it had to quote it in old_string).
  const known: string[] = [];
  for (const p of ledger.paths()) for (const o of ledger.valid(p, current(p))) known.push(o.text);
  for (const h of hunks) known.push(h.origLines.join('\n'));
  const knownText = known.join('\n');

  // Added lines with their 1-based line numbers in the proposed file.
  const added: { line: number; code: string }[] = [];
  const newDefs = new Set<string>();
  for (const h of hunks) {
    const start = hunkStartIn(hunks, shown, h);
    h.newLines.forEach((_, k) => {
      const ln = start + k;
      added.push({ line: ln + 1, code: code[ln] ?? '' });
    });
    for (const d of defsIn(h.newLines)) newDefs.add(d.name);
    for (const l of h.newLines) {
      const m = l.match(/^\s*class\s+(\w+)/);
      if (m) newDefs.add(m[1]);
    }
  }
  const addedLineSet = new Set(added.map((a) => a.line));

  const seenDef = (name: string): 'seen' | 'stale' | 'unread' | 'absent' => {
    const defs = idx.findSymbol(name).filter((d) => d.name === name);
    if (!defs.length) return 'absent';
    for (const d of defs) {
      const text = current(d.path);
      const defLine = text?.split(/\r?\n/)[d.line - 1] ?? '';
      if (ledger.sawLine(d.path, defLine, text)) return 'seen';
    }
    // An outdated view of the definition outranks having seen the name used somewhere.
    for (const d of defs) if (ledger.stale(d.path, current(d.path)).some((o) => new RegExp(`def\\s+${name}\\b|class\\s+${name}\\b`).test(o.text))) return 'stale';
    if (word(name).test(knownText)) return 'seen';
    return 'unread';
  };
  const flagged = new Set<string>();
  const flag = (kind: IssueKind, name: string, line: number, detail: string, def?: { path: string; line: number }) => {
    if (flagged.has(name)) return;
    flagged.add(name);
    report.issues.push({ kind, name, line, detail, def });
  };

  // 1. Imports added by this change from local modules.
  for (const imp of binds.imports) {
    if (!addedLineSet.has(imp.line)) continue;
    const mod = resolvePyModule(idx, rel, imp.module);
    if (!mod) continue; // third-party / stdlib
    report.checked++;
    const text = current(mod) ?? '';
    if (!moduleDefines(text, imp.name) && !idx.files.has(mod.replace(/__init__\.py$|\.py$/, '') + '/' + imp.name + '.py')) {
      flag('unknown', imp.name, imp.line, `imported from ${imp.module} (${mod}), which defines no "${imp.name}"`);
      continue;
    }
    const s = seenDef(imp.name);
    if (s === 'seen' || s === 'absent') report.grounded++;
    else {
      const d = idx.findSymbol(imp.name).find((x) => x.name === imp.name);
      flag(s, imp.name, imp.line, s === 'stale' ? 'the model saw an older version of this definition' : `defined in ${d?.path}:${d?.line}, never shown to the model`, d && { path: d.path, line: d.line });
    }
  }

  // 2. Calls in the added lines.
  for (const a of added) {
    for (const m of a.code.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)) {
      const n = m[1];
      if (PY_KEYWORDS.has(n) || PY_BUILTINS.has(n) || newDefs.has(n) || flagged.has(n)) continue;
      report.checked++;
      const s = seenDef(n);
      if (s === 'seen') {
        report.grounded++;
        continue;
      }
      if (s === 'absent') {
        if (binds.names.has(n) || binds.star || word(n).test(knownText)) report.grounded++;
        else flag('unknown', n, a.line, 'not defined in this file, not imported, not a builtin and not defined anywhere in the repository');
        continue;
      }
      const d = idx.findSymbol(n).find((x) => x.name === n)!;
      if (d.path === rel && word(n).test(knownText)) {
        report.grounded++;
        continue;
      }
      flag(s, n, a.line, s === 'stale' ? 'the model saw an older version of this definition' : `defined in ${d.path}:${d.line}, never shown to the model`, { path: d.path, line: d.line });
    }
    // 2b. self.X() / cls.X() must resolve to a method of the enclosing class (or anywhere, as a
    // fallback when the class can't be identified). Plain attribute calls on other objects are
    // deliberately left to the generic check below: Anvil has no type information to know what a
    // third-party object's own attributes are.
    for (const m of a.code.matchAll(/\b(?:self|cls)\.([A-Za-z_]\w*)\s*\(/g)) {
      const n = m[1];
      if (n.startsWith('__') || newDefs.has(n) || flagged.has(n)) continue;
      const chunk = idx.chunkAt(rel, a.line);
      const cls = chunk?.symbol?.includes('.') ? chunk.symbol.split('.')[0] : undefined;
      const anyDefs = idx.findSymbol(n).filter((d) => d.name === n && d.kind !== 'section');
      if (cls) {
        const qualified = `${cls}.${n}`;
        const onClass = idx.findSymbol(qualified).some((d) => d.qualified.toLowerCase() === qualified.toLowerCase());
        if (onClass) continue;
      } else if (anyDefs.length) continue; // can't tell the class, but the method exists somewhere
      if (anyDefs.length) continue; // exists on some other class: let the generic check below judge it
      report.checked++;
      flag('unknown', n, a.line, `no method "${n}" exists${cls ? ` on ${cls}` : ''} or anywhere in the repository`);
    }
    for (const m of a.code.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) {
      const n = m[1];
      if (n.length < 4 || GENERIC_ATTRS.has(n) || n.startsWith('__') || newDefs.has(n) || flagged.has(n)) continue;
      const defs = idx.findSymbol(n).filter((d) => d.name === n && d.kind !== 'section');
      if (!defs.length) continue; // third-party API: nothing to check against
      report.checked++;
      const s = seenDef(n);
      if (s === 'seen') report.grounded++;
      else flag(s === 'absent' ? 'unread' : s, n, a.line, s === 'stale' ? 'the model saw an older version of this method' : `method defined in ${defs[0].path}:${defs[0].line}, never shown to the model`, { path: defs[0].path, line: defs[0].line });
    }
  }

  // 3. Blind spots: references to functions whose signature changed or that were removed.
  const before = new Map(defsIn(hunks.flatMap((h) => h.origLines)).map((d) => [d.name, d.sig]));
  const afterAll = new Map(defsIn(proposed.split(/\r?\n/)).map((d) => [d.name, d.sig]));
  const changed: { name: string; change: 'signature' | 'removed' }[] = [];
  for (const [name, sig] of before) {
    if (!afterAll.has(name)) changed.push({ name, change: 'removed' });
    else if (afterAll.get(name) !== sig) changed.push({ name, change: 'signature' });
  }
  const max = opts.maxBlindSpots ?? 12;
  for (const c of changed) {
    const callRe = new RegExp(`(?<![\\w])${c.name}\\s*\\(|\\.${c.name}\\b`);
    const docRe = new RegExp(`\\b${c.name}\\b`);
    const scan = (path: string, text: string, skipLines?: Set<number>) => {
      const lines = text.split(/\r?\n/);
      const isDoc = /\.(rst|md|markdown)$/i.test(path);
      lines.forEach((l, i) => {
        if (report.blindSpots.length >= max) return;
        if (skipLines?.has(i + 1)) return;
        if (!(isDoc ? docRe : callRe).test(l) || /^\s*(async\s+)?def\s/.test(l)) return;
        if (ledger.sawLine(path, l, current(path) ?? text)) {
          report.seenReferences++;
          return;
        }
        report.blindSpots.push({ symbol: c.name, change: c.change, path, line: i + 1, text: l.trim().slice(0, 160), relation: isDoc ? 'docs' : /(^|\/)tests?\/|test_/.test(path) ? 'test' : 'caller' });
      });
    };
    // Other lines of the edited file (the model's own new lines are excluded).
    scan(rel, proposed, addedLineSet);
    for (const f of idx.files.values()) if (f.path !== rel) scan(f.path, f.text);
  }
  return report;
}

export function admissionSummary(r: AdmissionReport): string {
  if (r.language !== 'python') return '';
  const refs = r.seenReferences + r.blindSpots.length;
  return `Grounding: ${r.grounded}/${r.checked} names backed by code the model saw` + (refs ? ` · callers of changed signatures seen ${r.seenReferences}/${refs}` : '');
}

/** True if the report should hold the edit back for the agent to re-check before human review. */
export function shouldHold(r: AdmissionReport): boolean {
  return r.issues.length > 0 || r.blindSpots.length > 0;
}
