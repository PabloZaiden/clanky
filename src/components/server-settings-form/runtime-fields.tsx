/**
 * Workspace adapter, host and SSH field presentation.
 */

import {
  executionHostRefsEqual, serializeExecutionHostRef,
  type AgentProvider, type HarnessAdapter, type ExecutionHostRef, type ExecutionHostDescriptor,
} from "@/shared";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";

interface RuntimeFieldsProps {
  adapter: HarnessAdapter;
  supportedAdapters: readonly HarnessAdapter[];
  adapterAvailabilityError?: ExecutionHostDescriptor["harnessAdapterError"];
  provider: AgentProvider;
  executionHost: ExecutionHostRef | null;
  sshTarget: WorkspaceSshTargetRequest | null;
  loading: boolean;
  selectableTargets: ExecutionHostDescriptor[];
  unavailableInitialTarget?: ExecutionHostDescriptor;
  initialExecutionHost: ExecutionHostRef | null;
  initialDedicatedWorker: boolean;
  dedicatedWorkerSelected: boolean;
  dedicatedWorkerActive: boolean;
  allowWorkspaceSshTarget: boolean;
  passwordConfigured: boolean;
  clearStoredPassword: boolean;
  updateAdapter: (adapter: HarnessAdapter) => void;
  updateProvider: (provider: AgentProvider) => void;
  updateExecutionHost: (host: string) => void;
  updateSshTarget: (field: "host" | "port" | "username" | "password", value: string | number | null | undefined) => void;
  updateClearStoredPassword: (clear: boolean) => void;
}

export function RuntimeFields({ adapter, supportedAdapters, adapterAvailabilityError, provider, executionHost, sshTarget, loading, selectableTargets, unavailableInitialTarget, initialExecutionHost, initialDedicatedWorker, dedicatedWorkerSelected, dedicatedWorkerActive, allowWorkspaceSshTarget, clearStoredPassword, updateAdapter, updateProvider, updateExecutionHost, updateSshTarget, updateClearStoredPassword, passwordConfigured }: RuntimeFieldsProps) {
  return (
    <div className="space-y-4 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Runtime
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="harness-adapter" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Adapter
            </label>
            <select
              id="harness-adapter"
              value={adapter}
              onChange={(event) => updateAdapter(event.target.value as HarnessAdapter)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            >
              <option value="acp" disabled={!supportedAdapters.includes("acp")}>ACP</option>
              <option value="copilot" disabled={!supportedAdapters.includes("copilot")}>GitHub Copilot</option>
              <option value="codex" disabled={!supportedAdapters.includes("codex")}>Codex</option>
              <option value="opencode2" disabled={!supportedAdapters.includes("opencode2")}>OpenCode 2</option>
            </select>
          </div>
          {adapter === "acp" && <div>
            <label
              htmlFor="agent-provider"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Harness preset
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
          </div>}
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
                  : dedicatedWorkerActive
                    ? "workspace-worker"
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
              {dedicatedWorkerSelected && !initialDedicatedWorker && (
                <option value="workspace-worker">Dedicated worker</option>
              )}
              {initialDedicatedWorker && initialExecutionHost && (
                <option
                  value={serializeExecutionHostRef(initialExecutionHost)}
                >
                  Dedicated worker
                </option>
              )}
              {unavailableInitialTarget && (
                <option
                  value={serializeExecutionHostRef(
                    unavailableInitialTarget.ref,
                  )}
                  disabled
                >
                  {unavailableInitialTarget.name} ({unavailableInitialTarget.ref.kind}) - unavailable
                </option>
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
            {unavailableInitialTarget
              && executionHost
              && executionHostRefsEqual(
                unavailableInitialTarget.ref,
                executionHost,
              ) ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  This execution host no longer supports workspace file and
                  agent operations. Select another host.
                </p>
              ) : null}
          </div>
          {!loading && (adapterAvailabilityError || (adapter !== "acp" && !supportedAdapters.includes(adapter))) && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {adapterAvailabilityError
                ? "Harness availability could not be verified for this execution host."
                : "This adapter is unavailable on the selected execution host."}
            </p>
          )}
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
                placeholder={passwordConfigured
                  ? "Leave blank to keep the current password"
                  : "Leave blank for key-based authentication"}
                disabled={clearStoredPassword}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
              />
              {passwordConfigured && (
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
  );
}
