import { ILockAdapter } from "./lockAdapterInterface";
import { LockCreateError, LockExtendError, LockReleaseError } from "../errors";
import * as validators from "../utils/validators";

type LockEntry = {
  expireAt: number;
  uniqueValue: string;
};
export class InMemoryAdapter implements ILockAdapter {
  private storage = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

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
    if (!entry || entry.expireAt <= now) {
      throw new LockReleaseError("Lock is already expired");
    }
    if (entry.uniqueValue !== uniqueValue) {
      throw new LockReleaseError("Lock is already taken");
    }
    this.storage.delete(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
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
      !entry ||
      entry.expireAt <= Date.now() ||
      entry.uniqueValue !== uniqueValue
    ) {
      throw new LockExtendError();
    }
    this.setLock({ key, uniqueValue, ttl });
  }

  async isValidLock({
    key,
    uniqueValue,
  }: {
    key: string;
    uniqueValue: string;
  }) {
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    const entry = this.storage.get(key);
    return Boolean(
      entry && entry.uniqueValue === uniqueValue && entry.expireAt > Date.now()
    );
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
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      const entryAfterTime = this.storage.get(key);
      if (
        entryAfterTime &&
        entryAfterTime.uniqueValue === uniqueValue &&
        entryAfterTime.expireAt === expireAt
      ) {
        this.storage.delete(key);
      }
      this.timers.delete(key);
    }, ttl);
    timer.unref();
    this.timers.set(key, timer);
  }
}
