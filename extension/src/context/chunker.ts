/**
 * Splits source files into retrieval units ("chunks").
 *  - Python: one chunk per top-level def/class and per method (decorators attached),
 *    module-level code between definitions becomes "module" chunks.
 *  - Markdown / reStructuredText: one chunk per section (heading to next heading).
 *  - Everything else: fixed 60-line windows.
 * Oversized chunks are split into windows so no single chunk can eat the budget.
 */

export interface Chunk {
  id: number;
  path: string; // workspace-relative, forward slashes
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
  symbol?: string; // e.g. "FlaskGroup.list_commands"
  kind: 'function' | 'class' | 'method' | 'module' | 'section' | 'window';
  text: string;
}

export interface SymbolDef {
  name: string; // short name
  qualified: string; // Class.method or name
  path: string;
  line: number; // 1-based
  kind: 'function' | 'class' | 'method' | 'section';
}

const MAX_CHUNK_LINES = 120;
const WINDOW = 60;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function chunkFile(path: string, text: string): { chunks: Omit<Chunk, 'id'>[]; symbols: SymbolDef[] } {
  const lower = path.toLowerCase();
  const lines = splitLines(text);
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) return chunkPython(path, lines);
  if (lower.endsWith('.rst') || lower.endsWith('.md') || lower.endsWith('.markdown')) return chunkDocs(path, lines, lower.endsWith('.rst'));
  return chunkGeneric(path, lines);
}

function windows(path: string, lines: string[], start: number, end: number, base: Partial<Chunk>): Omit<Chunk, 'id'>[] {
  // start/end are 0-based inclusive
  const out: Omit<Chunk, 'id'>[] = [];
  for (let s = start; s <= end; s += WINDOW) {
    const e = Math.min(end, s + WINDOW - 1);
    const text = lines.slice(s, e + 1).join('\n');
    if (!text.trim()) continue;
    out.push({ path, startLine: s + 1, endLine: e + 1, kind: (base.kind as Chunk['kind']) ?? 'window', symbol: base.symbol, text });
  }
  return out;
}

function pushRange(out: Omit<Chunk, 'id'>[], path: string, lines: string[], s: number, e: number, kind: Chunk['kind'], symbol?: string) {
  while (e > s && !lines[e].trim()) e--; // trim trailing blank lines
  if (e < s) return;
  const text = lines.slice(s, e + 1).join('\n');
  if (!text.trim()) return;
  if (e - s + 1 > MAX_CHUNK_LINES) {
    out.push(...windows(path, lines, s, e, { kind, symbol }));
  } else {
    out.push({ path, startLine: s + 1, endLine: e + 1, kind, symbol, text });
  }
}

const PY_DEF = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:\[]/;

function chunkPython(path: string, lines: string[]) {
  const chunks: Omit<Chunk, 'id'>[] = [];
  const symbols: SymbolDef[] = [];
  type B = { line: number; indent: number; name: string; isClass: boolean; qualified: string; kind: Chunk['kind'] };
  const bounds: B[] = [];
  const classStack: { indent: number; name: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = PY_DEF.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    const isClass = /^\s*class\s/.test(lines[i]);
    while (classStack.length && classStack[classStack.length - 1].indent >= indent) classStack.pop();
    const parent = classStack[classStack.length - 1];
    // Only index definitions at module level or directly inside a class (not nested closures).
    const directChildOfClass = parent && indent > parent.indent && indent <= parent.indent + 8;
    if (indent === 0 || directChildOfClass) {
      const qualified = parent && indent > 0 ? `${parent.name}.${m[2]}` : m[2];
      const kind: Chunk['kind'] = isClass ? 'class' : indent > 0 ? 'method' : 'function';
      // attach decorators directly above
      let start = i;
      while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
      bounds.push({ line: start, indent, name: m[2], isClass, qualified, kind });
      symbols.push({ name: m[2], qualified, path, line: i + 1, kind });
    }
    if (isClass) classStack.push({ indent, name: m[2] });
  }

  let cursor = 0;
  for (let b = 0; b < bounds.length; b++) {
    const cur = bounds[b];
    if (cur.line > cursor) pushRange(chunks, path, lines, cursor, cur.line - 1, 'module');
    // A chunk runs until the next boundary. For a class, that means the class header + docstring
    // + attributes up to its first method; methods get their own chunks.
    const next = bounds[b + 1];
    let end = next ? next.line - 1 : lines.length - 1;
    // Stop before any later module-level statement (indent 0) so trailing module code
    // becomes its own "module" chunk instead of being glued onto the previous def/method.
    if (!(cur.isClass && next && next.indent > cur.indent)) {
      for (let k = cur.line + 1; k <= end; k++) {
        if (lines[k].trim() && !/^\s/.test(lines[k]) && !/^[)\]}]/.test(lines[k]) && !/^@/.test(lines[k]) && !PY_DEF.test(lines[k])) {
          end = k - 1;
          break;
        }
      }
    }
    pushRange(chunks, path, lines, cur.line, end, cur.kind, cur.qualified);
    cursor = end + 1;
  }
  if (cursor < lines.length) pushRange(chunks, path, lines, cursor, lines.length - 1, 'module');
  return { chunks, symbols };
}

function chunkDocs(path: string, lines: string[], rst: boolean) {
  const chunks: Omit<Chunk, 'id'>[] = [];
  const symbols: SymbolDef[] = [];
  const heads: { line: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (rst) {
      const next = lines[i + 1];
      if (
        next !== undefined &&
        lines[i].trim() &&
        /^([=\-~^"'`#*+])\1{2,}\s*$/.test(next) &&
        next.trim().length >= lines[i].trim().length &&
        !/^([=\-~^"'`#*+])\1{2,}\s*$/.test(lines[i])
      ) {
        heads.push({ line: i, title: lines[i].trim() });
      }
    } else {
      const m = /^#{1,6}\s+(.*)$/.exec(lines[i]);
      if (m) heads.push({ line: i, title: m[1].trim() });
    }
  }
  if (!heads.length) return { chunks: windows(path, lines, 0, lines.length - 1, { kind: 'window' }), symbols };
  if (heads[0].line > 0) pushRange(chunks, path, lines, 0, heads[0].line - 1, 'section');
  for (let h = 0; h < heads.length; h++) {
    const end = h + 1 < heads.length ? heads[h + 1].line - 1 : lines.length - 1;
    pushRange(chunks, path, lines, heads[h].line, end, 'section', heads[h].title);
    symbols.push({ name: heads[h].title, qualified: heads[h].title, path, line: heads[h].line + 1, kind: 'section' });
  }
  return { chunks, symbols };
}

const GENERIC_DEF =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|func|fn|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/;

function chunkGeneric(path: string, lines: string[]) {
  const symbols: SymbolDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = GENERIC_DEF.exec(lines[i]);
    if (m) symbols.push({ name: m[1], qualified: m[1], path, line: i + 1, kind: /class|struct|interface/.test(lines[i]) ? 'class' : 'function' });
  }
  return { chunks: windows(path, lines, 0, lines.length - 1, { kind: 'window' }), symbols };
}
