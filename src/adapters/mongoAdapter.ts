import { ILockAdapter } from "./lockAdapterInterface";
import { isMongoError } from "../utils/validators";
import { LockCreateError, LockExtendError, LockReleaseError } from "../errors";
import * as validators from "../utils/validators";

const MONGO_DUPLICATE_ERROR_CODE = 11000;

export type MongoLikeClient = {
  db: (name?: string) => { collection: (name: string) => MongoLikeCollection };
};

export type MongoLikeCollection = {
  createIndex: (
    spec: Record<string, 1 | -1>,
    options: {
      unique?: boolean;
      expireAfterSeconds?: number;
      background?: boolean;
    }
  ) => Promise<unknown>;
  updateOne: (
    query: Record<string, any>,
    setter: Record<string, any>,
    options?: { upsert?: boolean }
  ) => Promise<unknown>;
  findOne: (query: Record<string, any>) => Promise<unknown>;
  deleteOne: (query: Record<string, any>) => Promise<{ deletedCount: number }>;
};

export class MongoAdapter implements ILockAdapter {
  private collection: MongoLikeCollection;
  private indexesCreated = false;

  constructor({
    client,
    locksCollectionName = "locco-locks",
    dbName,
  }: {
    client: MongoLikeClient;
    dbName?: string;
    locksCollectionName?: string;
  }) {
    this.collection = client.db(dbName).collection(locksCollectionName);
  }

  private async createIndexes() {
    if (this.indexesCreated) {
      return;
    }
    await Promise.all([
      this.collection.createIndex({ key: 1 }, { unique: true }),
      this.collection.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      this.collection.createIndex(
        { key: 1, expireAt: 1, uniqueValue: 1 },
        { background: true }
      ),
    ]);
    this.indexesCreated = true;
  }

  async createLock({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) {
    validators.validateTtl(ttl);
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    await this.createIndexes();
    try {
      await this.collection.updateOne(
        {
          key,
          expireAt: { $lt: new Date() },
        },
        { $set: { key, uniqueValue, expireAt: new Date(Date.now() + ttl) } },
        { upsert: true }
      );
    } catch (error) {
      if (isMongoError(error) && error?.code === MONGO_DUPLICATE_ERROR_CODE) {
        throw new LockCreateError();
      }
      throw error;
    }
  }

  async releaseLock({
    key,
    uniqueValue,
  }: {
    key: string;
    uniqueValue: string;
  }) {
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    await this.createIndexes();
    const result = await this.collection.deleteOne({
      key,
      expireAt: { $gt: new Date() },
      uniqueValue,
    });
    if (result.deletedCount === 0) {
      throw new LockReleaseError();
    }
  }

  async extendLock({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) {
    validators.validateTtl(ttl);
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    await this.createIndexes();
    try {
      await this.collection.updateOne(
        {
          key,
          expireAt: { $gt: new Date() },
          uniqueValue,
        },
        { $set: { key, uniqueValue, expireAt: new Date(Date.now() + ttl) } },
        { upsert: true }
      );
    } catch (error) {
      if (isMongoError(error) && error?.code === MONGO_DUPLICATE_ERROR_CODE) {
        throw new LockExtendError();
      }
      throw error;
    }
  }

  async isValidLock({
    key,
    uniqueValue,
  }: {
    key: string;
    uniqueValue: string;
  }) {
    validators.validateKey(key);
    validators.validateUniqueValue(uniqueValue);
    const entry = await this.collection.findOne({
      key,
      expireAt: { $gt: new Date() },
      uniqueValue,
    });
    return Boolean(entry);
  }
}
