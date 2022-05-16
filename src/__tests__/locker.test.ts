import { describe, expect, it } from "@jest/globals";
import { InMemoryAdapter } from "../adapters/inMemoryAdapter";
import { ValidationError } from "../errors";
import { Locker } from "../locker";

describe("Locker", () => {
  it("should validate adapter existence", () => {
    expect(
      () =>
        new Locker({
          retrySettings: { retryDelay: 20, retryTimes: 10 },
        } as any)
    ).toThrow(ValidationError);
  });
  it("should validate adapter interface", () => {
    expect(
      () =>
        new Locker({
          adapter: { createLock: () => Promise.resolve() } as any,
          retrySettings: { retryDelay: 20, retryTimes: 10 },
        })
    ).toThrow(ValidationError);
  });
  it("should validate retry settings", () => {
    expect(
      () =>
        // @ts-ignore
        new Locker({
          adapter: new InMemoryAdapter(),
          retrySettings: { retryDelay: 20 },
        })
    ).toThrow(ValidationError);
  });

  it("should set retry settings properly", async () => {
    const initialSettings = { retryDelay: 20, retryTimes: 10 };
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: initialSettings,
    });
    const lock = locker.lock("test", 1000);
    expect(lock.retrySettings).toMatchObject(initialSettings);
    const newSettings = { retryDelay: 10, retryTimes: 40, totalTime: 200 };
    const newLock = lock.setRetrySettings(newSettings);
    expect(newLock.retrySettings).toMatchObject(newSettings);
  });

  it("should validate a ttl properly", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    await expect(() => locker.lock("test", "1000" as any)).toThrow(
      ValidationError
    );
    await expect(() => locker.lock("test", 100.2)).toThrow(ValidationError);
  });

  it("should validate a key properly", async () => {
    const locker = new Locker({
      adapter: new InMemoryAdapter(),
      retrySettings: { retryDelay: 20, retryTimes: 10 },
    });
    await expect(() => locker.lock("", 1000)).toThrow(ValidationError);
    await expect(() => locker.lock(1 as any, 1000)).toThrow(ValidationError);
    await expect(() => locker.lock(undefined as any, 1000)).toThrow(
      ValidationError
    );
  });
});
