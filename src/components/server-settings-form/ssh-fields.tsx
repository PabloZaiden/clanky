/** SSH-specific connection fields (server select, hostname, port, credentials). */

import { PASSWORD_INPUT_PROPS } from "../common";
import { EyeIcon, EyeOffIcon } from "./icons";
import type { SshServer } from "@/shared";

const OTHER_SSH_SERVER_OPTION = "__other__";

export interface SshFieldsProps {
  registeredSshServers: readonly SshServer[];
  showRegisteredSshServerSelect: boolean;
  selectedRegisteredSshServerId: string;
  showManualHostnameInput: boolean;
  agentHostname: string;
  agentPort: string;
  agentUsername: string;
  agentPassword: string;
  showPassword: boolean;
  onRegisteredSshServerChange: (value: string) => void;
  onHostnameChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onShowPasswordToggle: () => void;
}

export function SshFields({
  registeredSshServers,
  showRegisteredSshServerSelect,
  selectedRegisteredSshServerId,
  showManualHostnameInput,
  agentHostname,
  agentPort,
  agentUsername,
  agentPassword,
  showPassword,
  onRegisteredSshServerChange,
  onHostnameChange,
  onPortChange,
  onUsernameChange,
  onPasswordChange,
  onShowPasswordToggle,
}: SshFieldsProps) {
  const selectedRegisteredSshServer = registeredSshServers.find(
    (server) => server.config.id === selectedRegisteredSshServerId,
  );

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {showRegisteredSshServerSelect && (
          <div>
            <label
              htmlFor="agent-registered-ssh-server"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Server
            </label>
            <select
              id="agent-registered-ssh-server"
              value={selectedRegisteredSshServerId}
              onChange={(e) => onRegisteredSshServerChange(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            >
              {registeredSshServers.map((server) => (
                <option key={server.config.id} value={server.config.id}>
                  {server.config.name}
                </option>
              ))}
              <option value={OTHER_SSH_SERVER_OPTION}>Other</option>
            </select>
            {selectedRegisteredSshServer && selectedRegisteredSshServerId !== OTHER_SSH_SERVER_OPTION && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Using {selectedRegisteredSshServer.config.address}
              </p>
            )}
          </div>
        )}

        {showManualHostnameInput && (
          <div>
            <label htmlFor="agent-hostname" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Hostname
            </label>
            <input
              id="agent-hostname"
              type="text"
              value={agentHostname}
              onChange={(e) => onHostnameChange(e.target.value)}
              placeholder="remote-host"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            />
          </div>
        )}

        <div>
          <label htmlFor="agent-port" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Port
          </label>
          <input
            id="agent-port"
            type="number"
            value={agentPort}
            onChange={(e) => onPortChange(e.target.value)}
            min="1"
            max="65535"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="agent-username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Username (optional)
          </label>
          <input
            id="agent-username"
            type="text"
            value={agentUsername}
            onChange={(e) => onUsernameChange(e.target.value)}
            placeholder="SSH username"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
        </div>

        <div>
          <label htmlFor="agent-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Password (optional)
          </label>
          <div className="relative">
            <input
              id="agent-password"
              type={showPassword ? "text" : "password"}
              value={agentPassword}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="SSH password"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
              {...PASSWORD_INPUT_PROPS}
            />
            <button
              type="button"
              onClick={onShowPasswordToggle}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            >
              {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
