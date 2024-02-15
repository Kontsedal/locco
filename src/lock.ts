import { LoccoError, LockCreateError } from "./errors";
import { RetrySettings, retry } from "./utils/retry";
import * as validators from "./utils/validators";
import { ILockAdapter } from "./adapters/lockAdapterInterface";
import { getRandomHash } from "./utils/getRandomHash";
import { isFunction } from "./utils/validators";

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
    validators.validateRetrySettings(retrySettings);
    validators.validateTtl(ttl);
    validators.validateKey(key);
    this.retrySettings = retrySettings;
    this.adapter = adapter;
    this.key = key;
    this.ttl = ttl;
    this.uniqueValue = uniqueValue ?? getRandomHash();
  }

  async acquire<T>(cb?: (lock: Lock) => T): Promise<Lock> {
    if (this.locked) {
      throw new LoccoError("Lock is already acquired");
    }
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
    this.locked = true;
    if (isFunction(cb)) {
      try {
        await cb(this);
      } finally {
        await this.release();
      }
    }
    return this;
  }

  async release({ throwOnFail = false }: { throwOnFail?: boolean } = {}) {
    try {
      if (this.released) {
        throw new LoccoError(
          "Locco:::Lock:::release Can't release resource twice"
        );
      }
      await this.adapter.releaseLock({
        key: this.key,
        uniqueValue: this.uniqueValue,
      });
      this.released = true;
    } catch (error) {
      if (throwOnFail) {
        throw error;
      }
    }
  }

  async isLocked() {
    return this.adapter.isValidLock({
      key: this.key,
      uniqueValue: this.uniqueValue,
    });
  }

  async extend(ttl: number) {
    if (!this.locked) {
      throw new LoccoError(
        "Locco:::Lock:::extend Can't extend a lock before a lock success"
      );
    }
    if (this.released) {
      throw new LoccoError(
        "Locco:::Lock:::extend Can't extend a released lock"
      );
    }
    validators.validateTtl(ttl);
    return this.adapter.extendLock({
      key: this.key,
      uniqueValue: this.uniqueValue,
      ttl,
    });
  }

  setRetrySettings(settings: RetrySettings) {
    if (this.locked) {
      throw new LoccoError(
        "Locco:::setRetrySettings Can't change retry settings after lock success"
      );
    }
    validators.validateRetrySettings(settings);
    return new Lock({
      adapter: this.adapter,
      key: this.key,
      ttl: this.ttl,
      retrySettings: settings,
      uniqueValue: this.uniqueValue,
    });
  }
}
