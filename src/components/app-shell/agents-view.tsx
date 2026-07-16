import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, AgentEvent, AgentRun, ModelConfig, Workspace } from "@/shared";
import type { BranchInfo, ModelInfo } from "@/contracts";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { CreateAgentRequest, UpdateAgentRequest } from "@/contracts/schemas";
import { appFetch } from "../../lib/public-path";
import { useMarkdownPreference, useRealtimeStream } from "../../hooks";
import { mergeToolCallRecord, upsertToolCallExtra } from "@/shared/tool-call";
import { ConversationViewer } from "../LogViewer";
import { ModelSelector, makeModelKey, parseModelKey } from "../ModelSelector";
import { BranchSelector } from "../create-task/branch-selector";
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  useToast,
  useRealtimeRefresh,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { Button, getAgentStatusBadgeVariant, StatusBadge } from "../common";
import { getRouteString } from "./route-fields";
import { useShellHeaderActions } from "./shell-header-actions";
import { ClankyListRow } from "./clanky-list-row";

const inputClassName = "mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60";
const compactInputClassName = "mt-1 block rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60";

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDateTimeLocalInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

function getDefaultModelKey(models: ModelInfo[], lastModel: ModelConfig | null): string {
  if (lastModel) {
    return makeModelKey(lastModel.providerID, lastModel.modelID, lastModel.variant);
  }
  const connected = models.find((model) => model.connected);
  return connected ? makeModelKey(connected.providerID, connected.modelID, connected.variants?.[0] ?? "") : "";
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

function upsertById<T extends { id: string; timestamp?: string }>(items: T[], item: T): T[] {
  return [...items.filter((entry) => entry.id !== item.id), item].sort((left, right) => {
    const byTimestamp = (left.timestamp ?? "").localeCompare(right.timestamp ?? "");
    return byTimestamp !== 0 ? byTimestamp : left.id.localeCompare(right.id);
  }).slice(-1000);
}

function AgentStatusPill({ status }: { status: string }) {
  return (
    <StatusBadge variant={getAgentStatusBadgeVariant(status)} size="md">
      {status}
    </StatusBadge>
  );
}

function AgentForm({
  mode,
  agent = null,
  initialWorkspace,
  workspaces,
  workspacesLoading,
  workspaceError,
  models,
  modelsLoading,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
  onUpdateAgent,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  agent?: Agent | null;
  initialWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onCancel: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(agent?.config.name ?? "");
  const [prompt, setPrompt] = useState(agent?.config.prompt ?? "");
  const [workspaceId, setWorkspaceId] = useState(agent?.config.workspaceId ?? initialWorkspace?.id ?? "");
  const [modelKey, setModelKey] = useState(agent
    ? makeModelKey(agent.config.model.providerID, agent.config.model.modelID, agent.config.model.variant)
    : "");
  const [baseBranch, setBaseBranch] = useState(agent?.config.baseBranch ?? "");
  const [useWorktree, setUseWorktree] = useState(agent?.config.useWorktree ?? true);
  const [startAtLocal, setStartAtLocal] = useState(
    agent?.config.schedule.startAtLocal ?? formatDateTimeLocalInTimezone(new Date(), schedulerTimezone),
  );
  const [startAtTouched, setStartAtTouched] = useState(Boolean(agent));
  const [intervalValue, setIntervalValue] = useState(agent?.config.schedule.interval.value ?? 60);
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days">(agent?.config.schedule.interval.unit ?? "minutes");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

  useEffect(() => {
    if (mode === "create" && initialWorkspace && workspaceId !== initialWorkspace.id) {
      setWorkspaceId(initialWorkspace.id);
    }
  }, [initialWorkspace?.id, mode, workspaceId]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setBaseBranch("");
      return;
    }
    onWorkspaceChange(selectedWorkspace.id, selectedWorkspace.directory);
  }, [onWorkspaceChange, selectedWorkspace?.directory, selectedWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace || baseBranch) {
      return;
    }
    setBaseBranch(defaultBranch || currentBranch);
  }, [baseBranch, currentBranch, defaultBranch, selectedWorkspace?.id]);

  useEffect(() => {
    if (modelKey || models.length === 0) {
      return;
    }
    setModelKey(getDefaultModelKey(models, lastModel));
  }, [lastModel, modelKey, models]);

  useEffect(() => {
    if (mode !== "create" || startAtTouched) {
      return;
    }
    setStartAtLocal(formatDateTimeLocalInTimezone(new Date(), schedulerTimezone));
  }, [mode, schedulerTimezone, startAtTouched]);

  async function handleSubmit(): Promise<void> {
    if (!selectedWorkspace) {
      toast.error("Select a workspace first");
      return;
    }
    const parsedModel = parseModelKey(modelKey);
    if (!parsedModel) {
      toast.error("Select a model first");
      return;
    }
    const schedule = {
      startAtLocal,
      timezone: schedulerTimezone,
      interval: {
        value: intervalValue,
        unit: intervalUnit,
      },
    };
    const baseRequest = {
      name: name.trim(),
      prompt: prompt.trim(),
      model: {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant ?? "",
      },
      baseBranch: baseBranch.trim() || undefined,
      useWorktree,
      schedule,
    };

    setIsSubmitting(true);
    try {
      const savedAgent = mode === "edit" && agent
        ? await onUpdateAgent(agent.config.id, {
            ...baseRequest,
            baseBranch: baseRequest.baseBranch ?? null,
          } satisfies UpdateAgentRequest)
        : await onCreateAgent({
            ...baseRequest,
            workspaceId: selectedWorkspace.id,
            enabled: true,
          } satisfies CreateAgentRequest);
      if (!savedAgent) {
        toast.error(mode === "edit" ? "Failed to save agent" : "Failed to create agent");
        return;
      }
      onSaved(savedAgent);
    } finally {
      setIsSubmitting(false);
    }
  }

  const canSubmit = !isSubmitting
    && !branchesLoading
    && !modelsLoading
    && Boolean(selectedWorkspace)
    && Boolean(modelKey)
    && Boolean(name.trim())
    && Boolean(prompt.trim())
    && intervalValue >= 1;
  const headerActions = useMemo(() => (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        loading={isSubmitting}
      >
        {mode === "edit" ? "Save agent" : "Create agent"}
      </Button>
    </>
  ), [canSubmit, handleSubmit, isSubmitting, mode, onCancel]);
  useShellHeaderActions(headerActions);

  return (
    <div className="space-y-5">
        <div>
          <label htmlFor="agent-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Name
          </label>
          <input
            id="agent-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClassName}
          />
        </div>

        <div>
          <label htmlFor="agent-workspace" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Workspace
          </label>
          <select
            id="agent-workspace"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            disabled={mode === "edit" || Boolean(initialWorkspace) || workspacesLoading}
            className={inputClassName}
          >
            <option value="">
              {workspacesLoading ? "Loading workspaces..." : "Select a workspace"}
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          {workspaceError && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{workspaceError}</p>
          )}
        </div>

        <div>
          <label htmlFor="agent-model" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Model
          </label>
          <ModelSelector
            id="agent-model"
            value={modelKey}
            onChange={setModelKey}
            models={models}
            loading={modelsLoading}
            showDisconnected
            variantDiscovery={selectedWorkspace ? {
              workspaceId: selectedWorkspace.id,
            } : undefined}
            className={inputClassName}
            emptyText="Select a workspace to load models"
          />
        </div>

        <BranchSelector
          selectedBranch={baseBranch}
          onBranchChange={setBaseBranch}
          branches={branches}
          branchesLoading={branchesLoading}
          defaultBranch={defaultBranch}
          currentBranch={currentBranch}
          helpText={null}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="agent-start-at" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Start at
            </label>
            <input
              id="agent-start-at"
              className={`${compactInputClassName} w-56`}
              type="datetime-local"
              value={startAtLocal}
              onChange={(event) => {
                setStartAtTouched(true);
                setStartAtLocal(event.target.value);
              }}
              required
            />
          </div>
          <div>
            <label htmlFor="agent-interval-value" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Every
            </label>
            <input
              id="agent-interval-value"
              className={`${compactInputClassName} w-24`}
              type="number"
              min={1}
              value={intervalValue}
              onChange={(event) => setIntervalValue(Number(event.target.value))}
              required
            />
          </div>
          <div>
            <label htmlFor="agent-interval-unit" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Unit
            </label>
            <select
              id="agent-interval-unit"
              className={`${compactInputClassName} w-36`}
              value={intervalUnit}
              onChange={(event) => setIntervalUnit(event.target.value as "minutes" | "hours" | "days")}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        </div>

        <label className="flex items-center gap-3 text-sm font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(event) => setUseWorktree(event.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
          />
          Use worktree
        </label>

        <div>
          <label htmlFor="agent-prompt" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Prompt
          </label>
          <textarea
            id="agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className={`${inputClassName} min-h-32 resize-y`}
          />
        </div>
    </div>
  );
}

function AgentRunsList({
  agent,
  runs,
  onDeleteRun,
  onNavigate,
}: {
  agent: Agent;
  runs: AgentRun[];
  onDeleteRun: (runId: string) => Promise<boolean>;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const toast = useToast();
  const [deleteRun, setDeleteRun] = useState<AgentRun | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  function closeDeleteRunConfirmation(): void {
    if (deletePending) {
      return;
    }
    setDeleteRun(null);
  }

  async function handleConfirmDeleteRun(): Promise<void> {
    if (!deleteRun) {
      return;
    }
    setDeletePending(true);
    try {
      const deleted = await onDeleteRun(deleteRun.id);
      if (!deleted) {
        toast.error("Failed to delete agent run");
        return;
      }
      setDeleteRun(null);
    } finally {
      setDeletePending(false);
    }
  }

  if (runs.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No runs yet.</p>;
  }

  return (
    <>
      <div className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-neutral-950">
        {runs.slice(0, 25).map((run) => (
          <div key={run.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onNavigate({ view: "agent-run", agentId: agent.config.id, runId: run.id })}
            >
              <div className="flex flex-wrap items-center gap-2">
                <AgentStatusPill status={run.status} />
                <span className="text-xs text-gray-500 dark:text-gray-400">{run.trigger}</span>
              </div>
              <p className="mt-1 truncate text-sm text-gray-700 dark:text-gray-200">
                {formatDate(run.scheduledFor)}
              </p>
              {run.error && (
                <p className="mt-1 truncate text-xs text-red-600 dark:text-red-300">{run.error.message}</p>
              )}
            </button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteRun(run)}>
              Delete
            </Button>
          </div>
        ))}
      </div>
      <ConfirmModal
        isOpen={Boolean(deleteRun)}
        onClose={closeDeleteRunConfirmation}
        onConfirm={() => void handleConfirmDeleteRun()}
        title="Delete agent run"
        message={`Delete the ${deleteRun?.trigger ?? "selected"} run for "${agent.config.name}" scheduled for ${formatDate(deleteRun?.scheduledFor)}? This cannot be undone.`}
        confirmLabel="Delete run"
        loading={deletePending}
      />
    </>
  );
}

function AgentWorkspaceList({
  agents,
  loading,
  error,
  onNavigate,
}: {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  onNavigate: (route: WebAppRoute) => void;
}) {
  return (
    <Panel>
      {error ? <ErrorState title="Unable to load agents" description={error} /> : null}
      {loading ? <LoadingState title="Loading agents" /> : null}
      <div className="space-y-2">
        {agents.map((agent) => (
          <ClankyListRow
            key={agent.config.id}
            title={agent.config.name}
            description={agent.config.prompt}
            descriptionClassName="line-clamp-2"
            meta={`Next run: ${formatDate(agent.state.nextRunAt)} · Every ${agent.config.schedule.interval.value} ${agent.config.schedule.interval.unit}`}
            metaPlacement="below"
            badge={<AgentStatusPill status={agent.state.status} />}
            onClick={() => onNavigate({ view: "agent", agentId: agent.config.id })}
          />
        ))}
        {!loading && agents.length === 0 && (
          <EmptyState title="No agents yet" description="Create one to automate tasks on a schedule." />
        )}
      </div>
    </Panel>
  );
}

function AgentDetail({
  agent,
  runs,
  workspaces,
  workspacesLoading,
  workspaceError,
  models,
  modelsLoading,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  editing,
  onWorkspaceChange,
  onUpdateAgent,
  onDeleteRun,
  onRefreshRuns,
  onCancelEdit,
  onSavedEdit,
  onNavigate,
}: {
  agent: Agent;
  runs: AgentRun[];
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  editing: boolean;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onDeleteRun: UseAgentsResult["deleteRun"];
  onRefreshRuns: UseAgentsResult["refreshRuns"];
  onCancelEdit: () => void;
  onSavedEdit: (agent: Agent) => void;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const workspace = workspaces.find((item) => item.id === agent.config.workspaceId) ?? null;

  useEffect(() => {
    void onRefreshRuns(agent.config.id);
  }, [agent.config.id, onRefreshRuns]);

  if (editing) {
    return (
      <AgentForm
        mode="edit"
        agent={agent}
        initialWorkspace={workspace}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        models={models}
        modelsLoading={modelsLoading}
        lastModel={lastModel}
        schedulerTimezone={schedulerTimezone}
        branches={branches}
        branchesLoading={branchesLoading}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        onWorkspaceChange={onWorkspaceChange}
        onCreateAgent={async () => null}
        onUpdateAgent={onUpdateAgent}
        onCancel={onCancelEdit}
        onSaved={(savedAgent) => {
          onSavedEdit(savedAgent);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950">
        <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{agent.config.prompt}</p>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-500 dark:text-gray-400">
          <span>Next run: {formatDate(agent.state.nextRunAt)}</span>
          <span>Every {agent.config.schedule.interval.value} {agent.config.schedule.interval.unit}</span>
          <span>Base branch: {agent.config.baseBranch ?? "default"}</span>
          <span>Worktree: {agent.config.useWorktree ? "yes" : "no"}</span>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Runs</h2>
        <div>
        <AgentRunsList
          agent={agent}
          runs={runs}
          onDeleteRun={onDeleteRun}
          onNavigate={onNavigate}
        />
        </div>
      </section>
    </div>
  );
}

function AgentRunDetail({
  agent,
  runId,
  initialRun,
}: {
  agent: Agent | null;
  runId: string;
  initialRun: AgentRun | null;
}) {
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const [run, setRun] = useState<AgentRun | null>(initialRun);
  const [loading, setLoading] = useState(!initialRun);
  const [error, setError] = useState<string | null>(null);

  const refreshRun = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const response = await appFetch(`/api/agent-runs/${runId}`);
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to fetch agent run"));
      }
      setRun(await response.json() as AgentRun);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [runId]);

  useRealtimeRefresh({
    resources: ["agent-runs"],
    ids: [runId],
    filters: { resource: "agent-runs", id: runId, scope: agent?.config.id },
    enabled: agent !== null,
    refresh: (event) => {
      if (event.action === "deleted") {
        setRun(null);
        return;
      }
      return refreshRun({ showLoading: false });
    },
  });

  useEffect(() => {
    if (!run) {
      void refreshRun();
    }
  }, [refreshRun, run]);

  useRealtimeStream<AgentEvent>({
    filters: { agentRunId: runId },
    predicate: (event) => event.type.startsWith("agent.run."),
    onEvent: (event) => {
      if (!run || !("agentRunId" in event) || event.agentRunId !== run.id) {
        return;
      }
      if (event.type === "agent.run.message") {
        setRun((current) => current ? { ...current, messages: upsertById(current.messages, event.message), updatedAt: event.timestamp } : current);
        return;
      }
      if (event.type === "agent.run.tool_call") {
        setRun((current) => current
          ? {
              ...current,
              toolCalls: upsertById(
                current.toolCalls,
                mergeToolCallRecord(
                  current.toolCalls.find((toolCall) => toolCall.id === event.tool.id),
                  event.tool,
                ),
              ),
              updatedAt: event.timestamp,
            }
          : current);
        return;
      }
      if (event.type === "agent.run.tool_call.extra") {
        setRun((current) => current
          ? {
              ...current,
              toolCalls: current.toolCalls.map((toolCall) => (
                toolCall.id === event.toolId
                  ? { ...toolCall, extras: upsertToolCallExtra(toolCall.extras, event.extra) }
                  : toolCall
              )),
              updatedAt: event.timestamp,
            }
          : current);
        return;
      }
      if (event.type === "agent.run.log") {
        setRun((current) => current ? { ...current, logs: upsertById(current.logs, event.log), updatedAt: event.timestamp } : current);
      }
    },
    onReconnect: () => refreshRun({ showLoading: false }),
  });

  if (loading && !run) {
    return <LoadingState title="Loading agent run" />;
  }

  if (!run) {
    return (
      <ErrorState
        title="Agent run not found"
        description={error ?? "The selected agent run no longer exists."}
      />
    );
  }

  const isActive = run.status === "scheduled" || run.status === "starting" || run.status === "running";
  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-900">
      {run.error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {run.error.message}
        </div>
      )}
      <ConversationViewer
        id="agent-run-transcript"
        messages={run.messages}
        toolCalls={run.toolCalls}
        logs={run.logs}
        isActive={isActive}
        markdownEnabled={markdownEnabled}
        showAssistantMessages
        showResponseLogs={false}
        emptyStateMessage="No messages yet"
        activeStateMessage="Running..."
      />
    </div>
  );
}

export function AgentComposer({
  composeWorkspace,
  workspaces,
  workspacesLoading,
  workspaceError,
  models,
  modelsLoading,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
  navigateWithinShell,
}: {
  composeWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  return (
    <AgentForm
      mode="create"
      initialWorkspace={composeWorkspace}
      workspaces={workspaces}
      workspacesLoading={workspacesLoading}
      workspaceError={workspaceError}
      models={models}
      modelsLoading={modelsLoading}
      lastModel={lastModel}
      schedulerTimezone={schedulerTimezone}
      branches={branches}
      branchesLoading={branchesLoading}
      currentBranch={currentBranch}
      defaultBranch={defaultBranch}
      onWorkspaceChange={onWorkspaceChange}
      onCreateAgent={onCreateAgent}
      onUpdateAgent={async () => null}
      onCancel={() => navigateWithinShell(composeWorkspace ? { view: "agents", workspaceId: composeWorkspace.id } : { view: "home" })}
      onSaved={(savedAgent) => navigateWithinShell({ view: "agent", agentId: savedAgent.config.id })}
    />
  );
}

export function AgentsView({
  agents,
  workspaces,
  models,
  modelsLoading,
  lastModel,
  schedulerTimezone,
  selectedWorkspaceId: _selectedWorkspaceId,
  onWorkspaceChange,
  onUpdateAgent,
  onDeleteRun,
  onRefreshRuns,
  runsByAgentId,
  route,
  navigateWithinShell,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  loading,
  error,
  editingAgentId,
  onCancelAgentEdit,
  onSavedAgentEdit,
}: {
  agents: Agent[];
  workspaces: Workspace[];
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onDeleteRun: UseAgentsResult["deleteRun"];
  onRefreshRuns: UseAgentsResult["refreshRuns"];
  runsByAgentId: Record<string, AgentRun[]>;
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  loading: boolean;
  error: string | null;
  editingAgentId: string | null;
  onCancelAgentEdit: () => void;
  onSavedAgentEdit: (agent: Agent) => void;
}) {
  if (route.view === "agent") {
    const agentId = getRouteString(route, "agentId");
    if (!agentId) {
      return (
        <ErrorState
          title="Invalid route"
          description="The agent route is missing its agent identifier. Use the sidebar or home button to continue."
        />
      );
    }
    const agent = agents.find((item) => item.config.id === agentId);
    if (!agent) {
      return loading ? (
        <LoadingState title="Loading agent" />
      ) : (
        <ErrorState title="Agent not found" description="The selected agent no longer exists." />
      );
    }
    return (
      <AgentDetail
        agent={agent}
        runs={runsByAgentId[agent.config.id] ?? []}
        workspaces={workspaces}
        workspacesLoading={false}
        workspaceError={null}
        models={models}
        modelsLoading={modelsLoading}
        lastModel={lastModel}
        schedulerTimezone={schedulerTimezone}
        branches={branches}
        branchesLoading={branchesLoading}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        editing={editingAgentId === agent.config.id}
        onWorkspaceChange={onWorkspaceChange}
        onUpdateAgent={onUpdateAgent}
        onDeleteRun={onDeleteRun}
        onRefreshRuns={onRefreshRuns}
        onCancelEdit={onCancelAgentEdit}
        onSavedEdit={onSavedAgentEdit}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "agent-run") {
    const agentId = getRouteString(route, "agentId");
    const runId = getRouteString(route, "runId");
    if (!agentId || !runId) {
      return (
        <ErrorState
          title="Invalid route"
          description="The agent run route is missing an identifier. Use the sidebar or home button to continue."
        />
      );
    }
    const agent = agents.find((item) => item.config.id === agentId) ?? null;
    const initialRun = (runsByAgentId[agentId] ?? []).find((run) => run.id === runId) ?? null;
    return (
      <AgentRunDetail
        agent={agent}
        runId={runId}
        initialRun={initialRun}
      />
    );
  }

  const workspaceId = route.view === "agents" ? getRouteString(route, "workspaceId") : undefined;
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  const visibleAgents = workspace
    ? agents.filter((agent) => agent.config.workspaceId === workspace.id)
    : agents;

  return (
    <AgentWorkspaceList
      agents={visibleAgents}
      loading={loading}
      error={error}
      onNavigate={navigateWithinShell}
    />
  );
}
