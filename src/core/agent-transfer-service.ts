import type { AgentTransferPayload } from "@/contracts/schemas";
import type { Agent } from "@/shared/agent";
import { getWorkspace } from "../persistence/workspaces";
import { agentManager } from "./agent-manager";
import { DomainError } from "./domain-error";
import { isGitBackedWorkspace } from "./workspace-capabilities";

const AGENT_TRANSFER_FORMAT = "clanky-agent" as const;
const AGENT_TRANSFER_VERSION = 1 as const;

export function createAgentTransferPayload(agent: Agent): AgentTransferPayload {
  return {
    format: AGENT_TRANSFER_FORMAT,
    version: AGENT_TRANSFER_VERSION,
    agent: {
      name: agent.config.name,
      prompt: agent.config.prompt,
      ...(agent.config.code === undefined ? {} : { code: agent.config.code }),
      model: agent.config.model,
      ...(agent.config.baseBranch === undefined ? {} : { baseBranch: agent.config.baseBranch }),
      useWorktree: agent.config.useWorktree,
      schedule: {
        startAtLocal: agent.config.schedule.startAtLocal,
        timezone: agent.config.schedule.timezone,
        interval: agent.config.schedule.interval,
      },
    },
  };
}

export async function exportAgentConfig(agentId: string): Promise<AgentTransferPayload | null> {
  const agent = await agentManager.getAgent(agentId);
  return agent ? createAgentTransferPayload(agent) : null;
}

export function getAgentTransferFilename(name: string): string {
  const normalizedName = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${normalizedName || "agent"}.clanky-agent.json`;
}

export async function importAgentConfig(
  workspaceId: string,
  payload: AgentTransferPayload,
): Promise<Agent> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", "Workspace not found", {
      details: { workspaceId },
    });
  }

  const isGitWorkspace = isGitBackedWorkspace(workspace);
  return await agentManager.createAgent({
    name: payload.agent.name,
    workspaceId,
    prompt: payload.agent.prompt,
    code: payload.agent.code,
    model: payload.agent.model,
    baseBranch: isGitWorkspace ? payload.agent.baseBranch : undefined,
    useWorktree: isGitWorkspace ? payload.agent.useWorktree : false,
    schedule: payload.agent.schedule,
    enabled: false,
  });
}
