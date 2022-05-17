[![Buuild and Test](https://github.com/kontsedal/locco/workflows/Build%20and%20Test/badge.svg)](https://github.com/kontsedal/locco/actions/workflows/status.yml?query=branch%3Amain++)
![Coverage Badge](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Kontsedal/e0ad01840d30efd4c1766e5ba5845567/raw/locco__heads_main.json)

# locco

A small and simple library to deal with race conditions in distributed systems by applying locks on resources. Currently, supports locking via Redis, MongoDB, and in-memory object.

## Installation

```shell
npm i @kontsedal/locco
```

## Core logic

With locks, user can just say _"I'm doing some stuff with this user, please lock him and don't allow anybody to change him"_ and no one will, till a lock is valid.

The core logic is simple. When we create a lock we generate a unique string identifying a current lock operation.
Then, we search for a valid lock with a same key in the storage(Redis, Mongo, js object) and if it doesn't exist we add one and proceed.
If a valid lock already exists we retry this operation for some time and then fail.

When we release or extend a lock, we check that lock exists in the storage and has the same unique identifier with a current lock. It makes impossible to release or extend other process lock.

## Usage

There are two ways to create a resource lock. In the first one, you should manually lock and unlock a resource. Here is an example with a Redis:

```typescript
import { Locker, IoRedisAdapter } from "@kontsedal/locco";
import Redis from "ioredis";

const redisAdapter = new IoRedisAdapter({ client: new Redis() });
const locker = new Locker({
  adapter: redisAdapter,
  retrySettings: { retryDelay: 200, retryTimes: 10 },
});

const lock = await locker.lock("user:123", 3000).aquire();
try {
  //do some risky stuff here
  //...
  //
  await lock.extend(2000);
  //do more risky stuff
  //...
} catch (error) {
} finally {
  await lock.release();
}
```

In the second one, you pass a function in the **acquire** method and a lock will be released automatically when a function finishes. Here is an example with a mongo:

```typescript
import { Locker, IoRedisAdapter, MongoAdapter } from "@kontsedal/Locker";
import { MongoClient } from "mongodb";

const mongoAdapter = new MongoAdapter({
  client: new MongoClient(process.env.MONGO_URL),
});
const locker = new Locker({
  adapter: mongoAdapter,
  retrySettings: { retryDelay: 200, retryTimes: 10 },
});

await locker.lock("user:123", 3000).setRetrySettings({retryDelay: 200, retryTimes: 50}).aquire(async (lock) => {
  //do some risky stuff here
  //...
  await lock.extend(2000);
  //do some risky stuff here
  //...
});
```

## API

### Locker

The main class is responsible for the creation of new locks and passing them a storage adapter and default retrySettings.

Constructor params:

| parameter                         | type                 | isRequired | description                                                                                             |
| --------------------------------- | -------------------- | ---------- |---------------------------------------------------------------------------------------------------------|
| params.adapter                    | ILockAdapter         | true       | Adapter to work with a lock keys storage. Currently Redis, Mongo and in-memory adapters are implemented |
| params.retrySettings              | object               | true       |                                                                                                         |
| params.retrySettings.retryTimes   | number(milliseconds) | false      | How many times we should retry lock before fail                                                         |
| params.retrySettings.retryDelay   | number(milliseconds) | false      | How much time should pass between retries                                                               |
| params.retrySettings.totalTime    | number(milliseconds) | false      | How much time should all retries last in total                                                          |
| params.retrySettings.retryDelayFn | function             | false      | Function which returns a retryDelay for each attempt. Allows to implement an own delay logic            |

Example of a retryDelayFn usage:

```typescript
const locker = new Locker({
  adapter: new InMemoryAdapter(),
  retrySettings: {
    retryDelayFn: ({
      attemptNumber, // starts from 0
      startedAt, // date of start in milliseconds
      previousDelay,
      settings, // retrySettings
      stop, // function to stop a retries, throws an error
    }) => {
      if (attemptNumber === 4) {
        stop();
      }
      return (attemptNumber + 1) * 50;
    },
  },
});
```

Provided example will do the same as providing retryTimes = 5, retryDelay = 50

#### Methods

##### _lock(key: string, ttl: number) => Lock_

Creates a **Lock** instance with provided key and time to live in milliseconds.
It won't lock a resource at this point. Need to call an **aquire()** to do so

##### _Lock.aquire(cb?: (lock: Lock) => void) => Promise\<Lock>_

Locks a resource if possible. If not, it retries as much as specified in the retrySettings.
If callback is provided, lock will be released after a callback execution.

##### _Lock.release({ throwOnFail?: boolean }) => Promise\<void>_

Unlocks a resource. If a resource is invalid (already taken by other lock or expired) it won't throw an error.
To make it throw an error, need to provide `{throwOnFail:true}`.

##### _Lock.extend(ttl: number) => Promise\<void>_

Extends a lock for a provided milliseconds from now. Will throw an error if current lock is already invalid

##### _Lock.isLocked() => Promise\<boolean>_

Checks if a lock still valid

##### _Lock.setRetrySettings(settings: RetrySettings) => Promise\<Lock>_

Overrides a default retry settings of the lock.

---

### Redis adapter

Requires only a compatible with ioredis client:

```typescript
import { IoRedisAdapter } from "@kontsedal/locco";
import Redis from "ioredis";

const redisAdapter = new IoRedisAdapter({ client: new Redis() });
```

#### How it works

It relies on a Redis **SET** command with options **NX** and **PX**.

**NX** - ensures that a record will be removed after provided time

**PX** - ensures that if a record already exists it won't be replaced with a new one

So, to create a lock we just execute a **SET** command and if it returns "OK"
response means that lock is created, if it returns null - a resource is locked.

To release or extend a lock, firstly, it gets a current key value(which is a unique string for each lock) and
compares it with a current one. If it matches we either remove the key or set a new TTL for it.


---

### Mongo adapter

Requires a mongo client and optional database name and lock collection name:

```typescript
import { MongoAdapter } from "@kontsedal/locco";
import { MongoClient } from "mongodb";

const mongoAdapter = new MongoAdapter({
  client: new MongoClient(process.env.MONGO_URL),
  dbName: "my-db", // optional parameter
  locksCollectionName: "locks", //optional parameter, defaults to "locco-locks"
});
```

#### How it works

We create a collection of locks in the database with the next fields:

- key: string
- uniqueValue: string
- expireAt: Date

For this collection we create a special index `{ key: 1 }, { unique: true }`, so mongo will throw an error
if we try to create a new record with an existing key.

To create a lock, we use an **updateOne** method with an `upsert = true` option:

```typescript
collection.updateOne(
  {
    key,
    expireAt: { $lt: new Date() },
  },
  { $set: { key, uniqueValue, expireAt: new Date(Date.now() + ttl) } },
  { upsert: true }
);
```
So, let's imagine that we want to create a lock and there is a valid lock in the DB.
If the lock is valid, it won't pass ```expireAt: { $lt: new Date() }``` check, because its expireAt
will be later than a current date. In this case **updateOne** will try to create a new record in the collection, because of ```{ upsert: true }``` option.
But it will throw an error because we have a **unique** index. So this operation can only be successful when
there is no valid lock in the DB. If there is an invalid lock in the DB, it will be replaced by a new one.

Release and extend relies on the same logic, but we also compare with a key unique string.
