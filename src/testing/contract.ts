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
  // A race must not take longer than the lease, or a second winner is legitimate.
  const raceTtl = Math.max(ttl * 20, 60_000);

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

    it('sets a shorter lease from now, not from the old expiry', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl: ttl * 3 });
      await expect(adapter.extend({ key: k, token: t, ttl })).resolves.toBe(true);
      await sleep(afterExpiry);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(false);
      await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(true);
    });

    it('does not extend a key another token holds, and keeps that holder', async () => {
      const k = key();
      const t = token();
      await adapter.acquire({ key: k, token: t, ttl });
      await expect(adapter.extend({ key: k, token: token(), ttl })).resolves.toBe(false);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
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

    /** Races `racers` acquires on one key and gives the winner's minute-long lease straight back. */
    const raceFor = async (k: string): Promise<number> => {
      const tokens = Array.from({ length: racers }, token);
      const results = await Promise.all(
        tokens.map((t) => adapter.acquire({ key: k, token: t, ttl: raceTtl })),
      );
      // `raceTtl` is a minute or more, so a lease left behind outlives the whole suite and piles
      // up in a backend that has no reaper of its own, such as Postgres.
      await Promise.all(
        tokens
          .filter((_, index) => results[index])
          .map((t) => adapter.release({ key: k, token: t })),
      );
      return results.filter(Boolean).length;
    };

    it('lets exactly one of many concurrent acquires win a free key', async () => {
      await expect(raceFor(key())).resolves.toBe(1);
    });

    it('lets exactly one of many concurrent acquires take over an expired key', async () => {
      const k = key();
      await adapter.acquire({ key: k, token: token(), ttl });
      await sleep(afterExpiry);
      await expect(raceFor(k)).resolves.toBe(1);
    });

    it('stores a key and a token verbatim, including a key that starts with $', async () => {
      const k = `$$NOW:${key()}`;
      const t = `$${token()}`;
      await expect(adapter.acquire({ key: k, token: t, ttl })).resolves.toBe(true);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
      await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(false);
      await expect(adapter.extend({ key: k, token: t, ttl })).resolves.toBe(true);
      await expect(adapter.release({ key: k, token: t })).resolves.toBe(true);
      await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(false);
    });

    it('keeps keys independent', async () => {
      const first = key();
      const second = key();
      await expect(adapter.acquire({ key: first, token: token(), ttl })).resolves.toBe(true);
      await expect(adapter.acquire({ key: second, token: token(), ttl })).resolves.toBe(true);
    });

    describe('acquireFenced, for an adapter that has it', () => {
      /** The method, or a skipped test for an adapter without fencing. */
      const fenced = (context: { skip: () => void }) => {
        const method = adapter.acquireFenced;
        if (typeof method !== 'function') {
          context.skip();
          throw new Error('unreachable: skip() ends the test');
        }
        return (params: { key: string; token: string; ttl: number }) =>
          method.call(adapter, params);
      };

      const expectFence = (fence: number | null): number => {
        expect(Number.isSafeInteger(fence) && (fence as number) > 0).toBe(true);
        return fence as number;
      };

      it('grants a free key with a positive integer token', async (context) => {
        const acquire = fenced(context);
        const k = key();
        const t = token();
        expectFence(await acquire({ key: k, token: t, ttl }));
        await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
      });

      it('gives every later grant of a key a larger token', async (context) => {
        const acquire = fenced(context);
        const k = key();
        const first = token();
        const afterRelease = token();
        const one = expectFence(await acquire({ key: k, token: first, ttl }));
        await adapter.release({ key: k, token: first });
        const two = expectFence(await acquire({ key: k, token: afterRelease, ttl }));
        expect(two).toBeGreaterThan(one);
        await sleep(afterExpiry);
        const three = expectFence(await acquire({ key: k, token: token(), ttl }));
        expect(three).toBeGreaterThan(two);
      });

      it('answers null for a held key and keeps the holder', async (context) => {
        const acquire = fenced(context);
        const k = key();
        const t = token();
        await adapter.acquire({ key: k, token: t, ttl });
        await expect(acquire({ key: k, token: token(), ttl })).resolves.toBeNull();
        await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(true);
      });

      it('holds a fenced key against a plain acquire', async (context) => {
        const acquire = fenced(context);
        const k = key();
        expectFence(await acquire({ key: k, token: token(), ttl }));
        await expect(adapter.acquire({ key: k, token: token(), ttl })).resolves.toBe(false);
      });

      it('extends and releases a fenced lease like any other', async (context) => {
        const acquire = fenced(context);
        const k = key();
        const t = token();
        expectFence(await acquire({ key: k, token: t, ttl }));
        await expect(adapter.extend({ key: k, token: t, ttl: ttl * 3 })).resolves.toBe(true);
        await expect(adapter.release({ key: k, token: t })).resolves.toBe(true);
        await expect(adapter.isHeld({ key: k, token: t })).resolves.toBe(false);
      });

      it('lets exactly one of many concurrent fenced acquires win', async (context) => {
        const acquire = fenced(context);
        const k = key();
        const tokens = Array.from({ length: racers }, token);
        const fences = await Promise.all(
          tokens.map((t) => acquire({ key: k, token: t, ttl: raceTtl })),
        );
        const winners = tokens.filter((_, index) => fences[index] !== null);
        expect(winners).toHaveLength(1);
        await Promise.all(winners.map((t) => adapter.release({ key: k, token: t })));
      });
    });
  });
}
