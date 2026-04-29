/**
 * Hook for AGENTS.md optimization operations.
 * Provides functions to read, preview, and apply Ralpher optimization
 * to a workspace's AGENTS.md file.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OptimizationAnalysis, OptimizationPreview } from "../core/agents-md-optimizer";
import { analyzeAgentsMd } from "../core/agents-md-optimizer";
import { log } from "../lib/logger";
import { appFetch } from "../lib/public-path";

/** Result of reading the current AGENTS.md state */
export interface AgentsMdStatus {
  content: string;
  fileExists: boolean;
  analysis: OptimizationAnalysis;
}

/** Result of applying optimization */
export interface OptimizeResult {
  success: boolean;
  alreadyOptimized: boolean;
  content: string;
  analysis?: OptimizationAnalysis;
}

export interface UseAgentsMdOptimizerResult {
  /** Current AGENTS.md status (null if not yet fetched) */
  status: AgentsMdStatus | null;
  /** Preview of optimization changes (null if not yet fetched) */
  preview: OptimizationPreview | null;
  /** Whether any operation is in progress */
  loading: boolean;
  /** Error message if any operation failed */
  error: string | null;
  /** Fetch the current AGENTS.md status */
  fetchStatus: (workspaceId: string) => Promise<AgentsMdStatus | null>;
  /** Fetch a preview of what optimization would change */
  fetchPreview: (workspaceId: string) => Promise<OptimizationPreview | null>;
  /** Apply optimization to the workspace's AGENTS.md */
  optimize: (workspaceId: string) => Promise<OptimizeResult | null>;
  /** Clear the current state */
  reset: () => void;
}

/**
 * Format error messages from the AGENTS.md optimizer API to be user-friendly.
 * Connection failures from getCommandExecutorAsync() can produce verbose error
 * messages -- this simplifies them for display.
 */
function formatOptimizerError(rawMessage: string): string {
  const lower = rawMessage.toLowerCase();
  if (lower.includes("econnrefused") || lower.includes("connect error") || lower.includes("connection refused")) {
    return "Could not connect to the server. Check your connection settings and try again.";
  }
  if (lower.includes("not connected") || lower.includes("call connect() first")) {
    return "Server connection not available. The connection will be established on-demand when retried.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Connection timed out. The server may be unreachable or slow to respond.";
  }
  if (lower.includes("workspace not found")) {
    return "Workspace not found. It may have been deleted.";
  }
  // Strip "Error: " prefix if present for cleaner display
  return rawMessage.replace(/^Error:\s*/i, "");
}

/**
 * Hook for managing AGENTS.md optimization for a workspace.
 */
export function useAgentsMdOptimizer(): UseAgentsMdOptimizerResult {
  const [status, setStatus] = useState<AgentsMdStatus | null>(null);
  const [preview, setPreview] = useState<OptimizationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchStatus = useCallback(async (workspaceId: string): Promise<AgentsMdStatus | null> => {
    try {
      if (isMountedRef.current) {
        setLoading(true);
        setError(null);
      }
      const response = await appFetch(`/api/workspaces/${workspaceId}/agents-md`);
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || "Failed to fetch AGENTS.md status");
      }
      const data = (await response.json()) as AgentsMdStatus;
      if (isMountedRef.current) {
        setStatus(data);
      }
      return data;
    } catch (err) {
      const rawMessage = String(err);
      // Provide user-friendly messages for common connection errors
      const message = formatOptimizerError(rawMessage);
      if (isMountedRef.current) {
        setError(message);
      }
      log.error("Failed to fetch AGENTS.md status:", err);
      return null;
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const fetchPreview = useCallback(async (workspaceId: string): Promise<OptimizationPreview | null> => {
    try {
      if (isMountedRef.current) {
        setLoading(true);
        setError(null);
      }
      const response = await appFetch(`/api/workspaces/${workspaceId}/agents-md/preview`, {
        method: "POST",
      });
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || "Failed to preview optimization");
      }
      const data = (await response.json()) as OptimizationPreview;
      if (isMountedRef.current) {
        setPreview(data);
        // Also update the status from the preview analysis
        setStatus({
          content: data.currentContent,
          fileExists: data.fileExists,
          analysis: data.analysis,
        });
      }
      return data;
    } catch (err) {
      const rawMessage = String(err);
      // Apply the same user-friendly formatting as fetchStatus and optimize
      const message = formatOptimizerError(rawMessage);
      if (isMountedRef.current) {
        setError(message);
      }
      log.error("Failed to preview AGENTS.md optimization:", err);
      return null;
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const optimize = useCallback(async (workspaceId: string): Promise<OptimizeResult | null> => {
    try {
      if (isMountedRef.current) {
        setLoading(true);
        setError(null);
      }
      const response = await appFetch(`/api/workspaces/${workspaceId}/agents-md/optimize`, {
        method: "POST",
      });
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || "Failed to optimize AGENTS.md");
      }
      const data = (await response.json()) as OptimizeResult;
      // Update local status after successful optimization
      if (data.success && isMountedRef.current) {
        // Derive analysis from the returned content, or use analysis from server if provided
        const derivedAnalysis = data.analysis ?? analyzeAgentsMd(data.content);
        setStatus({
          content: data.content,
          fileExists: true,
          analysis: derivedAnalysis,
        });
        setPreview(null);
      }
      return data;
    } catch (err) {
      const rawMessage = String(err);
      const message = formatOptimizerError(rawMessage);
      if (isMountedRef.current) {
        setError(message);
      }
      log.error("Failed to optimize AGENTS.md:", err);
      return null;
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }
    setStatus(null);
    setPreview(null);
    setLoading(false);
    setError(null);
  }, []);

  return {
    status,
    preview,
    loading,
    error,
    fetchStatus,
    fetchPreview,
    optimize,
    reset,
  };
}
