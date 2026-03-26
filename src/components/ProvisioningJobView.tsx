import { memo, useEffect, useMemo, useRef } from "react";
import { Badge, getProvisioningStatusBadgeVariant, getProvisioningStatusLabel, StatusBadge } from "./common";
import type { ProvisioningJobMode, ProvisioningJobSnapshot, ProvisioningStep } from "../types";
import type { WebSocketConnectionStatus } from "../hooks";

const STEP_LABELS: Record<ProvisioningStep, string> = {
  verify_devbox: "Verify devbox",
  prepare_directory: "Prepare directory",
  clone_repo: "Clone repository",
  devbox_up: "Run devbox up",
  devbox_rebuild: "Rebuild devbox",
  devbox_status: "Read devbox status",
  create_workspace: "Create workspace",
  test_connection: "Test connection",
  workspace_ready: "Workspace Ready",
};

const PROVISION_STEPS: ProvisioningStep[] = [
  "verify_devbox",
  "prepare_directory",
  "clone_repo",
  "devbox_up",
  "devbox_status",
  "create_workspace",
  "test_connection",
  "workspace_ready",
];

const REBUILD_STEPS: ProvisioningStep[] = [
  "verify_devbox",
  "prepare_directory",
  "devbox_rebuild",
  "devbox_status",
  "test_connection",
  "workspace_ready",
];

const RESTART_STEPS: ProvisioningStep[] = [
  "verify_devbox",
  "prepare_directory",
  "devbox_up",
  "devbox_status",
  "test_connection",
  "workspace_ready",
];

function getStepsForMode(mode: ProvisioningJobMode | undefined): [ProvisioningStep, string][] {
  const steps = mode === "rebuild"
    ? REBUILD_STEPS
    : mode === "restart"
      ? RESTART_STEPS
      : PROVISION_STEPS;
  return steps.map((step) => [step, STEP_LABELS[step]]);
}

function getWebSocketStatusLabel(status: WebSocketConnectionStatus): string {
  switch (status) {
    case "open":
      return "Live";
    case "connecting":
      return "Connecting";
    case "error":
      return "Reconnecting";
    case "closed":
      return "Offline";
  }
}

export interface ProvisioningJobViewProps {
  snapshot: ProvisioningJobSnapshot | null;
  logs: ProvisioningJobSnapshot["logs"];
  websocketStatus: WebSocketConnectionStatus;
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
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = logContainerRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [logs]);

  const jobMode = snapshot?.job.config.mode;
  const stepEntries = useMemo(() => getStepsForMode(jobMode), [jobMode]);

  if (loading && !snapshot) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-300">
        Loading provisioning job…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-300">
        No provisioning job selected.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge variant={getProvisioningStatusBadgeVariant(snapshot.job.state.status)}>
          {getProvisioningStatusLabel(snapshot.job.state.status)}
        </StatusBadge>
        <StatusBadge variant={websocketStatus === "open" ? "info" : "warning"}>
          {getWebSocketStatusLabel(websocketStatus)}
        </StatusBadge>
        {snapshot.job.state.workspaceAction && snapshot.job.state.workspaceId && (
          <Badge variant="success">
            workspace {snapshot.job.state.workspaceAction}
          </Badge>
        )}
      </div>

      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Workspace name
            </p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">
              {snapshot.job.config.name}
            </p>
          </div>
          <div className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Target directory
            </p>
            <p className="mt-1 break-all text-sm font-mono text-gray-900 dark:text-gray-100">
              {snapshot.job.state.targetDirectory ?? "Pending"}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Progress</h3>
        <div className="space-y-2">
          {stepEntries.map(([step, label], index) => {
            const currentStep = snapshot.job.state.currentStep;
            const isCurrent = snapshot.job.state.status !== "completed" && currentStep === step;
            const hasPassed = currentStep ? stepEntries.findIndex(([value]) => value === currentStep) > index : false;
            const isDone = snapshot.job.state.status === "completed" || hasPassed;

            return (
              <div
                key={step}
                className={`rounded-md border px-3 py-2 text-sm ${
                  isCurrent
                    ? "border-blue-300 bg-blue-50 text-blue-900 dark:border-gray-700 dark:bg-neutral-900/60 dark:text-blue-100"
                    : isDone
                      ? "border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-100"
                      : "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-300"
                }`}
              >
                {label}
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Provisioning log</h3>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {logs.length} entries
          </span>
        </div>
        <div
          ref={logContainerRef}
          className="max-h-80 overflow-auto rounded-md border border-gray-200 bg-neutral-950 p-3 font-mono text-xs text-gray-100 dark:border-gray-700"
        >
          {logs.length === 0 ? (
            <div className="text-gray-400">Waiting for output…</div>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className="whitespace-pre-wrap break-words">
                <span className="mr-2 text-gray-500">
                  [{entry.source}]
                </span>
                <span>{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {snapshot.job.state.error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {snapshot.job.state.error.message}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
});
