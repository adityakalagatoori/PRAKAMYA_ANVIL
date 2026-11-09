import { ReviewResult } from './review/reviewManager';
import { LoopGuard } from './security/policy';
import { ObservationLedger } from './context/observation';

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
  /** Commands the user approved in this run (consumed when executed). */
  private approvedCommands = new Map<string, number>();
  /** Circuit breaker for repeated identical tool calls / runaway runs. */
  readonly loopGuard = new LoopGuard(3, 250);
  /** What the model has been shown in this conversation (kept across turns of a continued conversation). */
  readonly ledger = new ObservationLedger();
  /** Admission holds per file in the current run (the check holds an edit back at most twice per file). */
  readonly admissionHolds = new Map<string, number>();

  start(id: string, opts: { keepObservations?: boolean } = {}): ActiveRun {
    this.active = { id, cancelled: false, abort: new AbortController() };
    this.decisions.clear();
    this.approvedCommands.clear();
    this.loopGuard.reset();
    this.admissionHolds.clear();
    if (!opts.keepObservations) this.ledger.clear();
    return this.active;
  }

  approveCommand(cmd: string) {
    this.approvedCommands.set(cmd, (this.approvedCommands.get(cmd) ?? 0) + 1);
  }

  /** True (and consumes the approval) if the user approved exactly this command in this run. */
  isCommandApproved(cmd: string): boolean {
    const n = this.approvedCommands.get(cmd) ?? 0;
    if (n <= 0) return false;
    this.approvedCommands.set(cmd, n - 1);
    return true;
  }

  cancel() {
    if (this.active) {
      this.active.cancelled = true;
      this.active.abort.abort();
    }
    this.decisions.clear();
    this.approvedCommands.clear();
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
