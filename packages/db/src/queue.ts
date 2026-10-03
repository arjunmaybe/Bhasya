/**
 * QueuePort — Cloudflare Queues contract for Phase 1.
 * Production: Queues + isolated workers. Dev: synchronous execution through
 * the same job names/payloads/idempotency keys (no competing architecture).
 */
export interface Job { name: string; payload: Record<string, unknown>; idempotencyKey: string }

export interface QueuePort {
  enqueue: (job: Job) => Promise<void>;
}

export class SyncQueueAdapter implements QueuePort {
  public sent: Job[] = [];
  constructor(private handlers: Record<string, (payload: Record<string, unknown>) => Promise<void>> = {}) {}
  on(name: string, fn: (payload: Record<string, unknown>) => Promise<void>): void {
    this.handlers[name] = fn;
  }
  async enqueue(job: Job): Promise<void> {
    if (this.sent.some((j) => j.idempotencyKey === job.idempotencyKey)) return;
    this.sent.push(job);
    await this.handlers[job.name]?.(job.payload);
  }
}
