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
  test("builds a loop prompt from the full chat transcript", () => {
    const prompt = buildSpawnLoopPrompt("Repo pairing", [
      createMessage({ role: "user", content: "Investigate why the reconnect flow is flaky." }),
      createMessage({ role: "assistant", content: "The race looks related to the websocket reconnect guard." }),
      createMessage({ role: "user", content: "Turn this into a concrete implementation plan." }),
    ]);

    expect(prompt).toContain("You are creating a new Ralph plan loop from an existing chat conversation.");
    expect(prompt).toContain("Chat title: Repo pairing");
    expect(prompt).toContain("User:\nInvestigate why the reconnect flow is flaky.");
    expect(prompt).toContain("Assistant:\nThe race looks related to the websocket reconnect guard.");
    expect(prompt).toContain("User:\nTurn this into a concrete implementation plan.");
    expect(prompt).toContain("Only the user and assistant messages are included here; tool calls and hidden reasoning are intentionally excluded.");
    expect(prompt).toContain("Infer the final goal from the entire conversation");
  });

  test("keeps earlier transcript turns when the full transcript fits the prompt budget", () => {
    const earliestMessage = "A".repeat(13_000);
    const prompt = buildSpawnLoopPrompt("Long conversation", [
      createMessage({ role: "user", content: earliestMessage }),
      createMessage({ role: "assistant", content: "I found the likely subsystem to change." }),
      createMessage({ role: "user", content: "Now turn everything we learned into the final implementation plan." }),
    ]);

    expect(prompt).toContain(`User:\n${earliestMessage}`);
    expect(prompt).not.toContain("Earlier message compacted");
    expect(prompt).not.toContain("Earlier transcript summary:");
  });

  test("compacts older turns deterministically when the full transcript exceeds the prompt budget", () => {
    const oversizedMessage = "A".repeat(40_000);
    const prompt = buildSpawnLoopPrompt("Oversized conversation", [
      createMessage({
        role: "user",
        content: oversizedMessage,
        attachments: [{
          id: "attachment-1",
          data: "abc123",
          filename: "screenshot.png",
          mimeType: "image/png",
          size: 6,
        }],
      }),
      createMessage({ role: "assistant", content: "The socket handoff needs one guarded reconnect path." }),
      createMessage({ role: "user", content: "Turn this into the final implementation plan." }),
    ]);

    expect(prompt).toContain("[Earlier message compacted to stay within the spawned loop prompt budget.]");
    expect(prompt).toContain(`${"A".repeat(280)}...`);
    expect(prompt).not.toContain(`User:\n${oversizedMessage}`);
    expect(prompt).toContain("[1 image attachment referenced in the chat but not inlined here]");
    expect(prompt).toContain("Turn this into the final implementation plan.");
  });

  test("summarizes the oldest compacted turns when compacted sections still exceed the prompt budget", () => {
    const attachment = {
      id: "attachment-1",
      data: "abc123",
      filename: "diagram.png",
      mimeType: "image/png",
      size: 6,
    };
    const transcript = Array.from({ length: 120 }, (_, index) => createMessage({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Message ${index}: ${"B".repeat(400)}`,
      attachments: index === 0 ? [attachment] : undefined,
    }));
    const prompt = buildSpawnLoopPrompt("Massive conversation", [
      ...transcript,
      createMessage({ role: "user", content: "Use the latest decision and write the implementation plan." }),
    ]);

    expect(prompt).toContain("Earlier transcript summary:");
    expect(prompt).toContain("older messages summarized to keep the spawned loop prompt within size limits.");
    expect(prompt).toContain("and 1 image attachment reference.");
    expect(prompt).toContain("Use the latest decision and write the implementation plan.");
    expect(prompt).not.toContain("Message 0:");
  });

  test("mentions image attachments without inlining them into the transcript", () => {
    const prompt = buildSpawnLoopPrompt("Attachment chat", [
      createMessage({
        role: "user",
        content: "",
        attachments: [{
          id: "attachment-1",
          data: "abc123",
          filename: "screenshot.png",
          mimeType: "image/png",
          size: 6,
        }],
      }),
    ]);

    expect(prompt).toContain("User:\n[No text content]\n[1 image attachment referenced in the chat but not inlined here]");
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
