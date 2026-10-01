// What a CommonJS consumer writes. TypeScript resolves the `require` condition here.
import { LoccoError, Locker } from '@kontsedal/locco';
import { InMemoryAdapter } from '@kontsedal/locco/memory';

const locker = new Locker({ adapter: new InMemoryAdapter() });

export async function run(): Promise<boolean> {
  const lock = await locker.tryAcquire('nightly-report', { ttl: 60_000 });
  if (!lock) {
    return false;
  }
  try {
    return lock.state === 'held';
  } catch (error) {
    return error instanceof LoccoError && error.code === 'LOCK_LOST';
  } finally {
    await lock.release();
  }
}
