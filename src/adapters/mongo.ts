import type { LockAdapter, LockKeyParams, LockLeaseParams } from '../adapter';

type Filter = Record<string, unknown>;
type Pipeline = Array<Record<string, unknown>>;

/** The part of a `mongodb` collection the adapter uses. */
export type MongoLikeCollection = {
  createIndex: (
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean; expireAfterSeconds?: number },
  ) => Promise<unknown>;
  findOneAndUpdate: (
    filter: Filter,
    update: Pipeline,
    options: { upsert: boolean; returnDocument: 'after'; includeResultMetadata: true },
  ) => Promise<unknown>;
  updateOne: (filter: Filter, update: Pipeline) => Promise<{ matchedCount: number }>;
  deleteOne: (filter: Filter) => Promise<{ deletedCount: number }>;
  findOne: (filter: Filter) => Promise<unknown>;
};

export type MongoLikeClient = {
  db: (name?: string) => { collection: (name: string) => MongoLikeCollection };
};

export type MongoAdapterOptions = {
  client: MongoLikeClient;
  dbName?: string;
  /** Default 'locco-locks'. */
  collectionName?: string;
  /** Create the two indexes on first use. Default true. Set false when the role has no rights for it. */
  createIndexes?: boolean;
};

const DUPLICATE_KEY = 11000;

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
  readonly #createIndexes: boolean;
  #indexes: Promise<void> | undefined;

  constructor({
    client,
    dbName,
    collectionName = 'locco-locks',
    createIndexes = true,
  }: MongoAdapterOptions) {
    this.#collection = client.db(dbName).collection(collectionName);
    this.#createIndexes = createIndexes;
  }

  async acquire({ key, token, ttl }: LockLeaseParams): Promise<boolean> {
    await this.#ensureIndexes();
    // `$expr` is not allowed in the filter of an upsert, so the filter is the key alone and the
    // pipeline decides whether the lease is over. The returned document tells who holds it.
    const update: Pipeline = [
      {
        $set: {
          key,
          uniqueValue: { $cond: [EXPIRED, token, '$uniqueValue'] },
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
      if (!isDuplicateKeyError(error)) {
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
    if (!this.#createIndexes) {
      return Promise.resolve();
    }
    if (!this.#indexes) {
      this.#indexes = Promise.all([
        this.#collection.createIndex({ key: 1 }, { unique: true }),
        this.#collection.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      ]).then(
        () => undefined,
        (error: unknown) => {
          // A failed attempt must not poison every later call, so the next call tries again.
          this.#indexes = undefined;
          throw error;
        },
      );
    }
    return this.#indexes;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
