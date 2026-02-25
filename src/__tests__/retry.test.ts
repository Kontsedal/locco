import { describe, expect, it, vi } from "vitest";
import { normalizeDelay, normalizeDelays } from "./utils/delays";
import { RetrySettings, retry } from "../utils/retry";
import { RetryError, ValidationError } from "../errors";

describe("Retry helper", () => {
  it("should retry on error specified times", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    try {
      await retry({
        settings: {
          retryTimes: 10,
          retryDelay: 1,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it("should retry with a provided delay", async () => {
    const delays: number[] = [];
    const startedAt = Date.now();
    const fn = vi.fn().mockImplementation(() => {
      delays.push(Date.now() - startedAt);
      return Promise.reject(new Error());
    });
    try {
      await retry({
        settings: {
          retryTimes: 5,
          retryDelay: 50,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    const expectedDelays = [0, 50, 100, 150, 200];
    expect(normalizeDelays(expectedDelays, delays)).toEqual(
      expect.arrayContaining(expectedDelays)
    );
  });
  it("should not retry if shouldProceedFn decided so", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    try {
      await retry({
        settings: {
          retryTimes: 5,
          retryDelay: 10,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => false,
      });
    } catch (error) {}
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("should not retry if an operation was successful", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.resolve());
    try {
      await retry({
        settings: {
          retryTimes: 5,
          retryDelay: 10,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should not retry if retry was manually stopped", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    try {
      await retry({
        settings: {
          retryDelayFn: ({ attemptNumber, stop }) => {
            if (attemptNumber === 3) {
              stop();
            }
            return 10;
          },
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("should stop retry on provided timeout", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    const startedAt = Date.now();
    const timeout = 200;
    try {
      await retry({
        settings: {
          retryTimes: 100,
          retryDelay: 10,
          totalTime: timeout,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    const timeDiff = Date.now() - startedAt;
    expect(normalizeDelay(timeout, timeDiff)).toBe(timeout);
  });

  it("should not allow invalid settings", () => {
    const fn = vi.fn().mockImplementation(() => Promise.resolve());
    const params = {
      fn: fn as () => Promise<void>,
      shouldProceedFn: () => true,
    };
    const badSettings = [
      {},
      { retryTimes: 20 },
      { retryTimes: "20" },
      { retryDelay: 20 },
      { retryDelay: "20" },
      { retryTimes: 20.4, retryDelay: 20 },
      { retryTimes: 20, retryDelay: 20.4 },
      { retryTimes: "20", retryDelay: 20 },
      { retryTimes: 20, retryDelay: "20" },
      { retryDelayFn: () => 100, retryDelay: 20 },
      { retryDelayFn: "???" },
      { totalTime: 2000.2 },
      { totalTime: "2000" },
    ];
    const goodSettings = [
      { retryTimes: 20, retryDelay: 100 },
      { retryTimes: 20, retryDelay: 100, totalTime: 5000 },
      { retryDelayFn: () => 100 },
      { retryDelayFn: () => 100, totalTime: 5000 },
      { retryDelayFn: () => 100, totalTime: 5000, retryTimes: 20 },
    ];
    badSettings.forEach((settings) => {
      expect(() =>
        retry({ ...params, settings: settings as RetrySettings })
      ).toThrow(ValidationError);
    });
    goodSettings.forEach((settings) => {
      expect(() =>
        retry({ ...params, settings: settings as RetrySettings })
      ).not.toThrow();
    });
  });

  it("should support async retryDelayFn", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    try {
      await retry({
        settings: {
          retryDelayFn: async () => {
            return 10;
          },
          retryTimes: 3,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should support totalTime with retryDelayFn", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    const startedAt = Date.now();
    const timeout = 100;
    try {
      await retry({
        settings: {
          retryDelayFn: () => 10,
          totalTime: timeout,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      });
    } catch (error) {}
    const timeDiff = Date.now() - startedAt;
    expect(normalizeDelay(timeout, timeDiff)).toBe(timeout);
  });

  it("should re-throw original error when shouldProceedFn returns false", async () => {
    const originalError = new Error("specific error");
    const fn = vi.fn().mockImplementation(() => Promise.reject(originalError));
    await expect(
      retry({
        settings: {
          retryTimes: 5,
          retryDelay: 10,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => false,
      })
    ).rejects.toBe(originalError);
  });

  it("should throw RetryError with descriptive message on retry times limit", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    await expect(
      retry({
        settings: {
          retryTimes: 2,
          retryDelay: 1,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      })
    ).rejects.toThrow("Reached retry times limit");
  });

  it("should throw RetryError with descriptive message on total time exceeded", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error()));
    await expect(
      retry({
        settings: {
          retryTimes: 1000,
          retryDelay: 1,
          totalTime: 10,
        },
        fn: fn as () => Promise<void>,
        shouldProceedFn: () => true,
      })
    ).rejects.toThrow("Total time exceeded");
  });
});
