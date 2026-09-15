import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockAdapter } from '../adapter';
import { InMemoryAdapter } from '../adapters/inMemory';
import {
  LoccoError,
  LockHeldError,
  LockLostError,
  LockStateError,
  ValidationError,
} from '../errors';
import { Locker, type LockerOptions } from '../locker';
import { wait } from '../retry';
import type { LockEvent } from '../types';

const TTL = 1000;

function setup(options: Partial<LockerOptions> = {}) {
  const adapter = new InMemoryAdapter({ now: () => Date.now() });
  const events: LockEvent[] = [];
  const locker = new Locker({
    adapter,
    now: () => Date.now(),
    onEvent: (event) => {
      events.push(event);
    },
    retry: { retries: 0 },
    ...options,
  });
  const types = () => events.map((event) => event.type);
  return { adapter, events, locker, types };
}

/** Wraps an adapter so one method answers only after `ms` of fake time. */
function slowAdapter(adapter: LockAdapter, method: 'acquire' | 'extend', ms: number): LockAdapter {
  return {
    acquire: (p) => adapter.acquire(p),
    release: (p) => adapter.release(p),
    extend: (p) => adapter.extend(p),
    isHeld: (p) => adapter.isHeld(p),
    [method]: async (p: never) => {
      const answer = await adapter[method](p);
      await wait(ms);
      return answer;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Locker constructor', () => {
  it('validates its options', () => {
    const adapter = new InMemoryAdapter();
    expect(() => new Locker(null as never)).toThrow(ValidationError);
    expect(() => new Locker({ adapter: {} as never })).toThrow(ValidationError);
    expect(() => new Locker({ adapter, retry: { retries: -1 } })).toThrow(ValidationError);
    expect(() => new Locker({ adapter, keyPrefix: 1 as never })).toThrow(ValidationError);
    expect(() => new Locker({ adapter, onEvent: 'x' as never })).toThrow(ValidationError);
    expect(() => new Locker({ adapter })).not.toThrow();
  });
});

describe('acquire', () => {
  it('returns a held lock and reports it', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    expect(lock.state).toBe('held');
    expect(lock.key).toBe('k');
    expect(lock.ttl).toBe(TTL);
    expect(lock.token).toMatch(/^[0-9a-f]{32}$/);
    await expect(adapter.isHeld({ key: 'k', token: lock.token })).resolves.toBe(true);
    expect(events).toEqual([{ type: 'acquired', key: 'k', ttl: TTL, waitedMs: 0, attempts: 1 }]);
  });

  it('validates the key and the options', async () => {
    const { locker } = setup();
    await expect(locker.acquire('', { ttl: TTL })).rejects.toThrow(ValidationError);
    await expect(locker.acquire('k', { ttl: 0 })).rejects.toThrow(ValidationError);
    await expect(locker.acquire('k', null as never)).rejects.toThrow(ValidationError);
    await expect(locker.acquire('k', { ttl: TTL, retry: { delay: -1 } })).rejects.toThrow(
      ValidationError,
    );
    await expect(locker.acquire('k', { ttl: TTL, signal: {} as never })).rejects.toThrow(
      ValidationError,
    );
    await expect(locker.acquire('k', { ttl: TTL, autoExtend: {} as never })).rejects.toThrow(
      /maxHold is required/,
    );
  });

  it('merges retry options per field and exposes the result on the lock', async () => {
    const { locker } = setup({ retry: { retries: 3, delay: 10 } });
    const lock = await locker.acquire('k', { ttl: TTL, retry: { delay: 50 } });
    expect(lock.retry).toEqual({ retries: 3, delay: 50 });
  });

  it('prefixes the key before it reaches the adapter', async () => {
    const { adapter, locker, events } = setup({ keyPrefix: 'app:' });
    const lock = await locker.acquire('k', { ttl: TTL });
    expect(lock.key).toBe('app:k');
    await expect(adapter.isHeld({ key: 'app:k', token: lock.token })).resolves.toBe(true);
    expect(events[0]?.key).toBe('app:k');
  });

  it('retries while another holder has the key and wins after the release', async () => {
    const { locker, types } = setup();
    const first = await locker.acquire('k', { ttl: TTL });
    const pending = locker.acquire('k', { ttl: TTL, retry: { retries: 5, delay: 100 } });
    await vi.advanceTimersByTimeAsync(150);
    await first.release();
    await vi.advanceTimersByTimeAsync(100);
    const second = await pending;
    expect(second.state).toBe('held');
    expect(types().filter((type) => type === 'contended')).toHaveLength(2);
    const acquired = types().lastIndexOf('acquired');
    expect(acquired).toBe(types().length - 1);
  });

  it('throws LockHeldError when the retry budget is spent', async () => {
    const { locker } = setup();
    await locker.acquire('k', { ttl: TTL });
    const pending = locker.acquire('k', { ttl: TTL, retry: { retries: 2, delay: 10 } });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await failure;
    expect(error).toBeInstanceOf(LockHeldError);
    expect(error).toMatchObject({ code: 'LOCK_HELD', key: 'k', attempts: 3, reason: 'retries' });
  });

  it('stops at the timeout and does not start an attempt after it', async () => {
    const { adapter, locker } = setup();
    await locker.acquire('k', { ttl: TTL });
    const spy = vi.spyOn(adapter, 'acquire');
    const pending = locker.acquire('k', {
      ttl: TTL,
      retry: { retries: Number.POSITIVE_INFINITY, delay: 100, timeout: 250 },
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await failure;
    expect(error).toMatchObject({ code: 'LOCK_HELD', reason: 'timeout', attempts: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('rejects with the signal reason when aborted while waiting', async () => {
    const { locker } = setup();
    await locker.acquire('k', { ttl: TTL });
    const controller = new AbortController();
    const pending = locker.acquire('k', {
      ttl: TTL,
      retry: { retries: 10, delay: 1000 },
      signal: controller.signal,
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error('cancelled'));
    await expect(failure).resolves.toMatchObject({ message: 'cancelled' });
  });

  it('feeds the delay function with attempt, elapsed time and the previous delay', async () => {
    const { locker } = setup();
    await locker.acquire('k', { ttl: TTL });
    const delay = vi.fn(async ({ attempt }: { attempt: number }) => (attempt + 1) * 10);
    const pending = locker.acquire('k', { ttl: TTL, retry: { retries: 2, delay } });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(delay).toHaveBeenNthCalledWith(1, { attempt: 0, elapsedMs: 0, previousDelay: 0 });
    expect(delay).toHaveBeenNthCalledWith(2, { attempt: 1, elapsedMs: 10, previousDelay: 10 });
  });

  it('rejects a delay function that returns a bad value', async () => {
    const { locker } = setup();
    await locker.acquire('k', { ttl: TTL });
    await expect(
      locker.acquire('k', { ttl: TTL, retry: { retries: 1, delay: () => -5 } }),
    ).rejects.toThrow(ValidationError);
  });

  it('treats an answer that arrives after the lease as a failed attempt and gives the key back', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const slow = slowAdapter(memory, 'acquire', 150);
    const release = vi.spyOn(slow, 'release');
    const locker = new Locker({ adapter: slow, now: () => Date.now(), retry: { retries: 0 } });
    const pending = locker.tryAcquire('k', { ttl: 100 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBeNull();
    expect(release).toHaveBeenCalledWith({ key: 'k', token: expect.any(String) });
  });
});

describe('tryAcquire', () => {
  it('returns the lock or null and never retries', async () => {
    const { adapter, locker, events } = setup({ retry: { retries: 5, delay: 100 } });
    const spy = vi.spyOn(adapter, 'acquire');
    const lock = await locker.tryAcquire('k', { ttl: TTL });
    expect(lock?.state).toBe('held');
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'contended', attempt: 0 });
  });
});

describe('Lock', () => {
  it('releases once, then answers false without a backend call', async () => {
    const { adapter, locker, types } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    const spy = vi.spyOn(adapter, 'release');
    await expect(lock.release()).resolves.toBe(true);
    expect(lock.state).toBe('released');
    await expect(lock.release()).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(types()).toEqual(['acquired', 'released']);
  });

  it('reports a release that found the key not ours', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await adapter.release({ key: 'k', token: lock.token });
    await expect(lock.release()).resolves.toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'release' });
  });

  it('extends the lease, resets the local expiry and reports it', async () => {
    const { locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: 500 });
    await vi.advanceTimersByTimeAsync(400);
    await lock.extend(1000);
    expect(lock.ttl).toBe(1000);
    expect(events.at(-1)).toMatchObject({ type: 'extended', ttl: 1000, heldMs: 400 });
    await vi.advanceTimersByTimeAsync(900);
    expect(lock.state).toBe('held');
    await vi.advanceTimersByTimeAsync(200);
    expect(lock.state).toBe('lost');
  });

  it('validates the extend ttl and refuses after release', async () => {
    const { locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await expect(lock.extend(0)).rejects.toThrow(ValidationError);
    await lock.release();
    await expect(lock.extend(TTL)).rejects.toThrow(LockStateError);
  });

  it('marks the lock lost when extend finds the key not ours', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await adapter.release({ key: 'k', token: lock.token });
    await expect(lock.extend(TTL)).rejects.toThrow(LockLostError);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('extend');
    expect(lock.signal.aborted).toBe(true);
    expect(lock.signal.reason).toBeInstanceOf(LockLostError);
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'extend' });
    await expect(lock.extend(TTL)).rejects.toThrow(LockLostError);
  });

  it('marks the lock lost when the extend answer arrives after the new lease', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const locker = new Locker({
      adapter: slowAdapter(memory, 'extend', 150),
      now: () => Date.now(),
    });
    const lock = await locker.acquire('k', { ttl: TTL });
    const pending = lock.extend(100).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ code: 'LOCK_LOST', reason: 'late-extend' });
    expect(lock.state).toBe('lost');
  });

  it('marks the lock lost and rethrows when the backend throws on extend', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    vi.spyOn(adapter, 'extend').mockRejectedValueOnce(new Error('redis down'));
    await expect(lock.extend(TTL)).rejects.toThrow('redis down');
    expect(lock.state).toBe('lost');
    expect((lock.signal.reason as LockLostError).cause).toMatchObject({ message: 'redis down' });
  });

  it('marks the lock lost at local lease expiry', async () => {
    const { locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: 300 });
    await vi.advanceTimersByTimeAsync(299);
    expect(lock.state).toBe('held');
    await vi.advanceTimersByTimeAsync(1);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('expired');
    expect(lock.signal.reason).toMatchObject({ code: 'LOCK_LOST', reason: 'expired' });
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'expired', heldMs: 300 });
  });

  it('answers isHeld from the backend', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await expect(lock.isHeld()).resolves.toBe(true);
    await adapter.release({ key: 'k', token: lock.token });
    await expect(lock.isHeld()).resolves.toBe(false);
  });

  it('releases through Symbol.asyncDispose', async () => {
    const { locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await lock[Symbol.asyncDispose]();
    expect(lock.state).toBe('released');
  });

  it('releases at block exit with await using', async () => {
    const { locker } = setup();
    let token = '';
    {
      await using lock = await locker.acquire('k', { ttl: TTL });
      token = lock.token;
      expect(lock.state).toBe('held');
    }
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.not.toBeNull();
    expect(token).not.toBe('');
  });
});

describe('autoExtend', () => {
  it('extends on a timer and keeps the lock past its ttl', async () => {
    const { adapter, locker, types } = setup();
    const lock = await locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 10_000 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lock.state).toBe('held');
    await expect(adapter.isHeld({ key: 'k', token: lock.token })).resolves.toBe(true);
    expect(types().filter((type) => type === 'extended').length).toBeGreaterThanOrEqual(9);
    await lock.release();
    const extendedBefore = types().filter((type) => type === 'extended').length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(types().filter((type) => type === 'extended').length).toBe(extendedBefore);
  });

  it('uses the explicit interval', async () => {
    const { adapter, locker } = setup();
    const spy = vi.spyOn(adapter, 'extend');
    await locker.acquire('k', { ttl: 1000, autoExtend: { interval: 250, maxHold: 10_000 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('marks the lock lost and aborts the signal when an extension fails', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 10_000 } });
    await adapter.release({ key: 'k', token: lock.token });
    await vi.advanceTimersByTimeAsync(100);
    expect(lock.state).toBe('lost');
    expect(lock.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'extend' });
  });

  it('stops at the hold deadline and lets the lease end there', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: 100, autoExtend: { maxHold: 250 } });
    await vi.advanceTimersByTimeAsync(249);
    expect(lock.state).toBe('held');
    await vi.advanceTimersByTimeAsync(1);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('max-hold');
    expect(lock.signal.reason).toBeInstanceOf(LoccoError);
    expect(lock.signal.reason).toMatchObject({ code: 'LOCK_MAX_HOLD' });
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'max-hold' });
    await expect(adapter.isHeld({ key: 'k', token: lock.token })).resolves.toBe(false);
  });

  it('rejects an interval that is not smaller than the ttl and a deadline under the ttl', async () => {
    const { locker } = setup();
    await expect(
      locker.acquire('k', { ttl: 100, autoExtend: { interval: 100, maxHold: 1000 } }),
    ).rejects.toThrow(ValidationError);
    await expect(locker.acquire('k', { ttl: 100, autoExtend: { maxHold: 50 } })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('withLock', () => {
  it('runs the callback with a held lock, releases, and returns the value', async () => {
    const { locker, types } = setup();
    const value = await locker.withLock('k', { ttl: TTL }, async (lock) => {
      expect(lock.state).toBe('held');
      return 42;
    });
    expect(value).toBe(42);
    expect(types()).toEqual(['acquired', 'released']);
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.not.toBeNull();
  });

  it('releases and rethrows when the callback throws', async () => {
    const { locker } = setup();
    await expect(
      locker.withLock('k', { ttl: TTL }, () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.not.toBeNull();
  });

  it('keeps the callback error and reports a release failure as an event', async () => {
    const { adapter, locker, events } = setup();
    vi.spyOn(adapter, 'release').mockRejectedValueOnce(new Error('redis down'));
    await expect(
      locker.withLock('k', { ttl: TTL }, () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(events.at(-1)).toMatchObject({
      type: 'releaseFailed',
      error: expect.objectContaining({ message: 'redis down' }),
    });
  });

  it('throws LockLostError with the result when the lease ran out during the work', async () => {
    const { locker } = setup();
    const pending = locker.withLock('k', { ttl: 100 }, async () => {
      await wait(200);
      return 'done';
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);
    const error = await failure;
    expect(error).toBeInstanceOf(LockLostError);
    expect(error).toMatchObject({ completed: true, result: 'done', reason: 'expired' });
  });

  it('throws LockLostError when the release finds the key not ours', async () => {
    const { adapter, locker } = setup();
    await expect(
      locker.withLock('k', { ttl: TTL }, async (lock) => {
        await adapter.release({ key: 'k', token: lock.token });
        return 'done';
      }),
    ).rejects.toMatchObject({ code: 'LOCK_LOST', reason: 'release', result: 'done' });
  });

  it('throws the adapter error when the release throws after a good run', async () => {
    const { adapter, locker } = setup();
    vi.spyOn(adapter, 'release').mockRejectedValueOnce(new Error('redis down'));
    await expect(locker.withLock('k', { ttl: TTL }, async () => 'done')).rejects.toThrow(
      'redis down',
    );
  });

  it('keeps the lock alive with autoExtend true and hands the signal to the callback', async () => {
    const { locker } = setup();
    const pending = locker.withLock('k', { ttl: 100, autoExtend: true }, async (lock) => {
      await wait(500);
      return lock.signal.aborted;
    });
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe(false);
  });

  it('accepts an optional hold deadline', async () => {
    const { locker } = setup();
    const pending = locker.withLock(
      'k',
      { ttl: 100, autoExtend: { maxHold: 250 } },
      async (lock) => {
        await wait(400);
        return (lock.signal.reason as LoccoError).code;
      },
    );
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    await expect(failure).resolves.toMatchObject({ code: 'LOCK_LOST', reason: 'max-hold' });
  });

  it('validates the callback', async () => {
    const { locker } = setup();
    await expect(locker.withLock('k', { ttl: TTL }, 'x' as never)).rejects.toThrow(ValidationError);
  });
});

describe('acquireMany', () => {
  it('acquires unique keys in sorted order and refreshes every lease', async () => {
    const { adapter, locker, events } = setup();
    const order: string[] = [];
    vi.spyOn(adapter, 'acquire').mockImplementation(async (params) => {
      order.push(params.key);
      return InMemoryAdapter.prototype.acquire.call(adapter, params);
    });
    const locks = await locker.acquireMany(['b', 'a', 'b', 'c'], { ttl: TTL });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(locks.locks.map((lock) => lock.key)).toEqual(['a', 'b', 'c']);
    expect(events.filter((event) => event.type === 'extended')).toHaveLength(3);
    await expect(locks.release()).resolves.toBe(true);
    expect(locks.locks.every((lock) => lock.state === 'released')).toBe(true);
  });

  it('rolls back the acquired keys when one key is held', async () => {
    const { locker } = setup();
    const blocker = await locker.acquire('b', { ttl: TTL });
    await expect(locker.acquireMany(['a', 'b'], { ttl: TTL })).rejects.toBeInstanceOf(
      LockHeldError,
    );
    await expect(locker.tryAcquire('a', { ttl: TTL })).resolves.not.toBeNull();
    expect(blocker.state).toBe('held');
  });

  it('shares one timeout across the keys', async () => {
    const { locker } = setup();
    await locker.acquire('c', { ttl: TTL });
    const pending = locker.acquireMany(['a', 'b', 'c'], {
      ttl: TTL,
      retry: { retries: Number.POSITIVE_INFINITY, delay: 100, timeout: 250 },
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'timeout',
      key: 'c',
    });
    await expect(locker.tryAcquire('a', { ttl: TTL })).resolves.not.toBeNull();
  });

  it('validates the keys', async () => {
    const { locker } = setup();
    await expect(locker.acquireMany([], { ttl: TTL })).rejects.toThrow(ValidationError);
  });

  it('releases every lock at block exit and aborts the set signal with any member', async () => {
    const { adapter, locker } = setup();
    let firstToken = '';
    {
      await using locks = await locker.acquireMany(['a', 'b'], { ttl: 200 });
      const [first] = locks.locks;
      firstToken = first?.token ?? '';
      expect(locks.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(locks.signal.aborted).toBe(true);
    }
    await expect(adapter.isHeld({ key: 'a', token: firstToken })).resolves.toBe(false);
  });

  it('extends every lock in the set', async () => {
    const { locker } = setup();
    const locks = await locker.acquireMany(['a', 'b'], { ttl: 200 });
    await vi.advanceTimersByTimeAsync(150);
    await locks.extend(1000);
    await vi.advanceTimersByTimeAsync(500);
    expect(locks.locks.every((lock) => lock.state === 'held')).toBe(true);
    await locks.release();
  });
});

describe('onEvent', () => {
  it('drops what the hook throws or rejects', async () => {
    const adapter = new InMemoryAdapter({ now: () => Date.now() });
    const throwing = new Locker({
      adapter,
      onEvent: () => {
        throw new Error('hook broke');
      },
    });
    const lock = await throwing.acquire('k', { ttl: TTL });
    expect(lock.state).toBe('held');
    await lock.release();
    const rejecting = new Locker({
      adapter,
      onEvent: async () => Promise.reject(new Error('later')),
    });
    await expect(rejecting.acquire('k', { ttl: TTL })).resolves.toBeDefined();
  });
});
