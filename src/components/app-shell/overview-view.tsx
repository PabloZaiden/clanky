import { useMemo, useState } from "react";
import {
  getExecutionHostSourceId,
  isProvisioningJobTerminal,
  type Agent,
  type ExecutionHostDescriptor,
  type PublicProvisioningJob,
  type WorkerUpdateJob,
} from "@/shared";
import { ConfirmModal, DataList, Panel, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  DismissAllProvisioningJobsResult,
  UseWorkerUpdateJobsResult,
  useTaskGrouping,
} from "../../hooks";
import { Button } from "../common";
import { getProvisioningStatusBadgeVariant, getProvisioningStatusLabel } from "../common/status-variants";
import {
  type SidebarExecutionHostNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";
import { ServerTransportIcon } from "./server-sidebar-item";
import { WorkerUpdateJobsSection } from "./worker-update-jobs-section";
import { WorkspaceIdentity } from "../common";
import { OverviewAgents } from "./overview-agents";
import { OverviewWork } from "./overview-work";
import { JobListRow } from "../job-list-row";

function getExecutionHostRoute(host: ExecutionHostDescriptor): WebAppRoute {
  return {
    view: "execution-host",
    hostKind: host.ref.kind,
    hostId: getExecutionHostSourceId(host.ref),
  };
}

function getProvisioningJobModeLabel(job: PublicProvisioningJob): string {
  switch (job.config.mode) {
    case "rebuild":
      return "Rebuild";
    case "restart":
      return "Restart";
    case "arise":
      return "Arise";
    case "provision":
    default:
      return "Provision";
  }
}

export function OverviewView({
  executionHosts,
  executionHostNodes,
  agents,
  agentsLoading,
  agentsError,
  workspaceGroups,
  sidebarWorkspaceGroups,
  onNavigate,
  provisioningJobs,
  onDismissAllProvisioningJobs,
  dismissingAllProvisioningJobs,
  workerUpdateJobs,
  onDismissAllWorkerUpdateJobs,
  dismissingAllWorkerUpdateJobs,
  showPrivateItems = false,
}: {
  executionHosts: ExecutionHostDescriptor[];
  executionHostNodes: SidebarExecutionHostNode[];
  agents: Agent[];
  agentsLoading: boolean;
  agentsError: string | null;
  workspaceGroups: ReturnType<typeof useTaskGrouping>["workspaceGroups"];
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  onNavigate: (route: WebAppRoute) => void;
  provisioningJobs: PublicProvisioningJob[];
  onDismissAllProvisioningJobs: () => Promise<DismissAllProvisioningJobsResult>;
  dismissingAllProvisioningJobs: boolean;
  workerUpdateJobs: WorkerUpdateJob[];
  onDismissAllWorkerUpdateJobs: UseWorkerUpdateJobsResult["dismissAllJobs"];
  dismissingAllWorkerUpdateJobs: boolean;
  showPrivateItems?: boolean;
}) {
  const toast = useToast();
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const serverMapItems = useMemo(() => {
    return executionHosts
      .filter((host) => host.ref.kind !== "local")
      .map((host) => ({
        host,
        sessionCount: executionHostNodes.find((node) => node.host.targetKey === host.targetKey)
          ?.terminalSessions.length ?? 0,
      }))
      .sort((left, right) => left.host.name.localeCompare(right.host.name));
  }, [executionHostNodes, executionHosts]);
  const visibleWorkspaces = useMemo(() => workspaceGroups.map((group) => group.workspace), [workspaceGroups]);
  const visibleWorkspaceIds = useMemo(
    () => new Set(workspaceGroups.map((group) => group.workspace.id)),
    [workspaceGroups],
  );
  const visibleAgents = useMemo(
    () => agents.filter((agent) => visibleWorkspaceIds.has(agent.config.workspaceId)),
    [agents, visibleWorkspaceIds],
  );
  const terminalProvisioningJobs = useMemo(
    () => provisioningJobs.filter((job) => isProvisioningJobTerminal(job.state.status)),
    [provisioningJobs],
  );

  async function handleDismissAllProvisioningJobs(): Promise<void> {
    try {
      const result = await onDismissAllProvisioningJobs();
      setDismissConfirmOpen(false);
      if (result.failedJobIds.length > 0) {
        toast.error(
          `Dismissed ${result.dismissedJobIds.length} provisioning job${
            result.dismissedJobIds.length === 1 ? "" : "s"
          }, but ${result.failedJobIds.length} could not be dismissed.`,
        );
        return;
      }
      toast.success(
        `Dismissed ${result.dismissedJobIds.length} provisioning job${
          result.dismissedJobIds.length === 1 ? "" : "s"
        }.`,
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div className="space-y-6">
      <OverviewWork
        sidebarWorkspaceGroups={sidebarWorkspaceGroups}
        executionHostNodes={executionHostNodes}
        agents={visibleAgents}
        workspaces={visibleWorkspaces}
        onNavigate={onNavigate}
        showPrivateItems={showPrivateItems}
      />

      <Panel title="Resources">
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <section className="space-y-2" aria-label="Workspaces">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Workspaces</h3>
            {workspaceGroups.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No workspaces</p>
            ) : (
              <DataList>
                {workspaceGroups.map((group) => {
                  const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(group.workspace), showPrivateItems);
                  return (
                    <ClankyListRow
                      key={group.workspace.id}
                      title={<WorkspaceIdentity workspace={group.workspace} />}
                      meta={`${group.tasks.length} task${group.tasks.length === 1 ? "" : "s"}`}
                      onClick={!privateHidden ? () => onNavigate({ view: "workspace", workspaceId: group.workspace.id }) : undefined}
                      privateHidden={privateHidden}
                    />
                  );
                })}
              </DataList>
            )}
          </section>
          <OverviewAgents
            agents={visibleAgents}
            loading={agentsLoading}
            error={agentsError}
            workspaces={visibleWorkspaces}
            onNavigate={onNavigate}
            showPrivateItems={showPrivateItems}
          />
          <section className="space-y-2" aria-label="Servers">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Servers</h3>
            {serverMapItems.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No servers</p>
            ) : (
              <DataList>
                {serverMapItems.map(({ host, sessionCount }) => {
                  const privateHidden = shouldObscurePrivateItem(
                    isEffectivelyPrivate({ isPrivate: host.isPrivate }),
                    showPrivateItems,
                  );
                  return (
                    <ClankyListRow
                      key={`${host.ref.kind}:${getExecutionHostSourceId(host.ref)}`}
                      title={host.name}
                      description={host.endpoint ?? "Endpoint unavailable"}
                      meta={`${sessionCount} terminal${sessionCount === 1 ? "" : "s"}`}
                      badge={<ServerTransportIcon transport={host.ref.kind} />}
                      onClick={!privateHidden ? () => onNavigate(getExecutionHostRoute(host)) : undefined}
                      privateHidden={privateHidden}
                    />
                  );
                })}
              </DataList>
            )}
          </section>
        </div>
      </Panel>

      {provisioningJobs.length > 0 ? (
        <Panel
          className="clanky-provisioning-panel"
          title="Provisioning"
          actions={terminalProvisioningJobs.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              tone="danger"
              loading={dismissingAllProvisioningJobs}
              onClick={() => setDismissConfirmOpen(true)}
              data-testid="dismiss-all-provisioning-jobs"
            >
              Dismiss all
            </Button>
          ) : null}
        >
          <DataList>
            {provisioningJobs.map((job) => (
              <JobListRow
                key={job.config.id}
                title={`${getProvisioningJobModeLabel(job)} · ${job.config.name}`}
                timestamp={job.state.updatedAt}
                status={getProvisioningStatusLabel(job.state.status)}
                statusVariant={getProvisioningStatusBadgeVariant(job.state.status)}
                onClick={() => onNavigate({
                  view: "provisioning-job",
                  provisioningJobId: job.config.id,
                  returnView: "home",
                })}
              />
            ))}
          </DataList>
        </Panel>
      ) : null}

      <WorkerUpdateJobsSection
        jobs={workerUpdateJobs}
        onNavigate={onNavigate}
        onDismissAll={onDismissAllWorkerUpdateJobs}
        dismissingAll={dismissingAllWorkerUpdateJobs}
      />

      <ConfirmModal
        isOpen={dismissConfirmOpen}
        onClose={() => {
          if (!dismissingAllProvisioningJobs) {
            setDismissConfirmOpen(false);
          }
        }}
        onConfirm={() => void handleDismissAllProvisioningJobs()}
        title="Dismiss terminal provisioning jobs?"
        message="This permanently removes the selected jobs, their logs, and their retry configuration."
        confirmLabel="Dismiss all"
        loading={dismissingAllProvisioningJobs}
        variant="danger"
      />
    </div>
  );
}
