/**
 * Sub-hook for workspace git branch fetching (current and default branch).
 */

import { useState, useCallback, useRef } from "react";
import { createLogger } from "../../lib/logger";
import type { BranchInfo } from "@/contracts";
import { appFetch } from "../../lib/public-path";

export interface UseWorkspaceBranchesResult {
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  fetchBranches: (workspaceId: string | null) => Promise<void>;
  fetchDefaultBranch: (workspaceId: string | null) => Promise<void>;
  resetBranches: () => void;
}

export function useWorkspaceBranches(): UseWorkspaceBranchesResult {
  const log = createLogger("useWorkspaceBranches");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  const branchesRequestIdRef = useRef(0);
  const defaultBranchRequestIdRef = useRef(0);

  const fetchBranches = useCallback(async (workspaceId: string | null) => {
    const requestId = ++branchesRequestIdRef.current;
    if (!workspaceId) {
      setBranches([]);
      setCurrentBranch("");
      setBranchesLoading(false);
      return;
    }

    setBranchesLoading(true);
    try {
      const response = await appFetch(
        `/api/git/branches?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      if (requestId !== branchesRequestIdRef.current) {
        return;
      }
      if (response.ok) {
        const data = await response.json();
        if (requestId !== branchesRequestIdRef.current) {
          return;
        }
        setBranches(data.branches ?? []);
        setCurrentBranch(data.currentBranch ?? "");
      } else {
        setBranches([]);
        setCurrentBranch("");
      }
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
        setBranchesLoading(false);
      }
    }
  }, []);

  const fetchDefaultBranch = useCallback(async (workspaceId: string | null) => {
    const requestId = ++defaultBranchRequestIdRef.current;
    if (!workspaceId) {
      setDefaultBranch("");
      return;
    }

    try {
      const response = await appFetch(
        `/api/git/default-branch?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      if (requestId !== defaultBranchRequestIdRef.current) {
        return;
      }
      if (response.ok) {
        const data = await response.json();
        if (requestId !== defaultBranchRequestIdRef.current) {
          return;
        }
        setDefaultBranch(data.defaultBranch ?? "");
      } else {
        setDefaultBranch("");
      }
    } catch (error) {
      log.warn("Failed to fetch workspace default branch", {
        workspaceId,
        error: String(error),
      });
      if (requestId === defaultBranchRequestIdRef.current) {
        setDefaultBranch("");
      }
    }
  }, []);

  const resetBranches = useCallback(() => {
    setBranches([]);
    setCurrentBranch("");
    setDefaultBranch("");
  }, []);

  return {
    branches,
    branchesLoading,
    currentBranch,
    defaultBranch,
    fetchBranches,
    fetchDefaultBranch,
    resetBranches,
  };
}
