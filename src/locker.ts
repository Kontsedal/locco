import { randomBytes } from 'node:crypto';
import type { LockAdapter } from './adapter';
import { createSystemClock } from './clock';
import { LockHeldError, LockLostError, ValidationError } from './errors';
import { abandonLock, type HeartbeatConfig, Lock, leaseValidity } from './lock';
import { LockSet } from './lockSet';
import { mergeRetry, wait } from './retry';
import type {
  AcquireOptions,
  ContendedReason,
  LockEvent,
  LockEventHandler,
  ResolvedRetry,
  RetryOptions,
  TryAcquireOptions,
  WithLockOptions,
} from './types';
import {
  assertAdapter,
  assertAutoExtend,
  assertDuration,
  assertFunction,
  assertKey,
  assertKeys,
  assertRetry,
  assertSignal,
  isDelayValue,
} from './validate';

export type LockerOptions = {
  adapter: LockAdapter;
  /** Default retry policy. Each field can be overridden per call. */
  retry?: RetryOptions;
  /** Prepended to every key before it reaches the adapter. Default ''. */
  keyPrefix?: string;
  /** Receives one object per lock event. What it throws or rejects is dropped. */
  onEvent?: LockEventHandler;
  /**
   * A monotonic clock in milliseconds. Default: `performance.now`, plus any time the machine spent
   * paused that only the wall clock saw. Tests replace it.
   */
  now?: () => number;
  /** Token generator. Default 16 random bytes as hex. Tests replace it. */
  token?: () => string;
};

type Normalized = {
  ttl: number;
  retry: ResolvedRetry;
  signal: AbortSignal | undefined;
  heartbeat: HeartbeatConfig | undefined;
};

/** What every acquire method accepts once `withLock` has turned its `autoExtend` into a config. */
type NormalizeInput = {
  ttl: number;
  retry?: RetryOptions;
  signal?: AbortSignal;
  autoExtend?: HeartbeatConfig;
};

type Prepared = Normalized & { key: string };

/**
 * An attempt either wins a usable lock or does not. `late` is not contention: the backend granted
 * the key but answered so slowly that the lease could already have ended, so the key was given
 * back. Reporting that as `held` would tell a caller another holder has a key that is in fact free.
 */
type Attempt = { lock: Lock } | { lock: null; reason: ContendedReason };

const defaultToken = (): string => randomBytes(16).toString('hex');

export class Locker {
  readonly #adapter: LockAdapter;
  readonly #retry: RetryOptions | undefined;
  readonly #keyPrefix: string;
  readonly #onEvent: LockEventHandler | undefined;
  readonly #now: () => number;
  readonly #token: () => string;

  constructor(options: LockerOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new ValidationError('options must be an object');
    }
    assertAdapter(options.adapter);
    assertRetry(options.retry);
    if (options.keyPrefix !== undefined && typeof options.keyPrefix !== 'string') {
      throw new ValidationError('keyPrefix must be a string');
    }
    if (options.onEvent !== undefined) {
      assertFunction(options.onEvent, 'onEvent');
    }
    if (options.now !== undefined) {
      assertFunction(options.now, 'now');
    }
    if (options.token !== undefined) {
      assertFunction(options.token, 'token');
    }
    this.#adapter = options.adapter;
    this.#retry = options.retry;
    this.#keyPrefix = options.keyPrefix ?? '';
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? createSystemClock();
    this.#token = options.token ?? defaultToken;
  }

  /** Acquires the key, retrying while another holder has it. Throws LockHeldError when the budget runs out. */
  async acquire(key: string, options: AcquireOptions): Promise<Lock> {
    assertKey(key);
    const normalized = this.#normalize(options);
    return this.#acquireWithRetry({ key: this.#fullKey(key), ...normalized });
  }

  /**
   * One attempt. Returns null when another holder has the key, so `if (!lock) return` is safe.
   * Throws LockHeldError with reason `late-acquire` when the backend granted the key but answered
   * too slowly to use it, because nobody holds the key then and skipping the work would be wrong.
   * Ignores the retry options.
   */
  async tryAcquire(key: string, options: TryAcquireOptions): Promise<Lock | null> {
    assertKey(key);
    const normalized = this.#normalize(options);
    const prepared: Prepared = { key: this.#fullKey(key), ...normalized };
    const startedAt = this.#now();
    const attempt = await this.#attempt(prepared, startedAt, 1);
    if (attempt.lock) {
      return attempt.lock;
    }
    const elapsedMs = this.#elapsed(startedAt);
    this.#emit({
      type: 'contended',
      key: prepared.key,
      ttl: prepared.ttl,
      attempt: 0,
      elapsedMs,
      reason: attempt.reason,
    });
    if (attempt.reason === 'late') {
      throw new LockHeldError({
        key: prepared.key,
        attempts: 1,
        elapsedMs,
        reason: 'late-acquire',
      });
    }
    return null;
  }

  /**
   * Runs `fn` with a held lock and releases it afterwards. When the callback returned but the
   * lock was lost, throws LockLostError with the callback's value in `result`.
   */
  async withLock<T>(
    key: string,
    options: WithLockOptions,
    fn: (lock: Lock) => T | Promise<T>,
  ): Promise<T> {
    assertKey(key);
    assertFunction(fn, 'fn');
    const normalized = this.#normalize(options);
    const lock = await this.#acquireWithRetry({ key: this.#fullKey(key), ...normalized });
    let result: T;
    try {
      result = await fn(lock);
    } catch (error) {
      await this.#releaseQuietly(lock);
      throw error;
    }
    // `lostReason` covers both a loss during the work and a release the callback ran itself that
    // found the key not ours. `state` alone would miss the second: it reads `released` there.
    if (lock.lostReason !== undefined) {
      await this.#releaseQuietly(lock);
      throw new LockLostError({
        key: lock.key,
        reason: lock.lostReason,
        completed: true,
        result,
        cause: lock.signal.reason,
      });
    }
    // The callback released the lock itself and the key was still ours. Nothing went wrong, and
    // a second release would answer `false` and turn a clean run into a LockLostError.
    if (lock.state === 'released') {
      return result;
    }
    // The work finished under a held lock, so a release that throws does not take its value away:
    // the error goes to a `releaseFailed` event and the lease runs out on its own. Throwing here
    // would invite a caller to run finished work a second time.
    const released = await this.#releaseQuietly(lock);
    if (released === false) {
      throw new LockLostError({
        key: lock.key,
        reason: 'release',
        completed: true,
        result,
        cause: lock.signal.reason,
      });
    }
    return result;
  }

  /**
   * Acquires every key, one by one in sorted order, under one timeout. Each key gets the whole
   * `retries` budget of its own. Rolls every acquired lock back when one key fails. Refreshes every
   * lease before it returns, so the leases overlap.
   */
  async acquireMany(keys: string[], options: AcquireOptions): Promise<LockSet> {
    assertKeys(keys);
    const normalized = this.#normalize(options);
    const uniqueKeys = [...new Set(keys)].sort();
    const startedAt = this.#now();
    const deadline =
      normalized.retry.timeout === undefined ? undefined : startedAt + normalized.retry.timeout;
    const locks: Lock[] = [];
    let lastKey = '';
    try {
      for (const key of uniqueKeys) {
        lastKey = this.#fullKey(key);
        locks.push(await this.#acquireWithRetry({ key: lastKey, ...normalized }, deadline));
      }
      normalized.signal?.throwIfAborted();
      await this.#refreshSet(locks, normalized.ttl, startedAt, deadline, lastKey);
      normalized.signal?.throwIfAborted();
      return new LockSet(locks, (event) => this.#emit(event));
    } catch (error) {
      await Promise.all(locks.map((lock) => this.#releaseQuietly(lock)));
      throw error;
    }
  }

  #fullKey(key: string): string {
    return this.#keyPrefix + key;
  }

  #elapsed(since: number): number {
    return Math.round(this.#now() - since);
  }

  #normalize(options: NormalizeInput): Normalized {
    if (typeof options !== 'object' || options === null) {
      throw new ValidationError('options must be an object');
    }
    const { ttl, autoExtend, retry, signal } = options;
    assertDuration(ttl, 'ttl');
    assertRetry(retry);
    assertSignal(signal);
    let heartbeat: HeartbeatConfig | undefined;
    if (autoExtend !== undefined) {
      assertAutoExtend(autoExtend, ttl);
      heartbeat = { interval: autoExtend.interval, maxHold: autoExtend.maxHold };
    }
    return { ttl, retry: mergeRetry(this.#retry, retry), signal, heartbeat };
  }

  async #acquireWithRetry(prepared: Prepared, sharedDeadline?: number): Promise<Lock> {
    const { key, ttl, retry, signal } = prepared;
    const startedAt = this.#now();
    const deadline =
      sharedDeadline ?? (retry.timeout === undefined ? undefined : startedAt + retry.timeout);
    let attempt = 0;
    let previousDelay = 0;
    // What stopped the most recent attempt, so the final error blames the right thing: a busy key
    // or a backend too slow to hand back a usable lease.
    let lastReason: ContendedReason = 'held';
    for (;;) {
      signal?.throwIfAborted();
      if (deadline !== undefined && this.#now() >= deadline) {
        throw new LockHeldError({
          key,
          attempts: attempt,
          elapsedMs: this.#elapsed(startedAt),
          reason: 'timeout',
        });
      }
      const outcome = await this.#attempt(prepared, startedAt, attempt + 1);
      if (outcome.lock) {
        if (signal?.aborted) {
          // The caller cancelled while the backend was answering. The lock is not wanted.
          await this.#releaseQuietly(outcome.lock);
          throw signal.reason;
        }
        return outcome.lock;
      }
      lastReason = outcome.reason;
      const elapsedMs = this.#elapsed(startedAt);
      this.#emit({ type: 'contended', key, ttl, attempt, elapsedMs, reason: lastReason });
      if (attempt >= retry.retries) {
        throw new LockHeldError({
          key,
          attempts: attempt + 1,
          elapsedMs,
          reason: lastReason === 'late' ? 'late-acquire' : 'retries',
        });
      }
      const delay = await this.#delayFor(retry, attempt, elapsedMs, previousDelay);
      // A slow delay function cannot be interrupted, so the signal is read again after it.
      signal?.throwIfAborted();
      if (deadline !== undefined && this.#now() + delay >= deadline) {
        throw new LockHeldError({ key, attempts: attempt + 1, elapsedMs, reason: 'timeout' });
      }
      await wait(delay, signal);
      previousDelay = delay;
      attempt += 1;
    }
  }

  async #delayFor(
    retry: ResolvedRetry,
    attempt: number,
    elapsedMs: number,
    previousDelay: number,
  ): Promise<number> {
    const delay =
      typeof retry.delay === 'function'
        ? await retry.delay({ attempt, elapsedMs, previousDelay })
        : retry.delay;
    if (!isDelayValue(delay)) {
      throw new ValidationError('retry.delay must return a number of milliseconds of 0 or more');
    }
    return delay;
  }

  async #attempt(prepared: Prepared, startedAt: number, attempts: number): Promise<Attempt> {
    const { key, ttl } = prepared;
    const token = this.#token();
    const requestedAt = this.#now();
    let acquired: boolean;
    try {
      acquired = await this.#adapter.acquire({ key, token, ttl });
    } catch (error) {
      this.#giveBack(key, token);
      throw error;
    }
    if (!acquired) {
      return { lock: null, reason: 'held' };
    }
    if (this.#now() - requestedAt >= leaseValidity(ttl)) {
      // The answer came after the lease could have ended, so the lock is not usable.
      // Give the key back so the next caller does not wait for the expiry.
      try {
        await this.#adapter.release({ key, token });
      } catch (error) {
        this.#emit({ type: 'releaseFailed', key, ttl, heldMs: this.#elapsed(requestedAt), error });
      }
      return { lock: null, reason: 'late' };
    }
    const lock = new Lock({
      adapter: this.#adapter,
      key,
      token,
      ttl,
      retry: prepared.retry,
      acquiredAt: requestedAt,
      now: this.#now,
      emit: (event) => this.#emit(event),
      heartbeat: prepared.heartbeat,
    });
    this.#emit({ type: 'acquired', key, ttl, waitedMs: this.#elapsed(startedAt), attempts });
    return { lock };
  }

  /** Gives every lease of the set a fresh TTL. An earlier lease that already ran out fails the set. */
  async #refreshSet(
    locks: Lock[],
    ttl: number,
    startedAt: number,
    deadline: number | undefined,
    lastKey: string,
  ): Promise<void> {
    if (deadline !== undefined && this.#now() >= deadline) {
      throw new LockHeldError({
        key: lastKey,
        attempts: locks.length,
        elapsedMs: this.#elapsed(startedAt),
        reason: 'timeout',
      });
    }
    // Each outcome carries its own lock, so nothing has to line results up with the array by index.
    const outcomes = await Promise.all(
      locks.map(async (lock) => {
        try {
          await lock.extend(ttl);
          return { lock, error: undefined };
        } catch (error) {
          return { lock, error };
        }
      }),
    );
    const failure = outcomes.find((outcome) => outcome.error !== undefined);
    if (failure) {
      // A driver error is not contention and must not be reported as a busy key.
      if (!(failure.error instanceof LockLostError)) {
        throw failure.error;
      }
      throw this.#setExpired(failure.lock.key, locks.length, startedAt);
    }
    // A member can be lost while a slower member was still being refreshed.
    const lost = locks.find((lock) => lock.state !== 'held');
    if (lost) {
      throw this.#setExpired(lost.key, locks.length, startedAt);
    }
  }

  #setExpired(key: string, attempts: number, startedAt: number): LockHeldError {
    return new LockHeldError({
      key,
      attempts,
      elapsedMs: this.#elapsed(startedAt),
      reason: 'expired',
    });
  }

  /**
   * An acquire that threw may still have set the key before its answer was lost. The token is
   * ours alone, so a release with it removes that key and nothing else. It is not awaited: with the
   * backend down it would fail too, and only after delaying the error the caller is waiting for.
   */
  #giveBack(key: string, token: string): void {
    Promise.resolve()
      .then(() => this.#adapter.release({ key, token }))
      .catch(() => undefined);
  }

  /**
   * Releases a lock that nobody will release again. Answers undefined when the release threw: the
   * error goes to a `releaseFailed` event and the heartbeat stops, so the lease runs out on its
   * own instead of being renewed until the hold deadline.
   */
  async #releaseQuietly(lock: Lock): Promise<boolean | undefined> {
    try {
      return await lock.release();
    } catch (error) {
      abandonLock(lock);
      this.#emit({
        type: 'releaseFailed',
        key: lock.key,
        ttl: lock.ttl,
        heldMs: lock.heldMs,
        error,
      });
      return undefined;
    }
  }

  #emit(event: LockEvent): void {
    const handler = this.#onEvent;
    if (!handler) {
      return;
    }
    try {
      const result = handler(event);
      // Duck-typed, not `instanceof Promise`: a handler built on a promise library, downleveled
      // onto a polyfill, or created in another realm returns a thenable that fails that test, and
      // its rejection would escape as an unhandled rejection and take the process down.
      if (typeof (result as PromiseLike<void> | undefined)?.then === 'function') {
        Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // A logging hook must not lose an acquired handle or change lock control flow.
    }
  }
}
