import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresAdapter, type PostgresLikeClient, postgresLocksDdl } from '../adapters/postgres';
import { postgresPool, sleep, uniqueKey } from './backends';

describe('PostgresAdapter', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = postgresPool();
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS "locco_test_locks"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_sweep"');
    await pool.end();
  });

  it('creates its table on first use, once', async () => {
    const query = vi.fn(pool.query.bind(pool)) as unknown as PostgresLikeClient['query'];
    const adapter = new PostgresAdapter({ client: { query }, tableName: 'locco_test_locks' });
    await adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 });
    await adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 });
    const creates = (query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([text]) => typeof text === 'string' && text.startsWith('CREATE TABLE'),
    );
    expect(creates).toHaveLength(1);
  });

  it('tries the table creation again after a failure', async () => {
    let failOnce = true;
    const client: PostgresLikeClient = {
      query: (text, values) => {
        if (failOnce && text.startsWith('CREATE TABLE')) {
          failOnce = false;
          return Promise.reject(new Error('connection reset'));
        }
        return pool.query(text, values);
      },
    };
    const adapter = new PostgresAdapter({ client, tableName: 'locco_test_locks' });
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).rejects.toThrow(
      'connection reset',
    );
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).resolves.toBe(true);
  });

  it('lets the driver error through when createTable is off and the table is missing', async () => {
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_missing_table',
      createTable: false,
    });
    await expect(
      adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 }),
    ).rejects.toMatchObject({ code: '42P01' });
  });

  it('accepts only a plain or schema-qualified identifier', () => {
    expect(() => new PostgresAdapter({ client: pool, tableName: 'locks; DROP TABLE x' })).toThrow(
      TypeError,
    );
    expect(() => new PostgresAdapter({ client: pool, tableName: 'a.b.c' })).toThrow(TypeError);
    expect(
      () => new PostgresAdapter({ client: pool, tableName: 'public.locco_locks' }),
    ).not.toThrow();
    expect(postgresLocksDdl('public.locco_locks')).toContain('"public"."locco_locks"');
  });

  it('sweeps the rows whose lease is over and keeps the live ones', async () => {
    const adapter = new PostgresAdapter({ client: pool, tableName: 'locco_test_sweep' });
    const live = uniqueKey();
    await adapter.acquire({ key: uniqueKey(), token: 'a', ttl: 100 });
    await adapter.acquire({ key: uniqueKey(), token: 'b', ttl: 100 });
    await adapter.acquire({ key: live, token: 'c', ttl: 10_000 });
    await sleep(150);
    await expect(adapter.sweepExpired()).resolves.toBe(2);
    await expect(adapter.isHeld({ key: live, token: 'c' })).resolves.toBe(true);
    await expect(adapter.sweepExpired()).resolves.toBe(0);
  });
});
