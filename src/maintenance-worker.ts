import { setTimeout as sleep } from 'node:timers/promises';

/** Serialize timer callbacks and await accepted work during shutdown. */
export class DrainingTask {
  private pending?: Promise<void>;
  private stopping = false;
  get state() { return { active: Boolean(this.pending), stopping: this.stopping }; }
  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.stopping || this.pending) return false;
    this.pending = Promise.resolve().then(task);
    try { await this.pending; return true; }
    finally { this.pending = undefined; }
  }
  async stop(): Promise<void> { this.stopping = true; await this.pending; }
}

/** Track upload handlers even after their HTTP 202 has been sent. */
export class ActiveOperations {
  private pending = new Set<Promise<unknown>>();
  get count() { return this.pending.size; }
  async run<T>(task: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(task);
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

/** Stop admission, finish the current operation, then interrupt the idle wait. */
export class MaintenanceWorker {
  private readonly wake = new AbortController();
  private running?: Promise<void>;
  private stopping = false;
  private active = false;
  private lastCompletedAt?: string;
  private nextRunAt?: string;

  constructor(private readonly task: () => Promise<void>, private readonly intervalMs: number) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('Invalid worker interval');
  }

  get state() {
    return { stopping: this.stopping, active: this.active,
      lastCompletedAt: this.lastCompletedAt, nextRunAt: this.nextRunAt };
  }

  run(): Promise<void> {
    if (!this.running) this.running = this.loop();
    return this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      this.active = true;
      this.nextRunAt = undefined;
      try { await this.task(); }
      finally { this.active = false; this.lastCompletedAt = new Date().toISOString(); }
      if (this.stopping) break;
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      try { await sleep(this.intervalMs, undefined, { signal: this.wake.signal }); }
      catch (error: any) { if (!this.stopping || error?.name !== 'AbortError') throw error; }
    }
    this.nextRunAt = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake.abort();
    await this.running;
  }
}
