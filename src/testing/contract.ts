import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LockAdapter } from '../adapter';

export type AdapterUnderTest = {
  adapter: LockAdapter;
  /** Called once after the suite. Close clients here. */
  close?: () => Promise<unknown> | unknown;
};

export type ContractOptions = {
  /** Lease length the suite uses. Default 300 ms. Raise it for a slow backend. */
  ttl?: number;
  /** How many concurrent acquires race on one key. Default 40. */
  racers?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The behaviour every adapter must have. Run it in a vitest file for a custom adapter:
 * `runLockAdapterContract('MyAdapter', () => ({ adapter: new MyAdapter() }))`.
 */
export function runLockAdapterContract(
  name: string,
  makeAdapter: () => AdapterUnderTest | Promise<AdapterUnderTest>,
  options: ContractOptions = {},
): void {
  const ttl = options.ttl ?? 300;
  const racers = options.racers ?? 40;
  const afterExpiry = ttl + Math.max(50, Math.floor(ttl / 4));

  describe(`${name} lock adapter contract`, () => {
    let subject: AdapterUnderTest;
    let adapter: LockAdapter;
    const key = () => `locco-contract:${randomUUID()}`;
    const token = () => randomUUID();

    beforeAll(async () => {
      subject = await makeAdapter();
      adapter = subject.adapter;
    });

    afterAll(async () => {
      await subject.close?.();
    });

    it('acquires a free key', async () => {
      await expect(adapter.acquire({ key: key(), token: token(), ttl })).resolves.toBe(true);
    });

    it('refuses a key another token holds', async () => {
      const k = key();
      await adapter.acquire({ key: k, token: token(), ttl });
      await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(false);
    });

    it('acquires a key whose lease ran out', async () => {
      const k = key();
      await adapter.acquire({ key: k, token: token(), ttl });
      await sleep(afterExpiry);
      await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(true);
    });

    it('acquires a key after its holder released it', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await adapter.release({ key: k, token: t });
      await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(true);
    });

    it('releases once and answers false the second time', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await expect(adapter.release({ key: k, token: t })).resolves.toBe(true);
      await expect(adapter.release({ key: k, token: t })).resolves.toBe(false);
    });

    it('does not release a key another token holds', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await expect(adapter.release({ key: k, token: token() })).resolves.toBe(false);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
    });

    it('does not release a key whose lease ran out', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await sleep(afterExpiry);
      await expect(adapter.release({ key: k, token: t })).resolves.toBe(false);
    });

    it('extends our lease past the original one', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await expect(adapter.extend({ key: k, token: t, ttl: ttl * 3 })).resolves.toBe(true);
      await sleep(afterExpiry);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
      await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(false);
    });

    it('does not extend a key another token holds', async () => {
      const k = key();
      await adapter.acquire({ key: k, token: token(), ttl });
      await expect(adapter.extend({ key: k, token: token(), ttl })).resolves.toBe(false);
    });

    it('does not extend a key whose lease ran out', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await sleep(afterExpiry);
      await expect(adapter.extend({ key: k, token: t, ttl })).resolves.toBe(false);
    });

    it('reports whether our lease is live', async () => {
      const k = key();
      const t = token();
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(false);
      await adapter.acquire({ key: k, token: t, ttl });
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
      await expect(adapter.isHeld({ key: k, token: token() })).resolves.toBe(false);
      await sleep(afterExpiry);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(false);
    });

    it('lets exactly one of many concurrent acquires win', async () => {
      const k = key();
      const results = await Promise.all(
        Array.from({ length: racers }, () => adapter.acquire({ key: k, token: token(), ttl })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('keeps keys independent', async () => {
      const first = key();
      const second = key();
      await expect(adapter.acquire({ key: first, token: token(), ttl })).resolves.toBe(true);
      await expect(adapter.acquire({ key: second, token: token(), ttl })).resolves.toBe(true);
    });
  });
}
