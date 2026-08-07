import type { ModelInfo, BranchInfo } from "@/contracts";
import type { Workspace } from "@/shared";
import { ModelSelector } from "../ModelSelector";
import { BranchSelector } from "../create-task/branch-selector";
import type {
  AgentFormDraft,
  AgentFormIntervalUnit,
  AgentFormMode,
} from "./use-agent-form-state";

const inputClassName = "mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60";
const compactInputClassName = "mt-1 block rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60";

export interface AgentFormFieldsProps {
  mode: AgentFormMode;
  initialWorkspace: Workspace | null;
  draft: AgentFormDraft;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  selectedWorkspace: Workspace | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setWorkspaceId: (value: string) => void;
  setModelKey: (value: string) => void;
  setBaseBranch: (value: string) => void;
  setUseWorktree: (value: boolean) => void;
  setStartAtLocal: (value: string) => void;
  setIntervalValue: (value: number) => void;
  setIntervalUnit: (value: AgentFormIntervalUnit) => void;
}

export function AgentFormFields({
  mode,
  initialWorkspace,
  draft,
  workspaces,
  workspacesLoading,
  workspaceError,
  selectedWorkspace,
  models,
  modelsLoading,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  setName,
  setPrompt,
  setWorkspaceId,
  setModelKey,
  setBaseBranch,
  setUseWorktree,
  setStartAtLocal,
  setIntervalValue,
  setIntervalUnit,
}: AgentFormFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="agent-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Name
        </label>
        <input
          id="agent-name"
          value={draft.name}
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
          value={draft.workspaceId}
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
          value={draft.modelKey}
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
        selectedBranch={draft.baseBranch}
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
            value={draft.startAtLocal}
            onChange={(event) => setStartAtLocal(event.target.value)}
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
            value={draft.intervalValue}
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
            value={draft.intervalUnit}
            onChange={(event) => setIntervalUnit(event.target.value as AgentFormIntervalUnit)}
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
          checked={draft.useWorktree}
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
          value={draft.prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className={`${inputClassName} min-h-32 resize-y`}
        />
      </div>
    </>
  );
}
