import { describe, expect, test } from "bun:test";

import {
  getComposerMinHeightClass,
  getComposerPaddingClass,
  getComposerRows,
} from "../../src/components/common/composer-rows";

describe("composer-rows", () => {
  test("uses a compact single-line size for empty and single-line values", () => {
    expect(getComposerRows("")).toBe(1);
    expect(getComposerRows("Hello")).toBe(1);
    expect(getComposerMinHeightClass(1)).toBe("min-h-9");
    expect(getComposerPaddingClass(1)).toBe("py-1.5");
  });

  test("switches to multiline sizing when the value contains a newline", () => {
    expect(getComposerRows("Hello\nWorld")).toBe(2);
    expect(getComposerRows("Hello\rWorld")).toBe(2);
    expect(getComposerMinHeightClass(2)).toBe("min-h-[58px]");
    expect(getComposerPaddingClass(2)).toBe("py-2");
  });
});
