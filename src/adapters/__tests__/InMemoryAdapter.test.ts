import { describe, expect, it } from "@jest/globals";
import { InMemoryAdapter } from "../InMemoryAdapter";
import {
  LockCreateError,
  LockExtendError,
  LockReleaseError,
} from "../../errors";
import { wait } from "../../utils/wait";

describe("InMemoryAdapter", () => {
  it("should not allow to access a locked resource", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 500, uniqueValue: "1" });
    await wait(100);
    expect(
      adapter.createLock({ key: "test", ttl: 100, uniqueValue: "2" })
    ).rejects.toThrow(LockCreateError);
  });

  it("should allow to access a locked resource after ttl", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 100, uniqueValue: "1" });
    await wait(100);
    expect(
      adapter.createLock({ key: "test", ttl: 100, uniqueValue: "2" })
    ).resolves.toBe(undefined);
  });

  it("should allow to access a released resource", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 1000000, uniqueValue: "1" });
    await adapter.releaseLock({ key: "test", uniqueValue: "1" });

    expect(
      adapter.createLock({ key: "test", ttl: 100, uniqueValue: "2" })
    ).resolves.toBe(undefined);
  });

  it("should not allow to release an already taken lock ", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 100, uniqueValue: "1" });
    expect(
      adapter.releaseLock({ key: "test", uniqueValue: "2" })
    ).rejects.toThrow(LockReleaseError);
  });

  it("should not allow to release an expired lock ", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 10, uniqueValue: "1" });
    await wait(40);
    expect(
      adapter.releaseLock({ key: "test", uniqueValue: "1" })
    ).rejects.toThrow(LockReleaseError);
  });

  it("should allow to extend lock", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 100, uniqueValue: "1" });
    await adapter.extendLock({ key: "test", uniqueValue: "1", ttl: 10000 });
    await wait(200);
    expect(
      adapter.createLock({ key: "test", ttl: 100, uniqueValue: "2" })
    ).rejects.toThrow(LockCreateError);
  });

  it("should not allow to extend an already taken lock", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createLock({ key: "test", ttl: 100, uniqueValue: "1" });
    expect(
      adapter.extendLock({ key: "test", uniqueValue: "2", ttl: 10000 })
    ).rejects.toThrow(LockExtendError);
  });
});
