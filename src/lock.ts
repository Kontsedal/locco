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
  /** A monotonic clock in milliseconds. */
  now: () => number;
  emit: (event: LockEvent) => void;
  heartbeat?: HeartbeatConfig;
};

type ExtendRequest = {
  /** Undefined means the current TTL, resolved when the request runs, not when it was queued. */
  ttl?: number;
  fromHeartbeat: boolean;
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
  #releasing: Promise<boolean> | undefined;

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

  /** Why the lock was lost, or undefined when it was never lost. */
  get lostReason(): LockLostReason | undefined {
    return this.#lostReason;
  }

  /** Aborts on every known loss: a failed, late or refused extension, a local lease expiry, the hold deadline, a release or check that finds the key not ours. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /**
   * Returns true when it deleted our key. Returns false when the key was gone or belonged to
   * another holder. Throws only when the adapter throws; the lock then keeps its state and a
   * later call tries again. After a successful call, a second call returns false.
   */
  release(): Promise<boolean> {
    if (this.#state === 'released') {
      return Promise.resolve(false);
    }
    if (!this.#releasing) {
      this.#releasing = this.#release().finally(() => {
        this.#releasing = undefined;
      });
    }
    return this.#releasing;
  }

  /**
   * Sets a new lease of `ttl` milliseconds from now, clamped to the hold deadline. Throws
   * LockLostError when the key was not ours, and the deadline error when the deadline has passed.
   */
  async extend(ttl: number): Promise<void> {
    assertDuration(ttl, 'ttl');
    this.#assertExtendable();
    await this.#queueExtend({ ttl, fromHeartbeat: false });
  }

  /** One observation of the backend. A `false` while the lock is held marks it lost. */
  async isHeld(): Promise<boolean> {
    const held = await this.#adapter.isHeld({ key: this.key, token: this.token });
    if (!held && this.#state === 'held') {
      this.#markLost('observed');
    }
    return held;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  async #release(): Promise<boolean> {
    const wasLost = this.#state === 'lost';
    this.#clearTimers();
    let released: boolean;
    try {
      released = await this.#adapter.release({ key: this.key, token: this.token });
    } catch (error) {
      // The backend did not answer, so the key may still exist. Keep the state so a later call
      // can try again, and keep watching the local expiry.
      if (this.#state === 'held') {
        this.#scheduleExpiry();
      }
      throw error;
    }
    this.#state = 'released';
    const heldMs = this.#heldMs();
    if (released) {
      this.#emit({ type: 'released', key: this.key, ttl: this.#ttl, heldMs });
    } else if (!wasLost) {
      this.#lostReason = 'release';
      this.#emit({ type: 'lost', key: this.key, ttl: this.#ttl, heldMs, reason: 'release' });
      this.#abort.abort(new LockLostError({ key: this.key, reason: 'release' }));
    }
    return released;
  }

  #assertExtendable(): void {
    if (this.#state === 'released') {
      throw new LockStateError(`Lock "${this.key}" is released and cannot be extended`);
    }
    if (this.#state === 'lost') {
      throw this.#abort.signal.reason;
    }
    if (this.#releasing) {
      throw new LockStateError(`Lock "${this.key}" is being released and cannot be extended`);
    }
  }

  // Extensions run one at a time, so a heartbeat and a manual call cannot interleave their bookkeeping.
  #queueExtend(request: ExtendRequest): Promise<void> {
    const run = this.#extendQueue.then(() => this.#extend(request));
    this.#extendQueue = run.catch(() => undefined);
    return run;
  }

  async #extend({ ttl: requested, fromHeartbeat }: ExtendRequest): Promise<void> {
    if (this.#state !== 'held' || this.#releasing) {
      if (fromHeartbeat) {
        return;
      }
      this.#assertExtendable();
    }
    const startedAt = this.#now();
    let ttl = requested ?? this.#ttl;
    const deadline = this.#heartbeat?.deadline;
    if (deadline !== undefined) {
      const untilDeadline = deadline - startedAt;
      if (untilDeadline <= 0) {
        this.#markLost('max-hold');
        if (fromHeartbeat) {
          return;
        }
        throw this.#abort.signal.reason;
      }
      // The last extension is clamped, so the lease cannot end after the deadline by more than
      // the network latency of this request.
      ttl = Math.min(ttl, Math.ceil(untilDeadline));
    }
    // A shorter lease takes effect on the backend before the answer arrives, so the local
    // estimate must not outlive it. It is lengthened only after the answer.
    if (startedAt + ttl < this.#expiresAt) {
      this.#expiresAt = startedAt + ttl;
      this.#scheduleExpiry();
    }
    let extended: boolean;
    try {
      extended = await this.#adapter.extend({ key: this.key, token: this.token, ttl });
    } catch (error) {
      // The backend did not answer, so the lease state is unknown. Treat it as lost.
      this.#markLost('extend', error);
      throw error;
    }
    if (this.#state !== 'held') {
      if (fromHeartbeat) {
        return;
      }
      this.#assertExtendable();
    }
    if (!extended) {
      this.#markLost('extend');
      throw this.#abort.signal.reason;
    }
    if (this.#now() - startedAt >= ttl) {
      this.#markLost('late-extend');
      throw this.#abort.signal.reason;
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
    try {
      await this.#queueExtend({ fromHeartbeat: true });
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
    return Math.round(this.#now() - this.#acquiredAt);
  }
}
