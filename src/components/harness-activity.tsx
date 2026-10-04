import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  CodeValue,
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
import { Button, StatusBadge } from "./common";
import { HarnessInputActions } from "./harness-input-actions";
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
  kind: "chat" | "task";
  entityId: string;
  inputs: ReadonlyMap<string, HarnessInputReceipt>;
  onInputUpdated?: () => Promise<void>;
} | null>(null);

export function HarnessMessageAdmission({ inputId }: { inputId: string }) {
  const context = useContext(ToolActivityContext);
  const receipt = context?.inputs.get(inputId);
  if (!context || !receipt || receipt.admission.status === "rejected") return null;
  return (
    <div className="pt-1 text-xs text-gray-500 dark:text-gray-400">
      <span>{receipt.admission.status === "unknown" ? "Steering" : `Steered · ${receipt.admission.status === "delivered" ? "Delivered" : "Admitted"}`}</span>
      {context.onInputUpdated && (
        <HarnessInputActions
          kind={context.kind}
          entityId={context.entityId}
          inputId={inputId}
          canSteer={false}
          receipt={receipt}
          onUpdated={context.onInputUpdated}
        />
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
    <div>
      <DataListRow
        title={activity.description}
        description={activity.kind === "subagent" ? "Subagent" : activity.kind === "process" ? "Process" : "External activity"}
        meta={activity.lastActivity}
        metaPlacement="below"
        badge={<StatusBadge size="sm">{activity.status}</StatusBadge>}
        actions={canStop ? (
          <Button variant="danger" size="sm" loading={stopping} disabled={disabled} onClick={onStop}>Stop</Button>
        ) : undefined}
      />
      <details className="px-3 pb-3 text-xs text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer">Details</summary>
        <div className="mt-2 space-y-2">
          <CodeValue label="Activity" value={activity.id} />
          {activity.parentId && <CodeValue label="Parent" value={activity.parentId} />}
          {activity.spawningToolCallId && <CodeValue label="Tool" value={activity.spawningToolCallId} />}
          {activity.requestedModel && <div>Requested model: {activity.requestedModel}</div>}
          {activity.effectiveModel && <div>Effective model: {activity.effectiveModel}</div>}
          <div>Ownership: {activity.ownership}</div>
          <div>Workspace writes: {activity.workspaceWrites}</div>
        </div>
      </details>
    </div>
  );
}

function HarnessActivityPage({ kind, entityId, snapshot, capabilities, onBack }: HarnessActivityProps) {
  const { activity, loaded, error, stoppingId, unconfirmedId, refresh, stop } = useHarnessActivity({ kind, entityId, snapshot });
  return (
    <Page className="h-full overflow-y-auto">
      <Panel
        title="Activity"
        actions={<Button variant="ghost" size="sm" onClick={onBack}>Back to {kind}</Button>}
      >
        {!loaded ? <LoadingState title="Observing activity" /> : error ? (
          <ErrorState
            title="Activity could not be observed"
            description={error}
            action={<Button size="sm" onClick={() => void refresh()}>Retry</Button>}
          />
        ) : activity?.observation !== "available" ? (
          <ErrorState
            title={activity?.reason === "unsupported" ? "Activity is not supported" : "Activity is unavailable"}
            description={activity?.reason === "disconnected" ? "The native session is disconnected." : "Active work cannot be confirmed."}
            action={<Button variant="ghost" size="sm" onClick={() => void refresh()}>Refresh</Button>}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>Principal: {activity.principalProcessing ? "Running" : "Idle"}</span>
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>Refresh</Button>
            </div>
            {activity.coverage === "partial" && (
              <ErrorState title="Partial observation" description="Some background work may not be visible." />
            )}
            {unconfirmedId && (
              <ErrorState title="Termination unconfirmed" description="Refresh activity before assuming the work has stopped." />
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
  ...props
}: HarnessActivityProps & { showActivity: boolean; children: ReactNode }) {
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
    kind: props.kind,
    entityId: props.entityId,
    onOpenActivity: props.onOpenActivity,
    onInputUpdated: props.onInputUpdated,
  }), [byTool, inputs, props.kind, props.entityId, props.onOpenActivity, props.onInputUpdated]);
  return (
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
            <HarnessActivityPage {...props} />
          </div>
        )}
      </div>
    </ToolActivityContext.Provider>
  );
}
