import { Collection, MongoClient } from "mongodb";
import { LockCreateError, LockReleaseError } from "../errors";
import { ILockAdapter } from "./LockAdapterInterface";

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

  private async initialize() {
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
    await this.initialize();
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
      const DUPLICATE_ERROR_CODE = 11000;
      if (error.code === DUPLICATE_ERROR_CODE) {
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
    const result = await this.collection.deleteOne({
      key,
      uniqueValue,
    });
    if (result.deletedCount === 0) {
      throw new LockReleaseError();
    }
  }
}
