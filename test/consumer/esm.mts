// What an ESM consumer writes. It only has to type-check against the published declarations.
import {
  exponentialBackoff,
  type LockEvent,
  Locker,
  LockHeldError,
  LockLostError,
  type LockLostReason,
} from '@kontsedal/locco';
import { InMemoryAdapter } from '@kontsedal/locco/memory';
import { MongoAdapter, mongoLocksIndexes } from '@kontsedal/locco/mongo';
import { NodeRedisAdapter } from '@kontsedal/locco/node-redis';
import { PostgresAdapter, postgresLocksDdl } from '@kontsedal/locco/postgres';
import { IoRedisAdapter } from '@kontsedal/locco/redis';
import { runLockAdapterContract } from '@kontsedal/locco/testing';

function describeEvent(event: LockEvent): string {
  switch (event.type) {
    case 'acquired':
      return `${event.key} after ${event.waitedMs} ms`;
    case 'extendFailed':
    case 'releaseFailed':
      return String(event.error);
    case 'lost':
      return event.reason satisfies LockLostReason;
    default:
      return `${event.type} ${event.ttl}`;
  }
}

const locker = new Locker({
  adapter: new InMemoryAdapter(),
  retry: { retries: 3, delay: exponentialBackoff({ base: 50 }) },
  onEvent: (event) => {
    describeEvent(event);
  },
});

export async function settle(): Promise<string> {
  await using lock = await locker.acquire('order:1', {
    ttl: 30_000,
    autoExtend: { maxHold: 600_000 },
  });
  lock.signal.throwIfAborted();
  try {
    return await locker.withLock('report', { ttl: 1000 }, async (inner) => `${inner.heldMs}`);
  } catch (error) {
    if (error instanceof LockHeldError) {
      return error.reason;
    }
    if (error instanceof LockLostError && error.completed) {
      return String(error.result);
    }
    throw error;
  }
}

export const adapters = [IoRedisAdapter, NodeRedisAdapter, MongoAdapter, PostgresAdapter];
export const setup = [mongoLocksIndexes(), postgresLocksDdl('locks'), runLockAdapterContract];
