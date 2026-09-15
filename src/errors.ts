export type LoccoErrorCode =
  | 'LOCK_HELD'
  | 'LOCK_LOST'
  | 'LOCK_STATE'
  | 'LOCK_MAX_HOLD'
  | 'LOCK_VALIDATION';

export class LoccoError extends Error {
  readonly code: LoccoErrorCode;

  constructor(message: string, options: { code: LoccoErrorCode; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LoccoError';
    this.code = options.code;
  }
}

export type LockHeldReason = 'retries' | 'timeout';

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
    const budget = params.reason === 'timeout' ? 'the timeout' : 'the retry budget';
    super(
      `Lock "${params.key}" is held by another holder. ${budget} ran out after ${params.attempts} attempt(s) in ${params.elapsedMs} ms.`,
      { code: 'LOCK_HELD' },
    );
    this.name = 'LockHeldError';
    this.key = params.key;
    this.attempts = params.attempts;
    this.elapsedMs = params.elapsedMs;
    this.reason = params.reason;
  }
}

export type LockLostReason = 'release' | 'extend' | 'late-extend' | 'expired' | 'max-hold';

const LOSS_MESSAGES: Record<LockLostReason, string> = {
  release: 'the key was gone or belonged to another holder at release',
  extend: 'the key was gone or belonged to another holder at extend',
  'late-extend': 'the extend answer arrived after the new lease had already run out',
  expired: 'the lease ran out before an extension refreshed it',
  'max-hold': 'the hold deadline passed',
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
