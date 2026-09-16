import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import { DEFAULT_RETRY, exponentialBackoff, mergeRetry, wait } from '../retry';

describe('mergeRetry', () => {
  it('starts from the built-in default', () => {
    expect(mergeRetry()).toEqual(DEFAULT_RETRY);
    expect(mergeRetry(undefined, undefined)).toEqual(DEFAULT_RETRY);
  });

  it('lets a later layer override one field and keep the others', () => {
    expect(mergeRetry({ retries: 3 }, { delay: 50 })).toEqual({ retries: 3, delay: 50 });
    expect(mergeRetry({ retries: 3, delay: 10 }, { retries: 0 })).toEqual({
      retries: 0,
      delay: 10,
    });
  });

  it('carries timeout and a delay function through', () => {
    const delay = () => 5;
    expect(mergeRetry({ timeout: 1000 }, { delay })).toEqual({ retries: 10, delay, timeout: 1000 });
  });

  it('keeps DEFAULT_RETRY frozen, so nobody can change the default for the whole process', () => {
    // mergeRetry reads it on every acquisition. A mutation would reach every Locker in the
    // process, including ones in unrelated modules that never asked for it.
    expect(Object.isFrozen(DEFAULT_RETRY)).toBe(true);
    expect(() => {
      (DEFAULT_RETRY as { retries: number }).retries = 999;
    }).toThrow(TypeError);
    expect(mergeRetry().retries).toBe(10);
  });

  it('does not let a merged result alias the default', () => {
    const merged = mergeRetry({ delay: 1 });
    merged.retries = 0;
    expect(DEFAULT_RETRY.retries).toBe(10);
  });
});

describe('exponentialBackoff', () => {
  it('doubles from base and stops at max without jitter', async () => {
    const delay = exponentialBackoff({ base: 100, max: 500, jitter: false });
    const context = { elapsedMs: 0, previousDelay: 0 };
    expect(await delay({ attempt: 0, ...context })).toBe(100);
    expect(await delay({ attempt: 1, ...context })).toBe(200);
    expect(await delay({ attempt: 2, ...context })).toBe(400);
    expect(await delay({ attempt: 3, ...context })).toBe(500);
  });

  it('keeps a jittered delay inside the upper half', async () => {
    const delay = exponentialBackoff({ base: 100, max: 5000 });
    for (let i = 0; i < 50; i += 1) {
      const value = await delay({ attempt: 2, elapsedMs: 0, previousDelay: 0 });
      expect(value).toBeGreaterThanOrEqual(200);
      expect(value).toBeLessThanOrEqual(400);
    }
  });

  it('rejects a bad base or max', () => {
    expect(() => exponentialBackoff({ base: 0 })).toThrow(ValidationError);
    expect(() => exponentialBackoff({ max: -1 })).toThrow(ValidationError);
  });
});

describe('wait', () => {
  it('resolves after the delay', async () => {
    const startedAt = Date.now();
    await wait(20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it('rejects with the signal reason when aborted', async () => {
    const controller = new AbortController();
    const pending = wait(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(wait(10, controller.signal)).rejects.toThrow('early');
  });
});
