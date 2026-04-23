import { describe, expect, test } from "bun:test";
import { getStructuredToolDetails, getToolMeta, getToolSummary, inferToolKind } from "../../src/components/log-viewer/tool-inference";
import type { ToolCallData } from "../../src/types";

function createToolCall(input: unknown): ToolCallData {
  return {
    id: "tool-1",
    name: "edit",
    input,
    status: "completed",
    timestamp: "2026-04-23T00:00:00.000Z",
  };
}

describe("apply_patch tool inference", () => {
  test("summarizes rename-only patches without parsing hunk content", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "*** End Patch",
    ].join("\n");

    expect(getToolSummary(createToolCall(patch), "apply_patch")).toBe("Patch src/old-name.ts → src/new-name.ts");
  });

  test("builds patch details from one parsed pass for header-only multi-file patches", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "*** Delete File: src/removed.ts",
      "*** End Patch",
    ].join("\n");

    const details = getStructuredToolDetails(createToolCall(patch));

    expect(details).not.toBeNull();
    expect(details?.inputBlocks).toHaveLength(2);
    expect(details?.inputBlocks[0]).toEqual({
      type: "rows",
      rows: [
        {
          label: "Files",
          value: "src/old-name.ts → src/new-name.ts, src/removed.ts",
        },
      ],
    });
    expect(details?.inputBlocks[1]).toEqual({
      type: "patch",
      title: "Patch",
      files: [
        {
          path: "src/new-name.ts",
          oldPath: "src/old-name.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
          patch: undefined,
        },
        {
          path: "src/removed.ts",
          oldPath: undefined,
          status: "deleted",
          additions: 0,
          deletions: 0,
          patch: undefined,
        },
      ],
    });
  });
});

describe("OpenCode tool inference fallbacks", () => {
  test("maps stored read tool name to view when input is empty", () => {
    const tool: ToolCallData = {
      id: "tool-read",
      name: "read",
      input: {},
      output: {
        output: "<path>/workspace/repo/README.md</path>\n<type>file</type>\n<content>\n1: hello\n</content>",
      },
      status: "completed",
      timestamp: "2026-04-23T00:00:00.000Z",
    };

    expect(inferToolKind(tool)).toBe("view");
    expect(getToolMeta(tool).summary).toBe("View file");
    expect(getStructuredToolDetails(tool)?.inputBlocks).toEqual([
      {
        type: "rows",
        rows: [{ label: "Path", value: "/workspace/repo/README.md" }],
      },
    ]);
  });

  test("maps stored search tool name to rg when output looks like search results", () => {
    const tool: ToolCallData = {
      id: "tool-search",
      name: "search",
      input: {},
      output: {
        output: "Found 2 matches",
        metadata: {
          matches: [
            { file: "/workspace/repo/src/app.ts", line: 12, text: "const match = true;" },
          ],
        },
      },
      status: "completed",
      timestamp: "2026-04-23T00:00:00.000Z",
    };

    expect(inferToolKind(tool)).toBe("rg");
    expect(getToolMeta(tool).summary).toBe("Search for ''");
    expect(getStructuredToolDetails(tool)?.outputBlocks).toEqual([
      {
        type: "list",
        title: "Matches",
        items: ["/workspace/repo/src/app.ts:12 const match = true;"],
      },
    ]);
  });

  test("maps stored execute tool name to bash", () => {
    const tool: ToolCallData = {
      id: "tool-execute",
      name: "execute",
      input: {
        command: "pwd",
        description: "Show current directory",
      },
      output: {
        output: "/workspace/repo\n",
      },
      status: "completed",
      timestamp: "2026-04-23T00:00:00.000Z",
    };

    expect(inferToolKind(tool)).toBe("bash");
    expect(getToolMeta(tool).summary).toBe("Show current directory");
  });

  test("maps stored fetch tool name to web_fetch", () => {
    const tool: ToolCallData = {
      id: "tool-fetch",
      name: "fetch",
      input: {
        url: "https://example.com",
        format: "text",
      },
      output: {
        output: "Example Domain",
      },
      status: "completed",
      timestamp: "2026-04-23T00:00:00.000Z",
    };

    expect(inferToolKind(tool)).toBe("web_fetch");
    expect(getToolMeta(tool).summary).toBe("Fetch https://example.com");
  });

  test("maps stored todowrite tool name to todo list presentation", () => {
    const tool: ToolCallData = {
      id: "tool-todo",
      name: "todowrite",
      input: {
        todos: [
          { content: "Task one", status: "pending", priority: "high" },
          { content: "Task two", status: "completed", priority: "medium" },
        ],
      },
      output: {
        output: "[{\"content\":\"Task one\"}]",
      },
      status: "completed",
      timestamp: "2026-04-23T00:00:00.000Z",
    };

    expect(inferToolKind(tool)).toBe("todo");
    expect(getToolMeta(tool).summary).toBe("Update todo list (2)");
    expect(getStructuredToolDetails(tool)?.inputBlocks).toEqual([
      {
        type: "list",
        title: "Todos",
        items: [
          "Task one (pending / high)",
          "Task two (completed / medium)",
        ],
      },
    ]);
  });
});
