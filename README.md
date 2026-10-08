[![Build and Test](https://github.com/Kontsedal/locco/actions/workflows/status.yml/badge.svg?branch=main)](https://github.com/Kontsedal/locco/actions/workflows/status.yml?query=branch%3Amain)
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
- **`await using`.** A `Lock` is an `AsyncDisposable`, so it is released at block exit. Node.js
  runs `await using` natively from 24; on 22, compile it with TypeScript 5.2+ or Babel.
- **Retries with a budget.** A count, a delay or a delay function, and a timeout on the whole
  acquisition. The options merge per field with the locker default.
- **Auto-extension with a hard deadline.** A heartbeat extends the lease and retries a failed
  extension while the lease lasts. `maxHold` caps how long the lock can live, so a forgotten lock
  still expires.
- **A loss signal.** `lock.signal` is an `AbortSignal` that aborts when the lease is lost.
  `withLock` throws `LockLostError` when the work finished without a lock.
- **Fencing tokens.** With `fencing: true`, every grant carries a number that only grows, so the
  resource you write to can refuse a holder whose lease ended.
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

Run a callback under a lock that extends itself. `maxHold` caps the whole hold, so a callback that
never returns cannot keep the key forever:

```ts
const report = await locker.withLock(
  'nightly-report',
  { ttl: 60_000, autoExtend: { maxHold: 30 * 60_000 } },
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

**How the holder's clock is read.** The local lease starts when the acquire or extend request
leaves, never later than the backend's, and ends 1% of the TTL early, the margin Redlock uses for
a holder clock that runs slower than the backend's. The clock is `performance.now`, which cannot
step backwards, plus any pause that only the wall clock saw: a sleeping laptop or a paused VM
stops the monotonic clock while the backend's keeps running. Reading `state`, `signal`,
`lostReason` or `heldMs` checks the clock, so a lock whose expiry timer has not run yet, after a
pause or on a busy event loop, still reads `lost`.

**What no lease lock survives.** Read this before you protect a money-moving write with a lock.

- **A pause after the signal fires.** A process that stops for garbage collection or a page fault
  after it checked `signal.aborted` can still write after the lease ended. Where an overlapping
  write is unacceptable, the write itself needs a condition. [Fencing tokens](#fencing-tokens)
  give it one.
- **A signal that fires late after a sleep.** `lock.signal` aborts from a timer, and a timer does
  not run while the machine sleeps or the VM is paused. On macOS it also does not count the time
  asleep, so it can fire long after the lease ended. Reading `state`, `signal`, `lostReason` or
  `heldMs` checks the clock and finds the loss at once, but work that only listens for the abort
  event learns of it when the timer runs. Check `lock.state` before a write that matters, or fence
  the write.
- **A clock that is not the backend's.** Redis expires the key on its own clock. MongoDB and
  Postgres compare on the server clock, through `$$NOW` and `clock_timestamp()`. The local expiry
  estimate counts elapsed time on the holder's machine and needs no shared clock. A holder clock
  that runs more than 1% slower than the backend's breaks that estimate.
- **Redis eviction.** Under memory pressure Redis can evict a lock key. Run the lock Redis with
  `maxmemory-policy noeviction`.
- **Failover.** A backend that fails over can lose a write it had acknowledged, and another caller
  can then acquire the same key. A single Redis can forget a lock that only its old primary had;
  locco locks one Redis and is not a Redlock quorum. The Redis adapters'
  [`waitForReplicas`](#redis-with-ioredis) option makes a grant count only once replicas have it.
  MongoDB writes with `w: 'majority'` by
  default, which survives a replica set election. Postgres is safe across a failover only with
  synchronous replication to the standby that takes over.
- **A slow answer.** An acquire or extend answer that arrives after the lease has run out is
  treated as a failure, not as a lock.

### Fencing tokens

A lease cannot stop a holder that paused past its end from writing. A fencing token can, when the
resource you write to takes part. With `fencing: true`, every acquisition takes a token, a
positive integer in `lock.fence`, and a later grant of the same key always gets a larger one.
Send the token with every write, and let the resource refuse a token smaller than the largest it
has seen. Accept an equal one, because one holder can write more than once:

```ts
const locker = new Locker({ adapter, fencing: true });

await locker.withLock(`account:${id}`, { ttl: 10_000 }, async (lock) => {
  // Postgres, as the resource: `fence bigint` keeps the largest fence that wrote the row.
  const { rowCount } = await db.query(
    'UPDATE accounts SET balance = $1, fence = $2 WHERE id = $3 AND COALESCE(fence, 0) <= $2',
    [balance, lock.fence, id],
  );
  if (rowCount === 0) throw new Error('a later holder wrote first');
});
```

- **Ordered per key.** Compare tokens of one key only. Tokens of different keys come from
  counters that need not agree.
- **Store a token in a 64-bit column.** Redis tokens are about 2 × 10^15, see below. Every token
  stays below 2^53, so a JavaScript number holds it exactly.
- **Where the counter lives.**
  - Redis: one counter per lock key, `{<key>}:locco-fence`, or `<key>:locco-fence` when the key
    has a hash tag already. Either way it is in the hash slot of its lock key, so the script runs
    on a Cluster. The acquire and the counter write are one Lua script. The token is at least the
    Redis server time in microseconds, so tokens keep growing when the counter is lost to a
    restart without persistence, a flush or a failover. The counter only breaks ties and covers a
    server clock that steps back. It expires a day after the last grant of its key, or after the
    lease when that is longer.
  - Postgres: the sequence `<tableName>_fence`. Its `nextval` is in the same statement as the
    acquire.
  - MongoDB: one document in `<collectionName>-fences`. MongoDB cannot write two documents in one
    atomic step without a transaction, so the counter is a second write after the grant. Its order
    rests on the lease. A token counts only when its answer arrives before the lease could have
    ended, and the next holder is granted only after that end or after a release. The tokens of a
    key stay ordered under the same clock bound as the lock.
  - In memory: a counter in the adapter.
- **The stored lock is unchanged.** The counter lives next to the lock keys, not in them, so 1.x
  and 2.x processes still share one backend. A holder that takes no token, a 1.x process or a
  locker without `fencing`, writes without one. Turn fencing on for every holder of the keys you
  fence.
- **Gaps are normal.** A token taken by a grant that came back too late is not used.
- **A custom adapter** needs an `acquireFenced` method for `fencing: true`. See
  [Write your own adapter](#write-your-own-adapter).

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
| `now` | `() => number` | `performance.now` plus pauses | A monotonic clock in milliseconds. See [how the holder's clock is read](#guarantees-and-limits). Tests replace it. |
| `token` | `() => string` | 16 random bytes as hex | The value stored under the key. Tests replace it. |
| `fencing` | `boolean` | `false` | Take a [fencing token](#fencing-tokens) with every acquisition, as `lock.fence`. |

### `locker.acquire(key, options)`

Returns a held `Lock`. Retries while another holder has the key. Throws `LockHeldError` when the
retry budget or the timeout runs out.

| Option | Type | Meaning |
|---|---|---|
| `ttl` | `number` | Lease length in milliseconds. Required. |
| `retry` | `RetryOptions` | Overrides for this call. |
| `signal` | `AbortSignal` | Stops the retry loop. When it aborts while a winning attempt is in flight, the key is given back. `acquire` throws `signal.reason`. |
| `autoExtend` | `{ interval?, maxHold }` | Heartbeat. `maxHold` is always required. See below. |

### `locker.tryAcquire(key, { ttl, autoExtend? })`

One attempt. Returns the `Lock`, or `null` when another holder has the key. A driver error throws.

`null` always means another holder has the key, so `if (!lock) return;` is safe. When the backend
grants the key but answers so slowly that the lease could already have ended, the key is given
back and `LockHeldError` with `reason: 'late-acquire'` is thrown instead of `null`, because nobody
holds the key then and skipping the work would be wrong.

### `locker.withLock(key, options, fn)`

Acquires, runs `fn(lock)`, releases. Takes the same options as `acquire`, `autoExtend.maxHold`
included. The outcome follows one order:

1. `fn` threw. That error is thrown. A release error after it goes to a `releaseFailed` event.
2. `fn` returned and the lock is lost, or a release found the key not ours. `LockLostError` is
   thrown with `completed: true` and the return value in `result`.
3. The return value of `fn` is returned. A callback that released the lock itself counts here, as
   long as the key was still ours. So does a release that threw: the work finished under a held
   lock, so the error goes to a `releaseFailed` event instead of hiding the value, and the key
   stays until its lease runs out.

Whenever `withLock` cannot release the lock, the heartbeat stops, so the key is not renewed until
`maxHold` for a caller that has already moved on.

### `locker.acquireMany(keys, options)`

Deduplicates and sorts the keys, then acquires them one by one, so two callers with overlapping
sets cannot deadlock. `retry.timeout` is one budget for the whole set, while `retry.retries` is
spent on each key separately. Every lease is refreshed before the set is returned, so the leases
overlap. When one key fails, every acquired lock is released and the error is thrown. With
`autoExtend`, each lock counts `maxHold` from its own acquisition.

Returns a `LockSet` with `locks`, `signal`, `release()`, `extend(ttl)` and `Symbol.asyncDispose`.

### Retry options

| Field | Type | Meaning |
|---|---|---|
| `retries` | `number` | Attempts after the first one. `0` is one attempt. `Infinity` runs until `timeout` or the signal. |
| `delay` | `number` or `DelayFn` | Milliseconds between attempts. May be `0`. |
| `timeout` | `number` | Budget for the acquisition, waits included. No attempt or wait starts after it. An attempt that is already in flight may finish later. |

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

`autoExtend` runs `extend(ttl)` on a timer. The default interval is a third of the TTL, and an
explicit interval can be at most half of it. Each tick runs one interval after the request for
the current lease left, not after its answer came back, so a slow backend uses up the slack of one
lease instead of adding up across leases. Whatever the interval leaves of the TTL is the time an
extension has to come back. The timer does not keep the process alive.

`maxHold` is **required** wherever `autoExtend` is, on `acquire`, `tryAcquire` and `withLock`
alike. It is a deadline on ownership, counted from acquisition. Every extension, manual or from
the heartbeat, is clamped so the local lease ends no later than the deadline, and at the deadline
the lock is lost with `reason: 'max-hold'`. The backend counts its TTL from the moment it handles
the request, so the backend lease can outlive the deadline by the time the last extension spent in
flight, in queues and in the backend.

There is no way to ask for a heartbeat without a deadline. A caller that never returns, or a
`withLock` callback that never settles, would otherwise renew the lease until the process died,
which is the failure a lease exists to survive. Pick a `maxHold` above the longest run you expect.

An extension that throws does not end the lock. The lease confirmed before it still runs, so the
lock stays `held`, an `extendFailed` event reports the error, and the heartbeat tries again after
a third of its interval. The lock is lost only when the backend refuses the key, or when the lease
runs out first. The reasons tell these apart:

| `reason` | Meaning |
|---|---|
| `extend` | The backend answered that the key was not ours. |
| `extend-failed` | The lease ran out while extension requests kept throwing. The last driver error is the `cause`. |
| `late-extend` | The lease ran out while an extension was still waiting for its answer. The backend is too slow for the TTL. |
| `expired` | The lease ran out and nothing extended it. |
| `max-hold` | The hold deadline passed. |
| `release` | A release found the key gone or another holder's. |
| `observed` | `isHeld()` found the key gone or another holder's. |

When `await using` or `withLock` cannot release a lock, its heartbeat stops for good: nobody is
left to release it again, and renewing it until `maxHold` would only keep the key from everyone.

### `Lock`

| Member | Meaning |
|---|---|
| `key`, `token`, `ttl`, `retry` | Read-only. `key` includes the prefix. `ttl` is the latest lease length. |
| `fence` | The [fencing token](#fencing-tokens) of this grant, or `undefined` when the locker's `fencing` is off. |
| `state` | `'held'`, `'lost'` or `'released'`. Loss is sticky until `release()`. |
| `lostReason` | Why the lock was lost, or `undefined` when it was never lost. |
| `heldMs` | How long the lock was held. Stops counting once it is lost or released. |
| `signal` | Aborts on every known loss, with a `LockLostError` as its reason: a refused or late extension, a local lease expiry, the hold deadline, a release or a check that finds the key not ours. Pass it to the work. |
| `release()` | `true` when it deleted our key, `false` when the key was gone or not ours. Throws only when the driver throws; the lock then keeps its state and a later call tries again. After a successful call, a second call returns `false`. |
| `extend(ttl)` | New lease from now, clamped to the hold deadline. Throws `LockLostError` when the key was not ours or the deadline has passed. A driver error is thrown as it is and leaves the lock held until its current lease runs out. |
| `isHeld()` | One observation of the backend. A `false` while the lock is held marks it lost. |
| `[Symbol.asyncDispose]()` | Calls `release()`. |

### Errors

Every class extends `LoccoError`, which extends `Error` and carries a stable `code`. A driver
error is not wrapped. It reaches you as the driver threw it.

| Class | `code` | When |
|---|---|---|
| `LockHeldError` | `LOCK_HELD` | The key could not be taken and the budget is spent. Carries `key`, `attempts`, `elapsedMs`, `reason`. |
| `LockLostError` | `LOCK_LOST` | The lease was lost, the hold deadline included. Carries `key`, `reason`, `cause`, and from `withLock` also `completed` and `result`. |
| `LockStateError` | `LOCK_STATE` | `extend` on a lock that is released, or one whose release is in flight. |
| `ValidationError` | `LOCK_VALIDATION` | A wrong argument or a backend set up wrong, such as a MongoDB collection without its unique index or a missing Postgres table. |

`RedisReplicationError`, from `@kontsedal/locco/redis` and `@kontsedal/locco/node-redis`, is the
one adapter error that does not come from a driver. See
[`waitForReplicas`](#redis-with-ioredis).

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
| `contended` | `attempt`, `elapsedMs`, `reason` | An attempt yielded no lock. |
| `extended` | `heldMs` | A lease was extended. |
| `extendFailed` | `heldMs`, `error` | An extension threw. The lock is still held, and the heartbeat tries again. |
| `released` | `heldMs` | Our key was deleted. |
| `lost` | `heldMs`, `reason` | The lease was lost. |
| `releaseFailed` | `heldMs`, `error` | A release threw. |

A lock reports its ending once. A lease that runs out while a release is in flight fires `lost`
and no `released`, so counting the two never double-counts one lock.

`contended.reason` is `'held'` when another holder had the key, and `'late'` when the backend
granted it to us but answered too slowly to use the lease. A run of `'late'` points at the
backend, not at a busy key.

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

| Option | Default | Meaning |
|---|---|---|
| `waitForReplicas` | off | `{ replicas, timeout }`. After every acquire and extend, run `WAIT replicas timeout`. Needs a client with one connection. |

Acquire is `SET key token PX ttl NX`. Release and extend are Lua scripts sent with `EVALSHA`, with
a fallback to `EVAL` when the script cache is empty. The adapter registers nothing on the client,
so several adapters can share one client. Run the lock Redis with `maxmemory-policy noeviction`.

Redis replicates asynchronously, so a primary that fails over can take a granted lock with it.
With `waitForReplicas`, a grant or an extension counts only when `replicas` replicas acknowledged
it within `timeout` milliseconds. When fewer did, the adapter throws `RedisReplicationError` with
`replicas` and `acknowledged`. It throws instead of answering `false`, because `false` would say
another holder has the key. An acquire then gives the key back and throws. An extension leaves the
lock held, fires `extendFailed`, and the heartbeat tries again, as for any extension that throws.
`WAIT` makes failover loss less likely. It does not make Redis strongly consistent.

- **One connection.** `WAIT` counts the writes of its own connection only. A pool or a cluster
  client can send it on another connection than the write, and it then confirms nothing. The
  adapter refuses an ioredis `Cluster`, a node-redis `createCluster` client and a
  `createClientPool` pool with `waitForReplicas`.
- **Its own connection.** `WAIT` blocks the connection for up to `timeout`, and every command
  queued behind it waits, the heartbeats of other locks included. Give the adapter a client that
  nothing else uses.
- **A timeout well below the TTL.** The `WAIT` time counts against the lease like the rest of the
  request. A `timeout` near the TTL turns a slow replica into `late` acquires.

**Redis Cluster.** Each operation touches one key, or a key and its fence counter in the same
hash slot. A key that contains `}` but no hash tag, such as `a}b`, cannot share its slot with a
counter, so a fenced acquire of it fails on a Cluster with `CROSSSLOT`. Give such a key a hash
tag. The ioredis `keyPrefix` option moves a key without a hash tag to another slot than its
counter; on a Cluster, put the hash tag in the key or in the prefix.

```ts
const adapter = new IoRedisAdapter({ client, waitForReplicas: { replicas: 1, timeout: 100 } });
```

### Redis with node-redis

```ts
import { createClient } from 'redis';
import { NodeRedisAdapter } from '@kontsedal/locco/node-redis';

const client = createClient();
await client.connect();
const adapter = new NodeRedisAdapter({ client });
```

Same keys, same scripts and the same options as the ioredis adapter. The two adapters can share
one Redis and its fence counters.

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
| `writeConcern` | `{ w: 'majority' }` | The write concern of every lock write. |

One document per key: `key`, `uniqueValue`, `expireAt`. Expiry is compared on the server clock
through `$$NOW`. Acquire is a pipeline upsert on `key`, so it is atomic without a transaction. The
TTL index removes expired documents in the background. Needs MongoDB 4.2 or newer.

The unique index on `key` is what makes acquire exclusive: without it, two upserts of a missing
key can both insert a document, and both callers win. With `createIndexes: false`, create the
indexes in a migration from `mongoLocksIndexes()`, which returns them in the shape
`collection.createIndexes()` takes. The adapter checks once that the unique index exists and
refuses to work without it.

Every write uses `w: 'majority'` unless `writeConcern` says otherwise, so a replica set election
cannot roll back a lock that was granted. A write acknowledged by the primary alone can be lost in
a failover, and another caller can then acquire the same key. Every read goes to the primary,
whatever the client's read preference: a lagging secondary could answer that a lock we were just
granted is not ours.

### Postgres

```ts
import { Pool } from 'pg';
import { PostgresAdapter } from '@kontsedal/locco/postgres';

const adapter = new PostgresAdapter({ client: new Pool(), tableName: 'locco_locks' });
```

| Option | Default | Meaning |
|---|---|---|
| `tableName` | `'locco_locks'` | Plain or schema-qualified identifier. |
| `createTable` | `true` | Create the table and the fence sequence on first use. |

Pass a `Pool`, or a `Client` that is not inside a transaction. Inside a transaction the lock row is
invisible to others until commit, rolls back with it, and holds a row lock until commit. The
adapter cannot detect that.

Every statement uses `clock_timestamp()`, the server clock. Acquire is one `INSERT ... ON CONFLICT
DO UPDATE ... WHERE expires_at <= clock_timestamp()`. When another transaction holds the row, the
statement waits for it, and the retry timeout cannot cut that wait. Set `lock_timeout` on the
connection to bound it.

A standby that takes over after a failover has every lock row only with synchronous replication.
With asynchronous replication, a lock granted just before the failover can be missing on the new
primary.

Postgres has no TTL index. An expired row stays until the next acquire of the same key overwrites
it. Call `sweepExpired()` on a schedule to remove them:

```ts
setInterval(() => adapter.sweepExpired().catch(report), 60_000).unref();
```

Or with `pg_cron`: `SELECT cron.schedule('locco-sweep', '* * * * *', $$DELETE FROM locco_locks WHERE expires_at <= clock_timestamp()$$);`

For a role without DDL rights, set `createTable: false` and run the statements from
`postgresLocksDdl(tableName)` in your migration: the table, and the sequence `<tableName>_fence`
for [fencing tokens](#fencing-tokens). The adapter then checks once that the table exists with a
primary key or unique index on `key` alone, which `ON CONFLICT (key)` needs, and throws a
`ValidationError` naming the problem when it does not. The first fenced acquire checks the
sequence the same way. A failed check runs again on the next call.

The role that locks needs `SELECT, INSERT, UPDATE, DELETE` on the table and, for fencing,
`USAGE` on the sequence: `GRANT USAGE ON SEQUENCE locco_locks_fence TO app`. A grant on all tables
does not cover sequences. Fencing needs a table name of at most 57 characters, so that
`<tableName>_fence` fits in a Postgres identifier.

`postgresLocksDdl()` returns two statements. Run it through the simple query protocol, as
`pool.query(ddl)` with no parameters does, or split it on `;`. Needs Postgres 9.5 or newer.

### In-memory

```ts
import { InMemoryAdapter } from '@kontsedal/locco/memory';

const adapter = new InMemoryAdapter();
```

One process only. `clear()` forgets every lock, and keeps the fence counter. The clock is `performance.now`, so a wall-clock
step cannot end every lease at once. `now` in the options replaces it: pass `() => Date.now()` to
follow fake timers.

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
  // Optional, for `fencing: true`. Answers null when the key is held.
  async acquireFenced({ key, token, ttl }) { /* acquire, and take the next counter value */ }
}
```

`acquireFenced` must answer a positive integer that is larger than every token it answered
before for the key. Take it in the same atomic step as the grant when the backend allows that.

Run the same contract suite the built-in adapters pass, in a vitest file (vitest 1 or newer). It
tests `acquireFenced` when the adapter has it, and skips those tests when it does not:

```ts
import { runLockAdapterContract } from '@kontsedal/locco/testing';

runLockAdapterContract('MyAdapter', () => ({ adapter: new MyAdapter() }));
```

## Migrating from 1.x

See [docs/migrating-to-v2.md](docs/migrating-to-v2.md). The Redis keys and the MongoDB documents
are unchanged, so 1.x and 2.x processes can share one backend during a rolling deploy. A codemod
ships with the package. After you install 2.0, run it from your project. Quote the glob: the
codemod expands it itself, at every depth, on every shell.

```shell
npx locco-migrate-v2 --write "src/**/*.ts"
```

## Requirements

- Node.js 22 or newer. `await using` runs natively from Node.js 24; on 22 it needs a compiler that
  lowers it, such as TypeScript 5.2+ with a `target` below `ESNext`. CommonJS has no top-level
  `await`, so write it inside an async function.
- TypeScript 5.2 or newer, if you use TypeScript. The declarations are checked on 5.2 and on the
  latest release.
- One of: `ioredis` 5 or 6, `redis` 4 to 6, `mongodb` 5.7 to 7, `pg` 8.0.3 or newer 8.x. CI runs
  the suite on the oldest and the newest of each.

## License

MIT
