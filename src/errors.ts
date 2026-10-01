export type LoccoErrorCode = 'LOCK_HELD' | 'LOCK_LOST' | 'LOCK_STATE' | 'LOCK_VALIDATION';

export class LoccoError extends Error {
  readonly code: LoccoErrorCode;

  constructor(message: string, options: { code: LoccoErrorCode; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LoccoError';
    this.code = options.code;
  }
}

export type LockHeldReason = 'retries' | 'timeout' | 'expired' | 'late-acquire';

const HELD_MESSAGES: Record<LockHeldReason, string> = {
  retries: 'the retry budget ran out',
  timeout: 'the timeout ran out',
  expired: "an earlier key's lease ran out before the whole set was acquired",
  'late-acquire':
    'the backend granted the key but answered after the lease could have ended, so the key was given back',
};

export class LockHeldError extends LoccoError {
  readonly key: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly reason: LockHeldReason;

  constructor(params: {
    key: string;
    attempts: number;
    elapsedMs: number;
    reason: LockHeldReason;
  }) {
    super(
      `Lock "${params.key}" could not be acquired: ${HELD_MESSAGES[params.reason]} after ${params.attempts} attempt(s) in ${params.elapsedMs} ms.`,
      { code: 'LOCK_HELD' },
    );
    this.name = 'LockHeldError';
    this.key = params.key;
    this.attempts = params.attempts;
    this.elapsedMs = params.elapsedMs;
    this.reason = params.reason;
  }
}

export type LockLostReason =
  | 'release'
  | 'extend'
  | 'extend-failed'
  | 'late-extend'
  | 'expired'
  | 'max-hold'
  | 'observed';

const LOSS_MESSAGES: Record<LockLostReason, string> = {
  release: 'the key was gone or belonged to another holder at release',
  extend: 'the key was gone or belonged to another holder at extend',
  // The requests never got an answer, so the lease may well still be ours on the backend. Saying
  // the key was taken would send an operator hunting a double acquisition that never happened.
  'extend-failed': 'the lease ran out while extend requests were failing. See `cause`',
  'late-extend': 'the lease ran out while an extend request was still waiting for its answer',
  expired: 'the lease ran out before an extension refreshed it',
  'max-hold': 'the hold deadline passed',
  observed: 'a check found the key gone or owned by another holder',
};

export class LockLostError extends LoccoError {
  readonly key: string;
  readonly reason: LockLostReason;
  readonly completed: boolean;
  readonly result: unknown;

  constructor(params: {
    key: string;
    reason: LockLostReason;
    completed?: boolean;
    result?: unknown;
    cause?: unknown;
  }) {
    super(`Lock "${params.key}" was lost: ${LOSS_MESSAGES[params.reason]}.`, {
      code: 'LOCK_LOST',
      cause: params.cause,
    });
    this.name = 'LockLostError';
    this.key = params.key;
    this.reason = params.reason;
    this.completed = params.completed ?? false;
    this.result = params.result;
  }
}

export class LockStateError extends LoccoError {
  constructor(message: string) {
    super(message, { code: 'LOCK_STATE' });
    this.name = 'LockStateError';
  }
}

export class ValidationError extends LoccoError {
  constructor(message: string) {
    super(message, { code: 'LOCK_VALIDATION' });
    this.name = 'ValidationError';
  }
}
