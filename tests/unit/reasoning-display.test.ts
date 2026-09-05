import { describe, expect, test } from "bun:test";
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

describe("reasoning display helpers", () => {
  test("formats whole-second and whole-minute thought durations", () => {
    const start = "2026-09-05T00:00:00.000Z";

    expect(formatThoughtDuration(start, "2026-09-05T00:00:00.999Z")).toBe("0 seconds");
    expect(formatThoughtDuration(start, "2026-09-05T00:00:01.000Z")).toBe("1 second");
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
    expect(formatThoughtDuration(firstGroup.timestamp, firstGroup.endedAt!)).toBe("5 seconds");
    expect(secondGroup.logs.map((log) => log.id)).toEqual(["reasoning-filtered-second"]);
    expect(secondGroup.endedAt).toBe(sharedEndTimestamp);
    expect(formatThoughtDuration(secondGroup.timestamp, secondGroup.endedAt!)).toBe("0 seconds");
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
