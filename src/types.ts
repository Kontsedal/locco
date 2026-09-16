import type { LockLostReason } from './errors';

export type DelayContext = {
  /** Zero-based index of the attempt that just failed. */
  attempt: number;
  /** Milliseconds since the acquisition started. */
  elapsedMs: number;
  /** The delay returned before the previous attempt, 0 on the first retry. */
  previousDelay: number;
};

export type DelayFn = (context: DelayContext) => number | Promise<number>;

export type RetryOptions = {
  /** Attempts after the first one. 0 means one attempt. Infinity means until `timeout` or the signal. */
  retries?: number;
  /** Milliseconds between attempts, or a function that returns them. May be 0. */
  delay?: number | DelayFn;
  /** Cap on the whole acquisition in milliseconds, waits included. */
  timeout?: number;
};

export type ResolvedRetry = {
  retries: number;
  delay: number | DelayFn;
  timeout?: number;
};

export type AutoExtendOptions = {
  /** Milliseconds between extensions. Defaults to a third of the TTL. Must be smaller than the TTL. */
  interval?: number;
  /** Deadline on ownership in milliseconds from acquisition. The local lease ends at it; the backend lease can outlive it by the time the last extension spent in flight. */
  maxHold: number;
};

export type AcquireOptions = {
  /** Lease length in milliseconds. */
  ttl: number;
  retry?: RetryOptions;
  signal?: AbortSignal;
  autoExtend?: AutoExtendOptions;
};

export type TryAcquireOptions = Omit<AcquireOptions, 'retry' | 'signal'>;

/** `withLock` takes the same options as `acquire`, `maxHold` included. */
export type WithLockOptions = AcquireOptions;

type LockEventBase = {
  /** The key as stored in the backend, prefix included. */
  key: string;
  ttl: number;
};

/**
 * Why an attempt yielded no lock. `held` means another holder had the key. `late` means the
 * backend granted it to us but answered after the lease could have ended, so the key was
 * given back. A run of `late` events points at the backend, not at a busy key.
 */
export type ContendedReason = 'held' | 'late';

export type LockEvent =
  | (LockEventBase & { type: 'acquired'; waitedMs: number; attempts: number })
  | (LockEventBase & {
      type: 'contended';
      attempt: number;
      elapsedMs: number;
      reason: ContendedReason;
    })
  | (LockEventBase & { type: 'extended'; heldMs: number })
  | (LockEventBase & { type: 'released'; heldMs: number })
  | (LockEventBase & { type: 'lost'; heldMs: number; reason: LockLostReason })
  | (LockEventBase & { type: 'releaseFailed'; heldMs: number; error: unknown });

export type LockEventHandler = (event: LockEvent) => void | Promise<void>;
