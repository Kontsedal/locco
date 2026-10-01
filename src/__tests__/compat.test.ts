import * as V1_0 from 'locco-v1-0';
import * as V1_1 from 'locco-v1-1';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LockAdapter } from '../adapter';
import { IoRedisAdapter } from '../adapters/ioRedis';
import { MongoAdapter } from '../adapters/mongo';
import { Locker } from '../locker';
import { ioRedisClient, mongoClient, uniqueKey } from './backends';

type V1 = typeof V1_0;

type Pair = {
  v2: LockAdapter;
  v1: InstanceType<V1['Locker']>;
  close: () => Promise<unknown>;
};

/** Both published 1.x lines: 1.0.0, and 1.1.0, which most 1.x users run. */
const RELEASES: Array<[string, V1]> = [
  ['1.0.0', V1_0],
  // Same API, but its classes declare their private fields separately, so TypeScript treats them
  // as unrelated types.
  ['1.1.0', V1_1 as unknown as V1],
];

/**
 * 1.x and 2.x pods share one backend during a rolling deploy. Both must see the other's lock, and
 * neither may remove the other's key.
 */
const pairs: Array<[string, string, () => Promise<Pair>]> = RELEASES.flatMap(
  ([version, v1]): Array<[string, string, () => Promise<Pair>]> => [
    [
      version,
      'Redis',
      async () => {
        const client = ioRedisClient();
        return {
          v2: new IoRedisAdapter({ client }),
          v1: new v1.Locker({
            adapter: new v1.IoRedisAdapter({ client }),
            retrySettings: { retryDelay: 1, retryTimes: 1 },
          }),
          close: () => client.quit(),
        };
      },
    ],
    [
      version,
      'Mongo',
      async () => {
        const client: MongoClient = await mongoClient();
        return {
          v2: new MongoAdapter({ client }),
          v1: new v1.Locker({
            adapter: new v1.MongoAdapter({ client }),
            retrySettings: { retryDelay: 1, retryTimes: 1 },
          }),
          close: () => client.close(),
        };
      },
    ],
  ],
);

describe.each(pairs)('%s and 2.0 on one %s', (_version, _backend, make) => {
  let pair: Pair;
  let locker: Locker;

  beforeAll(async () => {
    pair = await make();
    locker = new Locker({ adapter: pair.v2, retry: { retries: 0 } });
  });

  afterAll(async () => {
    await pair.close();
  });

  it('a 1.x holder blocks a 2.0 acquire, and 2.0 cannot release it', async () => {
    const key = uniqueKey();
    const old = await pair.v1.lock(key, 5000).acquire();
    await expect(locker.tryAcquire(key, { ttl: 5000 })).resolves.toBeNull();
    await expect(pair.v2.release({ key, token: 'not-the-token' })).resolves.toBe(false);
    await expect(old.isLocked()).resolves.toBe(true);
    await old.release({ throwOnFail: true });
    const fresh = await locker.tryAcquire(key, { ttl: 5000 });
    expect(fresh).not.toBeNull();
    await fresh?.release();
  });

  it('a 2.0 holder blocks a 1.x acquire, and 1.x cannot release it', async () => {
    const key = uniqueKey();
    const lock = await locker.acquire(key, { ttl: 5000 });
    await expect(pair.v1.lock(key, 5000).acquire()).rejects.toThrow();
    await expect(pair.v1.lock(key, 5000).release({ throwOnFail: true })).rejects.toThrow();
    await expect(lock.isHeld()).resolves.toBe(true);
    await expect(lock.release()).resolves.toBe(true);
    const old = await pair.v1.lock(key, 5000).acquire();
    await old.release({ throwOnFail: true });
  });
});
