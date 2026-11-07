import type {
  ActionMenuItem,
  SidebarNode,
} from "@pablozaiden/webapp/web";
import type { Agent, Workspace } from "@/shared";
import type { UseAgentsResult } from "../../hooks/useAgents";
import { formatStatusLabel } from "../common";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  sidebarActionItems,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";

export interface AgentSidebarContext {
  setEditingAgentId: (agentId: string) => void;
  setDeleteAgentTarget: (agent: Agent) => void;
  setPurgeAgentTarget: (agent: Agent) => void;
  exportAgent: (agent: Agent) => void | Promise<void>;
  agents: Pick<UseAgentsResult, "pauseAgent" | "resumeAgent" | "interruptAgent" | "runAgent">;
  onError: (message: string) => void;
  toggleAgentPrivate: (agent: Agent) => void | Promise<void>;
  showPrivateItems: boolean;
}

export function getAgentSidebarActions(
  agent: Agent,
  context: AgentSidebarContext,
): ActionMenuItem[] {
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "edit-agent",
        label: "Edit",
        onClick: () => context.setEditingAgentId(agent.config.id),
      },
      {
        id: "export-agent",
        label: "Export",
        onClick: () => void context.exportAgent(agent),
      },
      {
        id: "toggle-agent-paused",
        label: agent.config.enabled ? "Pause" : "Resume",
        onClick: () => {
          const request = agent.config.enabled
            ? context.agents.pauseAgent(agent.config.id)
            : context.agents.resumeAgent(agent.config.id);
          void request.then((updated) => {
            if (!updated) {
              context.onError(agent.config.enabled ? "Failed to pause agent" : "Failed to resume agent");
            }
          });
        },
      },
      agent.state.status === "running"
        ? {
            id: "interrupt-agent",
            label: "Interrupt",
            onClick: () => void context.agents.interruptAgent(agent.config.id),
          }
        : {
            id: "run-agent",
            label: "Run now",
            onClick: () => void context.agents.runAgent(agent.config.id),
          },
      {
        id: "purge-agent-runs",
        label: "Purge runs",
        destructive: true,
        onClick: () => context.setPurgeAgentTarget(agent),
      },
      {
        id: "delete-agent",
        label: "Delete",
        destructive: true,
        onClick: () => context.setDeleteAgentTarget(agent),
      },
    ]),
    agent.config,
    () => void context.toggleAgentPrivate(agent),
  );
}

export function createAgentSidebarNode(
  agent: Agent,
  workspace: Workspace,
  context: AgentSidebarContext,
): SidebarNode {
  const privateHidden = getPrivateHidden(agent.config, [workspace], context.showPrivateItems);
  const actions = getAgentSidebarActions(agent, context);
  const statusLabel = agent.config.enabled ? "Agent" : "Paused agent";
  return privateSidebarPresentation({
    type: "item",
    id: `agent:${agent.config.id}`,
    title: agent.config.name,
    subtitle: `${workspace.name} · ${statusLabel}`,
    badge: formatStatusLabel(agent.config.enabled ? "enabled" : "paused"),
    badgeVariant: agent.config.enabled ? "success" : "disabled",
    route: { view: "agent", agentId: agent.config.id },
    actions,
    pinnable: true,
    pinId: `agent:${agent.config.id}`,
  }, privateHidden, privateActions(actions, privateHidden, agent.config.isPrivate === true));
}

export function buildAgentSidebarNodes(
  agents: Agent[],
  workspaces: Workspace[],
  context: AgentSidebarContext,
): SidebarNode[] {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return agents.flatMap((agent) => {
    const workspace = workspaceById.get(agent.config.workspaceId);
    return workspace ? [createAgentSidebarNode(agent, workspace, context)] : [];
  });
}
