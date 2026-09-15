import { describe, expect, it } from 'vitest';
import {
  LoccoError,
  LockHeldError,
  LockLostError,
  LockStateError,
  ValidationError,
} from '../errors';

describe('errors', () => {
  it('every class extends LoccoError and Error', () => {
    const errors = [
      new LockHeldError({ key: 'k', attempts: 3, elapsedMs: 10, reason: 'retries' }),
      new LockLostError({ key: 'k', reason: 'extend' }),
      new LockStateError('released'),
      new ValidationError('bad'),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(LoccoError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('carries a stable code and a class name', () => {
    expect(
      new LockHeldError({ key: 'k', attempts: 1, elapsedMs: 0, reason: 'timeout' }),
    ).toMatchObject({
      code: 'LOCK_HELD',
      name: 'LockHeldError',
      key: 'k',
      attempts: 1,
      reason: 'timeout',
    });
    expect(new LockLostError({ key: 'k', reason: 'expired' })).toMatchObject({
      code: 'LOCK_LOST',
      name: 'LockLostError',
      reason: 'expired',
      completed: false,
    });
    expect(new LockStateError('x').code).toBe('LOCK_STATE');
    expect(new ValidationError('x').code).toBe('LOCK_VALIDATION');
    expect(new LoccoError('x', { code: 'LOCK_MAX_HOLD' }).code).toBe('LOCK_MAX_HOLD');
  });

  it('keeps the cause and the callback result', () => {
    const cause = new Error('driver');
    const error = new LockLostError({
      key: 'k',
      reason: 'release',
      completed: true,
      result: 42,
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.result).toBe(42);
    expect(error.completed).toBe(true);
    expect(error.message).toContain('"k"');
  });

  it('names the spent budget in the LockHeldError message', () => {
    expect(
      new LockHeldError({ key: 'k', attempts: 4, elapsedMs: 900, reason: 'retries' }).message,
    ).toContain('retry budget');
    expect(
      new LockHeldError({ key: 'k', attempts: 4, elapsedMs: 900, reason: 'timeout' }).message,
    ).toContain('timeout');
  });
});
