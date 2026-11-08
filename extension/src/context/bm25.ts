/**
 * Small BM25 index with code-aware tokenisation.
 * Identifiers are split on snake_case / camelCase / punctuation; both the whole identifier and
 * its parts are indexed so "get_debug_flag" matches "debug flag" and "get_debug_flag".
 */

const STOP = new Set(
  (
    'a an and are as at be by for from has have if in into is it its of on or that the then this to was were will with ' +
    'self cls none true false return import def class pass not elif else try except finally raise while ' +
    'should must also any every other same new all add make it they them their there these those which who what when ' +
    'do does using use used can could would may might like just only than very'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g);
  if (!raw) return out;
  for (const word of raw) {
    const lower = word.toLowerCase();
    if (lower.length < 2) continue;
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2);
    if (parts.length > 1 && !STOP.has(lower)) out.push(lower);
    for (const p of parts) if (!STOP.has(p)) out.push(stem(p));
  }
  return out;
}

/** Very light stemmer: plural/verb suffixes only, so "commands"~"command", "masking"~"mask". */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

export class Bm25 {
  private docs: Map<string, number>[] = [];
  private lens: number[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  constructor(private k1 = 1.2, private b = 0.75) {}

  add(tokens: string[]): number {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push(tf);
    this.lens.push(tokens.length);
    this.avgLen = this.lens.reduce((a, b) => a + b, 0) / this.lens.length;
    return this.docs.length - 1;
  }

  idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Returns scores for every doc with score > 0, plus which query terms matched. */
  score(query: string[]): { doc: number; score: number; matched: string[] }[] {
    const terms = [...new Set(query)];
    const out: { doc: number; score: number; matched: string[] }[] = [];
    for (let d = 0; d < this.docs.length; d++) {
      const tf = this.docs[d];
      let s = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const norm = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + this.b * (this.lens[d] / (this.avgLen || 1))));
        s += this.idf(t) * norm;
        matched.push(t);
      }
      if (s > 0) out.push({ doc: d, score: s, matched });
    }
    return out;
  }
}
