import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';

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
  /** Create the table on first use. Default true. Set false when the role has no DDL rights. */
  createTable?: boolean;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `clock_timestamp()` moves during a statement. `now()` is frozen at its start and would write a stale expiry after a lock wait. */
const LEASE_END = "clock_timestamp() + $3::double precision * interval '1 millisecond'";

export function postgresLocksDdl(tableName = 'locco_locks'): string {
  const table = quoteIdentifier(tableName);
  return `CREATE TABLE IF NOT EXISTS ${table} (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  expires_at timestamptz NOT NULL
)`;
}

export class PostgresAdapter implements LockAdapter {
  readonly #client: PostgresLikeClient;
  readonly #table: string;
  readonly #ddl: string;
  readonly #createTable: boolean;
  #tableReady: Promise<void> | undefined;

  constructor({ client, tableName = 'locco_locks', createTable = true }: PostgresAdapterOptions) {
    this.#client = client;
    this.#table = quoteIdentifier(tableName);
    this.#ddl = postgresLocksDdl(tableName);
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
    if (!this.#createTable) {
      return Promise.resolve();
    }
    if (!this.#tableReady) {
      this.#tableReady = this.#client.query(this.#ddl).then(
        () => undefined,
        (error: unknown) => {
          // A failed attempt must not poison every later call, so the next call tries again.
          this.#tableReady = undefined;
          throw error;
        },
      );
    }
    return this.#tableReady;
  }
}

function quoteIdentifier(name: string): string {
  const parts = name.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new TypeError(
      `tableName "${name}" must be a plain or schema-qualified SQL identifier, because it is interpolated into SQL`,
    );
  }
  return parts.map((part) => `"${part}"`).join('.');
}
