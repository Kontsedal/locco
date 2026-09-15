import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';
import {
  EXTEND_SCRIPT,
  EXTEND_SHA,
  isNoScriptError,
  RELEASE_SCRIPT,
  RELEASE_SHA,
} from './redisScripts';

/** The part of an ioredis client the adapter uses. */
export type IoRedisLikeClient = {
  set: (key: string, value: string, px: 'PX', ttl: number, nx: 'NX') => Promise<unknown>;
  get: (key: string) => Promise<unknown>;
  eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  evalsha: (sha: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

export type IoRedisAdapterOptions = {
  client: IoRedisLikeClient;
};

export class IoRedisAdapter implements LockAdapter {
  readonly #client: IoRedisLikeClient;

  constructor({ client }: IoRedisAdapterOptions) {
    this.#client = client;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    return (await this.#client.set(key, token, 'PX', ttl, 'NX')) === 'OK';
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    return (await this.#run(RELEASE_SHA, RELEASE_SCRIPT, key, token)) === 1;
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    return (await this.#run(EXTEND_SHA, EXTEND_SCRIPT, key, token, ttl)) === 1;
  }

  async isHeld({ key, token }: LockKeyParams): Promise<boolean> {
    return (await this.#client.get(key)) === token;
  }

  async #run(sha: string, script: string, ...args: Array<string | number>): Promise<unknown> {
    try {
      return await this.#client.evalsha(sha, 1, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) {
        throw error;
      }
      return this.#client.eval(script, 1, ...args);
    }
  }
}
