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
   * Releases every lock, even when one throws. Returns true when every key was still ours, and
   * false when any key was already gone. A second call answers false, like `Lock.release`.
   * Every failure gets a `releaseFailed` event, and the first error is then thrown.
   */
  release(): Promise<boolean> {
    return this.#releaseEach((lock) => lock.release());
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

  /**
   * Releases every lock the way `await using` releases one: a member whose release throws stops
   * its heartbeat, because nobody holds the set after the block to try again.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#releaseEach(async (lock) => {
      await lock[Symbol.asyncDispose]();
      return true;
    });
  }

  async #releaseEach(release: (lock: Lock) => Promise<boolean>): Promise<boolean> {
    // Each outcome carries its own lock, so nothing has to line results up with the array by index.
    const outcomes = await Promise.all(
      this.locks.map(async (lock) => {
        try {
          return { lock, released: await release(lock), error: undefined };
        } catch (error) {
          return { lock, released: false, error };
        }
      }),
    );
    let allReleased = true;
    let firstError: { error: unknown } | undefined;
    for (const { lock, released, error } of outcomes) {
      if (error === undefined) {
        allReleased = allReleased && released;
        continue;
      }
      firstError ??= { error };
      // Every failure is reported, the first one included. It is thrown as well, but an observer
      // counting keys that may have leaked has to see all of them, not all but one.
      this.#emit({
        type: 'releaseFailed',
        key: lock.key,
        ttl: lock.ttl,
        heldMs: lock.heldMs,
        error,
      });
    }
    if (firstError) {
      throw firstError.error;
    }
    return allReleased;
  }
}
