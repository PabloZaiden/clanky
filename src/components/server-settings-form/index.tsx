/**
 * Shared workspace runtime form.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SERVER_AGENT_PROVIDER,
  parseExecutionHostRef,
  serializeExecutionHostRef,
  type AgentProvider,
  type ExecutionHostRef,
  type ServerSettings,
} from "@/shared";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { useWorkspaceExecutionTargets } from "../../hooks/workspace-server-settings";
import { TestConnection } from "./test-connection";

export interface ServerSettingsFormProps {
  initialSettings?: ServerSettings;
  initialExecutionHost?: ExecutionHostRef | null;
  initialSshTarget?: Pick<WorkspaceSshTargetRequest, "host" | "port" | "username"> & {
    credentialConfigured?: boolean;
  } | null;
  onChange: (
    settings: ServerSettings,
    isValid: boolean,
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
  ) => void;
  onTest?: (
    settings: ServerSettings,
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
  ) => Promise<{ success: boolean; error?: string }>;
  testing?: boolean;
  remoteOnly?: boolean;
  allowWorkspaceSshTarget?: boolean;
}

export function ServerSettingsForm({
  initialSettings,
  initialExecutionHost = null,
  initialSshTarget = null,
  onChange,
  onTest,
  testing = false,
  remoteOnly = false,
  allowWorkspaceSshTarget = false,
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
  const [sshTarget, setSshTarget] = useState<WorkspaceSshTargetRequest | null>(
    initialSshTarget
      ? {
        host: initialSshTarget.host,
        port: initialSshTarget.port,
        username: initialSshTarget.username,
      }
      : null,
  );
  const [clearStoredPassword, setClearStoredPassword] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);

  useEffect(() => {
    const nextProvider =
      initialSettings?.agent.provider ?? DEFAULT_SERVER_AGENT_PROVIDER;
    setProvider(nextProvider);
    setExecutionHost(initialExecutionHost);
    setSshTarget(
      initialSshTarget
        ? {
          host: initialSshTarget.host,
          port: initialSshTarget.port,
          username: initialSshTarget.username,
        }
        : null,
    );
    setClearStoredPassword(false);
    setTestResult(null);
    onChangeRef.current(
      { agent: { provider: nextProvider } },
      initialExecutionHost !== null || initialSshTarget !== null,
      initialExecutionHost,
      initialSshTarget
        ? {
          host: initialSshTarget.host,
          port: initialSshTarget.port,
          username: initialSshTarget.username,
        }
        : null,
    );
  }, [initialExecutionHost, initialSshTarget, initialSettings]);

  useEffect(() => {
    if (loading || executionHost || sshTarget || selectableTargets.length === 0) {
      return;
    }
    const nextHost = selectableTargets[0]!.ref;
    setExecutionHost(nextHost);
    onChangeRef.current({ agent: { provider } }, true, nextHost);
  }, [executionHost, loading, provider, selectableTargets, sshTarget]);

  function updateProvider(nextProvider: AgentProvider): void {
    setProvider(nextProvider);
    setTestResult(null);
    onChangeRef.current(
      { agent: { provider: nextProvider } },
      executionHost !== null,
      executionHost,
    );
  }

  function updateExecutionHost(serialized: string): void {
    if (serialized === "workspace-ssh-target") {
      const nextTarget = sshTarget ?? {
        host: "",
        port: 22,
        username: "",
      };
      setExecutionHost(null);
      setSshTarget(nextTarget);
      setClearStoredPassword(false);
      setTestResult(null);
      onChangeRef.current(
        { agent: { provider } },
        isSshTargetValid(nextTarget),
        null,
        nextTarget,
      );
      return;
    }
    const nextHost = serialized ? parseExecutionHostRef(serialized) : null;
    setExecutionHost(nextHost);
    setSshTarget(null);
    setClearStoredPassword(false);
    setTestResult(null);
    onChangeRef.current({ agent: { provider } }, nextHost !== null, nextHost);
  }

  function updateSshTarget(
    field: "host" | "port" | "username" | "password",
    value: string | number | null | undefined,
  ): void {
    const nextTarget: WorkspaceSshTargetRequest = {
      ...(sshTarget ?? { host: "", port: 22, username: "" }),
      [field]: value,
    };
    if (field === "password" && value !== null && value !== "") {
      setClearStoredPassword(false);
    }
    setSshTarget(nextTarget);
    setTestResult(null);
    onChangeRef.current(
      { agent: { provider } },
      isSshTargetValid(nextTarget),
      null,
      nextTarget,
    );
  }

  function updateClearStoredPassword(clear: boolean): void {
    setClearStoredPassword(clear);
    const nextTarget: WorkspaceSshTargetRequest = {
      ...(sshTarget ?? { host: "", port: 22, username: "" }),
      password: clear ? null : undefined,
    };
    setSshTarget(nextTarget);
    setTestResult(null);
    onChangeRef.current(
      { agent: { provider } },
      isSshTargetValid(nextTarget),
      null,
      nextTarget,
    );
  }

  async function handleTest(): Promise<void> {
    if (!onTest || (!executionHost && !isSshTargetValid(sshTarget))) {
      return;
    }
    setTestResult(null);
    setTestResult(await onTest({ agent: { provider } }, executionHost, sshTarget));
  }

  const sshTargetValid = isSshTargetValid(sshTarget);

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
              value={sshTarget
                ? "workspace-ssh-target"
                : executionHost
                  ? serializeExecutionHostRef(executionHost)
                  : ""}
              disabled={loading}
              onChange={(event) => updateExecutionHost(event.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:disabled:bg-neutral-900"
            >
              <option value="" disabled>
                {loading ? "Loading execution hosts..." : "Select an execution host"}
              </option>
              {allowWorkspaceSshTarget && (
                <option value="workspace-ssh-target">Direct SSH target</option>
              )}
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
        {allowWorkspaceSshTarget && sshTarget && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label
                htmlFor="workspace-ssh-target-host"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                SSH host
              </label>
              <input
                id="workspace-ssh-target-host"
                value={sshTarget.host}
                onChange={(event) => updateSshTarget("host", event.target.value)}
                placeholder="devcontainer.example.com"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
                required
              />
            </div>
            <div>
              <label
                htmlFor="workspace-ssh-target-port"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                SSH port
              </label>
              <input
                id="workspace-ssh-target-port"
                type="number"
                min={1}
                max={65535}
                value={sshTarget.port}
                onChange={(event) => updateSshTarget("port", Number(event.target.value))}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
                required
              />
            </div>
            <div>
              <label
                htmlFor="workspace-ssh-target-username"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                SSH username
              </label>
              <input
                id="workspace-ssh-target-username"
                value={sshTarget.username}
                onChange={(event) => updateSshTarget("username", event.target.value)}
                placeholder="devbox"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
                required
              />
            </div>
            <div className="sm:col-span-2">
              <label
                htmlFor="workspace-ssh-target-password"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                SSH password
              </label>
              <input
                id="workspace-ssh-target-password"
                type="password"
                value={typeof sshTarget.password === "string" ? sshTarget.password : ""}
                onChange={(event) => updateSshTarget("password", event.target.value || undefined)}
                placeholder={initialSshTarget?.credentialConfigured
                  ? "Leave blank to keep the current password"
                  : "Leave blank for key-based authentication"}
                disabled={clearStoredPassword}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
              />
              {initialSshTarget?.credentialConfigured && (
                <label className="mt-2 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={clearStoredPassword}
                    onChange={(event) => updateClearStoredPassword(event.target.checked)}
                  />
                  Remove the stored SSH password
                </label>
              )}
            </div>
          </div>
        )}
      </div>

      {onTest && (
        <TestConnection
          onTest={handleTest}
          testing={testing}
          disabled={!executionHost && !sshTargetValid}
          testResult={testResult}
        />
      )}
    </div>
  );
}

function isSshTargetValid(
  target: WorkspaceSshTargetRequest | null,
): boolean {
  return target !== null
    && target.host.trim().length > 0
    && target.username.trim().length > 0
    && Number.isInteger(target.port)
    && target.port >= 1
    && target.port <= 65535;
}
