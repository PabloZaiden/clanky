import { useMemo, useRef, useState, type RefObject } from "react";
import { usePerformanceContent } from "@/platform/web/use-performance-content";
import {
  isProvisioningJobTerminal,
  type Automation,
  type PublicProvisioningJob,
  type WorkerUpdateJob,
} from "@/shared";
import { ConfirmModal, DataList, EmptyState, Panel, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  DismissAllProvisioningJobsResult,
  UseWorkerUpdateJobsResult,
} from "../../hooks";
import { Button } from "../common";
import { getProvisioningStatusBadgeVariant, getProvisioningStatusLabel } from "../common/status-variants";
import {
  type SidebarExecutionHostNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";
import { WorkerUpdateJobsSection } from "./worker-update-jobs-section";
import { WorkspaceIdentity } from "../common";
import { OverviewWork } from "./overview-work";
import { JobListRow } from "../job-list-row";

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

function readHomePresentation(view: RefObject<HTMLDivElement | null>): string | undefined {
  if (!view.current) return undefined;
  const parts: string[] = [];
  function read(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
      parts.push(node.nodeValue);
      return;
    }
    // A relative clock tick is not a new server update.
    if (node instanceof HTMLTimeElement && node.dateTime) {
      parts.push(node.dateTime);
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) read(child);
  }
  read(view.current);
  return JSON.stringify(parts);
}

export function OverviewView({
  measurePerformance,
  executionHostNodes,
  automations,
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
  measurePerformance: boolean;
  executionHostNodes: SidebarExecutionHostNode[];
  automations: Automation[];
  workspaceGroups: { workspace: import("@/shared").Workspace }[];
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
  const view = useRef<HTMLDivElement>(null);
  usePerformanceContent("home", measurePerformance, view, readHomePresentation, { observe: view });
  const toast = useToast();
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const workspaceChatCounts = useMemo(
    () => new Map(sidebarWorkspaceGroups.flatMap((group) => group.workspaces.map((node) => [
      node.workspace.id,
      node.chats.length + node.historyChats.length,
    ]))),
    [sidebarWorkspaceGroups],
  );
  const visibleWorkspaces = useMemo(() => workspaceGroups.map((group) => group.workspace), [workspaceGroups]);
  const visibleWorkspaceIds = useMemo(
    () => new Set(visibleWorkspaces.map((workspace) => workspace.id)),
    [visibleWorkspaces],
  );
  const visibleAutomations = useMemo(
    () => automations.filter((automation) => visibleWorkspaceIds.has(automation.config.workspaceId)),
    [automations, visibleWorkspaceIds],
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
    <div ref={view} className="space-y-6">
      <OverviewWork
        sidebarWorkspaceGroups={sidebarWorkspaceGroups}
        executionHostNodes={executionHostNodes}
        automations={visibleAutomations}
        workspaces={visibleWorkspaces}
        onNavigate={onNavigate}
        showPrivateItems={showPrivateItems}
      />

      <Panel title="Workspaces">
        {visibleWorkspaces.length > 0 ? (
          <DataList>
            {visibleWorkspaces.map((workspace) => {
              const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(workspace), showPrivateItems);
              const sessionCount = workspaceChatCounts.get(workspace.id) ?? 0;
              return (
                <ClankyListRow
                  key={workspace.id}
                  title={<WorkspaceIdentity workspace={workspace} />}
                  meta={`${sessionCount} session${sessionCount === 1 ? "" : "s"}`}
                  onClick={() => onNavigate({ view: "workspace", workspaceId: workspace.id })}
                  privateHidden={privateHidden}
                />
              );
            })}
          </DataList>
        ) : <EmptyState title="No workspaces" />}
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
