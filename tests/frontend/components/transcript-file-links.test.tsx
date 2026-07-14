import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { routeToHash } from "@pablozaiden/webapp/web";
import { render, waitFor } from "../helpers/render";
import { TranscriptTextContent } from "../../../src/components/log-viewer/transcript-file-links";
import type { TranscriptFileLinkContext, TranscriptFileLinkTarget } from "../../../src/components/log-viewer/types";

const originalFetch = globalThis.fetch;

function createFileLinkContext(openFile = mock((_target: TranscriptFileLinkTarget) => {})): TranscriptFileLinkContext {
  return {
    fileExplorerTarget: {
      type: "workspace",
      id: "workspace-1",
      startDirectory: "/workspace/project",
    },
    rootDirectory: "/workspace/project",
    getFileHref: ({ path, startDirectory }: TranscriptFileLinkTarget) => routeToHash({
      view: "code-explorer",
      contentType: "workspace",
      workspaceId: "workspace-1",
      startDirectory,
      filePath: path,
    }),
    openFile,
    onFileOpenError: mock((_message: string) => {}),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TranscriptTextContent file links", () => {
  const sessionArtifactDirectory = "/root/.copilot/session-state/0bd94aa8-002a-484f-acda-f9bf2bce67c0/files/preview-e2e-screenshots";

  test("renders candidate paths as links without metadata requests", async () => {
    const fetchMock = mock(async () => {
      throw new Error("metadata should not be requested during render");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(createElement(TranscriptTextContent, {
      content: "`src/index.ts` `README.md` `not a link`",
      className: "text-sm",
      fileLinkContext: createFileLinkContext(),
    }));

    expect(document.querySelectorAll("a[data-file-link-path]").length).toBe(2);
    expect(document.querySelector("[data-file-link-path='src/index.ts']")).not.toBeNull();
    expect(document.querySelector("[data-file-link-path='README.md']")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("renders plain absolute session artifact directory paths as links", () => {
    render(createElement(TranscriptTextContent, {
      content: `Screenshots: ${sessionArtifactDirectory}`,
      className: "text-sm",
      fileLinkContext: createFileLinkContext(),
    }));

    const link = document.querySelector(`[data-file-link-path='${sessionArtifactDirectory}']`);
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(sessionArtifactDirectory);
  });

  test("keeps trailing punctuation outside plain absolute path links", () => {
    render(createElement(TranscriptTextContent, {
      content: `Open (${sessionArtifactDirectory}).`,
      className: "text-sm",
      fileLinkContext: createFileLinkContext(),
    }));

    const link = document.querySelector(`[data-file-link-path='${sessionArtifactDirectory}']`);
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(sessionArtifactDirectory);
    expect(document.body.textContent).toContain(`(${sessionArtifactDirectory}).`);
  });

  test("validates only the clicked path before opening it", async () => {
    const openFile = mock((_target: TranscriptFileLinkTarget) => {});
    const fetchMock = mock(async (input: string | URL | Request) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(requestUrl, window.location.href);

      expect(url.pathname).toBe("/api/workspaces/workspace-1/files/metadata");
      expect(url.searchParams.get("path")).toBe("src/index.ts");
      expect(url.searchParams.get("startDirectory")).toBe("/workspace/project");

      return new Response(JSON.stringify({
        file: {
          kind: "file",
          path: "src/index.ts",
        },
      }), { status: 200 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(createElement(TranscriptTextContent, {
      content: "`src/index.ts` `README.md`",
      className: "text-sm",
      fileLinkContext: createFileLinkContext(openFile),
    }));

    const link = document.querySelector("[data-file-link-path='src/index.ts']");
    expect(link).not.toBeNull();
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await waitFor(() => {
      expect(openFile).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith({
      kind: "file",
      path: "src/index.ts",
      startDirectory: "/workspace/project",
    });
  });

  test("validates and opens directory paths by navigating to the directory root", async () => {
    const openFile = mock((_target: TranscriptFileLinkTarget) => {});
    const fetchMock = mock(async (input: string | URL | Request) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(requestUrl, window.location.href);

      expect(url.pathname).toBe("/api/workspaces/workspace-1/files/metadata");
      expect(url.searchParams.get("path")).toBe(".");
      expect(url.searchParams.get("startDirectory")).toBe(sessionArtifactDirectory);

      return new Response(JSON.stringify({
        file: {
          kind: "directory",
          path: "",
          absolutePath: sessionArtifactDirectory,
        },
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(createElement(TranscriptTextContent, {
      content: sessionArtifactDirectory,
      className: "text-sm",
      fileLinkContext: createFileLinkContext(openFile),
    }));

    const link = document.querySelector(`[data-file-link-path='${sessionArtifactDirectory}']`);
    expect(link).not.toBeNull();
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await waitFor(() => {
      expect(openFile).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith({
      kind: "directory",
      path: ".",
      startDirectory: sessionArtifactDirectory,
    });
  });

  test("preserves browser default behavior for modified primary clicks", async () => {
    const openFile = mock((_target: TranscriptFileLinkTarget) => {});
    const fetchMock = mock(async () => {
      throw new Error("metadata should not be requested for modified clicks");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(createElement(TranscriptTextContent, {
      content: "`src/index.ts`",
      className: "text-sm",
      fileLinkContext: createFileLinkContext(openFile),
    }));

    const link = document.querySelector("[data-file-link-path='src/index.ts']");
    expect(link).not.toBeNull();
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    link!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(openFile).toHaveBeenCalledTimes(0);
  });
});
