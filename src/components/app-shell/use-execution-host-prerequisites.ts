import { useCallback, useEffect, useState } from "react";
import type { ExecutionHostRef, ExecutionHostPrerequisiteReport } from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import { checkExecutionHostPrerequisitesApi } from "../../hooks/executionHostActions";

interface UseExecutionHostPrerequisitesOptions {
  executionHost: ExecutionHostRef;
}

export function useExecutionHostPrerequisites({
  executionHost,
}: UseExecutionHostPrerequisitesOptions) {
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<ExecutionHostPrerequisiteReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setReport(null);
    setError(null);
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setReport(await checkExecutionHostPrerequisitesApi({
        executionHost,
      }));
    } catch (checkError) {
      setReport(null);
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    } finally {
      setChecking(false);
    }
  }, [executionHost]);

  useEffect(() => {
    reset();
  }, [executionHost.kind, getExecutionHostSourceId(executionHost), reset]);

  return {
    checking,
    report,
    error,
    check,
    reset,
  };
}
