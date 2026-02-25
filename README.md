[![Build and Test](https://github.com/kontsedal/locco/workflows/Build%20and%20Test/badge.svg)](https://github.com/kontsedal/locco/actions/workflows/status.yml?query=branch%3Amain++)
![Coverage Badge](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Kontsedal/e0ad01840d30efd4c1766e5ba5845567/raw/bf778a4aa5262997514945e024aa6722d5f72016/locco__heads_main.json)

# locco

A small, zero-dependency library for distributed locking. Supports Redis ([ioredis](https://github.com/redis/ioredis)), MongoDB, and in-memory backends. You provide your own client instances — locco has no runtime dependencies.

## Features

- **Three backends** — Redis, MongoDB, and in-memory (for testing)
- **Zero runtime dependencies** — adapters use duck-typed interfaces, no client packages bundled
- **Atomic operations** — Redis uses Lua scripts; MongoDB uses upsert with unique indexes
- **Automatic release** — pass a callback to `acquire()` and the lock is released in a `finally` block
- **Configurable retry** — fixed delay, total time cap, or fully custom delay function
- **Fencing tokens** — every lock carries a unique value; release/extend only succeed if the value matches
- **Dual package** — ships both ESM and CommonJS builds with full TypeScript declarations

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [API](#api)
  - [Locker](#locker)
  - [Lock](#lock)
  - [Retry settings](#retry-settings)
- [Adapters](#adapters)
  - [Redis adapter](#redis-adapter)
  - [MongoDB adapter](#mongodb-adapter)
  - [In-memory adapter](#in-memory-adapter)
- [Error handling](#error-handling)
- [How it works](#how-it-works)
  - [Redis internals](#redis-internals)
  - [MongoDB internals](#mongodb-internals)
- [Requirements](#requirements)
- [License](#license)

## Installation

```shell
npm i @kontsedal/locco
```

## Quick start

### Manual acquire and release

Lock a resource, do work, then release manually. Always release in a `finally` block to avoid dangling locks.

```typescript
import { Locker, IoRedisAdapter } from "@kontsedal/locco";
import Redis from "ioredis";

const adapter = new IoRedisAdapter({ client: new Redis() });
const locker = new Locker({
  adapter,
  retrySettings: { retryDelay: 200, retryTimes: 10 },
});

const lock = await locker.lock("user:123", 3000).acquire();
try {
  // critical section
  await lock.extend(2000); // need more time? extend the TTL
  // continue working
} finally {
  await lock.release();
}
```

### Callback-based (auto-release)

Pass a callback to `acquire()` and the lock is released automatically when the callback finishes (or throws).

```typescript
import { Locker, MongoAdapter } from "@kontsedal/locco";
import { MongoClient } from "mongodb";

const adapter = new MongoAdapter({
  client: new MongoClient("mongodb://localhost:27017"),
});
const locker = new Locker({
  adapter,
  retrySettings: { retryDelay: 200, retryTimes: 10 },
});

const result = await locker.lock("user:123", 3000).acquire(async (lock) => {
  // critical section — lock is auto-released when this function returns
  await lock.extend(2000);
  return { success: true };
});

console.log(result); // { success: true }
```

### In-memory (for testing)

```typescript
import { Locker, InMemoryAdapter } from "@kontsedal/locco";

const locker = new Locker({
  adapter: new InMemoryAdapter(),
  retrySettings: { retryDelay: 50, retryTimes: 5 },
});

const lock = await locker.lock("resource:1", 1000).acquire();
// ...
await lock.release();
```

## API

### Locker

Factory that creates `Lock` instances bound to a backend adapter and default retry settings.

```typescript
const locker = new Locker({ adapter, retrySettings });
```

**Constructor parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `adapter` | `ILockAdapter` | Yes | Backend adapter (Redis, MongoDB, or in-memory) |
| `retrySettings` | `RetrySettings` | Yes | Default retry behavior for all locks created by this locker |

**Methods:**

#### `locker.lock(key, ttl)`

Creates a `Lock` instance. Does **not** acquire the lock — call `.acquire()` on the returned object.

- `key` — a non-empty string identifying the resource to lock
- `ttl` — time to live in milliseconds (positive integer)

```typescript
const lock = locker.lock("orders:456", 5000);
```

---

### Lock

Represents a single lock on a resource. Created via `locker.lock()`.

#### `lock.acquire()`

Acquires the lock. Retries according to the retry settings if the resource is already locked.

```typescript
// Without callback — returns the Lock; you must release manually
const lock = await locker.lock("key", 3000).acquire();

// With callback — auto-releases when the callback finishes
const result = await locker.lock("key", 3000).acquire(async (lock) => {
  return doWork();
});
```

#### `lock.release(options?)`

Releases the lock. By default, silently succeeds even if the lock has already expired or was taken by another process. Pass `{ throwOnFail: true }` to throw on failure.

```typescript
await lock.release();
await lock.release({ throwOnFail: true }); // throws LockReleaseError on failure
```

#### `lock.extend(ttl)`

Extends the lock's TTL by the given number of milliseconds **from now**. Throws `LockExtendError` if the lock is no longer valid.

```typescript
await lock.extend(5000); // lock is now valid for 5 more seconds
```

#### `lock.isLocked()`

Returns `true` if this specific lock is still valid in the backend.

```typescript
if (await lock.isLocked()) {
  // still holding the lock
}
```

#### `lock.setRetrySettings(settings)`

Returns a **new** `Lock` with overridden retry settings. Must be called **before** `acquire()`.

```typescript
const lock = await locker
  .lock("key", 3000)
  .setRetrySettings({ retryDelay: 100, retryTimes: 50 })
  .acquire();
```

#### Public properties

| Property | Type | Description |
| --- | --- | --- |
| `key` | `string` | The resource key |
| `ttl` | `number` | The lock TTL in milliseconds |
| `uniqueValue` | `string` | The fencing token (hex string) |
| `retrySettings` | `RetrySettings` | Current retry settings |

---

### Retry settings

Controls how `acquire()` retries when a resource is already locked.

| Parameter | Type | Description |
| --- | --- | --- |
| `retryDelay` | `number` | Milliseconds between retries (positive integer) |
| `retryTimes` | `number` | Maximum number of retry attempts (positive integer) |
| `totalTime` | `number` | Hard cap on total retry duration in milliseconds |
| `retryDelayFn` | `function` | Custom delay function (see below). Mutually exclusive with `retryDelay` |

When using a fixed delay, both `retryDelay` and `retryTimes` are required. You can optionally add `totalTime` as an additional safeguard.

**Custom delay function:**

```typescript
const locker = new Locker({
  adapter: new InMemoryAdapter(),
  retrySettings: {
    retryDelayFn: ({ attemptNumber, startedAt, previousDelay, settings, stop }) => {
      // Exponential backoff
      return Math.min(2 ** attemptNumber * 50, 5000);
    },
  },
});
```

The function receives:

| Parameter | Type | Description |
| --- | --- | --- |
| `attemptNumber` | `number` | Zero-based attempt index |
| `startedAt` | `number` | Timestamp (ms) when retrying began |
| `previousDelay` | `number` | The delay returned on the previous attempt |
| `settings` | `RetrySettings` | The full retry settings object |
| `stop` | `() => void` | Call to stop retrying immediately (throws `RetryError`) |

## Adapters

All adapters implement the `ILockAdapter` interface. You can write your own by implementing four methods: `createLock`, `releaseLock`, `extendLock`, and `isValidLock`.

### Redis adapter

```typescript
import { IoRedisAdapter } from "@kontsedal/locco";
import Redis from "ioredis";

const adapter = new IoRedisAdapter({ client: new Redis() });
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `client` | ioredis-compatible | Yes | Any object with `set`, `get`, and `defineCommand` methods |

The adapter registers two Lua commands (`releaseLock` and `extendLock`) on the client at construction time to ensure atomic compare-and-delete/extend operations.

### MongoDB adapter

```typescript
import { MongoAdapter } from "@kontsedal/locco";
import { MongoClient } from "mongodb";

const adapter = new MongoAdapter({
  client: new MongoClient("mongodb://localhost:27017"),
  dbName: "my-app",               // optional
  locksCollectionName: "my-locks", // optional, defaults to "locco-locks"
});
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `client` | mongodb-compatible | Yes | Any object matching the `MongoLikeClient` interface |
| `dbName` | `string` | No | Database name passed to `client.db()` |
| `locksCollectionName` | `string` | No | Collection name (default: `"locco-locks"`) |

Indexes are created lazily and idempotently on first use.

### In-memory adapter

```typescript
import { InMemoryAdapter } from "@kontsedal/locco";

const adapter = new InMemoryAdapter();
```

No configuration needed. Uses a `Map` internally with `setTimeout` for TTL expiration. Timers call `.unref()` so they don't prevent Node.js from exiting.

Useful for unit tests where you don't want external dependencies.

## Error handling

All errors extend `LoccoError`, which extends `Error`. You can catch specific error types using `instanceof`.

```typescript
import {
  LoccoError,
  LockCreateError,
  LockReleaseError,
  LockExtendError,
  RetryError,
  ValidationError,
} from "@kontsedal/locco";

try {
  const lock = await locker.lock("key", 3000).acquire();
} catch (error) {
  if (error instanceof RetryError) {
    // could not acquire the lock within the retry limits
  } else if (error instanceof ValidationError) {
    // invalid parameters (e.g., negative TTL, missing retryDelay)
  }
}
```

| Error class | When it's thrown |
| --- | --- |
| `LockCreateError` | Backend reports the resource is already locked (this is the error `retry` catches and retries on) |
| `LockReleaseError` | Lock is expired or owned by another process (`release({ throwOnFail: true })`) |
| `LockExtendError` | Lock is expired or owned by another process when extending |
| `RetryError` | Retry limit, total time, or manual `stop()` exceeded during `acquire()` |
| `ValidationError` | Invalid parameters passed to any public method |

## How it works

### Redis internals

Lock creation uses the Redis `SET` command with two options:

- **NX** — only set the key if it does **not** already exist
- **PX** — set an expiration in milliseconds

```
SET <key> <uniqueValue> PX <ttl> NX
```

If the key already exists (another lock is active), `SET` returns `null` and the acquire fails (triggering a retry). If the key doesn't exist, it's created atomically with the given TTL.

Release and extend use Lua scripts to atomically check the stored value and either delete the key or reset its TTL. This guarantees that a lock can only be released or extended by the process that created it.

### MongoDB internals

Locks are stored in a collection with three fields: `key`, `uniqueValue`, and `expireAt`. A unique index on `key` prevents duplicate locks.

To create a lock, the adapter uses `updateOne` with `upsert: true`:

```typescript
collection.updateOne(
  { key, expireAt: { $lt: new Date() } }, // only match expired locks
  { $set: { key, uniqueValue, expireAt } },
  { upsert: true }
);
```

If a valid (non-expired) lock exists, the filter doesn't match it, so MongoDB tries to insert a new document — which fails due to the unique index. This makes lock creation atomic without transactions.

A TTL index on `expireAt` with `expireAfterSeconds: 0` lets MongoDB automatically clean up expired lock documents.

Release and extend use the same pattern: they match on both `key` and `uniqueValue` to ensure only the lock owner can modify or delete the lock.

## Requirements

- Node.js >= 18
- **Redis adapter:** [ioredis](https://github.com/redis/ioredis) (or any compatible client)
- **MongoDB adapter:** [mongodb](https://github.com/mongodb/node-mongodb-native) driver (or any compatible client)

## License

MIT
