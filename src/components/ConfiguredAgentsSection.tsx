import type { Agent } from "@/shared";
import { ErrorState, LoadingState } from "@pablozaiden/webapp/web";
import { ClankyListRow } from "./app-shell/clanky-list-row";

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
    <div data-testid="configured-agents-section">
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
        <div>
          <h2 className="text-base font-semibold text-gray-950 dark:text-gray-100">{title}</h2>
          {description ? <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p> : null}
        </div>
        {error ? <ErrorState title="Unable to load agents" description={error} /> : null}
        {loading ? <LoadingState title="Loading agents" /> : null}
        {agents.length > 0 ? (
          <div className="mt-4 space-y-2">
            {agents.map((agent) => {
              const workspaceName = workspaceNamesById[agent.config.workspaceId];
              const privateHidden = isAgentPrivateHidden(agent);
              return (
                <ClankyListRow
                  key={agent.config.id}
                  title={agent.config.name}
                  description={agent.config.prompt}
                  meta={`${workspaceName ? `${workspaceName} · ` : ""}Next run: ${formatDate(agent.state.nextRunAt)} · ${getScheduleText(agent)}`}
                  badge={<AgentStatusPill status={agent.state.status} />}
                  onClick={onSelectAgent && !privateHidden ? () => onSelectAgent(agent.config.id) : undefined}
                  privateHidden={privateHidden}
                />
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
