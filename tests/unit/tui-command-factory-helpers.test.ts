import { describe, expect, test } from "bun:test";
import { CommandFactory } from "../../apps/tui/src/services/command-factory";
import {
  buildCreateLoopRequest,
  buildCreateWorkspaceRequest,
  buildEntityCommandName,
  buildUpdateLoopRequest,
  buildUpdateWorkspaceRequest,
  getChatActionNames,
  getLoopActionNames,
} from "../../apps/tui/src/services/command-factory-helpers";
import { EntityCache } from "../../apps/tui/src/services/entity-cache";
import type { ApiClient } from "../../apps/tui/src/services/api-client";

function createFailingStartupApiClient(message: string): ApiClient {
  const fail = async () => {
    throw new Error(message);
  };

  return {
    listServers: fail,
    listWorkspaces: fail,
    listLoops: fail,
    listChats: fail,
  } as ApiClient;
}

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

  test("createRootCommands keeps startup lazy and only exposes top-level collections", async () => {
    const factory = new CommandFactory(
      createFailingStartupApiClient("Unable to connect to the configured Ralpher backend."),
      new EntityCache(),
    );

    const commands = await factory.createRootCommands();
    const serversCommand = commands.find((command) => command.name === "servers");
    const workspacesCommand = commands.find((command) => command.name === "workspaces");

    expect(commands.map((command) => command.name)).toEqual([
      "servers",
      "workspaces",
    ]);
    expect(serversCommand?.subCommands?.map((command) => command.name)).toEqual([
      "create",
      "list",
    ]);
    expect(workspacesCommand?.subCommands?.map((command) => command.name)).toEqual([
      "create",
      "list",
    ]);

    const serversListCommand = serversCommand?.subCommands?.find((command) => command.name === "list");
    expect(serversListCommand?.subCommands?.map((command) => command.name)).toEqual([
      "refresh",
    ]);

    await expect(serversListCommand?.subCommands?.[0]?.execute({})).rejects.toThrow(
      "Unable to connect to the configured Ralpher backend.",
    );

    const loadErrorCommand = serversListCommand?.subCommands?.find((command) => command.name === "load-error");
    const loadErrorResult = await loadErrorCommand?.execute({});
    expect(loadErrorResult).toMatchObject({
      success: false,
      message: "Unable to connect to the configured Ralpher backend.",
    });
  });

  test("workspace navigation nests loops and chats under the workspace list hierarchy", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Demo",
      directory: "/workspaces/demo",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "stdio",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const loop = {
      config: {
        id: "loop-1",
        name: "Ship feature",
        directory: "/workspaces/demo",
        prompt: "Implement it",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        workspaceId: "workspace-1",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          variant: "",
        },
        useWorktree: true,
        autoAcceptPlan: false,
        fullyAutonomous: false,
        planMode: true,
        gitBranchPrefix: "",
        gitCommitScope: "",
        clearPlanningFolder: false,
        cheapModel: {
          mode: "same-as-loop",
        },
        baseBranch: "main",
        maxIterations: null,
        activityTimeoutSeconds: null,
        git: {
          branchPrefix: "",
          commitScope: "",
        },
        maxConsecutiveErrors: 10,
      },
      state: {
        status: "draft",
      },
    } as const;
    const chat = {
      config: {
        id: "chat-1",
        name: "Investigate",
        workspaceId: "workspace-1",
        directory: "/workspaces/demo",
        prompt: "Take a look",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          variant: "",
        },
        useWorktree: true,
        baseBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        mode: "chat",
      },
      state: {
        status: "idle",
      },
    } as const;
    const apiClient = {
      listWorkspaces: async () => [workspace],
      listLoops: async () => [loop],
      listChats: async () => [chat],
      getDefaultBranch: async () => "main",
    } as ApiClient;
    const factory = new CommandFactory(apiClient, new EntityCache());

    const commands = await factory.createRootCommands();
    const workspacesCommand = commands.find((command) => command.name === "workspaces");
    const workspacesListCommand = workspacesCommand?.subCommands?.find((command) => command.name === "list");
    await workspacesListCommand?.subCommands?.[0]?.execute({});

    const workspaceCommand = workspacesListCommand?.subCommands?.find((command) => command.name !== "refresh");
    expect(workspaceCommand?.subCommands?.map((command) => command.name)).toEqual([
      "info",
      "edit",
      "delete",
      "loops",
      "chats",
    ]);

    const loopsCommand = workspaceCommand?.subCommands?.find((command) => command.name === "loops");
    const chatsCommand = workspaceCommand?.subCommands?.find((command) => command.name === "chats");
    expect(loopsCommand?.subCommands?.map((command) => command.name)).toEqual([
      "create",
      "list",
    ]);
    expect(chatsCommand?.subCommands?.map((command) => command.name)).toEqual([
      "create",
      "list",
    ]);

    const loopsListCommand = loopsCommand?.subCommands?.find((command) => command.name === "list");
    await loopsListCommand?.subCommands?.[0]?.execute({});
    expect(loopsListCommand?.subCommands?.map((command) => command.name)).toEqual([
      "refresh",
      "ship-feature-loop-1",
    ]);

    const chatsListCommand = chatsCommand?.subCommands?.find((command) => command.name === "list");
    await chatsListCommand?.subCommands?.[0]?.execute({});
    expect(chatsListCommand?.subCommands?.map((command) => command.name)).toEqual([
      "refresh",
      "investigate-chat-1",
    ]);
  });
});
