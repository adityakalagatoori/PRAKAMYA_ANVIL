import { tokenize } from './bm25';
import { Chunk } from './chunker';
import { CodeIndex, estimateTokens } from './index';

/**
 * Context assembly: decides what the model sees before its first token.
 *
 * Strategy (in priority order, all under one token budget):
 *   1. Explicit @file / @symbol mentions.
 *   2. Lexical retrieval: BM25 over definition-level chunks, boosted by path and symbol-name hits.
 *   3. Structural expansion: test + docs counterparts and import neighbours of the top source files,
 *      because a real change rarely lives in one file (code -> test -> docs).
 *   4. Diversity: at most 2 chunks per file on the first pass, then greedy fill by score.
 *   5. Leftover high-scoring files are listed (paths only) as candidates the agent can read_file.
 *   6. A compact repo map of the touched directories.
 */

export interface ContextItem {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  tokens: number;
  score: number;
  reason: string;
  source: 'mention' | 'retrieval' | 'counterpart' | 'selection';
  text: string;
}

export interface ContextPack {
  query: string;
  budget: number;
  used: number;
  items: ContextItem[];
  candidates: { path: string; score: number; reason: string }[];
  repoMap: string;
  queryTerms: string[];
}

export interface Mentions {
  files: string[];
  symbols: string[];
}

/** Extracts @mentions. A mention containing "/" or a file extension is a file, otherwise a symbol. */
export function parseMentions(text: string, index: CodeIndex): Mentions {
  const files: string[] = [];
  const symbols: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([\w./\\-]+(?:\.\w+)?)/g)) {
    const tok = m[1].replace(/\\/g, '/').replace(/[.,;:]+$/, '');
    const fileHit = index.files.has(tok) ? tok : [...index.files.keys()].find((p) => p.endsWith('/' + tok) || p === tok);
    if (fileHit) files.push(fileHit);
    else if (index.findSymbol(tok).length) symbols.push(tok);
  }
  return { files: [...new Set(files)], symbols: [...new Set(symbols)] };
}

const isTest = (p: string) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.py$/.test(p);
const isDoc = (p: string) => /\.(rst|md)$/.test(p);
const stemOf = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/^test_/, '').replace(/_test$/, '');

export function assembleContext(
  index: CodeIndex,
  query: string,
  opts: { budget: number; mentions?: Mentions; maxRepoMapTokens?: number; exclude?: (path: string) => boolean } = { budget: 6000 },
): ContextPack {
  const budget = opts.budget;
  const mentions = opts.mentions ?? parseMentions(query, index);
  const items: ContextItem[] = [];
  let used = 0;
  const taken = new Set<number>();
  const exclude = opts.exclude ?? (() => false);
  const fileChunkCount = new Map<string, number>();

  const take = (c: Chunk, score: number, reason: string, source: ContextItem['source'], maxTokens = Infinity): boolean => {
    if (taken.has(c.id)) return false;
    let text = c.text;
    let endLine = c.endLine;
    let tokens = estimateTokens(text);
    if (tokens > maxTokens || used + tokens > budget) {
      // Truncate rather than drop if at least ~40 lines fit.
      const room = Math.min(maxTokens, budget - used);
      if (room < 200) return false;
      const lines = text.split('\n');
      let acc = 0;
      let n = 0;
      for (; n < lines.length && acc + lines[n].length / 4 < room - 20; n++) acc += lines[n].length / 4 + 0.25;
      text = lines.slice(0, n).join('\n') + '\n# … truncated by Anvil (use read_file for the rest)';
      endLine = c.startLine + n - 1;
      tokens = estimateTokens(text);
    }
    taken.add(c.id);
    used += tokens;
    fileChunkCount.set(c.path, (fileChunkCount.get(c.path) ?? 0) + 1);
    items.push({ path: c.path, startLine: c.startLine, endLine, symbol: c.symbol, tokens, score: +score.toFixed(2), reason, source, text });
    return true;
  };

  // 1. Mentions
  for (const f of mentions.files) {
    const file = index.files.get(f);
    if (!file) continue;
    for (const id of file.chunkIds) {
      if (used >= budget * 0.6) break;
      take(index.chunks[id], 100, 'mentioned by you (@' + f + ')', 'mention', budget * 0.4);
    }
  }
  for (const s of mentions.symbols) {
    for (const def of index.findSymbol(s).slice(0, 2)) {
      const c = index.chunkAt(def.path, def.line);
      if (c) take(c, 100, `mentioned by you (@${s})`, 'mention', budget * 0.4);
    }
  }

  // 2. Lexical retrieval
  const qTerms = [...new Set(tokenize(query.replace(/@[\w./\\-]+/g, ' ')))];
  const hits = index.search(query).filter((h) => !exclude(h.chunk.path));
  // boosts
  for (const h of hits) {
    const pathTokens = new Set(tokenize(h.chunk.path));
    const symTokens = new Set(h.chunk.symbol ? tokenize(h.chunk.symbol) : []);
    let boost = 0;
    for (const t of qTerms) {
      if (pathTokens.has(t)) boost += 0.6 * index.idf(t);
      if (symTokens.has(t)) boost += 0.4 * index.idf(t);
    }
    // Pure-test and doc chunks are useful but should not crowd out source files at the top.
    h.score = (h.score + boost) * (isTest(h.chunk.path) || isDoc(h.chunk.path) ? 0.8 : 1);
  }
  hits.sort((a, b) => b.score - a.score);

  // File-level score = best chunk + 0.3 * next two
  const fileScores = new Map<string, { score: number; chunks: typeof hits; matched: Set<string> }>();
  for (const h of hits) {
    const e = fileScores.get(h.chunk.path) ?? { score: 0, chunks: [], matched: new Set<string>() };
    e.chunks.push(h);
    h.matched.forEach((m) => e.matched.add(m));
    fileScores.set(h.chunk.path, e);
  }
  for (const e of fileScores.values()) {
    const s = e.chunks.slice(0, 3).map((c) => c.score);
    e.score = (s[0] ?? 0) + 0.3 * ((s[1] ?? 0) + (s[2] ?? 0));
  }
  const rankedFiles = [...fileScores.entries()].sort((a, b) => b[1].score - a[1].score);
  const topSourceFiles = rankedFiles.filter(([p]) => !isTest(p) && !isDoc(p)).slice(0, 3).map(([p]) => p);

  // First pass: best 2 chunks of each top file (diversity)
  const topScore = rankedFiles[0]?.[1].score ?? 1;
  for (const [path, e] of rankedFiles.slice(0, 6)) {
    if (e.score < topScore * 0.25) break;
    for (const h of e.chunks.slice(0, 2)) {
      take(h.chunk, h.score, `matched ${[...h.matched].slice(0, 5).join(', ')} (score ${h.score.toFixed(1)})`, 'retrieval');
    }
    void path;
  }

  // 3. Structural expansion: counterparts of the top source files
  for (const src of topSourceFiles) {
    const stem = stemOf(src);
    const modName = src.replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '.');
    const counterparts: { path: string; why: string }[] = [];
    for (const p of index.files.keys()) {
      if (p === src || exclude(p)) continue;
      if (/(^|\/)test_[^/]+\.py$/.test(p) && stemOf(p) === stem) counterparts.push({ path: p, why: `test counterpart of ${src}` });
      else if (isDoc(p) && (stemOf(p) === stem || stemOf(p) === stem + 's')) counterparts.push({ path: p, why: `docs page for ${src}` });
    }
    // docs that reference the module with autodoc / explicit name (cap 1)
    if (!counterparts.some((c) => isDoc(c.path))) {
      for (const p of index.files.keys()) {
        if (isDoc(p) && index.files.get(p)!.text.includes(modName)) {
          counterparts.push({ path: p, why: `docs referencing ${modName}` });
          break;
        }
      }
    }
    for (const cp of counterparts) {
      // pick the counterpart's chunks that best match the query; fall back to its first chunk
      const inFile = fileScores.get(cp.path)?.chunks ?? [];
      const picks = inFile.length ? inFile.slice(0, 2) : [];
      if (picks.length) {
        for (const h of picks) take(h.chunk, h.score, `${cp.why}; matched ${[...h.matched].slice(0, 4).join(', ')}`, 'counterpart');
      } else {
        const first = index.files.get(cp.path)!.chunkIds[0];
        if (first !== undefined) take(index.chunks[first], 0, cp.why, 'counterpart', 600);
      }
    }
    // import neighbours: modules this source imports that also scored (listed as candidates later)
  }

  // 4. Greedy fill with remaining hits by score (max 4 chunks per file)
  for (const h of hits) {
    if (used >= budget - 150) break;
    if ((fileChunkCount.get(h.chunk.path) ?? 0) >= 3) continue;
    if (h.score < (hits[0]?.score ?? 0) * 0.3) break;
    take(h.chunk, h.score, `matched ${[...h.matched].slice(0, 5).join(', ')} (score ${h.score.toFixed(1)})`, 'retrieval');
  }

  // 5. Candidates not included
  const includedFiles = new Set(items.map((i) => i.path));
  const candidates = rankedFiles
    .filter(([p]) => !includedFiles.has(p))
    .slice(0, 8)
    .map(([p, e]) => ({ path: p, score: +e.score.toFixed(2), reason: `matched ${[...e.matched].slice(0, 4).join(', ')}` }));
  // import neighbours of top sources
  for (const src of topSourceFiles) {
    for (const imp of index.files.get(src)?.imports ?? []) {
      const target = resolvePyImport(src, imp, index);
      if (target && !includedFiles.has(target) && !candidates.some((c) => c.path === target) && candidates.length < 12) {
        candidates.push({ path: target, score: 0, reason: `imported by ${src}` });
      }
    }
  }

  // 6. Repo map
  const repoMap = buildRepoMap(index, [...includedFiles], opts.maxRepoMapTokens ?? 1200);

  items.sort((a, b) => (a.source === 'mention' ? -1 : 0) - (b.source === 'mention' ? -1 : 0) || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { query, budget, used, items, candidates, repoMap, queryTerms: qTerms };
}

function resolvePyImport(from: string, imp: string, index: CodeIndex): string | undefined {
  let mod = imp;
  if (mod.startsWith('.')) {
    const dir = from.split('/').slice(0, -1);
    let dots = 0;
    while (mod[dots] === '.') dots++;
    const base = dir.slice(0, dir.length - (dots - 1));
    mod = [...base, ...mod.slice(dots).split('.').filter(Boolean)].join('/');
  } else {
    mod = mod.replace(/\./g, '/');
  }
  for (const cand of [mod + '.py', mod + '/__init__.py', 'src/' + mod + '.py', 'src/' + mod + '/__init__.py']) {
    if (index.files.has(cand)) return cand;
  }
  return undefined;
}

/** Directory tree of the touched directories with top-level symbols; other dirs as file counts. */
export function buildRepoMap(index: CodeIndex, focus: string[], maxTokens: number): string {
  const focusDirs = new Set(focus.map((p) => p.split('/').slice(0, -1).join('/')));
  const byDir = new Map<string, string[]>();
  for (const p of [...index.files.keys()].sort()) {
    const dir = p.split('/').slice(0, -1).join('/') || '.';
    const arr = byDir.get(dir) ?? [];
    arr.push(p);
    byDir.set(dir, arr);
  }
  const lines: string[] = [];
  const focusFirst = [...byDir.keys()].sort((a, b) => Number(focusDirs.has(b)) - Number(focusDirs.has(a)) || a.localeCompare(b));
  for (const dir of focusFirst) {
    const files = byDir.get(dir)!;
    if (focusDirs.has(dir)) {
      lines.push(`${dir}/`);
      for (const f of files) {
        const syms = (index.files.get(f)?.symbols ?? []).filter((s) => s.kind === 'class' || s.kind === 'function').map((s) => s.name);
        const shown = syms.slice(0, 12).join(', ') + (syms.length > 12 ? `, …(+${syms.length - 12})` : '');
        lines.push(`  ${f.split('/').pop()}${shown ? ': ' + shown : ''}`);
      }
    } else {
      lines.push(`${dir}/ (${files.length} files)`);
    }
  }
  let out = '';
  for (const l of lines) {
    if (estimateTokens(out + l) > maxTokens) {
      out += '…\n';
      break;
    }
    out += l + '\n';
  }
  return out;
}

const fenceLang = (p: string) => (p.endsWith('.py') ? 'python' : p.endsWith('.rst') ? 'rst' : p.endsWith('.md') ? 'markdown' : p.split('.').pop() ?? '');

/** Renders the pack as the text the model receives. */
export function renderPack(pack: ContextPack): string {
  const out: string[] = [];
  out.push(`<anvil_context budget_tokens="${pack.budget}" used_tokens="${pack.used}">`);
  out.push('Code below was selected by Anvil\'s retriever. Each block says why it was chosen. It may be incomplete: use read_file / search_code / retrieve_context to see more before editing.');
  for (const it of pack.items) {
    out.push(`\n### ${it.path}:${it.startLine}-${it.endLine}${it.symbol ? ` (${it.symbol})` : ''}\nwhy: ${it.reason}\n\`\`\`${fenceLang(it.path)}\n${it.text}\n\`\`\``);
  }
  if (pack.candidates.length) {
    out.push('\nOther relevant files (not included; read if needed):');
    for (const c of pack.candidates) out.push(`- ${c.path} — ${c.reason}`);
  }
  out.push('\nRepository map:\n' + pack.repoMap);
  out.push('</anvil_context>');
  return out.join('\n');
}

/** Compact, UI-friendly summary for the panel / tool results. */
export function summarizePack(pack: ContextPack) {
  return {
    budget: pack.budget,
    used: pack.used,
    queryTerms: pack.queryTerms,
    items: pack.items.map((i) => ({ path: i.path, lines: `${i.startLine}-${i.endLine}`, symbol: i.symbol, tokens: i.tokens, reason: i.reason, source: i.source })),
    candidates: pack.candidates,
  };
}
