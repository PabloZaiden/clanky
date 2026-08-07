import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  DeterministicAgentTestResult,
  TaskLogEntry,
  Workspace,
} from "@/shared";
import type { TestAgentCodeRequest } from "@/contracts/schemas";
import { useToast } from "@pablozaiden/webapp/web";
import { parseModelKey } from "../ModelSelector";
import { useRealtimeStream } from "../../hooks";
import type { UseAgentsResult } from "../../hooks/useAgents";

const MAX_TEST_LOGS = 1000;

export interface UseAgentCodeTestOptions {
  name: string;
  prompt: string;
  code: string;
  selectedWorkspace: Workspace | null;
  modelKey: string;
  baseBranch: string;
  useWorktree: boolean;
  onTestStarted: () => void;
  onTestAgentCode: UseAgentsResult["testAgentCode"];
}

export interface UseAgentCodeTestResult {
  testResult: DeterministicAgentTestResult | null;
  testLogs: TaskLogEntry[];
  isTestingCode: boolean;
  resetOutput: () => void;
  testCode: () => Promise<void>;
  cancelTest: () => void;
}

export function useAgentCodeTest({
  name,
  prompt,
  code,
  selectedWorkspace,
  modelKey,
  baseBranch,
  useWorktree,
  onTestStarted,
  onTestAgentCode,
}: UseAgentCodeTestOptions): UseAgentCodeTestResult {
  const toast = useToast();
  const toastError = toast.error;
  const toastSuccess = toast.success;
  const [testResult, setTestResult] = useState<DeterministicAgentTestResult | null>(null);
  const [testLogs, setTestLogs] = useState<TaskLogEntry[]>([]);
  const [testStreamId, setTestStreamId] = useState<string | null>(null);
  const [isTestingCode, setIsTestingCode] = useState(false);
  const testAbortControllerRef = useRef<AbortController | null>(null);
  const testLogIdsRef = useRef(new Set<string>());

  useEffect(() => () => {
    testAbortControllerRef.current?.abort();
  }, []);

  const appendTestLog = useCallback((entry: TaskLogEntry): void => {
    if (testLogIdsRef.current.has(entry.id)) {
      return;
    }
    testLogIdsRef.current.add(entry.id);
    setTestLogs((previous) => {
      const next = [...previous, entry];
      const evictedEntries = next.slice(0, Math.max(0, next.length - MAX_TEST_LOGS));
      for (const evictedEntry of evictedEntries) {
        testLogIdsRef.current.delete(evictedEntry.id);
      }
      return next.slice(-MAX_TEST_LOGS);
    });
  }, []);

  useRealtimeStream<AgentEvent>({
    enabled: isTestingCode && testStreamId !== null,
    filters: { agentRunId: testStreamId ?? undefined },
    predicate: (event) => event.type === "agent.run.log" && event.agentRunId === testStreamId,
    onEvent: (event) => {
      if (event.type === "agent.run.log") {
        appendTestLog(event.log);
      }
    },
  });

  const resetOutput = useCallback((): void => {
    setTestResult(null);
    setTestLogs([]);
    testLogIdsRef.current.clear();
  }, []);

  const testCode = useCallback(async (): Promise<void> => {
    const parsedTestModel = parseModelKey(modelKey);
    if (!selectedWorkspace || !parsedTestModel) {
      toastError("Select a workspace and model before testing code");
      return;
    }
    if (!code.trim()) {
      toastError("Enter deterministic code before testing it");
      return;
    }
    onTestStarted();
    setIsTestingCode(true);
    setTestResult(null);
    setTestLogs([]);
    testLogIdsRef.current.clear();
    const testRunId = crypto.randomUUID();
    setTestStreamId(testRunId);
    const controller = new AbortController();
    testAbortControllerRef.current = controller;
    try {
      const result = await onTestAgentCode({
        name: name.trim() || undefined,
        prompt,
        code,
        workspaceId: selectedWorkspace.id,
        model: parsedTestModel,
        baseBranch: baseBranch.trim() || undefined,
        useWorktree,
        testRunId,
      } satisfies TestAgentCodeRequest, {
        signal: controller.signal,
        onLog: appendTestLog,
      });
      if (!result || controller.signal.aborted) {
        if (!result && !controller.signal.aborted) {
          setTestResult({
            status: "failed",
            logs: [],
            error: "Deterministic code test ended without a result",
            diagnostics: [],
          });
        }
        return;
      }
      setTestResult(result);
      setTestLogs((previous) => result.logs.length > 0 ? result.logs : previous);
      if (result.status === "completed") {
        toastSuccess("Deterministic code test completed");
      } else if (result.status === "failed") {
        toastError(result.error ?? "Deterministic code test failed");
      }
    } finally {
      if (testAbortControllerRef.current === controller) {
        testAbortControllerRef.current = null;
      }
      setTestStreamId(null);
      setIsTestingCode(false);
    }
  }, [
    appendTestLog,
    baseBranch,
    code,
    modelKey,
    name,
    onTestAgentCode,
    onTestStarted,
    prompt,
    selectedWorkspace,
    toastError,
    toastSuccess,
    useWorktree,
  ]);

  const cancelTest = useCallback((): void => {
    const controller = testAbortControllerRef.current;
    if (!controller || controller.signal.aborted) {
      return;
    }
    setTestResult({
      status: "cancelled",
      logs: testLogs,
      diagnostics: [],
    });
    setTestStreamId(null);
    controller.abort();
  }, [testLogs]);

  return {
    testResult,
    testLogs,
    isTestingCode,
    resetOutput,
    testCode,
    cancelTest,
  };
}
