export type { LockAdapter, LockKeyParams, LockLeaseParams } from './adapter';
export {
  LoccoError,
  type LoccoErrorCode,
  LockHeldError,
  type LockHeldReason,
  LockLostError,
  type LockLostReason,
  LockStateError,
  ValidationError,
} from './errors';
export { Lock, type LockState } from './lock';
export { Locker, type LockerOptions } from './locker';
export { LockSet } from './lockSet';
export { type BackoffOptions, DEFAULT_RETRY, exponentialBackoff } from './retry';
export type {
  AcquireOptions,
  AutoExtendOptions,
  ContendedReason,
  DelayContext,
  DelayFn,
  LockEvent,
  LockEventHandler,
  ResolvedRetry,
  RetryOptions,
  TryAcquireOptions,
  WithLockOptions,
} from './types';
