# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-10-08

### Added

- Fencing tokens. `new Locker({ adapter, fencing: true })` takes a token with every acquisition,
  as `lock.fence`: a positive integer that is larger for every later grant of the key. The stored
  lock keys and documents are unchanged, so 1.x processes can still share the backend.
  - Redis keeps one counter per lock key, in the hash slot of the key, written in the acquire
    script. The token is at least the server time in microseconds, so it keeps growing after the
    counter is lost. The counter expires a day after the last grant.
  - Postgres draws from the sequence `<tableName>_fence` in the acquire statement.
  - MongoDB increments one document in `<collectionName>-fences` right after the grant. The order
    rests on the late-answer rule, as the lock does.
- `LockAdapter.acquireFenced`, an optional method. An adapter without it works as before; only
  `fencing: true` needs it. The contract suite tests it when an adapter has it.
- `waitForReplicas: { replicas, timeout }` on both Redis adapters. After every acquire and
  extend, the adapter runs `WAIT` and throws `RedisReplicationError` when too few replicas
  acknowledged the write. It refuses a pool or a cluster client, where `WAIT` can run on another
  connection than the write.

### Changed

- `PostgresAdapter` with `createTable: false` checks once that the table exists with a valid
  primary key or unique index on `key`, and throws a `ValidationError` when it does not. A missing
  table used to surface as the driver's `42P01` on the first acquire. The first fenced acquire
  checks the fence sequence the same way.
- `postgresLocksDdl()` also returns the `CREATE SEQUENCE` statement for fencing tokens, so it is
  now two statements. Run it through the simple query protocol, or split it. With `createTable`
  on, the adapter creates the sequence on first use.

### Documentation

- The README says that `lock.signal` can abort late after the machine sleeps, because timers do not
  run during a sleep, and that reading `lock.state` finds the loss at once.
- The README covers Redis Cluster: which keys can be fenced there, and `keyPrefix`.

## [2.0.0] - 2026-10-01

Neither 2.0 beta was published, so this entry lists everything that changed since 1.1.0.
[The migration guide](docs/migrating-to-v2.md) has the full table and the codemod.

### Changed

- `acquire`, `tryAcquire`, `withLock` and `acquireMany` live on `Locker` and return a held lock.
  There is no lock object before acquisition, and `Locker.lock()` is gone.
- Every acquire method takes one options object with a required `ttl`.
- `retrySettings` is `retry`, `retryTimes` is `retries`, `retryDelay` and `retryDelayFn` are one
  `delay` field, `totalTime` is `timeout`. `retries` counts the attempts after the first one.
  Retry fields merge per field with the locker default, and `{ retries: 0 }` is valid.
- Contention is one error, `LockHeldError`, with `code: 'LOCK_HELD'`. `LockCreateError`,
  `LockReleaseError`, `LockExtendError` and `RetryError` are gone. Every error carries a `code`,
  and every loss, the hold deadline included, is a `LockLostError` with a `reason`.
- `release()` returns `true` or `false` and throws only when the driver throws. It no longer
  swallows driver errors, and it has no `throwOnFail` option.
- `extend()` throws `LockLostError` when the key was not ours. A driver error is thrown as it is
  and leaves the lock held until its current lease runs out.
- `uniqueValue` is `token`. `isLocked()` is `isHeld()`, and a `false` answer while the lock is
  held marks it lost.
- `ILockAdapter` is `LockAdapter`, and its methods return booleans instead of throwing.
- Each adapter has its own entry point: `@kontsedal/locco/redis`, `/node-redis`, `/mongo`,
  `/postgres`, `/memory`. The testing suite is `@kontsedal/locco/testing`.
- `MongoAdapter`'s `locksCollectionName` option is `collectionName`. The old name throws a
  `ValidationError`, so a spread config cannot send the locks to the default collection by
  mistake.
- The MongoDB adapter compares expiry on the server clock through `$$NOW`, acquires with a
  pipeline upsert, retries once after a duplicate-key race, and creates two indexes instead of
  three. The document shape is unchanged.
- The MongoDB adapter writes with `w: 'majority'` and reads from the primary, whatever the
  client's settings, so a failover cannot roll back a granted lock and a lagging secondary cannot
  mark a held one lost. `writeConcern` chooses another write concern.
- The Redis adapter sends its Lua scripts with `EVALSHA` and falls back to `EVAL`. It no longer
  registers commands on the client.
- The local clock is `performance.now`, which cannot step backwards, plus any pause that only the
  wall clock saw, such as a sleeping machine or a paused VM. Reading a lock's `state`, `signal`,
  `lostReason` or `heldMs` checks it, so a late expiry timer cannot leave a lock reading `held`.
- The local lease ends 1% of the TTL early, for a holder clock that runs slower than the
  backend's. An acquire or extend answered after the local lease ended counts as a failure.
- The in-memory adapter's clock is `performance.now` instead of `Date.now`.
- Validation errors reject the returned promise instead of throwing before it exists.
- Node.js 22 or newer is required.
- The peer ranges are bounded and tested at both ends: `ioredis` 5 and 6, `redis` 4 to 6,
  `mongodb` 5.7 to 7, `pg` 8.0.3 and newer 8.x, `vitest` 1 to 5.
- The build is tsdown. Output files are `.mjs` and `.cjs` with `.d.mts` and `.d.cts` beside them.

### Added

- `Lock` implements `Symbol.asyncDispose`, so `await using` releases it at block exit. When that
  release throws, the lock's heartbeat stops and its lease runs out on its own.
- `lock.signal`, an `AbortSignal` that aborts on every known loss, `lock.state` with a sticky
  `lost` state, `lock.lostReason` and `lock.heldMs`.
- `autoExtend` on `acquire`, `tryAcquire` and `withLock`: a heartbeat with a required `maxHold`
  deadline. Each tick counts from the start of the lease it renews, an extension that throws is
  tried again while the lease lasts, and an explicit `interval` can be at most half the TTL.
- `withLock`. It throws `LockLostError` with `completed` and `result` when the callback finished
  without a lock, and returns the value when only the release failed.
- `acquireMany` and `LockSet`: sorted, sequential, one timeout, refreshed leases, rollback.
- `tryAcquire`. `null` means another holder has the key; a free key answered too late throws
  `LockHeldError` with `reason: 'late-acquire'`.
- `signal` in the acquire options.
- `keyPrefix`, `onEvent`, `now` and `token` on `Locker`.
- Events: `acquired`, `contended` with `reason: 'held' | 'late'`, `extended`, `extendFailed`,
  `released`, `lost` with its reason, and `releaseFailed`.
- `exponentialBackoff()`, and a frozen `DEFAULT_RETRY`.
- `NodeRedisAdapter` for the `redis` package.
- `PostgresAdapter` with `clock_timestamp()`, lazy table creation, `postgresLocksDdl()` and
  `sweepExpired()`.
- `mongoLocksIndexes()`. With `createIndexes: false`, the MongoDB adapter checks that the unique
  index on `key` exists and refuses to work without it.
- `InMemoryAdapter.clear()`, `Symbol.dispose`, and an injectable clock.
- `runLockAdapterContract()` for custom adapters.
- A compatibility suite that runs 1.0.0 and 1.1.0 against 2.0 on one Redis and one MongoDB.
- `locco-migrate-v2`, the codemod for the 1.x call shape, ships in the package as a command. It
  expands globs and directories itself, takes `--typescript <path>`, and finds a TypeScript 5 that
  `npx --package` installed when the project is on TypeScript 7.

### Fixed

- An acquire that throws after the backend may have applied it gives the key back, instead of
  leaving it held until its TTL.
- The MongoDB adapter tries its index creation again after a failure, instead of failing every
  later call with the first error.
- The retry timeout no longer overshoots by one delay.

## [1.1.0] - 2026-02-25

### Changed

- `retryTimes` and `retryDelay` of `0` are rejected with a `ValidationError`. 1.0.0 accepted them.

### Fixed

- `totalTime` is checked with an explicit `undefined` test.
- `validateAdapter` checks `isValidLock`.
- The `validateKey` message names the key.

## [1.0.0] - 2025-12-29

First stable release with the Redis, MongoDB and in-memory adapters.

[Unreleased]: https://github.com/Kontsedal/locco/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/Kontsedal/locco/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Kontsedal/locco/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/Kontsedal/locco/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Kontsedal/locco/releases/tag/v1.0.0
