export interface ApiErrorResponse {
  [key: string]: unknown;
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

export class ApiError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly data?: ApiErrorResponse;

  constructor(message: string, options: {
    code?: string;
    status: number;
    cause?: unknown;
    data?: ApiErrorResponse;
  }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.data = options.data;
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
  let parseCause: unknown;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as ApiErrorResponse;
    }
  } catch (error) {
    parseCause = error;
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
    cause: parseCause,
    data: Object.keys(data).length > 0 ? data : undefined,
  });
}

export async function readApiError(response: Response): Promise<string> {
  return (await parseApiError(response, `Request failed with status ${String(response.status)}`)).message;
}
