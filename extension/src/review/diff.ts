import { diffArrays } from 'diff';

/**
 * Hunk model used by the review UI. A hunk replaces original lines [origStart, origStart+origLines.length)
 * with newLines. Hunks never overlap and are sorted, so any subset can be applied independently.
 */
export interface Hunk {
  index: number;
  origStart: number; // 0-based line in original
  origLines: string[];
  newLines: string[];
}

export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function toLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function computeHunks(original: string, proposed: string, mergeGap = 0): Hunk[] {
  const a = toLines(original);
  const b = toLines(proposed);
  const parts = diffArrays(a, b);
  const hunks: Hunk[] = [];
  let line = 0;
  let cur: Hunk | null = null;
  let gap = 0;
  for (const p of parts) {
    if (!p.added && !p.removed) {
      // Merge hunks separated by <= mergeGap unchanged lines so tiny islands don't fragment review.
      if (cur && p.value.length <= mergeGap && p !== parts[parts.length - 1]) {
        cur.origLines.push(...p.value);
        cur.newLines.push(...p.value);
        gap += p.value.length;
      } else if (cur) {
        hunks.push(cur);
        cur = null;
      }
      line += p.value.length;
      continue;
    }
    if (!cur) {
      cur = { index: hunks.length, origStart: line, origLines: [], newLines: [] };
      gap = 0;
    }
    if (p.removed) {
      cur.origLines.push(...p.value);
      line += p.value.length;
    } else {
      cur.newLines.push(...p.value);
    }
  }
  if (cur) hunks.push(cur);
  void gap;
  return hunks.map((h, i) => ({ ...h, index: i }));
}

/** Applies the given hunks (by index) to the original text. */
export function applyHunks(original: string, hunks: Hunk[], accepted: Set<number>): string {
  const eol = detectEol(original);
  const a = toLines(original);
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.origStart) out.push(a[i++]);
    if (accepted.has(h.index)) out.push(...h.newLines);
    else out.push(...h.origLines);
    i = h.origStart + h.origLines.length;
  }
  while (i < a.length) out.push(a[i++]);
  return out.join(eol);
}

/** Line in the text produced by applyHunks(original, hunks, shown) where hunk h starts. */
export function hunkStartIn(hunks: Hunk[], shown: Set<number>, h: Hunk): number {
  let delta = 0;
  for (const o of hunks) {
    if (o.index >= h.index) break;
    if (shown.has(o.index)) delta += o.newLines.length - o.origLines.length;
  }
  return h.origStart + delta;
}

/** Minimal single-range edit turning `from` into `to` (common prefix/suffix trimmed), as offsets. */
export function minimalEdit(from: string, to: string): { start: number; end: number; text: string } {
  let s = 0;
  const max = Math.min(from.length, to.length);
  while (s < max && from.charCodeAt(s) === to.charCodeAt(s)) s++;
  let e1 = from.length;
  let e2 = to.length;
  while (e1 > s && e2 > s && from.charCodeAt(e1 - 1) === to.charCodeAt(e2 - 1)) {
    e1--;
    e2--;
  }
  return { start: s, end: e1, text: to.slice(s, e2) };
}

/**
 * search/replace edit used by the edit_file tool. Tolerates CRLF vs LF and trailing-whitespace drift.
 * Returns an error string the model can act on when the match is missing or ambiguous.
 */
export function applySearchReplace(content: string, oldStr: string, newStr: string): { ok: true; result: string } | { ok: false; error: string } {
  const eol = detectEol(content);
  const norm = (s: string) => s.replace(/\r\n/g, '\n');
  const c = norm(content);
  const o = norm(oldStr);
  const n = norm(newStr);
  if (o === '') return { ok: false, error: 'old_string is empty. Use create_file for new files, or include surrounding lines to anchor an insertion.' };
  let idx = c.indexOf(o);
  if (idx >= 0 && c.indexOf(o, idx + 1) >= 0) {
    return { ok: false, error: 'old_string matches more than one location. Include more surrounding lines so it is unique.' };
  }
  let out: string | undefined;
  if (idx >= 0) out = c.slice(0, idx) + n + c.slice(idx + o.length);
  else {
    // Fallback: compare lines with trailing whitespace stripped.
    const cl = c.split('\n');
    const ol = o.split('\n').map((l) => l.trimEnd());
    while (ol.length && ol[ol.length - 1] === '') ol.pop();
    const matches: number[] = [];
    for (let i = 0; i + ol.length <= cl.length; i++) {
      let ok = true;
      for (let j = 0; j < ol.length; j++) if (cl[i + j].trimEnd() !== ol[j]) { ok = false; break; }
      if (ok) matches.push(i);
    }
    if (matches.length !== 1) {
      return {
        ok: false,
        error: matches.length
          ? 'old_string matches more than one location. Include more surrounding lines so it is unique.'
          : 'old_string was not found in the file. Re-read the file with read_file and copy the exact text (including indentation).',
      };
    }
    const nl = n.replace(/\n$/, '').split('\n');
    cl.splice(matches[0], ol.length, ...nl);
    out = cl.join('\n');
  }
  return { ok: true, result: eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out };
}
