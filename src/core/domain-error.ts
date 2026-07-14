/**
 * Transport-neutral errors raised by Core operations.
 *
 * API handlers may map the stable code to an HTTP response, while Core keeps
 * business failures independent from request/response concerns.
 */

export interface DomainErrorOptions {
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}

export class DomainError<TCode extends string = string> extends Error {
  readonly code: TCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: TCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
