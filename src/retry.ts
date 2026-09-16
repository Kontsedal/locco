import type { DelayFn, ResolvedRetry, RetryOptions } from './types';
import { assertDuration } from './validate';

/** Frozen: `mergeRetry` reads it on every acquisition, so a mutation would change the default
 * policy for every Locker in the process. */
export const DEFAULT_RETRY: Readonly<ResolvedRetry> = Object.freeze({ retries: 10, delay: 200 });

/** Later layers win per field. A field that a layer leaves undefined keeps the earlier value. */
export function mergeRetry(...layers: Array<RetryOptions | undefined>): ResolvedRetry {
  const merged: ResolvedRetry = { ...DEFAULT_RETRY };
  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    if (layer.retries !== undefined) {
      merged.retries = layer.retries;
    }
    if (layer.delay !== undefined) {
      merged.delay = layer.delay;
    }
    if (layer.timeout !== undefined) {
      merged.timeout = layer.timeout;
    }
  }
  return merged;
}

export type BackoffOptions = {
  /** Delay before the first retry in milliseconds. Default 100. */
  base?: number;
  /** Largest delay in milliseconds. Default 5000. */
  max?: number;
  /** Randomize the upper half of each delay. Default true. */
  jitter?: boolean;
};

export function exponentialBackoff(options: BackoffOptions = {}): DelayFn {
  const { base = 100, max = 5000, jitter = true } = options;
  assertDuration(base, 'base');
  assertDuration(max, 'max');
  return ({ attempt }) => {
    const full = Math.min(max, base * 2 ** attempt);
    if (!jitter) {
      return full;
    }
    // Equal jitter keeps half of the delay, so retries spread out and no retry collapses to 0.
    return Math.floor(full / 2 + Math.random() * (full / 2));
  };
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
