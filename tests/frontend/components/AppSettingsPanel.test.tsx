import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { AppSettingsPanel } from "@/components/AppSettingsModal";
import { ThemePreferenceProvider } from "@/hooks";
import type { QuickChatSettings } from "@/types/preferences";
import { createWorkspace } from "../helpers/factories";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
  api.get("/api/preferences/theme", () => ({ theme: "system" }));
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  api.put("/api/preferences/theme", () => ({ success: true, theme: "dark" }));
  api.get("/api/models", () => [
    {
      providerID: "copilot",
      providerName: "Copilot",
      modelID: "gpt-5.5",
      modelName: "GPT-5.5",
      connected: true,
      variants: [""],
    },
  ]);
});

afterEach(() => {
  api.uninstall();
});

describe("AppSettingsPanel", () => {
  test("loads and saves theme preference from Display Settings", async () => {
    const { getByLabelText, getByText, user } = renderWithUser(
      <ThemePreferenceProvider>
        <AppSettingsPanel />
      </ThemePreferenceProvider>,
    );

    const themeSelect = await waitFor(() => getByLabelText("Theme")) as HTMLSelectElement;
    expect(themeSelect.value).toBe("system");
    expect(getByText("Match your browser or operating system color scheme.")).toBeInTheDocument();
    expect(getByText("Render Markdown")).toBeInTheDocument();

    await user.selectOptions(themeSelect, "dark");

    await waitFor(() => {
      expect(themeSelect.value).toBe("dark");
      expect(getByText("Always use the dark theme.")).toBeInTheDocument();
    });

    const themeCalls = api.calls("/api/preferences/theme", "PUT");
    expect(themeCalls).toHaveLength(1);
    expect(themeCalls[0]?.body).toEqual({ theme: "dark" });
  });

  test("updates quick chat workspace and model settings", async () => {
    const updates: QuickChatSettings[] = [];
    function Harness() {
      const [settings, setSettings] = useState<QuickChatSettings>({
        workspaceId: "",
        model: null,
      });
      return (
        <ThemePreferenceProvider>
          <AppSettingsPanel
            workspaces={[
              createWorkspace({
                id: "workspace-quick",
                name: "Quick Workspace",
                directory: "/workspaces/quick",
              }),
            ]}
            quickChatSettings={settings}
            onUpdateQuickChatSettings={async (nextSettings) => {
              updates.push(nextSettings);
              setSettings(nextSettings);
              return nextSettings;
            }}
          />
        </ThemePreferenceProvider>
      );
    }

    const { getByLabelText, user } = renderWithUser(<Harness />);

    await user.selectOptions(await waitFor(() => getByLabelText("Workspace")), "workspace-quick");
    await waitFor(() => {
      expect(updates.at(-1)).toEqual({
        workspaceId: "workspace-quick",
        model: null,
      });
    });

    const modelSelect = await waitFor(() => getByLabelText("Model")) as HTMLSelectElement;
    await user.selectOptions(modelSelect, "copilot:gpt-5.5:");

    await waitFor(() => {
      expect(updates.at(-1)).toEqual({
        workspaceId: "workspace-quick",
        model: {
          providerID: "copilot",
          modelID: "gpt-5.5",
          variant: "",
        },
      });
    });
  });

  test("confirms global terminal-state purge and reports the result", async () => {
    const purgeCalls: string[] = [];
    const { getByText, user } = renderWithUser(
      <ThemePreferenceProvider>
        <AppSettingsPanel
          onPurgeTerminalTasks={async () => {
            purgeCalls.push("purged");
            return {
              success: true,
              totalWorkspaces: 2,
              totalArchived: 3,
              purgedCount: 2,
              purgedTaskIds: ["task-1", "task-2"],
              failures: [{ workspaceId: "ws-2", taskId: "task-3", error: "permission denied" }],
              workspaces: [],
            };
          }}
        />
      </ThemePreferenceProvider>,
    );

    await user.click(getByText("Danger Zone"));
    await user.click(getByText("Purge terminal-state tasks"));
    await user.click(getByText("Yes, purge tasks"));

    await waitFor(() => {
      expect(purgeCalls).toEqual(["purged"]);
      expect(getByText("Purged 2 of 3 terminal-state tasks across 2 workspaces.")).toBeInTheDocument();
      expect(getByText("Failed task IDs: task-3")).toBeInTheDocument();
    });
  });
});
