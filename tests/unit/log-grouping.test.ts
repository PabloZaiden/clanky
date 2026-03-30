/**
 * Tests for the LogViewer consecutive entry grouping logic.
 * Verifies that getEntryGroupKey and annotateShowHeader correctly identify
 * when consecutive entries share the same actor+action.
 */

import { test, expect, describe } from "bun:test";
import { getEntryGroupKey, annotateShowHeader } from "../../src/components/LogViewer";
import type { MessageData, ToolCallData } from "../../src/types/events";
import type { LogEntry } from "../../src/components/LogViewer";

// -- Test helpers --

function makeMessage(overrides: Partial<MessageData> & { role: MessageData["role"] }): {
  type: "message";
  data: MessageData;
  timestamp: string;
} {
  const data: MessageData = {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "test content",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
  return { type: "message", data, timestamp: data.timestamp };
}

function makeTool(overrides: Partial<ToolCallData> & { name: string }): {
  type: "tool";
  data: ToolCallData;
  timestamp: string;
} {
  const data: ToolCallData = {
    id: `tool-${Math.random().toString(36).slice(2, 8)}`,
    input: {},
    status: "completed",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
  return { type: "tool", data, timestamp: data.timestamp };
}

function makeLog(overrides: Partial<LogEntry> & { level: LogEntry["level"]; message: string }): {
  type: "log";
  data: LogEntry;
  timestamp: string;
} {
  const data: LogEntry = {
    id: `log-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
  return { type: "log", data, timestamp: data.timestamp };
}

// -- Tests --

describe("getEntryGroupKey", () => {
  test("message entries group by role", () => {
    const userMsg = makeMessage({ role: "user" });
    const assistantMsg = makeMessage({ role: "assistant" });

    expect(getEntryGroupKey(userMsg)).toBe("message|user");
    expect(getEntryGroupKey(assistantMsg)).toBe("message|assistant");
  });

  test("tool entries group by tool name", () => {
    const writeTool = makeTool({ name: "Write" });
    const readTool = makeTool({ name: "Read" });

    expect(getEntryGroupKey(writeTool)).toBe("tool|Write");
    expect(getEntryGroupKey(readTool)).toBe("tool|Read");
  });

  test("tool entries with same name but different status have same key", () => {
    const toolRunning = makeTool({ name: "Write", status: "running" });
    const toolCompleted = makeTool({ name: "Write", status: "completed" });

    expect(getEntryGroupKey(toolRunning)).toBe(getEntryGroupKey(toolCompleted));
  });

  test("log entries group by level and message", () => {
    const agentLog = makeLog({ level: "agent", message: "AI generating response..." });
    const infoLog = makeLog({ level: "info", message: "Server started" });

    expect(getEntryGroupKey(agentLog)).toBe("log|agent|AI generating response...");
    expect(getEntryGroupKey(infoLog)).toBe("log|info|Server started");
  });

  test("log entries with same level but different message have different keys", () => {
    const log1 = makeLog({ level: "agent", message: "AI generating response..." });
    const log2 = makeLog({ level: "agent", message: "AI reasoning..." });

    expect(getEntryGroupKey(log1)).not.toBe(getEntryGroupKey(log2));
  });

  test("different entry types always have different keys", () => {
    const msg = makeMessage({ role: "user" });
    const tool = makeTool({ name: "user" }); // same string, different type
    const log = makeLog({ level: "user", message: "user" });

    const keys = [getEntryGroupKey(msg), getEntryGroupKey(tool), getEntryGroupKey(log)];
    // All three should be unique
    expect(new Set(keys).size).toBe(3);
  });
});

describe("annotateShowHeader", () => {
  test("single entry always shows header", () => {
    const entries = [makeLog({ level: "agent", message: "AI generating response..." })];
    const result = annotateShowHeader(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.showHeader).toBe(true);
  });

  test("empty array returns empty", () => {
    const result = annotateShowHeader([]);
    expect(result).toHaveLength(0);
  });

  test("two consecutive entries with same actor+action: first shows header, second does not", () => {
    const entries = [
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:01Z" }),
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result).toHaveLength(2);
    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(false);
  });

  test("two consecutive entries with different actor show both headers", () => {
    const entries = [
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:01Z" }),
      makeLog({ level: "info", message: "AI generating response...", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(true);
  });

  test("two consecutive entries with different action show both headers", () => {
    const entries = [
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:01Z" }),
      makeLog({ level: "agent", message: "AI reasoning...", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(true);
  });

  test("three entries: same, same, different", () => {
    const entries = [
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:01Z" }),
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:02Z" }),
      makeLog({ level: "agent", message: "AI reasoning...", timestamp: "2025-01-01T00:00:03Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);  // first in group
    expect(result[1]!.showHeader).toBe(false); // continuation
    expect(result[2]!.showHeader).toBe(true);  // new group
  });

  test("mixed entry types always start new groups", () => {
    const entries = [
      makeMessage({ role: "user", timestamp: "2025-01-01T00:00:01Z" }),
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:02Z" }),
      makeTool({ name: "Write", timestamp: "2025-01-01T00:00:03Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(true);
    expect(result[2]!.showHeader).toBe(true);
  });

  test("consecutive messages from same role collapse headers", () => {
    const entries = [
      makeMessage({ role: "assistant", content: "Hello", timestamp: "2025-01-01T00:00:01Z" }),
      makeMessage({ role: "assistant", content: "World", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(false);
  });

  test("consecutive messages from different roles show both headers", () => {
    const entries = [
      makeMessage({ role: "user", content: "Hi", timestamp: "2025-01-01T00:00:01Z" }),
      makeMessage({ role: "assistant", content: "Hello", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(true);
  });

  test("consecutive tool calls with same name collapse headers", () => {
    const entries = [
      makeTool({ name: "Write", status: "completed", timestamp: "2025-01-01T00:00:01Z" }),
      makeTool({ name: "Write", status: "completed", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(false);
  });

  test("consecutive tool calls with different names show both headers", () => {
    const entries = [
      makeTool({ name: "Write", timestamp: "2025-01-01T00:00:01Z" }),
      makeTool({ name: "Read", timestamp: "2025-01-01T00:00:02Z" }),
    ];
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    expect(result[1]!.showHeader).toBe(true);
  });

  test("long run of same type collapses all but first", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeLog({
        level: "agent",
        message: "AI generating response...",
        timestamp: `2025-01-01T00:00:0${i + 1}Z`,
      })
    );
    const result = annotateShowHeader(entries);

    expect(result[0]!.showHeader).toBe(true);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.showHeader).toBe(false);
    }
  });

  test("preserves original entry data", () => {
    const original = makeLog({
      level: "agent",
      message: "AI generating response...",
      details: { logKind: "response", responseContent: "Hello" },
    });
    const result = annotateShowHeader([original]);

    expect(result[0]!.type).toBe("log");
    expect(result[0]!.data).toEqual(original.data);
    expect(result[0]!.timestamp).toBe(original.timestamp);
  });

  test("group broken by different entry, then resumed", () => {
    const entries = [
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:01Z" }),
      makeMessage({ role: "user", timestamp: "2025-01-01T00:00:02Z" }),
      makeLog({ level: "agent", message: "AI generating response...", timestamp: "2025-01-01T00:00:03Z" }),
    ];
    const result = annotateShowHeader(entries);

    // First log shows header
    expect(result[0]!.showHeader).toBe(true);
    // Message breaks the group
    expect(result[1]!.showHeader).toBe(true);
    // Same log type as first, but after a break, so shows header again
    expect(result[2]!.showHeader).toBe(true);
  });

  test("large list: precomputed keys produce correct grouping", () => {
    // Simulate a large log list with alternating groups
    const entries = Array.from({ length: 1000 }, (_, i) => {
      const groupIndex = Math.floor(i / 10); // groups of 10
      return makeLog({
        level: "agent",
        message: `msg-${groupIndex}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      });
    });
    const result = annotateShowHeader(entries);

    expect(result).toHaveLength(1000);
    for (let i = 0; i < result.length; i++) {
      const isGroupStart = i % 10 === 0;
      expect(result[i]!.showHeader).toBe(isGroupStart);
    }
  });
});
