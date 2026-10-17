import { DataList, ErrorState, LoadingState, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Agent, Workspace } from "@/shared";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { getAgentStatusBadgeVariant, StateText, StatusBadge } from "../common";
import { ClankyListRow } from "./clanky-list-row";

export function OverviewAgentRow({ agent, workspace, showPrivateItems, onNavigate }: {
  agent: Agent;
  workspace?: Workspace;
  showPrivateItems: boolean;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const privateHidden = shouldObscurePrivateItem(
    isEffectivelyPrivate(agent.config, [workspace]),
    showPrivateItems,
  );
  return (
    <ClankyListRow
      title={agent.config.name}
      description={workspace?.name}
      badge={<StatusBadge variant={getAgentStatusBadgeVariant(agent.state.status)}><StateText>{agent.state.status}</StateText></StatusBadge>}
      onClick={() => onNavigate({ view: "agent", agentId: agent.config.id })}
      privateHidden={privateHidden}
    />
  );
}

export function OverviewAgents({
  agents,
  workspaces,
  loading,
  error,
  showPrivateItems,
  onNavigate,
}: {
  agents: Agent[];
  workspaces: Workspace[];
  loading?: boolean;
  error?: string | null;
  showPrivateItems: boolean;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const rows = (
    <DataList>
      {agents.map((agent) => {
        const workspace = workspaces.find((item) => item.id === agent.config.workspaceId);
        return (
          <OverviewAgentRow
            key={agent.config.id}
            agent={agent}
            workspace={workspace}
            showPrivateItems={showPrivateItems}
            onNavigate={onNavigate}
          />
        );
      })}
    </DataList>
  );
  return (
    <section className="space-y-2" aria-label="Agents">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Agents</h3>
      {error ? <ErrorState title="Could not load agents" description={error} /> : null}
      {loading ? <LoadingState title="Loading agents…" /> : null}
      {agents.length > 0 ? rows : null}
      {!loading && !error && agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No agents</p>
      ) : null}
    </section>
  );
}
