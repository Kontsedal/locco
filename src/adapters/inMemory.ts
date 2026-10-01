import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';

type Entry = {
  token: string;
  expiresAt: number;
};

export type InMemoryAdapterOptions = {
  /**
   * Clock in milliseconds. Default `performance.now`: the backend lives in this process and pauses
   * with it, and a wall-clock step must not end every lease at once while each holder still
   * counts its lease as live. Pass `() => Date.now()` to follow fake timers.
   */
  now?: () => number;
};

/** One process only. Meant for tests and for code that runs a single instance. */
export class InMemoryAdapter implements LockAdapter, Disposable {
  readonly #entries = new Map<string, Entry>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #now: () => number;

  constructor(options: InMemoryAdapterOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    if (this.#live(key)) {
      return false;
    }
    this.#set(key, token, ttl);
    return true;
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    const entry = this.#live(key);
    if (!entry || entry.token !== token) {
      return false;
    }
    this.#delete(key);
    return true;
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    const entry = this.#live(key);
    if (!entry || entry.token !== token) {
      return false;
    }
    this.#set(key, token, ttl);
    return true;
  }

  async isHeld({ key, token }: LockKeyParams): Promise<boolean> {
    const entry = this.#live(key);
    return entry !== undefined && entry.token === token;
  }

  /** Forgets every lock and stops every timer. */
  clear(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#entries.clear();
  }

  [Symbol.dispose](): void {
    this.clear();
  }

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (!entry || entry.expiresAt <= this.#now()) {
      return undefined;
    }
    return entry;
  }

  #set(key: string, token: string, ttl: number): void {
    const expiresAt = this.#now() + ttl;
    this.#entries.set(key, { token, expiresAt });
    clearTimeout(this.#timers.get(key));
    // The timer only frees memory; every read checks `expiresAt` anyway. `#set`, `#delete` and
    // `clear` all cancel it, so when it does run it can only be for the entry it was made for.
    const timer = setTimeout(() => {
      this.#entries.delete(key);
      this.#timers.delete(key);
    }, ttl);
    timer.unref();
    this.#timers.set(key, timer);
  }

  #delete(key: string): void {
    this.#entries.delete(key);
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
  }
}
