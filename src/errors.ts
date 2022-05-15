export class LoccoError extends Error {
  public name: string;

  constructor(description: string, name = "LoccoError") {
    super(description);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = name;
    Error.captureStackTrace(this);
  }
}

export class LockCreateError extends LoccoError {
  constructor(description = "") {
    super(description, "LockCreateError");
  }
}

export class LockReleaseError extends LoccoError {
  constructor(description = "") {
    super(description, "LockReleaseError");
  }
}

export class LockExtendError extends LoccoError {
  constructor(description = "") {
    super(description, "LockExtendError");
  }
}

export class RetryError extends LoccoError {
  constructor(description = "") {
    super(description, "RetryError");
  }
}

export class ValidationError extends LoccoError {
  constructor(description = "") {
    super(description, "ValidationError");
  }
}
