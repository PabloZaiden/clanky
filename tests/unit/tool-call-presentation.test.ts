import { describe, expect, test } from "bun:test";
import {
  getToolCallSummary,
  inferToolCallKind,
} from "../../src/shared/tool-call-presentation";
import { createToolCallSummary } from "../../src/shared/tool-call";
import type { ToolCallRecord } from "../../src/shared/tool-call";

function createToolCall(input: unknown, name = "search"): ToolCallRecord {
  return {
    id: "tool-1",
    name,
    input,
    status: "completed",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("tool-call presentation", () => {
  test("presents the webSearch payload as a web search", () => {
    const tool = createToolCall({
      type: "webSearch",
      id: "exec-1",
      query: "NVIDIA GeForce RTX 5080 Founders Edition price",
      action: {
        type: "search",
        query: null,
        queries: [
          "NVIDIA GeForce RTX 5080 Founders Edition price",
          "site:bestbuy.com RTX 5080 Founders Edition NVIDIA price",
        ],
      },
    });

    expect(inferToolCallKind(tool)).toBe("web_search");
    expect(getToolCallSummary(tool)).toBe(
      "Search the web for 'NVIDIA GeForce RTX 5080 Founders Edition price'",
    );
    expect(createToolCallSummary(tool)).toMatchObject({
      kind: "web_search",
      summary: "Search the web for 'NVIDIA GeForce RTX 5080 Founders Edition price'",
      outputLabel: "Result",
    });
  });

  test("uses the first nested query when the web search query is null", () => {
    const tool = createToolCall({
      type: "webSearch",
      action: {
        type: "search",
        query: null,
        queries: ["  first web query  ", "second web query"],
      },
    });

    expect(getToolCallSummary(tool)).toBe("Search the web for 'first web query'");
  });

  test("uses a generic web-search summary when no query is available", () => {
    const tool = createToolCall({
      type: "webSearch",
      action: {
        type: "search",
        query: null,
        queries: [],
      },
    });

    expect(inferToolCallKind(tool)).toBe("web_search");
    expect(getToolCallSummary(tool)).toBe("Search the web");
  });

  test("preserves file search and web fetch classification", () => {
    const glob = createToolCall({ pattern: "*.ts" });
    const rg = createToolCall({ pattern: "TODO", output_mode: "content" });
    const webFetch = createToolCall({ url: "https://example.com" }, "web_fetch");

    expect(inferToolCallKind(glob)).toBe("glob");
    expect(inferToolCallKind(rg)).toBe("rg");
    expect(inferToolCallKind(webFetch)).toBe("web_fetch");
    expect(getToolCallSummary(glob)).toBe("Find files matching '*.ts'");
    expect(getToolCallSummary(webFetch)).toBe("Fetch https://example.com");
  });
});
