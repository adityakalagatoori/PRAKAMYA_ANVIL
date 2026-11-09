import { ReviewResult } from './review/reviewManager';
import { LoopGuard } from './security/policy';
import { ObservationLedger } from './context/observation';
import { Contract } from './review/contract';

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
  /** Code the agent added per file in this conversation (edit-to-execution binding). */
  readonly agentWrites = new Map<string, string>();
  /** The intent contract the user approved for the current run (if the agent proposed one). */
  contract: Contract | undefined;
  /** How many times the finish gate has withheld completion in this run. */
  gateRounds = 0;
  /** Content hashes each approved command is bound to (FIFO per command string). */
  private commandBindings = new Map<string, Record<string, string>[]>();

  start(id: string, opts: { keepObservations?: boolean } = {}): ActiveRun {
    this.active = { id, cancelled: false, abort: new AbortController() };
    this.decisions.clear();
    this.approvedCommands.clear();
    this.loopGuard.reset();
    this.admissionHolds.clear();
    this.commandBindings.clear();
    this.contract = undefined;
    this.gateRounds = 0;
    if (!opts.keepObservations) {
      this.ledger.clear();
      this.agentWrites.clear();
    }
    return this.active;
  }

  approveCommand(cmd: string, binding?: Record<string, string>) {
    this.approvedCommands.set(cmd, (this.approvedCommands.get(cmd) ?? 0) + 1);
    const q = this.commandBindings.get(cmd) ?? [];
    q.push(binding ?? {});
    this.commandBindings.set(cmd, q);
  }

  /** The content-hash binding of the oldest pending approval for this command (if any). */
  peekBinding(cmd: string): Record<string, string> | undefined {
    return this.commandBindings.get(cmd)?.[0];
  }

  recordAgentWrite(path: string, added: string) {
    this.agentWrites.set(path, ((this.agentWrites.get(path) ?? '') + '\n' + added).slice(-200_000));
  }

  /** True (and consumes the approval) if the user approved exactly this command in this run. */
  isCommandApproved(cmd: string): boolean {
    const n = this.approvedCommands.get(cmd) ?? 0;
    if (n <= 0) return false;
    this.approvedCommands.set(cmd, n - 1);
    this.commandBindings.get(cmd)?.shift();
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
