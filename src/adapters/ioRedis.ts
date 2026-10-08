import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';
import {
  ACQUIRE_FENCED_SCRIPT,
  ACQUIRE_FENCED_SHA,
  EXTEND_SCRIPT,
  EXTEND_SHA,
  fencedArguments,
  fenceKeyFor,
  isNoScriptError,
  RELEASE_SCRIPT,
  RELEASE_SHA,
  replicationCheck,
  type WaitForReplicas,
} from './redisScripts';

/** The part of an ioredis client the adapter uses. */
export type IoRedisLikeClient = {
  set: (key: string, value: string, px: 'PX', ttl: number, nx: 'NX') => Promise<unknown>;
  get: (key: string) => Promise<unknown>;
  eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  evalsha: (sha: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  /** Needed only with `waitForReplicas`. */
  wait?: (replicas: number, timeout: number) => Promise<unknown>;
};

export type IoRedisAdapterOptions = {
  client: IoRedisLikeClient;
  /**
   * Run `WAIT replicas timeout` after every acquire and extend, and throw RedisReplicationError
   * when fewer replicas acknowledged the write. Default off. Needs a client with one connection
   * of its own: `WAIT` blocks it for up to `timeout`.
   */
  waitForReplicas?: WaitForReplicas;
};

export class IoRedisAdapter implements LockAdapter {
  readonly #client: IoRedisLikeClient;
  readonly #replicate: () => Promise<void>;

  constructor({ client, waitForReplicas }: IoRedisAdapterOptions) {
    this.#replicate = replicationCheck(waitForReplicas, client);
    this.#client = client;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    const acquired = (await this.#client.set(key, token, 'PX', ttl, 'NX')) === 'OK';
    if (acquired) {
      await this.#replicate();
    }
    return acquired;
  }

  async acquireFenced({ key, token, ttl }: LockLeaseParams): Promise<number | null> {
    const fence = Number(
      await this.#run(
        ACQUIRE_FENCED_SHA,
        ACQUIRE_FENCED_SCRIPT,
        [key, fenceKeyFor(key)],
        token,
        ...fencedArguments(ttl),
      ),
    );
    if (fence === 0) {
      return null;
    }
    await this.#replicate();
    return fence;
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    return (await this.#run(RELEASE_SHA, RELEASE_SCRIPT, [key], token)) === 1;
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    const extended = (await this.#run(EXTEND_SHA, EXTEND_SCRIPT, [key], token, ttl)) === 1;
    if (extended) {
      await this.#replicate();
    }
    return extended;
  }

  async isHeld({ key, token }: LockKeyParams): Promise<boolean> {
    return (await this.#client.get(key)) === token;
  }

  async #run(
    sha: string,
    script: string,
    keys: string[],
    ...args: Array<string | number>
  ): Promise<unknown> {
    try {
      return await this.#client.evalsha(sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) {
        throw error;
      }
      return this.#client.eval(script, keys.length, ...keys, ...args);
    }
  }
}
