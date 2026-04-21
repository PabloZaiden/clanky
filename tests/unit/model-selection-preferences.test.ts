import { describe, expect, mock, test } from "bun:test";
import { getStoredLoopModelPreference } from "../../src/lib/model-selection-preferences";

describe("model-selection-preferences", () => {
  test("returns null when storage access throws during getItem", () => {
    const storage = {
      getItem: mock((_key: string) => {
        throw new Error("storage denied");
      }),
      setItem: mock((_key: string, _value: string) => {}),
      removeItem: mock((_key: string) => {}),
    };

    expect(getStoredLoopModelPreference({ storage })).toBeNull();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  test("returns null when invalid stored data cannot be removed", () => {
    const storage = {
      getItem: mock((_key: string) => "{bad json"),
      setItem: mock((_key: string, _value: string) => {}),
      removeItem: mock((_key: string) => {
        throw new Error("storage denied");
      }),
    };

    expect(getStoredLoopModelPreference({ storage })).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });
});
