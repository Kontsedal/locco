# Migrating from 1.x to 2.0

2.0 changes the call shape and the error classes. It does not change what is stored: the Redis key
and value and the MongoDB document are the same, so 1.x and 2.0 processes can share one backend
during a rolling deploy.

## The call shape

| 1.x | 2.0 |
|---|---|
| `new Locker({ adapter, retrySettings })` | `new Locker({ adapter, retry })` |
| `locker.lock(key, ttl).acquire()` | `locker.acquire(key, { ttl })` |
| `.lock(key, ttl).setRetrySettings({ retryTimes: N, retryDelay: D }).acquire()` | `.acquire(key, { ttl, retry: { retries: N - 1, delay: D } })` |
| `.setRetrySettings({ retryTimes: 0, retryDelay: 0 })` | `retry: { retries: 0 }` |
| `.setRetrySettings({ retryDelayFn })` with no `retryTimes` | `retry: { retries: Infinity, delay: fn }` |
| `totalTime` | `retry.timeout` |
| `stop()` inside `retryDelayFn` | `signal` in the options |
| `acquire(callback)` | `locker.withLock(key, { ttl }, callback)` |
| `catch` on `LockCreateError` or `RetryError` | `catch` on `LockHeldError`, or `tryAcquire()` and test for `null` |
| `release({ throwOnFail: true })` | `if (!(await lock.release())) { ... }` |
| `lock.uniqueValue` | `lock.token` |
| `lock.isLocked()` | `lock.isHeld()` |
| `ILockAdapter` with methods that throw | `LockAdapter` with methods that return booleans |
| `new MongoAdapter({ locksCollectionName })` | `new MongoAdapter({ collectionName })`. The old name throws a `TypeError`, so a spread config cannot send the locks to the default collection by mistake. |
| `import { IoRedisAdapter } from '@kontsedal/locco'` | `import { IoRedisAdapter } from '@kontsedal/locco/redis'` |

### Why `retries` is one less than `retryTimes`

In 1.x, `retryTimes: N` with N of 1 or more meant N attempts in total, and `retryTimes: 0` meant
one attempt. In 2.0, `retries` counts the attempts after the first one, so `retries: N` is N plus
one attempts. Map `retryTimes: N` to `retries: max(0, N - 1)` to keep the attempt count.

### The delay function

The 1.x function received `{ attemptNumber, startedAt, previousDelay, settings, stop }`. The 2.0
function receives `{ attempt, elapsedMs, previousDelay }`. Cancel with an `AbortSignal` in the
options instead of `stop()`. A 1.x settings object with a delay function and no `retryTimes`
retried without a limit. Pass `retries: Infinity` to keep that.

## Behaviour that changed

- **`release()` throws driver errors.** 1.x swallowed every error in `release()`. 2.0 returns
  `false` when the key was not ours and throws only when the driver throws. A `finally` block that
  calls `release()` can now throw a driver error. The lock keeps its state after such a throw, so
  a later `release()` tries again.
- **`isHeld()` marks a lost lock.** A `false` answer while the lock is held moves it to `lost` and
  aborts `lock.signal`. 1.x `isLocked()` only reported.
- **The local clock is monotonic.** Elapsed time comes from `performance.now()`, so a wall-clock
  step does not move the local expiry estimate.
- **A slow answer is not a lock.** An acquire or extend answer that arrives after the lease has run
  out is treated as a failure.
- **The MongoDB adapter compares expiry on the server clock.** 1.x compared `expireAt` with the
  client's `new Date()`. 2.0 uses `$$NOW` on the server. The document shape is unchanged. Two
  processes on 1.x and 2.0 therefore read one document with two clocks until the deploy finishes.
- **The MongoDB adapter creates two indexes, not three.** The compound index on
  `key, expireAt, uniqueValue` is no longer created. An existing one is left in place.
- **The Redis adapter registers no commands.** 1.x called `defineCommand` for `releaseLock` and
  `extendLock` on the client. 2.0 sends the scripts with `EVALSHA` and falls back to `EVAL`.
- **Validation errors are rejections.** Every acquire method is async, so a bad argument rejects
  the promise instead of throwing before the promise exists.

## The codemod

The package ships a codemod as the `locco-migrate-v2` command. It rewrites the one literal 1.x
call shape:

```
.lock(KEY, TTL).setRetrySettings({ retryTimes: N, retryDelay: D }).acquire()
```

into

```
.acquire(KEY, { ttl: TTL, retry: { retries: N - 1, delay: D } })
```

It parses each file with the TypeScript package of your project, so text inside a string, a
comment or a regular expression is not touched. It changes only numeric literals for
`retryTimes`. It prints every site it did not rewrite: a `lock()` call kept in a variable, a
`retryDelayFn`, a settings object held in a variable, a spread, a `uniqueValue`, an `isLocked`, a
`throwOnFail`, a `locksCollectionName`, or an import of a 1.x error class.

After you install 2.0, run it from your project:

```shell
npx locco-migrate-v2 src/**/*.ts            # report only
npx locco-migrate-v2 --write src/**/*.ts    # rewrite the files
```

Read the report and finish the listed sites by hand. Then run your test suite against a 2.0
install before you deploy.

## `await using`

A `Lock` implements `Symbol.asyncDispose`, so `await using lock = await locker.acquire(...)`
releases it at block exit. When the work throws and the release throws too, the runtime raises a
`SuppressedError` that carries both errors. This needs TypeScript 5.2 or newer. It is a follow-up
after the mechanical migration, one critical section at a time.
