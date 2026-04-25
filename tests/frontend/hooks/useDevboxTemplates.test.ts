import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDevboxTemplates } from "@/hooks/useDevboxTemplates";

function createTemplateResponse(name: string): Response {
  return new Response(JSON.stringify([
    {
      name,
      description: `${name} template`,
      source: "built-in",
      base: "bookworm",
      image: `example/${name}:latest`,
      pinnedReference: `example/${name}:latest`,
      runtimeVersion: `${name} 1.0`,
      languages: [name],
      runnerCompatible: true,
    },
  ]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = fetch;
  window.fetch = fetch;
});

describe("useDevboxTemplates", () => {
  test("keeps only the latest server request results", async () => {
    const firstResponse = Promise.withResolvers<Response>();
    const secondResponse = Promise.withResolvers<Response>();
    const signals: Array<AbortSignal | undefined> = [];
    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = window.fetch;

    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal | undefined);
      requestCount += 1;
      return requestCount === 1 ? firstResponse.promise : secondResponse.promise;
    }) as unknown as typeof fetch;

    globalThis.fetch = fetchMock;
    window.fetch = fetchMock;

    try {
      const { result, rerender } = renderHook(
        ({ serverId }) => useDevboxTemplates({ serverId }),
        { initialProps: { serverId: "server-1" } },
      );

      await waitFor(() => {
        expect(requestCount).toBe(1);
      });

      rerender({ serverId: "server-2" });

      await waitFor(() => {
        expect(requestCount).toBe(2);
        expect(signals[0]?.aborted).toBe(true);
      });

      await act(async () => {
        secondResponse.resolve(createTemplateResponse("bun"));
        await secondResponse.promise;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.templates.map((template) => template.name)).toEqual(["bun"]);
        expect(result.current.templatesLoading).toBe(false);
      });

      await act(async () => {
        firstResponse.resolve(createTemplateResponse("python"));
        await firstResponse.promise;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.templates.map((template) => template.name)).toEqual(["bun"]);
        expect(result.current.templatesLoading).toBe(false);
      });
    } finally {
      globalThis.fetch = originalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  test("aborts the active request on unmount", async () => {
    const pendingResponse = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = window.fetch;

    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined;
      return pendingResponse.promise;
    }) as unknown as typeof fetch;

    globalThis.fetch = fetchMock;
    window.fetch = fetchMock;

    try {
      const { unmount } = renderHook(() => useDevboxTemplates({ serverId: "server-1" }));

      await waitFor(() => {
        expect(signal).toBeDefined();
      });

      unmount();

      expect(signal?.aborted).toBe(true);
    } finally {
      pendingResponse.resolve(createTemplateResponse("python"));
      globalThis.fetch = originalFetch;
      window.fetch = originalWindowFetch;
    }
  });
});
