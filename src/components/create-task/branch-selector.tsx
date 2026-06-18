import type { BranchInfo } from "../../types";

interface BranchSelectorProps {
  selectedBranch: string;
  onBranchChange: (branch: string) => void;
  branches: BranchInfo[];
  branchesLoading: boolean;
  defaultBranch: string;
  currentBranch: string;
  disabled?: boolean;
  helpText?: string | null;
}

export function BranchSelector({
  selectedBranch,
  onBranchChange,
  branches,
  branchesLoading,
  defaultBranch,
  currentBranch,
  disabled = false,
  helpText = "Branch to base the task on (default: repository's default branch)",
}: BranchSelectorProps) {
  return (
    <div>
      <label
        htmlFor="branch"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        Base Branch
      </label>
      <select
        id="branch"
        value={selectedBranch}
        onChange={(e) => onBranchChange(e.target.value)}
        disabled={disabled || branchesLoading || branches.length === 0}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-50 font-mono text-sm"
      >
        {branchesLoading && (
          <option value="">Loading branches...</option>
        )}
        {!branchesLoading && branches.length === 0 && (
          <option value="">Select a workspace to load branches</option>
        )}
        {!branchesLoading && branches.length > 0 && (
          <>
            {/* Default branch first (with label) */}
            {defaultBranch && (
              <option value={defaultBranch}>
                {defaultBranch} (default){defaultBranch === currentBranch ? " (current)" : ""}
              </option>
            )}
            {/* Current branch if different from default */}
            {currentBranch && currentBranch !== defaultBranch && (
              <option value={currentBranch}>
                {currentBranch} (current)
              </option>
            )}
            {/* Separator if we have special branches */}
            {(defaultBranch || currentBranch) && branches.length > 1 && (
              <option disabled>──────────</option>
            )}
            {/* Other branches sorted by name (excluding default and current) */}
            {branches
              .filter((b) => b.name !== defaultBranch && b.name !== currentBranch)
              .map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
          </>
        )}
      </select>
      {helpText && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {helpText}
        </p>
      )}
    </div>
  );
}
