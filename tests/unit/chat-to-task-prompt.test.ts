import { describe, expect, test } from "bun:test";
import type { PersistedMessage } from "@/types/task";
import {
  buildSpawnCurrentPlanPrompt,
  buildSpawnTaskNameFromChat,
  buildSpawnTaskNameFromCurrentPlan,
  buildSpawnTaskPrompt,
} from "@/utils/chat-to-task-prompt";

function createMessage(overrides: Partial<PersistedMessage>): PersistedMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    role: overrides.role ?? "user",
    content: overrides.content ?? "Message content",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    attachments: overrides.attachments,
  };
}

describe("chat-to-task-prompt", () => {
  test("builds a task prompt from the full chat transcript", () => {
    const prompt = buildSpawnTaskPrompt("Repo pairing", [
      createMessage({ role: "user", content: "Investigate why the reconnect flow is flaky." }),
      createMessage({ role: "assistant", content: "The race looks related to the websocket reconnect guard." }),
      createMessage({ role: "user", content: "Turn this into a concrete implementation plan." }),
    ]);

    expect(prompt).toContain("You are creating a new Clanky plan task from an existing chat conversation.");
    expect(prompt).toContain("Chat title: Repo pairing");
    expect(prompt).toContain("User:\nInvestigate why the reconnect flow is flaky.");
    expect(prompt).toContain("Assistant:\nThe race looks related to the websocket reconnect guard.");
    expect(prompt).toContain("User:\nTurn this into a concrete implementation plan.");
    expect(prompt).toContain("Only the user and assistant messages are included here; tool calls and hidden reasoning are intentionally excluded.");
    expect(prompt).toContain("Infer the final goal from the entire conversation");
  });

  test("keeps earlier transcript turns when the full transcript fits the prompt budget", () => {
    const earliestMessage = "A".repeat(13_000);
    const prompt = buildSpawnTaskPrompt("Long conversation", [
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
    const prompt = buildSpawnTaskPrompt("Oversized conversation", [
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

    expect(prompt).toContain("[Earlier message compacted to stay within the spawned task prompt budget.]");
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
    const prompt = buildSpawnTaskPrompt("Massive conversation", [
      ...transcript,
      createMessage({ role: "user", content: "Use the latest decision and write the implementation plan." }),
    ]);

    expect(prompt).toContain("Earlier transcript summary:");
    expect(prompt).toContain("older messages summarized to keep the spawned task prompt within size limits.");
    expect(prompt).toContain("and 1 image attachment reference.");
    expect(prompt).toContain("Use the latest decision and write the implementation plan.");
    expect(prompt).not.toContain("Message 0:");
  });

  test("mentions image attachments without inlining them into the transcript", () => {
    const prompt = buildSpawnTaskPrompt("Attachment chat", [
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
    expect(() => buildSpawnTaskPrompt("Empty chat", [
      createMessage({ content: "   " }),
    ])).toThrow("Chat transcript is empty. Send at least one message before spawning a task.");
  });

  test("builds a task name from the chat goal instead of the chat title", () => {
    const name = buildSpawnTaskNameFromChat("Generic pairing chat", [
      createMessage({ role: "user", content: "Investigate why workspace reconnects drop pending websocket events." }),
      createMessage({ role: "assistant", content: "The reconnect guard is racing with event replay." }),
      createMessage({ role: "user", content: "Turn this into a concrete implementation plan." }),
    ]);

    expect(name).toBe("Investigate why workspace reconnects drop pending websocket events");
    expect(name).not.toContain("Generic pairing chat");
    expect(name).not.toContain("Plan from");
  });

  test("builds a current-plan task name from the selected plan content", () => {
    const name = buildSpawnTaskNameFromCurrentPlan("Generic plan chat", [
      createMessage({ role: "user", content: "Turn this into a plan-ready task." }),
    ], "\uFEFF# Fix reconnect event replay\n\n1. Preserve pending events.\n\n<promise>PLAN_READY</promise>");

    expect(name).toBe("Fix reconnect event replay");
    expect(name).not.toContain("Generic plan chat");
    expect(name).not.toContain("PLAN_READY");
  });

  test("bounds generated task names", () => {
    const name = buildSpawnTaskNameFromChat("Fallback chat", [
      createMessage({ content: `Improve ${"workspace ".repeat(30)}handoff reliability` }),
    ]);

    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.startsWith("Improve workspace")).toBe(true);
  });

  test("falls back to the chat title without the old fixed prefix for low-signal content", () => {
    const name = buildSpawnTaskNameFromChat("Meaningful Chat Name", [
      createMessage({ content: "Turn this into a concrete implementation plan." }),
    ]);

    expect(name).toBe("Meaningful Chat Name");
    expect(name).not.toContain("Plan from");
  });

  test("builds a concise prompt for current-plan spawning", () => {
    expect(buildSpawnCurrentPlanPrompt()).toBe("Implement the existing plan in .clanky-planning/plan.md.");
  });
});
