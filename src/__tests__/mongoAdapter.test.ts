import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { MongoClient } from "mongodb";
import { TEST_CONFIG } from "./testConfig";
import {
  LockCreateError,
  LockExtendError,
  LockReleaseError,
  ValidationError,
} from "../errors";
import { wait } from "../utils/wait";
import { getRandomHash } from "../utils/getRandomHash";
import { MongoAdapter } from "../adapters/mongoAdapter";

describe("MongoAdapter", () => {
  let adapter: MongoAdapter;
  let key;
  let mongo;
  beforeAll(async () => {
    mongo = new MongoClient(TEST_CONFIG.MONGO_URL);
    await mongo.connect();
    adapter = new MongoAdapter({ client: mongo });
  });
  beforeEach(() => {
    key = `test_key_` + getRandomHash();
  });

  afterAll(() => {
    mongo.close();
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

  it("should not swallow mongo errors on createLock", async () => {
    const error = new Error("Some mongo error");
    const adapter = new MongoAdapter({
      client: {
        db: () => ({
          collection: () => ({
            createIndex: () => Promise.resolve(),
            updateOne: () => Promise.reject(error),
            deleteOne: () => Promise.reject(error),
          }),
        }),
      },
    });
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: "1" })
    ).rejects.toThrow(error);
  });

  it("should not swallow mongo errors on releaseLock", async () => {
    const error = new Error("Some mongo error");
    const adapter = new MongoAdapter({
      client: {
        db: () => ({
          collection: () => ({
            createIndex: () => Promise.resolve(),
            updateOne: () => Promise.reject(error),
            deleteOne: () => Promise.reject(error),
          }),
        }),
      },
    });
    await expect(
      adapter.releaseLock({ key: key, uniqueValue: "1" })
    ).rejects.toThrow(error);
  });

  it("should not swallow mongo errors on extendLock", async () => {
    const error = new Error("Some mongo error");
    const adapter = new MongoAdapter({
      client: {
        db: () => ({
          collection: () => ({
            createIndex: () => Promise.resolve(),
            updateOne: () => Promise.reject(error),
            deleteOne: () => Promise.reject(error),
          }),
        }),
      },
    });
    await expect(
      adapter.extendLock({ key: key, uniqueValue: "2", ttl: 100 })
    ).rejects.toThrow(error);
  });

  it("should validate an unique value", async () => {
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: "" })
    ).rejects.toThrow(ValidationError);
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: 1 as any })
    ).rejects.toThrow(ValidationError);
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: undefined as any })
    ).rejects.toThrow(ValidationError);
  });
});
