import Redis from "ioredis";
import { LockCreateError, LockReleaseError } from "../errors";
import { ILockAdapter } from "./LockAdapterInterface";

type EnhancedRedis = Redis & {
  releaseLock: (key: string, uniqueValue: string) => Promise<number>;
};

export class IoRedisAdapter implements ILockAdapter {
  private client: Redis;
  constructor({ client }: { client: Redis }) {
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
    const releaseScript = `
      if redis.call("get",KEYS[1]) == ARGV[1] then
        return redis.call("del",KEYS[1])
      else
        return 0
      end
    `;
    this.client.defineCommand("releaseLock", {
      numberOfKeys: 1,
      lua: releaseScript,
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
}
