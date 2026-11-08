import { ReviewResult } from './review/reviewManager';

/**
 * Shared state between the run controller (which sees TrueForge events and drives reviews)
 * and the MCP tool handlers (which TrueForge calls after approval).
 */
export interface ActiveRun {
  id: string;
  cancelled: boolean;
  abort: AbortController;
}

export interface WriteDecision {
  tool: string;
  path: string;
  review: ReviewResult;
  createdAt: number;
}

export function canonicalKey(tool: string, args: unknown): string {
  return `${tool}:${stableStringify(args)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

export class RunState {
  active: ActiveRun | undefined;
  /** Reviews completed during TrueForge approval, waiting for the tool call to report them. */
  private decisions = new Map<string, WriteDecision>();

  start(id: string): ActiveRun {
    this.active = { id, cancelled: false, abort: new AbortController() };
    this.decisions.clear();
    return this.active;
  }

  cancel() {
    if (this.active) {
      this.active.cancelled = true;
      this.active.abort.abort();
    }
    this.decisions.clear();
  }

  end(id: string) {
    if (this.active?.id === id) this.active = undefined;
  }

  recordDecision(key: string, d: WriteDecision) {
    this.decisions.set(key, d);
  }

  /** Exact match on (tool, args); otherwise the oldest decision for the same tool+path. */
  takeDecision(key: string, tool: string, path: string): WriteDecision | undefined {
    let d = this.decisions.get(key);
    if (d) {
      this.decisions.delete(key);
      return d;
    }
    let bestKey: string | undefined;
    for (const [k, v] of this.decisions) {
      if (v.tool === tool && v.path === path && (!d || v.createdAt < d.createdAt)) {
        d = v;
        bestKey = k;
      }
    }
    if (bestKey) this.decisions.delete(bestKey);
    return d;
  }
}
