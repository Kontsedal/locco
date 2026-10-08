import { createHash } from 'node:crypto';
import { ValidationError } from '../errors';
import { isPositiveInteger } from '../validate';

/** Deletes the key only while it still carries our token. Answers 1 or 0. */
export const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Sets a new lease only while the key still carries our token. Answers 1 or 0. */
export const EXTEND_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

/**
 * Sets the lock key like `SET NX PX` and, in the same script, takes the next fence of the key.
 * Answers the fence, or 0 when another holder had the key. A script runs alone, so no other grant
 * can fall between the two writes.
 *
 * The fence is at least the server time in microseconds, so it keeps growing after the counter is
 * lost to a restart without persistence, a flush, a failover, or its own expiry. The counter only
 * breaks ties within one microsecond and covers a server clock that steps back. Microseconds since
 * 1970 stay below 2^53, which a JavaScript number holds exactly, until the year 2255.
 *
 * Redis 3.2 to 4 replicate a script verbatim and refuse a write after TIME unless the script asks
 * for its effects to be replicated instead. Later versions always replicate effects.
 */
export const ACQUIRE_FENCED_SCRIPT = `if redis.replicate_commands then
  redis.replicate_commands()
end
if not redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
  return 0
end
local time = redis.call("time")
local now = tonumber(time[1]) * 1000000 + tonumber(time[2])
local fence = math.max(tonumber(redis.call("get", KEYS[2]) or "0") + 1, now)
redis.call("set", KEYS[2], string.format("%.0f", fence), "PX", ARGV[3])
return fence`;

export const RELEASE_SHA = sha1(RELEASE_SCRIPT);
export const EXTEND_SHA = sha1(EXTEND_SCRIPT);
export const ACQUIRE_FENCED_SHA = sha1(ACQUIRE_FENCED_SCRIPT);

/**
 * How long a fence counter outlives the last grant of its key. The time floor makes an expired
 * counter safe, so the expiry only keeps one key per lock key from piling up.
 */
export const FENCE_RETENTION_MS = 86_400_000;

/**
 * The fence counter of a lock key, in the same Redis Cluster hash slot so one script can write
 * both. A key with a hash tag keeps it under a suffix. Any other key becomes the hash tag itself.
 */
export function fenceKeyFor(key: string): string {
  const open = key.indexOf('{');
  const close = open === -1 ? -1 : key.indexOf('}', open + 1);
  if (close > open + 1) {
    return `${key}:locco-fence`;
  }
  return `{${key}}:locco-fence`;
}

/** The ARGV of the fenced acquire after the token: the lease, then the counter's retention. */
export function fencedArguments(ttl: number): [string, string] {
  return [String(ttl), String(Math.max(ttl, FENCE_RETENTION_MS))];
}

function sha1(script: string): string {
  return createHash('sha1').update(script).digest('hex');
}

/** Redis answers NOSCRIPT when the script cache does not hold the sha, for example after a restart. */
export function isNoScriptError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.includes('NOSCRIPT')
  );
}

export type WaitForReplicas = {
  /** How many replicas must acknowledge a write before it counts. */
  replicas: number;
  /** How long `WAIT` blocks for them, in milliseconds. */
  timeout: number;
};

/**
 * A grant or an extension that too few replicas acknowledged in time. The write is on the
 * primary, so whether the lease survives a failover is unknown. It is thrown, not answered as
 * `false`, because `false` would say that another holder has the key.
 */
export class RedisReplicationError extends Error {
  readonly replicas: number;
  readonly acknowledged: number;

  constructor(replicas: number, acknowledged: number) {
    super(`Redis write reached ${acknowledged} of the ${replicas} replicas required`);
    this.name = 'RedisReplicationError';
    this.replicas = replicas;
    this.acknowledged = acknowledged;
  }
}

type WaitFn = (replicas: number, timeout: number) => Promise<unknown>;

/** ioredis `Cluster`, node-redis `createCluster` and node-redis `createClientPool`. */
function isMultiConnection(client: object): boolean {
  return (
    (client as { isCluster?: unknown }).isCluster === true ||
    'masters' in client ||
    'totalClients' in client
  );
}

/**
 * Validates `waitForReplicas` and returns what runs after a write: nothing without the option,
 * and otherwise a `WAIT` that throws RedisReplicationError when too few replicas acknowledged.
 */
export function replicationCheck(options: unknown, client: { wait?: WaitFn }): () => Promise<void> {
  if (options === undefined) {
    return async () => undefined;
  }
  if (typeof options !== 'object' || options === null) {
    throw new ValidationError(
      'waitForReplicas must be an object, such as { replicas: 1, timeout: 100 }',
    );
  }
  const { replicas, timeout } = options as Partial<WaitForReplicas>;
  if (!isPositiveInteger(replicas)) {
    throw new ValidationError('waitForReplicas.replicas must be a positive integer');
  }
  // WAIT with a timeout of 0 blocks until enough replicas answer, which can be forever.
  if (!isPositiveInteger(timeout)) {
    throw new ValidationError('waitForReplicas.timeout must be a positive integer of milliseconds');
  }
  if (typeof client.wait !== 'function') {
    throw new ValidationError('waitForReplicas needs a client with a wait() method');
  }
  // WAIT counts the writes of its own connection. A pool or a cluster client can send it on
  // another connection than the write, and WAIT then confirms nothing about the lock.
  if (isMultiConnection(client)) {
    throw new ValidationError(
      'waitForReplicas needs a client with one connection, not a pool or a cluster client',
    );
  }
  // Bound, because a driver method reads its connection from `this`.
  const wait = client.wait.bind(client);
  return async () => {
    const acknowledged = Number(await wait(replicas, timeout));
    if (!(acknowledged >= replicas)) {
      throw new RedisReplicationError(replicas, acknowledged);
    }
  };
}
