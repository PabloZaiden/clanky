import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeTranscriptSnapshot, mergeTranscriptToolCalls } from "@/shared";
import type {
  Agent,
  AgentEvent,
  AgentRun,
  ChatTranscript,
  DeterministicAgentTestResult,
  DeterministicCodeDiagnostic,
  ModelConfig,
  ToolCallData,
  Workspace,
} from "@/shared";
import { isAgentCodeEnabled } from "@/shared/agent";
import type { BranchInfo, ModelInfo } from "@/contracts";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { CreateAgentRequest, TestAgentCodeRequest, UpdateAgentRequest } from "@/contracts/schemas";
import type { TaskLogEntry } from "@/shared/task";
import { appFetch } from "../../lib/public-path";
import { useMarkdownPreference, useRealtimeStream } from "../../hooks";
import { isToolCallSummary, upsertToolCallExtra } from "@/shared/tool-call";
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
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
  onUpdateAgent,
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
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onTestAgentCode: UseAgentsResult["testAgentCode"];
  onCancel: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(agent?.config.name ?? "");
  const [prompt, setPrompt] = useState(agent?.config.prompt ?? "");
  const [code, setCode] = useState(agent?.config.code ?? "");
  const [codeDiagnostics, setCodeDiagnostics] = useState<DeterministicCodeDiagnostic[]>([]);
  const [generationComments, setGenerationComments] = useState("");
  const [testResult, setTestResult] = useState<DeterministicAgentTestResult | null>(null);
  const [testLogs, setTestLogs] = useState<TaskLogEntry[]>([]);
  const [testStreamId, setTestStreamId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState(agent?.config.workspaceId ?? initialWorkspace?.id ?? "");
  const workspaceForBranchRef = useRef<string | null>(agent?.config.workspaceId ?? initialWorkspace?.id ?? null);
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
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [isTestingCode, setIsTestingCode] = useState(false);
  const generateAbortControllerRef = useRef<AbortController | null>(null);
  const testAbortControllerRef = useRef<AbortController | null>(null);
  const testLogIdsRef = useRef(new Set<string>());

  useEffect(() => () => {
    generateAbortControllerRef.current?.abort();
    testAbortControllerRef.current?.abort();
  }, []);

  function appendTestLog(entry: TaskLogEntry): void {
    if (testLogIdsRef.current.has(entry.id)) {
      return;
    }
    testLogIdsRef.current.add(entry.id);
    setTestLogs((previous) => [...previous, entry].slice(-1000));
  }

  useRealtimeStream<AgentEvent>({
    enabled: isTestingCode && testStreamId !== null,
    filters: { agentRunId: testStreamId ?? undefined },
    predicate: (event) => event.type === "agent.run.log" && event.agentRunId === testStreamId,
    onEvent: (event) => {
      if (event.type === "agent.run.log") {
        appendTestLog(event.log);
      }
    },
  });

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
      workspaceForBranchRef.current = null;
      return;
    }
    if (workspaceForBranchRef.current !== selectedWorkspace.id) {
      workspaceForBranchRef.current = selectedWorkspace.id;
      setBaseBranch("");
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
      code: code.trim() || null,
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

  async function handleGenerateCode(): Promise<void> {
    const parsedGenerationModel = parseModelKey(modelKey);
    if (!selectedWorkspace || !parsedGenerationModel) {
      toast.error("Select a workspace and model before generating code");
      return;
    }
    const controller = new AbortController();
    generateAbortControllerRef.current = controller;
    setIsGeneratingCode(true);
    try {
      const generated = await onGenerateAgentCode({
        name: name.trim() || undefined,
        prompt,
        comments: generationComments,
        previousCode: code,
        workspaceId: selectedWorkspace.id,
        model: parsedGenerationModel,
      }, agent?.config.id, { signal: controller.signal });
      if (!generated || controller.signal.aborted) {
        return;
      }
      setCode(generated.code);
      setCodeDiagnostics(generated.diagnostics);
      setTestResult(null);
      setTestLogs([]);
      toast.success(
        generated.diagnostics.length > 0
          ? "Code draft generated with validation warnings. Fix them before saving."
          : "Code draft generated. Save the agent to enable it.",
      );
    } finally {
      if (generateAbortControllerRef.current === controller) {
        generateAbortControllerRef.current = null;
      }
      setIsGeneratingCode(false);
    }
  }

  function handleCancelGenerateCode(): void {
    const controller = generateAbortControllerRef.current;
    if (!controller || controller.signal.aborted) {
      return;
    }
    controller.abort();
  }

  async function handleTestCode(): Promise<void> {
    const parsedTestModel = parseModelKey(modelKey);
    if (!selectedWorkspace || !parsedTestModel) {
      toast.error("Select a workspace and model before testing code");
      return;
    }
    if (!code.trim()) {
      toast.error("Enter deterministic code before testing it");
      return;
    }
    setIsTestingCode(true);
    setTestResult(null);
    setTestLogs([]);
    testLogIdsRef.current.clear();
    const testRunId = crypto.randomUUID();
    setTestStreamId(testRunId);
    const controller = new AbortController();
    testAbortControllerRef.current = controller;
    try {
      const result = await onTestAgentCode({
        name: name.trim() || undefined,
        prompt,
        code,
        workspaceId: selectedWorkspace.id,
        model: parsedTestModel,
        baseBranch: baseBranch.trim() || undefined,
        useWorktree,
        testRunId,
      } satisfies TestAgentCodeRequest, {
        signal: controller.signal,
        onLog: appendTestLog,
      });
      if (!result || controller.signal.aborted) {
        if (!result && !controller.signal.aborted) {
          setTestResult({
            status: "failed",
            logs: [],
            error: "Deterministic code test ended without a result",
            diagnostics: [],
          });
        }
        return;
      }
      setTestResult(result);
      setTestLogs((previous) => result.logs.length > 0 ? result.logs : previous);
      if (result.status === "completed") {
        toast.success("Deterministic code test completed");
      } else if (result.status === "failed") {
        toast.error(result.error ?? "Deterministic code test failed");
      }
    } finally {
      if (testAbortControllerRef.current === controller) {
        testAbortControllerRef.current = null;
      }
      setTestStreamId(null);
      setIsTestingCode(false);
    }
  }

  function handleCancelTest(): void {
    const controller = testAbortControllerRef.current;
    if (!controller || controller.signal.aborted) {
      return;
    }
    setTestResult({
      status: "cancelled",
      logs: testLogs,
      diagnostics: [],
    });
    setTestStreamId(null);
    controller.abort();
  }

  const canSubmit = !isSubmitting
    && !isGeneratingCode
    && !isTestingCode
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

        <section className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Deterministic Mode (optional)</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Deterministic Mode code replaces the scheduled prompt. Leave it empty to keep prompt mode
            </p>
          </div>
          <div>
            <label htmlFor="agent-code-comments" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Generation comments
            </label>
            <textarea
              id="agent-code-comments"
              value={generationComments}
              onChange={(event) => setGenerationComments(event.target.value)}
              className={`${inputClassName} min-h-20 resize-y`}
              placeholder="Describe what to change in the generated code"
              disabled={isGeneratingCode}
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            The user can only see text written to stdout and stderr. Do not print anything to either stream that should remain hidden.
          </p>
          <div>
            <label htmlFor="agent-code" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              TypeScript code
            </label>
            <textarea
              id="agent-code"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setCodeDiagnostics([]);
                setTestResult(null);
                setTestLogs([]);
              }}
              className={`${inputClassName} min-h-72 resize-y font-mono text-xs`}
              spellCheck={false}
              disabled={isGeneratingCode || isTestingCode}
              placeholder={'export default async function run(ctx) {\n  // Use ctx.workspace.exec or ctx.workspace.prompt\n}'}
            />
            {codeDiagnostics.length > 0 && (
              <div className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-300">
                {codeDiagnostics.map((diagnostic, index) => (
                  <p key={`${diagnostic.line ?? "code"}-${diagnostic.column ?? "position"}-${index}`}>
                    {diagnostic.line ? `Line ${diagnostic.line}: ` : ""}{diagnostic.message}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-28"
              onClick={() => void handleGenerateCode()}
              disabled={isSubmitting || isGeneratingCode || isTestingCode || !selectedWorkspace || !modelKey}
              loading={isGeneratingCode}
            >
              Generate
            </Button>
            {isGeneratingCode && (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleCancelGenerateCode}
              >
                Cancel generation
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-28"
              onClick={() => void handleTestCode()}
              disabled={isSubmitting || isGeneratingCode || isTestingCode || !code.trim() || !selectedWorkspace || !modelKey}
              loading={isTestingCode}
            >
              Test
            </Button>
            {isTestingCode && (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleCancelTest}
              >
                Cancel test
              </Button>
            )}
          </div>
          {(isTestingCode || testResult || testLogs.length > 0) && (
            <DeterministicTestOutputPanel
              result={testResult}
              logs={testLogs}
              isRunning={isTestingCode}
            />
          )}
        </section>
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
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  editing: boolean;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAgent: UseAgentsResult["updateAgent"];
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
        lastModel={lastModel}
        schedulerTimezone={schedulerTimezone}
        branches={branches}
        branchesLoading={branchesLoading}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        onWorkspaceChange={onWorkspaceChange}
        onCreateAgent={async () => null}
        onUpdateAgent={onUpdateAgent}
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

function DeterministicTestOutputPanel({
  result,
  logs,
  isRunning,
}: {
  result: DeterministicAgentTestResult | null;
  logs: AgentRun["logs"];
  isRunning: boolean;
}) {
  return (
    <section className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Test output</h2>
        <StatusBadge
          variant={
            isRunning
              ? "info"
              : result?.status === "completed"
                ? "success"
                : result?.status === "cancelled"
                  ? "warning"
                  : "error"
          }
          size="sm"
        >
          {isRunning ? "running" : result?.status ?? "failed"}
        </StatusBadge>
      </div>
      {result?.error && (
        <p className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-300">{result.error}</p>
      )}
      {result && result.diagnostics.length > 0 && (
        <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
          {result.diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.line ?? "code"}-${diagnostic.column ?? "position"}-${index}`}>
              {diagnostic.line ? `Line ${diagnostic.line}: ` : ""}{diagnostic.message}
            </p>
          ))}
        </div>
      )}
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

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const refreshRun = useCallback(async (options: { showLoading?: boolean } = {}) => {
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
      const response = await appFetch(`/api/agent-runs/${runId}/snapshot`, { headers });
      if (response.status === 304) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to fetch agent run"));
      }
      const snapshot = await response.json() as { run: AgentRun; transcript: ChatTranscript };
      snapshotEtagRef.current = response.headers.get("ETag");
      setRun(snapshot.run);
      setTranscript(mergeTranscriptSnapshot(transcriptRef.current, snapshot.transcript));
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [runId]);

  useEffect(() => {
    const runChanged = previousRunIdRef.current !== runId;
    if (runChanged) {
      snapshotEtagRef.current = null;
      previousRunIdRef.current = runId;
      transcriptRef.current = null;
      setTranscript(null);
    }
    setRun(initialRun);
    void refreshRun();
  }, [initialRun, refreshRun, runId]);

  const loadToolDetails = useCallback(async (toolCallId: string): Promise<ToolCallData | null> => {
    const response = await appFetch(`/api/agent-runs/${runId}/tool-calls/${encodeURIComponent(toolCallId)}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(await parseError(response, "Failed to load tool-call details"));
    }
    return await response.json() as ToolCallData;
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
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
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
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
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
      lastModel={lastModel}
      schedulerTimezone={schedulerTimezone}
      branches={branches}
      branchesLoading={branchesLoading}
      currentBranch={currentBranch}
      defaultBranch={defaultBranch}
      onWorkspaceChange={onWorkspaceChange}
      onCreateAgent={onCreateAgent}
      onUpdateAgent={async () => null}
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
  lastModel,
  schedulerTimezone,
  selectedWorkspaceId: _selectedWorkspaceId,
  onWorkspaceChange,
  onUpdateAgent,
  onGenerateAgentCode,
  onTestAgentCode,
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
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onTestAgentCode: UseAgentsResult["testAgentCode"];
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
