import {
  IoRedisAdapter as IoRedisAdapterV1,
  Locker as LockerV1,
  MongoAdapter as MongoAdapterV1,
} from 'locco-v1';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LockAdapter } from '../adapter';
import { IoRedisAdapter } from '../adapters/ioRedis';
import { MongoAdapter } from '../adapters/mongo';
import { Locker } from '../locker';
import { ioRedisClient, mongoClient, uniqueKey } from './backends';

type Pair = {
  v2: LockAdapter;
  v1: LockerV1;
  close: () => Promise<unknown>;
};

/**
 * 1.x and 2.x pods share one backend during a rolling deploy. Both must see the other's lock, and
 * neither may remove the other's key.
 */
const pairs: Array<[string, () => Promise<Pair>]> = [
  [
    'Redis',
    async () => {
      const client = ioRedisClient();
      return {
        v2: new IoRedisAdapter({ client }),
        v1: new LockerV1({
          adapter: new IoRedisAdapterV1({ client }),
          retrySettings: { retryDelay: 1, retryTimes: 1 },
        }),
        close: () => client.quit(),
      };
    },
  ],
  [
    'Mongo',
    async () => {
      const client: MongoClient = await mongoClient();
      return {
        v2: new MongoAdapter({ client }),
        v1: new LockerV1({
          adapter: new MongoAdapterV1({ client }),
          retrySettings: { retryDelay: 1, retryTimes: 1 },
        }),
        close: () => client.close(),
      };
    },
  ],
];

describe.each(pairs)('1.0.0 and 2.0 on one %s', (_name, make) => {
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
