import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ThemePreferenceProvider, useThemePreference } from "@/hooks";
import { createMockApi } from "../helpers/mock-api";
import { act, renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

function createMatchMediaController(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  return {
    matchMedia: (query: string) =>
      ({
        get matches() {
          return matches;
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => false,
      }) as MediaQueryList,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

function ThemeProbe() {
  const { theme, resolvedTheme } = useThemePreference();
  return (
    <div>
      <span data-testid="theme-preference">{theme}</span>
      <span data-testid="resolved-theme">{resolvedTheme}</span>
    </div>
  );
}

beforeEach(() => {
  api.reset();
  api.install();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  delete document.documentElement.dataset["themePreference"];
  delete document.documentElement.dataset["themeResolved"];
});

afterEach(() => {
  api.uninstall();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  delete document.documentElement.dataset["themePreference"];
  delete document.documentElement.dataset["themeResolved"];
});

describe("ThemePreferenceProvider", () => {
  test("applies an explicit dark theme from the preference API", async () => {
    api.get("/api/preferences/theme", () => ({ theme: "dark" }));

    const { getByTestId } = renderWithUser(
      <ThemePreferenceProvider>
        <ThemeProbe />
      </ThemePreferenceProvider>,
    );

    await waitFor(() => {
      expect(getByTestId("theme-preference")).toHaveTextContent("dark");
      expect(getByTestId("resolved-theme")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe("dark");
      expect(document.documentElement.dataset["themePreference"]).toBe("dark");
      expect(document.documentElement.dataset["themeResolved"]).toBe("dark");
      expect(localStorage.getItem("ralpher.themePreference")).toBe("dark");
    });
  });

  test("reacts to system color scheme changes when the preference is system", async () => {
    api.get("/api/preferences/theme", () => ({ theme: "system" }));
    const originalMatchMedia = window.matchMedia;
    const controller = createMatchMediaController(false);
    window.matchMedia = controller.matchMedia;

    try {
      const { getByTestId } = renderWithUser(
        <ThemePreferenceProvider>
          <ThemeProbe />
        </ThemePreferenceProvider>,
      );

      await waitFor(() => {
        expect(getByTestId("resolved-theme")).toHaveTextContent("light");
        expect(document.documentElement.classList.contains("dark")).toBe(false);
        expect(document.documentElement.style.colorScheme).toBe("light");
      });

      await act(() => {
        controller.setMatches(true);
      });

      await waitFor(() => {
        expect(getByTestId("resolved-theme")).toHaveTextContent("dark");
        expect(document.documentElement.classList.contains("dark")).toBe(true);
        expect(document.documentElement.style.colorScheme).toBe("dark");
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
