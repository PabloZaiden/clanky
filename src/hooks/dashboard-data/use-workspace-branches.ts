/**
 * Sub-hook for workspace git branch fetching (current and default branch).
 */

import { useState, useCallback, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { BranchInfo } from "@/contracts";
import { apiRequest } from "../../lib/api-client";

export interface UseWorkspaceBranchesResult {
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  fetchBranches: (workspaceId: string | null) => Promise<void>;
  fetchDefaultBranch: (workspaceId: string | null) => Promise<void>;
  resetBranches: () => void;
}

export function useWorkspaceBranches(): UseWorkspaceBranchesResult {
  const log = createLogger("useWorkspaceBranches");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchListLoading, setBranchListLoading] = useState(false);
  const [defaultBranchLoading, setDefaultBranchLoading] = useState(false);
  const [branchesWorkspaceId, setBranchesWorkspaceId] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  const branchesRequestIdRef = useRef(0);
  const defaultBranchRequestIdRef = useRef(0);

  const resetBranchData = useCallback((workspaceId: string | null): void => {
    setBranchesWorkspaceId(workspaceId);
    setBranches([]);
    setCurrentBranch("");
    setDefaultBranch("");
  }, []);

  const fetchBranches = useCallback(async (workspaceId: string | null) => {
    const requestId = ++branchesRequestIdRef.current;
    resetBranchData(workspaceId);
    setBranchListLoading(Boolean(workspaceId));
    if (!workspaceId) {
      return;
    }

    try {
      const data = await apiRequest<{ branches?: BranchInfo[]; currentBranch?: string }>(
        `/api/git/branches?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          action: "Load workspace branches",
          fallbackMessage: "Failed to fetch workspace branches",
        },
      );
      if (requestId !== branchesRequestIdRef.current) {
        return;
      }
      setBranches(data.branches ?? []);
      setCurrentBranch(data.currentBranch ?? "");
    } catch (error) {
      log.error("Failed to fetch workspace branches", {
        workspaceId,
        error: String(error),
      });
      if (requestId === branchesRequestIdRef.current) {
        setBranches([]);
        setCurrentBranch("");
      }
    } finally {
      if (requestId === branchesRequestIdRef.current) {
        setBranchListLoading(false);
      }
    }
  }, [resetBranchData]);

  const fetchDefaultBranch = useCallback(async (workspaceId: string | null) => {
    const requestId = ++defaultBranchRequestIdRef.current;
    resetBranchData(workspaceId);
    setDefaultBranchLoading(Boolean(workspaceId));
    if (!workspaceId) {
      return;
    }

    try {
      const data = await apiRequest<{ defaultBranch?: string }>(
        `/api/git/default-branch?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          action: "Load workspace default branch",
          fallbackMessage: "Failed to fetch workspace default branch",
        },
      );
      if (requestId !== defaultBranchRequestIdRef.current) {
        return;
      }
      setDefaultBranch(data.defaultBranch ?? "");
    } catch (error) {
      log.warn("Failed to fetch workspace default branch", {
        workspaceId,
        error: String(error),
      });
      if (requestId === defaultBranchRequestIdRef.current) {
        setDefaultBranch("");
      }
    } finally {
      if (requestId === defaultBranchRequestIdRef.current) {
        setDefaultBranchLoading(false);
      }
    }
  }, [resetBranchData]);

  const resetBranches = useCallback(() => {
    branchesRequestIdRef.current += 1;
    defaultBranchRequestIdRef.current += 1;
    resetBranchData(null);
    setBranchListLoading(false);
    setDefaultBranchLoading(false);
  }, [resetBranchData]);

  return {
    branches,
    branchesLoading: branchListLoading || defaultBranchLoading,
    branchesWorkspaceId,
    currentBranch,
    defaultBranch,
    fetchBranches,
    fetchDefaultBranch,
    resetBranches,
  };
}
