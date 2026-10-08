export type LockKeyParams = {
  key: string;
  token: string;
};

export type LockLeaseParams = LockKeyParams & {
  /** Lease length in milliseconds. */
  ttl: number;
};

/**
 * A backend answers `true` when the operation applied to our key and `false` when another
 * holder, or no holder, had it. It throws only what its driver throws. The core turns the
 * answers into errors and events, so an adapter never imports a locco error class.
 */
export interface LockAdapter {
  acquire(params: LockLeaseParams): Promise<boolean>;
  release(params: LockKeyParams): Promise<boolean>;
  extend(params: LockLeaseParams): Promise<boolean>;
  isHeld(params: LockKeyParams): Promise<boolean>;
  /**
   * Optional. Acquires like `acquire` and also takes a fencing token: a positive integer that is
   * larger for every later grant of the key. Answers the token, or null when another holder had
   * the key. `Locker` calls it instead of `acquire` when its `fencing` option is on.
   */
  acquireFenced?(params: LockLeaseParams): Promise<number | null>;
}
