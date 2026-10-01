// Runs the published contract suite through the published entry points, under the vitest the
// check installed, and loads the CommonJS build once to prove it still resolves.
import { createRequire } from 'node:module';
import { InMemoryAdapter } from '@kontsedal/locco/memory';
import { runLockAdapterContract } from '@kontsedal/locco/testing';
import { expect, it } from 'vitest';

runLockAdapterContract('InMemoryAdapter from the tarball', () => ({
  adapter: new InMemoryAdapter(),
}));

it('loads the CommonJS build', async () => {
  const require = createRequire(import.meta.url);
  const { Locker } = require('@kontsedal/locco');
  const { InMemoryAdapter: Memory } = require('@kontsedal/locco/memory');
  const locker = new Locker({ adapter: new Memory() });
  const lock = await locker.acquire('k', { ttl: 1000 });
  await expect(lock.release()).resolves.toBe(true);
});
