import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useWorkspaceModels } from "@/hooks/dashboard-data/use-workspace-models";
import { createMockApi } from "../helpers/mock-api";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

describe("useWorkspaceModels", () => {
  test("normalizes a persisted last-model response without a variant", async () => {
    api.get("/api/preferences/last-model", () => ({
      providerID: "copilot",
      modelID: "gpt-5.4",
    }));
    api.get("/api/preferences/last-cheap-model", () => null);

    const { result } = renderHook(() => useWorkspaceModels());

    await waitFor(() => {
      expect(result.current.lastModel).toEqual({
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "",
      });
    });
  });
});
