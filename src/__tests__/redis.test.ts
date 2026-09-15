import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
