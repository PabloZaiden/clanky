import { describe, expect, test } from "bun:test";
import { agentRunner } from "../../src/core/agent-runner";
import type { AgentRun } from "@/shared/agent";

function createRunWithoutChatId(): AgentRun {
  const now = new Date("2026-01-01T00:00:00Z").toISOString();
  return {
    id: "run-without-chat-id",
    agentId: "agent-1",
    status: "running",
    trigger: "manual",
    scheduledFor: now,
    startedAt: now,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    configSnapshot: {
      name: "Agent",
      workspaceId: "workspace-1",
      directory: "/workspace",
      prompt: "Run",
      model: {
        providerID: "test-provider",
        modelID: "test-model",
        variant: "",
      },
      useWorktree: false,
      schedule: {
        startAtLocal: "2026-01-01T00:00",
        timezone: "UTC",
        interval: {
          value: 1,
          unit: "hours",
        },
        nextRunAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("AgentRunner", () => {
  test("does not fall back to run id when interrupting without a chat id", async () => {
    await expect(agentRunner.interruptRun(createRunWithoutChatId())).rejects.toThrow(
      "cannot be interrupted because its chat has not been created yet",
    );
  });
});
