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

type ScriptOptions = {
  keys: string[];
  arguments: string[];
};

/** The part of a `redis` package client the adapter uses. */
export type NodeRedisLikeClient = {
  set: (key: string, value: string, options: { PX: number; NX: true }) => Promise<unknown>;
  get: (key: string) => Promise<unknown>;
  eval: (script: string, options: ScriptOptions) => Promise<unknown>;
  evalSha: (sha: string, options: ScriptOptions) => Promise<unknown>;
  /** Needed only with `waitForReplicas`. */
  wait?: (replicas: number, timeout: number) => Promise<unknown>;
};

export type NodeRedisAdapterOptions = {
  client: NodeRedisLikeClient;
  /**
   * Run `WAIT replicas timeout` after every acquire and extend, and throw RedisReplicationError
   * when fewer replicas acknowledged the write. Default off. Needs a client with one connection
   * of its own: `WAIT` blocks it for up to `timeout`.
   */
  waitForReplicas?: WaitForReplicas;
};

export class NodeRedisAdapter implements LockAdapter {
  readonly #client: NodeRedisLikeClient;
  readonly #replicate: () => Promise<void>;

  constructor({ client, waitForReplicas }: NodeRedisAdapterOptions) {
    this.#replicate = replicationCheck(waitForReplicas, client);
    this.#client = client;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    const acquired = (await this.#client.set(key, token, { PX: ttl, NX: true })) === 'OK';
    if (acquired) {
      await this.#replicate();
    }
    return acquired;
  }

  async acquireFenced({ key, token, ttl }: LockLeaseParams): Promise<number | null> {
    const options = { keys: [key, fenceKeyFor(key)], arguments: [token, ...fencedArguments(ttl)] };
    const fence = Number(await this.#run(ACQUIRE_FENCED_SHA, ACQUIRE_FENCED_SCRIPT, options));
    if (fence === 0) {
      return null;
    }
    await this.#replicate();
    return fence;
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    return (
      (await this.#run(RELEASE_SHA, RELEASE_SCRIPT, { keys: [key], arguments: [token] })) === 1
    );
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    const options = { keys: [key], arguments: [token, String(ttl)] };
    const extended = (await this.#run(EXTEND_SHA, EXTEND_SCRIPT, options)) === 1;
    if (extended) {
      await this.#replicate();
    }
    return extended;
  }

  async isHeld({ key, token }: LockKeyParams): Promise<boolean> {
    return (await this.#client.get(key)) === token;
  }

  async #run(sha: string, script: string, options: ScriptOptions): Promise<unknown> {
    try {
      return await this.#client.evalSha(sha, options);
    } catch (error) {
      if (!isNoScriptError(error)) {
        throw error;
      }
      return this.#client.eval(script, options);
    }
  }
}
