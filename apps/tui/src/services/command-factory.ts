import {
  Command,
  type AnyCommand,
  type CommandResult,
  type OptionSchema,
  type OptionValues,
} from "@pablozaiden/terminatui";
import type { CreateLoopRequest } from "@ralpher/contracts";
import type { CreateSshServerRequest } from "@ralpher/contracts/schemas/ssh-server";
import type {
  Chat,
  Loop,
  SshServer,
  Workspace,
} from "@ralpher/shared";
import type { ReactNode } from "react";
import {
  buildCreateChatRequest,
  buildCreateLoopRequest,
  buildCreateServerRequest,
  buildCreateWorkspaceRequest,
  buildEntityCommandName,
  buildUpdateChatRequest,
  buildUpdateLoopRequest,
  buildUpdateServerRequest,
  buildUpdateWorkspaceRequest,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  getChatActionNames,
  getLoopActionNames,
  requireConfirmation,
  type ChatFormValues,
  type LoopFormValues,
  type LoopUpdateFormValues,
  type WorkspaceFormValues,
  type WorkspaceUpdateFormValues,
} from "./command-factory-helpers";
import type { ApiClient } from "./api-client";
import type { EntityCache } from "./entity-cache";
import {
  renderChatSummary,
  renderLiveResult,
  renderLoopSummary,
  renderServerSummary,
  renderWorkspaceSummary,
} from "../renderers/command-renderers";

const noOptions = {} as const satisfies OptionSchema;
type RootCollectionName = "servers" | "workspaces";

interface RefreshableCollection {
  command: AnyCommand;
  refresh: () => Promise<void>;
}

export class CommandFactory {
  private readonly collections = new Map<string, RefreshableCollection>();
  private readonly collectionErrors = new Map<string, string>();
  private readonly workspaceBranchDefaults = new Map<string, string>();

  constructor(
    private readonly apiClient: ApiClient,
    private readonly cache: EntityCache,
  ) {}

  async createRootCommands(): Promise<AnyCommand[]> {
    const servers = this.createServersCollection();
    const workspaces = this.createWorkspacesCollection();

    this.collections.set("servers", servers);
    this.collections.set("workspaces", workspaces);

    return [servers.command, workspaces.command];
  }

  async refreshCollections(...names: RootCollectionName[]): Promise<void> {
    const uniqueNames = [...new Set(names)];
    await Promise.all(uniqueNames.map(async (name) => {
      const collection = this.collections.get(name);
      if (collection) {
        await collection.refresh();
      }
    }));
  }

  private createServersCollection(): RefreshableCollection {
    const collectionName = "servers";
    let refresh = async () => {};
    const refreshCommand = this.createRefreshCommand("SSH servers", async () => {
      await refresh();
    });
    const loadErrorCommand = this.createCollectionLoadErrorCommand(collectionName, "SSH servers");
    const listCommand = this.createCommand({
      name: "list",
      displayName: "List",
      description: "Load and browse registered SSH servers.",
      options: noOptions,
      subCommands: [refreshCommand],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: "Use Refresh to load servers, then open one to manage it.",
        };
      },
    });
    const collectionCommand = this.createCommand({
      name: "servers",
      displayName: "Servers",
      description: "Browse the server area and load SSH servers on demand.",
      options: noOptions,
      subCommands: [this.createServerCreateCommand(), listCommand],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: "Open Servers to create a server or browse the loaded list.",
        };
      },
    });

    const rebuildListCommand = () => {
      const servers = this.cache.getCollection("servers");
      listCommand.subCommands = [
        refreshCommand,
        ...(this.collectionErrors.has(collectionName) ? [loadErrorCommand] : []),
        ...servers.map((server) => this.createServerEntityCommand(server)),
      ];
    };

    refresh = async () => {
      try {
        const servers = await this.apiClient.listServers();
        this.cache.setCollection(collectionName, servers);
        this.collectionErrors.delete(collectionName);
      } catch (error) {
        this.collectionErrors.set(collectionName, this.getErrorMessage(error));
        throw error;
      } finally {
        rebuildListCommand();
      }
    };

    rebuildListCommand();
    return { command: collectionCommand, refresh };
  }

  private createWorkspacesCollection(): RefreshableCollection {
    const collectionName = "workspaces";
    let refresh = async () => {};
    const refreshCommand = this.createRefreshCommand("workspaces", async () => {
      await refresh();
    });
    const loadErrorCommand = this.createCollectionLoadErrorCommand(collectionName, "workspaces");
    const listCommand = this.createCommand({
      name: "list",
      displayName: "List",
      description: "Load and browse registered workspaces.",
      options: noOptions,
      subCommands: [refreshCommand],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: "Use Refresh to load workspaces, then open one to browse its loops and chats.",
        };
      },
    });
    const collectionCommand = this.createCommand({
      name: "workspaces",
      displayName: "Workspaces",
      description: "Browse the workspace area and load workspaces on demand.",
      options: noOptions,
      subCommands: [this.createWorkspaceCreateCommand(), listCommand],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: "Open Workspaces to create a workspace or browse the loaded list.",
        };
      },
    });

    const rebuildListCommand = () => {
      const workspaces = this.cache.getCollection("workspaces");
      listCommand.subCommands = [
        refreshCommand,
        ...(this.collectionErrors.has(collectionName) ? [loadErrorCommand] : []),
        ...workspaces.map((workspace) => this.createWorkspaceEntityCommand(workspace)),
      ];
    };

    refresh = async () => {
      try {
        const workspaces = await this.apiClient.listWorkspaces();
        this.cache.setCollection(collectionName, workspaces);
        this.collectionErrors.delete(collectionName);
      } catch (error) {
        this.collectionErrors.set(collectionName, this.getErrorMessage(error));
        throw error;
      } finally {
        rebuildListCommand();
      }
    };

    rebuildListCommand();
    return { command: collectionCommand, refresh };
  }

  private createRefreshCommand(
    label: string,
    refresh: () => Promise<void>,
  ): AnyCommand {
    return this.createCommand({
      name: "refresh",
      displayName: "Refresh",
      description: `Refresh ${label}.`,
      options: noOptions,
      async execute(): Promise<CommandResult> {
        await refresh();
        return {
          success: true,
          message: `Refreshed ${label}.`,
        };
      },
    });
  }

  private createCollectionLoadErrorCommand(collectionName: string, label: string): AnyCommand {
    const factory = this;
    return this.createCommand({
      name: "load-error",
      displayName: "Load error",
      description: `Show the latest ${label} load error.`,
      options: noOptions,
      async execute(): Promise<CommandResult> {
        return {
          success: false,
          message: factory.collectionErrors.get(collectionName) ?? `${label} are ready to use.`,
        };
      },
    });
  }

  private createServerCreateCommand(): AnyCommand {
    const factory = this;
    const options = this.getServerOptions();
    return this.createCommand<typeof options, CreateSshServerRequest>({
      name: "create",
      displayName: "New",
      description: "Create a new SSH server.",
      options,
      actionLabel: "Create Server",
      buildConfig(values) {
        return buildCreateServerRequest(values);
      },
      async execute(values): Promise<CommandResult> {
        const server = await factory.apiClient.createServer(values);
        await factory.refreshCollections("servers");
        return {
          success: true,
          data: server,
          message: `Created server ${server.config.name}.`,
        };
      },
      renderResult: (result) => renderServerSummary(result.data as SshServer),
    });
  }

  private createServerEntityCommand(server: SshServer): AnyCommand {
    const factory = this;
    const editServerOptions = this.getServerOptions(server);
    return this.createCommand({
      name: buildEntityCommandName(server.config.name, server.config.id),
      displayName: server.config.name,
      description: `Actions for ${server.config.name}.`,
      options: noOptions,
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          data: await factory.apiClient.getServer(server.config.id),
        };
      },
      subCommands: [
        this.createCommand({
          name: "info",
          displayName: "Info",
          description: "Show server details.",
          options: noOptions,
          async execute(): Promise<CommandResult> {
            const freshServer = await factory.apiClient.getServer(server.config.id);
            return {
              success: true,
              data: freshServer,
            };
          },
          renderResult: (result) => renderServerSummary(result.data as SshServer),
        }),
        this.createCommand({
          name: "edit",
          displayName: "Edit",
          description: "Edit the server configuration.",
          options: editServerOptions,
          actionLabel: "Save Server",
          buildConfig(values) {
            return buildUpdateServerRequest(values);
          },
          async execute(values): Promise<CommandResult> {
            const updatedServer = await factory.apiClient.updateServer(server.config.id, values);
            await factory.refreshCollections("servers");
            return {
              success: true,
              data: updatedServer,
              message: `Updated server ${updatedServer.config.name}.`,
            };
          },
          renderResult: (result) => renderServerSummary(result.data as SshServer),
        }),
        this.createDestructiveCommand({
          name: "delete",
          displayName: "Delete",
          description: "Delete this server.",
          actionLabel: "Delete Server",
          async execute(): Promise<CommandResult> {
            await factory.apiClient.deleteServer(server.config.id);
            await factory.refreshCollections("servers");
            return {
              success: true,
              message: `Deleted server ${server.config.name}.`,
            };
          },
        }),
      ],
    });
  }

  private createWorkspaceCreateCommand(): AnyCommand {
    const factory = this;
    const options = this.getWorkspaceCreateOptions();
    return this.createCommand({
      name: "create",
      displayName: "New",
      description: "Create a new workspace.",
      options,
      actionLabel: "Create Workspace",
      buildConfig(values) {
        return buildCreateWorkspaceRequest(values as WorkspaceFormValues);
      },
      async execute(values): Promise<CommandResult> {
        const workspace = await factory.apiClient.createWorkspace(values);
        await factory.refreshCollections("workspaces");
        return {
          success: true,
          data: workspace,
          message: `Created workspace ${workspace.name}.`,
        };
      },
      renderResult: (result) => renderWorkspaceSummary(result.data as Workspace),
    });
  }

  private createWorkspaceEntityCommand(workspace: Workspace): AnyCommand {
    const factory = this;
    const editWorkspaceOptions = this.getWorkspaceUpdateOptions(workspace);
    const workspaceLabel = this.getWorkspaceLabel(workspace);
    const loopErrorKey = `workspace:${workspace.id}:loops`;
    const chatErrorKey = `workspace:${workspace.id}:chats`;
    let refreshLoops = async () => {};
    let refreshChats = async () => {};
    const loopRefreshCommand = this.createRefreshCommand(`loops for ${workspace.name}`, async () => {
      await refreshLoops();
    });
    const chatRefreshCommand = this.createRefreshCommand(`chats for ${workspace.name}`, async () => {
      await refreshChats();
    });
    const loopLoadErrorCommand = this.createCollectionLoadErrorCommand(loopErrorKey, `loops for ${workspace.name}`);
    const chatLoadErrorCommand = this.createCollectionLoadErrorCommand(chatErrorKey, `chats for ${workspace.name}`);
    const loopListCommand = this.createCommand({
      name: "list",
      displayName: "List",
      description: `Load and browse loops for ${workspace.name}.`,
      options: noOptions,
      subCommands: [loopRefreshCommand],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: `Use Refresh to load loops for ${workspace.name}.`,
        };
      },
    });
    const chatListCommand = this.createCommand({
      name: "list",
      displayName: "List",
      description: `Load and browse chats for ${workspace.name}.`,
      options: noOptions,
      subCommands: [chatRefreshCommand],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: `Use Refresh to load chats for ${workspace.name}.`,
        };
      },
    });
    const loopsCommand = this.createCommand({
      name: "loops",
      displayName: "Loops",
      description: `Create or browse loops in ${workspace.name}.`,
      options: noOptions,
      subCommands: [],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: `Open Loops to create a loop or browse the loaded list for ${workspace.name}.`,
        };
      },
    });
    const chatsCommand = this.createCommand({
      name: "chats",
      displayName: "Chats",
      description: `Create or browse chats in ${workspace.name}.`,
      options: noOptions,
      subCommands: [],
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          message: `Open Chats to create a chat or browse the loaded list for ${workspace.name}.`,
        };
      },
    });
    const rebuildLoopCommands = () => {
      const branchDefaults = {
        [workspaceLabel]: this.workspaceBranchDefaults.get(workspace.id) ?? "main",
      };
      const loops = this.cache.getCollection("loops").filter((loop) => loop.config.workspaceId === workspace.id);
      loopListCommand.subCommands = [
        loopRefreshCommand,
        ...(this.collectionErrors.has(loopErrorKey) ? [loopLoadErrorCommand] : []),
        ...loops.map((loop) => this.createLoopEntityCommand(loop, refreshLoops)),
      ];
      loopsCommand.subCommands = [
        this.createLoopCreateCommand([workspace], branchDefaults, refreshLoops),
        loopListCommand,
      ];
    };
    const rebuildChatCommands = () => {
      const branchDefaults = {
        [workspaceLabel]: this.workspaceBranchDefaults.get(workspace.id) ?? "main",
      };
      const chats = this.cache.getCollection("chats").filter((chat) => chat.config.workspaceId === workspace.id);
      chatListCommand.subCommands = [
        chatRefreshCommand,
        ...(this.collectionErrors.has(chatErrorKey) ? [chatLoadErrorCommand] : []),
        ...chats.map((chat) => this.createChatEntityCommand(chat, refreshChats)),
      ];
      chatsCommand.subCommands = [
        this.createChatCreateCommand([workspace], branchDefaults, refreshChats),
        chatListCommand,
      ];
    };

    refreshLoops = async () => {
      try {
        const [loops] = await Promise.all([
          this.apiClient.listLoops(),
          this.ensureWorkspaceBranchDefault(workspace),
        ]);
        this.cache.setCollection("loops", loops);
        this.collectionErrors.delete(loopErrorKey);
      } catch (error) {
        this.collectionErrors.set(loopErrorKey, this.getErrorMessage(error));
        throw error;
      } finally {
        rebuildLoopCommands();
      }
    };

    refreshChats = async () => {
      try {
        const [chats] = await Promise.all([
          this.apiClient.listChats(),
          this.ensureWorkspaceBranchDefault(workspace),
        ]);
        this.cache.setCollection("chats", chats);
        this.collectionErrors.delete(chatErrorKey);
      } catch (error) {
        this.collectionErrors.set(chatErrorKey, this.getErrorMessage(error));
        throw error;
      } finally {
        rebuildChatCommands();
      }
    };

    rebuildLoopCommands();
    rebuildChatCommands();

    return this.createCommand({
      name: buildEntityCommandName(workspace.name, workspace.id),
      displayName: workspace.name,
      description: `Actions for ${workspace.name}.`,
      options: noOptions,
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          data: await factory.apiClient.getWorkspace(workspace.id),
        };
      },
      subCommands: [
        this.createCommand({
          name: "info",
          displayName: "Info",
          description: "Show workspace details.",
          options: noOptions,
          async execute(): Promise<CommandResult> {
            const freshWorkspace = await factory.apiClient.getWorkspace(workspace.id);
            return {
              success: true,
              data: freshWorkspace,
            };
          },
          renderResult: (result) => renderWorkspaceSummary(result.data as Workspace),
        }),
        this.createCommand({
          name: "edit",
          displayName: "Edit",
          description: "Edit the workspace configuration.",
          options: editWorkspaceOptions,
          actionLabel: "Save Workspace",
          buildConfig(values) {
            return buildUpdateWorkspaceRequest(values as WorkspaceUpdateFormValues);
          },
          async execute(values): Promise<CommandResult> {
            const updatedWorkspace = await factory.apiClient.updateWorkspace(workspace.id, values);
            await factory.refreshCollections("workspaces");
            return {
              success: true,
              data: updatedWorkspace,
              message: `Updated workspace ${updatedWorkspace.name}.`,
            };
          },
          renderResult: (result) => renderWorkspaceSummary(result.data as Workspace),
        }),
        this.createDestructiveCommand({
          name: "delete",
          displayName: "Delete",
          description: "Delete this workspace.",
          actionLabel: "Delete Workspace",
          async execute(): Promise<CommandResult> {
            await factory.apiClient.deleteWorkspace(workspace.id);
            await factory.refreshCollections("workspaces");
            return {
              success: true,
              message: `Deleted workspace ${workspace.name}.`,
            };
          },
        }),
        loopsCommand,
        chatsCommand,
      ],
    });
  }

  private createLoopCreateCommand(
    workspaces: Workspace[],
    branchDefaults: Record<string, string>,
    refreshAfterMutation: () => Promise<void>,
  ): AnyCommand {
    const factory = this;
    const { labels, labelToId } = this.getWorkspaceChoices(workspaces);
    const options = this.getLoopOptions({
      workspaceLabels: labels,
      initialWorkspaceLabel: labels[0] ?? "",
      branchDefaults,
    });

    return this.createCommand<typeof options, CreateLoopRequest>({
      name: "create",
      displayName: "New",
      description: "Create a new loop.",
      options,
      actionLabel: "Create Loop",
      buildConfig(values) {
        const workspaceId = labelToId.get(values.workspace);
        if (!workspaceId) {
          throw new Error("Create a workspace first, then choose it here.");
        }
        return buildCreateLoopRequest(values as LoopFormValues, workspaceId);
      },
      onConfigChange(key, value) {
        if (key === "workspace") {
          const label = String(value);
          return {
            baseBranch: branchDefaults[label] ?? "",
          };
        }
        return undefined;
      },
      async execute(values): Promise<CommandResult> {
        const loop = await factory.apiClient.createLoop(values);
        await refreshAfterMutation();
        return {
          success: true,
          data: loop,
          message: `Created loop ${loop.config.name}.`,
        };
      },
      renderResult: (result) => renderLoopSummary(result.data as Loop),
    });
  }

  private createLoopEntityCommand(loop: Loop, refreshAfterMutation: () => Promise<void>): AnyCommand {
    const factory = this;
    const baseCommand = this.createCommand({
      name: buildEntityCommandName(loop.config.name, loop.config.id),
      displayName: loop.config.name,
      description: `Actions for ${loop.config.name}.`,
      options: noOptions,
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          data: await factory.apiClient.getLoop(loop.config.id),
        };
      },
    });

    const actionCommands = this.createLoopActionCommands(loop, refreshAfterMutation);
    baseCommand.subCommands = actionCommands;
    return baseCommand;
  }

  private createLoopActionCommands(loop: Loop, refreshAfterMutation: () => Promise<void>): AnyCommand[] {
    const factory = this;
    const actions = getLoopActionNames(loop.state.status);
    const commands: AnyCommand[] = [];
    const editLoopOptions = this.getLoopOptionsForExisting(loop);

    for (const actionName of actions) {
      switch (actionName) {
        case "info":
          commands.push(this.createCommand({
            name: "info",
            displayName: "Info",
            description: "Show loop details.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              const freshLoop = await factory.apiClient.getLoop(loop.config.id);
              return {
                success: true,
                data: freshLoop,
              };
            },
            renderResult: (result) => renderLoopSummary(result.data as Loop),
          }));
          break;
        case "edit":
          commands.push(this.createCommand({
            name: "edit",
            displayName: "Edit",
            description: "Edit loop configuration.",
            options: editLoopOptions,
            actionLabel: "Save Loop",
            buildConfig(values) {
              return buildUpdateLoopRequest(values as LoopUpdateFormValues);
            },
            async execute(values): Promise<CommandResult> {
              const updatedLoop = await factory.apiClient.updateLoop(
                loop.config.id,
                values,
                loop.state.status === "draft",
              );
              await refreshAfterMutation();
              return {
                success: true,
                data: updatedLoop,
                message: `Updated loop ${updatedLoop.config.name}.`,
              };
            },
            renderResult: (result) => renderLoopSummary(result.data as Loop),
          }));
          break;
        case "live":
          commands.push(this.createCommand({
            name: "live",
            displayName: "Live",
            description: "Watch live loop activity.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              return {
                success: true,
                data: {
                  kind: "loop",
                  id: loop.config.id,
                  title: loop.config.name,
                },
                message: `Watching ${loop.config.name}.`,
              };
            },
            renderResult: renderLiveResult,
          }));
          break;
        case "stop":
          commands.push(this.createCommand({
            name: "stop",
            displayName: "Stop",
            description: "Stop the active loop.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              await factory.apiClient.stopLoop(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Stopped loop ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "set-pending":
          commands.push(this.createCommand({
            name: "set-pending",
            displayName: "Set pending",
            description: "Inject a pending message or model override.",
            options: pendingOptions,
            actionLabel: "Set Pending",
            buildConfig(values) {
              const message = values.message.trim() ? values.message.trim() : null;
              const model = values.modelProviderID.trim() && values.modelID.trim()
                ? {
                    providerID: values.modelProviderID.trim(),
                    modelID: values.modelID.trim(),
                    variant: values.modelVariant.trim(),
                  }
                : null;

              if (message === null && model === null) {
                throw new Error("Provide a message or a model override.");
              }

              return { message, model };
            },
            async execute(values): Promise<CommandResult> {
              await factory.apiClient.setPending(loop.config.id, values);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Updated pending input for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "clear-pending":
          commands.push(this.createCommand({
            name: "clear-pending",
            displayName: "Clear pending",
            description: "Clear pending message and model overrides.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              await factory.apiClient.clearPending(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Cleared pending input for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "plan-feedback":
          commands.push(this.createCommand({
            name: "plan-feedback",
            displayName: "Plan feedback",
            description: "Send feedback for the active plan.",
            options: planFeedbackOptions,
            actionLabel: "Send Feedback",
            buildConfig(values) {
              const feedback = values.feedback.trim();
              if (!feedback) {
                throw new Error("feedback is required.");
              }
              return { feedback };
            },
            async execute(values): Promise<CommandResult> {
              await factory.apiClient.sendPlanFeedback(loop.config.id, values.feedback);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Sent plan feedback for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "plan-accept":
          commands.push(this.createCommand({
            name: "plan-accept",
            displayName: "Plan accept",
            description: "Accept the ready plan.",
            options: planAcceptOptions,
            actionLabel: "Accept Plan",
            buildConfig(values) {
              return { mode: values.mode as "start_loop" | "open_ssh" };
            },
            async execute(values): Promise<CommandResult> {
              const response = await factory.apiClient.acceptPlan(loop.config.id, values);
              await refreshAfterMutation();
              return {
                success: true,
                data: response,
                message: `Accepted the plan for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "plan-discard":
          commands.push(this.createDestructiveCommand({
            name: "plan-discard",
            displayName: "Plan discard",
            description: "Discard the current plan.",
            actionLabel: "Discard Plan",
            async execute(): Promise<CommandResult> {
              await factory.apiClient.discardPlan(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Discarded the plan for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "follow-up":
          commands.push(this.createCommand({
            name: "follow-up",
            displayName: "Follow up",
            description: "Start another feedback cycle from a terminal state.",
            options: followUpOptions,
            actionLabel: "Send Follow-up",
            buildConfig(values) {
              const message = values.message.trim();
              if (!message) {
                throw new Error("message is required.");
              }
              const model = values.modelProviderID.trim() && values.modelID.trim()
                ? {
                    providerID: values.modelProviderID.trim(),
                    modelID: values.modelID.trim(),
                    variant: values.modelVariant.trim(),
                  }
                : null;
              return { message, model };
            },
            async execute(values): Promise<CommandResult> {
              await factory.apiClient.followUpLoop(loop.config.id, values);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Started a follow-up cycle for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "accept":
          commands.push(this.createCommand({
            name: "accept",
            displayName: "Accept",
            description: "Accept the loop and merge its changes.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              const response = await factory.apiClient.acceptLoop(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                data: response,
                message: `Accepted loop ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "push":
          commands.push(this.createCommand({
            name: "push",
            displayName: "Push",
            description: "Push the loop branch to the remote.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              const response = await factory.apiClient.pushLoop(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                data: response,
                message: `Pushed loop ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "manual-complete":
          commands.push(this.createCommand({
            name: "manual-complete",
            displayName: "Manual complete",
            description: "Promote this loop to completed.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              await factory.apiClient.manualCompleteLoop(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Marked loop ${loop.config.name} as completed.`,
              };
            },
          }));
          break;
        case "discard":
          commands.push(this.createDestructiveCommand({
            name: "discard",
            displayName: "Discard",
            description: "Discard this loop and its branch.",
            actionLabel: "Discard Loop",
            async execute(): Promise<CommandResult> {
              await factory.apiClient.discardLoop(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Discarded loop ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "update-branch":
          commands.push(this.createCommand({
            name: "update-branch",
            displayName: "Update branch",
            description: "Sync this pushed branch with its base branch.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              const response = await factory.apiClient.updateLoopBranch(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                data: response,
                message: `Updated branch for ${loop.config.name}.`,
              };
            },
          }));
          break;
        case "mark-merged":
          commands.push(this.createCommand({
            name: "mark-merged",
            displayName: "Mark merged",
            description: "Mark this loop as merged.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              await factory.apiClient.markLoopMerged(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Marked loop ${loop.config.name} as merged.`,
              };
            },
          }));
          break;
        case "purge":
          commands.push(this.createDestructiveCommand({
            name: "purge",
            displayName: "Purge",
            description: "Permanently purge this loop.",
            actionLabel: "Purge Loop",
            async execute(): Promise<CommandResult> {
              await factory.apiClient.purgeLoop(loop.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Purged loop ${loop.config.name}.`,
              };
            },
          }));
          break;
        default:
          break;
      }
    }

    return commands;
  }

  private createChatCreateCommand(
    workspaces: Workspace[],
    branchDefaults: Record<string, string>,
    refreshAfterMutation: () => Promise<void>,
  ): AnyCommand {
    const factory = this;
    const { labels, labelToId } = this.getWorkspaceChoices(workspaces);
    const options = this.getChatOptions({
      workspaceLabels: labels,
      initialWorkspaceLabel: labels[0] ?? "",
      branchDefaults,
    });

    return this.createCommand<typeof options, ReturnType<typeof buildCreateChatRequest>>({
      name: "create",
      displayName: "New",
      description: "Create a new chat.",
      options,
      actionLabel: "Create Chat",
      buildConfig(values) {
        const workspaceId = labelToId.get(values.workspace);
        if (!workspaceId) {
          throw new Error("Create a workspace first, then choose it here.");
        }
        return buildCreateChatRequest(values, workspaceId);
      },
      onConfigChange(key, value) {
        if (key === "workspace") {
          const label = String(value);
          return {
            baseBranch: branchDefaults[label] ?? "",
          };
        }
        return undefined;
      },
      async execute(values): Promise<CommandResult> {
        const chat = await factory.apiClient.createChat(values);
        await refreshAfterMutation();
        return {
          success: true,
          data: chat,
          message: `Created chat ${chat.config.name}.`,
        };
      },
      renderResult: (result) => renderChatSummary(result.data as Chat),
    });
  }

  private createChatEntityCommand(chat: Chat, refreshAfterMutation: () => Promise<void>): AnyCommand {
    const factory = this;
    const baseCommand = this.createCommand({
      name: buildEntityCommandName(chat.config.name, chat.config.id),
      displayName: chat.config.name,
      description: `Actions for ${chat.config.name}.`,
      options: noOptions,
      async execute(): Promise<CommandResult> {
        return {
          success: true,
          data: await factory.apiClient.getChat(chat.config.id),
        };
      },
    });

    const commands: AnyCommand[] = [];
    const editChatOptions = this.getChatOptionsForExisting(chat);
    for (const actionName of getChatActionNames(chat.state.status)) {
      switch (actionName) {
        case "info":
          commands.push(this.createCommand({
            name: "info",
            displayName: "Info",
            description: "Show chat details.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              const freshChat = await factory.apiClient.getChat(chat.config.id);
              return {
                success: true,
                data: freshChat,
              };
            },
            renderResult: (result) => renderChatSummary(result.data as Chat),
          }));
          break;
        case "edit":
          commands.push(this.createCommand({
            name: "edit",
            displayName: "Edit",
            description: "Edit this chat.",
            options: editChatOptions,
            actionLabel: "Save Chat",
            buildConfig(values) {
              return buildUpdateChatRequest(values as Omit<ChatFormValues, "workspace">);
            },
            async execute(values): Promise<CommandResult> {
              const updatedChat = await factory.apiClient.updateChat(chat.config.id, values);
              await refreshAfterMutation();
              return {
                success: true,
                data: updatedChat,
                message: `Updated chat ${updatedChat.config.name}.`,
              };
            },
            renderResult: (result) => renderChatSummary(result.data as Chat),
          }));
          break;
        case "live":
          commands.push(this.createCommand({
            name: "live",
            displayName: "Live",
            description: "Watch live chat activity.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              return {
                success: true,
                data: {
                  kind: "chat",
                  id: chat.config.id,
                  title: chat.config.name,
                },
                message: `Watching ${chat.config.name}.`,
              };
            },
            renderResult: renderLiveResult,
          }));
          break;
        case "send":
          commands.push(this.createCommand({
            name: "send",
            displayName: "Send",
            description: "Send a message into the chat.",
            options: chatSendOptions,
            actionLabel: "Send Message",
            buildConfig(values) {
              const message = values.message.trim();
              if (!message) {
                throw new Error("message is required.");
              }
              return {
                message,
                attachments: [],
              };
            },
            async execute(values): Promise<CommandResult> {
              const updatedChat = await factory.apiClient.sendChatMessage(chat.config.id, values);
              await refreshAfterMutation();
              return {
                success: true,
                data: updatedChat,
                message: `Sent a message to ${chat.config.name}.`,
              };
            },
            renderResult: (result) => renderChatSummary(result.data as Chat),
          }));
          break;
        case "interrupt":
          commands.push(this.createCommand({
            name: "interrupt",
            displayName: "Interrupt",
            description: "Interrupt the current chat turn.",
            options: interruptOptions,
            actionLabel: "Interrupt Chat",
            buildConfig(values) {
              return {
                reason: values.reason.trim() || "user requested stop",
              };
            },
            async execute(values): Promise<CommandResult> {
              const updatedChat = await factory.apiClient.interruptChat(chat.config.id, values);
              await refreshAfterMutation();
              return {
                success: true,
                data: updatedChat,
                message: `Interrupted ${chat.config.name}.`,
              };
            },
            renderResult: (result) => renderChatSummary(result.data as Chat),
          }));
          break;
        case "reconnect":
          commands.push(this.createCommand({
            name: "reconnect",
            displayName: "Reconnect",
            description: "Reconnect this chat session.",
            options: noOptions,
            async execute(): Promise<CommandResult> {
              const updatedChat = await factory.apiClient.reconnectChat(chat.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                data: updatedChat,
                message: `Reconnected ${chat.config.name}.`,
              };
            },
            renderResult: (result) => renderChatSummary(result.data as Chat),
          }));
          break;
        case "delete":
          commands.push(this.createDestructiveCommand({
            name: "delete",
            displayName: "Delete",
            description: "Delete this chat.",
            actionLabel: "Delete Chat",
            async execute(): Promise<CommandResult> {
              await factory.apiClient.deleteChat(chat.config.id);
              await refreshAfterMutation();
              return {
                success: true,
                message: `Deleted chat ${chat.config.name}.`,
              };
            },
          }));
          break;
        default:
          break;
      }
    }

    baseCommand.subCommands = commands;
    return baseCommand;
  }

  private async ensureWorkspaceBranchDefault(workspace: Workspace): Promise<string> {
    const cachedDefault = this.workspaceBranchDefaults.get(workspace.id);
    if (cachedDefault) {
      return cachedDefault;
    }

    try {
      const defaultBranch = await this.apiClient.getDefaultBranch(workspace);
      this.workspaceBranchDefaults.set(workspace.id, defaultBranch);
      return defaultBranch;
    } catch {
      this.workspaceBranchDefaults.set(workspace.id, "main");
      return "main";
    }
  }

  private getWorkspaceChoices(workspaces: Workspace[]): {
    labels: string[];
    labelToId: Map<string, string>;
  } {
    const labelToId = new Map<string, string>();
    const labels = workspaces.map((workspace) => {
      const label = this.getWorkspaceLabel(workspace);
      labelToId.set(label, workspace.id);
      return label;
    });
    return { labels, labelToId };
  }

  private getWorkspaceLabel(workspace: Workspace): string {
    return `${workspace.name} (${workspace.directory})`;
  }

  private getServerOptions(server?: SshServer) {
    return {
      name: {
        type: "string",
        description: "Server name",
        label: "Name",
        order: 1,
        default: server?.config.name ?? "",
      },
      address: {
        type: "string",
        description: "Host or address",
        label: "Address",
        order: 2,
        default: server?.config.address ?? "",
      },
      username: {
        type: "string",
        description: "SSH username",
        label: "Username",
        order: 3,
        default: server?.config.username ?? "",
      },
      repositoriesBasePath: {
        type: "string",
        description: "Default repositories base path",
        label: "Repositories base path",
        order: 4,
        default: server?.config.repositoriesBasePath ?? "",
      },
    } as const satisfies OptionSchema;
  }

  private getWorkspaceCreateOptions(workspace?: Workspace) {
    const agent = workspace?.serverSettings.agent;
    return {
      name: {
        type: "string",
        description: "Workspace name",
        label: "Name",
        order: 1,
        default: workspace?.name ?? "",
      },
      directory: {
        type: "string",
        description: "Repository directory",
        label: "Directory",
        order: 2,
        default: workspace?.directory ?? "",
      },
      agentProvider: {
        type: "string",
        description: "Agent provider",
        label: "Provider",
        order: 3,
        enum: ["opencode", "copilot"],
        default: agent?.provider ?? "copilot",
      },
      agentTransport: {
        type: "string",
        description: "Agent transport",
        label: "Transport",
        order: 4,
        enum: ["ssh", "stdio"],
        default: agent?.transport ?? "ssh",
      },
      hostname: {
        type: "string",
        description: "SSH hostname",
        label: "Hostname",
        order: 5,
        default: agent?.transport === "ssh" ? agent.hostname : "localhost",
      },
      port: {
        type: "number",
        description: "SSH port",
        label: "Port",
        order: 6,
        default: agent?.transport === "ssh" ? (agent.port ?? 22) : 22,
      },
      username: {
        type: "string",
        description: "SSH username",
        label: "Username",
        order: 7,
        default: agent?.transport === "ssh" ? (agent.username ?? "") : "",
      },
      password: {
        type: "string",
        description: "SSH password",
        label: "Password",
        order: 8,
        default: agent?.transport === "ssh" ? (agent.password ?? "") : "",
      },
      identityFile: {
        type: "string",
        description: "SSH identity file",
        label: "Identity file",
        order: 9,
        default: agent?.transport === "ssh" ? (agent.identityFile ?? "") : "",
      },
    } as const satisfies OptionSchema;
  }

  private getWorkspaceUpdateOptions(workspace: Workspace) {
    const { directory: _directory, ...options } = this.getWorkspaceCreateOptions(workspace);
    return options;
  }

  private getLoopOptions({
    workspaceLabels,
    initialWorkspaceLabel,
    branchDefaults,
  }: {
    workspaceLabels: string[];
    initialWorkspaceLabel: string;
    branchDefaults: Record<string, string>;
  }) {
    return {
      workspace: {
        type: "string",
        description: "Workspace",
        label: "Workspace",
        order: 1,
        enum: workspaceLabels,
        default: initialWorkspaceLabel,
      },
      name: {
        type: "string",
        description: "Loop name",
        label: "Name",
        order: 2,
        default: "",
      },
      prompt: {
        type: "string",
        description: "Loop prompt",
        label: "Prompt",
        order: 3,
        default: "",
      },
      modelProviderID: {
        type: "string",
        description: "Model provider ID",
        label: "Model provider",
        order: 4,
        default: "",
      },
      modelID: {
        type: "string",
        description: "Model ID",
        label: "Model ID",
        order: 5,
        default: "",
      },
      modelVariant: {
        type: "string",
        description: "Model variant",
        label: "Model variant",
        order: 6,
        default: "",
      },
      cheapModelMode: {
        type: "string",
        description: "Cheap model selection mode",
        label: "Cheap model mode",
        order: 7,
        enum: ["same-as-loop", "custom"],
        default: "same-as-loop",
      },
      cheapModelProviderID: {
        type: "string",
        description: "Cheap model provider ID",
        label: "Cheap model provider",
        order: 8,
        default: "",
      },
      cheapModelID: {
        type: "string",
        description: "Cheap model ID",
        label: "Cheap model ID",
        order: 9,
        default: "",
      },
      cheapModelVariant: {
        type: "string",
        description: "Cheap model variant",
        label: "Cheap model variant",
        order: 10,
        default: "",
      },
      baseBranch: {
        type: "string",
        description: "Base branch",
        label: "Base branch",
        order: 11,
        default: branchDefaults[initialWorkspaceLabel] ?? "",
      },
      maxIterations: {
        type: "number",
        description: "Maximum iterations (0 for unlimited)",
        label: "Max iterations",
        order: 12,
        default: 0,
      },
      maxConsecutiveErrors: {
        type: "number",
        description: "Maximum consecutive identical errors",
        label: "Max consecutive errors",
        order: 13,
        default: DEFAULT_MAX_CONSECUTIVE_ERRORS,
      },
      activityTimeoutSeconds: {
        type: "number",
        description: "Activity timeout in seconds (0 for none)",
        label: "Activity timeout",
        order: 14,
        default: 0,
      },
      useWorktree: {
        type: "boolean",
        description: "Use a git worktree",
        label: "Use worktree",
        order: 15,
        default: true,
      },
      clearPlanningFolder: {
        type: "boolean",
        description: "Clear .ralph-planning before start",
        label: "Clear planning folder",
        order: 16,
        default: false,
      },
      planMode: {
        type: "boolean",
        description: "Start in plan mode",
        label: "Plan mode",
        order: 17,
        default: true,
      },
      autoAcceptPlan: {
        type: "boolean",
        description: "Auto-accept ready plans",
        label: "Auto-accept plan",
        order: 18,
        default: true,
      },
      fullyAutonomous: {
        type: "boolean",
        description: "Continue through autonomous post-plan flow",
        label: "Fully autonomous",
        order: 19,
        default: false,
      },
      gitBranchPrefix: {
        type: "string",
        description: "Git branch prefix",
        label: "Git branch prefix",
        order: 20,
        default: "",
      },
      gitCommitScope: {
        type: "string",
        description: "Git commit scope",
        label: "Git commit scope",
        order: 21,
        default: "",
      },
    } as const satisfies OptionSchema;
  }

  private getLoopOptionsForExisting(loop: Loop) {
    return {
      name: {
        type: "string",
        description: "Loop name",
        label: "Name",
        order: 1,
        default: loop.config.name,
      },
      prompt: {
        type: "string",
        description: "Loop prompt",
        label: "Prompt",
        order: 2,
        default: loop.config.prompt,
      },
      modelProviderID: {
        type: "string",
        description: "Model provider ID",
        label: "Model provider",
        order: 3,
        default: loop.config.model.providerID,
      },
      modelID: {
        type: "string",
        description: "Model ID",
        label: "Model ID",
        order: 4,
        default: loop.config.model.modelID,
      },
      modelVariant: {
        type: "string",
        description: "Model variant",
        label: "Model variant",
        order: 5,
        default: loop.config.model.variant ?? "",
      },
      cheapModelMode: {
        type: "string",
        description: "Cheap model selection mode",
        label: "Cheap model mode",
        order: 6,
        enum: ["same-as-loop", "custom"],
        default: loop.config.cheapModel?.mode ?? "same-as-loop",
      },
      cheapModelProviderID: {
        type: "string",
        description: "Cheap model provider ID",
        label: "Cheap model provider",
        order: 7,
        default: loop.config.cheapModel?.mode === "custom" ? loop.config.cheapModel.model.providerID : "",
      },
      cheapModelID: {
        type: "string",
        description: "Cheap model ID",
        label: "Cheap model ID",
        order: 8,
        default: loop.config.cheapModel?.mode === "custom" ? loop.config.cheapModel.model.modelID : "",
      },
      cheapModelVariant: {
        type: "string",
        description: "Cheap model variant",
        label: "Cheap model variant",
        order: 9,
        default: loop.config.cheapModel?.mode === "custom" ? (loop.config.cheapModel.model.variant ?? "") : "",
      },
      baseBranch: {
        type: "string",
        description: "Base branch",
        label: "Base branch",
        order: 10,
        default: loop.config.baseBranch ?? "",
      },
      maxIterations: {
        type: "number",
        description: "Maximum iterations (0 for unlimited)",
        label: "Max iterations",
        order: 11,
        default: Number.isFinite(loop.config.maxIterations) ? loop.config.maxIterations : 0,
      },
      maxConsecutiveErrors: {
        type: "number",
        description: "Maximum consecutive identical errors",
        label: "Max consecutive errors",
        order: 12,
        default: loop.config.maxConsecutiveErrors,
      },
      activityTimeoutSeconds: {
        type: "number",
        description: "Activity timeout in seconds (0 for none)",
        label: "Activity timeout",
        order: 13,
        default: loop.config.activityTimeoutSeconds ?? 0,
      },
      useWorktree: {
        type: "boolean",
        description: "Use a git worktree",
        label: "Use worktree",
        order: 14,
        default: loop.config.useWorktree,
      },
      clearPlanningFolder: {
        type: "boolean",
        description: "Clear .ralph-planning before start",
        label: "Clear planning folder",
        order: 15,
        default: loop.config.clearPlanningFolder,
      },
      planMode: {
        type: "boolean",
        description: "Start in plan mode",
        label: "Plan mode",
        order: 16,
        default: loop.config.planMode,
      },
      autoAcceptPlan: {
        type: "boolean",
        description: "Auto-accept ready plans",
        label: "Auto-accept plan",
        order: 17,
        default: loop.config.autoAcceptPlan ?? false,
      },
      fullyAutonomous: {
        type: "boolean",
        description: "Continue through autonomous post-plan flow",
        label: "Fully autonomous",
        order: 18,
        default: loop.config.fullyAutonomous ?? false,
      },
      gitBranchPrefix: {
        type: "string",
        description: "Git branch prefix",
        label: "Git branch prefix",
        order: 19,
        default: loop.config.git.branchPrefix,
      },
      gitCommitScope: {
        type: "string",
        description: "Git commit scope",
        label: "Git commit scope",
        order: 20,
        default: loop.config.git.commitScope,
      },
    } as const satisfies OptionSchema;
  }

  private getChatOptions({
    workspaceLabels,
    initialWorkspaceLabel,
    branchDefaults,
  }: {
    workspaceLabels: string[];
    initialWorkspaceLabel: string;
    branchDefaults: Record<string, string>;
  }) {
    return {
      workspace: {
        type: "string",
        description: "Workspace",
        label: "Workspace",
        order: 1,
        enum: workspaceLabels,
        default: initialWorkspaceLabel,
      },
      name: {
        type: "string",
        description: "Chat name",
        label: "Name",
        order: 2,
        default: "",
      },
      modelProviderID: {
        type: "string",
        description: "Model provider ID",
        label: "Model provider",
        order: 3,
        default: "",
      },
      modelID: {
        type: "string",
        description: "Model ID",
        label: "Model ID",
        order: 4,
        default: "",
      },
      modelVariant: {
        type: "string",
        description: "Model variant",
        label: "Model variant",
        order: 5,
        default: "",
      },
      baseBranch: {
        type: "string",
        description: "Base branch",
        label: "Base branch",
        order: 6,
        default: branchDefaults[initialWorkspaceLabel] ?? "",
      },
      useWorktree: {
        type: "boolean",
        description: "Use a git worktree",
        label: "Use worktree",
        order: 7,
        default: true,
      },
    } as const satisfies OptionSchema;
  }

  private getChatOptionsForExisting(chat: Chat) {
    return {
      name: {
        type: "string",
        description: "Chat name",
        label: "Name",
        order: 1,
        default: chat.config.name,
      },
      modelProviderID: {
        type: "string",
        description: "Model provider ID",
        label: "Model provider",
        order: 2,
        default: chat.config.model.providerID,
      },
      modelID: {
        type: "string",
        description: "Model ID",
        label: "Model ID",
        order: 3,
        default: chat.config.model.modelID,
      },
      modelVariant: {
        type: "string",
        description: "Model variant",
        label: "Model variant",
        order: 4,
        default: chat.config.model.variant ?? "",
      },
      baseBranch: {
        type: "string",
        description: "Base branch",
        label: "Base branch",
        order: 5,
        default: chat.config.baseBranch ?? "",
      },
      useWorktree: {
        type: "boolean",
        description: "Use a git worktree",
        label: "Use worktree",
        order: 6,
        default: chat.config.useWorktree,
      },
    } as const satisfies OptionSchema;
  }

  private createDestructiveCommand(spec: {
    name: string;
    displayName: string;
    description: string;
    actionLabel: string;
    execute: () => Promise<CommandResult>;
  }): AnyCommand {
    const options = destructiveOptions;
    return this.createCommand({
      ...spec,
      options,
      buildConfig(values) {
        requireConfirmation(values.confirm, spec.displayName.toLowerCase());
        return values;
      },
      async execute(): Promise<CommandResult> {
        return await spec.execute();
      },
    });
  }

  private createCommand<TOptions extends OptionSchema, TConfig = OptionValues<TOptions>>(spec: {
    name: string;
    displayName: string;
    description: string;
    options: TOptions;
    actionLabel?: string;
    buildConfig?: (values: OptionValues<TOptions>) => TConfig;
    execute: (config: TConfig) => Promise<CommandResult>;
    renderResult?: (result: CommandResult) => ReactNode;
    onConfigChange?: (
      key: string,
      value: unknown,
      allValues: Record<string, unknown>,
    ) => Record<string, unknown> | undefined;
    subCommands?: AnyCommand[];
  }): AnyCommand {
    return new class extends Command<TOptions, TConfig> {
      override readonly name = spec.name;
      override readonly displayName = spec.displayName;
      override readonly description = spec.description;
      override readonly options = spec.options;
      override readonly actionLabel = spec.actionLabel;
      override subCommands = spec.subCommands;
      override buildConfig = spec.buildConfig;
      override onConfigChange = spec.onConfigChange;
      override async execute(config: TConfig): Promise<CommandResult> {
        return await spec.execute(config);
      }
      override renderResult(result: CommandResult): ReactNode {
        return spec.renderResult?.(result);
      }
    }();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

const pendingOptions = {
  message: {
    type: "string",
    description: "Pending message",
    label: "Message",
    order: 1,
    default: "",
  },
  modelProviderID: {
    type: "string",
    description: "Optional model provider override",
    label: "Model provider",
    order: 2,
    default: "",
  },
  modelID: {
    type: "string",
    description: "Optional model ID override",
    label: "Model ID",
    order: 3,
    default: "",
  },
  modelVariant: {
    type: "string",
    description: "Optional model variant override",
    label: "Model variant",
    order: 4,
    default: "",
  },
} as const satisfies OptionSchema;

const followUpOptions = {
  message: {
    type: "string",
    description: "Follow-up message",
    label: "Message",
    order: 1,
    default: "",
  },
  modelProviderID: {
    type: "string",
    description: "Optional model provider override",
    label: "Model provider",
    order: 2,
    default: "",
  },
  modelID: {
    type: "string",
    description: "Optional model ID override",
    label: "Model ID",
    order: 3,
    default: "",
  },
  modelVariant: {
    type: "string",
    description: "Optional model variant override",
    label: "Model variant",
    order: 4,
    default: "",
  },
} as const satisfies OptionSchema;

const planFeedbackOptions = {
  feedback: {
    type: "string",
    description: "Plan feedback",
    label: "Feedback",
    order: 1,
    default: "",
  },
} as const satisfies OptionSchema;

const planAcceptOptions = {
  mode: {
    type: "string",
    description: "Plan acceptance mode",
    label: "Mode",
    order: 1,
    enum: ["start_loop", "open_ssh"],
    default: "start_loop",
  },
} as const satisfies OptionSchema;

const chatSendOptions = {
  message: {
    type: "string",
    description: "Chat message",
    label: "Message",
    order: 1,
    default: "",
  },
} as const satisfies OptionSchema;

const interruptOptions = {
  reason: {
    type: "string",
    description: "Interrupt reason",
    label: "Reason",
    order: 1,
    default: "user requested stop",
  },
} as const satisfies OptionSchema;

const destructiveOptions = {
  confirm: {
    type: "boolean",
    description: "Confirm this destructive action",
    label: "Confirm destructive action",
    order: 1,
    default: false,
  },
} as const satisfies OptionSchema;
