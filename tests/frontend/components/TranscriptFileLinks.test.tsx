import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamingTextContent } from "@/components/log-viewer/streaming-text-content";
import { looksLikeFileLinkCandidate, resetTranscriptFileLinkCache, type TranscriptFileLinkContext } from "@/components/LogViewer";
import { createMockApi } from "../helpers/mock-api";
import { act, renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

function createFileLinkContext(): TranscriptFileLinkContext & { openedPaths: string[] } {
  const openedPaths: string[] = [];
  return {
    fileExplorerTarget: {
      type: "workspace",
      id: "workspace-1",
      startDirectory: "/workspaces/demo",
    },
    rootDirectory: "/workspaces/demo",
    getFileHref: (path: string) => `#/code-explorer/chat/chat-1?filePath=${encodeURIComponent(path)}`,
    openFile: (path: string) => {
      openedPaths.push(path);
    },
    openedPaths,
  };
}

describe("transcript file links", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    resetTranscriptFileLinkCache();
  });

  afterEach(() => {
    api.uninstall();
    resetTranscriptFileLinkCache();
  });

  test("recognizes file-shaped inline code conservatively", () => {
    expect(looksLikeFileLinkCandidate("src/index.ts")).toBe(true);
    expect(looksLikeFileLinkCandidate("/workspaces/demo/src/index.ts")).toBe(true);
    expect(looksLikeFileLinkCandidate("package.json")).toBe(true);
    expect(looksLikeFileLinkCandidate("Dockerfile")).toBe(true);
    expect(looksLikeFileLinkCandidate("echo hi")).toBe(false);
    expect(looksLikeFileLinkCandidate("--watch")).toBe(false);
    expect(looksLikeFileLinkCandidate("done")).toBe(false);
  });

  test("upgrades only verified path-shaped inline code to links and reuses cached lookups", async () => {
    const fileLinkContext = createFileLinkContext();
    let resolveMetadata: ((value: unknown) => void) | null = null;

    api.get("/api/workspaces/:id/files/metadata", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path");
      expect(path).toBe("src/index.ts");
      return new Promise((resolve) => {
        resolveMetadata = resolve;
      });
    });

    const { getByText, queryByRole, rerender, user } = renderWithUser(
      <StreamingTextContent
        content={"Run `echo hi` and inspect `src/index.ts`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    expect(getByText("echo hi")).toBeInTheDocument();
    expect(getByText("src/index.ts")).toBeInTheDocument();
    expect(queryByRole("link", { name: "src/index.ts" })).toBeNull();

    await waitFor(() => {
      expect(api.calls("/api/workspaces/:id/files/metadata", "GET")).toHaveLength(1);
    });

    await act(async () => {
      resolveMetadata?.({
        workspaceId: "workspace-1",
        file: {
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 24,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "100:24",
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryByRole("link", { name: "src/index.ts" })).toBeInTheDocument();
    });

    expect(queryByRole("link", { name: "echo hi" })).toBeNull();

    rerender(
      <StreamingTextContent
        content={"Run `echo hi` and inspect `src/index.ts`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    await waitFor(() => {
      expect(queryByRole("link", { name: "src/index.ts" })).toBeInTheDocument();
    });

    expect(api.calls("/api/workspaces/:id/files/metadata", "GET")).toHaveLength(1);

    await user.click(queryByRole("link", { name: "src/index.ts" })!);
    expect(fileLinkContext.openedPaths).toEqual(["src/index.ts"]);
  });
});
