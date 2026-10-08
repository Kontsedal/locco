import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';
import { ValidationError } from '../errors';

/** The part of a `pg` Pool or Client the adapter uses. */
export type PostgresLikeClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: unknown[] }>;
};

export type PostgresAdapterOptions = {
  /** A Pool, or a Client that is not inside a transaction. */
  client: PostgresLikeClient;
  /** Plain or schema-qualified identifier. Default 'locco_locks'. */
  tableName?: string;
  /**
   * Create the table and the fence sequence on first use. Default true. Set false when the role
   * has no DDL rights; the adapter then checks once that the table exists with its primary key.
   */
  createTable?: boolean;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `clock_timestamp()` moves during a statement. `now()` is frozen at its start and would write a stale expiry after a lock wait. */
const LEASE_END = "clock_timestamp() + $3::double precision * interval '1 millisecond'";

/** Postgres truncates a longer identifier to this many bytes, which would lose the `_fence` suffix. */
const MAX_IDENTIFIER_LENGTH = 63;

/** `<table>_fence`, in the table's schema. */
function fenceSequenceName(tableName: string): string {
  return `${tableName}_fence`;
}

/** Whether `<table>_fence` fits in an identifier. A longer table name can still lock, but not fence. */
function fenceSequenceFits(tableName: string): boolean {
  return (fenceSequenceName(tableName).split('.').at(-1) as string).length <= MAX_IDENTIFIER_LENGTH;
}

/** The statements that create the table and the fence sequence, one per element. */
function ddlStatements(tableName: string): string[] {
  const table = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  expires_at timestamptz NOT NULL
)`;
  if (!fenceSequenceFits(tableName)) {
    return [table];
  }
  return [table, `CREATE SEQUENCE IF NOT EXISTS ${quoteIdentifier(fenceSequenceName(tableName))}`];
}

/** The DDL for a migration: the table, and the sequence that `acquireFenced` draws from. */
export function postgresLocksDdl(tableName = 'locco_locks'): string {
  return `${ddlStatements(tableName).join(';\n\n')};`;
}

export class PostgresAdapter implements LockAdapter {
  readonly #client: PostgresLikeClient;
  readonly #table: string;
  readonly #tableName: string;
  readonly #ddl: string[];
  readonly #fenceSequence: string;
  readonly #fenceNameTooLong: boolean;
  readonly #createTable: boolean;
  #tableReady: Promise<void> | undefined;
  #fenceReady: Promise<void> | undefined;

  constructor(options: PostgresAdapterOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new ValidationError('PostgresAdapter options must be an object with a client');
    }
    const { client, tableName = 'locco_locks', createTable = true } = options;
    this.#client = client;
    this.#table = quoteIdentifier(tableName);
    this.#tableName = tableName;
    this.#ddl = ddlStatements(tableName);
    this.#fenceSequence = quoteIdentifier(fenceSequenceName(tableName));
    this.#fenceNameTooLong = !fenceSequenceFits(tableName);
    this.#createTable = createTable;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    await this.#ensureTable();
    const result = await this.#client.query(
      `INSERT INTO ${this.#table} AS locks (key, value, expires_at)
       VALUES ($1, $2, ${LEASE_END})
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = ${LEASE_END}
         WHERE locks.expires_at <= clock_timestamp()
       RETURNING key`,
      [key, token, ttl],
    );
    return result.rows.length === 1;
  }

  /**
   * The same statement as `acquire`, returning `nextval` of the fence sequence. RETURNING runs
   * only for a row the statement wrote, while it holds that row's lock, so a competing acquire of
   * the key waits for the commit and draws a later value.
   */
  async acquireFenced({ key, token, ttl }: LockLeaseParams): Promise<number | null> {
    await this.#ensureTable();
    await this.#ensureFence();
    const result = await this.#client.query(
      `INSERT INTO ${this.#table} AS locks (key, value, expires_at)
       VALUES ($1, $2, ${LEASE_END})
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = ${LEASE_END}
         WHERE locks.expires_at <= clock_timestamp()
       RETURNING nextval('${this.#fenceSequence}') AS fence`,
      [key, token, ttl],
    );
    const row = result.rows[0] as { fence: string | number } | undefined;
    // `pg` returns a bigint as a string.
    return row === undefined ? null : Number(row.fence);
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    await this.#ensureTable();
    const result = await this.#client.query(
      `DELETE FROM ${this.#table} WHERE key = $1 AND value = $2 AND expires_at > clock_timestamp()`,
      [key, token],
    );
    return result.rowCount === 1;
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    await this.#ensureTable();
    const result = await this.#client.query(
      `UPDATE ${this.#table} SET expires_at = ${LEASE_END}
       WHERE key = $1 AND value = $2 AND expires_at > clock_timestamp()`,
      [key, token, ttl],
    );
    return result.rowCount === 1;
  }

  async isHeld({ key, token }: LockKeyParams): Promise<boolean> {
    await this.#ensureTable();
    const result = await this.#client.query(
      `SELECT 1 FROM ${this.#table} WHERE key = $1 AND value = $2 AND expires_at > clock_timestamp()`,
      [key, token],
    );
    return result.rows.length === 1;
  }

  /** Deletes the rows whose lease is over. Returns how many. Schedule it; nothing runs it for you. */
  async sweepExpired(): Promise<number> {
    await this.#ensureTable();
    const result = await this.#client.query(
      `DELETE FROM ${this.#table} WHERE expires_at <= clock_timestamp()`,
    );
    return result.rowCount ?? 0;
  }

  #ensureTable(): Promise<void> {
    this.#tableReady ??= (this.#createTable ? this.#create() : this.#verify()).catch(
      (error: unknown) => {
        // A failed attempt must not poison every later call, so the next call tries again.
        this.#tableReady = undefined;
        throw error;
      },
    );
    return this.#tableReady;
  }

  /**
   * A table made by a 2.0 migration has no fence sequence, and `nextval` would then fail on every
   * fenced acquire with a bare 42P01. With `createTable` on, `#create` made the sequence already.
   */
  #ensureFence(): Promise<void> {
    if (this.#fenceNameTooLong) {
      return Promise.reject(
        new ValidationError(
          `tableName "${this.#tableName}" is too long for fencing: its sequence name "${fenceSequenceName(this.#tableName)}" exceeds ${MAX_IDENTIFIER_LENGTH} characters`,
        ),
      );
    }
    if (this.#createTable) {
      return Promise.resolve();
    }
    this.#fenceReady ??= this.#verifyFence().catch((error: unknown) => {
      this.#fenceReady = undefined;
      throw error;
    });
    return this.#fenceReady;
  }

  async #verifyFence(): Promise<void> {
    const result = await this.#client.query('SELECT to_regclass($1) IS NOT NULL AS found', [
      this.#fenceSequence,
    ]);
    if (!(result.rows[0] as { found: boolean }).found) {
      throw new ValidationError(
        `The fence sequence "${fenceSequenceName(this.#tableName)}" does not exist, so fenced acquires cannot work. Create it from postgresLocksDdl().`,
      );
    }
  }

  async #create(): Promise<void> {
    for (const statement of this.#ddl) {
      try {
        await this.#client.query(statement);
      } catch (error) {
        // Postgres does not make CREATE ... IF NOT EXISTS immune to a race: two sessions running
        // it at once can raise a duplicate-key or duplicate-table error. The relation exists
        // either way, so the loser proceeds instead of failing its first acquire.
        if (!isConcurrentCreate(error)) {
          throw error;
        }
      }
    }
  }

  /**
   * Without a unique index on `key` alone, `ON CONFLICT (key)` has no arbiter and every acquire
   * fails. Checking once names the cause instead of leaving it to the first acquire.
   */
  async #verify(): Promise<void> {
    const result = await this.#client.query(
      `SELECT to_regclass($1) IS NOT NULL AS found,
              EXISTS (
                SELECT 1 FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                WHERE i.indrelid = to_regclass($1) AND i.indisunique AND i.indimmediate
                  AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
                  AND a.attname = 'key'
                  -- Key columns only: INCLUDE columns do not count against the arbiter. The
                  -- column is new in Postgres 11, and reading it through to_jsonb keeps the
                  -- statement valid on older servers, where indnatts has the same meaning.
                  AND COALESCE((to_jsonb(i) ->> 'indnkeyatts')::int, i.indnatts) = 1
              ) AS keyed`,
      [this.#table],
    );
    const row = result.rows[0] as { found: boolean; keyed: boolean };
    if (!row.found) {
      throw new ValidationError(
        `The table "${this.#tableName}" does not exist. Create it from postgresLocksDdl(), or leave createTable on.`,
      );
    }
    if (!row.keyed) {
      throw new ValidationError(
        `The table "${this.#tableName}" has no primary key or unique index on key alone, so acquire cannot work. Create it from postgresLocksDdl().`,
      );
    }
  }
}

function quoteIdentifier(name: string): string {
  const parts = name.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new ValidationError(
      `tableName "${name}" must be a plain or schema-qualified SQL identifier, because it is interpolated into SQL`,
    );
  }
  return parts.map((part) => `"${part}"`).join('.');
}

/** 23505 unique_violation on a catalog index, 42P07 duplicate_table. Both mean someone won the race. */
function isConcurrentCreate(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '23505' || code === '42P07';
}
