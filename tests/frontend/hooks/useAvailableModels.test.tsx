import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useAvailableModels } from "@/hooks";
import { makeModelKey } from "@/components/ModelSelector";
import type { ModelInfo } from "@/types";
import { render, waitFor } from "../helpers/render";
import { createMockApi } from "../helpers/mock-api";

const api = createMockApi();

const DEFAULT_MODELS: ModelInfo[] = [
  {
    providerID: "github",
    providerName: "GitHub",
    modelID: "gpt-5.4",
    modelName: "GPT-5.4",
    connected: true,
  },
  {
    providerID: "github",
    providerName: "GitHub",
    modelID: "gpt-5.5",
    modelName: "GPT-5.5",
    connected: true,
  },
];

function ModelsProbe({
  directory,
  workspaceId,
}: {
  directory: string | undefined;
  workspaceId: string | undefined;
}) {
  const { models, modelsLoading } = useAvailableModels({ directory, workspaceId });

  return (
    <div>
      <span data-testid="loading">{modelsLoading ? "true" : "false"}</span>
      <span data-testid="count">{String(models.length)}</span>
      {models.map((model) => (
        <span key={makeModelKey(model.providerID, model.modelID, model.variants?.[0] ?? "")}>
          {model.modelName}
        </span>
      ))}
    </div>
  );
}

beforeEach(() => {
  api.reset();
  api.install();
  api.get("/api/models", () => DEFAULT_MODELS);
});

afterEach(() => {
  api.uninstall();
});

describe("useAvailableModels", () => {
  test("clears stale models when a later fetch fails", async () => {
    const installedFetch = globalThis.fetch;
    const installedWindowFetch = window.fetch;
    let modelRequestCount = 0;

    const controlledFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

        if (url.includes("/api/models")) {
          modelRequestCount += 1;
          if (modelRequestCount === 2) {
            throw new Error("simulated network failure");
          }
        }

        return installedFetch(input, init);
      },
      {
        preconnect: installedFetch.preconnect,
      },
    ) satisfies typeof globalThis.fetch;

    globalThis.fetch = controlledFetch;
    window.fetch = controlledFetch;

    try {
      const { getByTestId, queryByText, rerender } = render(
        <ModelsProbe directory="/workspace/repo-a" workspaceId="workspace-1" />,
      );

      await waitFor(() => {
        expect(getByTestId("count").textContent).toBe("2");
      });

      rerender(<ModelsProbe directory="/workspace/repo-b" workspaceId="workspace-2" />);

      await waitFor(() => {
        expect(getByTestId("loading").textContent).toBe("false");
        expect(getByTestId("count").textContent).toBe("0");
      });

      expect(queryByText("GPT-5.4")).toBeNull();
      expect(queryByText("GPT-5.5")).toBeNull();
    } finally {
      globalThis.fetch = installedFetch;
      window.fetch = installedWindowFetch;
    }
  });
});
