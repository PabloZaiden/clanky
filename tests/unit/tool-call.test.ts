import { describe, expect, test } from "bun:test";
import {
  mergeToolCallRecords,
  mergeToolCallRecord,
  type ToolCallExtra,
  type ToolCallRecord,
} from "../../src/types/tool-call";

const sampleExtra: ToolCallExtra = {
  id: "tool-extra-1",
  type: "image_preview",
  image: {
    id: "image-1",
    filename: "screen.png",
    mimeType: "image/png",
    data: "ZmFrZQ==",
    size: 1234,
  },
  sourcePath: "/tmp/screen.png",
};

describe("mergeToolCallRecord", () => {
  test("preserves existing extras when the incoming tool call omits them", () => {
    const existing: ToolCallRecord = {
      id: "tool-1",
      name: "read",
      input: { path: "/tmp/screen.png" },
      output: { content: "initial" },
      status: "completed",
      timestamp: "2025-01-01T00:00:00.000Z",
      extras: [sampleExtra],
    };
    const incoming: ToolCallRecord = {
      id: "tool-1",
      name: "read",
      input: { path: "/tmp/screen.png" },
      output: { content: "updated" },
      status: "completed",
      timestamp: "2025-01-01T00:00:01.000Z",
    };

    expect(mergeToolCallRecord(existing, incoming)).toEqual({
      ...incoming,
      extras: [sampleExtra],
    });
  });

  test("uses the incoming extras when they are provided", () => {
    const existing: ToolCallRecord = {
      id: "tool-1",
      name: "read",
      input: { path: "/tmp/screen.png" },
      status: "completed",
      timestamp: "2025-01-01T00:00:00.000Z",
      extras: [sampleExtra],
    };
    const incoming: ToolCallRecord = {
      id: "tool-1",
      name: "read",
      input: { path: "/tmp/screen.png" },
      status: "completed",
      timestamp: "2025-01-01T00:00:01.000Z",
      extras: [{
        ...sampleExtra,
        id: "tool-extra-2",
      }],
    };

    expect(mergeToolCallRecord(existing, incoming)).toEqual({
      ...incoming,
      extras: [
        sampleExtra,
        {
          ...sampleExtra,
          id: "tool-extra-2",
        },
      ],
    });
  });

  test("preserves completed output when a later partial update omits it", () => {
    const existing: ToolCallRecord = {
      id: "tool-1",
      name: "view",
      input: { path: "/workspace/repo/a.ts" },
      output: { content: "file contents" },
      status: "completed",
      timestamp: "2025-01-01T00:00:02.000Z",
      extras: [sampleExtra],
    };
    const incoming: ToolCallRecord = {
      id: "tool-1",
      name: "view",
      input: { path: "/workspace/repo/a.ts" },
      status: "running",
      timestamp: "2025-01-01T00:00:03.000Z",
    };

    expect(mergeToolCallRecord(existing, incoming)).toEqual({
      ...incoming,
      output: { content: "file contents" },
      status: "completed",
      extras: [sampleExtra],
    });
  });
});

describe("mergeToolCallRecords", () => {
  test("preserves richer existing tool calls when incoming snapshots are less complete", () => {
    const existing: ToolCallRecord[] = [
      {
        id: "tool-1",
        name: "view",
        input: { path: "/workspace/repo/a.ts" },
        output: { content: "file contents" },
        status: "completed",
        timestamp: "2025-01-01T00:00:02.000Z",
        extras: [sampleExtra],
      },
    ];
    const incoming: ToolCallRecord[] = [
      {
        id: "tool-1",
        name: "view",
        input: { path: "/workspace/repo/a.ts" },
        status: "running",
        timestamp: "2025-01-01T00:00:03.000Z",
      },
      {
        id: "tool-2",
        name: "view",
        input: { path: "/workspace/repo/b.ts" },
        output: { content: "other file" },
        status: "completed",
        timestamp: "2025-01-01T00:00:04.000Z",
      },
    ];

    expect(mergeToolCallRecords(existing, incoming)).toEqual([
      {
        id: "tool-1",
        name: "view",
        input: { path: "/workspace/repo/a.ts" },
        output: { content: "file contents" },
        status: "completed",
        timestamp: "2025-01-01T00:00:03.000Z",
        extras: [sampleExtra],
      },
      {
        id: "tool-2",
        name: "view",
        input: { path: "/workspace/repo/b.ts" },
        output: { content: "other file" },
        status: "completed",
        timestamp: "2025-01-01T00:00:04.000Z",
      },
    ]);
  });
});
