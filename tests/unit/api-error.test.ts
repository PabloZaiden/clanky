import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ApiError, isApiErrorCode, parseApiError } from "../../src/lib/api-error";
import { apiClientFetch, apiRequest, requestApiResponse } from "../../src/lib/api-client";

let apiClientFetchSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  apiClientFetchSpy?.mockRestore();
  apiClientFetchSpy = null;
});

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

describe("apiRequest", () => {
  test("decodes JSON, text, blob, and empty responses", async () => {
    const responses = [
      Response.json({ value: 42 }),
      new Response("transcript"),
      new Response("image", { headers: { "Content-Type": "image/png" } }),
      new Response(null, { status: 204 }),
    ];
    apiClientFetchSpy = spyOn(apiClientFetch, "fetch").mockImplementation(async () => responses.shift()!);

    await expect(apiRequest<{ value: number }>("/json")).resolves.toEqual({ value: 42 });
    await expect(apiRequest("/text", { responseType: "text" })).resolves.toBe("transcript");
    const blob = await apiRequest("/blob", { responseType: "blob" });
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("image");
    await expect(apiRequest("/empty", { responseType: "empty" })).resolves.toBeUndefined();
  });

  test("preserves typed API failure metadata and parsing causes", async () => {
    apiClientFetchSpy = spyOn(apiClientFetch, "fetch").mockResolvedValue(
      new Response("not JSON", { status: 502 }),
    );

    const request = apiRequest("/failure", {
      action: "Load failure fixture",
      fallbackMessage: "The fixture failed",
    });
    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: "The fixture failed",
    });
    try {
      await request;
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  test("preserves API error codes and response data", async () => {
    apiClientFetchSpy = spyOn(apiClientFetch, "fetch").mockResolvedValue(
      Response.json(
        {
          error: "file_conflict",
          message: "The file changed on the server",
          currentFile: null,
        },
        { status: 409 },
      ),
    );

    await expect(apiRequest("/conflict")).rejects.toMatchObject({
      name: "ApiError",
      code: "file_conflict",
      status: 409,
      data: {
        error: "file_conflict",
        currentFile: null,
      },
    });
  });

  test("accepts conditional statuses without consuming the response body", async () => {
    const response = new Response("unchanged", { status: 304 });
    apiClientFetchSpy = spyOn(apiClientFetch, "fetch").mockResolvedValue(response);

    await expect(requestApiResponse("/snapshot", { acceptedStatuses: [304] })).resolves.toBe(response);
    expect(await response.text()).toBe("unchanged");
  });

  test("propagates transport failures unchanged", async () => {
    const transportError = new TypeError("network unavailable");
    apiClientFetchSpy = spyOn(apiClientFetch, "fetch").mockRejectedValue(transportError);

    await expect(apiRequest("/network")).rejects.toBe(transportError);
  });
});
