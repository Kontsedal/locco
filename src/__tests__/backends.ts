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

export async function nodeRedisBackend(): Promise<Backend> {
  const client = createClient({ url: `redis://localhost:${TEST_CONFIG.REDIS_PORT}` });
  await client.connect();
  return { adapter: new NodeRedisAdapter({ client }), close: () => client.close() };
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
  return { adapter: new PostgresAdapter({ client: pool }), close: () => pool.end() };
}

export const ALL_BACKENDS: Array<[string, () => Backend | Promise<Backend>]> = [
  ['InMemoryAdapter', memoryBackend],
  ['IoRedisAdapter', ioRedisBackend],
  ['NodeRedisAdapter', nodeRedisBackend],
  ['MongoAdapter', mongoBackend],
  ['PostgresAdapter', postgresBackend],
];
