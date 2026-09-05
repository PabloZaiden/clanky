import { describe, expect, test } from "bun:test";
import type { ToolCallDisplayData } from "../../src/shared";
import type { EntryBase, LogEntry } from "../../src/components/log-viewer/types";
import {
  annotateReasoningBoundaries,
  formatThoughtDuration,
  groupConsecutiveEntries,
  isReasoningLogEntry,
} from "../../src/components/log-viewer/utils";

function createReasoningLog(id: string, timestamp: string, content: string): LogEntry {
  return {
    id,
    level: "agent",
    message: "AI reasoning...",
    details: {
      logKind: "reasoning",
      responseContent: content,
    },
    timestamp,
  };
}

function createReasoningEntry(
  id: string,
  timestamp: string,
  reasoningEndTimestamp?: string,
): Extract<EntryBase, { type: "log" }> {
  return {
    type: "log",
    data: createReasoningLog(id, timestamp, id),
    timestamp,
    reasoningGroupId: id,
    reasoningEndTimestamp,
  };
}

function createToolEntry(
  id: string,
  timestamp: string,
): Extract<EntryBase, { type: "tool" }> {
  const tool: ToolCallDisplayData = {
    id,
    name: "read",
    status: "completed",
    timestamp,
  };
  return {
    type: "tool",
    data: tool,
    timestamp,
  };
}

describe("reasoning display helpers", () => {
  test("uses a short label below ten seconds and preserves duration boundaries", () => {
    const start = "2026-09-05T00:00:00.000Z";

    expect(formatThoughtDuration(start, "2026-09-05T00:00:00.999Z")).toBe("a bit");
    expect(formatThoughtDuration(start, "2026-09-05T00:00:01.000Z")).toBe("a bit");
    expect(formatThoughtDuration(start, "2026-09-05T00:00:09.999Z")).toBe("a bit");
    expect(formatThoughtDuration(start, "2026-09-05T00:00:10.000Z")).toBe("10 seconds");
    expect(formatThoughtDuration(start, "2026-09-05T00:00:59.999Z")).toBe("59 seconds");
    expect(formatThoughtDuration(start, "2026-09-05T00:01:00.000Z")).toBe("1 minute");
    expect(formatThoughtDuration(start, "2026-09-05T00:02:00.000Z")).toBe("2 minutes");
  });

  test("groups consecutive reasoning logs and closes a finished group at the next event", () => {
    const firstReasoning = createReasoningLog(
      "reasoning-1",
      "2026-09-05T00:00:00.000Z",
      "first",
    );
    const secondReasoning = createReasoningLog(
      "reasoning-2",
      "2026-09-05T00:00:01.000Z",
      "second",
    );
    const nextMessage = {
      type: "message" as const,
      data: {
        id: "message-1",
        role: "assistant" as const,
        content: "done",
        timestamp: "2026-09-05T00:00:05.000Z",
      },
      timestamp: "2026-09-05T00:00:05.000Z",
    };
    const entries: EntryBase[] = [
      {
        type: "log",
        data: firstReasoning,
        timestamp: firstReasoning.timestamp,
        reasoningEndTimestamp: nextMessage.timestamp,
      },
      {
        type: "log",
        data: secondReasoning,
        timestamp: secondReasoning.timestamp,
        reasoningEndTimestamp: nextMessage.timestamp,
      },
      nextMessage,
    ];

    const grouped = groupConsecutiveEntries(entries, true);
    const reasoningGroup = grouped[0];

    expect(reasoningGroup?.type).toBe("reasoning-group");
    if (reasoningGroup?.type !== "reasoning-group") {
      return;
    }
    expect(reasoningGroup.logs.map((log) => log.id)).toEqual(["reasoning-1", "reasoning-2"]);
    expect(reasoningGroup.endedAt).toBe(nextMessage.timestamp);
    expect(reasoningGroup.isActive).toBe(false);
    expect(grouped[1]?.type).toBe("message");
  });

  test("keeps consecutive tools unwrapped while wrapping mixed activity", () => {
    const pureTools = groupConsecutiveEntries([
      createToolEntry("tool-only-1", "2026-09-05T00:00:00.000Z"),
      createToolEntry("tool-only-2", "2026-09-05T00:00:01.000Z"),
    ], true);

    expect(pureTools).toHaveLength(1);
    expect(pureTools[0]?.type).toBe("tool-group");

    const mixed = groupConsecutiveEntries([
      createReasoningEntry(
        "reasoning-mixed-1",
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:01.000Z",
      ),
      createToolEntry("tool-mixed-1", "2026-09-05T00:00:01.000Z"),
      createToolEntry("tool-mixed-2", "2026-09-05T00:00:02.000Z"),
      createReasoningEntry("reasoning-mixed-2", "2026-09-05T00:00:03.000Z"),
    ], true);

    expect(mixed).toHaveLength(1);
    const workingGroup = mixed[0];
    expect(workingGroup?.type).toBe("working-group");
    if (workingGroup?.type !== "working-group") {
      return;
    }
    expect(workingGroup.isActive).toBe(true);
    expect(workingGroup.entries.map((entry) => entry.type)).toEqual([
      "reasoning-group",
      "tool-group",
      "reasoning-group",
    ]);
    const toolGroup = workingGroup.entries[1];
    expect(toolGroup?.type).toBe("tool-group");
    if (toolGroup?.type === "tool-group") {
      expect(toolGroup.tools.map((tool) => tool.id)).toEqual([
        "tool-mixed-1",
        "tool-mixed-2",
      ]);
    }
  });

  test("uses the first following event to close a mixed working group", () => {
    const responseTimestamp = "2026-09-05T00:00:10.000Z";
    const grouped = groupConsecutiveEntries([
      createReasoningEntry(
        "reasoning-completed",
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:01.000Z",
      ),
      createToolEntry("tool-completed", "2026-09-05T00:00:01.000Z"),
      {
        type: "message",
        data: {
          id: "response-message",
          role: "assistant",
          content: "Finished",
          timestamp: responseTimestamp,
        },
        timestamp: responseTimestamp,
      },
    ], true);

    const workingGroup = grouped[0];
    expect(workingGroup?.type).toBe("working-group");
    if (workingGroup?.type !== "working-group") {
      return;
    }
    expect(workingGroup.endedAt).toBe(responseTimestamp);
    expect(workingGroup.isActive).toBe(false);
    expect(formatThoughtDuration(workingGroup.timestamp, workingGroup.endedAt!)).toBe("10 seconds");
    expect(grouped[1]?.type).toBe("message");
  });

  test("does not join mixed runs across a hidden response boundary", () => {
    const firstBoundaryTimestamp = "2026-09-05T00:00:02.000Z";
    const grouped = groupConsecutiveEntries([
      createReasoningEntry(
        "reasoning-before-response",
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:01.000Z",
      ),
      createToolEntry("tool-before-response", "2026-09-05T00:00:01.000Z"),
      {
        type: "response-boundary",
        id: "hidden-response",
        timestamp: firstBoundaryTimestamp,
      },
      createReasoningEntry(
        "reasoning-after-response",
        "2026-09-05T00:00:03.000Z",
        "2026-09-05T00:00:04.000Z",
      ),
      createToolEntry("tool-after-response", "2026-09-05T00:00:04.000Z"),
    ], true);

    expect(grouped).toHaveLength(2);
    const firstGroup = grouped[0];
    const secondGroup = grouped[1];
    expect(firstGroup?.type).toBe("working-group");
    expect(secondGroup?.type).toBe("working-group");
    if (firstGroup?.type !== "working-group" || secondGroup?.type !== "working-group") {
      return;
    }
    expect(firstGroup.endedAt).toBe(firstBoundaryTimestamp);
    expect(secondGroup.isActive).toBe(true);
  });

  test("keeps adjacent reasoning runs separate when their end timestamps differ", () => {
    const firstEndTimestamp = "2026-09-05T00:00:05.000Z";
    const secondEndTimestamp = "2026-09-05T00:00:09.000Z";
    const firstReasoning = createReasoningLog(
      "reasoning-first-run",
      "2026-09-05T00:00:00.000Z",
      "first run",
    );
    const secondReasoning = createReasoningLog(
      "reasoning-second-run",
      "2026-09-05T00:00:06.000Z",
      "second run",
    );

    const grouped = groupConsecutiveEntries([
      {
        type: "log",
        data: firstReasoning,
        timestamp: firstReasoning.timestamp,
        reasoningEndTimestamp: firstEndTimestamp,
      },
      {
        type: "log",
        data: secondReasoning,
        timestamp: secondReasoning.timestamp,
        reasoningEndTimestamp: secondEndTimestamp,
      },
    ], true);

    expect(grouped).toHaveLength(2);
    const firstGroup = grouped[0];
    const secondGroup = grouped[1];
    expect(firstGroup?.type).toBe("reasoning-group");
    expect(secondGroup?.type).toBe("reasoning-group");
    if (firstGroup?.type !== "reasoning-group" || secondGroup?.type !== "reasoning-group") {
      return;
    }

    expect(firstGroup.logs.map((log) => log.id)).toEqual(["reasoning-first-run"]);
    expect(firstGroup.endedAt).toBe(firstEndTimestamp);
    expect(firstGroup.isActive).toBe(false);
    expect(secondGroup.logs.map((log) => log.id)).toEqual(["reasoning-second-run"]);
    expect(secondGroup.endedAt).toBe(secondEndTimestamp);
    expect(secondGroup.isActive).toBe(false);
  });

  test("preserves original run boundaries across filtered entries", () => {
    const sharedEndTimestamp = "2026-09-05T00:00:05.000Z";
    const firstReasoning = createReasoningLog(
      "reasoning-filtered-first",
      "2026-09-05T00:00:00.000Z",
      "first run",
    );
    const secondReasoning = createReasoningLog(
      "reasoning-filtered-second",
      sharedEndTimestamp,
      "second run",
    );
    const filteredSystemLog = {
      id: "system-between-runs",
      level: "info" as const,
      message: "System event between reasoning runs.",
      details: { logKind: "system" },
      timestamp: sharedEndTimestamp,
    };

    const annotatedEntries = annotateReasoningBoundaries([
      {
        type: "log",
        data: firstReasoning,
        timestamp: firstReasoning.timestamp,
      },
      {
        type: "log",
        data: filteredSystemLog,
        timestamp: filteredSystemLog.timestamp,
      },
      {
        type: "log",
        data: secondReasoning,
        timestamp: secondReasoning.timestamp,
      },
      {
        type: "log",
        data: {
          ...filteredSystemLog,
          id: "system-after-second-run",
        },
        timestamp: sharedEndTimestamp,
      },
    ]);
    const visibleReasoningEntries = annotatedEntries.filter(
      (entry): entry is Extract<EntryBase, { type: "log" }> =>
        entry.type === "log" && isReasoningLogEntry(entry.data),
    );
    const grouped = groupConsecutiveEntries(visibleReasoningEntries, true);

    expect(grouped).toHaveLength(2);
    const firstGroup = grouped[0];
    const secondGroup = grouped[1];
    expect(firstGroup?.type).toBe("reasoning-group");
    expect(secondGroup?.type).toBe("reasoning-group");
    if (firstGroup?.type !== "reasoning-group" || secondGroup?.type !== "reasoning-group") {
      return;
    }

    expect(firstGroup.logs.map((log) => log.id)).toEqual(["reasoning-filtered-first"]);
    expect(firstGroup.endedAt).toBe(sharedEndTimestamp);
    expect(formatThoughtDuration(firstGroup.timestamp, firstGroup.endedAt!)).toBe("a bit");
    expect(secondGroup.logs.map((log) => log.id)).toEqual(["reasoning-filtered-second"]);
    expect(secondGroup.endedAt).toBe(sharedEndTimestamp);
    expect(formatThoughtDuration(secondGroup.timestamp, secondGroup.endedAt!)).toBe("a bit");
  });

  test("keeps a trailing reasoning group active while the transcript is active", () => {
    const reasoning = createReasoningLog(
      "reasoning-active",
      "2026-09-05T00:00:00.000Z",
      "still thinking",
    );

    const [group] = groupConsecutiveEntries([{
      type: "log",
      data: reasoning,
      timestamp: reasoning.timestamp,
    }], true);

    expect(group?.type).toBe("reasoning-group");
    if (group?.type !== "reasoning-group") {
      return;
    }
    expect(group.isActive).toBe(true);
    expect(group.endedAt).toBeUndefined();
  });
});
