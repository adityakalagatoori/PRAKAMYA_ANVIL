import { Bm25, tokenize } from './bm25';
import { Chunk, SymbolDef, chunkFile } from './chunker';

export interface IndexedFile {
  path: string;
  text: string;
  chunkIds: number[];
  symbols: SymbolDef[];
  imports: string[]; // module-ish names imported (python: "flask.cli", ".helpers")
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * In-memory code index: chunks + BM25 + symbol table + import graph.
 * Pure (no vscode), so it is unit-tested directly against the flask repository.
 */
export class CodeIndex {
  files = new Map<string, IndexedFile>();
  chunks: Chunk[] = [];
  private bm25 = new Bm25();
  private chunkDoc: number[] = []; // chunk id -> bm25 doc id
  private docChunk: number[] = []; // bm25 doc id -> chunk id
  symbols = new Map<string, SymbolDef[]>(); // lowercased short + qualified name -> defs

  static build(files: { path: string; text: string }[]): CodeIndex {
    const idx = new CodeIndex();
    for (const f of files) idx.addFile(f.path, f.text);
    return idx;
  }

  private addFile(path: string, text: string) {
    const { chunks, symbols } = chunkFile(path, text);
    const ids: number[] = [];
    const pathTokens = tokenize(path.replace(/\.[a-z]+$/i, ''));
    for (const c of chunks) {
      const id = this.chunks.length;
      const chunk: Chunk = { ...c, id };
      this.chunks.push(chunk);
      // Path and symbol tokens are repeated so they weigh more than body text.
      const symTokens = c.symbol ? tokenize(c.symbol) : [];
      const doc = this.bm25.add([...pathTokens, ...pathTokens, ...symTokens, ...symTokens, ...symTokens, ...tokenize(c.text)]);
      this.chunkDoc[id] = doc;
      this.docChunk[doc] = id;
      ids.push(id);
    }
    for (const s of symbols) {
      for (const key of new Set([s.name.toLowerCase(), s.qualified.toLowerCase()])) {
        const arr = this.symbols.get(key) ?? [];
        arr.push(s);
        this.symbols.set(key, arr);
      }
    }
    this.files.set(path, { path, text, chunkIds: ids, symbols, imports: parseImports(path, text) });
  }

  /** Rebuilds from the current file set (cheap: flask indexes in well under a second). */
  withFile(path: string, text: string | undefined): CodeIndex {
    const files = [...this.files.values()].filter((f) => f.path !== path).map((f) => ({ path: f.path, text: f.text }));
    if (text !== undefined) files.push({ path, text });
    return CodeIndex.build(files);
  }

  search(queryText: string): { chunk: Chunk; score: number; matched: string[] }[] {
    const q = tokenize(queryText);
    if (!q.length) return [];
    return this.bm25
      .score(q)
      .map((r) => ({ chunk: this.chunks[this.docChunk[r.doc]], score: r.score, matched: r.matched }))
      .sort((a, b) => b.score - a.score);
  }

  idf(term: string) {
    return this.bm25.idf(term);
  }

  findSymbol(name: string): SymbolDef[] {
    const key = name.toLowerCase().replace(/\(\)$/, '');
    const exact = this.symbols.get(key);
    if (exact?.length) return exact;
    const out: SymbolDef[] = [];
    for (const [k, defs] of this.symbols) if (k.endsWith('.' + key) || k.includes(key)) out.push(...defs);
    return out.slice(0, 20);
  }

  chunkAt(path: string, line: number): Chunk | undefined {
    const f = this.files.get(path);
    if (!f) return undefined;
    let best: Chunk | undefined;
    for (const id of f.chunkIds) {
      const c = this.chunks[id];
      if (c.startLine <= line && line <= c.endLine) {
        if (!best || c.endLine - c.startLine < best.endLine - best.startLine) best = c;
      }
    }
    return best;
  }
}

function parseImports(path: string, text: string): string[] {
  if (!path.endsWith('.py')) return [];
  const out = new Set<string>();
  const re = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1] ?? m[2]);
  return [...out];
}
