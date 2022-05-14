import { ILockAdapter } from "./adapters/LockAdapterInterface";
import { LockCreateError } from "./errors";
import { retry, RetrySettings } from "./retryHelper";
import { getRandomHash } from "./utils/getRandomHash";

export class Locco {
  private adapter: ILockAdapter;
  private retrySettings: RetrySettings;

  constructor({
    adapter,
    retrySettings,
  }: {
    adapter: ILockAdapter;
    retrySettings?: RetrySettings;
  }) {
    if (!adapter) {
      throw new Error("Locco:::constructor Adapter is required");
    }
    this.adapter = adapter;
    this.retrySettings = { retryDelay: 300, retryTimes: 10, ...retrySettings };
  }

  lock(key: string, ttl: number) {
    if (!key || !ttl) {
      throw new Error("Locco:::lock Key and ttl are required");
    }
    return new Lock({
      adapter: this.adapter,
      key,
      ttl,
      retrySettings: this.retrySettings,
    });
  }
}

export class Lock {
  private adapter: ILockAdapter;
  public readonly key: string;
  public readonly retrySettings: RetrySettings;
  public readonly uniqueValue: string;
  public readonly ttl: number;
  private locked = false;
  private released = false;
  constructor({
    adapter,
    key,
    retrySettings,
    uniqueValue,
    ttl,
  }: {
    adapter: ILockAdapter;
    key: string;
    retrySettings: RetrySettings;
    ttl: number;
    uniqueValue?: string;
  }) {
    this.retrySettings = retrySettings;
    this.adapter = adapter;
    this.key = key;
    this.ttl = ttl;
    this.uniqueValue = uniqueValue ?? getRandomHash();
  }

  async execute() {
    await retry({
      settings: this.retrySettings,
      fn: () =>
        this.adapter.createLock({
          key: this.key,
          uniqueValue: this.uniqueValue,
          ttl: this.ttl,
        }),
      shouldProceedFn: (error) => error instanceof LockCreateError,
    });
    return this;
  }

  async release(throwError = false) {
    if (this.released) {
      throw new Error("Locco:::Lock:::release Can't release resource twice");
    }
    try {
      await this.adapter.releaseLock({
        key: this.key,
        uniqueValue: this.uniqueValue,
      });
      this.released = true;
    } catch (error) {
      if (throwError) {
        throw error;
      }
    }
  }

  async extend(ttl) {
    if (!this.locked) {
      throw new Error(
        "Locco:::Lock:::extend Can't extend a lock before a lock success"
      );
    }
    if (this.release) {
      throw new Error("Locco:::Lock:::extend Can't extend a released lock");
    }
    return this.adapter.extendLock({
      key: this.key,
      uniqueValue: this.uniqueValue,
      ttl,
    });
  }

  setRetrySettings(settings: RetrySettings) {
    if (this.locked) {
      throw new Error(
        "Locco:::Lock:::setRetrySettings Can't change retry settings after lock success"
      );
    }
    return new Lock({
      adapter: this.adapter,
      key: this.key,
      ttl: this.ttl,
      retrySettings: { ...this.retrySettings, ...settings },
    });
  }
}
