import { describe, expect, it } from "vitest";
import {
  isPositiveInteger,
  isObject,
  validateTtl,
  validateKey,
  validateAdapter,
  validateRetrySettings,
  validateUniqueValue,
} from "../utils/validators";
import { ValidationError } from "../errors";

describe("Validators", () => {
  describe("isPositiveInteger", () => {
    it("should reject 0", () => {
      expect(isPositiveInteger(0)).toBe(false);
    });
    it("should reject negative numbers", () => {
      expect(isPositiveInteger(-1)).toBe(false);
      expect(isPositiveInteger(-100)).toBe(false);
    });
    it("should reject NaN", () => {
      expect(isPositiveInteger(NaN)).toBe(false);
    });
    it("should reject Infinity", () => {
      expect(isPositiveInteger(Infinity)).toBe(false);
      expect(isPositiveInteger(-Infinity)).toBe(false);
    });
    it("should reject strings", () => {
      expect(isPositiveInteger("1")).toBe(false);
    });
    it("should reject floats", () => {
      expect(isPositiveInteger(1.5)).toBe(false);
    });
    it("should accept positive integers", () => {
      expect(isPositiveInteger(1)).toBe(true);
      expect(isPositiveInteger(100)).toBe(true);
    });
  });

  describe("isObject", () => {
    it("should reject null", () => {
      expect(isObject(null)).toBe(false);
    });
    it("should reject undefined", () => {
      expect(isObject(undefined)).toBe(false);
    });
    it("should reject strings", () => {
      expect(isObject("hello")).toBe(false);
    });
    it("should accept plain objects", () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ a: 1 })).toBe(true);
    });
  });

  describe("validateTtl", () => {
    it("should reject 0", () => {
      expect(() => validateTtl(0)).toThrow(ValidationError);
    });
    it("should reject -1", () => {
      expect(() => validateTtl(-1)).toThrow(ValidationError);
    });
    it("should reject NaN", () => {
      expect(() => validateTtl(NaN)).toThrow(ValidationError);
    });
    it("should reject Infinity", () => {
      expect(() => validateTtl(Infinity)).toThrow(ValidationError);
    });
    it("should reject floats", () => {
      expect(() => validateTtl(1.5)).toThrow(ValidationError);
    });
    it("should reject strings", () => {
      expect(() => validateTtl("100")).toThrow(ValidationError);
    });
    it("should accept valid positive integers", () => {
      expect(() => validateTtl(1)).not.toThrow();
      expect(() => validateTtl(1000)).not.toThrow();
    });
  });

  describe("validateKey", () => {
    it("should reject empty string", () => {
      expect(() => validateKey("")).toThrow(ValidationError);
    });
    it("should reject null", () => {
      expect(() => validateKey(null)).toThrow(ValidationError);
    });
    it("should reject undefined", () => {
      expect(() => validateKey(undefined)).toThrow(ValidationError);
    });
    it("should reject numbers", () => {
      expect(() => validateKey(123 as any)).toThrow(ValidationError);
    });
    it("should accept valid strings", () => {
      expect(() => validateKey("my-key")).not.toThrow();
    });
    it("should have correct error message mentioning Key", () => {
      expect(() => validateKey("")).toThrow(/Key/);
    });
  });

  describe("validateAdapter", () => {
    it("should reject null", () => {
      expect(() => validateAdapter(null)).toThrow(ValidationError);
    });
    it("should reject undefined", () => {
      expect(() => validateAdapter(undefined)).toThrow(ValidationError);
    });
    it("should reject empty object", () => {
      expect(() => validateAdapter({})).toThrow(ValidationError);
    });
    it("should reject adapter missing isValidLock", () => {
      expect(() =>
        validateAdapter({
          createLock: () => {},
          releaseLock: () => {},
          extendLock: () => {},
        })
      ).toThrow(ValidationError);
    });
    it("should accept valid adapter with all four methods", () => {
      expect(() =>
        validateAdapter({
          createLock: () => {},
          releaseLock: () => {},
          extendLock: () => {},
          isValidLock: () => {},
        })
      ).not.toThrow();
    });
  });

  describe("validateRetrySettings", () => {
    it("should reject null", () => {
      expect(() => validateRetrySettings(null as any)).toThrow(ValidationError);
    });
    it("should reject undefined", () => {
      expect(() => validateRetrySettings(undefined as any)).toThrow(
        ValidationError
      );
    });
  });

  describe("validateUniqueValue", () => {
    it("should reject empty string", () => {
      expect(() => validateUniqueValue("")).toThrow(ValidationError);
    });
    it("should reject null", () => {
      expect(() => validateUniqueValue(null)).toThrow(ValidationError);
    });
    it("should reject undefined", () => {
      expect(() => validateUniqueValue(undefined)).toThrow(ValidationError);
    });
    it("should accept valid strings", () => {
      expect(() => validateUniqueValue("abc123")).not.toThrow();
    });
  });
});
