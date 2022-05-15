import { LockCreateError, LockExtendError, LockReleaseError } from "../errors";
import { ILockAdapter } from "./LockAdapterInterface";
import * as validators from "../validators";

type LockEntry = {
  expireAt: number;
  uniqueValue: string;
};
export class InMemoryAdapter implements ILockAdapter {
  private storage = new Map<string, LockEntry>();

  async createLock({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) {
    validators.validateTtl(ttl);
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    const entry = this.storage.get(key);
    if (entry && entry.expireAt > Date.now()) {
      throw new LockCreateError();
    }
    this.setLock({ key, uniqueValue, ttl });
  }

  async releaseLock({
    key,
    uniqueValue,
  }: {
    key: string;
    uniqueValue: string;
  }) {
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    const entry = this.storage.get(key);
    const now = Date.now();
    if (!entry || entry.expireAt < now) {
      throw new LockReleaseError("Lock is already expired");
    }
    if (entry && entry.uniqueValue !== uniqueValue) {
      throw new LockReleaseError("Lock is already taken");
    }
    this.storage.delete(key);
  }

  async extendLock({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) {
    validators.validateTtl(ttl);
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    const entry = this.storage.get(key);
    if (
      entry &&
      (entry.expireAt < Date.now() || entry.uniqueValue !== uniqueValue)
    ) {
      throw new LockExtendError();
    }
    this.setLock({ key, uniqueValue, ttl });
  }

  private setLock({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) {
    validators.validateTtl(ttl);
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    const expireAt = Date.now() + ttl;
    this.storage.set(key, { uniqueValue, expireAt });
    setTimeout(() => {
      const entryAfterTime = this.storage.get(key);
      if (
        entryAfterTime.uniqueValue === uniqueValue &&
        entryAfterTime.expireAt === expireAt
      ) {
        this.storage.delete(key);
      }
    }, ttl);
  }
}
