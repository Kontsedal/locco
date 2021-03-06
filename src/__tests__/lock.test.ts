import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import Redis from "ioredis";
import { MongoClient } from "mongodb";
import { normalizeDelay } from "./utils/delays";
import { mapTimes } from "./utils/function";
import { TEST_CONFIG } from "./config";
import { getRandomHash } from "../utils/getRandomHash";
import {
  LoccoError,
  LockExtendError,
  LockReleaseError,
  RetryError,
} from "../errors";
import { wait } from "../utils/wait";
import { IoRedisAdapter } from "../adapters/ioRedisAdapter";
import { InMemoryAdapter } from "../adapters/inMemoryAdapter";
import { Locker } from "../locker";
import { MongoAdapter } from "../adapters/mongoAdapter";

describe("Locco", () => {
  let key: string;
  beforeEach(() => {
    key = `test_key_` + getRandomHash();
  });
  describe("InMemoryAdapter", () => {
    const adapter = new InMemoryAdapter();
    const locker = new Locker({
      adapter,
      retrySettings: { retryDelay: 10, retryTimes: 300 },
    });
    it("should not allow to get a locked resource", async () => {
      await locker.lock(key, 1000).acquire();
      await expect(
        locker
          .lock(key, 1000)
          .setRetrySettings({ retryDelay: 10, retryTimes: 10 })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should allow to lock an expired resource", async () => {
      await locker.lock(key, 100).acquire();
      await wait(110);
      await expect(locker.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to lock an released resource", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await lock.release();
      await expect(locker.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to extend an active lock", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await lock.extend(300);
      await wait(250);
      await expect(
        locker
          .lock(key, 1000)
          .setRetrySettings({
            retryTimes: 10,
            retryDelay: 3,
          })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should not allow to extend an expired lock", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await wait(110);
      await expect(lock.extend(300)).rejects.toThrow(LockExtendError);
    });
    it("should not allow to release another lock", async () => {
      await locker.lock(key, 100).acquire();
      const lock = await locker.lock(key, 100);
      await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
        LockReleaseError
      );
    });
    it("should lock a resource after lock is free", async () => {
      const startAt = Date.now();
      const firstLockTtl = 300;
      await locker.lock(key, firstLockTtl).acquire();
      await locker
        .lock(key, 200)
        .setRetrySettings({ retryTimes: 32, retryDelay: 10 })
        .acquire();
      const timeDiff = Date.now() - startAt;
      expect(normalizeDelay(firstLockTtl, timeDiff)).toBe(firstLockTtl);
    });
    it("should deal with race conditions", async () => {
      const callback = jest.fn();
      const task = async () => {
        await locker
          .lock(key, 300)
          .setRetrySettings({ retryTimes: 2, retryDelay: 30 })
          .acquire();
        callback();
      };
      await Promise.allSettled(mapTimes(40, task));
      expect(callback).toHaveBeenCalledTimes(1);
    });
    it("should release lock automatically if callback is passed to the execute method", async () => {
      await locker.lock(key, 10000).acquire(async () => {
        await wait(200);
      });
      const secondLock = await locker
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 15, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });
    it("should release lock automatically if callback is passed to the execute method and throws an error", async () => {
      try {
        await locker.lock(key, 10000).acquire(async () => {
          throw new Error("Ooopsie");
        });
      } catch (error) {}
      const secondLock = await locker
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 1, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });
    it("should allow to check if lock is still valid", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await expect(lock.isLocked()).resolves.toBe(true);
      await wait(110);
      await expect(lock.isLocked()).resolves.toBe(false);
    });
  });

  describe("IoRedisAdapter", () => {
    const client = new Redis(TEST_CONFIG.REDIS_PORT);
    const adapter = new IoRedisAdapter({
      client: client,
    });
    const locker = new Locker({
      adapter,
      retrySettings: { retryDelay: 10, retryTimes: 300 },
    });
    afterAll(() => {
      client.disconnect();
    });
    it("should not allow to get a locked resource", async () => {
      await locker.lock(key, 1000).acquire();
      await expect(
        locker
          .lock(key, 1000)
          .setRetrySettings({ retryDelay: 10, retryTimes: 10 })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should allow to lock an expired resource", async () => {
      await locker.lock(key, 100).acquire();
      await wait(110);
      await expect(locker.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to lock an released resource", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await lock.release();
      await expect(locker.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to extend an active lock", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await lock.extend(300);
      await wait(250);
      await expect(
        locker
          .lock(key, 1000)
          .setRetrySettings({
            retryTimes: 1,
            retryDelay: 1,
          })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should not allow to extend an expired lock", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await wait(110);
      await expect(lock.extend(300)).rejects.toThrow(LockExtendError);
    });
    it("should not allow to release another lock", async () => {
      await locker.lock(key, 100).acquire();
      const lock = await locker.lock(key, 100);
      await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
        LockReleaseError
      );
    });
    it("should lock a resource after lock is free", async () => {
      const startAt = Date.now();
      const firstLockTtl = 300;
      await locker.lock(key, firstLockTtl).acquire();
      await locker
        .lock(key, 200)
        .setRetrySettings({ retryTimes: 32, retryDelay: 10 })
        .acquire();
      const timeDiff = Date.now() - startAt;
      expect(normalizeDelay(firstLockTtl, timeDiff)).toBe(firstLockTtl);
    });
    it("should deal with race conditions", async () => {
      const callback = jest.fn();
      const task = async () => {
        await locker
          .lock(key, 300)
          .setRetrySettings({ retryTimes: 2, retryDelay: 30 })
          .acquire();
        callback();
      };
      await Promise.allSettled(mapTimes(40, task));
      expect(callback).toHaveBeenCalledTimes(1);
    });
    it("should release lock automatically if callback is passed to the execute method", async () => {
      await locker.lock(key, 10000).acquire(async () => {
        await wait(200);
      });
      const secondLock = await locker
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 15, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });

    it("should release lock automatically if callback is passed to the execute method and throws an error", async () => {
      try {
        await locker.lock(key, 10000).acquire(async () => {
          throw new Error("Ooopsie");
        });
      } catch (error) {}
      const secondLock = await locker
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 1, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });

    it("should allow to check if lock is still valid", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await expect(lock.isLocked()).resolves.toBe(true);
      await wait(110);
      await expect(lock.isLocked()).resolves.toBe(false);
    });
  });

  describe("MongoAdapter", () => {
    let locker: Locker;
    let client: MongoClient;
    beforeAll(async () => {
      client = new MongoClient(TEST_CONFIG.MONGO_URL);
      await client.connect();
      const adapter = new MongoAdapter({
        client,
      });
      locker = new Locker({
        adapter,
        retrySettings: { retryDelay: 10, retryTimes: 300 },
      });
    });
    afterAll(() => {
      client.close();
    });
    it("should not allow to get a locked resource", async () => {
      await locker.lock(key, 1000).acquire();
      await expect(
        locker
          .lock(key, 1000)
          .setRetrySettings({ retryDelay: 10, retryTimes: 10 })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should allow to lock an expired resource", async () => {
      await locker.lock(key, 100).acquire();
      await wait(110);
      await expect(locker.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to lock an released resource", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await lock.release();
      await expect(locker.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to extend an active lock", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await lock.extend(300);
      await wait(250);
      await expect(
        locker
          .lock(key, 1000)
          .setRetrySettings({
            retryTimes: 1,
            retryDelay: 1,
          })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should not allow to extend an expired lock", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await wait(110);
      await expect(lock.extend(300)).rejects.toThrow(LockExtendError);
    });
    it("should not allow to release another lock", async () => {
      await locker.lock(key, 100).acquire();
      const lock = await locker.lock(key, 100);
      await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
        LockReleaseError
      );
    });
    it("should lock a resource after lock is free", async () => {
      const startAt = Date.now();
      const firstLockTtl = 300;
      await locker.lock(key, firstLockTtl).acquire();
      await locker
        .lock(key, 200)
        .setRetrySettings({ retryTimes: 32, retryDelay: 10 })
        .acquire();
      const timeDiff = Date.now() - startAt;
      expect(normalizeDelay(firstLockTtl, timeDiff)).toBe(firstLockTtl);
    });
    it("should deal with race conditions", async () => {
      const callback = jest.fn();
      const task = async () => {
        await locker
          .lock(key, 300)
          .setRetrySettings({ retryTimes: 2, retryDelay: 30 })
          .acquire();
        callback();
      };
      await Promise.allSettled(mapTimes(40, task));
      expect(callback).toHaveBeenCalledTimes(1);
    });
    it("should release lock automatically if callback is passed to the execute method", async () => {
      await locker.lock(key, 10000).acquire(async () => {
        await wait(200);
      });
      const secondLock = await locker
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 15, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });
    it("should release lock automatically if callback is passed to the execute method and throws an error", async () => {
      try {
        await locker.lock(key, 10000).acquire(async () => {
          throw new Error("Ooopsie");
        });
      } catch (error) {}
      const secondLock = await locker
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 1, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });
    it("should allow to check if lock is still valid", async () => {
      const lock = await locker.lock(key, 100).acquire();
      await expect(lock.isLocked()).resolves.toBe(true);
      await wait(110);
      await expect(lock.isLocked()).resolves.toBe(false);
    });
  });

  it("should not allow to lock twice", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = locker.lock(key, 1000);
    await lock.acquire();
    await expect(lock.acquire()).rejects.toThrow(LoccoError);
  });

  it("should not allow to extend not locked resource", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = locker.lock(key, 1000);
    await expect(lock.extend(1000)).rejects.toThrow(LoccoError);
  });

  it("should not allow to extend released resource", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = await locker.lock(key, 1000).acquire();
    await lock.release({ throwOnFail: true });
    await expect(lock.extend(1000)).rejects.toThrow(LoccoError);
  });

  it("should not allow to release not locked resource", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = locker.lock(key, 1000);
    await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
      LoccoError
    );
  });
  it("should not allow to release already released resource", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = await locker.lock(key, 1000).acquire();
    await lock.release({ throwOnFail: true });
    await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
      LoccoError
    );
  });

  it("should not allow to set retry settings after a resource lock", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = await locker.lock(key, 1000).acquire();
    expect(() =>
      lock.setRetrySettings({ retryDelay: 2, retryTimes: 1 })
    ).toThrow(LoccoError);
  });
});
