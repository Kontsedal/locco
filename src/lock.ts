import type { LockAdapter } from './adapter';
import { LockLostError, type LockLostReason, LockStateError } from './errors';
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
  /** The fencing token of the grant, when the locker takes them. */
  fence?: number;
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

/**
 * How long a lease of `ttl` milliseconds counts as ours on the holder's clock. It ends 1% early,
 * rounded down, so a holder clock that runs slower than the backend's cannot outlive the backend
 * lease. Redlock uses the same factor.
 */
export function leaseValidity(ttl: number): number {
  return ttl - Math.floor(ttl / 100);
}

/**
 * Package-internal; the entry point does not export it. Stops the heartbeat of a lock whose
 * release threw where nobody is left to try again, so the lease runs out on its own instead of
 * being renewed until the hold deadline.
 */
export let abandonLock: (lock: Lock) => void;

export class Lock implements AsyncDisposable {
  static {
    abandonLock = (lock) => lock.#abandon();
  }

  readonly key: string;
  readonly token: string;
  readonly retry: ResolvedRetry;
  /**
   * The fencing token of this grant, or undefined when the locker's `fencing` option is off. A
   * later grant of the key always gets a larger one, so a resource that remembers the largest
   * token it has seen can refuse a write from a holder whose lease ended.
   */
  readonly fence: number | undefined;

  #ttl: number;
  #state: LockState = 'held';
  #lostReason: LockLostReason | undefined;
  /** Where the last confirmed lease ends on the local clock. */
  #expiresAt: number;
  /** When the request for that lease left. The heartbeat counts its interval from here. */
  #leaseStartedAt: number;
  /** The last confirmed lease runs to the hold deadline, so there is nothing left to extend. */
  #finalLease: boolean;
  /** The latest extend request that threw, until one succeeds. A loss at expiry carries it. */
  #extendError: { error: unknown } | undefined;
  /** An extend request is waiting for its answer. A lease that runs out meanwhile ends `late-extend`. */
  #extending = false;
  #abandoned = false;
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
    this.fence = init.fence;
    this.#ttl = init.ttl;
    this.#acquiredAt = init.acquiredAt;
    this.#leaseStartedAt = init.acquiredAt;
    this.#expiresAt = init.acquiredAt + leaseValidity(init.ttl);
    this.#finalLease = init.heartbeat !== undefined && init.heartbeat.maxHold <= init.ttl;
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
    this.#checkExpiry();
    return this.#state;
  }

  /** Why the lock was lost, or undefined when it was never lost. */
  get lostReason(): LockLostReason | undefined {
    this.#checkExpiry();
    return this.#lostReason;
  }

  /** How long the lock was held, in milliseconds. Stops counting once it is lost or released. */
  get heldMs(): number {
    this.#checkExpiry();
    return this.#heldMs();
  }

  /** Aborts on every known loss: a refused or late extension, a local lease expiry, the hold deadline, a release or check that finds the key not ours. */
  get signal(): AbortSignal {
    this.#checkExpiry();
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
    this.#checkExpiry();
    if (!this.#releasing) {
      this.#releasing = this.#release().finally(() => {
        this.#releasing = undefined;
      });
    }
    return this.#releasing;
  }

  /**
   * Sets a new lease of `ttl` milliseconds from now, clamped to the hold deadline. Throws
   * LockLostError when the key was not ours or the deadline has passed. A driver error is thrown
   * as it is and leaves the lock held until its current lease runs out.
   */
  async extend(ttl: number): Promise<void> {
    assertDuration(ttl, 'ttl');
    this.#checkExpiry();
    this.#assertExtendable();
    await this.#queueExtend({ ttl, fromHeartbeat: false });
  }

  /** One observation of the backend. A `false` while the lock is held marks it lost. */
  async isHeld(): Promise<boolean> {
    const held = await this.#adapter.isHeld({ key: this.key, token: this.token });
    this.#checkExpiry();
    // Our own release in flight deletes the key, so a `false` then says nothing about another holder.
    if (!held && this.#state === 'held' && !this.#releasing) {
      this.#markLost('observed');
    }
    return held;
  }

  /**
   * Releases the lock. When the release throws, the heartbeat stops for good: nobody holds this
   * handle after the block to try again, so the lease runs out on its own.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.release();
    } catch (error) {
      this.#abandon();
      throw error;
    }
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
    // A heartbeat that fires late, after a pause, must not extend a lease that already ran out.
    this.#checkExpiry();
    if (this.#state !== 'held' || this.#releasing) {
      if (fromHeartbeat) {
        return;
      }
      this.#assertExtendable();
    }
    const startedAt = this.#now();
    let ttl = requested ?? this.#ttl;
    let final = false;
    const deadline = this.#heartbeat?.deadline;
    if (deadline !== undefined) {
      // Whole milliseconds below the deadline, so the backend lease cannot outlive it by more
      // than the time this request spends in flight.
      const untilDeadline = Math.floor(deadline - startedAt);
      if (untilDeadline <= 0) {
        // A heartbeat tick catches this like any other failure, and stops on the lost state.
        this.#markLost('max-hold');
        throw this.#abort.signal.reason;
      }
      if (ttl >= untilDeadline) {
        ttl = untilDeadline;
        final = true;
      }
    }
    // A shorter lease takes effect on the backend before the answer arrives, so the local
    // estimate must not outlive it. It is lengthened only after the answer.
    const leaseEnd = startedAt + leaseValidity(ttl);
    if (leaseEnd < this.#expiresAt) {
      this.#expiresAt = leaseEnd;
      this.#scheduleExpiry();
    }
    let extended: boolean;
    this.#extending = true;
    try {
      extended = await this.#adapter.extend({ key: this.key, token: this.token, ttl });
    } catch (error) {
      this.#extending = false;
      // No answer, so nothing is known about the new lease. The lease confirmed before it still
      // runs to its local end, so the lock stays held and a later extension can try again. A loss
      // at that end carries this error as its cause.
      if (this.#state === 'held' && !this.#releasing) {
        this.#extendError = { error };
        this.#emit({ type: 'extendFailed', key: this.key, ttl, heldMs: this.#heldMs(), error });
      }
      throw error;
    }
    // An answer that arrives after the local lease ran out cannot be used: both the old lease and
    // the new one end no later than that. The loss is `late-extend`, which points at the backend.
    this.#checkExpiry();
    this.#extending = false;
    if (this.#state !== 'held' || this.#releasing) {
      // The lock ended, or our own release went out, while the request was in flight. A refusal
      // then can be that release's doing, so the answer says nothing about another holder.
      if (fromHeartbeat) {
        return;
      }
      this.#assertExtendable();
    }
    if (!extended) {
      this.#markLost('extend');
      throw this.#abort.signal.reason;
    }
    this.#ttl = ttl;
    this.#expiresAt = leaseEnd;
    this.#leaseStartedAt = startedAt;
    this.#finalLease = final;
    this.#extendError = undefined;
    this.#scheduleExpiry();
    if (!fromHeartbeat) {
      this.#scheduleHeartbeat();
    }
    this.#emit({ type: 'extended', key: this.key, ttl, heldMs: this.#heldMs() });
  }

  /** Only for a held lock. Every caller checks, and the end of holding clears the expiry timer. */
  #markLost(reason: LockLostReason, cause?: unknown): void {
    this.#state = 'lost';
    this.#lostReason = reason;
    this.#endedAt = this.#now();
    this.#clearTimers();
    this.#emit({ type: 'lost', key: this.key, ttl: this.#ttl, heldMs: this.#heldMs(), reason });
    this.#abort.abort(new LockLostError({ key: this.key, reason, cause }));
  }

  #onLocalExpiry(): void {
    if (this.#finalLease) {
      this.#markLost('max-hold');
      return;
    }
    const failure = this.#extendError;
    if (failure) {
      this.#markLost('extend-failed', failure.error);
      return;
    }
    this.#markLost(this.#extending ? 'late-extend' : 'expired');
  }

  /** The expiry timer can run late, after a pause or on a busy event loop, so a read checks the clock too. */
  #checkExpiry(): void {
    if (this.#state === 'held' && this.#now() >= this.#expiresAt) {
      this.#onLocalExpiry();
    }
  }

  #abandon(): void {
    this.#abandoned = true;
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#expiryTimer);
    const ms = Math.max(0, this.#expiresAt - this.#now());
    this.#expiryTimer = setTimeout(() => this.#onLocalExpiry(), ms);
    this.#expiryTimer.unref();
  }

  /**
   * The next tick runs one interval after the current lease was requested, not after its answer
   * arrived, so a slow backend eats into the slack of one lease instead of piling up across them.
   * `delay` overrides that for a retry.
   */
  #scheduleHeartbeat(delay?: number): void {
    if (!this.#heartbeat || this.#state !== 'held' || this.#finalLease || this.#abandoned) {
      return;
    }
    clearTimeout(this.#heartbeatTimer);
    const ms = Math.max(0, delay ?? this.#leaseStartedAt + this.#heartbeatInterval() - this.#now());
    this.#heartbeatTimer = setTimeout(() => {
      void this.#heartbeatTick();
    }, ms);
    this.#heartbeatTimer.unref();
  }

  #heartbeatInterval(): number {
    const explicit = this.#heartbeat?.interval;
    // An explicit interval stands while it leaves half the lease for the request. A manual
    // extension to a shorter TTL can break that, and the default takes over.
    if (explicit !== undefined && explicit * 2 <= this.#ttl) {
      return explicit;
    }
    return Math.max(1, Math.floor(this.#ttl / 3));
  }

  async #heartbeatTick(): Promise<void> {
    let retryIn: number | undefined;
    try {
      await this.#queueExtend({ fromHeartbeat: true });
    } catch {
      // A refusal or a late answer already ended the lock, and the schedule below stops there. A
      // request that threw leaves the lock held, so the next attempt comes sooner than a tick.
      retryIn = Math.max(1, Math.floor(this.#heartbeatInterval() / 3));
    }
    // A release in flight cleared the timer, and puts it back itself if it throws.
    if (this.#releasing) {
      return;
    }
    this.#scheduleHeartbeat(retryIn);
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
