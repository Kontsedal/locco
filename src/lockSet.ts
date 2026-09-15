import type { Lock } from './lock';
import type { LockEvent } from './types';
import { assertDuration } from './validate';

export class LockSet implements AsyncDisposable {
  readonly locks: readonly Lock[];
  /** Aborts when any member's signal aborts. */
  readonly signal: AbortSignal;
  readonly #emit: (event: LockEvent) => void;

  constructor(locks: Lock[], emit: (event: LockEvent) => void) {
    this.locks = Object.freeze([...locks]);
    this.signal = AbortSignal.any(locks.map((lock) => lock.signal));
    this.#emit = emit;
  }

  /**
   * Releases every lock, even when one throws. Returns true when every key was still ours.
   * When releases throw, the first error is thrown and the others go to `releaseFailed` events.
   */
  async release(): Promise<boolean> {
    const results = await Promise.allSettled(this.locks.map((lock) => lock.release()));
    let allReleased = true;
    let firstError: { error: unknown } | undefined;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allReleased = allReleased && result.value;
        return;
      }
      if (!firstError) {
        firstError = { error: result.reason };
        return;
      }
      const lock = this.locks[index];
      if (lock) {
        this.#emit({
          type: 'releaseFailed',
          key: lock.key,
          ttl: lock.ttl,
          heldMs: 0,
          error: result.reason,
        });
      }
    });
    if (firstError) {
      throw firstError.error;
    }
    return allReleased;
  }

  /** Extends every lock. Throws the first failure after every extension has settled. */
  async extend(ttl: number): Promise<void> {
    assertDuration(ttl, 'ttl');
    const results = await Promise.allSettled(this.locks.map((lock) => lock.extend(ttl)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}
