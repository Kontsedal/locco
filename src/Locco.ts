import { ILockAdapter } from "./adapters";
import { RetrySettings } from "./utils/retry";
import { Lock } from "./Lock";
import * as validators from "./validators";
import { LoccoError } from "./errors";

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
      throw new LoccoError("Locco:::constructor Adapter is required");
    }
    validators.validateRetrySettings(retrySettings);
    this.adapter = adapter;
    this.retrySettings = retrySettings;
  }

  lock(key: string, ttl: number) {
    if (!key || !ttl) {
      throw new LoccoError("Locco:::lock Key and ttl are required");
    }
    return new Lock({
      adapter: this.adapter,
      key,
      ttl,
      retrySettings: this.retrySettings,
    });
  }
}
