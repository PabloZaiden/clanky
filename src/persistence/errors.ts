import { SQLiteError } from "bun:sqlite";
import { DomainError, type DomainErrorOptions } from "../core/domain-error";

export type PersistenceErrorCode =
  | "database_not_initialized"
  | "unique_constraint"
  | "persistence_failed";

export class PersistenceError<
  TCode extends PersistenceErrorCode = PersistenceErrorCode,
> extends DomainError<TCode> {
  constructor(
    code: TCode,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "PersistenceError";
  }
}

export class DatabaseNotInitializedError extends PersistenceError<"database_not_initialized"> {
  constructor() {
    super(
      "database_not_initialized",
      "Database not initialized. Call initializeDatabase() first.",
    );
    this.name = "DatabaseNotInitializedError";
  }
}

export function isSqliteUniqueConstraintError(
  error: unknown,
): error is SQLiteError {
  return error instanceof SQLiteError
    && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

export function uniqueConstraintError(
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause: unknown,
): PersistenceError<"unique_constraint"> {
  return new PersistenceError("unique_constraint", message, {
    cause,
    details,
  });
}

export function isUniqueConstraint(
  error: unknown,
  table: string,
  constraint: string,
): error is PersistenceError<"unique_constraint"> {
  return error instanceof PersistenceError
    && error.code === "unique_constraint"
    && error.details["table"] === table
    && error.details["constraint"] === constraint;
}

export function isPersistenceError(
  error: unknown,
): error is PersistenceError {
  return error instanceof PersistenceError;
}
