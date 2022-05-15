import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getRandomHash } from "../utils/getRandomHash";
import { InMemoryAdapter, IoRedisAdapter } from "../adapters";
import { Locco } from "../Locco";
import {
  LoccoError,
  LockExtendError,
  LockReleaseError,
  RetryError,
  ValidationError,
} from "../errors";
import { wait } from "../utils/wait";
import { normalizeDelay } from "../utils/delays";
import { mapTimes } from "../utils/function";
import Redis from "ioredis";

describe("Locco", () => {
  let key;
  beforeEach(() => {
    key = `test_key_` + getRandomHash();
  });
  describe("InMemoryAdapter", () => {
    const adapter = new InMemoryAdapter();
    const locco = new Locco({
      adapter,
      retrySettings: { retryDelay: 10, retryTimes: 300 },
    });
    it("should not allow to get a locked resource", async () => {
      await locco.lock(key, 1000).acquire();
      await expect(
        locco
          .lock(key, 1000)
          .setRetrySettings({ retryDelay: 10, retryTimes: 10 })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should allow to lock an expired resource", async () => {
      await locco.lock(key, 100).acquire();
      await wait(101);
      await expect(locco.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to lock an released resource", async () => {
      const lock = await locco.lock(key, 100).acquire();
      await lock.release();
      await expect(locco.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to extend an active lock", async () => {
      const lock = await locco.lock(key, 100).acquire();
      await lock.extend(300);
      await wait(250);
      await expect(
        locco
          .lock(key, 1000)
          .setRetrySettings({
            retryTimes: 10,
            retryDelay: 3,
          })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should not allow to extend an expired lock", async () => {
      const lock = await locco.lock(key, 100).acquire();
      await wait(105);
      await expect(lock.extend(300)).rejects.toThrow(LockExtendError);
    });
    it("should not allow to release another lock", async () => {
      await locco.lock(key, 100).acquire();
      const lock = await locco.lock(key, 100);
      await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
        LockReleaseError
      );
    });
    it("should lock a resource after lock is free", async () => {
      const startAt = Date.now();
      const firstLockTtl = 300;
      await locco.lock(key, firstLockTtl).acquire();
      await locco
        .lock(key, 200)
        .setRetrySettings({ retryTimes: 32, retryDelay: 10 })
        .acquire();
      const timeDiff = Date.now() - startAt;
      expect(normalizeDelay(firstLockTtl, timeDiff)).toBe(firstLockTtl);
    });
    it("should deal with race conditions", async () => {
      const callback = jest.fn();
      const task = async () => {
        await locco
          .lock(key, 300)
          .setRetrySettings({ retryTimes: 2, retryDelay: 30 })
          .acquire();
        callback();
      };
      await Promise.allSettled(mapTimes(40, task));
      expect(callback).toHaveBeenCalledTimes(1);
    });
    it("should release lock automatically if callback is passed to the execute method", async () => {
      await locco.lock(key, 10000).acquire(async () => {
        await wait(200);
      });
      const secondLock = await locco
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 15, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });
  });

  describe("IoRedisAdapter", () => {
    const adapter = new IoRedisAdapter({ client: new Redis(6380) });
    const locco = new Locco({
      adapter,
      retrySettings: { retryDelay: 10, retryTimes: 300 },
    });
    it("should not allow to get a locked resource", async () => {
      await locco.lock(key, 1000).acquire();
      await expect(
        locco
          .lock(key, 1000)
          .setRetrySettings({ retryDelay: 10, retryTimes: 10 })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should allow to lock an expired resource", async () => {
      await locco.lock(key, 100).acquire();
      await wait(101);
      await expect(locco.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to lock an released resource", async () => {
      const lock = await locco.lock(key, 100).acquire();
      await lock.release();
      await expect(locco.lock(key, 1000).acquire()).resolves.toBeDefined();
    });
    it("should allow to extend an active lock", async () => {
      const lock = await locco.lock(key, 100).acquire();
      await lock.extend(300);
      await wait(250);
      await expect(
        locco
          .lock(key, 1000)
          .setRetrySettings({
            retryTimes: 1,
            retryDelay: 1,
          })
          .acquire()
      ).rejects.toThrow(RetryError);
    });
    it("should not allow to extend an expired lock", async () => {
      const lock = await locco.lock(key, 100).acquire();
      await wait(105);
      await expect(lock.extend(300)).rejects.toThrow(LockExtendError);
    });
    it("should not allow to release another lock", async () => {
      await locco.lock(key, 100).acquire();
      const lock = await locco.lock(key, 100);
      await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
        LockReleaseError
      );
    });
    it("should lock a resource after lock is free", async () => {
      const startAt = Date.now();
      const firstLockTtl = 300;
      await locco.lock(key, firstLockTtl).acquire();
      await locco
        .lock(key, 200)
        .setRetrySettings({ retryTimes: 32, retryDelay: 10 })
        .acquire();
      const timeDiff = Date.now() - startAt;
      expect(normalizeDelay(firstLockTtl, timeDiff)).toBe(firstLockTtl);
    });
    it("should deal with race conditions", async () => {
      const callback = jest.fn();
      const task = async () => {
        await locco
          .lock(key, 300)
          .setRetrySettings({ retryTimes: 2, retryDelay: 30 })
          .acquire();
        callback();
      };
      await Promise.allSettled(mapTimes(40, task));
      expect(callback).toHaveBeenCalledTimes(1);
    });
    it("should release lock automatically if callback is passed to the execute method", async () => {
      await locco.lock(key, 10000).acquire(async () => {
        await wait(200);
      });
      const secondLock = await locco
        .lock(key, 100)
        .setRetrySettings({ retryTimes: 15, retryDelay: 20 });
      await expect(secondLock.acquire()).resolves.toBe(secondLock);
    });
  });

  it("should validate adapter", () => {
    expect(
      () =>
        // @ts-ignore
        new Locco({
          retrySettings: { retryDelay: 20, retryTimes: 10 },
        })
    ).toThrow(ValidationError);
  });
  it("should validate retry settings", () => {
    expect(
      () =>
        // @ts-ignore
        new Locco({
          adapter: new InMemoryAdapter(),
          retrySettings: { retryDelay: 20 },
        })
    ).toThrow(ValidationError);
  });

  it("should not allow to lock twice", async () => {
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = locco.lock(key, 1000);
    await lock.acquire();
    await expect(lock.acquire()).rejects.toThrow(LoccoError);
  });

  it("should not allow to extend not locked resource", async () => {
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = locco.lock(key, 1000);
    await expect(lock.extend(1000)).rejects.toThrow(LoccoError);
  });

  it("should not allow to extend released resource", async () => {
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = await locco.lock(key, 1000).acquire();
    await lock.release({ throwOnFail: true });
    await expect(lock.extend(1000)).rejects.toThrow(LoccoError);
  });

  it("should not allow to release not locked resource", async () => {
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = locco.lock(key, 1000);
    await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
      LoccoError
    );
  });
  it("should not allow to release already released resource", async () => {
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = await locco.lock(key, 1000).acquire();
    await lock.release({ throwOnFail: true });
    await expect(lock.release({ throwOnFail: true })).rejects.toThrow(
      LoccoError
    );
  });

  it("should set retry settings properly", async () => {
    const initialSettings = { retryDelay: 20, retryTimes: 10 };
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: initialSettings,
    });
    const lock = locco.lock(key, 1000);
    expect(lock.retrySettings).toMatchObject(initialSettings);
    const newSettings = { retryDelay: 10, retryTimes: 40, totalTime: 200 };
    const newLock = lock.setRetrySettings(newSettings);
    expect(newLock.retrySettings).toMatchObject(newSettings);
  });

  it("should not allow to set retry settings after a resource lock", async () => {
    const locco = new Locco({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    const lock = await locco.lock(key, 1000).acquire();
    expect(() =>
      lock.setRetrySettings({ retryDelay: 2, retryTimes: 1 })
    ).toThrow(LoccoError);
  });
});