import type { Agent } from "@/shared";
import { DataList, DataListRow, ErrorState, LoadingState, Panel } from "@pablozaiden/webapp/web";
import { Badge, type BadgeVariant } from "./common";
import { getPrivateContainerClassName } from "../lib/private-items";

const MAX_CONFIGURED_AGENT_PROMPT_WORDS = 20;

function summarizeAgentPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/, MAX_CONFIGURED_AGENT_PROMPT_WORDS + 1);
  if (words.length <= MAX_CONFIGURED_AGENT_PROMPT_WORDS) {
    return words.join(" ");
  }
  return `${words.slice(0, MAX_CONFIGURED_AGENT_PROMPT_WORDS).join(" ")}…`;
}

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusVariant(status: string): BadgeVariant {
  if (status === "enabled" || status === "completed") {
    return "success";
  }
  if (status === "running" || status === "starting" || status === "scheduled") {
    return "info";
  }
  if (status === "failed" || status === "error") {
    return "error";
  }
  if (status === "paused" || status === "skipped" || status === "interrupted") {
    return "warning";
  }
  return "default";
}

function AgentStatusPill({ status }: { status: string }) {
  return <Badge variant={statusVariant(status)} size="md" className="font-medium">{status}</Badge>;
}

function getScheduleText(agent: Agent): string {
  const { value, unit } = agent.config.schedule.interval;
  const displayUnit = value === 1 ? unit.slice(0, -1) : unit;
  return `Every ${value} ${displayUnit}`;
}

export interface ConfiguredAgentsSectionProps {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  title?: string;
  description?: string;
  workspaceNamesById?: Record<string, string>;
  onSelectAgent?: (agentId: string) => void;
  isAgentPrivateHidden?: (agent: Agent) => boolean;
}

export function ConfiguredAgentsSection({
  agents,
  loading,
  error,
  title = "Configured Agents",
  description,
  workspaceNamesById = {},
  onSelectAgent,
  isAgentPrivateHidden = () => false,
}: ConfiguredAgentsSectionProps) {
  if (!loading && !error && agents.length === 0) {
    return null;
  }

  return (
    <Panel
      data-testid="configured-agents-section"
      title={title}
      description={description}
    >
      {error ? <ErrorState title="Unable to load agents" description={error} /> : null}
      {loading ? <LoadingState title="Loading agents" /> : null}
      {agents.length > 0 ? (
        <DataList>
          {agents.map((agent) => {
            const workspaceName = workspaceNamesById[agent.config.workspaceId];
            const privateHidden = isAgentPrivateHidden(agent);
            return (
              <DataListRow
                key={agent.config.id}
                title={agent.config.name}
                description={summarizeAgentPrompt(agent.config.prompt)}
                descriptionClassName="line-clamp-2"
                meta={`${workspaceName ? `${workspaceName} · ` : ""}Next run: ${formatDate(agent.state.nextRunAt)} · ${getScheduleText(agent)}`}
                metaPlacement="below"
                badge={<AgentStatusPill status={agent.state.status} />}
                onClick={!privateHidden && onSelectAgent ? () => onSelectAgent(agent.config.id) : undefined}
                className={getPrivateContainerClassName(privateHidden)}
              />
            );
          })}
        </DataList>
      ) : null}
    </Panel>
  );
}
