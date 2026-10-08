import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresAdapter, type PostgresLikeClient, postgresLocksDdl } from '../adapters/postgres';
import { ValidationError } from '../errors';
import { postgresPool, sleep, uniqueKey } from './backends';

/** 58 characters: a valid table name whose `_fence` sequence name would pass the 63-byte limit. */
const LONG_NAME = `locco_test_${'x'.repeat(47)}`;

describe('PostgresAdapter', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = postgresPool();
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS "locco_test_locks"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_sweep"');
    await pool.query('DROP TABLE IF EXISTS "excluded"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_unkeyed"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_premade"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_late"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_include"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_invalid"');
    await pool.query('DROP TABLE IF EXISTS "locco_test_noseq"');
    await pool.query(`DROP TABLE IF EXISTS "${LONG_NAME}"`);
    for (const table of [
      'locco_test_locks',
      'locco_test_sweep',
      'excluded',
      'locco_test_premade',
    ]) {
      await pool.query(`DROP SEQUENCE IF EXISTS "${table}_fence"`);
    }
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

  it('refuses to work when createTable is off and the table is missing', async () => {
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_missing_table',
      createTable: false,
    });
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).rejects.toThrow(
      /The table "locco_missing_table" does not exist/,
    );
    await expect(adapter.isHeld({ key: uniqueKey(), token: 't' })).rejects.toThrow(ValidationError);
  });

  it('refuses a premade table without a unique key, which ON CONFLICT needs', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS "locco_test_unkeyed" (key text, value text NOT NULL, expires_at timestamptz NOT NULL)',
    );
    // A composite or partial index does not keep two rows of one key apart either.
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "locco_test_unkeyed_pair" ON "locco_test_unkeyed" (key, value)',
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "locco_test_unkeyed_partial" ON "locco_test_unkeyed" (key) WHERE value <> ''`,
    );
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_test_unkeyed',
      createTable: false,
    });
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).rejects.toThrow(
      /has no primary key or unique index on key alone/,
    );
  });

  it('checks a premade table once, and again after a failed check', async () => {
    const query = vi.fn(pool.query.bind(pool)) as unknown as PostgresLikeClient['query'];
    const adapter = new PostgresAdapter({
      client: { query },
      tableName: 'locco_test_late',
      createTable: false,
    });
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).rejects.toThrow(
      ValidationError,
    );
    // The migration ran after the process started.
    await pool.query(postgresLocksDdl('locco_test_late'));
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).resolves.toBe(true);
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).resolves.toBe(true);
    const checks = (query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([text]) => typeof text === 'string' && text.includes('to_regclass'),
    );
    expect(checks).toHaveLength(2);
    expect(
      (query as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        ([text]) => typeof text === 'string' && text.startsWith('CREATE'),
      ),
    ).toBe(false);
    await pool.query('DROP SEQUENCE IF EXISTS "locco_test_late_fence"');
  });

  it('accepts a premade unique index with INCLUDE columns, which ON CONFLICT accepts too', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS "locco_test_include" (key text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL)',
    );
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "locco_test_include_key" ON "locco_test_include" (key) INCLUDE (value)',
    );
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_test_include',
      createTable: false,
    });
    const key = uniqueKey();
    await expect(adapter.acquire({ key, token: 'a', ttl: 1000 })).resolves.toBe(true);
    await expect(adapter.acquire({ key, token: 'b', ttl: 1000 })).resolves.toBe(false);
  });

  it('refuses an invalid unique index, such as one a failed CREATE INDEX CONCURRENTLY left', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS "locco_test_invalid" (key text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL)',
    );
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "locco_test_invalid_key" ON "locco_test_invalid" (key)',
    );
    // The test role is a superuser, so it can mark the index the way a failed build leaves it.
    await pool.query(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"locco_test_invalid_key"'::regclass`,
    );
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_test_invalid',
      createTable: false,
    });
    await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).rejects.toThrow(
      /no primary key or unique index on key alone/,
    );
  });

  it('names a missing fence sequence on a premade table, and checks again after it is made', async () => {
    await pool.query(postgresLocksDdl('locco_test_noseq'));
    await pool.query('DROP SEQUENCE "locco_test_noseq_fence"');
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_test_noseq',
      createTable: false,
    });
    const key = uniqueKey();
    await expect(adapter.acquireFenced({ key, token: 't', ttl: 1000 })).rejects.toThrow(
      /The fence sequence "locco_test_noseq_fence" does not exist/,
    );
    // Plain locks on the same table do not need the sequence.
    await expect(adapter.acquire({ key, token: 't', ttl: 1000 })).resolves.toBe(true);
    await pool.query('CREATE SEQUENCE "locco_test_noseq_fence"');
    await expect(adapter.acquireFenced({ key: uniqueKey(), token: 't', ttl: 1000 })).resolves.toBe(
      1,
    );
    await pool.query('DROP SEQUENCE "locco_test_noseq_fence"');
  });

  it('refuses fencing on a table name too long for its sequence name, and still locks', async () => {
    const adapter = new PostgresAdapter({ client: pool, tableName: LONG_NAME });
    const key = uniqueKey();
    await expect(adapter.acquireFenced({ key, token: 't', ttl: 1000 })).rejects.toThrow(
      /too long for fencing/,
    );
    await expect(adapter.acquire({ key, token: 't', ttl: 1000 })).resolves.toBe(true);
    // Postgres would truncate the name and make a sequence nothing reads, so none is made.
    expect(postgresLocksDdl(LONG_NAME)).not.toContain('SEQUENCE');
    const stray = await pool.query(
      "SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname LIKE 'locco_test_xxx%'",
    );
    expect(stray.rows).toHaveLength(0);
  });

  it('accepts a premade table from postgresLocksDdl, fences included', async () => {
    await pool.query(postgresLocksDdl('locco_test_premade'));
    const adapter = new PostgresAdapter({
      client: pool,
      tableName: 'locco_test_premade',
      createTable: false,
    });
    const key = uniqueKey();
    const first = await adapter.acquireFenced({ key, token: 'a', ttl: 1000 });
    await expect(adapter.acquireFenced({ key, token: 'b', ttl: 1000 })).resolves.toBeNull();
    await adapter.release({ key, token: 'a' });
    const second = await adapter.acquireFenced({ key, token: 'b', ttl: 1000 });
    expect(typeof first).toBe('number');
    expect(second).toBeGreaterThan(first as number);
  });

  it('creates the fence sequence next to the table', async () => {
    const adapter = new PostgresAdapter({ client: pool, tableName: 'locco_test_locks' });
    await expect(
      adapter.acquireFenced({ key: uniqueKey(), token: 't', ttl: 1000 }),
    ).resolves.toEqual(expect.any(Number));
    const found = await pool.query(`SELECT to_regclass('"locco_test_locks_fence"') AS seq`);
    expect(found.rows[0]).toEqual({ seq: 'locco_test_locks_fence' });
    expect(postgresLocksDdl('public.locks')).toContain(
      'CREATE SEQUENCE IF NOT EXISTS "public"."locks_fence"',
    );
  });

  it('accepts only a plain or schema-qualified identifier', () => {
    // A ValidationError, not a bare TypeError: the README tells consumers to switch on
    // `error.code`, and LOCK_VALIDATION has to cover every wrong argument to reach them.
    expect(() => new PostgresAdapter({ client: pool, tableName: 'locks; DROP TABLE x' })).toThrow(
      ValidationError,
    );
    expect(() => new PostgresAdapter({ client: pool, tableName: 'a.b.c' })).toThrow(
      ValidationError,
    );
    expect(() => new PostgresAdapter(undefined as never)).toThrow(ValidationError);
    expect(() => new PostgresAdapter({ client: pool, tableName: 'locks; DROP TABLE x' })).toThrow(
      /must be a plain or schema-qualified SQL identifier/,
    );
    expect(
      () => new PostgresAdapter({ client: pool, tableName: 'public.locco_locks' }),
    ).not.toThrow();
    expect(postgresLocksDdl('public.locco_locks')).toContain('"public"."locco_locks"');
  });

  it('works with a table named after the EXCLUDED pseudo-relation', async () => {
    const adapter = new PostgresAdapter({ client: pool, tableName: 'excluded' });
    const key = uniqueKey();
    await expect(adapter.acquire({ key, token: 'a', ttl: 100 })).resolves.toBe(true);
    await expect(adapter.acquire({ key, token: 'b', ttl: 100 })).resolves.toBe(false);
    await sleep(150);
    await expect(adapter.acquire({ key, token: 'b', ttl: 5000 })).resolves.toBe(true);
    await expect(adapter.release({ key, token: 'b' })).resolves.toBe(true);
  });

  it('treats a lost CREATE TABLE race as success, so the first acquire still works', async () => {
    // Postgres does not make CREATE TABLE IF NOT EXISTS race-proof. Two instances starting
    // together can make one of them see 23505 or 42P07; the table exists either way.
    for (const code of ['23505', '42P07']) {
      const client: PostgresLikeClient = {
        query: (text, values) => {
          if (text.startsWith('CREATE')) {
            return Promise.reject(Object.assign(new Error(`duplicate ${code}`), { code }));
          }
          return pool.query(text, values);
        },
      };
      const adapter = new PostgresAdapter({ client, tableName: 'locco_test_locks' });
      await expect(adapter.acquire({ key: uniqueKey(), token: 't', ttl: 1000 })).resolves.toBe(
        true,
      );
    }
  });

  it('answers 0 when the driver reports no row count for the sweep', async () => {
    const client: PostgresLikeClient = {
      query: async () => ({ rowCount: null, rows: [] }),
    };
    const adapter = new PostgresAdapter({ client, tableName: 'locco_test_sweep' });
    await expect(adapter.sweepExpired()).resolves.toBe(0);
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
