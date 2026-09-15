import type { LockAdapter } from './adapter';
import { LoccoError, LockLostError, type LockLostReason, LockStateError } from './errors';
import type { LockEvent, ResolvedRetry } from './types';
import { assertDuration } from './validate';

export type LockState = 'held' | 'lost' | 'released';

export type HeartbeatConfig = {
  interval?: number;
  maxHold?: number;
};

export type LockInit = {
  adapter: LockAdapter;
  key: string;
  token: string;
  ttl: number;
  retry: ResolvedRetry;
  /** Clock reading taken before the acquire request left. The lease cannot have started earlier. */
  acquiredAt: number;
  now: () => number;
  emit: (event: LockEvent) => void;
  heartbeat?: HeartbeatConfig;
};

export class Lock implements AsyncDisposable {
  readonly key: string;
  readonly token: string;
  readonly retry: ResolvedRetry;

  #ttl: number;
  #state: LockState = 'held';
  #lostReason: LockLostReason | undefined;
  #expiresAt: number;
  readonly #acquiredAt: number;
  readonly #adapter: LockAdapter;
  readonly #now: () => number;
  readonly #emit: (event: LockEvent) => void;
  readonly #abort = new AbortController();
  readonly #heartbeat: { interval?: number; deadline?: number } | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;
  #extendQueue: Promise<unknown> = Promise.resolve();

  constructor(init: LockInit) {
    this.key = init.key;
    this.token = init.token;
    this.retry = init.retry;
    this.#ttl = init.ttl;
    this.#acquiredAt = init.acquiredAt;
    this.#expiresAt = init.acquiredAt + init.ttl;
    this.#adapter = init.adapter;
    this.#now = init.now;
    this.#emit = init.emit;
    if (init.heartbeat) {
      this.#heartbeat = {
        interval: init.heartbeat.interval,
        deadline:
          init.heartbeat.maxHold === undefined
            ? undefined
            : init.acquiredAt + init.heartbeat.maxHold,
      };
      this.#scheduleHeartbeat();
    }
    this.#scheduleExpiry();
  }

  /** The latest TTL, after any extension. */
  get ttl(): number {
    return this.#ttl;
  }

  get state(): LockState {
    return this.#state;
  }

  /** Why the lock is lost, or undefined while it is held or after a release. */
  get lostReason(): LockLostReason | undefined {
    return this.#lostReason;
  }

  /** Aborts on every known loss: a failed or late extension, a local lease expiry, the hold deadline. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /**
   * Returns true when it deleted our key. Returns false when the key was gone or belonged to
   * another holder. Throws only when the adapter throws. A second call returns false.
   */
  async release(): Promise<boolean> {
    if (this.#state === 'released') {
      return false;
    }
    const wasLost = this.#state === 'lost';
    this.#state = 'released';
    this.#clearTimers();
    const released = await this.#adapter.release({ key: this.key, token: this.token });
    const heldMs = this.#heldMs();
    if (released) {
      this.#emit({ type: 'released', key: this.key, ttl: this.#ttl, heldMs });
    } else if (!wasLost) {
      this.#emit({ type: 'lost', key: this.key, ttl: this.#ttl, heldMs, reason: 'release' });
    }
    return released;
  }

  /** Sets a new lease of `ttl` milliseconds from now. Throws LockLostError when the key was not ours. */
  async extend(ttl: number): Promise<void> {
    assertDuration(ttl, 'ttl');
    this.#assertExtendable();
    await this.#queueExtend(ttl, false);
  }

  /** One observation of the backend. The answer can change right after it returns. */
  isHeld(): Promise<boolean> {
    return this.#adapter.isHeld({ key: this.key, token: this.token });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  #assertExtendable(): void {
    if (this.#state === 'released') {
      throw new LockStateError(`Lock "${this.key}" is released and cannot be extended`);
    }
    if (this.#state === 'lost') {
      throw new LockLostError({ key: this.key, reason: this.#lostReason ?? 'extend' });
    }
  }

  // Extensions run one at a time, so a heartbeat and a manual call cannot interleave their bookkeeping.
  #queueExtend(ttl: number, fromHeartbeat: boolean): Promise<void> {
    const run = this.#extendQueue.then(() => this.#extend(ttl, fromHeartbeat));
    this.#extendQueue = run.catch(() => undefined);
    return run;
  }

  async #extend(ttl: number, fromHeartbeat: boolean): Promise<void> {
    if (this.#state !== 'held') {
      if (fromHeartbeat) {
        return;
      }
      this.#assertExtendable();
    }
    const startedAt = this.#now();
    let extended: boolean;
    try {
      extended = await this.#adapter.extend({ key: this.key, token: this.token, ttl });
    } catch (error) {
      // The backend did not answer, so the lease state is unknown. Treat it as lost.
      this.#markLost('extend', error);
      throw error;
    }
    if (this.#state !== 'held') {
      return;
    }
    if (!extended) {
      this.#markLost('extend');
      throw new LockLostError({ key: this.key, reason: 'extend' });
    }
    if (this.#now() - startedAt >= ttl) {
      this.#markLost('late-extend');
      throw new LockLostError({ key: this.key, reason: 'late-extend' });
    }
    this.#ttl = ttl;
    this.#expiresAt = startedAt + ttl;
    this.#scheduleExpiry();
    if (!fromHeartbeat) {
      this.#scheduleHeartbeat();
    }
    this.#emit({ type: 'extended', key: this.key, ttl, heldMs: this.#heldMs() });
  }

  #markLost(reason: LockLostReason, cause?: unknown): void {
    if (this.#state !== 'held') {
      return;
    }
    this.#state = 'lost';
    this.#lostReason = reason;
    this.#clearTimers();
    this.#emit({ type: 'lost', key: this.key, ttl: this.#ttl, heldMs: this.#heldMs(), reason });
    const abortReason =
      reason === 'max-hold'
        ? new LoccoError(
            `Lock "${this.key}" reached its hold deadline. The lease ends here and is not extended.`,
            { code: 'LOCK_MAX_HOLD' },
          )
        : new LockLostError({ key: this.key, reason, cause });
    this.#abort.abort(abortReason);
  }

  #onLocalExpiry(): void {
    if (this.#state !== 'held') {
      return;
    }
    const deadline = this.#heartbeat?.deadline;
    const reason = deadline !== undefined && this.#expiresAt >= deadline ? 'max-hold' : 'expired';
    this.#markLost(reason);
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#expiryTimer);
    const ms = Math.max(0, this.#expiresAt - this.#now());
    this.#expiryTimer = setTimeout(() => this.#onLocalExpiry(), ms);
    this.#expiryTimer.unref();
  }

  #scheduleHeartbeat(): void {
    const heartbeat = this.#heartbeat;
    if (!heartbeat || this.#state !== 'held') {
      return;
    }
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(() => {
      void this.#heartbeatTick();
    }, this.#heartbeatInterval());
    this.#heartbeatTimer.unref();
  }

  #heartbeatInterval(): number {
    const explicit = this.#heartbeat?.interval;
    if (explicit !== undefined && explicit < this.#ttl) {
      return explicit;
    }
    return Math.max(1, Math.floor(this.#ttl / 3));
  }

  async #heartbeatTick(): Promise<void> {
    const heartbeat = this.#heartbeat;
    if (!heartbeat || this.#state !== 'held') {
      return;
    }
    let ttl = this.#ttl;
    if (heartbeat.deadline !== undefined) {
      const untilDeadline = heartbeat.deadline - this.#now();
      if (untilDeadline <= 0) {
        return;
      }
      // The last extension is clamped, so the lease cannot end after the deadline.
      ttl = Math.min(ttl, Math.ceil(untilDeadline));
    }
    try {
      await this.#queueExtend(ttl, true);
    } catch {
      // #extend already marked the lock lost and aborted the signal.
      return;
    }
    if (this.#state !== 'held') {
      return;
    }
    if (heartbeat.deadline !== undefined && this.#expiresAt >= heartbeat.deadline) {
      return;
    }
    this.#scheduleHeartbeat();
  }

  #clearTimers(): void {
    clearTimeout(this.#heartbeatTimer);
    clearTimeout(this.#expiryTimer);
    this.#heartbeatTimer = undefined;
    this.#expiryTimer = undefined;
  }

  #heldMs(): number {
    return this.#now() - this.#acquiredAt;
  }
}
