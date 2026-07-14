export interface ApiErrorResponse {
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

export class ApiError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, options: { code?: string; status: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
  }
}

export function isApiErrorCode<TCode extends string>(
  error: unknown,
  code: TCode,
): error is ApiError & { code: TCode } {
  return error instanceof ApiError && error.code === code;
}

export async function parseApiError(response: Response, fallbackMessage: string): Promise<ApiError> {
  let data: ApiErrorResponse = {};
  try {
    data = await response.json() as ApiErrorResponse;
  } catch {
    // Use the fixed fallback when the server does not return a JSON error body.
  }

  const code = typeof data.code === "string"
    ? data.code
    : typeof data.error === "string"
      ? data.error
      : undefined;
  const message = typeof data.message === "string"
    ? data.message
    : typeof data.error === "string"
      ? data.error
      : fallbackMessage;

  return new ApiError(message, {
    code,
    status: response.status,
  });
}

export async function readApiError(response: Response): Promise<string> {
  return (await parseApiError(response, `Request failed with status ${String(response.status)}`)).message;
}
