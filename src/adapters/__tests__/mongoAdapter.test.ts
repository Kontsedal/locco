import { beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
  LockCreateError,
  LockExtendError,
  LockReleaseError,
} from "../../errors";
import { wait } from "../../utils/wait";
import { getRandomHash } from "../../utils/getRandomHash";
import { MongoClient } from "mongodb";
import { MongoAdapter } from "../mongoAdapter";
import { TEST_CONFIG } from "../../testConfig";

describe("MongoAdapter", () => {
  let adapter: MongoAdapter;
  let key;
  beforeAll(async () => {
    const mongo = new MongoClient(TEST_CONFIG.MONGO_URL);
    await mongo.connect();
    adapter = new MongoAdapter({ client: mongo });
  });
  beforeEach(() => {
    key = `test_key_` + getRandomHash();
  });

  it("should not allow to access a locked resource", async () => {
    await adapter.createLock({ key: key, ttl: 500, uniqueValue: "1" });
    await wait(100);
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: "2" })
    ).rejects.toThrow(LockCreateError);
  });

  it("should allow to access a locked resource after ttl", async () => {
    await adapter.createLock({ key: key, ttl: 100, uniqueValue: "1" });
    await wait(110);
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: "2" })
    ).resolves.toBe(undefined);
  });

  it("should allow to access a released resource", async () => {
    await adapter.createLock({ key: key, ttl: 1000000, uniqueValue: "1" });
    await adapter.releaseLock({ key: key, uniqueValue: "1" });

    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: "2" })
    ).resolves.toBe(undefined);
  });

  it("should not allow to release an already taken lock ", async () => {
    await adapter.createLock({ key: key, ttl: 100, uniqueValue: "1" });
    await expect(
      adapter.releaseLock({ key: key, uniqueValue: "2" })
    ).rejects.toThrow(LockReleaseError);
  });

  it("should not allow to release an expired lock ", async () => {
    await adapter.createLock({ key: key, ttl: 10, uniqueValue: "1" });
    await wait(40);
    await expect(
      adapter.releaseLock({ key: key, uniqueValue: "1" })
    ).rejects.toThrow(LockReleaseError);
  });

  it("should allow to extend lock", async () => {
    const testKey = "debug_" + key;
    await adapter.createLock({ key: testKey, ttl: 100, uniqueValue: "1" });
    await adapter.extendLock({ key: testKey, ttl: 100000, uniqueValue: "1" });
    await wait(200);
    await expect(
      adapter.createLock({ key: testKey, ttl: 100, uniqueValue: "2" })
    ).rejects.toThrow(LockCreateError);
  });

  it("should not allow to extend an already taken lock", async () => {
    await adapter.createLock({ key: key, ttl: 1000, uniqueValue: "1" });
    await expect(
      adapter.extendLock({ key: key, uniqueValue: "2", ttl: 10000 })
    ).rejects.toThrow(LockExtendError);
  });
});
