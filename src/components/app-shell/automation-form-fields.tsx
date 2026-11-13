import type { ModelInfo, BranchInfo } from "@/contracts";
import type { Workspace } from "@/shared";
import { getWorkspaceDisplayName } from "../../lib/workspace-label";
import { ModelSelector } from "../ModelSelector";
import { BranchSelector } from "../common/branch-selector";
import type {
  AutomationFormDraft,
  AutomationFormIntervalUnit,
  AutomationFormMode,
} from "./use-automation-form-state";

const inputClassName = "mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60";
const compactInputClassName = "mt-1 block rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60";

export interface AutomationFormFieldsProps {
  mode: AutomationFormMode;
  initialWorkspace: Workspace | null;
  draft: AutomationFormDraft;
  schedulerTimezone: string | null;
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
  worktreeControlDisabled: boolean;
  setStartAtLocal: (value: string) => void;
  setIntervalValue: (value: number) => void;
  setIntervalUnit: (value: AutomationFormIntervalUnit) => void;
}

export function AutomationFormFields({
  mode,
  initialWorkspace,
  draft,
  schedulerTimezone,
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
  worktreeControlDisabled,
  setStartAtLocal,
  setIntervalValue,
  setIntervalUnit,
}: AutomationFormFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="automation-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Name
        </label>
        <input
          id="automation-name"
          value={draft.name}
          onChange={(event) => setName(event.target.value)}
          className={inputClassName}
        />
      </div>

      <div>
        <label htmlFor="automation-workspace" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Workspace
        </label>
        <select
          id="automation-workspace"
          value={draft.workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          disabled={mode === "edit" || Boolean(initialWorkspace) || workspacesLoading}
          className={inputClassName}
        >
          <option value="">
            {workspacesLoading ? "Loading workspaces..." : "Select a workspace"}
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id} disabled={workspace.access === "read"}>
              {getWorkspaceDisplayName(workspace)}
            </option>
          ))}
        </select>
        {workspaceError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{workspaceError}</p>
        )}
      </div>

      <div>
        <label htmlFor="automation-model" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Model
        </label>
        <ModelSelector
          id="automation-model"
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

      {selectedWorkspace?.workspaceType === "git" ? (
        <BranchSelector
          selectedBranch={draft.baseBranch}
          onBranchChange={setBaseBranch}
          branches={branches}
          branchesLoading={branchesLoading}
          defaultBranch={defaultBranch}
          currentBranch={currentBranch}
          helpText={null}
        />
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          This automation runs directly at the selected path without branches or worktrees.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="automation-start-at" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Start at{schedulerTimezone ? ` (${schedulerTimezone})` : ""}
          </label>
          <input
            id="automation-start-at"
            className={`${compactInputClassName} w-56`}
            type="datetime-local"
            disabled={!schedulerTimezone}
            value={draft.startAtLocal}
            onChange={(event) => setStartAtLocal(event.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="automation-interval-value" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Every
          </label>
          <input
            id="automation-interval-value"
            className={`${compactInputClassName} w-24`}
            type="number"
            min={1}
            value={draft.intervalValue}
            onChange={(event) => setIntervalValue(Number(event.target.value))}
            required
          />
        </div>
        <div>
          <label htmlFor="automation-interval-unit" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Unit
          </label>
          <select
            id="automation-interval-unit"
            className={`${compactInputClassName} w-36`}
            value={draft.intervalUnit}
            onChange={(event) => setIntervalUnit(event.target.value as AutomationFormIntervalUnit)}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      </div>

      {selectedWorkspace?.workspaceType === "git" && (
        <label className={`flex items-center gap-3 text-sm font-medium text-gray-700 dark:text-gray-300 ${worktreeControlDisabled ? "opacity-60" : ""}`}>
          <input
            type="checkbox"
            checked={draft.useWorktree}
            onChange={(event) => setUseWorktree(event.target.checked)}
            disabled={worktreeControlDisabled}
            className="h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
          />
          Use worktree
        </label>
      )}

      <div>
        <label htmlFor="automation-prompt" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Prompt
        </label>
        <textarea
          id="automation-prompt"
          value={draft.prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className={`${inputClassName} min-h-32 resize-y`}
        />
      </div>
    </>
  );
}
