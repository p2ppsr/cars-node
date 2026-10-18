/** Refresh ahead of expiry without extending the existing freshness bound. */
export class HealthCache<T> {
  private cached?: { value: T; expiresAt: number };
  private pending?: Promise<T>;
  constructor(private readonly load: () => Promise<T>, private readonly ttlMs: number,
              private readonly now: () => number = Date.now) {}

  get(): Promise<T> {
    if (this.cached && this.cached.expiresAt > this.now()) return Promise.resolve(this.cached.value);
    return this.refresh();
  }

  refresh(): Promise<T> {
    if (!this.pending) {
      this.pending = Promise.resolve().then(this.load).then(value => {
        this.cached = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  async drain(): Promise<void> { await this.pending; }
}
