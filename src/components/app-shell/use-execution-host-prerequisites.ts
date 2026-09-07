import { useCallback, useEffect, useState } from "react";
import type { ExecutionHostRef, SshServerPrerequisiteReport } from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import { checkExecutionHostPrerequisitesApi } from "../../hooks/executionHostActions";

interface UseExecutionHostPrerequisitesOptions {
  executionHost: ExecutionHostRef;
  password?: string;
}

export function useExecutionHostPrerequisites({
  executionHost,
  password,
}: UseExecutionHostPrerequisitesOptions) {
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<SshServerPrerequisiteReport | null>(null);
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
        password,
      }));
    } catch (checkError) {
      setReport(null);
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    } finally {
      setChecking(false);
    }
  }, [executionHost, password]);

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
