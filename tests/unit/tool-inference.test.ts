import { describe, expect, test } from "bun:test";
import { getStructuredToolDetails, getToolSummary } from "../../src/components/log-viewer/tool-inference";
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
