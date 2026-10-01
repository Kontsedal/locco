import { describe, expect, it, vi } from 'vitest';
import { MongoAdapter, type MongoLikeClient, type MongoLikeCollection } from '../adapters/mongo';
import { ValidationError } from '../errors';
import { mongoClient, uniqueKey } from './backends';

function fakeCollection(overrides: Partial<MongoLikeCollection> = {}): MongoLikeCollection {
  return {
    createIndex: vi.fn(async () => 'ok'),
    indexes: vi.fn(async () => [{ key: { _id: 1 } }, { key: { key: 1 }, unique: true }]),
    findOneAndUpdate: vi.fn(async () => ({ value: null })),
    updateOne: vi.fn(async () => ({ matchedCount: 0 })),
    deleteOne: vi.fn(async () => ({ deletedCount: 0 })),
    findOne: vi.fn(async () => null),
    ...overrides,
  };
}

function clientFor(collection: MongoLikeCollection): MongoLikeClient {
  return { db: () => ({ collection: () => collection }) };
}

describe('MongoAdapter', () => {
  it('creates the two indexes once', async () => {
    const collection = fakeCollection();
    const adapter = new MongoAdapter({ client: clientFor(collection) });
    await adapter.isHeld({ key: 'k', token: 't' });
    await adapter.isHeld({ key: 'k', token: 't' });
    expect(collection.createIndex).toHaveBeenCalledTimes(2);
    expect(collection.createIndex).toHaveBeenCalledWith({ key: 1 }, { unique: true });
    expect(collection.createIndex).toHaveBeenCalledWith({ expireAt: 1 }, { expireAfterSeconds: 0 });
  });

  it('rejects the 1.x option name instead of sending locks to the default collection', () => {
    const client = clientFor(fakeCollection());
    expect(() => new MongoAdapter({ client, locksCollectionName: 'x' } as never)).toThrow(
      /renamed to collectionName/,
    );
  });

  it('rejects a missing options object with a ValidationError, not a raw TypeError', () => {
    // The README tells consumers to switch on `error.code`, so every wrong argument has to be a
    // LOCK_VALIDATION error to reach that handling.
    expect(() => new MongoAdapter(undefined as never)).toThrow(ValidationError);
    expect(() => new MongoAdapter(null as never)).toThrow(/must be an object with a client/);
  });

  it('skips index creation when told to, and checks the unique index once instead', async () => {
    const collection = fakeCollection();
    const adapter = new MongoAdapter({ client: clientFor(collection), createIndexes: false });
    await adapter.isHeld({ key: 'k', token: 't' });
    await adapter.isHeld({ key: 'k', token: 't' });
    expect(collection.createIndex).not.toHaveBeenCalled();
    expect(collection.indexes).toHaveBeenCalledTimes(1);
  });

  it('refuses to work without a unique index on key alone', async () => {
    // Without it two upserts of a missing key can both insert a document, and both callers win.
    const missing = [
      [{ key: { _id: 1 } }],
      [{ key: { key: 1 } }],
      [{ key: { key: 1, uniqueValue: 1 }, unique: true }],
      [{ key: { key: 1 }, unique: true, partialFilterExpression: { expireAt: { $exists: true } } }],
    ];
    for (const indexes of missing) {
      const collection = fakeCollection({ indexes: vi.fn(async () => indexes) });
      const adapter = new MongoAdapter({ client: clientFor(collection), createIndexes: false });
      await expect(adapter.acquire({ key: 'k', token: 't', ttl: 1000 })).rejects.toThrow(
        /no unique index on key/,
      );
      expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    }
  });

  it('treats a collection that does not exist as one without the index', async () => {
    const notFound = Object.assign(new Error('ns does not exist'), { code: 26 });
    const collection = fakeCollection({ indexes: vi.fn().mockRejectedValue(notFound) });
    const adapter = new MongoAdapter({ client: clientFor(collection), createIndexes: false });
    await expect(adapter.isHeld({ key: 'k', token: 't' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('checks the index again after the check itself failed', async () => {
    const indexes = vi
      .fn()
      .mockRejectedValueOnce(new Error('not primary'))
      .mockResolvedValue([{ key: { key: 1 }, unique: true }]);
    const collection = fakeCollection({ indexes });
    const adapter = new MongoAdapter({ client: clientFor(collection), createIndexes: false });
    await expect(adapter.isHeld({ key: 'k', token: 't' })).rejects.toThrow('not primary');
    await expect(adapter.isHeld({ key: 'k', token: 't' })).resolves.toBe(false);
  });

  it('reads from the primary and writes with a majority by default', () => {
    const collection = vi.fn(() => fakeCollection());
    const client: MongoLikeClient = { db: () => ({ collection }) };
    new MongoAdapter({ client });
    expect(collection).toHaveBeenCalledWith('locco-locks', {
      readPreference: 'primary',
      writeConcern: { w: 'majority' },
    });
    new MongoAdapter({ client, collectionName: 'x', writeConcern: { w: 1, journal: true } });
    expect(collection).toHaveBeenLastCalledWith('x', {
      readPreference: 'primary',
      writeConcern: { w: 1, journal: true },
    });
    expect(() => new MongoAdapter({ client, writeConcern: 'majority' as never })).toThrow(
      ValidationError,
    );
  });

  it('tries the index creation again after a failure', async () => {
    const createIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('not primary'))
      .mockResolvedValue('ok');
    const collection = fakeCollection({ createIndex });
    const adapter = new MongoAdapter({ client: clientFor(collection) });
    await expect(adapter.isHeld({ key: 'k', token: 't' })).rejects.toThrow('not primary');
    await expect(adapter.isHeld({ key: 'k', token: 't' })).resolves.toBe(false);
    expect(createIndex).toHaveBeenCalledTimes(4);
  });

  it('retries the upsert once after a duplicate-key race', async () => {
    const findOneAndUpdate = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))
      .mockResolvedValueOnce({ value: { uniqueValue: 't' } });
    const collection = fakeCollection({ findOneAndUpdate });
    const adapter = new MongoAdapter({ client: clientFor(collection) });
    await expect(adapter.acquire({ key: 'k', token: 't', ttl: 1000 })).resolves.toBe(true);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('lets other driver errors through', async () => {
    const findOneAndUpdate = vi.fn().mockRejectedValue(new Error('network'));
    const adapter = new MongoAdapter({ client: clientFor(fakeCollection({ findOneAndUpdate })) });
    await expect(adapter.acquire({ key: 'k', token: 't', ttl: 1000 })).rejects.toThrow('network');
  });

  it('writes the 1.x document shape and reads expiry on the server clock', async () => {
    const client = await mongoClient();
    try {
      const adapter = new MongoAdapter({ client, collectionName: 'locco-locks-shape' });
      const key = uniqueKey();
      await expect(adapter.acquire({ key, token: 't', ttl: 60_000 })).resolves.toBe(true);
      const document = await client.db().collection('locco-locks-shape').findOne({ key });
      expect(document).toMatchObject({ key, uniqueValue: 't' });
      expect(document?.expireAt).toBeInstanceOf(Date);
      expect(document?.expireAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
      await expect(adapter.release({ key, token: 't' })).resolves.toBe(true);
    } finally {
      await client
        .db()
        .collection('locco-locks-shape')
        .drop()
        .catch(() => undefined);
      await client.close();
    }
  });
});
