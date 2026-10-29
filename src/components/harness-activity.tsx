import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
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
  HarnessConversationBinding,
} from "@/shared/harness-control";
import { StateText, StatusBadge } from "./common";
import {
  getEffectiveHarnessInputAdmission,
  HarnessInputReconciliationProvider,
  useRetryHarnessInputReconciliation,
  useHarnessInputReconciliation,
} from "./harness-input-reconciliation";
import { useHarnessActivity } from "./use-harness-activity";
import { useWorkspaceReadOnly } from "../context/workspace-access-context";
import type { Subagent } from "@/shared/subagent";
import type { TranscriptFileLinkContext } from "./log-viewer";
import { SubagentTranscript } from "./subagent-transcript";
import { useSavedSubagents } from "./use-saved-subagents";

interface HarnessActivityProps {
  kind: "chat" | "task";
  entityId: string;
  snapshot?: HarnessActivitySnapshot;
  capabilities?: HarnessCapabilities;
  onBack: () => void;
  onOpenActivity?: () => void;
  inputs?: HarnessInputReceipt[];
  onInputUpdated?: () => Promise<void>;
  binding?: HarnessConversationBinding | null;
  fileLinkContext?: TranscriptFileLinkContext;
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
  const hasRunningActivity = activities.some((activity) => activity.status === "running");
  const onOpenActivity = context?.onOpenActivity;
  if (!hasRunningActivity || !onOpenActivity) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100" onClick={onOpenActivity}>
        Activity
      </button>
    </div>
  );
}

function ActivityRow({
  activity,
  canStop,
  stopping,
  disabled,
  onStop,
  onOpen,
  parentDescription,
}: {
  activity: HarnessActivity;
  canStop: boolean;
  stopping: boolean;
  disabled: boolean;
  onStop: () => void;
  onOpen?: () => void;
  parentDescription?: string;
}) {
  return (
    <DataListRow
      title={onOpen ? <button type="button" className="block w-full truncate text-left hover:underline" onClick={onOpen}
        aria-label={`Open transcript for ${activity.description}`}>{activity.description}</button>
        : <span className="block truncate">{activity.description}</span>}
      description={activity.kind === "subagent" ? [activity.effectiveModel ?? activity.requestedModel ?? "Model not reported", parentDescription].filter(Boolean).join(" / ")
        : activity.kind === "process" ? "Process" : "External activity"}
      descriptionClassName="!mt-0"
      badge={<StatusBadge size="sm"><StateText>{activity.status}</StateText></StatusBadge>}
      actions={canStop ? (
        <button type="button" className="shrink-0 py-1 text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-red-600 disabled:opacity-50 dark:text-gray-400" disabled={disabled || stopping} onClick={onStop}>
          {stopping ? "Stopping" : "Stop"}
        </button>
      ) : undefined}
    />
  );
}

function HarnessActivityPage({ kind, entityId, snapshot, capabilities, onBack, binding, fileLinkContext }: HarnessActivityProps) {
  const readOnly = useWorkspaceReadOnly();
  const { activity, loaded, error, stoppingId, unconfirmedId, stop } = useHarnessActivity({ kind, entityId, snapshot });
  const saved = useSavedSubagents(kind, entityId);
  const [selected, setSelected] = useState<Subagent | null>(null);
  const nativeItems = activity?.observation === "available" ? activity.activities : [];
  const savedCurrent = new Set(saved.items.filter((item) => item.binding.nativeId === binding?.nativeId).map((item) => item.activity.id));
  const canStop = (item: HarnessActivity) => !readOnly && item.ownership === "owned"
    && ["queued", "running", "waiting", "unknown"].includes(item.status)
    && (item.kind === "process" ? capabilities?.stopScopes.includes("command") === true
      : item.kind === "subagent" && capabilities?.stopScopes.includes("child-execution") === true);
  const childToolContext = useMemo(() => {
    const byTool = new Map<string, HarnessActivity[]>();
    for (const item of saved.items) {
      if (!selected || item.binding.nativeId !== selected.binding.nativeId || item.activity.parentId !== selected.activity.id
        || !item.activity.spawningToolCallId) continue;
      const key = item.activity.spawningToolCallId;
      byTool.set(key, [...(byTool.get(key) ?? []), item.activity]);
    }
    return { byTool, inputs: new Map<string, HarnessInputReceipt>(), onOpenActivity: () => setSelected(null) };
  }, [saved.items, selected]);
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
    <div className={`flex h-full min-h-0 flex-col ${selected ? "invisible" : ""}`} inert={selected ? true : undefined} aria-hidden={selected ? true : undefined}>
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
              <span>Principal: <StateText>{activity.principalProcessing ? "Running" : "Idle"}</StateText></span>
            </div>
            {activity.coverage === "partial" && (
              <ErrorState title="Partial observation" description="Some background work may not be visible." />
            )}
            {unconfirmedId && (
              <ErrorState title="Termination unconfirmed" description="Waiting for native termination confirmation." />
            )}
            <DataList>
              {nativeItems.filter((item) => !savedCurrent.has(item.id)).map((item) => (
                  <ActivityRow
                    key={item.id}
                    activity={item}
                    canStop={canStop(item)}
                    stopping={stoppingId === item.id}
                    disabled={stoppingId !== undefined && stoppingId !== item.id}
                    onStop={() => void stop(item.id)}
                  />
                ))}
            </DataList>
          </div>
        )}
      </Panel>
      <Panel title="Subagent conversations">
        {!saved.loaded && <LoadingState title="Loading saved subagents" />}
        {saved.error && <ErrorState title="Saved subagents could not be loaded" description={saved.error} />}
        {saved.loaded && !saved.error && !saved.items.length && <EmptyState title="No saved subagent conversations" />}
        <DataList>
          {saved.items.map((item) => {
            const currentSession = item.binding.nativeId === binding?.nativeId;
            const native = currentSession ? nativeItems.find((candidate) => candidate.id === item.activity.id) : undefined;
            const parent = item.activity.parentId ? saved.items.find((candidate) => candidate.binding.nativeId === item.binding.nativeId && candidate.activity.id === item.activity.parentId) : undefined;
            return <ActivityRow key={item.id} activity={native ?? item.activity}
              parentDescription={[parent ? `From ${parent.activity.description}` : item.activity.parentId ? "Nested subagent" : undefined,
                !currentSession ? "Previous session" : undefined, item.coverage === "partial" ? "Partial history" : undefined].filter(Boolean).join(" / ")}
              canStop={Boolean(native && canStop(native))} stopping={currentSession && stoppingId === item.activity.id}
              disabled={stoppingId !== undefined && stoppingId !== item.activity.id}
              onStop={() => void stop(item.activity.id)} onOpen={() => setSelected(item)} />;
          })}
        </DataList>
        {saved.hasMore && <button type="button" className="mt-3 text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
          disabled={saved.loading} onClick={saved.loadMore}>{saved.loading ? "Loading" : "Load older subagents"}</button>}
      </Panel>
    </Page>
    </div>
    {selected && <div className="absolute inset-0 flex min-h-0 flex-col">
      <ToolActivityContext.Provider value={childToolContext}>
        <SubagentTranscript key={selected.id} kind={kind} entityId={entityId} initialSubagent={selected}
          binding={binding} fileLinkContext={fileLinkContext} onBack={() => setSelected(null)} />
      </ToolActivityContext.Provider>
    </div>}
    </div>
  );
}

export function HarnessEntityView({
  showActivity,
  children,
  activityFooter,
  ...props
}: HarnessActivityProps & { showActivity: boolean; children: ReactNode; activityFooter?: ReactNode }) {
  const readOnly = useWorkspaceReadOnly();
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
      inputs={readOnly ? undefined : props.inputs}
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
              <div className="flex min-h-0 flex-1 flex-col"><HarnessActivityPage key={`${props.kind}:${props.entityId}`} {...props} /></div>
              {activityFooter}
            </div>
          )}
        </div>
      </ToolActivityContext.Provider>
    </HarnessInputReconciliationProvider>
  );
}
