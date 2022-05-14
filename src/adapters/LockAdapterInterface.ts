export interface ILockAdapter {
  createLock: ({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) => Promise<void>;

  releaseLock: ({
    key,
    uniqueValue,
  }: {
    key: string;
    uniqueValue: string;
  }) => Promise<void>;

  extendLock: ({
    key,
    uniqueValue,
    ttl,
  }: {
    key: string;
    uniqueValue: string;
    ttl: number;
  }) => Promise<void>;
}
