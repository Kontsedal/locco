import { RetrySettings } from "./retry.js";
import { ValidationError } from "../errors.js";

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Math.floor(value) === value;
}

export function isUndefinedOrPositiveInteger(
  value: unknown
): value is number | undefined {
  return isUndefined(value) || isPositiveInteger(value);
}

export function isUndefinedOrFunction(
  value: unknown
): value is undefined | Function {
  return isUndefined(value) || isFunction(value);
}
export function isFunction(value: unknown): value is Function {
  return typeof value === "function";
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object";
}
export function isUndefined(value: unknown): value is undefined {
  return typeof value === "undefined";
}

export type MongoError = {
  code: number;
};
export function isMongoError(value: unknown): value is MongoError {
  return value instanceof Error && "code" in value;
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

export function validateAdapter(adapter: unknown) {
  if (!isObject(adapter)) {
    throw new ValidationError("Adapter is required");
  }
  if (
    !isFunction(adapter.createLock) ||
    !isFunction(adapter.releaseLock) ||
    !isFunction(adapter.extendLock)
  ) {
    throw new ValidationError("Adapter is invalid");
  }
}
