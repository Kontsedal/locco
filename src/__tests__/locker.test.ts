import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockAdapter } from '../adapter';
import { InMemoryAdapter } from '../adapters/inMemory';
import {
  type LoccoError,
  LockHeldError,
  LockLostError,
  LockStateError,
  ValidationError,
} from '../errors';
import type { Lock } from '../lock';
import { Locker } from '../locker';
import { wait } from '../retry';
import type { LockEvent } from '../types';
import { setup, slowAdapter, slowSetup } from './harness';

const TTL = 1000;

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
    expect(() => new Locker({ adapter, now: 'x' as never })).toThrow(/now must be a function/);
    expect(() => new Locker({ adapter, token: 'x' as never })).toThrow(/token must be a function/);
    expect(() => new Locker({ adapter })).not.toThrow();
  });

  it('uses a monotonic clock by default, not the wall clock', async () => {
    vi.useRealTimers();
    // A wall clock that runs backwards. A lock that read it would never see its lease end.
    const realNow = Date.now;
    const base = realNow();
    Date.now = () => base - (realNow() - base) * 2;
    try {
      const locker = new Locker({ adapter: new InMemoryAdapter() });
      const lock = await locker.acquire('k', { ttl: 50 });
      expect(lock.state).toBe('held');
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(lock.state).toBe('lost');
    } finally {
      Date.now = realNow;
    }
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
    expect(types().at(-1)).toBe('acquired');
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

  it('gives the key back when the caller aborted while the attempt was winning', async () => {
    const { memory, adapter, locker } = slowSetup('acquire', 100);
    const release = vi.spyOn(adapter, 'release');
    const controller = new AbortController();
    const pending = locker.acquire('k', { ttl: TTL, signal: controller.signal });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(100);
    await expect(failure).resolves.toMatchObject({ message: 'cancelled' });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(memory.acquire({ key: 'k', token: 'other', ttl: TTL })).resolves.toBe(true);
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
    const { adapter, locker, events } = slowSetup('acquire', 150);
    const release = vi.spyOn(adapter, 'release');
    const pending = locker.acquire('k', { ttl: 100, retry: { retries: 0 } });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    // Nobody else held the key, so blaming contention would be a lie.
    await expect(failure).resolves.toMatchObject({ code: 'LOCK_HELD', reason: 'late-acquire' });
    expect(release).toHaveBeenCalledWith({ key: 'k', token: expect.any(String) });
    expect(events.at(-1)).toMatchObject({ type: 'contended', reason: 'late' });
  });

  it('tryAcquire throws instead of answering null when the key was free but the answer was late', async () => {
    // `null` means "another holder has it" and callers skip their work on it. A slow backend
    // must not make a caller skip a job on a key nobody holds.
    const { memory, locker } = slowSetup('acquire', 150);
    const pending = locker.tryAcquire('k', { ttl: 100 });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'late-acquire',
      attempts: 1,
    });
    await expect(memory.acquire({ key: 'k', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('still answers null when another holder really has the key', async () => {
    const { locker, events } = setup();
    await locker.acquire('k', { ttl: TTL });
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.toBeNull();
    expect(events.at(-1)).toMatchObject({ type: 'contended', reason: 'held' });
  });

  it('reports a giveback that failed, and still treats the attempt as late', async () => {
    // The answer came too late to use, and handing the key back failed too. The key is now stuck
    // until its lease runs out, which is exactly the thing an operator needs told.
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
      acquire: async (p) => {
        const answer = await memory.acquire(p);
        await wait(150);
        return answer;
      },
      release: async () => {
        throw new Error('redis down');
      },
    };
    const events: LockEvent[] = [];
    const locker = new Locker({
      adapter,
      now: () => Date.now(),
      retry: { retries: 0 },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const pending = locker.tryAcquire('k', { ttl: 100 });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await expect(failure).resolves.toMatchObject({ code: 'LOCK_HELD', reason: 'late-acquire' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'releaseFailed',
        key: 'k',
        error: expect.objectContaining({ message: 'redis down' }),
      }),
    );
  });

  it('continues the retry loop after a late answer and wins on a later attempt', async () => {
    const { adapter, locker, events } = slowSetup('acquire', 150, 1);
    const release = vi.spyOn(adapter, 'release');
    const pending = locker.acquire('k', { ttl: 100, retry: { retries: 2, delay: 10 } });
    // The first answer lands at 150 ms, the second attempt wins at 160 ms and lives until 260 ms.
    await vi.advanceTimersByTimeAsync(200);
    const lock = await pending;
    expect(lock.state).toBe('held');
    expect(release).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'acquired')).toMatchObject({ attempts: 2 });
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
    expect(lock.lostReason).toBeUndefined();
  });

  it('reports a release that found the key not ours and aborts the signal', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await adapter.release({ key: 'k', token: lock.token });
    await expect(lock.release()).resolves.toBe(false);
    expect(lock.state).toBe('released');
    expect(lock.lostReason).toBe('release');
    expect(lock.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'release' });
  });

  it('keeps its state when the backend throws on release, so a later call tries again', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    const spy = vi.spyOn(adapter, 'release').mockRejectedValueOnce(new Error('redis down'));
    await expect(lock.release()).rejects.toThrow('redis down');
    expect(lock.state).toBe('held');
    await expect(lock.release()).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(lock.state).toBe('released');
  });

  it('keeps extending after a release that threw, because the lock is still held', async () => {
    // The release stops the heartbeat before it calls the backend. When that call throws, the
    // lock stays held by contract, so the heartbeat has to come back with it. Without that the
    // lease quietly dies at its next expiry while the caller still believes it holds the key.
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 60_000 } });
    vi.spyOn(adapter, 'release').mockRejectedValueOnce(new Error('redis down'));
    await expect(lock.release()).rejects.toThrow('redis down');
    expect(lock.state).toBe('held');
    await vi.advanceTimersByTimeAsync(900);
    expect(lock.state).toBe('held');
    await expect(adapter.isHeld({ key: 'k', token: lock.token })).resolves.toBe(true);
    await expect(lock.release()).resolves.toBe(true);
  });

  it('reports one ending when the lease runs out during the release round trip', async () => {
    // The expiry watch stays armed across a release, so the lock can be lost while the release
    // is in flight. Emitting `lost` and then `released` would make an observer count it twice.
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const events: LockEvent[] = [];
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
      release: async (p) => {
        const answer = await memory.release(p);
        await wait(400);
        return answer;
      },
    };
    const locker = new Locker({
      adapter,
      now: () => Date.now(),
      onEvent: (event) => {
        events.push(event);
      },
    });
    const lock = await locker.acquire('k', { ttl: 200 });
    const pending = lock.release();
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe(true);
    expect(events.map((event) => event.type)).toEqual(['acquired', 'lost']);
    expect(lock.state).toBe('released');
    expect(lock.lostReason).toBe('expired');
  });

  it('keeps the lock held when an extend throws, and names the failure if the lease runs out', async () => {
    const { adapter, locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    vi.spyOn(adapter, 'extend').mockRejectedValueOnce(new Error('redis down'));
    await expect(lock.extend(TTL)).rejects.toThrow('redis down');
    // The lease confirmed at acquisition still runs, so the lock is still ours until it ends.
    expect(lock.state).toBe('held');
    expect(events.at(-1)).toMatchObject({
      type: 'extendFailed',
      key: 'k',
      ttl: TTL,
      error: expect.objectContaining({ message: 'redis down' }),
    });
    await vi.advanceTimersByTimeAsync(TTL);
    // The key was very likely still ours. Saying it was taken would send an operator hunting a
    // double acquisition that never happened.
    expect(lock.lostReason).toBe('extend-failed');
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'extend-failed' });
    expect((lock.signal.reason as LockLostError).message).toMatch(/extend requests were failing/);
    expect((lock.signal.reason as LockLostError).cause).toMatchObject({ message: 'redis down' });
  });

  it('stops counting heldMs once the lock ends', async () => {
    const { locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await vi.advanceTimersByTimeAsync(400);
    await lock.release();
    expect(lock.heldMs).toBe(400);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lock.heldMs).toBe(400);
  });

  it('keeps watching the lease while a release is in flight', async () => {
    // The release request stalls before it reaches the backend, so the lease ends on the way.
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
      release: async (p) => {
        await wait(500);
        return memory.release(p);
      },
    };
    const events: LockEvent[] = [];
    const locker = new Locker({
      adapter,
      now: () => Date.now(),
      onEvent: (event) => {
        events.push(event);
      },
    });
    const lock = await locker.acquire('k', { ttl: 200 });
    const pending = lock.release();
    await vi.advanceTimersByTimeAsync(200);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('expired');
    expect(lock.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(false);
    expect(lock.state).toBe('released');
    expect(lock.lostReason).toBe('expired');
    expect(events.filter((event) => event.type === 'lost')).toHaveLength(1);
  });

  it('shares one in-flight release between concurrent callers', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    const spy = vi.spyOn(adapter, 'release');
    const [first, second] = await Promise.all([lock.release(), lock.release()]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
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

  it('marks the lock lost when the extend answer arrives after the lease ran out', async () => {
    // The clock jumps inside the adapter call, so no timer fires before the answer is handled.
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async (p) => {
        const answer = await memory.extend(p);
        vi.setSystemTime(Date.now() + 150);
        return answer;
      },
    };
    const locker = new Locker({ adapter, now: () => Date.now(), retry: { retries: 0 } });
    const lock = await locker.acquire('k', { ttl: TTL });
    await expect(lock.extend(100)).rejects.toMatchObject({
      code: 'LOCK_LOST',
      reason: 'late-extend',
    });
    expect(lock.state).toBe('lost');
  });

  it('rejects a manual extend whose answer arrives after the local lease ran out', async () => {
    const { locker } = slowSetup('extend', 150);
    const lock = await locker.acquire('k', { ttl: 200 });
    await vi.advanceTimersByTimeAsync(100);
    const pending = lock.extend(1000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    // The lease ran out while the answer was on its way, which points at the backend.
    await expect(pending).resolves.toMatchObject({ code: 'LOCK_LOST', reason: 'late-extend' });
    expect(lock.state).toBe('lost');
  });

  it('shortens the local estimate before a shorter extension is answered', async () => {
    const { locker } = slowSetup('extend', 150);
    const lock = await locker.acquire('k', { ttl: TTL });
    const pending = lock.extend(100).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('late-extend');
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ code: 'LOCK_LOST' });
  });

  it('forgets an extend failure once a later extend succeeds', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    vi.spyOn(adapter, 'extend').mockRejectedValueOnce(new Error('redis down'));
    await expect(lock.extend(TTL)).rejects.toThrow('redis down');
    await lock.extend(TTL);
    await vi.advanceTimersByTimeAsync(TTL);
    expect(lock.lostReason).toBe('expired');
    expect((lock.signal.reason as LockLostError).cause).toBeUndefined();
  });

  it('marks the lock lost at local lease expiry, 1% early', async () => {
    // A holder clock that runs slower than the backend's must not outlive the backend lease, so
    // the local lease ends 1% of the TTL early.
    const { locker, events } = setup();
    const lock = await locker.acquire('k', { ttl: 300 });
    await vi.advanceTimersByTimeAsync(296);
    expect(lock.state).toBe('held');
    await vi.advanceTimersByTimeAsync(1);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('expired');
    expect(lock.signal.reason).toMatchObject({ code: 'LOCK_LOST', reason: 'expired' });
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'expired', heldMs: 297 });
  });

  it('answers isHeld from the backend and marks a lost lock', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await expect(lock.isHeld()).resolves.toBe(true);
    await adapter.release({ key: 'k', token: lock.token });
    await expect(lock.isHeld()).resolves.toBe(false);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('observed');
    expect(lock.signal.aborted).toBe(true);
  });

  it('releases through Symbol.asyncDispose', async () => {
    const { locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    await lock[Symbol.asyncDispose]();
    expect(lock.state).toBe('released');
  });

  it('releases at block exit with await using', async () => {
    const { locker, types } = setup();
    {
      await using lock = await locker.acquire('k', { ttl: TTL });
      expect(lock.state).toBe('held');
    }
    expect(types()).toEqual(['acquired', 'released']);
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.not.toBeNull();
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

  it('does not let a queued heartbeat undo a manual extension', async () => {
    const { adapter, locker } = setup();
    const spy = vi.spyOn(adapter, 'extend');
    const lock = await locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 10_000 } });
    await vi.advanceTimersByTimeAsync(50);
    await lock.extend(1000);
    await vi.advanceTimersByTimeAsync(700);
    expect(lock.ttl).toBe(1000);
    expect(spy.mock.calls.slice(1).every(([params]) => params.ttl === 1000)).toBe(true);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
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
    // The hold deadline is a loss like any other, so one `instanceof` check covers every ending.
    expect(lock.signal.reason).toBeInstanceOf(LockLostError);
    expect(lock.signal.reason).toMatchObject({ code: 'LOCK_LOST', reason: 'max-hold' });
    expect(events.at(-1)).toMatchObject({ type: 'lost', reason: 'max-hold' });
    await expect(adapter.isHeld({ key: 'k', token: lock.token })).resolves.toBe(false);
  });

  it('clamps a manual extension to the hold deadline', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', { ttl: 100, autoExtend: { maxHold: 250 } });
    await lock.extend(10_000);
    expect(lock.ttl).toBe(250);
    await vi.advanceTimersByTimeAsync(250);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('max-hold');
    await expect(adapter.isHeld({ key: 'k', token: lock.token })).resolves.toBe(false);
    await expect(lock.extend(100)).rejects.toMatchObject({ code: 'LOCK_LOST', reason: 'max-hold' });
  });

  it('rejects an interval over half the ttl and a deadline under the ttl', async () => {
    const { locker } = setup();
    await expect(
      locker.acquire('k', { ttl: 100, autoExtend: { interval: 51, maxHold: 1000 } }),
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

  it('returns the value when the release throws after a good run, and reports the failure', async () => {
    // The work finished under a held lock. Throwing would hide that and invite a caller to run it
    // a second time; the key only lingers until its lease runs out.
    const { adapter, locker, events } = setup();
    const extend = vi.spyOn(adapter, 'extend');
    vi.spyOn(adapter, 'release').mockRejectedValueOnce(new Error('redis down'));
    let held: Lock | undefined;
    await expect(
      locker.withLock('k', { ttl: 300, autoExtend: { maxHold: 60_000 } }, async (lock) => {
        held = lock;
        return 'charged';
      }),
    ).resolves.toBe('charged');
    expect(events.at(-1)).toMatchObject({
      type: 'releaseFailed',
      error: expect.objectContaining({ message: 'redis down' }),
    });
    // Nobody can release the lock again, so it must not be renewed until the hold deadline.
    await vi.advanceTimersByTimeAsync(1000);
    expect(extend).not.toHaveBeenCalled();
    expect(held?.lostReason).toBe('expired');
  });

  it('keeps the lock alive with autoExtend and hands the signal to the callback', async () => {
    const { locker } = setup();
    const pending = locker.withLock(
      'k',
      { ttl: 100, autoExtend: { maxHold: 10_000 } },
      async (lock) => {
        await wait(500);
        return lock.signal.aborted;
      },
    );
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe(false);
  });

  it('demands a hold deadline, so a callback that never returns cannot hold the key forever', async () => {
    const { locker } = setup();
    await expect(
      locker.withLock('k', { ttl: 100, autoExtend: true as never }, async () => 1),
    ).rejects.toThrow(/must be an object with maxHold/);
    await expect(
      locker.withLock('k', { ttl: 100, autoExtend: {} as never }, async () => 1),
    ).rejects.toThrow(/maxHold is required/);
  });

  it('returns the value when the callback released the lock itself', async () => {
    const { locker, types } = setup();
    const value = await locker.withLock('k', { ttl: 5000 }, async (lock) => {
      await lock.release();
      return 'work finished fine';
    });
    expect(value).toBe('work finished fine');
    expect(types()).toEqual(['acquired', 'released']);
  });

  it('still throws when the callback released a lock that was no longer ours', async () => {
    const { adapter, locker } = setup();
    await expect(
      locker.withLock('k', { ttl: 5000 }, async (lock) => {
        await adapter.release({ key: 'k', token: lock.token });
        await lock.release();
        return 'done';
      }),
    ).rejects.toMatchObject({ code: 'LOCK_LOST', reason: 'release', result: 'done' });
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

  it('shares one timeout across the keys and rolls back before the leases end', async () => {
    const { locker, events } = setup();
    await locker.acquire('c', { ttl: 60_000 });
    const pending = locker.acquireMany(['a', 'b', 'c'], {
      ttl: 60_000,
      retry: { retries: Number.POSITIVE_INFINITY, delay: 100, timeout: 250 },
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'timeout',
      key: 'c',
    });
    const released = events.filter((event) => event.type === 'released').map((event) => event.key);
    expect(released.sort()).toEqual(['a', 'b']);
    await expect(locker.tryAcquire('a', { ttl: TTL })).resolves.not.toBeNull();
  });

  it('fails the set when a member is lost while a slower member is still being refreshed', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const tokens: Record<string, string> = {};
    const adapter: LockAdapter = {
      acquire: (p) => {
        tokens[p.key] = p.token;
        return memory.acquire(p);
      },
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async (p) => {
        const answer = await memory.extend(p);
        if (p.key === 'b') {
          await wait(150);
        }
        return answer;
      },
    };
    const locker = new Locker({ adapter, now: () => Date.now(), retry: { retries: 0 } });
    const pending = locker.acquireMany(['a', 'b'], {
      ttl: 200,
      autoExtend: { interval: 50, maxHold: 10_000 },
    });
    const failure = pending.catch((error: unknown) => error);
    // Someone takes "a" away while "b" is still being refreshed. The heartbeat of "a" notices.
    await vi.advanceTimersByTimeAsync(25);
    await memory.release({ key: 'a', token: tokens.a ?? '' });
    await vi.advanceTimersByTimeAsync(200);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'expired',
      key: 'a',
    });
    await expect(memory.acquire({ key: 'b', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('honours an abort that arrives during the refresh', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const locker = new Locker({
      adapter: slowAdapter(memory, 'extend', 200),
      now: () => Date.now(),
      retry: { retries: 0 },
    });
    const controller = new AbortController();
    const pending = locker.acquireMany(['a', 'b'], { ttl: TTL, signal: controller.signal });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(300);
    await expect(failure).resolves.toMatchObject({ message: 'cancelled' });
    await expect(memory.acquire({ key: 'a', token: 'other', ttl: TTL })).resolves.toBe(true);
    await expect(memory.acquire({ key: 'b', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('does not start a later key after the deadline passed during an earlier attempt', async () => {
    const { memory, locker } = slowSetup('acquire', 150, 1);
    const pending = locker.acquireMany(['a', 'b'], { ttl: TTL, retry: { timeout: 100 } });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'timeout',
      key: 'b',
    });
    await expect(memory.acquire({ key: 'a', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('fails the set when an earlier lease ran out before the last key was acquired', async () => {
    const { locker } = setup();
    const blocker = await locker.acquire('b', { ttl: TTL });
    const pending = locker.acquireMany(['a', 'b'], {
      ttl: 200,
      retry: { retries: 10, delay: 100 },
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    await blocker.release();
    await vi.advanceTimersByTimeAsync(100);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'expired',
      key: 'a',
    });
    await expect(locker.tryAcquire('b', { ttl: TTL })).resolves.not.toBeNull();
  });

  it('validates the keys', async () => {
    const { locker } = setup();
    await expect(locker.acquireMany([], { ttl: TTL })).rejects.toThrow(ValidationError);
  });

  it('fails the set when the deadline passed while the last key was being acquired', async () => {
    // Every key was taken, but the budget ran out on the way, so the refresh never starts.
    const { memory, locker } = slowSetup('acquire', 80);
    const pending = locker.acquireMany(['a', 'b'], {
      ttl: 60_000,
      retry: { retries: 0, timeout: 100 },
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(400);
    await expect(failure).resolves.toMatchObject({
      code: 'LOCK_HELD',
      reason: 'timeout',
      key: 'b',
    });
    // Both keys were handed back rather than left held by a set that never returned.
    await expect(memory.acquire({ key: 'a', token: 'other', ttl: TTL })).resolves.toBe(true);
    await expect(memory.acquire({ key: 'b', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('lets a driver error from the refresh through instead of calling it contention', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async () => {
        throw new Error('redis down');
      },
    };
    const locker = new Locker({ adapter, now: () => Date.now(), retry: { retries: 0 } });
    await expect(locker.acquireMany(['a', 'b'], { ttl: TTL })).rejects.toThrow('redis down');
    await expect(memory.acquire({ key: 'a', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('releases every lock at block exit', async () => {
    const { locker, types } = setup();
    {
      await using locks = await locker.acquireMany(['a', 'b'], { ttl: TTL });
      expect(locks.locks).toHaveLength(2);
    }
    expect(types().filter((type) => type === 'released')).toHaveLength(2);
    await expect(locker.tryAcquire('a', { ttl: TTL })).resolves.not.toBeNull();
    await expect(locker.tryAcquire('b', { ttl: TTL })).resolves.not.toBeNull();
  });

  it('aborts the set signal when any member is lost', async () => {
    const { adapter, locker } = setup();
    const locks = await locker.acquireMany(['a', 'b'], { ttl: TTL });
    expect(locks.signal.aborted).toBe(false);
    const [first] = locks.locks;
    await adapter.release({ key: 'a', token: first?.token ?? '' });
    await expect(first?.isHeld()).resolves.toBe(false);
    expect(locks.signal.aborted).toBe(true);
    await locks.release();
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

describe('extend bookkeeping', () => {
  /**
   * A clock the test moves by hand, separate from the timer queue, so a lock can be found past a
   * deadline that no timer has reached yet.
   */
  function manualClock() {
    let value = 0;
    return {
      now: () => value,
      advance: (ms: number) => {
        value += ms;
      },
    };
  }

  it('refuses an extend while a release is in flight', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
      release: async (p) => {
        await wait(200);
        return memory.release(p);
      },
    };
    const locker = new Locker({ adapter, now: () => Date.now(), retry: { retries: 0 } });
    const lock = await locker.acquire('k', { ttl: 5000 });
    const releasing = lock.release();
    await expect(lock.extend(1000)).rejects.toThrow(/being released and cannot be extended/);
    await vi.advanceTimersByTimeAsync(200);
    await expect(releasing).resolves.toBe(true);
  });

  it('marks the lock lost when an extend starts past the hold deadline', async () => {
    const clock = manualClock();
    const adapter = new InMemoryAdapter({ now: () => Date.now() });
    const locker = new Locker({ adapter, now: clock.now, retry: { retries: 0 } });
    const lock = await locker.acquire('k', { ttl: 1000, autoExtend: { maxHold: 1000 } });
    // Past the deadline on the lock's own clock, with no timer having run yet.
    clock.advance(1500);
    await expect(lock.extend(1000)).rejects.toMatchObject({
      code: 'LOCK_LOST',
      reason: 'max-hold',
    });
    expect(lock.lostReason).toBe('max-hold');
  });

  it('marks the lock lost when the clamped lease would be under a millisecond', async () => {
    const clock = manualClock();
    const adapter = new InMemoryAdapter({ now: () => Date.now() });
    const locker = new Locker({ adapter, now: clock.now, retry: { retries: 0 } });
    // Under 100 ms the 1% margin rounds to nothing, so the lease reaches the deadline exactly.
    const lock = await locker.acquire('k', { ttl: 50, autoExtend: { maxHold: 50 } });
    // A sliver of the deadline is left, which floors to a zero-length lease.
    clock.advance(49.5);
    await expect(lock.extend(50)).rejects.toMatchObject({ code: 'LOCK_LOST', reason: 'max-hold' });
    expect(lock.lostReason).toBe('max-hold');
  });

  it('drops a queued heartbeat whose lock was lost while an earlier extend was in flight', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    let token = '';
    const adapter: LockAdapter = {
      acquire: async (p) => {
        token = p.token;
        return memory.acquire(p);
      },
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async (p) => {
        // The stall happens before the backend sees the request, so the answer reflects the key
        // as it is at the end of the round trip, not as it was when the request was made.
        await wait(150);
        return memory.extend(p);
      },
    };
    const events: LockEvent[] = [];
    const locker = new Locker({
      adapter,
      now: () => Date.now(),
      retry: { retries: 0 },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const lock = await locker.acquire('k', {
      ttl: 3000,
      autoExtend: { interval: 50, maxHold: 60_000 },
    });
    // A manual extend goes first and stalls. The heartbeat at 50 ms queues behind it.
    const manual = lock.extend(3000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    // Someone takes the key, so the manual extend comes back refused and the lock is lost.
    await memory.release({ key: 'k', token });
    await vi.advanceTimersByTimeAsync(400);
    await expect(manual).resolves.toMatchObject({ code: 'LOCK_LOST', reason: 'extend' });
    expect(lock.state).toBe('lost');
    // The queued heartbeat found a lost lock and returned without a second `lost` event.
    expect(events.filter((event) => event.type === 'lost')).toHaveLength(1);
  });

  it('rejects a queued manual extend whose lock was lost before its turn', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    let token = '';
    const adapter: LockAdapter = {
      acquire: async (p) => {
        token = p.token;
        return memory.acquire(p);
      },
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async (p) => {
        // The stall happens before the backend sees the request, so the answer reflects the key
        // as it is at the end of the round trip, not as it was when the request was made.
        await wait(150);
        return memory.extend(p);
      },
    };
    const locker = new Locker({ adapter, now: () => Date.now(), retry: { retries: 0 } });
    const lock = await locker.acquire('k', { ttl: 3000 });
    const first = lock.extend(3000).catch((error: unknown) => error);
    const second = lock.extend(3000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    await memory.release({ key: 'k', token });
    await vi.advanceTimersByTimeAsync(400);
    await expect(first).resolves.toMatchObject({ code: 'LOCK_LOST', reason: 'extend' });
    // The second was queued while the lock was still held, and finds it gone on its turn.
    await expect(second).resolves.toMatchObject({ code: 'LOCK_LOST', reason: 'extend' });
  });

  it('keeps the first loss when the lease runs out while a failing extend is in flight', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async () => {
        await wait(150);
        throw new Error('redis down');
      },
    };
    const events: LockEvent[] = [];
    const locker = new Locker({
      adapter,
      now: () => Date.now(),
      retry: { retries: 0 },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const lock = await locker.acquire('k', { ttl: 200 });
    await vi.advanceTimersByTimeAsync(100);
    const pending = lock.extend(5000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);
    // The expiry won the race while the request was out, and the driver error still surfaces.
    await expect(pending).resolves.toMatchObject({ message: 'redis down' });
    expect(lock.lostReason).toBe('late-extend');
    expect(events.filter((event) => event.type === 'lost')).toHaveLength(1);
  });

  it('retries a heartbeat whose extend throws until the lease runs out, then stops', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async () => {
        throw new Error('redis down');
      },
    };
    const events: LockEvent[] = [];
    const locker = new Locker({
      adapter,
      now: () => Date.now(),
      retry: { retries: 0 },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const lock = await locker.acquire('k', {
      ttl: 300,
      autoExtend: { interval: 50, maxHold: 60_000 },
    });
    await vi.advanceTimersByTimeAsync(60);
    // Most of the lease is left, so a failed request is no reason to give the lock up.
    expect(lock.state).toBe('held');
    await vi.advanceTimersByTimeAsync(240);
    expect(lock.lostReason).toBe('extend-failed');
    const attempts = events.filter((event) => event.type === 'extendFailed').length;
    expect(attempts).toBeGreaterThan(5);
    await vi.advanceTimersByTimeAsync(500);
    // The loss stopped the retries.
    expect(events.filter((event) => event.type === 'extendFailed')).toHaveLength(attempts);
    expect(events.filter((event) => event.type === 'lost')).toHaveLength(1);
  });

  it('stops the heartbeat when the lease runs out while its extend is in flight', async () => {
    const { locker, events } = slowSetup('extend', 250);
    const lock = await locker.acquire('k', {
      ttl: 200,
      autoExtend: { interval: 50, maxHold: 60_000 },
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('late-extend');
    expect(events.filter((event) => event.type === 'extended')).toHaveLength(0);
  });
});

describe('LockSet', () => {
  it('reports every failed release, not every one but the first', async () => {
    const { adapter, locker, events } = setup();
    const locks = await locker.acquireMany(['a', 'b'], { ttl: TTL });
    await vi.advanceTimersByTimeAsync(120);
    vi.spyOn(adapter, 'release').mockRejectedValue(new Error('redis down'));
    await expect(locks.release()).rejects.toThrow('redis down');
    const failures = events.filter((event) => event.type === 'releaseFailed');
    // An observer counting keys that may have leaked has to see both, not one of two.
    expect(failures.map((event) => event.key).sort()).toEqual(['a', 'b']);
    expect(failures.every((event) => event.heldMs === 120)).toBe(true);
    // Every lock kept its state, so a later release can try again.
    expect(locks.locks.every((lock) => lock.state === 'held')).toBe(true);
  });

  it('answers false when a key was already gone, and on a second call', async () => {
    const { adapter, locker } = setup();
    const locks = await locker.acquireMany(['a', 'b'], { ttl: TTL });
    const [first] = locks.locks;
    await adapter.release({ key: 'a', token: first?.token ?? '' });
    await expect(locks.release()).resolves.toBe(false);
    await expect(locks.release()).resolves.toBe(false);
  });

  it('throws the first failure when one member cannot be extended', async () => {
    const { adapter, locker } = setup();
    const locks = await locker.acquireMany(['a', 'b'], { ttl: TTL });
    const [first] = locks.locks;
    await adapter.release({ key: 'a', token: first?.token ?? '' });
    await expect(locks.extend(TTL)).rejects.toMatchObject({ code: 'LOCK_LOST' });
    // The healthy member was still extended; the failure is reported after all of them settled.
    expect(locks.locks[1]?.state).toBe('held');
    await expect(locks.extend(0)).rejects.toThrow(ValidationError);
  });
});

describe('onEvent', () => {
  it('drops a rejection from a handler that returns a non-native thenable', async () => {
    // A handler built on a promise library, downleveled onto a polyfill, or created in another
    // realm fails an `instanceof Promise` test. Its rejection must still not reach the process.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const adapter = new InMemoryAdapter({ now: () => Date.now() });
      const locker = new Locker({
        adapter,
        now: () => Date.now(),
        onEvent: () =>
          ({
            // A hand-rolled thenable is the subject of this test: it is what a promise library or
            // another realm hands back, and what an `instanceof Promise` guard waves through.
            // biome-ignore lint/suspicious/noThenProperty: the thenable is the point
            then: (_ok: unknown, bad: (error: unknown) => void) => {
              bad(new Error('hook broke'));
            },
          }) as never,
      });
      const lock = await locker.acquire('k', { ttl: TTL });
      expect(lock.state).toBe('held');
      await lock.release();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

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

describe('fencing', () => {
  it('validates the option against the adapter', () => {
    const adapter = new InMemoryAdapter();
    const plain: LockAdapter = {
      acquire: (p) => adapter.acquire(p),
      release: (p) => adapter.release(p),
      extend: (p) => adapter.extend(p),
      isHeld: (p) => adapter.isHeld(p),
    };
    expect(() => new Locker({ adapter, fencing: 'yes' as never })).toThrow(
      /fencing must be a boolean/,
    );
    expect(() => new Locker({ adapter: plain, fencing: true })).toThrow(
      /fencing needs an adapter with an acquireFenced method/,
    );
    // Off is the default, and an adapter without fencing is fine then.
    expect(() => new Locker({ adapter: plain, fencing: false })).not.toThrow();
  });

  it('gives each grant of a key a larger fence', async () => {
    const { locker } = setup({ fencing: true });
    const first = await locker.acquire('k', { ttl: TTL });
    await first.release();
    const second = await locker.acquire('k', { ttl: TTL });
    expect(first.fence).toEqual(expect.any(Number));
    expect(second.fence).toBeGreaterThan(first.fence as number);
    await second.release();
    const fromWithLock = await locker.withLock('k', { ttl: TTL }, (lock) => lock.fence);
    expect(fromWithLock).toBeGreaterThan(second.fence as number);
  });

  it('leaves the fence undefined when the option is off', async () => {
    const { locker } = setup();
    const lock = await locker.acquire('k', { ttl: TTL });
    expect(lock.fence).toBeUndefined();
  });

  it('answers null from tryAcquire when another holder has the key', async () => {
    const { locker } = setup({ fencing: true });
    await locker.acquire('k', { ttl: TTL });
    await expect(locker.tryAcquire('k', { ttl: TTL })).resolves.toBeNull();
  });

  it('counts the fence as part of the grant, so a late fence gives the key back', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      release: (p) => memory.release(p),
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
      acquireFenced: async (p) => {
        const fence = await memory.acquireFenced(p);
        await wait(150);
        return fence;
      },
    };
    const locker = new Locker({ adapter, fencing: true, now: () => Date.now() });
    const failure = locker.tryAcquire('k', { ttl: 100 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await expect(failure).resolves.toMatchObject({ code: 'LOCK_HELD', reason: 'late-acquire' });
    await expect(memory.acquire({ key: 'k', token: 'other', ttl: TTL })).resolves.toBe(true);
  });

  it('gives the key back when the fenced acquire throws', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const release = vi.fn((p: { key: string; token: string }) => memory.release(p));
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      release,
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
      acquireFenced: async (p) => {
        await memory.acquireFenced(p);
        throw new Error('counter write failed');
      },
    };
    const locker = new Locker({ adapter, fencing: true, now: () => Date.now() });
    await expect(locker.tryAcquire('k', { ttl: TTL })).rejects.toThrow('counter write failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledWith({ key: 'k', token: expect.any(String) });
    await expect(memory.acquire({ key: 'k', token: 'other', ttl: TTL })).resolves.toBe(true);
  });
});
