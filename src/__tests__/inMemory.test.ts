import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '../adapters/inMemory';

describe('InMemoryAdapter', () => {
  it('forgets every lock on clear', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.acquire({ key: 'a', token: 't', ttl: 60_000 });
    await adapter.acquire({ key: 'b', token: 't', ttl: 60_000 });
    adapter.clear();
    await expect(adapter.isHeld({ key: 'a', token: 't' })).resolves.toBe(false);
    await expect(adapter.acquire({ key: 'b', token: 'other', ttl: 1000 })).resolves.toBe(true);
  });

  it('clears at block exit through Symbol.dispose', () => {
    let escaped: InMemoryAdapter | undefined;
    {
      using adapter = new InMemoryAdapter();
      escaped = adapter;
      void adapter.acquire({ key: 'a', token: 't', ttl: 60_000 });
    }
    // The lease was minutes long, so anything still held here would outlive the block.
    return expect(escaped.isHeld({ key: 'a', token: 't' })).resolves.toBe(false);
  });

  it('reads expiry from the injected clock, not the timer queue', async () => {
    let now = 0;
    const adapter = new InMemoryAdapter({ now: () => now });
    await expect(adapter.acquire({ key: 'a', token: 't', ttl: 1000 })).resolves.toBe(true);
    now = 999;
    await expect(adapter.isHeld({ key: 'a', token: 't' })).resolves.toBe(true);
    now = 1000;
    await expect(adapter.isHeld({ key: 'a', token: 't' })).resolves.toBe(false);
    await expect(adapter.acquire({ key: 'a', token: 'other', ttl: 1000 })).resolves.toBe(true);
    adapter.clear();
  });
});
