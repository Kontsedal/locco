import { beforeEach, describe, expect, it } from "@jest/globals";
import { InMemoryAdapter } from "../adapters/inMemoryAdapter";
import {
  LockCreateError,
  LockExtendError,
  LockReleaseError,
  ValidationError,
} from "../errors";
import { wait } from "../utils/wait";
import { getRandomHash } from "../utils/getRandomHash";

describe("InMemoryAdapter", () => {
  const adapter = new InMemoryAdapter();
  let key;
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
    await adapter.createLock({ key: key, ttl: 1000, uniqueValue: "1" });
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
    await adapter.createLock({ key: key, ttl: 100, uniqueValue: "1" });
    await adapter.extendLock({ key: key, uniqueValue: "1", ttl: 300 });
    await wait(200);
    await expect(
      adapter.createLock({ key: key, ttl: 100, uniqueValue: "2" })
    ).rejects.toThrow(LockCreateError);
  });

  it("should not allow to extend an already taken lock", async () => {
    await adapter.createLock({ key: key, ttl: 100, uniqueValue: "1" });
    await expect(
      adapter.extendLock({ key: key, uniqueValue: "2", ttl: 300 })
    ).rejects.toThrow(LockExtendError);
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
