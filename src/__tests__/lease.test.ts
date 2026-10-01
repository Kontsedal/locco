import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockAdapter } from '../adapter';
import { InMemoryAdapter } from '../adapters/inMemory';
import type { Lock } from '../lock';
import { Locker } from '../locker';
import { wait } from '../retry';
import type { LockEvent } from '../types';
import { setup, slowSetup } from './harness';

/** A clock the test moves by hand, apart from the timer queue, like a process that was paused. */
function manualClock() {
  let value = 0;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function recordingLocker(adapter: LockAdapter, now: () => number = () => Date.now()) {
  const events: LockEvent[] = [];
  const locker = new Locker({
    adapter,
    now,
    retry: { retries: 0 },
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { locker, events, types: () => events.map((event) => event.type) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('heartbeat timing', () => {
  it('counts each tick from the start of the lease it renews, so latency does not pile up', async () => {
    // Every extension takes 40% of the TTL to answer. A tick that waited a whole interval after
    // each answer would start the second extension after the first lease had run out.
    const { locker, events } = slowSetup('extend', 400);
    const lock = await locker.acquire('k', { ttl: 1000, autoExtend: { maxHold: 60_000 } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lock.state).toBe('held');
    expect(events.filter((event) => event.type === 'extended').length).toBeGreaterThan(5);
    expect(events.some((event) => event.type === 'lost')).toBe(false);
    await lock.release();
  });

  it('counts the first tick from the acquire request, not from its answer', async () => {
    // The acquire answer used most of the lease. The first extension has to go out at once.
    const { locker, events } = slowSetup('acquire', 220);
    const pending = locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 60_000 } });
    await vi.advanceTimersByTimeAsync(220);
    const lock = await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(lock.state).toBe('held');
    expect(events.some((event) => event.type === 'lost')).toBe(false);
    await lock.release();
  });

  it('gives a lock whose deadline is its ttl no heartbeat at all', async () => {
    const { adapter, locker } = setup();
    const extend = vi.spyOn(adapter, 'extend');
    const lock = await locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 300 } });
    await vi.advanceTimersByTimeAsync(400);
    expect(extend).not.toHaveBeenCalled();
    expect(lock.lostReason).toBe('max-hold');
  });

  it('drops an explicit interval that a shorter extension left over half the ttl', async () => {
    const { adapter, locker } = setup();
    const lock = await locker.acquire('k', {
      ttl: 1000,
      autoExtend: { interval: 400, maxHold: 60_000 },
    });
    await lock.extend(500);
    const extend = vi.spyOn(adapter, 'extend');
    // A third of the new 500 ms lease, not the 400 ms that would leave the request 100 ms.
    await vi.advanceTimersByTimeAsync(165);
    expect(extend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(extend).toHaveBeenCalledTimes(1);
    await lock.release();
  });
});

describe('extend failures', () => {
  it('tries a thrown heartbeat extension again and keeps the lock when the backend recovers', async () => {
    const { adapter, locker, types } = setup();
    vi.spyOn(adapter, 'extend')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const lock = await locker.acquire('k', { ttl: 300, autoExtend: { maxHold: 60_000 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lock.state).toBe('held');
    expect(lock.lostReason).toBeUndefined();
    expect(types().slice(0, 4)).toEqual(['acquired', 'extendFailed', 'extendFailed', 'extended']);
    await lock.release();
  });

  it('reports no extend failure for a request that was out when the lock was released', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const { locker, types } = recordingLocker({
      acquire: (p) => memory.acquire(p),
      release: (p) => memory.release(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async () => {
        await wait(100);
        throw new Error('redis down');
      },
    });
    const lock = await locker.acquire('k', { ttl: 1000 });
    const extending = lock.extend(1000).catch((error: unknown) => error);
    // The request is out before the release starts.
    await vi.advanceTimersByTimeAsync(10);
    await lock.release();
    await vi.advanceTimersByTimeAsync(100);
    await expect(extending).resolves.toMatchObject({ message: 'redis down' });
    expect(types()).toEqual(['acquired', 'released']);
  });

  it('refuses the answer of a manual extend that a release overtook', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const { locker } = recordingLocker({
      acquire: (p) => memory.acquire(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async (p) => {
        await wait(100);
        return memory.extend(p);
      },
      release: async (p) => {
        await wait(200);
        return memory.release(p);
      },
    });
    const lock = await locker.acquire('k', { ttl: 5000 });
    const extending = lock.extend(5000).catch((error: unknown) => error);
    const releasing = lock.release();
    await vi.advanceTimersByTimeAsync(200);
    await expect(extending).resolves.toMatchObject({ message: /being released/ });
    await expect(releasing).resolves.toBe(true);
  });
});

describe('a release racing other requests', () => {
  /**
   * A pooled backend: the release reaches the backend first, but the answer of the extend that
   * was already out comes back before the release's own answer.
   */
  function racingBackend() {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    let releaseApplied: () => void = () => undefined;
    const applied = new Promise<void>((resolve) => {
      releaseApplied = resolve;
    });
    const adapter: LockAdapter = {
      acquire: (p) => memory.acquire(p),
      isHeld: (p) => memory.isHeld(p),
      extend: async (p) => {
        await applied;
        return memory.extend(p);
      },
      release: async (p) => {
        const answer = await memory.release(p);
        releaseApplied();
        await wait(50);
        return answer;
      },
    };
    return { memory, adapter };
  }

  it('does not report a loss when its own release overtakes an in-flight heartbeat', async () => {
    const { adapter } = racingBackend();
    const { locker, types } = recordingLocker(adapter);
    const lock = await locker.acquire('k', { ttl: 900, autoExtend: { maxHold: 60_000 } });
    // The heartbeat at 300 ms is out, waiting on the backend.
    await vi.advanceTimersByTimeAsync(320);
    const releasing = lock.release();
    await vi.advanceTimersByTimeAsync(100);
    await expect(releasing).resolves.toBe(true);
    expect(lock.lostReason).toBeUndefined();
    expect(lock.signal.aborted).toBe(false);
    expect(types()).toEqual(['acquired', 'released']);
  });

  it('does not mark the lock lost when a check sees the key its own release deleted', async () => {
    const { adapter } = racingBackend();
    const { locker, types } = recordingLocker(adapter);
    const lock = await locker.acquire('k', { ttl: 5000 });
    const releasing = lock.release();
    await Promise.resolve();
    await expect(lock.isHeld()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await expect(releasing).resolves.toBe(true);
    expect(types()).toEqual(['acquired', 'released']);
  });
});

describe('disposal after a failed release', () => {
  it('stops renewing a lock whose release threw at block exit', async () => {
    const { adapter, locker } = setup();
    const extend = vi.spyOn(adapter, 'extend');
    vi.spyOn(adapter, 'release').mockRejectedValueOnce(new Error('redis down'));
    let escaped: Lock | undefined;
    const run = async () => {
      await using lock = await locker.acquire('k', {
        ttl: 300,
        autoExtend: { maxHold: 60_000 },
      });
      escaped = lock;
    };
    await expect(run()).rejects.toThrow('redis down');
    // Nobody holds the handle any more, so nobody can release it. Renewing it until the hold
    // deadline would keep the key from every other caller for no one.
    await vi.advanceTimersByTimeAsync(1000);
    expect(extend).not.toHaveBeenCalled();
    expect(escaped?.lostReason).toBe('expired');
  });

  it('stops renewing the members of a set whose release threw at block exit', async () => {
    const { adapter, locker } = setup();
    const run = async () => {
      await using locks = await locker.acquireMany(['a', 'b'], {
        ttl: 300,
        autoExtend: { maxHold: 60_000 },
      });
      vi.spyOn(adapter, 'release').mockRejectedValue(new Error('redis down'));
      return locks;
    };
    const failure = run().catch((error: unknown) => error);
    await expect(failure).resolves.toMatchObject({ message: 'redis down' });
    const extend = vi.spyOn(adapter, 'extend');
    await vi.advanceTimersByTimeAsync(1000);
    expect(extend).not.toHaveBeenCalled();
  });

  it('stops renewing the keys a failed set rolls back when the rollback throws', async () => {
    const { adapter, locker, events } = setup();
    await locker.acquire('b', { ttl: 60_000 });
    vi.spyOn(adapter, 'release').mockRejectedValue(new Error('redis down'));
    await expect(
      locker.acquireMany(['a', 'b'], { ttl: 300, autoExtend: { maxHold: 60_000 } }),
    ).rejects.toMatchObject({ code: 'LOCK_HELD' });
    expect(events.at(-1)).toMatchObject({ type: 'releaseFailed', key: 'a' });
    const extend = vi.spyOn(adapter, 'extend');
    await vi.advanceTimersByTimeAsync(1000);
    expect(extend).not.toHaveBeenCalled();
  });
});

describe('an acquire that throws', () => {
  it('gives back the key it may have set before its answer was lost', async () => {
    const memory = new InMemoryAdapter({ now: () => Date.now() });
    const release = vi.fn((p: { key: string; token: string }) => memory.release(p));
    const { locker } = recordingLocker({
      acquire: async (p) => {
        await memory.acquire(p);
        throw new Error('ETIMEDOUT');
      },
      release,
      extend: (p) => memory.extend(p),
      isHeld: (p) => memory.isHeld(p),
    });
    await expect(locker.acquire('k', { ttl: 60_000 })).rejects.toThrow('ETIMEDOUT');
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledWith({ key: 'k', token: expect.any(String) });
    await expect(memory.acquire({ key: 'k', token: 'other', ttl: 1000 })).resolves.toBe(true);
  });

  it('keeps the acquire error when the giveback fails too', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { locker } = recordingLocker({
        acquire: async () => {
          throw new Error('ECONNREFUSED');
        },
        release: async () => {
          throw new Error('ECONNREFUSED again');
        },
        extend: async () => false,
        isHeld: async () => false,
      });
      await expect(locker.tryAcquire('k', { ttl: 1000 })).rejects.toThrow(/^ECONNREFUSED$/);
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('clock margin and pauses', () => {
  it('treats an acquire answered after 99% of the ttl as late', async () => {
    const late = slowSetup('acquire', 990);
    const lateAttempt = late.locker.tryAcquire('k', { ttl: 1000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(990);
    await expect(lateAttempt).resolves.toMatchObject({ reason: 'late-acquire' });

    const inTime = slowSetup('acquire', 989);
    const inTimeAttempt = inTime.locker.tryAcquire('k', { ttl: 1000 });
    await vi.advanceTimersByTimeAsync(989);
    await expect(inTimeAttempt).resolves.toMatchObject({ state: 'held' });
  });

  it('reads the clock on access, so a late expiry timer cannot leave a lock held', async () => {
    const clock = manualClock();
    const { locker, types } = recordingLocker(new InMemoryAdapter(), clock.now);
    const lock = await locker.acquire('k', { ttl: 1000 });
    // The process was paused: its clock moved past the lease, and no timer has run yet.
    clock.advance(5000);
    expect(lock.signal.aborted).toBe(true);
    expect(lock.state).toBe('lost');
    expect(lock.lostReason).toBe('expired');
    expect(lock.heldMs).toBe(5000);
    expect(types()).toEqual(['acquired', 'lost']);
  });

  it('does not extend a lease that a pause already ended', async () => {
    const clock = manualClock();
    const adapter = new InMemoryAdapter();
    const extend = vi.spyOn(adapter, 'extend');
    const { locker } = recordingLocker(adapter, clock.now);
    const lock = await locker.acquire('k', {
      ttl: 1000,
      autoExtend: { interval: 100, maxHold: 60_000 },
    });
    clock.advance(5000);
    // The heartbeat timer runs first after the pause. It must find the lease over, not renew it.
    await vi.advanceTimersByTimeAsync(100);
    expect(extend).not.toHaveBeenCalled();
    expect(lock.lostReason).toBe('expired');
  });

  it('counts a release after a pause as the end of a lost lock', async () => {
    const clock = manualClock();
    const { locker, types } = recordingLocker(new InMemoryAdapter(), clock.now);
    const lock = await locker.acquire('k', { ttl: 1000 });
    clock.advance(5000);
    await lock.release();
    expect(lock.state).toBe('released');
    expect(lock.lostReason).toBe('expired');
    expect(types()).toEqual(['acquired', 'lost']);
  });
});
