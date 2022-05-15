import { ILockAdapter } from "./adapters";
import { RetrySettings } from "./utils/retry";
import { Lock } from "./lock";
import * as validators from "./utils/validators";
import { ValidationError } from "./errors";

export class Locco {
  private adapter: ILockAdapter;
  private retrySettings: RetrySettings;

  constructor({
    adapter,
    retrySettings,
  }: {
    adapter: ILockAdapter;
    retrySettings: RetrySettings;
  }) {
    if (!adapter) {
      throw new ValidationError("Adapter is required");
    }
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
