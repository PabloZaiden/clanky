import { afterEach, beforeEach, mock } from "bun:test";
import { fireEvent } from "@testing-library/react";

interface CreateTestFileOptions {
  name?: string;
  type?: string;
  size?: number;
}

export function installImageAttachmentMocks() {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalFileReader = globalThis.FileReader;

  const createObjectURL = mock((file: Blob) => {
    const filename = file instanceof File ? file.name : "attachment";
    return `blob:mock:${filename}`;
  });
  const revokeObjectURL = mock((_url: string) => {});

  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(file: Blob) {
      this.result = `data:${file.type || "application/octet-stream"};base64,dGVzdA==`;
      queueMicrotask(() => {
        const loadEvent = new Event("load") as ProgressEvent<FileReader>;
        this.onload?.call(this as unknown as FileReader, loadEvent);
      });
    }
  }

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.FileReader = originalFileReader;
  });

  return {
    createObjectURL,
    revokeObjectURL,
  };
}

export function createTestFile(options?: CreateTestFileOptions): File {
  const {
    name = "clipboard-image.png",
    type = "image/png",
    size = 4,
  } = options ?? {};

  return new File([new Uint8Array(size)], name, { type });
}

export function pasteFiles(element: HTMLElement, files: File[]) {
  const items = files.map((file) => ({
    kind: "file" as const,
    type: file.type,
    getAsFile: () => file,
  }));

  fireEvent.paste(element, {
    clipboardData: { items },
  });
}
