import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeTranscriptSnapshot, mergeTranscriptToolCalls } from "@/shared";
import type {
  Agent,
  AgentEvent,
  AgentRun,
  ChatTranscript,
  ModelConfig,
  ToolCallData,
  Workspace,
} from "@/shared";
import { isAgentCodeEnabled } from "@/shared/agent";
import type { BranchInfo, ModelInfo } from "@/contracts";
import type { UseAgentsResult } from "../../hooks/useAgents";
import { readApiResponse, requestApiResponse } from "../../lib/api-client";
import { createRefreshCoordinator } from "../../lib/refresh-coordinator";
import { useMarkdownPreference, useRealtimeRefreshWithRecovery, useRealtimeStream } from "../../hooks";
import { isToolCallSummary, upsertToolCallExtra } from "@/shared/tool-call";
import { ConversationViewer } from "../LogViewer";
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  useToast,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { Button, getAgentStatusBadgeVariant, StatusBadge } from "../common";
import { getRouteString } from "./route-fields";
import { useShellHeaderActions } from "./shell-header-actions";
import { ClankyListRow } from "./clanky-list-row";
import { AgentDeterministicMode } from "./agent-deterministic-mode";
import { AgentFormFields } from "./agent-form-fields";
import { useAgentCodeGeneration } from "./use-agent-code-generation";
import { useAgentCodeTest } from "./use-agent-code-test";
import { useAgentFormState } from "./use-agent-form-state";

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function upsertById<T extends { id: string; timestamp?: string }>(items: T[], item: T): T[] {
  const existingIndex = items.findIndex((entry) => entry.id === item.id);
  const nextItems = existingIndex === -1 ? [...items, item] : items.map((entry, index) => (
    index === existingIndex ? item : entry
  ));
  return nextItems.sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? ""));
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
  modelsWorkspaceId,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
  onUpdateAgent,
  onPrepareGenerateAgentCode,
  onGenerateAgentCode,
  onTestAgentCode,
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
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onPrepareGenerateAgentCode: UseAgentsResult["prepareGenerateAgentCode"];
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onTestAgentCode: UseAgentsResult["testAgentCode"];
  onCancel: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const resetTestOutputRef = useRef<() => void>(() => {});
  const resetTestOutput = useCallback((): void => {
    resetTestOutputRef.current();
  }, []);
  const form = useAgentFormState({
    mode,
    agent,
    initialWorkspace,
    workspaces,
    models,
    modelsLoading,
    modelsWorkspaceId,
    lastModel,
    schedulerTimezone,
    branches,
    branchesLoading,
    branchesWorkspaceId,
    currentBranch,
    defaultBranch,
    onWorkspaceChange,
    onCreateAgent,
    onUpdateAgent,
    onSaved,
  });
  const generation = useAgentCodeGeneration({
    mode,
    agent,
    name: form.draft.name,
    prompt: form.draft.prompt,
    selectedWorkspace: form.selectedWorkspace,
    modelKey: form.draft.modelKey,
    workspaceSelectionsReady: form.workspaceSelectionsReady,
    onPrepareGenerateAgentCode,
    onGenerateAgentCode,
    onCodeChanged: resetTestOutput,
  });
  const testing = useAgentCodeTest({
    name: form.draft.name,
    prompt: form.draft.prompt,
    code: generation.code,
    selectedWorkspace: form.selectedWorkspace,
    modelKey: form.draft.modelKey,
    baseBranch: form.draft.baseBranch,
    useWorktree: form.draft.useWorktree,
    workspaceSelectionsReady: form.workspaceSelectionsReady,
    onTestStarted: generation.invalidatePendingDraft,
    onTestAgentCode,
  });
  resetTestOutputRef.current = testing.resetOutput;

  const canSubmit = form.canSubmit
    && !generation.isGeneratingCode
    && !testing.isTestingCode;
  const canGenerateCode = mode === "edit"
    && Boolean(agent)
    && !form.isSubmitting
    && !generation.isGeneratingCode
    && !testing.isTestingCode
    && form.workspaceSelectionsReady;
  const canTestCode = !form.isSubmitting
    && !generation.isGeneratingCode
    && !testing.isTestingCode
    && Boolean(generation.code.trim())
    && form.workspaceSelectionsReady;
  const handleSubmit = useCallback((): void => {
    void form.submit(generation.code);
  }, [form.submit, generation.code]);
  const headerActions = useMemo(() => (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={form.isSubmitting}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={handleSubmit}
        disabled={!canSubmit}
        loading={form.isSubmitting}
      >
        {mode === "edit" ? "Save agent" : "Create agent"}
      </Button>
    </>
  ), [canSubmit, form.isSubmitting, handleSubmit, mode, onCancel]);
  useShellHeaderActions(headerActions);

  return (
    <div className="space-y-5">
      <AgentFormFields
        mode={mode}
        initialWorkspace={initialWorkspace}
        draft={form.draft}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        selectedWorkspace={form.selectedWorkspace}
        models={models}
        modelsLoading={modelsLoading}
        branches={branches}
        branchesLoading={branchesLoading}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        setName={form.setName}
        setPrompt={form.setPrompt}
        setWorkspaceId={form.setWorkspaceId}
        setModelKey={form.setModelKey}
        setBaseBranch={form.setBaseBranch}
        setUseWorktree={form.setUseWorktree}
        setStartAtLocal={form.setStartAtLocal}
        setIntervalValue={form.setIntervalValue}
        setIntervalUnit={form.setIntervalUnit}
      />
      <AgentDeterministicMode
        mode={mode}
        agent={agent}
        isSubmitting={form.isSubmitting}
        canGenerateCode={canGenerateCode}
        canTestCode={canTestCode}
        generation={generation}
        testing={testing}
      />
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
  modelsWorkspaceId,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  editing,
  onWorkspaceChange,
  onUpdateAgent,
  onPrepareGenerateAgentCode,
  onGenerateAgentCode,
  onTestAgentCode,
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
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  editing: boolean;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onPrepareGenerateAgentCode: UseAgentsResult["prepareGenerateAgentCode"];
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onTestAgentCode: UseAgentsResult["testAgentCode"];
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
        modelsWorkspaceId={modelsWorkspaceId}
        lastModel={lastModel}
        schedulerTimezone={schedulerTimezone}
        branches={branches}
        branchesLoading={branchesLoading}
        branchesWorkspaceId={branchesWorkspaceId}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        onWorkspaceChange={onWorkspaceChange}
        onCreateAgent={async () => null}
        onUpdateAgent={onUpdateAgent}
        onPrepareGenerateAgentCode={onPrepareGenerateAgentCode}
        onGenerateAgentCode={onGenerateAgentCode}
        onTestAgentCode={onTestAgentCode}
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
          <span>Execution: {isAgentCodeEnabled(agent.config) ? "deterministic code" : "prompt"}</span>
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

function DeterministicOutputStreams({ logs }: { logs: AgentRun["logs"] }) {
  const outputLogs = logs.filter((log) => {
    const stream = log.details?.["stream"];
    return stream === "stdout" || stream === "stderr";
  });

  const renderStream = (stream: "stdout" | "stderr") => outputLogs
    .filter((log) => log.details?.["stream"] === stream)
    .map((log) => log.message)
    .join("");

  const stdout = renderStream("stdout");
  const stderr = renderStream("stderr");
  return (
    <div className="grid gap-3 rounded-md border border-gray-200 bg-neutral-950 p-3 text-xs text-gray-100 dark:border-gray-700">
      <div className="min-w-0">
        <h2 className="font-semibold text-gray-300">stdout</h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{stdout || "(empty)"}</pre>
      </div>
      <div className="min-w-0">
        <h2 className="font-semibold text-red-300">stderr</h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-red-100">{stderr || "(empty)"}</pre>
      </div>
    </div>
  );
}

function DeterministicOutputPanel({ logs }: { logs: AgentRun["logs"] }) {
  const hasOutput = logs.some((log) => {
    const stream = log.details?.["stream"];
    return stream === "stdout" || stream === "stderr";
  });
  if (!hasOutput) {
    return null;
  }
  return (
    <section className="mx-4 mt-3">
      <DeterministicOutputStreams logs={logs} />
    </section>
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
  const [transcript, setTranscript] = useState<ChatTranscript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<ChatTranscript | null>(null);
  const snapshotEtagRef = useRef<string | null>(null);
  const previousRunIdRef = useRef(runId);
  const runIdRef = useRef(runId);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  runIdRef.current = runId;

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const refreshRun = useCallback((options: { showLoading?: boolean } = {}) => {
    return refreshCoordinatorRef.current.run(async () => {
      const requestRunId = runId;
      const showLoading = options.showLoading ?? true;
      try {
        if (showLoading) {
          setLoading(true);
        }
        setError(null);
        const headers = new Headers();
        if (snapshotEtagRef.current) {
          headers.set("If-None-Match", snapshotEtagRef.current);
        }
        const response = await requestApiResponse(`/api/agent-runs/${runId}/snapshot`, {
          headers,
          action: "Fetch agent run snapshot",
          fallbackMessage: "Failed to fetch agent run",
          acceptedStatuses: [304],
        });
        if (runIdRef.current !== requestRunId) {
          return;
        }
        if (response.status === 304) {
          return;
        }
        const snapshot = await readApiResponse<{ run: AgentRun; transcript: ChatTranscript }>(response);
        if (runIdRef.current !== requestRunId) {
          return;
        }
        snapshotEtagRef.current = response.headers.get("ETag");
        setRun(snapshot.run);
        setTranscript(mergeTranscriptSnapshot(transcriptRef.current, snapshot.transcript));
      } catch (refreshError) {
        if (runIdRef.current !== requestRunId) {
          return;
        }
        setError(String(refreshError));
      } finally {
        if (showLoading && runIdRef.current === requestRunId) {
          setLoading(false);
        }
      }
    });
  }, [runId]);

  useEffect(() => {
    const runChanged = previousRunIdRef.current !== runId;
    if (runChanged) {
      refreshCoordinatorRef.current.reset();
      snapshotEtagRef.current = null;
      previousRunIdRef.current = runId;
      transcriptRef.current = null;
      setTranscript(null);
    }
    setRun(initialRun);
    void refreshRun();
  }, [initialRun, refreshRun, runId]);

  const loadToolDetails = useCallback(async (toolCallId: string): Promise<ToolCallData | null> => {
    const response = await requestApiResponse(
      `/api/agent-runs/${runId}/tool-calls/${encodeURIComponent(toolCallId)}`,
      {
        action: "Fetch agent tool-call details",
        fallbackMessage: "Failed to load tool-call details",
        acceptedStatuses: [404],
      },
    );
    if (response.status === 404) {
      return null;
    }
    return await readApiResponse<ToolCallData>(response);
  }, [runId]);

  useRealtimeRefreshWithRecovery({
    resources: ["agent-runs"],
    ids: [runId],
    filters: { resource: "agent-runs", id: runId, scope: agent?.config.id },
    refresh: (event) => {
      if (event.action === "deleted") {
        setRun(null);
        return;
      }
      return refreshRun({ showLoading: false });
    },
    onReconnect: () => refreshRun({ showLoading: false }),
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
        setTranscript((current) => current ? {
          ...current,
          messages: upsertById(current.messages, event.message),
          totalEntries: current.totalEntries + 1,
        } : current);
        return;
      }
      if (event.type === "agent.run.tool_call") {
        setTranscript((current) => current ? {
          ...current,
          toolCalls: mergeTranscriptToolCalls(current.toolCalls, [event.tool]),
        } : current);
        return;
      }
      if (event.type === "agent.run.tool_call.extra") {
        setTranscript((current) => current ? {
          ...current,
          toolCalls: current.toolCalls.map((toolCall) => (
            toolCall.id === event.toolId && !isToolCallSummary(toolCall)
              ? { ...toolCall, extras: upsertToolCallExtra(toolCall.extras, event.extra) }
              : toolCall
          )),
        } : current);
        return;
      }
      if (event.type === "agent.run.log") {
        setTranscript((current) => current ? {
          ...current,
          logs: upsertById(current.logs, event.log),
          totalEntries: current.totalEntries + 1,
        } : current);
        return;
      }
      if (event.type === "agent.run.status") {
        setRun((current) => current ? { ...current, status: event.status, updatedAt: event.timestamp } : current);
      }
    },
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
    <div className="flex h-full min-h-0 flex-col">
      {run.error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {run.error.message}
        </div>
      )}
      <DeterministicOutputPanel logs={transcript?.logs ?? []} />
      <ConversationViewer
        id="agent-run-transcript"
        messages={transcript?.messages ?? []}
        toolCalls={transcript?.toolCalls ?? []}
        logs={transcript?.logs ?? []}
        isActive={isActive}
        markdownEnabled={markdownEnabled}
        showAssistantMessages
        showResponseLogs={false}
        emptyStateMessage="No messages yet"
        activeStateMessage="Running..."
        onLoadToolDetails={loadToolDetails}
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
  modelsWorkspaceId,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
  onPrepareGenerateAgentCode,
  onGenerateAgentCode,
  onTestAgentCode,
  navigateWithinShell,
}: {
  composeWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  onPrepareGenerateAgentCode: UseAgentsResult["prepareGenerateAgentCode"];
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onTestAgentCode: UseAgentsResult["testAgentCode"];
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
      modelsWorkspaceId={modelsWorkspaceId}
      lastModel={lastModel}
      schedulerTimezone={schedulerTimezone}
      branches={branches}
      branchesLoading={branchesLoading}
      branchesWorkspaceId={branchesWorkspaceId}
      currentBranch={currentBranch}
      defaultBranch={defaultBranch}
      onWorkspaceChange={onWorkspaceChange}
      onCreateAgent={onCreateAgent}
      onUpdateAgent={async () => null}
      onPrepareGenerateAgentCode={onPrepareGenerateAgentCode}
      onGenerateAgentCode={onGenerateAgentCode}
      onTestAgentCode={onTestAgentCode}
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
  modelsWorkspaceId,
  lastModel,
  schedulerTimezone,
  selectedWorkspaceId: _selectedWorkspaceId,
  onWorkspaceChange,
  onUpdateAgent,
  onPrepareGenerateAgentCode,
  onGenerateAgentCode,
  onTestAgentCode,
  onDeleteRun,
  onRefreshRuns,
  runsByAgentId,
  route,
  navigateWithinShell,
  branches,
  branchesLoading,
  branchesWorkspaceId,
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
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onPrepareGenerateAgentCode: UseAgentsResult["prepareGenerateAgentCode"];
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onTestAgentCode: UseAgentsResult["testAgentCode"];
  onDeleteRun: UseAgentsResult["deleteRun"];
  onRefreshRuns: UseAgentsResult["refreshRuns"];
  runsByAgentId: Record<string, AgentRun[]>;
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
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
        modelsWorkspaceId={modelsWorkspaceId}
        lastModel={lastModel}
        schedulerTimezone={schedulerTimezone}
        branches={branches}
        branchesLoading={branchesLoading}
        branchesWorkspaceId={branchesWorkspaceId}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        editing={editingAgentId === agent.config.id}
        onWorkspaceChange={onWorkspaceChange}
        onUpdateAgent={onUpdateAgent}
        onPrepareGenerateAgentCode={onPrepareGenerateAgentCode}
        onGenerateAgentCode={onGenerateAgentCode}
        onTestAgentCode={onTestAgentCode}
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
