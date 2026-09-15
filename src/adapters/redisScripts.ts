import { createHash } from 'node:crypto';

/** Deletes the key only while it still carries our token. Answers 1 or 0. */
export const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Sets a new lease only while the key still carries our token. Answers 1 or 0. */
export const EXTEND_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export const RELEASE_SHA = sha1(RELEASE_SCRIPT);
export const EXTEND_SHA = sha1(EXTEND_SCRIPT);

function sha1(script: string): string {
  return createHash('sha1').update(script).digest('hex');
}

/** Redis answers NOSCRIPT when the script cache does not hold the sha, for example after a restart. */
export function isNoScriptError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.includes('NOSCRIPT')
  );
}
