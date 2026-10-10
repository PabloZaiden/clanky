import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  DataList,
  DataListRow,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Panel,
} from "@pablozaiden/webapp/web";
import type {
  HarnessActivity,
  HarnessActivitySnapshot,
  HarnessCapabilities,
  HarnessInputReceipt,
} from "@/shared/harness-control";
import { StatusBadge } from "./common";
import {
  getEffectiveHarnessInputAdmission,
  HarnessInputReconciliationProvider,
  useRetryHarnessInputReconciliation,
  useHarnessInputReconciliation,
} from "./harness-input-reconciliation";
import { useHarnessActivity } from "./use-harness-activity";

interface HarnessActivityProps {
  kind: "chat" | "task";
  entityId: string;
  snapshot?: HarnessActivitySnapshot;
  capabilities?: HarnessCapabilities;
  onBack: () => void;
  onOpenActivity?: () => void;
  inputs?: HarnessInputReceipt[];
  onInputUpdated?: () => Promise<void>;
}

const ToolActivityContext = createContext<{
  byTool: ReadonlyMap<string, HarnessActivity[]>;
  onOpenActivity?: () => void;
  inputs: ReadonlyMap<string, HarnessInputReceipt>;
} | null>(null);

export function HarnessMessageAdmission({ inputId }: { inputId: string }) {
  const context = useContext(ToolActivityContext);
  const reconciliation = useHarnessInputReconciliation(inputId);
  const retryReconciliation = useRetryHarnessInputReconciliation();
  const receipt = context?.inputs.get(inputId);
  const admission = getEffectiveHarnessInputAdmission(reconciliation?.admission, receipt?.admission);
  if (!context || !admission) return null;
  const delivered = admission.status === "delivered";
  const rejected = admission.status === "rejected";
  const permanentReconciliationError = reconciliation?.error?.kind === "reconciliation"
    && !reconciliation.error.retrying;
  return (
    <div className="flex flex-wrap items-center gap-x-2 pt-1 text-xs">
      <span role="status" aria-live="polite" aria-atomic="true" className="flex flex-wrap items-center gap-x-2">
        <span className="text-gray-500 dark:text-gray-400">
          {rejected
            ? "Steering was not admitted."
            : delivered ? "Steered" : "Admitting"}
        </span>
        {reconciliation?.error && (
          <span className="break-words text-amber-700 dark:text-amber-300">
            {reconciliation.error.kind === "refresh"
              ? delivered
                ? `Delivery confirmed; entity refresh failed: ${reconciliation.error.message}`
                : `Entity refresh failed; delivery reconciliation continues: ${reconciliation.error.message}`
              : reconciliation.error.retrying
                ? `Delivery check failed; retrying automatically: ${reconciliation.error.message}`
                : `Delivery check failed; automatic retries stopped: ${reconciliation.error.message}`}
          </span>
        )}
      </span>
      {permanentReconciliationError && (
        <button
          type="button"
          onClick={() => retryReconciliation(inputId)}
          className="font-medium text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          Retry check
        </button>
      )}
    </div>
  );
}

export function HarnessToolActivity({ toolIds }: { toolIds: readonly string[] }) {
  const context = useContext(ToolActivityContext);
  const activities = useMemo(() => toolIds.flatMap((id) => context?.byTool.get(id) ?? []), [context, toolIds]);
  if (!activities?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      {activities.map((activity) => (
        <span key={activity.id} className="max-w-full truncate">
          {activity.kind === "subagent" ? "Subagent" : "Process"}: {activity.status}
        </span>
      ))}
      {context?.onOpenActivity && (
        <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100" onClick={context.onOpenActivity}>
          Activity
        </button>
      )}
    </div>
  );
}

function ActivityRow({
  activity,
  canStop,
  stopping,
  disabled,
  onStop,
}: {
  activity: HarnessActivity;
  canStop: boolean;
  stopping: boolean;
  disabled: boolean;
  onStop: () => void;
}) {
  return (
    <DataListRow
      title={<span className="block truncate">{activity.description}</span>}
      description={activity.kind === "subagent" ? activity.effectiveModel ?? activity.requestedModel ?? "Model not reported"
        : activity.kind === "process" ? "Process" : "External activity"}
      badge={<StatusBadge size="sm">{activity.status}</StatusBadge>}
      actions={canStop ? (
        <button type="button" className="shrink-0 py-1 text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-red-600 disabled:opacity-50 dark:text-gray-400" disabled={disabled || stopping} onClick={onStop}>
          {stopping ? "Stopping" : "Stop"}
        </button>
      ) : undefined}
    />
  );
}

function HarnessActivityPage({ kind, entityId, snapshot, capabilities, onBack }: HarnessActivityProps) {
  const { activity, loaded, error, stoppingId, unconfirmedId, stop } = useHarnessActivity({ kind, entityId, snapshot });
  return (
    <Page className="h-full overflow-y-auto">
      <Panel
        title="Activity"
        actions={<button type="button" className="py-1 text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100" onClick={onBack}>Back to {kind}</button>}
      >
        {!loaded ? <LoadingState title="Observing activity" /> : error ? (
          <ErrorState
            title="Activity could not be observed"
            description={error}
          />
        ) : activity?.observation !== "available" ? (
          <ErrorState
            title={activity?.reason === "unsupported" ? "Activity is not supported" : "Activity is unavailable"}
            description={activity?.reason === "disconnected" ? "The native session is disconnected." : "Active work cannot be confirmed."}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>Principal: {activity.principalProcessing ? "Running" : "Idle"}</span>
            </div>
            {activity.coverage === "partial" && (
              <ErrorState title="Partial observation" description="Some background work may not be visible." />
            )}
            {unconfirmedId && (
              <ErrorState title="Termination unconfirmed" description="Waiting for native termination confirmation." />
            )}
            <DataList>
              {activity.activities.length === 0 ? <EmptyState title="No observed background activity" /> : (
                activity.activities.map((item) => (
                  <ActivityRow
                    key={item.id}
                    activity={item}
                    canStop={item.ownership === "owned"
                      && ["queued", "running", "waiting", "unknown"].includes(item.status)
                      && (item.kind === "process" ? capabilities?.stopScopes.includes("command") === true
                        : item.kind === "subagent" && capabilities?.stopScopes.includes("child-execution") === true)}
                    stopping={stoppingId === item.id}
                    disabled={stoppingId !== undefined && stoppingId !== item.id}
                    onStop={() => void stop(item.id)}
                  />
                ))
              )}
            </DataList>
          </div>
        )}
      </Panel>
    </Page>
  );
}

export function HarnessEntityView({
  showActivity,
  children,
  activityFooter,
  ...props
}: HarnessActivityProps & { showActivity: boolean; children: ReactNode; activityFooter?: ReactNode }) {
  const byTool = useMemo(() => {
    const result = new Map<string, HarnessActivity[]>();
    if (props.snapshot?.observation === "available") {
      for (const activity of props.snapshot.activities) {
        if (!activity.spawningToolCallId) continue;
        const siblings = result.get(activity.spawningToolCallId) ?? [];
        siblings.push(activity);
        result.set(activity.spawningToolCallId, siblings);
      }
    }
    return result;
  }, [props.snapshot]);
  const inputs = useMemo(() => new Map(props.inputs?.map((receipt) => [receipt.admission.inputId, receipt])), [props.inputs]);
  const toolActivity = useMemo(() => ({
    byTool,
    inputs,
    onOpenActivity: props.onOpenActivity,
  }), [byTool, inputs, props.onOpenActivity]);
  return (
    <HarnessInputReconciliationProvider
      kind={props.kind}
      entityId={props.entityId}
      inputs={props.inputs}
      onUpdated={props.onInputUpdated}
    >
      <ToolActivityContext.Provider value={toolActivity}>
        <div className="relative flex h-full min-h-0 flex-col">
          <div
            className={`flex min-h-0 flex-1 flex-col ${showActivity ? "invisible" : ""}`}
            inert={showActivity || undefined}
            aria-hidden={showActivity || undefined}
          >
            {children}
          </div>
          {showActivity && (
            <div className="absolute inset-0 flex min-h-0 flex-col">
              <div className="flex min-h-0 flex-1 flex-col"><HarnessActivityPage {...props} /></div>
              {activityFooter}
            </div>
          )}
        </div>
      </ToolActivityContext.Provider>
    </HarnessInputReconciliationProvider>
  );
}
