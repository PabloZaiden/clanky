import { memo } from "react";
import {
  DataList, DataListRow, ErrorState, LoadingState, Panel,
} from "@pablozaiden/webapp/web";
import { getProvisioningStatusBadgeVariant, getProvisioningStatusLabel, StatusBadge } from "./common";
import type { ProvisioningLogEntry, PublicProvisioningJobSnapshot } from "@/shared";
import type { RealtimeStreamStatus } from "../hooks";
import { getProvisioningExecutionLabel, getProvisioningStepLabel } from "./provisioning/presentation";
import { ConsoleOutput } from "./console-output";

export interface ProvisioningJobViewProps {
  snapshot: PublicProvisioningJobSnapshot | null;
  logs: ProvisioningLogEntry[];
  websocketStatus: RealtimeStreamStatus;
  loading?: boolean;
  error?: string | null;
}

export const ProvisioningJobView = memo(function ProvisioningJobView({
  snapshot,
  logs,
  websocketStatus,
  loading = false,
  error = null,
}: ProvisioningJobViewProps) {
  if (loading && !snapshot) return <LoadingState title="Loading provisioning job" />;
  if (!snapshot) return <ErrorState title="Provisioning job not found" description={error ?? undefined} />;
  const { job } = snapshot;
  const execution = job.state.execution;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge variant={getProvisioningStatusBadgeVariant(job.state.status)}>
          {getProvisioningStatusLabel(job.state.status)}
        </StatusBadge>
        {websocketStatus !== "open" ? (
          <StatusBadge variant="warning">
            {websocketStatus === "closed" ? "Offline" : "Reconnecting"}
          </StatusBadge>
        ) : null}
        {job.state.recovery?.status === "confirmed" ? (
          <StatusBadge variant="completed">Recovery confirmed</StatusBadge>
        ) : null}
        {job.state.workspaceAction ? (
          <StatusBadge variant="completed">Workspace {job.state.workspaceAction}</StatusBadge>
        ) : null}
      </div>
      {job.state.error ? (
        <ErrorState title={getProvisioningStatusLabel(job.state.status)} description={job.state.error.message} />
      ) : null}
      {job.state.status === "cancelled" && execution?.outcome === "unconfirmed" ? (
        <ErrorState title="Command outcome unconfirmed" description="Check the execution host before retrying." />
      ) : null}
      {error ? <ErrorState title="Unable to refresh job" description={error} /> : null}
      <Panel title="Target">
        <DataList>
          <DataListRow title={job.config.name} />
        </DataList>
      </Panel>
      <Panel title="Progress">
        <DataList>
          <DataListRow
            title={getProvisioningStepLabel(job.state.currentStep)}
            description={execution && execution.step === job.state.currentStep
              ? getProvisioningExecutionLabel(execution) : undefined}
            meta={execution?.exitCode === undefined ? undefined : `Exit code ${execution.exitCode}`}
            metaPlacement="inline"
          />
        </DataList>
      </Panel>
      <Panel title="Logs" description={`${logs.length} entries`}>
        <ConsoleOutput entries={logs} />
      </Panel>
    </div>
  );
});
