import { describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "@pablozaiden/webapp/web";
import { requestApiResponse } from "../../src/lib/api-client";

const apiClientLog = createLogger("apiClient");
const testUrl = "https://example.test/api/resource";

describe("api client request failures", () => {
  test("does not log an intentional AbortError as a transport failure", async () => {
    const errorSpy = spyOn(apiClientLog, "error").mockImplementation(() => undefined);
    const fetchSpy = spyOn(globalThis, "fetch");
    const controller = new AbortController();
    const abortError = Object.assign(new Error("request cancelled"), { name: "AbortError" });
    controller.abort();
    fetchSpy.mockRejectedValue(abortError);

    try {
      await expect(requestApiResponse(testUrl, {
        signal: controller.signal,
        action: "Load resource",
      })).rejects.toBe(abortError);
      expect(fetchSpy).toHaveBeenCalledWith(testUrl, expect.objectContaining({
        signal: controller.signal,
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("keeps logging genuine pre-response failures", async () => {
    const errorSpy = spyOn(apiClientLog, "error").mockImplementation(() => undefined);
    const fetchSpy = spyOn(globalThis, "fetch");
    const networkError = new TypeError("network unavailable");
    fetchSpy.mockRejectedValue(networkError);

    try {
      await expect(requestApiResponse(testUrl, {
        action: "Load resource",
      })).rejects.toBe(networkError);
      expect(errorSpy).toHaveBeenCalledWith(
        "API request failed before receiving a response",
        {
          action: "Load resource",
          method: "GET",
          url: testUrl,
          error: "network unavailable",
        },
      );
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("does not suppress AbortError without an aborted request signal", async () => {
    const errorSpy = spyOn(apiClientLog, "error").mockImplementation(() => undefined);
    const fetchSpy = spyOn(globalThis, "fetch");
    const abortError = Object.assign(new Error("request cancelled"), { name: "AbortError" });
    fetchSpy.mockRejectedValue(abortError);

    try {
      await expect(requestApiResponse(testUrl)).rejects.toBe(abortError);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("preserves warning and error severity for rejected HTTP responses", async () => {
    const errorSpy = spyOn(apiClientLog, "error").mockImplementation(() => undefined);
    const warnSpy = spyOn(apiClientLog, "warn").mockImplementation(() => undefined);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "invalid_request" }, { status: 400 }),
    ).mockResolvedValueOnce(
      Response.json({ error: "server_failure" }, { status: 500 }),
    );

    try {
      await expect(requestApiResponse(testUrl)).rejects.toMatchObject({ status: 400 });
      await expect(requestApiResponse(testUrl)).rejects.toMatchObject({ status: 500 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
