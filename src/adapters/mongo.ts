import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';
import { ValidationError } from '../errors';

type Filter = Record<string, unknown>;
type Pipeline = Array<Record<string, unknown>>;

/** The part of a `mongodb` collection the adapter uses. */
export type MongoLikeCollection = {
  createIndex: (
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean; expireAfterSeconds?: number },
  ) => Promise<unknown>;
  indexes: () => Promise<Array<{ key: Record<string, unknown>; unique?: boolean }>>;
  findOneAndUpdate: (
    filter: Filter,
    update: Pipeline,
    options: { upsert: boolean; returnDocument: 'after'; includeResultMetadata: true },
  ) => Promise<unknown>;
  updateOne: (filter: Filter, update: Pipeline) => Promise<{ matchedCount: number }>;
  deleteOne: (filter: Filter) => Promise<{ deletedCount: number }>;
  findOne: (filter: Filter) => Promise<unknown>;
};

/** The write concern options the adapter passes to `db().collection()`. */
export type MongoWriteConcern = {
  w?: number | 'majority';
  journal?: boolean;
  wtimeoutMS?: number;
};

export type MongoLikeClient = {
  db: (name?: string) => {
    collection: (
      name: string,
      options: { readPreference: 'primary'; writeConcern: MongoWriteConcern },
    ) => MongoLikeCollection;
  };
};

export type MongoAdapterOptions = {
  client: MongoLikeClient;
  dbName?: string;
  /** Default 'locco-locks'. Named `locksCollectionName` in 1.x. */
  collectionName?: string;
  /**
   * Create the two indexes on first use. Default true. Set false when the role has no rights for
   * it; the adapter then checks once that the unique index on `key` exists, and refuses to work
   * without it.
   */
  createIndexes?: boolean;
  /**
   * Default `{ w: 'majority' }`. A lock acknowledged by the primary alone is lost when a failover
   * rolls the write back, and another caller can then acquire the same key.
   */
  writeConcern?: MongoWriteConcern;
};

/** The indexes the adapter needs, in the shape `collection.createIndexes()` takes. */
export function mongoLocksIndexes(): Array<{
  key: Record<string, 1>;
  unique?: boolean;
  expireAfterSeconds?: number;
}> {
  return [
    // Without it, two upserts of a missing key can both insert a document, and both callers win.
    { key: { key: 1 }, unique: true },
    // Removes expired documents in the background. Expiry itself is read from `expireAt`.
    { key: { expireAt: 1 }, expireAfterSeconds: 0 },
  ];
}

const DUPLICATE_KEY = 11000;
const NAMESPACE_NOT_FOUND = 26;

/** The lease is over when `expireAt` is missing or not after the server clock. */
const EXPIRED = { $lte: [{ $ifNull: ['$expireAt', new Date(0)] }, '$$NOW'] };

const LIVE_AND_OURS = (key: string, token: string): Filter => ({
  key,
  uniqueValue: token,
  $expr: { $gt: ['$expireAt', '$$NOW'] },
});

/**
 * One document per key: `key`, `uniqueValue`, `expireAt`. The shape is the 1.x shape, so 1.x and
 * 2.x processes share one collection. Expiry is compared on the server clock through `$$NOW`.
 */
export class MongoAdapter implements LockAdapter {
  readonly #collection: MongoLikeCollection;
  readonly #collectionName: string;
  readonly #createIndexes: boolean;
  #indexes: Promise<void> | undefined;

  constructor(options: MongoAdapterOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new ValidationError('MongoAdapter options must be an object with a client');
    }
    if ('locksCollectionName' in options) {
      throw new ValidationError(
        'locksCollectionName was renamed to collectionName in 2.0. The old name would send the locks to the default collection.',
      );
    }
    const {
      client,
      dbName,
      collectionName = 'locco-locks',
      createIndexes = true,
      writeConcern = { w: 'majority' },
    } = options;
    if (typeof writeConcern !== 'object' || writeConcern === null) {
      throw new ValidationError('MongoAdapter writeConcern must be an object, such as { w: 1 }');
    }
    // Every read goes to the primary. A secondary that lags can answer that a lock we were just
    // granted is not ours, and `isHeld` would then mark it lost.
    this.#collection = client
      .db(dbName)
      .collection(collectionName, { readPreference: 'primary', writeConcern });
    this.#collectionName = collectionName;
    this.#createIndexes = createIndexes;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    await this.#ensureIndexes();
    // `$expr` is not allowed in the filter of an upsert, so the filter is the key alone and the
    // pipeline decides whether the lease is over. The returned document tells who holds it.
    // In a pipeline a string that starts with `$` is a field path, so the values go in `$literal`.
    const update: Pipeline = [
      {
        $set: {
          key: { $literal: key },
          uniqueValue: { $cond: [EXPIRED, { $literal: token }, '$uniqueValue'] },
          expireAt: { $cond: [EXPIRED, { $add: ['$$NOW', ttl] }, '$expireAt'] },
        },
      },
    ];
    const run = () =>
      this.#collection.findOneAndUpdate({ key }, update, {
        upsert: true,
        returnDocument: 'after',
        includeResultMetadata: true,
      });
    let result: unknown;
    try {
      result = await run();
    } catch (error) {
      // Two upserts of a missing key race on the insert. The loser retries and takes the update path.
      if (!hasCode(error, DUPLICATE_KEY)) {
        throw error;
      }
      result = await run();
    }
    const document = (result as { value?: { uniqueValue?: unknown } | null } | null)?.value;
    return document?.uniqueValue === token;
  }

  async release({ key, token }: LockKeyParams): Promise<boolean> {
    await this.#ensureIndexes();
    const result = await this.#collection.deleteOne(LIVE_AND_OURS(key, token));
    return result.deletedCount === 1;
  }

  async extend({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    await this.#ensureIndexes();
    const result = await this.#collection.updateOne(LIVE_AND_OURS(key, token), [
      { $set: { expireAt: { $add: ['$$NOW', ttl] } } },
    ]);
    return result.matchedCount === 1;
  }

  async isHeld({ key, token }: LockKeyParams): Promise<boolean> {
    await this.#ensureIndexes();
    return (await this.#collection.findOne(LIVE_AND_OURS(key, token))) !== null;
  }

  #ensureIndexes(): Promise<void> {
    this.#indexes ??= (this.#createIndexes ? this.#create() : this.#verify()).catch(
      (error: unknown) => {
        // A failed attempt must not poison every later call, so the next call tries again.
        this.#indexes = undefined;
        throw error;
      },
    );
    return this.#indexes;
  }

  async #create(): Promise<void> {
    await Promise.all(
      mongoLocksIndexes().map(({ key, ...options }) => this.#collection.createIndex(key, options)),
    );
  }

  async #verify(): Promise<void> {
    let indexes: Awaited<ReturnType<MongoLikeCollection['indexes']>> = [];
    try {
      indexes = await this.#collection.indexes();
    } catch (error) {
      // A collection that does not exist yet has no indexes at all.
      if (!hasCode(error, NAMESPACE_NOT_FOUND)) {
        throw error;
      }
    }
    if (!indexes.some(isUniqueOnKey)) {
      throw new ValidationError(
        `The "${this.#collectionName}" collection has no unique index on key. Without it two concurrent acquires can both win. Create the indexes from mongoLocksIndexes(), or leave createIndexes on.`,
      );
    }
  }
}

/** A unique index on `key` alone. A compound or partial one does not keep two documents apart. */
function isUniqueOnKey(index: { key: Record<string, unknown>; unique?: boolean }): boolean {
  const fields = Object.keys(index.key);
  return (
    index.unique === true &&
    fields.length === 1 &&
    fields[0] === 'key' &&
    !('partialFilterExpression' in index)
  );
}

function hasCode(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
