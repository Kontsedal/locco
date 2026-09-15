[![Build and Test](https://github.com/kontsedal/locco/workflows/Build%20and%20Test/badge.svg)](https://github.com/kontsedal/locco/actions/workflows/status.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/@kontsedal/locco)](https://www.npmjs.com/package/@kontsedal/locco)

# locco

Distributed locks for Node.js. One `Locker`, five backends: Redis through `ioredis` or `redis`,
MongoDB, Postgres, and memory for tests. You bring the client. The package has no runtime
dependencies.

A lock is a lease: a key in the backend that carries a random token and expires after `ttl`
milliseconds. Only the holder of the token can release or extend it. locco tells you when a lease
is lost, instead of letting the work run on unprotected.

## What you get

- **Three ways to hold a lock.** `acquire` for manual control, `withLock` for a scoped callback,
  `acquireMany` for a set of keys.
- **`await using`.** A `Lock` is an `AsyncDisposable`, so the runtime releases it at block exit.
- **Retries with a budget.** A count, a delay or a delay function, and a timeout on the whole
  acquisition. The options merge per field with the locker default.
- **Auto-extension with a hard deadline.** A heartbeat extends the lease, and `maxHold` caps how
  long the lock can live, so a forgotten lock still expires.
- **A loss signal.** `lock.signal` is an `AbortSignal` that aborts when the lease is lost.
  `withLock` throws `LockLostError` when the work finished without a lock.
- **Errors with codes.** Contention is one error, `LockHeldError`. A driver error passes through
  untouched.
- **Events.** One hook receives every acquire, contention, extension, release and loss, with the
  hold time and the wait time.
- **A contract test suite** for your own adapter.

## Install

```shell
npm i @kontsedal/locco
```

Add the driver for your backend: `ioredis`, `redis`, `mongodb` or `pg`.

## Quick start

```ts
import Redis from 'ioredis';
import { Locker } from '@kontsedal/locco';
import { IoRedisAdapter } from '@kontsedal/locco/redis';

const locker = new Locker({
  adapter: new IoRedisAdapter({ client: new Redis() }),
  retry: { retries: 10, delay: 200 },
});

async function settleOrder(orderId: string) {
  await using lock = await locker.acquire(`order:${orderId}`, { ttl: 30_000 });
  // The runtime releases the lock when this function returns or throws.
  await settle(orderId, { signal: lock.signal });
}
```

Without `await using`:

```ts
const lock = await locker.acquire('order:1', { ttl: 30_000 });
try {
  await settle('1');
} finally {
  await lock.release();
}
```

Fail fast when another holder has the key:

```ts
const lock = await locker.tryAcquire('nightly-report', { ttl: 60_000 });
if (!lock) {
  return; // another instance runs the report
}
```

Run a callback under a lock that extends itself:

```ts
const report = await locker.withLock(
  'nightly-report',
  { ttl: 60_000, autoExtend: true },
  async (lock) => buildReport({ signal: lock.signal }),
);
```

Lock several keys at once:

```ts
await using locks = await locker.acquireMany(['account:1', 'account:2'], { ttl: 10_000 });
await transfer('1', '2');
```

## Guarantees and limits

**What the lock guarantees.** While the lease is live, no other caller can acquire the key. The
backend deletes or extends the key only when the token matches, so a holder cannot release or
extend another holder's lock. Every backend operation is one atomic statement: `SET NX PX` and Lua
on Redis, a pipeline upsert on MongoDB, `INSERT ... ON CONFLICT` on Postgres.

**What locco detects.** A release that finds the key not ours returns `false` and fires a `lost`
event. An extension that finds the key not ours marks the lock `lost` and aborts `lock.signal`. A
lease that runs out with no extension does the same, on the holder's own clock. `withLock` throws
`LockLostError` when the callback finished but the lock was lost.

**What no lease lock survives.** Read this before you protect a money-moving write with a lock.

- **A pause after the signal fires.** A process that stops for garbage collection or a page fault
  after it checked `signal.aborted` can still write after the lease ended. Where an overlapping
  write is unacceptable, the write itself needs a condition, such as a version check.
- **A clock that is not the backend's.** Redis expires the key on its own clock. MongoDB and
  Postgres compare on the server clock, through `$$NOW` and `clock_timestamp()`. The local expiry
  estimate counts elapsed time on the holder's machine and needs no shared clock.
- **Redis eviction.** Under memory pressure Redis can evict a lock key. Run the lock Redis with
  `maxmemory-policy noeviction`.
- **Redis failover.** A single Redis that fails over to a replica can forget an acknowledged
  lock. locco locks one Redis and is not a Redlock quorum.
- **A slow answer.** An acquire or extend answer that arrives after the lease has run out is
  treated as a failure, not as a lock.

**Not reentrant.** A second `acquire` of the same key from the same process waits like any other
caller. Pass the held `Lock` to the code that needs it.

## API

### `new Locker(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `adapter` | `LockAdapter` | required | The backend. |
| `retry` | `RetryOptions` | `{ retries: 10, delay: 200 }` | Default retry policy. Each call can override a field. |
| `keyPrefix` | `string` | `''` | Prepended to every key. Use it to keep test workers apart. |
| `onEvent` | `(event: LockEvent) => void` | none | Receives every event. What it throws is dropped. |
| `now` | `() => number` | `performance.now` | A monotonic clock in milliseconds. A wall clock can step backwards and delay the local expiry. Tests replace it. |
| `token` | `() => string` | 16 random bytes as hex | The value stored under the key. Tests replace it. |

### `locker.acquire(key, options)`

Returns a held `Lock`. Retries while another holder has the key. Throws `LockHeldError` when the
retry budget or the timeout runs out.

| Option | Type | Meaning |
|---|---|---|
| `ttl` | `number` | Lease length in milliseconds. Required. |
| `retry` | `RetryOptions` | Overrides for this call. |
| `signal` | `AbortSignal` | Stops the retry loop. When it aborts while a winning attempt is in flight, the key is given back. `acquire` throws `signal.reason`. |
| `autoExtend` | `{ interval?, maxHold }` | Heartbeat. `maxHold` is required here. See below. |

### `locker.tryAcquire(key, { ttl, autoExtend? })`

One attempt. Returns the `Lock`, or `null` when another holder has the key. A driver error throws.

### `locker.withLock(key, options, fn)`

Acquires, runs `fn(lock)`, releases. `autoExtend` may be `true`, or `{ interval?, maxHold? }`. The
outcome follows one order:

1. `fn` threw. That error is thrown. A release error after it goes to a `releaseFailed` event.
2. `fn` returned and the lock is lost, or the release found the key not ours. `LockLostError` is
   thrown with `completed: true` and the return value in `result`.
3. `fn` returned and the release threw. The driver error is thrown.
4. The return value of `fn` is returned.

### `locker.acquireMany(keys, options)`

Deduplicates and sorts the keys, then acquires them one by one, so two callers with overlapping
sets cannot deadlock. `retry.timeout` is one budget for the whole set. Every lease is refreshed
before the set is returned, so the leases overlap. When one key fails, every acquired lock is
released and the error is thrown.

Returns a `LockSet` with `locks`, `signal`, `release()`, `extend(ttl)` and `Symbol.asyncDispose`.

### Retry options

| Field | Type | Meaning |
|---|---|---|
| `retries` | `number` | Attempts after the first one. `0` is one attempt. `Infinity` runs until `timeout` or the signal. |
| `delay` | `number` or `DelayFn` | Milliseconds between attempts. May be `0`. |
| `timeout` | `number` | Cap on the whole acquisition, waits included. No attempt starts after it. |

The fields merge in three layers: the built-in default, the `Locker` option, the call option.
`lock.retry` shows the merged result.

```ts
import { exponentialBackoff } from '@kontsedal/locco';

const locker = new Locker({
  adapter,
  retry: { retries: 8, delay: exponentialBackoff({ base: 100, max: 5000 }) },
});
```

A `DelayFn` receives `{ attempt, elapsedMs, previousDelay }` and returns milliseconds, or a promise
of them.

### Auto-extension

`autoExtend` runs `extend(ttl)` on a timer. The default interval is a third of the TTL, and the
interval must be smaller than the TTL. The timer does not keep the process alive.

`maxHold` is a hard deadline on ownership, counted from acquisition. Every extension, manual or
from the heartbeat, is clamped so the lease ends at the deadline, and at the deadline
`lock.signal` aborts with a `LOCK_MAX_HOLD` reason. The lease can outlive the deadline by at most
the network latency of the last extension, because the backend counts the TTL from the moment it
handles the request. On `acquire`, `maxHold` is required. On `withLock` it is optional, because
the callback scope ends the hold.

When an extension fails, throws, or answers after the new lease has run out, the heartbeat stops,
the lock becomes `lost`, and `lock.signal` aborts with a `LockLostError`.

### `Lock`

| Member | Meaning |
|---|---|
| `key`, `token`, `ttl`, `retry` | Read-only. `key` includes the prefix. `ttl` is the latest lease length. |
| `state` | `'held'`, `'lost'` or `'released'`. Loss is sticky until `release()`. |
| `lostReason` | Why the lock was lost, or `undefined` when it was never lost. |
| `signal` | Aborts on every known loss: a failed or late extension, a local lease expiry, the hold deadline, a release or a check that finds the key not ours. Pass it to the work. |
| `release()` | `true` when it deleted our key, `false` when the key was gone or not ours. Throws only when the driver throws; the lock then keeps its state and a later call tries again. After a successful call, a second call returns `false`. |
| `extend(ttl)` | New lease from now, clamped to the hold deadline. Throws `LockLostError` when the key was not ours, and the `LOCK_MAX_HOLD` error when the deadline has passed. |
| `isHeld()` | One observation of the backend. A `false` while the lock is held marks it lost. |
| `[Symbol.asyncDispose]()` | Calls `release()`. |

### Errors

Every class extends `LoccoError`, which extends `Error` and carries a stable `code`. A driver
error is not wrapped. It reaches you as the driver threw it.

| Class | `code` | When |
|---|---|---|
| `LockHeldError` | `LOCK_HELD` | Another holder has the key and the budget is spent. Carries `key`, `attempts`, `elapsedMs`, `reason`. |
| `LockLostError` | `LOCK_LOST` | The lease was lost. Carries `key`, `reason`, and from `withLock` also `completed` and `result`. |
| `LockStateError` | `LOCK_STATE` | `extend` on a released lock. |
| `LoccoError` | `LOCK_MAX_HOLD` | The abort reason on `lock.signal` at the hold deadline. |
| `ValidationError` | `LOCK_VALIDATION` | A wrong argument. |

A project that loads the package as CommonJS in one place and as ESM in another gets two copies of
these classes, and `instanceof` fails across them. Check `error.code` there.

```ts
try {
  await using lock = await locker.acquire('k', { ttl: 5000 });
} catch (error) {
  if (error instanceof LockHeldError) {
    // busy, come back later
  } else {
    throw error; // the driver failed
  }
}
```

### Events

`onEvent` receives one object per event. Every event carries `key` and `ttl`.

| `type` | Extra fields | When |
|---|---|---|
| `acquired` | `waitedMs`, `attempts` | A lock was taken. |
| `contended` | `attempt`, `elapsedMs` | An attempt found another holder. |
| `extended` | `heldMs` | A lease was extended. |
| `released` | `heldMs` | Our key was deleted. |
| `lost` | `heldMs`, `reason` | The lease was lost. |
| `releaseFailed` | `heldMs`, `error` | A cleanup release threw while another error was in flight. |

`heldMs` against `ttl` tells you when a TTL is too short. `waitedMs` tells you how contended a key
is.

## Adapters

Each adapter is its own entry point, so your bundle carries one driver's types only.

### Redis with ioredis

```ts
import Redis from 'ioredis';
import { IoRedisAdapter } from '@kontsedal/locco/redis';

const adapter = new IoRedisAdapter({ client: new Redis() });
```

Acquire is `SET key token PX ttl NX`. Release and extend are Lua scripts sent with `EVALSHA`, with
a fallback to `EVAL` when the script cache is empty. The adapter registers nothing on the client,
so several adapters can share one client. Run the lock Redis with `maxmemory-policy noeviction`.

### Redis with node-redis

```ts
import { createClient } from 'redis';
import { NodeRedisAdapter } from '@kontsedal/locco/node-redis';

const client = createClient();
await client.connect();
const adapter = new NodeRedisAdapter({ client });
```

Same keys and same scripts as the ioredis adapter. The two adapters can share one Redis.

### MongoDB

```ts
import { MongoClient } from 'mongodb';
import { MongoAdapter } from '@kontsedal/locco/mongo';

const client = new MongoClient('mongodb://localhost:27017');
const adapter = new MongoAdapter({ client, dbName: 'app', collectionName: 'locco-locks' });
```

| Option | Default | Meaning |
|---|---|---|
| `dbName` | the client's default | Passed to `client.db()`. |
| `collectionName` | `'locco-locks'` | Where the documents live. |
| `createIndexes` | `true` | Create the unique index on `key` and the TTL index on `expireAt` on first use. |

One document per key: `key`, `uniqueValue`, `expireAt`. Expiry is compared on the server clock
through `$$NOW`. Acquire is a pipeline upsert on `key`, so it is atomic without a transaction. The
TTL index removes expired documents in the background. Needs MongoDB 4.2 or newer.

### Postgres

```ts
import { Pool } from 'pg';
import { PostgresAdapter } from '@kontsedal/locco/postgres';

const adapter = new PostgresAdapter({ client: new Pool(), tableName: 'locco_locks' });
```

| Option | Default | Meaning |
|---|---|---|
| `tableName` | `'locco_locks'` | Plain or schema-qualified identifier. |
| `createTable` | `true` | Run `CREATE TABLE IF NOT EXISTS` on first use. |

Pass a `Pool`, or a `Client` that is not inside a transaction. Inside a transaction the lock row is
invisible to others until commit, rolls back with it, and holds a row lock until commit. The
adapter cannot detect that.

Every statement uses `clock_timestamp()`, the server clock. Acquire is one `INSERT ... ON CONFLICT
DO UPDATE ... WHERE expires_at <= clock_timestamp()`. When another transaction holds the row, the
statement waits for it, and the retry timeout cannot cut that wait. Set `lock_timeout` on the
connection to bound it.

Postgres has no TTL index. An expired row stays until the next acquire of the same key overwrites
it. Call `sweepExpired()` on a schedule to remove them:

```ts
setInterval(() => adapter.sweepExpired().catch(report), 60_000).unref();
```

Or with `pg_cron`: `SELECT cron.schedule('locco-sweep', '* * * * *', $$DELETE FROM locco_locks WHERE expires_at <= clock_timestamp()$$);`

For a role without DDL rights, set `createTable: false` and run the statement from
`postgresLocksDdl(tableName)` in your migration. Needs Postgres 9.5 or newer.

### In-memory

```ts
import { InMemoryAdapter } from '@kontsedal/locco/memory';

const adapter = new InMemoryAdapter();
```

One process only. `clear()` forgets every lock. `now` in the options replaces the clock, so tests
can use fake timers.

## Write your own adapter

An adapter answers `true` when the operation applied to our key and `false` when another holder,
or no holder, had it. It throws only what its driver throws.

```ts
import type { LockAdapter } from '@kontsedal/locco';

export class MyAdapter implements LockAdapter {
  async acquire({ key, token, ttl }) { /* set key=token with expiry ttl if absent or expired */ }
  async release({ key, token }) { /* delete key if it carries token */ }
  async extend({ key, token, ttl }) { /* set a new expiry if key carries token */ }
  async isHeld({ key, token }) { /* does key carry token and a live expiry */ }
}
```

Run the same contract suite the built-in adapters pass, in a vitest file:

```ts
import { runLockAdapterContract } from '@kontsedal/locco/testing';

runLockAdapterContract('MyAdapter', () => ({ adapter: new MyAdapter() }));
```

## Migrating from 1.x

See [docs/migrating-to-v2.md](docs/migrating-to-v2.md). The Redis keys and the MongoDB documents
are unchanged, so 1.x and 2.x processes can share one backend during a rolling deploy. A codemod
ships with the package:

```shell
npx -p @kontsedal/locco locco-migrate-v2 --write src/**/*.ts
```

## Requirements

- Node.js 22 or newer.
- TypeScript 5.2 or newer for `await using`. CommonJS has no top-level `await`, so write it inside
  an async function.
- One of: `ioredis` 5+, `redis` 4+, `mongodb` 5+, `pg` 8+.

## License

MIT
