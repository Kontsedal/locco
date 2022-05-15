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

export function isStringWithContents(value: unknown) {
  return typeof value === "string" && value.length > 0;
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

export function validateTtl(ttl: unknown) {
  if (!isPositiveInteger(ttl)) {
    throw new ValidationError("Ttl should be a positive integer");
  }
}
export function validateKey(key: unknown) {
  if (!isStringWithContents(key)) {
    throw new ValidationError(
      "Ttl should be a string with at least one character"
    );
  }
}
export function validateUniqueValue(uniqueValue: unknown) {
  if (!isStringWithContents(uniqueValue)) {
    throw new ValidationError(
      "uniqueValue should be a string with at least one character"
    );
  }
}