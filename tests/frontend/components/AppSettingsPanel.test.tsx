import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppSettingsPanel } from "@/components/AppSettingsModal";
import { ThemePreferenceProvider } from "@/hooks";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
  api.get("/api/preferences/theme", () => ({ theme: "system" }));
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  api.put("/api/preferences/theme", () => ({ success: true, theme: "dark" }));
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
});
