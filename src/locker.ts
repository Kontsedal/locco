import { randomBytes } from 'node:crypto';
import type { LockAdapter } from './adapter';
import { LockHeldError, LockLostError, ValidationError } from './errors';
import { type HeartbeatConfig, Lock } from './lock';
import { LockSet } from './lockSet';
import { mergeRetry, wait } from './retry';
import type {
  AcquireOptions,
  LockEvent,
  LockEventHandler,
  ResolvedRetry,
  RetryOptions,
  TryAcquireOptions,
  WithLockAutoExtend,
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
  /** A monotonic clock in milliseconds. Default `performance.now`. Tests replace it. */
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

const defaultToken = (): string => randomBytes(16).toString('hex');

// A wall clock can step backwards, which would push the local expiry estimate past the backend's.
const defaultNow = (): number => performance.now();

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
    this.#now = options.now ?? defaultNow;
    this.#token = options.token ?? defaultToken;
  }

  /** Acquires the key, retrying while another holder has it. Throws LockHeldError when the budget runs out. */
  async acquire(key: string, options: AcquireOptions): Promise<Lock> {
    assertKey(key);
    const normalized = this.#normalize(options, true);
    return this.#acquireWithRetry({ key: this.#fullKey(key), ...normalized });
  }

  /** One attempt. Returns null when another holder has the key. Ignores the retry options. */
  async tryAcquire(key: string, options: TryAcquireOptions): Promise<Lock | null> {
    assertKey(key);
    const normalized = this.#normalize(options, true);
    const prepared: Prepared = { key: this.#fullKey(key), ...normalized };
    const startedAt = this.#now();
    const lock = await this.#attempt(prepared, startedAt, 1);
    if (!lock) {
      this.#emit({
        type: 'contended',
        key: prepared.key,
        ttl: prepared.ttl,
        attempt: 0,
        elapsedMs: this.#elapsed(startedAt),
      });
    }
    return lock;
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
    const normalized = this.#normalize(
      { ...options, autoExtend: normalizeWithLockAutoExtend(options?.autoExtend) },
      false,
    );
    const lock = await this.#acquireWithRetry({ key: this.#fullKey(key), ...normalized });
    let result: T;
    try {
      result = await fn(lock);
    } catch (error) {
      await this.#releaseQuietly(lock);
      throw error;
    }
    if (lock.state === 'lost') {
      await this.#releaseQuietly(lock);
      throw new LockLostError({
        key: lock.key,
        reason: lock.lostReason ?? 'expired',
        completed: true,
        result,
        cause: lock.signal.reason,
      });
    }
    const released = await lock.release();
    if (!released) {
      throw new LockLostError({ key: lock.key, reason: 'release', completed: true, result });
    }
    return result;
  }

  /**
   * Acquires every key, one by one in sorted order, under one timeout. Rolls every acquired lock
   * back when one key fails. Refreshes every lease before it returns, so the leases overlap.
   */
  async acquireMany(keys: string[], options: AcquireOptions): Promise<LockSet> {
    assertKeys(keys);
    const normalized = this.#normalize(options, true);
    const uniqueKeys = [...new Set(keys)].sort();
    const startedAt = this.#now();
    const deadline =
      normalized.retry.timeout === undefined ? undefined : startedAt + normalized.retry.timeout;
    const locks: Lock[] = [];
    try {
      for (const key of uniqueKeys) {
        locks.push(
          await this.#acquireWithRetry({ key: this.#fullKey(key), ...normalized }, deadline),
        );
      }
      normalized.signal?.throwIfAborted();
      await this.#refreshSet(locks, normalized.ttl, startedAt, deadline);
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

  #normalize(options: NormalizeInput, maxHoldRequired: boolean): Normalized {
    if (typeof options !== 'object' || options === null) {
      throw new ValidationError('options must be an object');
    }
    const { ttl, autoExtend, retry, signal } = options;
    assertDuration(ttl, 'ttl');
    assertRetry(retry);
    assertSignal(signal);
    let heartbeat: HeartbeatConfig | undefined;
    if (autoExtend !== undefined) {
      assertAutoExtend(autoExtend, ttl, maxHoldRequired);
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
      const lock = await this.#attempt(prepared, startedAt, attempt + 1);
      if (lock) {
        if (signal?.aborted) {
          // The caller cancelled while the backend was answering. The lock is not wanted.
          await this.#releaseQuietly(lock);
          throw signal.reason;
        }
        return lock;
      }
      const elapsedMs = this.#elapsed(startedAt);
      this.#emit({ type: 'contended', key, ttl, attempt, elapsedMs });
      if (attempt >= retry.retries) {
        throw new LockHeldError({ key, attempts: attempt + 1, elapsedMs, reason: 'retries' });
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

  async #attempt(prepared: Prepared, startedAt: number, attempts: number): Promise<Lock | null> {
    const { key, ttl } = prepared;
    const token = this.#token();
    const requestedAt = this.#now();
    const acquired = await this.#adapter.acquire({ key, token, ttl });
    if (!acquired) {
      return null;
    }
    const elapsedMs = this.#elapsed(requestedAt);
    if (elapsedMs >= ttl) {
      // The answer came after the lease could have ended, so the lock is not usable.
      // Give the key back so the next caller does not wait for the expiry.
      try {
        await this.#adapter.release({ key, token });
      } catch (error) {
        this.#emit({ type: 'releaseFailed', key, ttl, heldMs: elapsedMs, error });
      }
      return null;
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
    return lock;
  }

  /** Gives every lease of the set a fresh TTL. An earlier lease that already ran out fails the set. */
  async #refreshSet(
    locks: Lock[],
    ttl: number,
    startedAt: number,
    deadline: number | undefined,
  ): Promise<void> {
    const lastKey = locks.at(-1)?.key ?? '';
    if (deadline !== undefined && this.#now() >= deadline) {
      throw new LockHeldError({
        key: lastKey,
        attempts: locks.length,
        elapsedMs: this.#elapsed(startedAt),
        reason: 'timeout',
      });
    }
    const results = await Promise.allSettled(locks.map((lock) => lock.extend(ttl)));
    const failed = results.findIndex((result) => result.status === 'rejected');
    if (failed !== -1) {
      const failure = results[failed];
      if (failure?.status === 'rejected' && !(failure.reason instanceof LockLostError)) {
        throw failure.reason;
      }
      throw this.#setExpired(locks[failed]?.key ?? lastKey, locks.length, startedAt);
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

  async #releaseQuietly(lock: Lock): Promise<void> {
    try {
      await lock.release();
    } catch (error) {
      this.#emit({ type: 'releaseFailed', key: lock.key, ttl: lock.ttl, heldMs: 0, error });
    }
  }

  #emit(event: LockEvent): void {
    const handler = this.#onEvent;
    if (!handler) {
      return;
    }
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        result.catch(() => undefined);
      }
    } catch {
      // A logging hook must not lose an acquired handle or change lock control flow.
    }
  }
}

function normalizeWithLockAutoExtend(
  autoExtend: WithLockAutoExtend | undefined,
): HeartbeatConfig | undefined {
  if (autoExtend === undefined || autoExtend === false) {
    return undefined;
  }
  if (autoExtend === true) {
    return {};
  }
  return autoExtend;
}
