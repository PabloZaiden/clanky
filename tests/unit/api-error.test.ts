import { describe, expect, test } from "bun:test";
import { ApiError, isApiErrorCode, parseApiError } from "../../src/lib/api-error";

describe("ApiError", () => {
  test("preserves the public code, message, and status", async () => {
    const error = await parseApiError(
      Response.json(
        {
          error: "invalid_credential_token",
          message: "SSH credential token is missing or expired",
        },
        { status: 400 },
      ),
      "Request failed",
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("invalid_credential_token");
    expect(error.message).toBe("SSH credential token is missing or expired");
    expect(error.status).toBe(400);
    expect(isApiErrorCode(error, "invalid_credential_token")).toBe(true);
  });

  test("uses a fixed fallback for a non-JSON error response", async () => {
    const error = await parseApiError(
      new Response("internal details", { status: 500 }),
      "Request failed",
    );

    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Request failed");
    expect(error.status).toBe(500);
  });
});
