import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, AgentEvent, AgentRun, BranchInfo, ModelConfig, ModelInfo, Workspace } from "../../types";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { CreateAgentRequest, UpdateAgentRequest } from "../../types/schemas";
import { appFetch } from "../../lib/public-path";
import { isAgentEvent, useAppEvents, useMarkdownPreference, useToast } from "../../hooks";
import { mergeToolCallRecord, upsertToolCallExtra } from "../../types/tool-call";
import { ConversationViewer } from "../LogViewer";
import { ModelSelector, makeModelKey, parseModelKey } from "../ModelSelector";
import { BranchSelector } from "../create-task/branch-selector";
import { ConfirmModal } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import { FrameworkMainHeaderPortal } from "./main-header-portal";

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
  });
}

function AgentStatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClassName(status)}`}>
      {status}
    </span>
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
  headerOffsetClassName,
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
  headerOffsetClassName: string;
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

  const title = mode === "edit"
    ? `Edit agent ${agent?.config.name ?? ""}`
    : initialWorkspace ? `Start a new agent in ${initialWorkspace.name}` : "Start a new agent";

  return (
    <ShellPanel
      title={title}
      description={selectedWorkspace?.directory}
      descriptionClassName="hidden font-mono sm:inline"
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={
              isSubmitting
              || branchesLoading
              || modelsLoading
              || !selectedWorkspace
              || !modelKey
              || !name.trim()
              || !prompt.trim()
              || intervalValue < 1
            }
            loading={isSubmitting}
          >
            {mode === "edit" ? "Save agent" : "Create agent"}
          </Button>
        </>
      )}
    >
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
    </ShellPanel>
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
  onNavigate: (route: ShellRoute) => void;
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
  workspace,
  agents,
  loading,
  error,
  headerOffsetClassName,
  onNavigate,
}: {
  workspace: Workspace | null;
  agents: Agent[];
  loading: boolean;
  error: string | null;
  headerOffsetClassName: string;
  onNavigate: (route: ShellRoute) => void;
}) {
  return (
    <ShellPanel
      title={workspace ? `Agents in ${workspace.name}` : "Agents"}
      description={workspace?.directory}
      descriptionClassName="hidden font-mono sm:inline"
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
    >
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading agents...</p>}
      <div className="grid gap-3">
        {agents.map((agent) => (
          <button
            key={agent.config.id}
            type="button"
            className="rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-gray-300 dark:border-gray-800 dark:bg-neutral-950 dark:hover:border-gray-700"
            onClick={() => onNavigate({ view: "agent", agentId: agent.config.id })}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">{agent.config.name}</h2>
              <AgentStatusPill status={agent.state.status} />
            </div>
            <p className="mt-2 line-clamp-2 text-sm text-gray-600 dark:text-gray-300">{agent.config.prompt}</p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Next run: {formatDate(agent.state.nextRunAt)} · Every {agent.config.schedule.interval.value} {agent.config.schedule.interval.unit}
            </p>
          </button>
        ))}
        {!loading && agents.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-neutral-950 dark:text-gray-400">
            No agents yet.
          </div>
        )}
      </div>
    </ShellPanel>
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
  headerOffsetClassName,
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
  headerOffsetClassName: string;
  editing: boolean;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onDeleteRun: UseAgentsResult["deleteRun"];
  onRefreshRuns: UseAgentsResult["refreshRuns"];
  onCancelEdit: () => void;
  onSavedEdit: (agent: Agent) => void;
  onNavigate: (route: ShellRoute) => void;
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
        headerOffsetClassName={headerOffsetClassName}
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
    <>
      <ShellPanel
        title={agent.config.name}
        description={workspace?.directory}
        descriptionClassName="hidden font-mono sm:inline"
        variant="compact"
        headerOffsetClassName={headerOffsetClassName}
        badges={<AgentStatusPill status={agent.state.status} />}
      >
        <div className="space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950">
            <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{agent.config.prompt}</p>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-500 dark:text-gray-400">
              <span>Next run: {formatDate(agent.state.nextRunAt)}</span>
              <span>Every {agent.config.schedule.interval.value} {agent.config.schedule.interval.unit}</span>
              <span>Base branch: {agent.config.baseBranch ?? "default"}</span>
              <span>Worktree: {agent.config.useWorktree ? "yes" : "no"}</span>
            </div>
          </div>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Runs</h2>
            <AgentRunsList
              agent={agent}
              runs={runs}
              onDeleteRun={onDeleteRun}
              onNavigate={onNavigate}
            />
          </section>
        </div>
      </ShellPanel>
    </>
  );
}

function AgentRunDetail({
  agent,
  runId,
  initialRun,
  headerOffsetClassName,
  onNavigate,
}: {
  agent: Agent | null;
  runId: string;
  initialRun: AgentRun | null;
  headerOffsetClassName: string;
  onNavigate: (route: ShellRoute) => void;
}) {
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const [run, setRun] = useState<AgentRun | null>(initialRun);
  const [loading, setLoading] = useState(!initialRun);
  const [error, setError] = useState<string | null>(null);

  const refreshRun = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await appFetch(`/api/agent-runs/${runId}`);
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to fetch agent run"));
      }
      setRun(await response.json() as AgentRun);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    if (!run) {
      void refreshRun();
    }
  }, [refreshRun, run]);

  useAppEvents<AgentEvent>((event) => {
    if (!run || !("agentRunId" in event) || event.agentRunId !== run.id) {
      return;
    }
    if (event.type === "agent.run.started" || event.type === "agent.run.completed") {
      setRun(event.run);
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
      return;
    }
    if (event.type === "agent.run.status") {
      setRun((current) => current ? { ...current, status: event.status, updatedAt: event.timestamp } : current);
      return;
    }
    if (event.type === "agent.run.failed") {
      setRun((current) => current
        ? {
            ...current,
            status: "failed",
            error: { message: event.message, timestamp: event.timestamp, code: "failed" },
            completedAt: current.completedAt ?? event.timestamp,
            updatedAt: event.timestamp,
          }
        : current);
      return;
    }
    if (event.type === "agent.run.interrupted") {
      setRun((current) => current
        ? { ...current, status: "interrupted", completedAt: current.completedAt ?? event.timestamp, updatedAt: event.timestamp }
        : current);
    }
  }, isAgentEvent);

  if (loading && !run) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading agent run...</div>;
  }

  if (!run) {
    return (
      <ShellPanel
        title="Agent run not found"
        variant="compact"
        headerOffsetClassName={headerOffsetClassName}
      >
        <p className="text-sm text-gray-500 dark:text-gray-400">{error ?? "The selected agent run no longer exists."}</p>
      </ShellPanel>
    );
  }

  const isActive = run.status === "scheduled" || run.status === "starting" || run.status === "running";
  const backRoute = agent ? { view: "agent", agentId: agent.config.id } as const : { view: "home" } as const;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-900">
      <FrameworkMainHeaderPortal
        title={agent?.config.name ?? run.configSnapshot.name}
        description={formatDate(run.scheduledFor)}
        badges={<AgentStatusPill status={run.status} />}
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onNavigate(backRoute)}
          >
            ← Back
          </Button>
        )}
      />
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
  shellHeaderOffsetClassName,
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
  shellHeaderOffsetClassName: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  navigateWithinShell: (route: ShellRoute) => void;
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
      headerOffsetClassName={shellHeaderOffsetClassName}
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
  headerOffsetClassName,
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
  route: ShellRoute;
  navigateWithinShell: (route: ShellRoute) => void;
  headerOffsetClassName: string;
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
    const agent = agents.find((item) => item.config.id === route.agentId);
    if (!agent) {
      return loading ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading agent...</div>
      ) : (
        <ShellPanel title="Agent not found" variant="compact" headerOffsetClassName={headerOffsetClassName}>
          <p className="text-sm text-gray-500 dark:text-gray-400">The selected agent no longer exists.</p>
        </ShellPanel>
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
        headerOffsetClassName={headerOffsetClassName}
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
    const agent = agents.find((item) => item.config.id === route.agentId) ?? null;
    const initialRun = (runsByAgentId[route.agentId] ?? []).find((run) => run.id === route.runId) ?? null;
    return (
      <AgentRunDetail
        agent={agent}
        runId={route.runId}
        initialRun={initialRun}
        headerOffsetClassName={headerOffsetClassName}
        onNavigate={navigateWithinShell}
      />
    );
  }

  const workspaceId = route.view === "agents" ? route.workspaceId : undefined;
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  const visibleAgents = workspace
    ? agents.filter((agent) => agent.config.workspaceId === workspace.id)
    : agents;

  return (
    <AgentWorkspaceList
      workspace={workspace}
      agents={visibleAgents}
      loading={loading}
      error={error}
      headerOffsetClassName={headerOffsetClassName}
      onNavigate={navigateWithinShell}
    />
  );
}
