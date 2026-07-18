import { afterEach, describe, expect, mock, test } from "bun:test";
import { readClipboardContent } from "../../src/utils/clipboard";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

afterEach(() => {
  if (originalClipboardDescriptor === undefined) {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
    return;
  }
  Object.defineProperty(globalThis.navigator, "clipboard", originalClipboardDescriptor);
});

function installClipboard(clipboard: Clipboard): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
}

describe("browser clipboard helper", () => {
  test("matches text MIME types case-insensitively and passes the exact type to getType", async () => {
    const matchedType = "Text/Plain; charset=UTF-8";
    const getType = mock(async (type: string) => {
      expect(type).toBe(matchedType);
      return new Blob(["pasted text"], { type: matchedType });
    });
    installClipboard({
      read: mock(async () => [{
        types: [matchedType],
        getType,
      }]),
    } as unknown as Clipboard);

    const result = await readClipboardContent();

    expect(result).toEqual({ attachmentFiles: [], text: "pasted text" });
    expect(getType).toHaveBeenCalledWith(matchedType);
  });
});
