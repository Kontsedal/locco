import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LockHeldError } from '../errors';
import { Locker } from '../locker';
import { ALL_BACKENDS, type Backend, sleep, uniqueKey } from './backends';

describe.each(ALL_BACKENDS)('Locker over %s', (_name, make) => {
  let backend: Backend;
  let locker: Locker;

  beforeAll(async () => {
    backend = await make();
    locker = new Locker({ adapter: backend.adapter, retry: { retries: 0 } });
  });

  afterAll(async () => {
    await backend.close();
  });

  it('waits for a held key and acquires it after the release', async () => {
    const key = uniqueKey();
    const first = await locker.acquire(key, { ttl: 5000 });
    const pending = locker.acquire(key, { ttl: 5000, retry: { retries: 40, delay: 50 } });
    await sleep(150);
    await first.release();
    const second = await pending;
    expect(second.state).toBe('held');
    await expect(second.isHeld()).resolves.toBe(true);
    await second.release();
  });

  it('fails fast with LockHeldError and with null', async () => {
    const key = uniqueKey();
    const holder = await locker.acquire(key, { ttl: 5000 });
    await expect(locker.acquire(key, { ttl: 5000 })).rejects.toBeInstanceOf(LockHeldError);
    await expect(locker.tryAcquire(key, { ttl: 5000 })).resolves.toBeNull();
    await holder.release();
  });

  it('runs withLock and frees the key afterwards', async () => {
    const key = uniqueKey();
    const value = await locker.withLock(key, { ttl: 5000 }, async (lock) => {
      await expect(lock.isHeld()).resolves.toBe(true);
      return 'ok';
    });
    expect(value).toBe('ok');
    const again = await locker.tryAcquire(key, { ttl: 5000 });
    expect(again).not.toBeNull();
    await again?.release();
  });

  it('keeps an auto-extended lock alive past its ttl', async () => {
    const key = uniqueKey();
    const lock = await locker.acquire(key, { ttl: 300, autoExtend: { maxHold: 10_000 } });
    await sleep(800);
    expect(lock.state).toBe('held');
    await expect(lock.isHeld()).resolves.toBe(true);
    await expect(lock.release()).resolves.toBe(true);
  });

  it('acquires and releases a set of keys', async () => {
    const keys = [uniqueKey(), uniqueKey()];
    const locks = await locker.acquireMany(keys, { ttl: 5000 });
    for (const key of keys) {
      await expect(locker.tryAcquire(key, { ttl: 5000 })).resolves.toBeNull();
    }
    await expect(locks.release()).resolves.toBe(true);
  });
});
