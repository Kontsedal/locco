import { Collection, MongoClient } from "mongodb";
import { LockCreateError, LockExtendError, LockReleaseError } from "../errors";
import { ILockAdapter } from "./lockAdapterInterface";
import * as validators from "../utils/validators";

const MONGO_DUPLICATE_ERROR_CODE = 11000;

export class MongoAdapter implements ILockAdapter {
  private client: MongoClient;
  private collection: Collection;
  private indexesCreated: boolean;

  constructor({
    client,
    locksCollectionName = "locco-locks",
    dbName,
  }: {
    client: MongoClient;
    dbName?: string;
    locksCollectionName?: string;
  }) {
    this.client = client;
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
      if (error.code === MONGO_DUPLICATE_ERROR_CODE) {
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
      if (error.code === MONGO_DUPLICATE_ERROR_CODE) {
        throw new LockExtendError();
      }
      throw error;
    }
  }
}
