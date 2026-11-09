import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Append-only JSONL audit trail of agent activity: tool calls, approvals/denials, applied writes,
 * commands and their exit codes (OWASP Agentic: repudiation / traceability). Stored in the
 * extension's per-workspace storage, never in the repository.
 */
export class AuditLog {
  private dir: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  configure(dir: string | undefined) {
    this.dir = dir;
  }

  get file(): string | undefined {
    return this.dir ? join(this.dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`) : undefined;
  }

  record(event: string, data: Record<string, unknown> = {}) {
    const file = this.file;
    if (!file || !this.dir) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n';
    const dir = this.dir;
    this.queue = this.queue.then(() => mkdir(dir, { recursive: true }).then(() => appendFile(file, line, 'utf8'))).catch(() => undefined);
  }

  flush() {
    return this.queue;
  }
}

export const audit = new AuditLog();
