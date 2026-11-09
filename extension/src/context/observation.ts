/**
 * Observation ledger: a record of exactly what repository content the model has been shown in
 * this conversation (context packs, read_file, find_symbol, search_code, its own accepted edits,
 * admission-check injections).
 *
 * Observations are stored as small line blocks of verbatim text, so validity is checked by
 * content, not by line number: a block stays valid while its text still occurs in the file
 * (edits elsewhere shift lines without invalidating it) and becomes stale as soon as the file
 * region it showed is changed. Pure (no vscode) so it is unit-tested directly.
 */

export type ObservationSource = 'context' | 'read_file' | 'find_symbol' | 'search_code' | 'own_edit' | 'admission' | 'retrieve_context';

export interface Observation {
  path: string;
  /** 1-based line where the block started when it was observed (informational; validity is by content). */
  line: number;
  text: string;
  source: ObservationSource;
  seq: number;
}

const BLOCK_LINES = 12;
const norm = (s: string) => s.replace(/\r\n/g, '\n');

export class ObservationLedger {
  private byPath = new Map<string, Observation[]>();
  private seq = 0;

  clear() {
    this.byPath.clear();
    this.seq = 0;
  }

  get size(): number {
    let n = 0;
    for (const v of this.byPath.values()) n += v.length;
    return n;
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }

  /** Records that the model saw `text` (lines starting at `startLine`) of `path`. */
  record(path: string, startLine: number, text: string, source: ObservationSource) {
    const lines = norm(text).split('\n');
    const arr = this.byPath.get(path) ?? [];
    for (let i = 0; i < lines.length; i += BLOCK_LINES) {
      const block = lines.slice(i, i + BLOCK_LINES).join('\n');
      if (!block.trim()) continue;
      arr.push({ path, line: startLine + i, text: block, source, seq: ++this.seq });
    }
    this.byPath.set(path, arr);
  }

  /** Records single lines (e.g. grep hits): each line is its own block. */
  recordLines(path: string, hits: { line: number; text: string }[], source: ObservationSource) {
    const arr = this.byPath.get(path) ?? [];
    for (const h of hits) if (h.text.trim()) arr.push({ path, line: h.line, text: norm(h.text), source, seq: ++this.seq });
    this.byPath.set(path, arr);
  }

  all(path: string): Observation[] {
    return this.byPath.get(path) ?? [];
  }

  /** Observations of `path` whose text still occurs verbatim in `current`. */
  valid(path: string, current: string | undefined): Observation[] {
    if (current === undefined) return [];
    const c = norm(current);
    return this.all(path).filter((o) => c.includes(o.text));
  }

  /** Observations of `path` the file no longer contains: the model saw an older version. */
  stale(path: string, current: string | undefined): Observation[] {
    if (current === undefined) return this.all(path);
    const c = norm(current);
    return this.all(path).filter((o) => !c.includes(o.text));
  }

  /** True if line `lineText` of `path` is inside text the model saw and that is still current. */
  sawLine(path: string, lineText: string, current: string | undefined): boolean {
    const t = lineText.trim();
    if (!t) return true;
    return this.valid(path, current).some((o) => o.text.split('\n').some((l) => l.trim() === t));
  }
}
