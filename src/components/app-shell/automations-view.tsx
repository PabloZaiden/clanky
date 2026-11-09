import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Automation,
  AutomationRun,
  ChatTranscript,
  ModelConfig,
  Workspace,
} from "@/shared";
import { isAutomationCodeEnabled } from "@/shared/automation";
import type { BranchInfo, ModelInfo } from "@/contracts";
import type { UseAutomationsResult } from "../../hooks/useAutomations";
import { useMarkdownPreference, useTranscriptResource } from "../../hooks";
import { ConversationViewer } from "../log-viewer";
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  useHeaderActions,
  useToast,
  type ActionMenuItem,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { Button, getAutomationStatusBadgeVariant, StateText, StatusBadge } from "../common";
import { getRouteString } from "./route-fields";
import { ClankyListRow } from "./clanky-list-row";
import { AutomationDeterministicMode } from "./automation-deterministic-mode";
import { AutomationFormFields } from "./automation-form-fields";
import { useAutomationCodeGeneration } from "./use-automation-code-generation";
import { useAutomationCodeTest } from "./use-automation-code-test";
import { useAutomationFormState } from "./use-automation-form-state";
import { DeterministicOutputStreams } from "./deterministic-output-streams";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function AutomationStatusPill({ status }: { status: string }) {
  return (
    <StatusBadge variant={getAutomationStatusBadgeVariant(status)} size="md">
      <StateText>{status}</StateText>
    </StatusBadge>
  );
}

function AutomationForm({
  mode,
  automation = null,
  initialWorkspace,
  workspaces,
  workspacesLoading,
  workspaceError,
  models,
  modelsLoading,
  modelsWorkspaceId,
  lastModel,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAutomation,
  onImportAutomation,
  onUpdateAutomation,
  onPrepareGenerateAutomationCode,
  onGenerateAutomationCode,
  onTestAutomationCode,
  onSaved,
}: {
  mode: "create" | "edit";
  automation?: Automation | null;
  initialWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (
    workspaceId: string | null,
    directory: string,
    workspaceType?: Workspace["workspaceType"],
  ) => void;
  onCreateAutomation: UseAutomationsResult["createAutomation"];
  onImportAutomation?: (workspaceId: string) => void;
  onUpdateAutomation: UseAutomationsResult["updateAutomation"];
  onPrepareGenerateAutomationCode: UseAutomationsResult["prepareGenerateAutomationCode"];
  onGenerateAutomationCode: UseAutomationsResult["generateAutomationCode"];
  onTestAutomationCode: UseAutomationsResult["testAutomationCode"];
  onSaved: (automation: Automation) => void;
}) {
  const resetTestOutputRef = useRef<() => void>(() => {});
  const resetTestOutput = useCallback((): void => {
    resetTestOutputRef.current();
  }, []);
  const form = useAutomationFormState({
    mode,
    automation,
    initialWorkspace,
    workspaces,
    workspacesLoading,
    models,
    modelsLoading,
    modelsWorkspaceId,
    lastModel,
    branches,
    branchesLoading,
    branchesWorkspaceId,
    currentBranch,
    defaultBranch,
    onWorkspaceChange,
    onCreateAutomation,
    onUpdateAutomation,
    onSaved,
  });
  const generation = useAutomationCodeGeneration({
    mode,
    automation,
    name: form.draft.name,
    prompt: form.draft.prompt,
    selectedWorkspace: form.selectedWorkspace,
    modelKey: form.draft.modelKey,
    workspaceSelectionsReady: form.workspaceSelectionsReady,
    onPrepareGenerateAutomationCode,
    onGenerateAutomationCode,
    onCodeChanged: resetTestOutput,
  });
  const testing = useAutomationCodeTest({
    name: form.draft.name,
    prompt: form.draft.prompt,
    code: generation.code,
    selectedWorkspace: form.selectedWorkspace,
    modelKey: form.draft.modelKey,
    baseBranch: form.draft.baseBranch,
    useWorktree: form.worktreeForNewRun,
    workspaceSelectionsReady: form.workspaceSelectionsReady,
    onTestStarted: generation.invalidatePendingDraft,
    onTestAutomationCode,
  });
  resetTestOutputRef.current = testing.resetOutput;

  const canSubmit = form.canSubmit
    && !generation.isGeneratingCode
    && !testing.isTestingCode;
  const canGenerateCode = mode === "edit"
    && Boolean(automation)
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
  const headerActions = useMemo(() => [
    {
      id: "save-automation",
      label: mode === "edit" ? "Save" : "Create",
      onAction: handleSubmit,
      disabled: !canSubmit,
      loading: form.isSubmitting,
    },
    ...(mode === "create" && onImportAutomation ? [{
      id: "import-automation",
      label: "Import Automation",
      onAction: () => {
        if (form.selectedWorkspace) onImportAutomation(form.selectedWorkspace.id);
      },
      disabled: !form.selectedWorkspace || form.selectedWorkspace.access === "read"
        || form.isSubmitting || generation.isGeneratingCode || testing.isTestingCode,
    }] : []),
  ], [
    canSubmit, form.isSubmitting, form.selectedWorkspace, generation.isGeneratingCode,
    handleSubmit, mode, onImportAutomation, testing.isTestingCode,
  ]);
  const headerMenuActions = useMemo<ActionMenuItem[]>(() => [
    {
      id: "generate-code",
      label: generation.isGeneratingCode ? "Generating..." : "Generate",
      disabled: !canGenerateCode || form.isSubmitting,
      onAction: () => void generation.generateCode(),
    },
    ...(generation.isGeneratingCode ? [{
      id: "cancel-generation",
      label: "Cancel generation",
      destructive: true,
      onAction: generation.cancelGeneration,
    }] : []),
    {
      id: "test-code",
      label: testing.isTestingCode ? "Testing..." : "Test",
      disabled: !canTestCode || form.isSubmitting,
      onAction: () => void testing.testCode(),
    },
    ...(testing.isTestingCode ? [{
      id: "cancel-test",
      label: "Cancel test",
      destructive: true,
      onAction: testing.cancelTest,
    }] : []),
  ], [
    canGenerateCode,
    canTestCode,
    generation,
    form.isSubmitting,
    testing,
  ]);
  useHeaderActions({ primary: headerActions, overflow: headerMenuActions });

  return (
    <div className="space-y-5">
      {form.schedulerError && (
        <ErrorState
          title="Scheduling defaults unavailable"
          description={String(form.schedulerError)}
          action={<Button onClick={() => void form.refreshScheduler()}>Retry</Button>}
        />
      )}
      <AutomationFormFields
        mode={mode}
        initialWorkspace={initialWorkspace}
        draft={form.draft}
        schedulerTimezone={form.schedulerTimezone}
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
        worktreeControlDisabled={form.worktreeControlDisabled}
        setStartAtLocal={form.setStartAtLocal}
        setIntervalValue={form.setIntervalValue}
        setIntervalUnit={form.setIntervalUnit}
      />
      <AutomationDeterministicMode
        mode={mode}
        automation={automation}
        generation={generation}
        testing={testing}
      />
    </div>
  );
}

function AutomationRunsList({
  automation,
  runs,
  onDeleteRun,
  onNavigate,
}: {
  automation: Automation;
  runs: AutomationRun[];
  onDeleteRun: (runId: string) => Promise<boolean>;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const toast = useToast();
  const readOnly = useWorkspaceReadOnly();
  const [deleteRun, setDeleteRun] = useState<AutomationRun | null>(null);
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
        toast.error("Failed to delete automation run");
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
              onClick={() => onNavigate({ view: "automation-run", automationId: automation.config.id, runId: run.id })}
            >
              <div className="flex flex-wrap items-center gap-2">
                <AutomationStatusPill status={run.status} />
                <span className="text-xs text-gray-500 dark:text-gray-400">{run.trigger}</span>
              </div>
              <p className="mt-1 truncate text-sm text-gray-700 dark:text-gray-200">
                {formatDate(run.scheduledFor)}
              </p>
              {run.error && (
                <p className="mt-1 truncate text-xs text-red-600 dark:text-red-300">{run.error.message}</p>
              )}
            </button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={readOnly || deletePending}
              onClick={() => setDeleteRun(run)}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>
      <ConfirmModal
        isOpen={!readOnly && Boolean(deleteRun)}
        onClose={closeDeleteRunConfirmation}
        onConfirm={() => void handleConfirmDeleteRun()}
        title="Delete automation run"
        message={`Delete the ${deleteRun?.trigger ?? "selected"} run for "${automation.config.name}" scheduled for ${formatDate(deleteRun?.scheduledFor)}? This cannot be undone.`}
        confirmLabel="Delete run"
        variant="danger"
        loading={deletePending}
      />
    </>
  );
}

function AutomationWorkspaceList({
  automations,
  loading,
  error,
  onNavigate,
}: {
  automations: Automation[];
  loading: boolean;
  error: string | null;
  onNavigate: (route: WebAppRoute) => void;
}) {
  return (
    <Panel>
      {error ? <ErrorState title="Unable to load automations" description={error} /> : null}
      {loading ? <LoadingState title="Loading automations" /> : null}
      <div className="space-y-2">
        {automations.map((automation) => (
          <ClankyListRow
            key={automation.config.id}
            title={automation.config.name}
            description={automation.config.prompt}
            descriptionClassName="line-clamp-2"
            meta={`Next run: ${formatDate(automation.state.nextRunAt)} · Every ${automation.config.schedule.interval.value} ${automation.config.schedule.interval.unit}`}
            metaPlacement="below"
            badge={<AutomationStatusPill status={automation.state.status} />}
            onClick={() => onNavigate({ view: "automation", automationId: automation.config.id })}
          />
        ))}
        {!loading && automations.length === 0 && (
          <EmptyState title="No automations yet" description="Create one to automate tasks on a schedule." />
        )}
      </div>
    </Panel>
  );
}

function AutomationDetail({
  automation,
  runs,
  workspaces,
  workspacesLoading,
  workspaceError,
  models,
  modelsLoading,
  modelsWorkspaceId,
  lastModel,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  editing,
  onWorkspaceChange,
  onUpdateAutomation,
  onPrepareGenerateAutomationCode,
  onGenerateAutomationCode,
  onTestAutomationCode,
  onDeleteRun,
  onRefreshRuns,
  onSavedEdit,
  onNavigate,
}: {
  automation: Automation;
  runs: AutomationRun[];
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  editing: boolean;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAutomation: UseAutomationsResult["updateAutomation"];
  onPrepareGenerateAutomationCode: UseAutomationsResult["prepareGenerateAutomationCode"];
  onGenerateAutomationCode: UseAutomationsResult["generateAutomationCode"];
  onTestAutomationCode: UseAutomationsResult["testAutomationCode"];
  onDeleteRun: UseAutomationsResult["deleteRun"];
  onRefreshRuns: UseAutomationsResult["refreshRuns"];
  onSavedEdit: (automation: Automation) => void;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const workspace = workspaces.find((item) => item.id === automation.config.workspaceId) ?? null;
  const readOnly = useWorkspaceReadOnly();

  useEffect(() => {
    void onRefreshRuns(automation.config.id);
  }, [automation.config.id, onRefreshRuns]);

  if (editing && !readOnly) {
    return (
      <AutomationForm
        mode="edit"
        automation={automation}
        initialWorkspace={workspace}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        models={models}
        modelsLoading={modelsLoading}
        modelsWorkspaceId={modelsWorkspaceId}
        lastModel={lastModel}
        branches={branches}
        branchesLoading={branchesLoading}
        branchesWorkspaceId={branchesWorkspaceId}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        onWorkspaceChange={onWorkspaceChange}
        onCreateAutomation={async () => null}
        onUpdateAutomation={onUpdateAutomation}
        onPrepareGenerateAutomationCode={onPrepareGenerateAutomationCode}
        onGenerateAutomationCode={onGenerateAutomationCode}
        onTestAutomationCode={onTestAutomationCode}
        onSaved={(savedAutomation) => {
          onSavedEdit(savedAutomation);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950">
        <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{automation.config.prompt}</p>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-500 dark:text-gray-400">
          <span>Next run: {formatDate(automation.state.nextRunAt)}</span>
          <span>Every {automation.config.schedule.interval.value} {automation.config.schedule.interval.unit}</span>
          <span>Execution: {isAutomationCodeEnabled(automation.config) ? "deterministic code" : "prompt"}</span>
          <span>Base branch: {automation.config.baseBranch ?? "default"}</span>
          <span>Worktree: {automation.config.useWorktree ? "yes" : "no"}</span>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Runs</h2>
        <div>
        <AutomationRunsList
          automation={automation}
          runs={runs}
          onDeleteRun={onDeleteRun}
          onNavigate={onNavigate}
        />
        </div>
      </section>
    </div>
  );
}

function DeterministicOutputPanel({ logs }: { logs: AutomationRun["logs"] }) {
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

interface AutomationRunSnapshotResponse {
  run: AutomationRun;
  transcript: ChatTranscript;
}

function decodeAutomationRunSnapshot(
  snapshot: AutomationRunSnapshotResponse,
): { resource: AutomationRun; transcript: ChatTranscript } {
  return {
    resource: {
      ...snapshot.run,
      messages: [],
      logs: [],
      toolCalls: [],
    },
    transcript: snapshot.transcript,
  };
}

function AutomationRunDetail({
  runId,
  initialRun,
  onMissingEntity,
}: {
  runId: string;
  initialRun: AutomationRun | null;
  onMissingEntity: () => void;
}) {
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const transcriptResource = useTranscriptResource<AutomationRun, AutomationRunSnapshotResponse>({
    resourceId: runId,
    resourceLabel: "automation run",
    stream: "automation.run",
    baseUrl: `/api/automation-runs/${encodeURIComponent(runId)}`,
    initialResource: initialRun,
    decodeSnapshot: decodeAutomationRunSnapshot,
  });
  const {
    resource: run,
    transcript,
    loading,
    loadingTranscript,
    error,
    notFound,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolDetails,
  } = transcriptResource;

  useEffect(() => {
    if (notFound) {
      onMissingEntity();
    }
  }, [notFound, onMissingEntity]);

  if (loading && !run) {
    return <LoadingState title="Loading automation run" />;
  }

  if (!run) {
    if (notFound) {
      return null;
    }
    return (
      <ErrorState
        title="Automation run not found"
        description={error ?? "The selected automation run no longer exists."}
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
      {error && (
        <div className="mx-4 mt-3">
          <ErrorState title="Unable to load automation run transcript" description={error} />
        </div>
      )}
      <DeterministicOutputPanel logs={transcript.logs} />
      <ConversationViewer
        id="automation-run-transcript"
        messages={transcript.messages}
        toolCalls={transcript.toolCalls}
        logs={transcript.logs}
        isActive={isActive}
        markdownEnabled={markdownEnabled}
        onLoadToolDetails={loadToolDetails}
        hasOlderTranscript={transcript.hasOlder}
        onLoadMoreTranscript={loadMoreTranscript}
        onLoadFullTranscript={loadFullTranscript}
        loadingTranscript={loadingTranscript}
      />
    </div>
  );
}

export function AutomationComposer({
  composeWorkspace,
  workspaces,
  workspacesLoading,
  workspaceError,
  models,
  modelsLoading,
  modelsWorkspaceId,
  lastModel,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAutomation,
  onImportAutomation,
  onPrepareGenerateAutomationCode,
  onGenerateAutomationCode,
  onTestAutomationCode,
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
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAutomation: UseAutomationsResult["createAutomation"];
  onImportAutomation: (workspaceId: string) => void;
  onPrepareGenerateAutomationCode: UseAutomationsResult["prepareGenerateAutomationCode"];
  onGenerateAutomationCode: UseAutomationsResult["generateAutomationCode"];
  onTestAutomationCode: UseAutomationsResult["testAutomationCode"];
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  return (
    <AutomationForm
      mode="create"
      initialWorkspace={composeWorkspace}
      workspaces={workspaces}
      workspacesLoading={workspacesLoading}
      workspaceError={workspaceError}
      models={models}
      modelsLoading={modelsLoading}
      modelsWorkspaceId={modelsWorkspaceId}
      lastModel={lastModel}
      branches={branches}
      branchesLoading={branchesLoading}
      branchesWorkspaceId={branchesWorkspaceId}
      currentBranch={currentBranch}
      defaultBranch={defaultBranch}
      onWorkspaceChange={onWorkspaceChange}
      onCreateAutomation={onCreateAutomation}
      onImportAutomation={onImportAutomation}
      onUpdateAutomation={async () => null}
      onPrepareGenerateAutomationCode={onPrepareGenerateAutomationCode}
      onGenerateAutomationCode={onGenerateAutomationCode}
      onTestAutomationCode={onTestAutomationCode}
      onSaved={(savedAutomation) => navigateWithinShell({ view: "automation", automationId: savedAutomation.config.id })}
    />
  );
}

export function AutomationsView({
  automations,
  workspaces,
  models,
  modelsLoading,
  modelsWorkspaceId,
  lastModel,
  selectedWorkspaceId: _selectedWorkspaceId,
  onWorkspaceChange,
  onUpdateAutomation,
  onPrepareGenerateAutomationCode,
  onGenerateAutomationCode,
  onTestAutomationCode,
  onDeleteRun,
  onRefreshRuns,
  runsByAutomationId,
  route,
  navigateWithinShell,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  loading,
  error,
  editingAutomationId,
  onSavedAutomationEdit,
}: {
  automations: Automation[];
  workspaces: Workspace[];
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onUpdateAutomation: UseAutomationsResult["updateAutomation"];
  onPrepareGenerateAutomationCode: UseAutomationsResult["prepareGenerateAutomationCode"];
  onGenerateAutomationCode: UseAutomationsResult["generateAutomationCode"];
  onTestAutomationCode: UseAutomationsResult["testAutomationCode"];
  onDeleteRun: UseAutomationsResult["deleteRun"];
  onRefreshRuns: UseAutomationsResult["refreshRuns"];
  runsByAutomationId: Record<string, AutomationRun[]>;
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  loading: boolean;
  error: string | null;
  editingAutomationId: string | null;
  onSavedAutomationEdit: (automation: Automation) => void;
}) {
  const navigateHome = useCallback(
    () => navigateWithinShell({ view: "home" }),
    [navigateWithinShell],
  );

  if (route.view === "automation") {
    const automationId = getRouteString(route, "automationId");
    if (!automationId) {
      return (
        <ErrorState
          title="Invalid route"
          description="The automation route is missing its automation identifier. Use the sidebar or home button to continue."
        />
      );
    }
    const automation = automations.find((item) => item.config.id === automationId);
    if (!automation) {
      return loading ? (
        <LoadingState title="Loading automation" />
      ) : (
        <ErrorState title="Automation not found" description="The selected automation no longer exists." />
      );
    }
    return (
      <AutomationDetail
        automation={automation}
        runs={runsByAutomationId[automation.config.id] ?? []}
        workspaces={workspaces}
        workspacesLoading={false}
        workspaceError={null}
        models={models}
        modelsLoading={modelsLoading}
        modelsWorkspaceId={modelsWorkspaceId}
        lastModel={lastModel}
        branches={branches}
        branchesLoading={branchesLoading}
        branchesWorkspaceId={branchesWorkspaceId}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        editing={editingAutomationId === automation.config.id}
        onWorkspaceChange={onWorkspaceChange}
        onUpdateAutomation={onUpdateAutomation}
        onPrepareGenerateAutomationCode={onPrepareGenerateAutomationCode}
        onGenerateAutomationCode={onGenerateAutomationCode}
        onTestAutomationCode={onTestAutomationCode}
        onDeleteRun={onDeleteRun}
        onRefreshRuns={onRefreshRuns}
        onSavedEdit={onSavedAutomationEdit}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "automation-run") {
    const automationId = getRouteString(route, "automationId");
    const runId = getRouteString(route, "runId");
    if (!automationId || !runId) {
      return (
        <ErrorState
          title="Invalid route"
          description="The automation run route is missing an identifier. Use the sidebar or home button to continue."
        />
      );
    }
    const initialRun = (runsByAutomationId[automationId] ?? []).find((run) => run.id === runId) ?? null;
    return (
      <AutomationRunDetail
        key={`automation-run:${runId}`}
        runId={runId}
        initialRun={initialRun}
        onMissingEntity={navigateHome}
      />
    );
  }

  const workspaceId = route.view === "automations" ? getRouteString(route, "workspaceId") : undefined;
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  const visibleAutomations = workspace
    ? automations.filter((automation) => automation.config.workspaceId === workspace.id)
    : automations;

  return (
    <AutomationWorkspaceList
      automations={visibleAutomations}
      loading={loading}
      error={error}
      onNavigate={navigateWithinShell}
    />
  );
}
