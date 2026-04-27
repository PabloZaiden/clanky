import { AppContext, type CommandResult } from "@pablozaiden/terminatui";
import type { Chat, ChatEvent, Loop, LoopEvent, SshServer, Workspace } from "@ralpher/shared";
import { useEffect, useState, type ReactNode } from "react";
import type { WsClient } from "../services/ws-client";

interface LiveResultData {
  kind: "loop" | "chat";
  id: string;
  title: string;
}

export function renderStatusSummary(result: CommandResult): string {
  const data = result.data as {
    baseUrl: string;
    servers: number;
    workspaces: number;
    loops: number;
    chats: number;
  };

  return [
    "Ralpher TUI status",
    "",
    `Base URL: ${data.baseUrl}`,
    `Servers: ${String(data.servers)}`,
    `Workspaces: ${String(data.workspaces)}`,
    `Loops: ${String(data.loops)}`,
    `Chats: ${String(data.chats)}`,
  ].join("\n");
}

export function renderServerSummary(server: SshServer): string {
  return [
    `Server: ${server.config.name}`,
    "",
    `ID: ${server.config.id}`,
    `Address: ${server.config.address}`,
    `Username: ${server.config.username}`,
    `Repositories base path: ${server.config.repositoriesBasePath ?? "(not set)"}`,
    `Created: ${server.config.createdAt}`,
    `Updated: ${server.config.updatedAt}`,
  ].join("\n");
}

export function renderWorkspaceSummary(workspace: Workspace): string {
  const agent = workspace.serverSettings.agent;
  return [
    `Workspace: ${workspace.name}`,
    "",
    `ID: ${workspace.id}`,
    `Directory: ${workspace.directory}`,
    `Provider: ${agent.provider}`,
    `Transport: ${agent.transport}`,
    ...(agent.transport === "ssh"
      ? [
          `Hostname: ${agent.hostname}`,
          `Port: ${String(agent.port ?? 22)}`,
          `Username: ${agent.username ?? "(not set)"}`,
        ]
      : []),
    `Created: ${workspace.createdAt}`,
    `Updated: ${workspace.updatedAt}`,
  ].join("\n");
}

export function renderLoopSummary(loop: Loop): string {
  return [
    `Loop: ${loop.config.name}`,
    "",
    `ID: ${loop.config.id}`,
    `Status: ${loop.state.status}`,
    `Workspace ID: ${loop.config.workspaceId}`,
    `Directory: ${loop.config.directory}`,
    `Model: ${formatModel(loop.config.model)}`,
    `Base branch: ${loop.config.baseBranch ?? "(not set)"}`,
    `Use worktree: ${String(loop.config.useWorktree)}`,
    `Plan mode: ${String(loop.config.planMode)}`,
    `Auto-accept plan: ${String(loop.config.autoAcceptPlan ?? false)}`,
    `Fully autonomous: ${String(loop.config.fullyAutonomous ?? false)}`,
    "",
    "Prompt",
    "------",
    loop.config.prompt,
  ].join("\n");
}

export function renderChatSummary(chat: Chat): string {
  return [
    `Chat: ${chat.config.name}`,
    "",
    `ID: ${chat.config.id}`,
    `Status: ${chat.state.status}`,
    `Workspace ID: ${chat.config.workspaceId}`,
    `Directory: ${chat.config.directory}`,
    `Model: ${formatModel(chat.config.model)}`,
    `Base branch: ${chat.config.baseBranch ?? "(not set)"}`,
    `Use worktree: ${String(chat.config.useWorktree)}`,
    `Messages: ${String(chat.state.messages.length)}`,
    `Logs: ${String(chat.state.logs.length)}`,
    `Tool calls: ${String(chat.state.toolCalls.length)}`,
  ].join("\n");
}

export function renderLiveResult(result: CommandResult): ReactNode {
  const data = result.data as LiveResultData;
  return <LiveStream kind={data.kind} id={data.id} title={data.title} />;
}

function LiveStream(props: LiveResultData): ReactNode {
  const wsClient = AppContext.current.requireService<WsClient>("wsClient");
  const [lines, setLines] = useState<string[]>([
    `Watching ${props.title}...`,
    "Press Escape to leave this view.",
  ]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let active = true;

    const appendLine = (line: string) => {
      setLines((current) => [...current.slice(-199), line]);
    };

    const subscribe = async () => {
      try {
        cleanup = props.kind === "loop"
          ? await wsClient.subscribeLoop(props.id, {
              onOpen: () => appendLine("Connected."),
              onEvent: (event: LoopEvent) => appendLine(formatLoopEvent(event)),
              onError: (error: Error) => appendLine(`Error: ${error.message}`),
              onClose: (result) => appendLine(`Closed (${String(result.code)}${result.reason ? `: ${result.reason}` : ""}).`),
            })
          : await wsClient.subscribeChat(props.id, {
              onOpen: () => appendLine("Connected."),
              onEvent: (event: ChatEvent) => appendLine(formatChatEvent(event)),
              onError: (error: Error) => appendLine(`Error: ${error.message}`),
              onClose: (result) => appendLine(`Closed (${String(result.code)}${result.reason ? `: ${result.reason}` : ""}).`),
            });
      } catch (error) {
        if (active) {
          appendLine(`Failed to connect: ${String(error)}`);
        }
      }
    };

    void subscribe();

    return () => {
      active = false;
      cleanup?.();
    };
  }, [props.id, props.kind, props.title, wsClient]);

  return <>{lines.join("\n")}</>;
}

function formatModel(model: { providerID: string; modelID: string; variant?: string }): string {
  return model.variant
    ? `${model.providerID}/${model.modelID} (${model.variant})`
    : `${model.providerID}/${model.modelID}`;
}

function formatLoopEvent(event: LoopEvent): string {
  switch (event.type) {
    case "loop.message":
      return `[${event.timestamp}] message: ${event.message.role}: ${event.message.content}`;
    case "loop.progress":
      return `[${event.timestamp}] progress: ${event.content}`;
    case "loop.log":
      return `[${event.timestamp}] ${event.level}: ${event.message}`;
    case "loop.error":
      return `[${event.timestamp}] error: ${event.error}`;
    case "loop.plan.ready":
      return `[${event.timestamp}] plan ready`;
    case "loop.plan.feedback":
      return `[${event.timestamp}] plan feedback round ${String(event.round)}`;
    case "loop.git.commit":
      return `[${event.timestamp}] commit: ${event.commit.sha} ${event.commit.message}`;
    case "loop.iteration.start":
      return `[${event.timestamp}] iteration ${String(event.iteration)} started`;
    case "loop.iteration.end":
      return `[${event.timestamp}] iteration ${String(event.iteration)} ended (${event.outcome})`;
    default:
      return `[${event.timestamp}] ${event.type}`;
  }
}

function formatChatEvent(event: ChatEvent): string {
  switch (event.type) {
    case "chat.message":
      return `[${event.timestamp}] message: ${event.message.role}: ${event.message.content}`;
    case "chat.log":
      return `[${event.timestamp}] ${event.log.level}: ${event.log.message}`;
    case "chat.status":
      return `[${event.timestamp}] status: ${event.status}`;
    case "chat.error":
      return `[${event.timestamp}] error: ${event.message}`;
    default:
      return `[${event.timestamp}] ${event.type}`;
  }
}
