import type { LockAdapter } from '../adapter';
import { InMemoryAdapter } from '../adapters/inMemory';
import { Locker, type LockerOptions } from '../locker';
import { wait } from '../retry';
import type { LockEvent } from '../types';

/** A locker over an in-memory backend, both on the fake-timer wall clock, that records every event. */
export function setup(options: Partial<LockerOptions> = {}) {
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

export type SlowMethod = 'acquire' | 'extend' | 'release';

/** Wraps an adapter so one method answers only after `ms` of fake time. `calls` limits it to the first calls. */
export function slowAdapter(
  adapter: LockAdapter,
  method: SlowMethod,
  ms: number,
  calls = Infinity,
) {
  let remaining = calls;
  const slow: LockAdapter = {
    acquire: (p) => adapter.acquire(p),
    release: (p) => adapter.release(p),
    extend: (p) => adapter.extend(p),
    isHeld: (p) => adapter.isHeld(p),
    [method]: async (p: never) => {
      const answer = await adapter[method](p);
      if (remaining > 0) {
        remaining -= 1;
        await wait(ms);
      }
      return answer;
    },
  };
  return slow;
}

export function slowSetup(method: SlowMethod, ms: number, calls = Infinity) {
  const memory = new InMemoryAdapter({ now: () => Date.now() });
  const adapter = slowAdapter(memory, method, ms, calls);
  const events: LockEvent[] = [];
  const locker = new Locker({
    adapter,
    now: () => Date.now(),
    retry: { retries: 0 },
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { memory, adapter, locker, events };
}
