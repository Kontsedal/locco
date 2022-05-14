import { Collection, MongoClient } from "mongodb";
import { LockCreateError, LockExtendError, LockReleaseError } from "../errors";
import { ILockAdapter } from "./LockAdapterInterface";

const MONGO_DUPLICATE_ERROR_CODE = 11000;

export class MongoAdapter implements ILockAdapter {
  private client: MongoClient;
  private collection: Collection;
  private initialized: boolean;

  constructor({
    client,
    locksCollectionName = "locco-locks",
    dbName,
  }: {
    client: MongoClient;
    dbName: string;
    locksCollectionName: string;
  }) {
    this.client = client;
    this.collection = client.db(dbName).collection(locksCollectionName);
  }

  private async createIndexes() {
    if (this.initialized) {
      return;
    }
    await Promise.all([
      this.collection.createIndex({ key: 1 }, { unique: true }),
      this.collection.createIndex(
        { key: 1, expireAt: 1 },
        { background: true }
      ),
    ]);
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
    await this.createIndexes();
    const result = await this.collection.deleteOne({
      key,
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
    await this.createIndexes();
    try {
      await this.collection.updateOne(
        {
          key,
          uniqueValue,
          expireAt: { $gt: new Date() },
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
