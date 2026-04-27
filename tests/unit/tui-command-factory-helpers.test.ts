import { describe, expect, test } from "bun:test";
import {
  buildCreateLoopRequest,
  buildCreateWorkspaceRequest,
  buildEntityCommandName,
  buildUpdateLoopRequest,
  buildUpdateWorkspaceRequest,
  getChatActionNames,
  getLoopActionNames,
} from "../../apps/tui/src/services/command-factory-helpers";

function expectConfigValidationError(fn: () => unknown, field?: string): void {
  try {
    fn();
    throw new Error("Expected ConfigValidationError to be thrown.");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ConfigValidationError");
    if (field !== undefined) {
      expect((error as Error & { field?: string }).field).toBe(field);
    }
  }
}

describe("tui command factory helpers", () => {
  test("buildCreateWorkspaceRequest maps ssh server settings", () => {
    const request = buildCreateWorkspaceRequest({
      name: "Demo",
      directory: "/workspaces/demo",
      agentProvider: "copilot",
      agentTransport: "ssh",
      hostname: "devbox",
      port: 22,
      username: "ralph",
      password: "",
      identityFile: "/keys/id_ed25519",
    });

    expect(request).toEqual({
      name: "Demo",
      directory: "/workspaces/demo",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "devbox",
          port: 22,
          username: "ralph",
          identityFile: "/keys/id_ed25519",
        },
      },
    });
  });

  test("buildCreateWorkspaceRequest rejects invalid ssh settings locally", () => {
    expectConfigValidationError(() => buildCreateWorkspaceRequest({
      name: "Demo",
      directory: "/workspaces/demo",
      agentProvider: "copilot",
      agentTransport: "ssh",
      hostname: "   ",
      port: 22,
      username: "ralph",
      password: "",
      identityFile: "",
    }), "hostname");

    expectConfigValidationError(() => buildCreateWorkspaceRequest({
      name: "Demo",
      directory: "/workspaces/demo",
      agentProvider: "copilot",
      agentTransport: "ssh",
      hostname: "devbox",
      port: 22.5,
      username: "ralph",
      password: "",
      identityFile: "",
    }), "port");
  });

  test("buildCreateLoopRequest preserves current loop defaults", () => {
    const request = buildCreateLoopRequest({
      workspace: "Demo (/workspaces/demo)",
      name: "Ship feature",
      prompt: "Implement the accepted plan.",
      modelProviderID: "anthropic",
      modelID: "claude-sonnet-4",
      modelVariant: "",
      cheapModelMode: "same-as-loop",
      cheapModelProviderID: "",
      cheapModelID: "",
      cheapModelVariant: "",
      baseBranch: "main",
      maxIterations: 0,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: 0,
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: true,
      fullyAutonomous: false,
      gitBranchPrefix: "",
      gitCommitScope: "",
    }, "workspace-1");

    expect(request).toMatchObject({
      workspaceId: "workspace-1",
      planMode: true,
      autoAcceptPlan: true,
      fullyAutonomous: false,
      maxIterations: null,
      activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>$",
      cheapModel: {
        mode: "same-as-loop",
      },
    });
  });

  test("buildUpdateLoopRequest supports custom cheap model selection", () => {
    const request = buildUpdateLoopRequest({
      name: "Ship feature",
      prompt: "Implement the accepted plan.",
      modelProviderID: "anthropic",
      modelID: "claude-sonnet-4",
      modelVariant: "",
      cheapModelMode: "custom",
      cheapModelProviderID: "openai",
      cheapModelID: "gpt-5-mini",
      cheapModelVariant: "fast",
      baseBranch: "main",
      maxIterations: 5,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: 120,
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: true,
      gitBranchPrefix: "team/",
      gitCommitScope: "tui",
    });

    expect(request.cheapModel).toEqual({
      mode: "custom",
      model: {
        providerID: "openai",
        modelID: "gpt-5-mini",
        variant: "fast",
      },
    });
    expect(request.fullyAutonomous).toBe(true);
    expect(request.autoAcceptPlan).toBe(true);
  });

  test("buildUpdateWorkspaceRequest rejects an empty trimmed name", () => {
    expectConfigValidationError(() => buildUpdateWorkspaceRequest({
      name: "   ",
      agentProvider: "copilot",
      agentTransport: "stdio",
      hostname: "",
      port: 22,
      username: "",
      password: "",
      identityFile: "",
    }), "name");
  });

  test("buildUpdateLoopRequest rejects empty required text fields", () => {
    expectConfigValidationError(() => buildUpdateLoopRequest({
      name: "   ",
      prompt: "Implement the accepted plan.",
      modelProviderID: "anthropic",
      modelID: "claude-sonnet-4",
      modelVariant: "",
      cheapModelMode: "same-as-loop",
      cheapModelProviderID: "",
      cheapModelID: "",
      cheapModelVariant: "",
      baseBranch: "main",
      maxIterations: 5,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: 120,
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: false,
      gitBranchPrefix: "",
      gitCommitScope: "",
    }), "name");

    expectConfigValidationError(() => buildUpdateLoopRequest({
      name: "Ship feature",
      prompt: "   ",
      modelProviderID: "anthropic",
      modelID: "claude-sonnet-4",
      modelVariant: "",
      cheapModelMode: "same-as-loop",
      cheapModelProviderID: "",
      cheapModelID: "",
      cheapModelVariant: "",
      baseBranch: "   ",
      maxIterations: 5,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: 120,
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: false,
      gitBranchPrefix: "",
      gitCommitScope: "",
    }), "prompt");
  });

  test("getLoopActionNames reflects lifecycle-specific actions", () => {
    expect(getLoopActionNames("planning")).toEqual([
      "info",
      "edit",
      "live",
      "stop",
      "set-pending",
      "clear-pending",
      "plan-feedback",
      "plan-accept",
      "plan-discard",
    ]);

    expect(getLoopActionNames("completed")).toEqual([
      "info",
      "edit",
      "live",
      "follow-up",
      "accept",
      "push",
      "discard",
    ]);

    expect(getLoopActionNames("pushed")).toEqual([
      "info",
      "edit",
      "live",
      "follow-up",
      "update-branch",
      "mark-merged",
      "purge",
    ]);
  });

  test("getChatActionNames exposes interrupt only for busy chats", () => {
    expect(getChatActionNames("streaming")).toEqual([
      "info",
      "edit",
      "live",
      "send",
      "delete",
      "interrupt",
    ]);

    expect(getChatActionNames("idle")).toEqual([
      "info",
      "edit",
      "live",
      "send",
      "delete",
      "reconnect",
    ]);
  });

  test("buildEntityCommandName creates a stable safe command name", () => {
    expect(buildEntityCommandName("Fix Auth Timeout", "12345678-1234")).toBe("fix-auth-timeout-123456");
  });
});
