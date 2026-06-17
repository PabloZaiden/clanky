import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentRun, ModelConfig, ModelInfo, Workspace } from "../../types";
import type { UseAgentsResult } from "../../hooks/useAgents";
import { ModelSelector, makeModelKey, parseModelKey } from "../ModelSelector";

const inputClassName = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700";
const buttonClassName = "inline-flex items-center justify-center rounded-lg border border-gray-900 bg-gray-900 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-300 dark:border-gray-100 dark:bg-gray-100 dark:text-gray-950 dark:hover:bg-gray-200 dark:disabled:border-gray-700 dark:disabled:bg-gray-700 dark:disabled:text-gray-400";
const secondaryButtonClassName = "inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:border-gray-400 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:text-white";

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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
  return "bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-gray-300";
}

function getDefaultModelKey(models: ModelInfo[], lastModel: ModelConfig | null): string {
  if (lastModel) {
    return makeModelKey(lastModel.providerID, lastModel.modelID, lastModel.variant);
  }
  const connected = models.find((model) => model.connected);
  if (!connected) {
    return "";
  }
  return makeModelKey(connected.providerID, connected.modelID, connected.variants?.[0] ?? "");
}

function AgentRunsList({
  runs,
  onDeleteRun,
}: {
  runs: AgentRun[];
  onDeleteRun: (runId: string) => Promise<boolean>;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No runs yet.</p>;
  }

  return (
    <div className="space-y-2">
      {runs.slice(0, 5).map((run) => (
        <div key={run.id} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-neutral-950">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClassName(run.status)}`}>
                  {run.status}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{run.trigger}</span>
              </div>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
                Scheduled {formatDate(run.scheduledFor)}
              </p>
              {run.error && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-300">{run.error.message}</p>
              )}
            </div>
            <button
              type="button"
              className={secondaryButtonClassName}
              onClick={() => void onDeleteRun(run.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AgentsView({
  agents,
  workspaces,
  models,
  modelsLoading,
  lastModel,
  selectedWorkspaceId,
  onWorkspaceChange,
  onCreateAgent,
  onRunAgent,
  onInterruptAgent,
  onDeleteAgent,
  onDeleteRun,
  onPurgeRuns,
  onRefreshRuns,
  runsByAgentId,
  loading,
  error,
}: {
  agents: Agent[];
  workspaces: Workspace[];
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  onRunAgent: UseAgentsResult["runAgent"];
  onInterruptAgent: UseAgentsResult["interruptAgent"];
  onDeleteAgent: UseAgentsResult["deleteAgent"];
  onDeleteRun: UseAgentsResult["deleteRun"];
  onPurgeRuns: UseAgentsResult["purgeRuns"];
  onRefreshRuns: UseAgentsResult["refreshRuns"];
  runsByAgentId: Record<string, AgentRun[]>;
  loading: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspaceId, setWorkspaceId] = useState(selectedWorkspaceId ?? workspaces[0]?.id ?? "");
  const [modelKey, setModelKey] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [startAtLocal, setStartAtLocal] = useState(() => new Date().toISOString().slice(0, 16));
  const [intervalValue, setIntervalValue] = useState(60);
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days">("minutes");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }
    onWorkspaceChange(selectedWorkspace.id, selectedWorkspace.directory);
  }, [onWorkspaceChange, selectedWorkspace]);

  useEffect(() => {
    if (!modelKey) {
      setModelKey(getDefaultModelKey(models, lastModel));
    }
  }, [lastModel, modelKey, models]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedModel = parseModelKey(modelKey);
    if (!selectedWorkspace || !parsedModel) {
      return;
    }
    const created = await onCreateAgent({
      name,
      workspaceId: selectedWorkspace.id,
      prompt,
      model: parsedModel,
      baseBranch: baseBranch.trim() || undefined,
      useWorktree,
      schedule: {
        startAtLocal,
        timezone,
        interval: {
          value: intervalValue,
          unit: intervalUnit,
        },
      },
      enabled: true,
    });
    if (created) {
      setName("");
      setPrompt("");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6 dark:bg-neutral-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Automation</p>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950 dark:text-gray-50">Agents</h1>
          <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
            Schedule chat-style prompts for a workspace. Runs are separate from Tasks and always auto-approve permissions.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Create agent</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>Name</span>
              <input className={inputClassName} value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>Workspace</span>
              <select className={inputClassName} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} required>
                <option value="">Select workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>Model</span>
              <ModelSelector
                value={modelKey}
                onChange={setModelKey}
                models={models}
                loading={modelsLoading}
                className={inputClassName}
              />
            </label>
            <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>Base branch</span>
              <input className={inputClassName} value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="Current/default branch" />
            </label>
            <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>Start at</span>
              <input className={inputClassName} type="datetime-local" value={startAtLocal} onChange={(event) => setStartAtLocal(event.target.value)} required />
            </label>
            <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>Timezone</span>
              <input className={inputClassName} value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
            </label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
                <span>Every</span>
                <input className={inputClassName} type="number" min={1} value={intervalValue} onChange={(event) => setIntervalValue(Number(event.target.value))} required />
              </label>
              <label className="space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
                <span>Unit</span>
                <select className={inputClassName} value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as "minutes" | "hours" | "days")}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 pt-7 text-sm text-gray-700 dark:text-gray-200">
              <input type="checkbox" checked={useWorktree} onChange={(event) => setUseWorktree(event.target.checked)} />
              Create a worktree for each run
            </label>
          </div>
          <label className="mt-4 block space-y-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            <span>Prompt</span>
            <textarea className={`${inputClassName} min-h-28`} value={prompt} onChange={(event) => setPrompt(event.target.value)} required />
          </label>
          <div className="mt-4 flex justify-end">
            <button type="submit" className={buttonClassName} disabled={!modelKey || !workspaceId || !name || !prompt}>Create agent</button>
          </div>
        </form>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
        {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading agents...</p>}

        <div className="grid gap-4">
          {agents.map((agent) => (
            <article key={agent.config.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-50">{agent.config.name}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClassName(agent.state.status)}`}>
                      {agent.state.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{agent.config.prompt}</p>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Next run: {formatDate(agent.state.nextRunAt)} · Every {agent.config.schedule.interval.value} {agent.config.schedule.interval.unit}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className={secondaryButtonClassName} type="button" onClick={() => void onRefreshRuns(agent.config.id)}>Refresh runs</button>
                  {agent.state.status === "running" ? (
                    <button className={secondaryButtonClassName} type="button" onClick={() => void onInterruptAgent(agent.config.id)}>Interrupt</button>
                  ) : (
                    <button className={buttonClassName} type="button" onClick={() => void onRunAgent(agent.config.id)}>Run now</button>
                  )}
                  <button className={secondaryButtonClassName} type="button" onClick={() => void onPurgeRuns(agent.config.id)}>Purge runs</button>
                  <button className={secondaryButtonClassName} type="button" onClick={() => void onDeleteAgent(agent.config.id)}>Delete</button>
                </div>
              </div>
              <div className="mt-4">
                <AgentRunsList runs={runsByAgentId[agent.config.id] ?? []} onDeleteRun={onDeleteRun} />
              </div>
            </article>
          ))}
          {!loading && agents.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-400">
              No agents yet. Create one to schedule recurring workspace prompts.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

