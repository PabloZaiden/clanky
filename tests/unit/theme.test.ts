import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THEME_PREFERENCE,
  getThemeSnapshot,
  isResolvedTheme,
  isThemePreference,
  resolveThemePreference,
  THEME_DARK_CLASS,
} from "../../src/lib/theme";

describe("theme utilities", () => {
  test("defaults to system preference", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
  });

  test("recognizes valid theme preferences", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
  });

  test("recognizes resolved themes", () => {
    expect(isResolvedTheme("light")).toBe(true);
    expect(isResolvedTheme("dark")).toBe(true);
    expect(isResolvedTheme("system")).toBe(false);
  });

  test("resolves system theme using the current media preference", () => {
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("system", true)).toBe("dark");
  });

  test("preserves explicit light and dark selections", () => {
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  test("builds a theme snapshot for document application", () => {
    expect(getThemeSnapshot("dark", false)).toEqual({
      preference: "dark",
      resolvedTheme: "dark",
      colorScheme: "dark",
      darkClass: THEME_DARK_CLASS,
      metaThemeColor: "#171717",
    });

    expect(getThemeSnapshot("system", false)).toEqual({
      preference: "system",
      resolvedTheme: "light",
      colorScheme: "light",
      darkClass: THEME_DARK_CLASS,
      metaThemeColor: "#f3f4f6",
    });
  });
});
