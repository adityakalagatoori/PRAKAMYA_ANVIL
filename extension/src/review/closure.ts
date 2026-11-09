import { Hunk, applyHunks } from './diff';
import { pythonBindings, pythonCode } from './grounding';

/**
 * Acceptance closure for per-hunk review.
 *
 * Per-hunk review lets a person assemble a version of the file that nobody (not the model, not
 * the tests) ever produced: accept hunk 3 (which calls `_mask`) but reject hunk 1 (which defines
 * it). This module derives the dependency relation between the hunks of one proposal and
 * evaluates the *exact* subset a person is about to leave on disk, so the review can
 *  - offer the required closure when a hunk is accepted (applied atomically as one edit),
 *  - show what breaks before a rejection is committed (counterfactual check), and
 *  - report to the agent any names the final accepted subset leaves undefined.
 * Pure (no vscode). Python and JS/TS get name analysis; other files fall back to "no dependencies".
 */

type Lang = 'python' | 'js' | 'other';

export function langOf(path: string): Lang {
  if (/\.pyi?$/.test(path)) return 'python';
  if (/\.[cm]?[jt]sx?$/.test(path)) return 'js';
  return 'other';
}

const PY_BUILTIN = new Set(
  'True False None self cls print len range str int float bool dict list set tuple type object super isinstance issubclass getattr setattr hasattr open sorted reversed enumerate zip map filter any all min max sum abs repr hash id iter next format vars dir callable property staticmethod classmethod Exception ValueError TypeError KeyError IndexError RuntimeError AttributeError NotImplementedError ImportError OSError StopIteration __name__ __file__ t'.split(
    ' ',
  ),
);
const PY_KW = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
const JS_KW = new Set(
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set true false null undefined NaN Infinity console Math JSON Object Array String Number Boolean Promise Error Map Set Date RegExp Symbol require module exports process window document globalThis'.split(
    ' ',
  ),
);

function jsCode(text: string): string[] {
  // blank strings/comments (approximate, line structure preserved)
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'));
}

function jsBindings(code: string[]): Set<string> {
  const names = new Set<string>();
  const all = code.join('\n');
  for (const m of all.matchAll(/\b(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of all.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) for (const p of m[1].split(',')) names.add(p.split(':').pop()!.split('=')[0].trim());
  for (const m of all.matchAll(/\bimport\s+([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*(?:\*\s+as\s+([\w$]+))?\s*from/g)) {
    if (m[1]) names.add(m[1]);
    if (m[3]) names.add(m[3]);
    for (const p of (m[2] ?? '').split(',')) {
      const n = p.split(/\s+as\s+/).pop()!.trim();
      if (n) names.add(n);
    }
  }
  for (const m of all.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const p of m[1].split(',')) names.add(p.replace(/[=:].*$/, '').replace(/[.{}[\]\s]/g, ''));
  for (const m of all.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of all.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1]); // methods
  return names;
}

function bindingsOf(lang: Lang, text: string): Set<string> {
  if (lang === 'python') return pythonBindings(pythonCode(text)).names;
  if (lang === 'js') return jsBindings(jsCode(text));
  return new Set();
}

function codeLines(lang: Lang, text: string): string[] {
  return lang === 'python' ? pythonCode(text) : lang === 'js' ? jsCode(text) : [];
}

/** Bare (non-attribute) identifiers referenced in code. */
function refsIn(lang: Lang, lines: string[]): Set<string> {
  const out = new Set<string>();
  const kw = lang === 'python' ? PY_KW : JS_KW;
  for (const l of lines) {
    if (lang === 'python' && /^\s*(from|import)\s/.test(l)) continue;
    if (lang === 'js' && /^\s*import\s/.test(l)) continue;
    for (const m of l.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) if (!kw.has(m[1])) out.add(m[1]);
  }
  return out;
}

function defSigs(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)?/) ?? l.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)?/);
    if (m) out.set(m[1], m[2].replace(/\s+/g, ''));
  }
  return out;
}

export interface HunkGraph {
  /** requires.get(b) = hunks that must also be applied for hunk b to make sense. */
  requires: Map<number, Set<number>>;
  /** Human-readable reason per edge "b->a". */
  why: Map<string, string>;
}

export function hunkGraph(path: string, original: string, hunks: Hunk[]): HunkGraph {
  const lang = langOf(path);
  const g: HunkGraph = { requires: new Map(), why: new Map() };
  if (lang === 'other' || hunks.length < 2) return g;
  const origBound = bindingsOf(lang, original);
  const info = hunks.map((h) => {
    const newCode = codeLines(lang, h.newLines.join('\n'));
    const oldCode = codeLines(lang, h.origLines.join('\n'));
    const newB = bindingsOf(lang, h.newLines.join('\n'));
    const oldB = bindingsOf(lang, h.origLines.join('\n'));
    return {
      h,
      introduces: new Set([...newB].filter((n) => !oldB.has(n) && !origBound.has(n))),
      removes: new Set([...oldB].filter((n) => !newB.has(n))),
      uses: refsIn(lang, newCode),
      usedBefore: refsIn(lang, oldCode),
      sigOld: defSigs(h.origLines),
      sigNew: defSigs(h.newLines),
    };
  });
  const edge = (b: number, a: number, why: string) => {
    if (a === b) return;
    const s = g.requires.get(b) ?? new Set();
    s.add(a);
    g.requires.set(b, s);
    if (!g.why.has(`${b}->${a}`)) g.why.set(`${b}->${a}`, why);
  };
  for (const B of info) {
    for (const A of info) {
      if (A === B) continue;
      // B uses a name that only A introduces.
      for (const n of B.uses) if (A.introduces.has(n) && !B.introduces.has(n)) edge(B.h.index, A.h.index, `uses ${n}, which hunk ${A.h.index + 1} defines`);
      // A removes/renames a name; B removes (rewrites) uses of it → applying A alone leaves those uses dangling.
      for (const n of A.removes) if (B.usedBefore.has(n) && !B.uses.has(n)) edge(A.h.index, B.h.index, `removes ${n}; hunk ${B.h.index + 1} updates code that used it`);
      // A changes a signature; B rewrites a call to it → they only make sense together.
      for (const [name, sig] of A.sigOld) {
        const now = A.sigNew.get(name);
        if (now !== undefined && now !== sig && (B.uses.has(name) || B.usedBefore.has(name))) {
          edge(A.h.index, B.h.index, `changes the signature of ${name}; hunk ${B.h.index + 1} updates a call`);
          edge(B.h.index, A.h.index, `calls ${name} with the signature hunk ${A.h.index + 1} introduces`);
        }
      }
    }
  }
  return g;
}

/** Transitive closure of `requires` from `start`, restricted to `among`. */
export function closureOf(g: HunkGraph, start: number[], among: Set<number>): Set<number> {
  const out = new Set<number>();
  const stack = [...start];
  while (stack.length) {
    const x = stack.pop()!;
    for (const y of g.requires.get(x) ?? []) if (among.has(y) && !out.has(y) && !start.includes(y)) {
      out.add(y);
      stack.push(y);
    }
  }
  return out;
}

/** Hunks (within `among`) that transitively require any of `targets`. */
export function dependentsOf(g: HunkGraph, targets: number[], among: Set<number>): Set<number> {
  const out = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of among) {
      if (out.has(b) || targets.includes(b)) continue;
      const req = g.requires.get(b);
      if (req && [...req].some((a) => targets.includes(a) || out.has(a))) {
        out.add(b);
        grew = true;
      }
    }
  }
  return out;
}

export interface Dangling {
  name: string;
  line: number;
}

/**
 * Counterfactual check of one exact subset: names the file would reference but no longer define,
 * that the original or the full proposal did define. (A name never defined anywhere in the file
 * is the admission check's business, not a partial-acceptance problem.)
 */
export function danglingNames(path: string, original: string, hunks: Hunk[], subset: Set<number>): Dangling[] {
  const lang = langOf(path);
  if (lang === 'other') return [];
  const all = new Set(hunks.map((h) => h.index));
  const full = applyHunks(original, hunks, all);
  const text = applyHunks(original, hunks, subset);
  const local = new Set([...bindingsOf(lang, original), ...bindingsOf(lang, full)]);
  const bound = bindingsOf(lang, text);
  const builtin = lang === 'python' ? PY_BUILTIN : JS_KW;
  const out: Dangling[] = [];
  const seen = new Set<string>();
  codeLines(lang, text).forEach((l, i) => {
    for (const n of refsIn(lang, [l])) {
      if (seen.has(n) || builtin.has(n) || bound.has(n) || !local.has(n)) continue;
      seen.add(n);
      out.push({ name: n, line: i + 1 });
    }
  });
  return out;
}
