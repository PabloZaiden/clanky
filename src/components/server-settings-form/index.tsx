/**
 * ServerSettingsForm component for configuring workspace connection settings.
 * This component is shared between CreateWorkspaceModal and WorkspaceSettingsModal.
 */

import { useEffect, useState } from "react";
import { findRegisteredSshServer } from "@/shared/settings";
import type { ServerSettings, AgentProvider, AgentTransport } from "@/shared/settings";
import type { SshServer } from "@/shared";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { SshFields } from "./ssh-fields";
import { TestConnection } from "./test-connection";

const OTHER_SSH_SERVER_OPTION = "__other__";

function resolveRegisteredSshServerId(hostname: string, registeredSshServers: readonly SshServer[]): string {
  return findRegisteredSshServer(hostname, registeredSshServers)?.config.id ?? OTHER_SSH_SERVER_OPTION;
}

export interface ServerSettingsFormProps {
  /** Initial server settings (for editing) */
  initialSettings?: ServerSettings;
  /** Callback when settings change */
  onChange: (settings: ServerSettings, isValid: boolean) => void;
  /** Callback to test connection - if not provided, test button is hidden */
  onTest?: (settings: ServerSettings) => Promise<{ success: boolean; error?: string }>;
  /** Whether testing is in progress */
  testing?: boolean;
  /** Whether remote-only mode is enabled (CLANKY_REMOTE_ONLY) */
  remoteOnly?: boolean;
  /** Optional list of registered SSH servers for hostname selection */
  registeredSshServers?: readonly SshServer[];
}

/**
 * ServerSettingsForm provides UI for configuring connection settings.
 */
export function ServerSettingsForm({
  initialSettings,
  onChange,
  onTest,
  testing = false,
  remoteOnly = false,
  registeredSshServers = [],
}: ServerSettingsFormProps) {
  const [agentProvider, setAgentProvider] = useState<AgentProvider>(
    initialSettings?.agent.provider ?? "opencode",
  );
  const [agentTransport, setAgentTransport] = useState<AgentTransport>(
    remoteOnly ? "ssh" : (initialSettings?.agent.transport ?? "stdio"),
  );
  const [agentHostname, setAgentHostname] = useState(
    initialSettings?.agent.transport === "ssh" ? initialSettings.agent.hostname : "localhost",
  );
  const [selectedRegisteredSshServerId, setSelectedRegisteredSshServerId] = useState(
    initialSettings?.agent.transport === "ssh"
      ? resolveRegisteredSshServerId(initialSettings.agent.hostname, registeredSshServers)
      : OTHER_SSH_SERVER_OPTION,
  );
  const [agentPort, setAgentPort] = useState(
    String(initialSettings?.agent.transport === "ssh" ? (initialSettings.agent.port ?? 22) : 22),
  );
  const [agentUsername, setAgentUsername] = useState(
    initialSettings?.agent.transport === "ssh" ? (initialSettings.agent.username ?? "") : "",
  );
  const [agentPassword, setAgentPassword] = useState(
    initialSettings?.agent.transport === "ssh" ? (initialSettings.agent.password ?? "") : "",
  );

  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const nextProvider = initialSettings?.agent.provider ?? "opencode";
    const nextTransport = remoteOnly ? "ssh" : (initialSettings?.agent.transport ?? "stdio");
    const nextHost = initialSettings?.agent.transport === "ssh" ? initialSettings.agent.hostname : "localhost";
    const nextSelectedRegisteredSshServerId = nextTransport === "ssh"
      ? resolveRegisteredSshServerId(nextHost, registeredSshServers)
      : OTHER_SSH_SERVER_OPTION;
    const nextPort = String(initialSettings?.agent.transport === "ssh" ? (initialSettings.agent.port ?? 22) : 22);
    const nextUsername = initialSettings?.agent.transport === "ssh" ? (initialSettings.agent.username ?? "") : "";
    const nextPassword = initialSettings?.agent.transport === "ssh" ? (initialSettings.agent.password ?? "") : "";

    setAgentProvider(nextProvider);
    setAgentTransport(nextTransport);
    setAgentHostname(nextHost);
    setSelectedRegisteredSshServerId(nextSelectedRegisteredSshServerId);
    setAgentPort(nextPort);
    setAgentUsername(nextUsername);
    setAgentPassword(nextPassword);
    setTestResult(null);
    setShowPassword(false);

    const settings = buildSettings({
      provider: nextProvider,
      transport: nextTransport,
      manualHostname: nextHost,
      selectedRegisteredSshServerId: nextSelectedRegisteredSshServerId,
      port: nextPort,
      username: nextUsername,
      password: nextPassword,
    });
    onChange(settings, validateSettings(settings));
  }, [initialSettings, remoteOnly]);

  function buildSettings(overrides?: {
    provider?: AgentProvider;
    transport?: AgentTransport;
    manualHostname?: string;
    selectedRegisteredSshServerId?: string;
    port?: string;
    username?: string;
    password?: string;
  }): ServerSettings {
    const provider = overrides?.provider ?? agentProvider;
    const transport = overrides?.transport ?? agentTransport;
    const manualHostname = overrides?.manualHostname ?? agentHostname;
    const nextSelectedRegisteredSshServerId = overrides?.selectedRegisteredSshServerId ?? selectedRegisteredSshServerId;
    const selectedRegisteredSshServer = registeredSshServers.find(
      (server) => server.config.id === nextSelectedRegisteredSshServerId,
    );
    const hostname = nextSelectedRegisteredSshServerId !== OTHER_SSH_SERVER_OPTION && selectedRegisteredSshServer
      ? selectedRegisteredSshServer.config.address
      : manualHostname;
    const port = overrides?.port ?? agentPort;
    const username = overrides?.username ?? agentUsername;
    const password = overrides?.password ?? agentPassword;

    if (transport === "ssh") {
      return {
        agent: {
          provider,
          transport,
          hostname: hostname.trim(),
          port: parseInt(port, 10) || 22,
          username: username.trim() || undefined,
          password: password.trim() || undefined,
        },
      };
    }

    return {
      agent: {
        provider,
        transport,
      },
    };
  }

  function validateSettings(settings: ServerSettings): boolean {
    if (settings.agent.transport === "ssh") {
      return settings.agent.hostname.trim().length > 0;
    }
    return true;
  }

  function notifyChange(overrides?: {
    provider?: AgentProvider;
    transport?: AgentTransport;
    manualHostname?: string;
    selectedRegisteredSshServerId?: string;
    port?: string;
    username?: string;
    password?: string;
  }) {
    const settings = buildSettings(overrides);
    onChange(settings, validateSettings(settings));
  }

  const showRegisteredSshServerSelect = agentTransport === "ssh" && registeredSshServers.length > 0;
  const showManualHostnameInput = agentTransport === "ssh"
    && (!showRegisteredSshServerSelect || selectedRegisteredSshServerId === OTHER_SSH_SERVER_OPTION);

  async function handleTest() {
    if (!onTest) {
      return;
    }

    setTestResult(null);
    const result = await onTest(buildSettings());
    setTestResult(result);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4 p-4 rounded-lg bg-gray-50 dark:bg-neutral-900">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Connection</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="agent-provider" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Provider
            </label>
            <select
              id="agent-provider"
              value={agentProvider}
              onChange={(e) => {
                const value = e.target.value as AgentProvider;
                setAgentProvider(value);
                setTestResult(null);
                notifyChange({ provider: value });
              }}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            >
              {AGENT_PROVIDER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="agent-transport" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Transport
            </label>
            <select
              id="agent-transport"
              value={agentTransport}
              onChange={(e) => {
                const value = e.target.value as AgentTransport;
                setAgentTransport(value);
                setTestResult(null);
                notifyChange({ transport: value });
              }}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            >
              <option value="stdio" disabled={remoteOnly}>stdio (local process)</option>
              <option value="ssh">ssh</option>
            </select>
          </div>
        </div>

        {agentTransport === "ssh" && (
          <SshFields
            registeredSshServers={registeredSshServers}
            showRegisteredSshServerSelect={showRegisteredSshServerSelect}
            selectedRegisteredSshServerId={selectedRegisteredSshServerId}
            showManualHostnameInput={showManualHostnameInput}
            agentHostname={agentHostname}
            agentPort={agentPort}
            agentUsername={agentUsername}
            agentPassword={agentPassword}
            showPassword={showPassword}
            onRegisteredSshServerChange={(value) => {
              setSelectedRegisteredSshServerId(value);
              setTestResult(null);
              notifyChange({ selectedRegisteredSshServerId: value });
            }}
            onHostnameChange={(value) => {
              setAgentHostname(value);
              setTestResult(null);
              notifyChange({ manualHostname: value });
            }}
            onPortChange={(value) => {
              setAgentPort(value);
              setTestResult(null);
              notifyChange({ port: value });
            }}
            onUsernameChange={(value) => {
              setAgentUsername(value);
              setTestResult(null);
              notifyChange({ username: value });
            }}
            onPasswordChange={(value) => {
              setAgentPassword(value);
              setTestResult(null);
              notifyChange({ password: value });
            }}
            onShowPasswordToggle={() => setShowPassword((prev) => !prev)}
          />
        )}
      </div>

      {onTest && (
        <TestConnection
          onTest={handleTest}
          testing={testing}
          testResult={testResult}
        />
      )}
    </div>
  );
}

export default ServerSettingsForm;
