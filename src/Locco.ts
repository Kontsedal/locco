import { ILockAdapter } from "./adapters";
import { RetrySettings } from "./utils/retry";
import { Lock } from "./Lock";

export class Locco {
  private adapter: ILockAdapter;
  private retrySettings: RetrySettings;

  constructor({
    adapter,
    retrySettings,
  }: {
    adapter: ILockAdapter;
    retrySettings?: RetrySettings;
  }) {
    if (!adapter) {
      throw new Error("Locco:::constructor Adapter is required");
    }
    this.adapter = adapter;
    this.retrySettings = { retryDelay: 300, retryTimes: 10, ...retrySettings };
  }

  lock(key: string, ttl: number) {
    if (!key || !ttl) {
      throw new Error("Locco:::lock Key and ttl are required");
    }
    return new Lock({
      adapter: this.adapter,
      key,
      ttl,
      retrySettings: this.retrySettings,
    });
  }
}
