import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IoRedisAdapter } from '../adapters/ioRedis';
import { NodeRedisAdapter } from '../adapters/nodeRedis';
import { isNoScriptError } from '../adapters/redisScripts';
import { ioRedisClient, uniqueKey } from './backends';
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

  describe('NodeRedisAdapter', () => {
    let nodeClient: Awaited<ReturnType<typeof import('redis').createClient>>;

    beforeAll(async () => {
      const { createClient } = await import('redis');
      nodeClient = createClient({ url: `redis://localhost:${TEST_CONFIG.REDIS_PORT}` });
      await nodeClient.connect();
    });

    afterAll(async () => {
      await nodeClient.close();
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
