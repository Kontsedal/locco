import { ValidationError } from "./errors";
import { RetrySettings } from "./utils/retry";

export function isPositiveInteger(value: unknown) {
  return typeof value === "number" && Math.floor(value) === value;
}

export function isUndefinedOrPositiveInteger(value: unknown) {
  return isUndefined(value) || isPositiveInteger(value);
}

export function isUndefinedOrFunction(value: unknown) {
  return isUndefined(value) || isFunction(value);
}
export function isFunction(value: unknown) {
  return typeof value === "function";
}
export function isUndefined(value: unknown) {
  return typeof value === "undefined";
}

export function validateRetrySettings(settings: RetrySettings) {
  const { retryDelayFn, retryDelay, retryTimes, totalTime } = settings;
  if (!isUndefinedOrPositiveInteger(retryDelay)) {
    throw new ValidationError("retryDelay should be an integer");
  }
  if (!isUndefinedOrPositiveInteger(retryTimes)) {
    throw new ValidationError("retryTimes should be an integer");
  }
  if (!isUndefinedOrPositiveInteger(totalTime)) {
    throw new ValidationError("totalTime should be an integer");
  }
  if (!isUndefinedOrFunction(retryDelayFn)) {
    throw new ValidationError("retryDelayFn should be a function");
  }
  if (isFunction(retryDelayFn) && isPositiveInteger(retryDelay)) {
    throw new ValidationError("Can't have both retryDelayFn and retryDelay");
  }
  if (
    isUndefined(retryDelayFn) &&
    (isUndefined(retryTimes) || isUndefined(retryDelay))
  ) {
    throw new ValidationError(
      "retryTimes and retryDelay should be specified if retryDelayFn is not provided"
    );
  }
}
