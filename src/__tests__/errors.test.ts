import { describe, expect, it } from "vitest";
import {
  LoccoError,
  LockCreateError,
  LockReleaseError,
  LockExtendError,
  RetryError,
  ValidationError,
} from "../errors";

describe("Error hierarchy", () => {
  it("LockCreateError should be instanceof LoccoError", () => {
    const err = new LockCreateError("test");
    expect(err).toBeInstanceOf(LoccoError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LockCreateError");
  });
  it("LockReleaseError should be instanceof LoccoError", () => {
    const err = new LockReleaseError("test");
    expect(err).toBeInstanceOf(LoccoError);
    expect(err.name).toBe("LockReleaseError");
  });
  it("LockExtendError should be instanceof LoccoError", () => {
    const err = new LockExtendError("test");
    expect(err).toBeInstanceOf(LoccoError);
    expect(err.name).toBe("LockExtendError");
  });
  it("RetryError should be instanceof LoccoError", () => {
    const err = new RetryError("test");
    expect(err).toBeInstanceOf(LoccoError);
    expect(err.name).toBe("RetryError");
  });
  it("ValidationError should be instanceof LoccoError", () => {
    const err = new ValidationError("test");
    expect(err).toBeInstanceOf(LoccoError);
    expect(err.name).toBe("ValidationError");
  });
  it("LoccoError should have correct message", () => {
    const err = new LoccoError("something went wrong");
    expect(err.message).toBe("something went wrong");
    expect(err.name).toBe("LoccoError");
  });
});
