/**
 * Shared workspace runtime form.
 */

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SERVER_AGENT_PROVIDER,
  parseExecutionHostRef,
  serializeExecutionHostRef,
  type AgentProvider,
  type ExecutionHostRef,
  type ServerSettings,
} from "@/shared";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { useWorkspaceExecutionTargets } from "../../hooks/workspace-server-settings";
import { TestConnection } from "./test-connection";

export interface ServerSettingsFormProps {
  initialSettings?: ServerSettings;
  initialExecutionHost?: ExecutionHostRef | null;
  onChange: (
    settings: ServerSettings,
    isValid: boolean,
    executionHost: ExecutionHostRef | null,
  ) => void;
  onTest?: (
    settings: ServerSettings,
    executionHost: ExecutionHostRef,
  ) => Promise<{ success: boolean; error?: string }>;
  testing?: boolean;
  remoteOnly?: boolean;
}

export function ServerSettingsForm({
  initialSettings,
  initialExecutionHost = null,
  onChange,
  onTest,
  testing = false,
  remoteOnly = false,
}: ServerSettingsFormProps) {
  const { targets, loading } = useWorkspaceExecutionTargets();
  const selectableTargets = useMemo(
    () => targets.filter((target) =>
      target.acceptRemoteExecution
      && (!remoteOnly || target.ref.kind !== "local")
    ),
    [remoteOnly, targets],
  );
  const [provider, setProvider] = useState<AgentProvider>(
    initialSettings?.agent.provider ?? DEFAULT_SERVER_AGENT_PROVIDER,
  );
  const [executionHost, setExecutionHost] = useState<ExecutionHostRef | null>(
    initialExecutionHost,
  );
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);

  useEffect(() => {
    const nextProvider =
      initialSettings?.agent.provider ?? DEFAULT_SERVER_AGENT_PROVIDER;
    setProvider(nextProvider);
    setExecutionHost(initialExecutionHost);
    setTestResult(null);
    onChange(
      { agent: { provider: nextProvider } },
      initialExecutionHost !== null,
      initialExecutionHost,
    );
  }, [initialExecutionHost, initialSettings, onChange]);

  useEffect(() => {
    if (loading || executionHost || selectableTargets.length === 0) {
      return;
    }
    const nextHost = selectableTargets[0]!.ref;
    setExecutionHost(nextHost);
    onChange({ agent: { provider } }, true, nextHost);
  }, [executionHost, loading, onChange, provider, selectableTargets]);

  function updateProvider(nextProvider: AgentProvider): void {
    setProvider(nextProvider);
    setTestResult(null);
    onChange(
      { agent: { provider: nextProvider } },
      executionHost !== null,
      executionHost,
    );
  }

  function updateExecutionHost(serialized: string): void {
    const nextHost = serialized ? parseExecutionHostRef(serialized) : null;
    setExecutionHost(nextHost);
    setTestResult(null);
    onChange({ agent: { provider } }, nextHost !== null, nextHost);
  }

  async function handleTest(): Promise<void> {
    if (!onTest || !executionHost) {
      return;
    }
    setTestResult(null);
    setTestResult(await onTest({ agent: { provider } }, executionHost));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Runtime
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="agent-provider"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Provider
            </label>
            <select
              id="agent-provider"
              value={provider}
              onChange={(event) => updateProvider(event.target.value as AgentProvider)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            >
              {AGENT_PROVIDER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="execution-host"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Execution host
            </label>
            <select
              id="execution-host"
              value={executionHost ? serializeExecutionHostRef(executionHost) : ""}
              disabled={loading}
              onChange={(event) => updateExecutionHost(event.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:disabled:bg-neutral-900"
            >
              <option value="" disabled>
                {loading ? "Loading execution hosts..." : "Select an execution host"}
              </option>
              {selectableTargets.map((target) => (
                <option
                  key={serializeExecutionHostRef(target.ref)}
                  value={serializeExecutionHostRef(target.ref)}
                >
                  {target.name} ({target.ref.kind})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {onTest && (
        <TestConnection
          onTest={handleTest}
          testing={testing}
          disabled={!executionHost}
          testResult={testResult}
        />
      )}
    </div>
  );
}
