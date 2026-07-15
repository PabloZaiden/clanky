import type { Agent } from "@/shared";
import { ErrorState, LoadingState } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName } from "../lib/private-items";

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusClassName(status: string): string {
  if (status === "enabled" || status === "completed") {
    return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (status === "running" || status === "starting" || status === "scheduled") {
    return "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
  }
  if (status === "failed" || status === "error") {
    return "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  }
  if (status === "paused" || status === "skipped" || status === "interrupted") {
    return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  }
  return "bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-gray-300";
}

function AgentStatusPill({ status }: { status: string }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClassName(status)}`}>
      {status}
    </span>
  );
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
    <section
      data-testid="configured-agents-section"
      className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">{title}</h2>
        {description ? <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p> : null}
      </div>
      {error ? <ErrorState title="Unable to load agents" description={error} /> : null}
      {loading ? <LoadingState title="Loading agents" /> : null}
      {agents.length > 0 ? (
        <div className="space-y-2">
          {agents.map((agent) => {
            const workspaceName = workspaceNamesById[agent.config.workspaceId];
            const privateHidden = isAgentPrivateHidden(agent);
            const itemClassName = "flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition dark:border-gray-800 dark:bg-neutral-900";
            const interactiveItemClassName = `${itemClassName} hover:border-gray-300 hover:bg-gray-100 dark:hover:border-gray-700 dark:hover:bg-neutral-800`;
            const body = (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                    {agent.config.name}
                  </span>
                  <span className="mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-300">
                    {agent.config.prompt}
                  </span>
                  <span className="mt-2 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                    {workspaceName ? `${workspaceName} · ` : ""}Next run: {formatDate(agent.state.nextRunAt)} · {getScheduleText(agent)}
                  </span>
                </span>
                <AgentStatusPill status={agent.state.status} />
              </>
            );

            if (onSelectAgent && !privateHidden) {
              return (
                <button
                  key={agent.config.id}
                  type="button"
                  className={interactiveItemClassName}
                  onClick={() => onSelectAgent(agent.config.id)}
                >
                  {body}
                </button>
              );
            }

            return (
              <div key={agent.config.id} className={`${itemClassName} ${getPrivateContainerClassName(privateHidden)}`}>
                {body}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
