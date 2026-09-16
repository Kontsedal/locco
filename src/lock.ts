import type { LockAdapter } from './adapter';
import { LoccoError, LockLostError, type LockLostReason, LockStateError } from './errors';
import type { LockEvent, ResolvedRetry } from './types';
import { assertDuration } from './validate';

export type LockState = 'held' | 'lost' | 'released';

export type HeartbeatConfig = {
  interval?: number;
  /** Always set. `assertAutoExtend` refuses a heartbeat without a deadline. */
  maxHold: number;
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

/** A live heartbeat. `deadline` is never absent, because `maxHold` is required wherever `autoExtend` is. */
type Heartbeat = {
  interval?: number;
  deadline: number;
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
  /** Frozen the moment the lock stops being held, so `heldMs` stops counting there. */
  #endedAt: number | undefined;
  readonly #adapter: LockAdapter;
  readonly #now: () => number;
  readonly #emit: (event: LockEvent) => void;
  readonly #abort = new AbortController();
  readonly #heartbeat: Heartbeat | undefined;
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
        deadline: init.acquiredAt + init.heartbeat.maxHold,
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

  /** How long the lock was held, in milliseconds. Stops counting once it is lost or released. */
  get heldMs(): number {
    return this.#heldMs();
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
    // The heartbeat stops now. The expiry watch stays armed, because a release that stalls must
    // not leave a handle that says `held` after the backend lease ended.
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    let released: boolean;
    try {
      released = await this.#adapter.release({ key: this.key, token: this.token });
    } catch (error) {
      // When the backend throws, the key may still exist and the lock keeps its state so a later
      // call can try again. Put the heartbeat back: without it an auto-extending lock would stop
      // renewing and quietly die at its next expiry, while the caller still believed it held.
      this.#scheduleHeartbeat();
      throw error;
    }
    const lostMeanwhile = this.#state === 'lost';
    this.#state = 'released';
    this.#endedAt ??= this.#now();
    this.#clearTimers();
    const heldMs = this.#heldMs();
    if (lostMeanwhile) {
      // `lost` already went out and `lostReason` already explains the ending. A second event for
      // the same lock would make an observer count it twice.
      return released;
    }
    if (released) {
      this.#emit({ type: 'released', key: this.key, ttl: this.#ttl, heldMs });
    } else {
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
      // The last extension is clamped to whole milliseconds below the deadline, so the backend
      // lease cannot outlive it by more than the time this request spends in flight.
      ttl = Math.min(ttl, Math.floor(untilDeadline));
      if (ttl <= 0) {
        this.#markLost('max-hold');
        if (fromHeartbeat) {
          return;
        }
        throw this.#abort.signal.reason;
      }
    }
    // A shorter lease takes effect on the backend before the answer arrives, so the local
    // estimate must not outlive it. It is lengthened only after the answer.
    const leaseEnd = deadline === undefined ? startedAt + ttl : Math.min(startedAt + ttl, deadline);
    if (leaseEnd < this.#expiresAt) {
      this.#expiresAt = leaseEnd;
      this.#scheduleExpiry();
    }
    let extended: boolean;
    try {
      extended = await this.#adapter.extend({ key: this.key, token: this.token, ttl });
    } catch (error) {
      // The backend did not answer, so the lease state is unknown. Treat it as lost, but under a
      // reason of its own: the key was very likely still ours, and saying it was taken would send
      // an operator hunting a double acquisition that never happened.
      this.#markLost('extend-failed', error);
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
    this.#expiresAt = leaseEnd;
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
    this.#endedAt = this.#now();
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
    const deadline = this.#heartbeat?.deadline;
    const reason = deadline !== undefined && this.#expiresAt >= deadline ? 'max-hold' : 'expired';
    // `#markLost` ignores a lock that is no longer held, so this needs no guard of its own.
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
    // The heartbeat travels with the timer, so the tick needs no null check of its own.
    this.#heartbeatTimer = setTimeout(() => {
      void this.#heartbeatTick(heartbeat);
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

  async #heartbeatTick(heartbeat: Heartbeat): Promise<void> {
    try {
      await this.#queueExtend({ fromHeartbeat: true });
    } catch {
      // #extend already marked the lock lost and aborted the signal.
      return;
    }
    if (this.#state !== 'held') {
      return;
    }
    // The lease now reaches the hold deadline, so there is nothing left to extend.
    if (this.#expiresAt >= heartbeat.deadline) {
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
    return Math.round((this.#endedAt ?? this.#now()) - this.#acquiredAt);
  }
}
