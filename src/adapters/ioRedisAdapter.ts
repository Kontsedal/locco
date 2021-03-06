import { ILockAdapter } from "./lockAdapterInterface";
import { LockCreateError, LockExtendError, LockReleaseError } from "../errors";
import * as validators from "../utils/validators";

type RedisLikeClient = {
  set: (...params: any[]) => Promise<"OK" | null>;
  get: (...params: any[]) => Promise<string | null>;
  defineCommand: (
    name: string,
    params: { lua: string; numberOfKeys?: number }
  ) => void;
};

type EnhancedRedis = RedisLikeClient & {
  releaseLock: (key: string, uniqueValue: string) => Promise<number>;
  extendLock: (
    key: string,
    uniqueValue: string,
    ttl: number
  ) => Promise<"OK" | null>;
};

export class IoRedisAdapter implements ILockAdapter {
  private client: RedisLikeClient;
  constructor({ client }: { client: RedisLikeClient }) {
    this.client = client;
  }
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
    const result = await this.client.set(key, uniqueValue, "PX", ttl, "NX");
    if (result !== "OK") {
      throw new LockCreateError();
    }
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
    const script = `
      if redis.call("get",KEYS[1]) == ARGV[1] then
        return redis.call("del",KEYS[1])
      else
        return 0
      end
    `;
    this.client.defineCommand("releaseLock", {
      numberOfKeys: 1,
      lua: script,
    });
    const result = await (this.client as EnhancedRedis).releaseLock(
      key,
      uniqueValue
    );
    if (result === 1) {
      return;
    }
    throw new LockReleaseError();
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
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
      else
        return nil
      end
    `;
    this.client.defineCommand("extendLock", {
      numberOfKeys: 1,
      lua: script,
    });
    const result = await (this.client as EnhancedRedis).extendLock(
      key,
      uniqueValue,
      ttl
    );
    if (result === "OK") {
      return;
    }
    throw new LockExtendError();
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
    const entry = await this.client.get(key);
    return Boolean(entry && entry === uniqueValue);
  }
}
