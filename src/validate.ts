import type { LockAdapter } from './adapter';
import { ValidationError } from './errors';
import type { RetryOptions } from './types';

/** The largest delay `setTimeout` accepts. A longer one fires at once. */
export const MAX_DURATION_MS = 2_147_483_647;

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function assertKey(key: unknown, name = 'key'): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
}

export function assertKeys(keys: unknown): asserts keys is string[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ValidationError('keys must be a non-empty array of strings');
  }
  for (const key of keys) {
    assertKey(key, 'every key');
  }
}

export function assertDuration(value: unknown, name: string): asserts value is number {
  if (!isPositiveInteger(value) || value > MAX_DURATION_MS) {
    throw new ValidationError(
      `${name} must be a positive integer of milliseconds, up to ${MAX_DURATION_MS}`,
    );
  }
}

export function assertRetry(retry: unknown): asserts retry is RetryOptions | undefined {
  if (retry === undefined) {
    return;
  }
  if (typeof retry !== 'object' || retry === null) {
    throw new ValidationError('retry must be an object');
  }
  const { retries, delay, timeout } = retry as RetryOptions;
  if (retries !== undefined && retries !== Infinity && !isNonNegativeInteger(retries)) {
    throw new ValidationError('retry.retries must be an integer of 0 or more, or Infinity');
  }
  if (delay !== undefined && typeof delay !== 'function' && !isDelayValue(delay)) {
    throw new ValidationError(
      `retry.delay must be a number of milliseconds from 0 to ${MAX_DURATION_MS}, or a function`,
    );
  }
  if (timeout !== undefined) {
    assertDuration(timeout, 'retry.timeout');
  }
}

export function isDelayValue(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS
  );
}

export type NormalizedAutoExtend = {
  interval?: number;
  maxHold: number;
};

/**
 * A heartbeat always carries a deadline. Without one, a caller that never returns, or a callback
 * that never settles, would keep renewing the lease until the process dies, which is exactly the
 * failure a lease is meant to survive.
 */
export function assertAutoExtend(
  options: unknown,
  ttl: number,
): asserts options is NormalizedAutoExtend {
  if (typeof options !== 'object' || options === null) {
    throw new ValidationError(
      'autoExtend must be an object with maxHold, for example { maxHold: 600000 }',
    );
  }
  const { interval, maxHold } = options as Partial<NormalizedAutoExtend>;
  if (interval !== undefined) {
    assertDuration(interval, 'autoExtend.interval');
    // Each tick counts from the start of the lease it renews, so whatever the interval leaves of
    // the TTL is the time an extension has to come back, and to be tried again if it throws.
    if (interval * 2 > ttl) {
      throw new ValidationError('autoExtend.interval must be at most half the ttl');
    }
  }
  if (maxHold === undefined) {
    throw new ValidationError('autoExtend.maxHold is required, so a forgotten lock still expires');
  }
  assertDuration(maxHold, 'autoExtend.maxHold');
  if (maxHold < ttl) {
    throw new ValidationError('autoExtend.maxHold must be at least ttl');
  }
}

export function assertSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ValidationError('signal must be an AbortSignal');
  }
}

export function assertFunction(
  value: unknown,
  name: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== 'function') {
    throw new ValidationError(`${name} must be a function`);
  }
}

export function assertAdapter(adapter: unknown): asserts adapter is LockAdapter {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new ValidationError('adapter is required');
  }
  for (const method of ['acquire', 'release', 'extend', 'isHeld'] as const) {
    if (typeof (adapter as Record<string, unknown>)[method] !== 'function') {
      throw new ValidationError(`adapter.${method} must be a function`);
    }
  }
}
