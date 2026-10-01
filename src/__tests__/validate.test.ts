import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import {
  assertAdapter,
  assertAutoExtend,
  assertDuration,
  assertKey,
  assertKeys,
  assertRetry,
  assertSignal,
  MAX_DURATION_MS,
} from '../validate';

describe('validate', () => {
  it('assertKey wants a non-empty string', () => {
    expect(() => assertKey('')).toThrow(ValidationError);
    expect(() => assertKey(1)).toThrow(ValidationError);
    expect(() => assertKey('a')).not.toThrow();
  });

  it('assertKeys wants a non-empty array of keys', () => {
    expect(() => assertKeys([])).toThrow(ValidationError);
    expect(() => assertKeys(['a', ''])).toThrow(ValidationError);
    expect(() => assertKeys('a')).toThrow(ValidationError);
    expect(() => assertKeys(['a'])).not.toThrow();
  });

  it('assertDuration wants a positive integer that a timer accepts', () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '10',
      MAX_DURATION_MS + 1,
    ]) {
      expect(() => assertDuration(bad, 'ttl')).toThrow(ValidationError);
    }
    expect(() => assertDuration(1, 'ttl')).not.toThrow();
    expect(() => assertDuration(MAX_DURATION_MS, 'ttl')).not.toThrow();
  });

  it('assertRetry accepts zero, Infinity, a function and a partial object', () => {
    expect(() => assertRetry(undefined)).not.toThrow();
    expect(() => assertRetry({})).not.toThrow();
    expect(() => assertRetry({ retries: 0 })).not.toThrow();
    expect(() => assertRetry({ retries: Number.POSITIVE_INFINITY, delay: 0 })).not.toThrow();
    expect(() => assertRetry({ delay: () => 1 })).not.toThrow();
    expect(() => assertRetry({ timeout: 100 })).not.toThrow();
  });

  it('assertRetry rejects wrong shapes', () => {
    expect(() => assertRetry(null)).toThrow(ValidationError);
    expect(() => assertRetry('x')).toThrow(ValidationError);
    expect(() => assertRetry({ retries: -1 })).toThrow(ValidationError);
    expect(() => assertRetry({ retries: 1.5 })).toThrow(ValidationError);
    expect(() => assertRetry({ delay: -1 })).toThrow(ValidationError);
    expect(() => assertRetry({ delay: 'x' })).toThrow(ValidationError);
    expect(() => assertRetry({ timeout: 0 })).toThrow(ValidationError);
    expect(() => assertRetry({ delay: MAX_DURATION_MS + 1 })).toThrow(ValidationError);
    expect(() => assertRetry({ delay: MAX_DURATION_MS })).not.toThrow();
    expect(() => assertRetry({ delay: 12.5 })).not.toThrow();
  });

  it('assertAutoExtend enforces the interval margin and the hold deadline', () => {
    expect(() => assertAutoExtend({ maxHold: 1000 }, 100)).not.toThrow();
    expect(() => assertAutoExtend({ interval: 30, maxHold: 1000 }, 100)).not.toThrow();
    expect(() => assertAutoExtend({ interval: 50, maxHold: 1000 }, 100)).not.toThrow();
    // An interval past half the TTL leaves an extension too little time to come back.
    expect(() => assertAutoExtend({ interval: 51, maxHold: 1000 }, 100)).toThrow(
      /interval must be at most half the ttl/,
    );
    expect(() => assertAutoExtend({ maxHold: 50 }, 100)).toThrow(/at least ttl/);
  });

  it('assertAutoExtend always demands a hold deadline', () => {
    // Without one, a caller that never returns renews the lease until the process dies, which is
    // the failure a lease exists to survive. There is no call shape that may skip it.
    expect(() => assertAutoExtend({}, 100)).toThrow(/maxHold is required/);
    expect(() => assertAutoExtend({ interval: 30 }, 100)).toThrow(/maxHold is required/);
    expect(() => assertAutoExtend(true, 100)).toThrow(/must be an object with maxHold/);
    expect(() => assertAutoExtend(null, 100)).toThrow(ValidationError);
  });

  it('assertSignal wants an AbortSignal or nothing', () => {
    expect(() => assertSignal(undefined)).not.toThrow();
    expect(() => assertSignal(new AbortController().signal)).not.toThrow();
    expect(() => assertSignal({})).toThrow(ValidationError);
  });

  it('assertAdapter wants the four methods', () => {
    const full = { acquire() {}, release() {}, extend() {}, isHeld() {} };
    expect(() => assertAdapter(full)).not.toThrow();
    expect(() => assertAdapter(null)).toThrow(ValidationError);
    expect(() => assertAdapter({ ...full, isHeld: undefined })).toThrow(/adapter.isHeld/);
  });
});
