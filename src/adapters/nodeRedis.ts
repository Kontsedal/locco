import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';
import {
  EXTEND_SCRIPT,
  EXTEND_SHA,
  isNoScriptError,
  RELEASE_SCRIPT,
  RELEASE_SHA,
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
};

export type NodeRedisAdapterOptions = {
  client: NodeRedisLikeClient;
};

export class NodeRedisAdapter implements LockAdapter {
  readonly #client: NodeRedisLikeClient;

  constructor({ client }: NodeRedisAdapterOptions) {
    this.#client = client;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    return (await this.#client.set(key, token, { PX: ttl, NX: true })) === 'OK';
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    return (
      (await this.#run(RELEASE_SHA, RELEASE_SCRIPT, { keys: [key], arguments: [token] })) === 1
    );
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    const options = { keys: [key], arguments: [token, String(ttl)] };
    return (await this.#run(EXTEND_SHA, EXTEND_SCRIPT, options)) === 1;
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
