import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { createClient } from 'redis';
import type { LockAdapter } from '../adapter';
import { InMemoryAdapter } from '../adapters/inMemory';
import { IoRedisAdapter } from '../adapters/ioRedis';
import { MongoAdapter } from '../adapters/mongo';
import { NodeRedisAdapter } from '../adapters/nodeRedis';
import { PostgresAdapter } from '../adapters/postgres';
import { TEST_CONFIG } from './config';

export type Backend = {
  adapter: LockAdapter;
  close: () => Promise<unknown> | unknown;
};

export const uniqueKey = (prefix = 'locco-test') => `${prefix}:${randomUUID()}`;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function memoryBackend(): Backend {
  const adapter = new InMemoryAdapter();
  return { adapter, close: () => adapter.clear() };
}

export function ioRedisClient(): Redis {
  return new Redis(TEST_CONFIG.REDIS_PORT);
}

export function ioRedisBackend(): Backend {
  const client = ioRedisClient();
  return { adapter: new IoRedisAdapter({ client }), close: () => client.quit() };
}

/** Closes a `redis` client of any supported major: 5 added `close()`, 4 only has `quit()`. */
export function closeNodeRedis(client: {
  close?: () => Promise<unknown>;
  quit: () => Promise<unknown>;
}) {
  return typeof client.close === 'function' ? client.close() : client.quit();
}

export async function nodeRedisBackend(): Promise<Backend> {
  const client = createClient({ url: `redis://localhost:${TEST_CONFIG.REDIS_PORT}` });
  await client.connect();
  return { adapter: new NodeRedisAdapter({ client }), close: () => closeNodeRedis(client) };
}

export async function mongoClient(): Promise<MongoClient> {
  const client = new MongoClient(TEST_CONFIG.MONGO_URL);
  await client.connect();
  return client;
}

export async function mongoBackend(): Promise<Backend> {
  const client = await mongoClient();
  return { adapter: new MongoAdapter({ client }), close: () => client.close() };
}

export function postgresPool(): Pool {
  return new Pool({ connectionString: TEST_CONFIG.POSTGRES_URL });
}

export function postgresBackend(): Backend {
  const pool = postgresPool();
  const adapter = new PostgresAdapter({ client: pool });
  return {
    adapter,
    close: async () => {
      // Postgres has no TTL reaper, so a row outlives the run that wrote it and the table grows
      // with every `npm test`. Sweeping is safe while other workers hold live leases; dropping
      // the table would not be, because test files run in parallel.
      await adapter.sweepExpired();
      await pool.end();
    },
  };
}

export const ALL_BACKENDS: Array<[string, () => Backend | Promise<Backend>]> = [
  ['InMemoryAdapter', memoryBackend],
  ['IoRedisAdapter', ioRedisBackend],
  ['NodeRedisAdapter', nodeRedisBackend],
  ['MongoAdapter', mongoBackend],
  ['PostgresAdapter', postgresBackend],
];
