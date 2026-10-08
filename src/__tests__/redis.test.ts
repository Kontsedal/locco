import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IoRedisAdapter, type IoRedisLikeClient } from '../adapters/ioRedis';
import { NodeRedisAdapter } from '../adapters/nodeRedis';
import {
  FENCE_RETENTION_MS,
  fenceKeyFor,
  isNoScriptError,
  RedisReplicationError,
} from '../adapters/redisScripts';
import { Locker } from '../locker';
import { closeNodeRedis, ioRedisClient, uniqueKey } from './backends';
import { TEST_CONFIG } from './config';

describe('Redis adapters', () => {
  const client = ioRedisClient();

  afterAll(async () => {
    await client.quit();
  });

  it('IoRedisAdapter falls back to eval after the script cache is flushed', async () => {
    const adapter = new IoRedisAdapter({ client });
    const key = uniqueKey();
    await adapter.acquire({ key, token: 't', ttl: 5000 });
    await client.script('FLUSH');
    await expect(adapter.extend({ key, token: 't', ttl: 5000 })).resolves.toBe(true);
    await client.script('FLUSH');
    await expect(adapter.release({ key, token: 't' })).resolves.toBe(true);
  });

  it('two IoRedisAdapters share one client', async () => {
    const first = new IoRedisAdapter({ client });
    const second = new IoRedisAdapter({ client });
    const key = uniqueKey();
    await expect(first.acquire({ key, token: 'a', ttl: 5000 })).resolves.toBe(true);
    await expect(second.acquire({ key, token: 'b', ttl: 5000 })).resolves.toBe(false);
    await expect(second.release({ key, token: 'a' })).resolves.toBe(true);
  });

  it('recognizes only NOSCRIPT answers', () => {
    expect(isNoScriptError(new Error('NOSCRIPT No matching script. Please use EVAL.'))).toBe(true);
    expect(isNoScriptError(new Error('ERR wrong number of arguments'))).toBe(false);
    expect(isNoScriptError(null)).toBe(false);
  });

  it('lets a script error that is not NOSCRIPT through, instead of retrying it as EVAL', async () => {
    // Re-sending the script on, say, a connection error would hide a real fault and double the
    // work. Only a missing script cache is worth a second attempt.
    const evalSpy = vi.fn();
    const adapter = new IoRedisAdapter({
      client: {
        set: async () => 'OK',
        get: async () => null,
        eval: evalSpy,
        evalsha: async () => {
          throw new Error('READONLY You cannot write against a read only replica.');
        },
      },
    });
    await expect(adapter.release({ key: 'k', token: 't' })).rejects.toThrow(/READONLY/);
    await expect(adapter.extend({ key: 'k', token: 't', ttl: 1000 })).rejects.toThrow(/READONLY/);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('lets a NodeRedis script error that is not NOSCRIPT through', async () => {
    const evalSpy = vi.fn();
    const adapter = new NodeRedisAdapter({
      client: {
        set: async () => 'OK',
        get: async () => null,
        eval: evalSpy,
        evalSha: async () => {
          throw new Error('READONLY You cannot write against a read only replica.');
        },
      },
    });
    await expect(adapter.release({ key: 'k', token: 't' })).rejects.toThrow(/READONLY/);
    await expect(adapter.extend({ key: 'k', token: 't', ttl: 1000 })).rejects.toThrow(/READONLY/);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  /** The server clock in microseconds, as the fenced acquire reads it. */
  const serverMicros = async () => {
    const [seconds, micros] = (await client.time()) as [string | number, string | number];
    return Number(seconds) * 1_000_000 + Number(micros);
  };

  it('IoRedisAdapter takes a fence after the script cache is flushed', async () => {
    const adapter = new IoRedisAdapter({ client });
    const key = uniqueKey();
    await client.script('FLUSH');
    const before = await serverMicros();
    const fence = (await adapter.acquireFenced({ key, token: 't', ttl: 5000 })) as number;
    expect(Number.isSafeInteger(fence)).toBe(true);
    expect(fence).toBeGreaterThanOrEqual(before);
    await expect(client.get(fenceKeyFor(key))).resolves.toBe(String(fence));
    // The lock key itself is the 1.x shape: the token, and nothing else.
    await expect(client.get(key)).resolves.toBe('t');
  });

  it('keeps fences growing after the counter is lost', async () => {
    // A restart without persistence, a flush or a failover can drop the counter. The fence then
    // starts again from the server clock, which is past every fence handed out before.
    const adapter = new IoRedisAdapter({ client });
    const key = uniqueKey();
    const first = (await adapter.acquireFenced({ key, token: 'a', ttl: 5000 })) as number;
    await adapter.release({ key, token: 'a' });
    await client.del(fenceKeyFor(key));
    const second = (await adapter.acquireFenced({ key, token: 'b', ttl: 5000 })) as number;
    expect(second).toBeGreaterThan(first);
  });

  it('keeps fences growing when the server clock is behind the counter', async () => {
    // A failover to a replica whose clock is behind, or a clock that stepped back.
    const adapter = new IoRedisAdapter({ client });
    const key = uniqueKey();
    const ahead = (await serverMicros()) + 3_600_000_000;
    await client.set(fenceKeyFor(key), String(ahead));
    await expect(adapter.acquireFenced({ key, token: 'a', ttl: 5000 })).resolves.toBe(ahead + 1);
    await adapter.release({ key, token: 'a' });
    await expect(adapter.acquireFenced({ key, token: 'b', ttl: 5000 })).resolves.toBe(ahead + 2);
  });

  it('expires the counter a day after the last grant, or after the lease when that is longer', async () => {
    const adapter = new IoRedisAdapter({ client });
    const short = uniqueKey();
    await adapter.acquireFenced({ key: short, token: 't', ttl: 5000 });
    const shortTtl = await client.pttl(fenceKeyFor(short));
    expect(shortTtl).toBeGreaterThan(FENCE_RETENTION_MS - 60_000);
    expect(shortTtl).toBeLessThanOrEqual(FENCE_RETENTION_MS);
    const long = uniqueKey();
    const twoDays = 2 * FENCE_RETENTION_MS;
    await adapter.acquireFenced({ key: long, token: 't', ttl: twoDays });
    expect(await client.pttl(fenceKeyFor(long))).toBeGreaterThan(twoDays - 60_000);
    await client.del(short, long, fenceKeyFor(short), fenceKeyFor(long));
  });

  it('puts the counter in the hash slot of its lock key', () => {
    for (const key of ['order:1', 'app:{tenant-7}:order:1', '{a}', '{', 'a{b', 'é:ключ']) {
      expect(keySlot(fenceKeyFor(key))).toBe(keySlot(key));
    }
    // A key with a `}` but no hash tag hashes whole, and no other key can share its slot. The
    // README tells Cluster users to give such a key a hash tag.
    expect(keySlot(fenceKeyFor('x{}y'))).not.toBe(keySlot('x{}y'));
    expect(fenceKeyFor('app:{tenant-7}:order:1')).toBe('app:{tenant-7}:order:1:locco-fence');
    expect(fenceKeyFor('order:1')).toBe('{order:1}:locco-fence');
  });

  it('validates waitForReplicas', () => {
    const make = (options: object) => () =>
      new IoRedisAdapter({ client, ...options } as ConstructorParameters<typeof IoRedisAdapter>[0]);
    expect(make({ waitForReplicas: 1 })).toThrow(/waitForReplicas must be an object/);
    expect(make({ waitForReplicas: null })).toThrow(/waitForReplicas must be an object/);
    expect(make({ waitForReplicas: { replicas: 0, timeout: 100 } })).toThrow(/replicas must be/);
    expect(make({ waitForReplicas: { replicas: 1, timeout: 0 } })).toThrow(/timeout must be/);
    expect(make({ waitForReplicas: { replicas: 1, timeout: 100 } })).not.toThrow();
    const noWait = { set: client.set, get: client.get, eval: client.eval, evalsha: client.evalsha };
    expect(
      () =>
        new IoRedisAdapter({
          client: noWait as never,
          waitForReplicas: { replicas: 1, timeout: 100 },
        }),
    ).toThrow(/needs a client with a wait\(\) method/);
  });

  it('refuses waitForReplicas on a pool or a cluster client', () => {
    // WAIT confirms only the writes of its own connection. These clients can send it on another.
    const base = { ...client, wait: async () => 1 };
    const pools = [
      { ...base, isCluster: true },
      Object.assign(
        Object.create({
          get masters() {
            return [];
          },
        }),
        base,
      ),
      Object.assign(
        Object.create({
          get totalClients() {
            return 2;
          },
        }),
        base,
      ),
    ];
    for (const pool of pools) {
      expect(
        () => new IoRedisAdapter({ client: pool, waitForReplicas: { replicas: 1, timeout: 100 } }),
      ).toThrow(/one connection, not a pool or a cluster client/);
    }
    expect(
      () =>
        new IoRedisAdapter({
          client: { ...base, isCluster: false } as IoRedisLikeClient,
          waitForReplicas: { replicas: 1, timeout: 100 },
        }),
    ).not.toThrow();
  });

  it('throws RedisReplicationError when a write reaches too few replicas', async () => {
    // The test Redis has no replicas, so WAIT answers 0 after its timeout.
    const adapter = new IoRedisAdapter({ client, waitForReplicas: { replicas: 1, timeout: 20 } });
    const key = uniqueKey();
    const failure = await adapter.acquire({ key, token: 't', ttl: 5000 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RedisReplicationError);
    expect(failure).toMatchObject({ replicas: 1, acknowledged: 0 });
    await expect(adapter.extend({ key, token: 't', ttl: 5000 })).rejects.toBeInstanceOf(
      RedisReplicationError,
    );
    // A release needs no replicas: a lost delete only leaves the key until its lease runs out.
    await expect(adapter.release({ key, token: 't' })).resolves.toBe(true);
    await expect(
      adapter.acquireFenced({ key: uniqueKey(), token: 't', ttl: 5000 }),
    ).rejects.toBeInstanceOf(RedisReplicationError);
    // A refused write sends no WAIT, so it answers at once.
    const held = uniqueKey();
    await client.set(held, 'other', 'PX', 5000);
    await expect(adapter.acquire({ key: held, token: 't', ttl: 5000 })).resolves.toBe(false);
    await expect(adapter.acquireFenced({ key: held, token: 't', ttl: 5000 })).resolves.toBeNull();
    await expect(adapter.extend({ key: held, token: 't', ttl: 5000 })).resolves.toBe(false);
  });

  it('gives the key back when a Locker acquire reaches too few replicas', async () => {
    const adapter = new IoRedisAdapter({ client, waitForReplicas: { replicas: 1, timeout: 20 } });
    const locker = new Locker({ adapter, retry: { retries: 0 } });
    const key = uniqueKey();
    await expect(locker.acquire(key, { ttl: 5000 })).rejects.toBeInstanceOf(RedisReplicationError);
    await vi.waitFor(async () => expect(await client.exists(key)).toBe(0));
  });

  it('accepts a write that enough replicas acknowledged', async () => {
    const wait = vi.fn(async () => 2);
    const store = new Map<string, string>();
    const adapter = new IoRedisAdapter({
      client: {
        set: async (key, value) => {
          store.set(key, value);
          return 'OK';
        },
        get: async (key) => store.get(key) ?? null,
        eval: async () => 1,
        evalsha: async () => 1,
        wait,
      },
      waitForReplicas: { replicas: 2, timeout: 100 },
    });
    await expect(adapter.acquire({ key: 'k', token: 't', ttl: 1000 })).resolves.toBe(true);
    await expect(adapter.extend({ key: 'k', token: 't', ttl: 1000 })).resolves.toBe(true);
    await expect(adapter.acquireFenced({ key: 'k', token: 't', ttl: 1000 })).resolves.toBe(1);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(2, 100);
  });

  it('calls wait on the client, so a driver that reads this keeps working', async () => {
    const client = {
      replicas: 1,
      set: async () => 'OK',
      get: async () => null,
      eval: async () => 1,
      evalsha: async () => 1,
      async wait(this: { replicas: number }) {
        return this.replicas;
      },
    };
    const adapter = new IoRedisAdapter({ client, waitForReplicas: { replicas: 1, timeout: 100 } });
    await expect(adapter.acquire({ key: 'k', token: 't', ttl: 1000 })).resolves.toBe(true);
  });

  describe('NodeRedisAdapter', () => {
    let nodeClient: Awaited<ReturnType<typeof import('redis').createClient>>;

    beforeAll(async () => {
      const { createClient } = await import('redis');
      nodeClient = createClient({ url: `redis://localhost:${TEST_CONFIG.REDIS_PORT}` });
      await nodeClient.connect();
    });

    afterAll(async () => {
      await closeNodeRedis(nodeClient);
    });

    it('falls back to eval after the script cache is flushed', async () => {
      const adapter = new NodeRedisAdapter({ client: nodeClient });
      const key = uniqueKey();
      await expect(adapter.acquire({ key, token: 't', ttl: 5000 })).resolves.toBe(true);
      await nodeClient.scriptFlush();
      await expect(adapter.extend({ key, token: 't', ttl: 5000 })).resolves.toBe(true);
      await nodeClient.scriptFlush();
      await expect(adapter.release({ key, token: 't' })).resolves.toBe(true);
    });

    it('takes fences from the same counter as IoRedisAdapter', async () => {
      const io = new IoRedisAdapter({ client });
      const node = new NodeRedisAdapter({ client: nodeClient });
      const key = uniqueKey();
      await nodeClient.scriptFlush();
      const first = (await node.acquireFenced({ key, token: 'a', ttl: 5000 })) as number;
      await node.release({ key, token: 'a' });
      const second = (await io.acquireFenced({ key, token: 'b', ttl: 5000 })) as number;
      await io.release({ key, token: 'b' });
      const third = (await node.acquireFenced({ key, token: 'c', ttl: 5000 })) as number;
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);
      await expect(nodeClient.get(fenceKeyFor(key))).resolves.toBe(String(third));
    });

    it('refuses waitForReplicas on a client pool', async (context) => {
      // `createClientPool` arrived in redis 5. On 4 there is no pool to refuse.
      const { createClientPool } = (await import('redis')) as Partial<typeof import('redis')>;
      if (typeof createClientPool !== 'function') {
        context.skip();
        return;
      }
      const pool = createClientPool({ url: `redis://localhost:${TEST_CONFIG.REDIS_PORT}` });
      expect(
        () =>
          new NodeRedisAdapter({
            client: pool as never,
            waitForReplicas: { replicas: 1, timeout: 100 },
          }),
      ).toThrow(/not a pool or a cluster client/);
    });

    it('throws RedisReplicationError when a write reaches too few replicas', async () => {
      const adapter = new NodeRedisAdapter({
        client: nodeClient,
        waitForReplicas: { replicas: 1, timeout: 20 },
      });
      const key = uniqueKey();
      await expect(adapter.acquire({ key, token: 't', ttl: 5000 })).rejects.toBeInstanceOf(
        RedisReplicationError,
      );
      await expect(adapter.extend({ key, token: 't', ttl: 5000 })).rejects.toBeInstanceOf(
        RedisReplicationError,
      );
      await expect(adapter.release({ key, token: 't' })).resolves.toBe(true);
      await expect(
        adapter.acquireFenced({ key: uniqueKey(), token: 't', ttl: 5000 }),
      ).rejects.toBeInstanceOf(RedisReplicationError);
      const held = uniqueKey();
      await nodeClient.set(held, 'other', { PX: 5000 });
      await expect(adapter.acquire({ key: held, token: 't', ttl: 5000 })).resolves.toBe(false);
      await expect(adapter.acquireFenced({ key: held, token: 't', ttl: 5000 })).resolves.toBeNull();
      await expect(adapter.extend({ key: held, token: 't', ttl: 5000 })).resolves.toBe(false);
    });

    it('shares keys with IoRedisAdapter', async () => {
      const io = new IoRedisAdapter({ client });
      const node = new NodeRedisAdapter({ client: nodeClient });
      const key = uniqueKey();
      await expect(io.acquire({ key, token: 'a', ttl: 5000 })).resolves.toBe(true);
      await expect(node.acquire({ key, token: 'b', ttl: 5000 })).resolves.toBe(false);
      await expect(node.isHeld({ key, token: 'a' })).resolves.toBe(true);
      await expect(node.release({ key, token: 'a' })).resolves.toBe(true);
    });
  });
});

/** The Redis Cluster hash slot of a key: CRC16/XMODEM of its hash tag, or of the whole key. */
function keySlot(key: string): number {
  const bytes = Buffer.from(key);
  const open = bytes.indexOf('{');
  const close = open === -1 ? -1 : bytes.indexOf('}', open + 1);
  const hashed = close > open + 1 ? bytes.subarray(open + 1, close) : bytes;
  let crc = 0;
  for (const byte of hashed) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16384;
}
