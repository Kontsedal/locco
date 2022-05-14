class CustomError extends Error {
  public name: string;

  constructor(description: string, name = "ERROR") {
    super(description);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = name;
    Error.captureStackTrace(this);
  }
}

export class LockCreateError extends CustomError {
  constructor(description = "") {
    super(description, "LockCreateError");
  }
}

export class LockReleaseError extends CustomError {
  constructor(description = "") {
    super(description, "LockReleaseError");
  }
}

export class LockExtendError extends CustomError {
  constructor(description = "") {
    super(description, "LockExtendError");
  }
}

export class RetryError extends CustomError {
  constructor(description = "") {
    super(description, "RetryError");
  }
}
