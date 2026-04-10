import { describe, expect, test } from "bun:test";
import type { PersistedMessage } from "@/types/loop";
import { buildSpawnLoopName, buildSpawnLoopPrompt } from "@/utils/chat-to-loop-prompt";

function createMessage(overrides: Partial<PersistedMessage>): PersistedMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    role: overrides.role ?? "user",
    content: overrides.content ?? "Message content",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    attachments: overrides.attachments,
  };
}

describe("chat-to-loop-prompt", () => {
  test("builds a loop prompt from the latest chat transcript context", () => {
    const prompt = buildSpawnLoopPrompt("Repo pairing", [
      createMessage({ role: "user", content: "Investigate why the reconnect flow is flaky." }),
      createMessage({ role: "assistant", content: "The race looks related to the websocket reconnect guard." }),
      createMessage({ role: "user", content: "Turn this into a concrete implementation plan." }),
    ]);

    expect(prompt).toContain("Chat title: Repo pairing");
    expect(prompt).toContain("User:\nInvestigate why the reconnect flow is flaky.");
    expect(prompt).toContain("Assistant:\nThe race looks related to the websocket reconnect guard.");
    expect(prompt).toContain("User:\nTurn this into a concrete implementation plan.");
    expect(prompt).toContain("Treat the most recent user intent, corrections, and constraints as authoritative");
  });

  test("throws when the chat transcript has no usable messages", () => {
    expect(() => buildSpawnLoopPrompt("Empty chat", [
      createMessage({ content: "   " }),
    ])).toThrow("Chat transcript is empty. Send at least one message before spawning a loop.");
  });

  test("builds a bounded loop name from the chat title", () => {
    const name = buildSpawnLoopName("A".repeat(150));

    expect(name.startsWith("Plan from ")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});
