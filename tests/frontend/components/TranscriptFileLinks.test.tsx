import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { StreamingTextContent } from "@/components/log-viewer/streaming-text-content";
import { looksLikeFileLinkCandidate, resetTranscriptFileLinkCache, type TranscriptFileLinkContext } from "@/components/LogViewer";
import { createMockApi } from "../helpers/mock-api";
import { act, renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

function createFileLinkContext(): TranscriptFileLinkContext & {
  openedTargets: Array<{ path: string; startDirectory: string }>;
} {
  const openedTargets: Array<{ path: string; startDirectory: string }> = [];
  return {
    fileExplorerTarget: {
      type: "workspace",
      id: "workspace-1",
      startDirectory: "/workspaces/demo",
    },
    rootDirectory: "/workspaces/demo",
    getFileHref: ({ path, startDirectory }) => `#/code-explorer/chat/chat-1?startDirectory=${encodeURIComponent(startDirectory)}&filePath=${encodeURIComponent(path)}`,
    openFile: (target) => {
      openedTargets.push(target);
    },
    openedTargets,
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
    expect(looksLikeFileLinkCandidate("https://example.com/src/index.ts")).toBe(false);
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
    expect(fileLinkContext.openedTargets).toEqual([{
      path: "src/index.ts",
      startDirectory: "/workspaces/demo",
    }]);
  });

  test("preserves browser behavior for modified and non-primary transcript link clicks", async () => {
    const fileLinkContext = createFileLinkContext();

    api.get("/api/workspaces/:id/files/metadata", () => ({
      workspaceId: "workspace-1",
      file: {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 24,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        versionToken: "100:24",
      },
    }));

    const { queryByRole } = renderWithUser(
      <StreamingTextContent
        content={"Inspect `src/index.ts`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    await waitFor(() => {
      expect(queryByRole("link", { name: "src/index.ts" })).toBeInTheDocument();
    });

    const link = queryByRole("link", { name: "src/index.ts" });
    expect(link).not.toBeNull();

    fireEvent.click(link!, { metaKey: true });
    fireEvent.click(link!, { ctrlKey: true });
    fireEvent.click(link!, { button: 1 });
    expect(fileLinkContext.openedTargets).toEqual([]);

    fireEvent.click(link!);
    expect(fileLinkContext.openedTargets).toEqual([{
      path: "src/index.ts",
      startDirectory: "/workspaces/demo",
    }]);
  });

  test("links absolute file paths outside the active worktree by switching the explorer root", async () => {
    const fileLinkContext = createFileLinkContext();

    api.get("/api/workspaces/:id/files/metadata", (req) => {
      const url = new URL(req.url, "http://localhost");
      expect(url.searchParams.get("path")).toBe("plan.md");
      expect(url.searchParams.get("startDirectory")).toBe("/root/.copilot/session-state/session-1");
      return {
        workspaceId: "workspace-1",
        file: {
          name: "plan.md",
          path: "plan.md",
          kind: "file",
          size: 24,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "100:24",
        },
      };
    });

    const { queryByRole, user } = renderWithUser(
      <StreamingTextContent
        content={"Open `/root/.copilot/session-state/session-1/plan.md`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    await waitFor(() => {
      expect(queryByRole("link", { name: "/root/.copilot/session-state/session-1/plan.md" })).toBeInTheDocument();
    });

    const link = queryByRole("link", { name: "/root/.copilot/session-state/session-1/plan.md" });
    expect(link).toHaveAttribute(
      "href",
      "#/code-explorer/chat/chat-1?startDirectory=%2Froot%2F.copilot%2Fsession-state%2Fsession-1&filePath=plan.md",
    );

    await user.click(link!);

    expect(fileLinkContext.openedTargets).toEqual([{
      path: "plan.md",
      startDirectory: "/root/.copilot/session-state/session-1",
    }]);
  });

  test("normalizes Windows drive-root parents for absolute transcript file links", async () => {
    const fileLinkContext = createFileLinkContext();

    api.get("/api/workspaces/:id/files/metadata", (req) => {
      const url = new URL(req.url, "http://localhost");
      expect(url.searchParams.get("path")).toBe("file.txt");
      expect(url.searchParams.get("startDirectory")).toBe("C:/");
      return {
        workspaceId: "workspace-1",
        file: {
          name: "file.txt",
          path: "file.txt",
          kind: "file",
          size: 24,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "100:24",
        },
      };
    });

    const { queryByRole, user } = renderWithUser(
      <StreamingTextContent
        content={"Open `C:/file.txt`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    await waitFor(() => {
      expect(queryByRole("link", { name: "C:/file.txt" })).toBeInTheDocument();
    });

    const link = queryByRole("link", { name: "C:/file.txt" });
    expect(link).toHaveAttribute(
      "href",
      "#/code-explorer/chat/chat-1?startDirectory=C%3A%2F&filePath=file.txt",
    );

    await user.click(link!);

    expect(fileLinkContext.openedTargets).toEqual([{
      path: "file.txt",
      startDirectory: "C:/",
    }]);
  });

  test("evicts old transcript link cache entries when many distinct candidates are resolved", async () => {
    const fileLinkContext = createFileLinkContext();

    api.get("/api/workspaces/:id/files/metadata", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path") ?? "";
      return {
        workspaceId: "workspace-1",
        file: {
          name: path.split("/").at(-1) ?? "unknown.ts",
          path,
          kind: "file",
          size: 24,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "100:24",
        },
      };
    });

    const { rerender } = renderWithUser(
      <StreamingTextContent
        content={"Inspect `src/file-0.ts`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    for (let index = 0; index <= 100; index += 1) {
      rerender(
        <StreamingTextContent
          content={`Inspect \`src/file-${index}.ts\`.`}
          markdownEnabled={false}
          plainTextClassName="whitespace-pre-wrap break-words text-sm"
          fileLinkContext={fileLinkContext}
        />,
      );

      await waitFor(() => {
        expect(api.calls("/api/workspaces/:id/files/metadata", "GET")).toHaveLength(index + 1);
      });
    }

    rerender(
      <StreamingTextContent
        content={"Inspect `src/file-0.ts`."}
        markdownEnabled={false}
        plainTextClassName="whitespace-pre-wrap break-words text-sm"
        fileLinkContext={fileLinkContext}
      />,
    );

    await waitFor(() => {
      expect(api.calls("/api/workspaces/:id/files/metadata", "GET")).toHaveLength(102);
    });
  });
});
