import * as validators from "./utils/validators.js";
import { Lock } from "./lock.js";
import { ILockAdapter } from "./adapters/lockAdapterInterface.js";
import { RetrySettings } from "./utils/retry.js";

export class Locker {
  private adapter: ILockAdapter;
  private retrySettings: RetrySettings;

  constructor({
    adapter,
    retrySettings,
  }: {
    adapter: ILockAdapter;
    retrySettings: RetrySettings;
  }) {
    validators.validateAdapter(adapter);
    validators.validateRetrySettings(retrySettings);
    this.adapter = adapter;
    this.retrySettings = retrySettings;
  }

  lock(key: string, ttl: number) {
    validators.validateTtl(ttl);
    validators.validateKey(key);
    return new Lock({
      adapter: this.adapter,
      key,
      ttl,
      retrySettings: this.retrySettings,
    });
  }
}
