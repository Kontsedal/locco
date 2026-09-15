# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## [2.0.0-beta.1] - 2026-09-15

See [docs/migrating-to-v2.md](docs/migrating-to-v2.md) for the full table and the codemod.

### Changed

- `acquire`, `tryAcquire`, `withLock` and `acquireMany` live on `Locker` and return a held lock.
  There is no lock object before acquisition, and `Locker.lock()` is gone.
- Every acquire method takes one options object with a required `ttl`.
- `retrySettings` is `retry`, `retryTimes` is `retries`, `retryDelay` and `retryDelayFn` are one
  `delay` field, `totalTime` is `timeout`. `retries` counts the attempts after the first one.
  Retry fields merge per field with the locker default, and `{ retries: 0 }` is valid.
- Contention is one error, `LockHeldError`, with `code: 'LOCK_HELD'`. `LockCreateError`,
  `LockReleaseError`, `LockExtendError` and `RetryError` are gone. Every error carries a `code`.
- `release()` returns `true` or `false` and throws only when the driver throws. It no longer
  swallows driver errors, and it has no `throwOnFail` option.
- `extend()` throws `LockLostError` when the key was not ours.
- `uniqueValue` is `token`. `isLocked()` is `isHeld()`, and a `false` answer while the lock is
  held marks it lost.
- `MongoAdapter`'s `locksCollectionName` option is `collectionName`. The old name throws a
  `TypeError`, so a spread config cannot send the locks to the default collection by mistake.
- The local clock is monotonic (`performance.now`), so a wall-clock step cannot delay the local
  expiry estimate.
- `ILockAdapter` is `LockAdapter`, and its methods return booleans instead of throwing.
- Each adapter has its own entry point: `@kontsedal/locco/redis`, `/node-redis`, `/mongo`,
  `/postgres`, `/memory`. The testing suite is `@kontsedal/locco/testing`.
- The Redis adapter sends its Lua scripts with `EVALSHA` and falls back to `EVAL`. It no longer
  registers commands on the client.
- The MongoDB adapter compares expiry on the server clock through `$$NOW`, acquires with a
  pipeline upsert, retries once after a duplicate-key race, and creates two indexes instead of
  three. The document shape is unchanged.
- An acquire or extend answer that arrives after the lease has run out counts as a failure.
- Validation errors reject the returned promise instead of throwing before it exists.
- Node.js 22 or newer is required.

### Added

- `Lock` implements `Symbol.asyncDispose`, so `await using` releases it at block exit.
- `lock.signal`, an `AbortSignal` that aborts on every known loss, and `lock.state` with a sticky
  `lost` state.
- `autoExtend` on `acquire` and `withLock`: a heartbeat with a hard `maxHold` deadline.
- `withLock` throws `LockLostError` with `completed` and `result` when the callback finished
  without a lock.
- `acquireMany` and `LockSet`: sorted, sequential, one timeout, refreshed leases, rollback.
- `tryAcquire`.
- `signal` in the acquire options.
- `keyPrefix`, `onEvent` and `now` on `Locker`.
- Events with `waitedMs`, `heldMs` and a `releaseFailed` type.
- `exponentialBackoff()`.
- `NodeRedisAdapter` for the `redis` package.
- `PostgresAdapter` with `clock_timestamp()`, lazy table creation, `postgresLocksDdl()` and
  `sweepExpired()`.
- `InMemoryAdapter.clear()`, `Symbol.dispose`, and an injectable clock.
- `runLockAdapterContract()` for custom adapters.
- A compatibility suite that runs 1.0.0 and 2.0 against one Redis and one MongoDB.
- `locco-migrate-v2`, the codemod for the 1.x call shape, ships in the package as a command.

### Fixed

- The MongoDB and Postgres adapters try their index or table creation again after a failure,
  instead of failing every later call with the first error.
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

[2.0.0-beta.1]: https://github.com/Kontsedal/locco/compare/v1.1.0...v2.0.0-beta.1
[1.1.0]: https://github.com/Kontsedal/locco/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Kontsedal/locco/releases/tag/v1.0.0
