import { useEffect, useState } from "react";
import {
  CodeValue,
  ErrorState,
  FormActions,
  FormGroup,
  Panel,
  SelectField,
  TextField,
  type WebAppRoute,
  useToast,
} from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
  SshServer,
  TerminalSession,
  VncSession,
  Workspace,
} from "@/shared";
import {
  getExecutionHostAgentProvider,
  getExecutionHostDefaultDirectory,
} from "@/shared";
import type { ExecutionHostWorkingDirectory } from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import {
  makeModelKey,
  ModelSelector,
  parseModelKey,
} from "../ModelSelector";
import { VncViewer } from "./VncViewer";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { useExecutionHostModelDiscovery } from "./use-execution-host-model-discovery";
import { createOrResumeExecutionHostVncSessionApi } from "../../hooks/executionHostActions";
import { SshServerSettingsForm } from "./ssh-server-settings-form";
import { useShellHeaderActions } from "./shell-header-actions";
import { ClankyListRow } from "./clanky-list-row";
import {
  formatStatusLabel,
  getChatStatusBadgeVariant,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
  StatusBadge,
} from "../common";

interface ExecutionHostViewProps {
  host: ExecutionHostDescriptor;
  workspaces: Workspace[];
  sessions: TerminalSession[];
  chats: Chat[];
  sshServer?: SshServer;
  provisioning: UseProvisioningJobResult;
  onNavigate: (route: WebAppRoute) => void;
  onRefresh: () => Promise<void>;
  onUpdateSshServer: (
    id: string,
    request?: import("@/contracts").UpdateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  onDeleteSshServer: (id: string) => Promise<boolean>;
}

function hostApiPath(host: ExecutionHostDescriptor): string {
  const id = host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId;
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function ExecutionHostView({
  host,
  workspaces,
  sessions,
  chats,
  sshServer,
  provisioning,
  onNavigate,
  onRefresh,
  onUpdateSshServer,
  onDeleteSshServer,
}: ExecutionHostViewProps) {
  const toast = useToast();
  const [directory, setDirectory] = useState(host.repositoriesBasePath ?? "");
  const [directoryConfigured, setDirectoryConfigured] = useState(
    host.repositoriesBasePath !== null,
  );
  const [directoryLoading, setDirectoryLoading] = useState(
    host.repositoriesBasePath === null,
  );
  const [discoveryDirectory, setDiscoveryDirectory] = useState(
    host.repositoriesBasePath ?? "",
  );
  const [preferredModel, setPreferredModel] = useState(
    host.preferredModel
      ? makeModelKey(
        host.preferredModel.providerID,
        host.preferredModel.modelID,
        host.preferredModel.variant,
      )
      : "",
  );
  const [vncPort, setVncPort] = useState("5900");
  const [vncUsername, setVncUsername] = useState("");
  const [vncPassword, setVncPassword] = useState("");
  const [vncSession, setVncSession] = useState<VncSession | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sshFormValid, setSshFormValid] = useState(false);
  const [sshFormSubmitting, setSshFormSubmitting] = useState(false);
  const available = host.availability === "local"
    || host.availability === "available"
    || host.availability === "online";
  const discovery = useExecutionHostModelDiscovery(host, discoveryDirectory);
  const apiPath = hostApiPath(host);
  useShellHeaderActions(sshServer ? (
    <Button
      type="submit"
      form="execution-host-ssh-settings"
      size="sm"
      loading={sshFormSubmitting}
      disabled={!sshFormValid || sshFormSubmitting}
    >
      Save
    </Button>
  ) : null);

  useEffect(() => {
    const controller = new AbortController();
    setDirectory(host.repositoriesBasePath ?? "");
    setDiscoveryDirectory(host.repositoriesBasePath ?? "");
    setDirectoryConfigured(host.repositoriesBasePath !== null);
    setDirectoryLoading(host.repositoriesBasePath === null);
    setError(null);
    void (async () => {
      try {
        const resolved = await apiRequest<ExecutionHostWorkingDirectory>(
          `${apiPath}/working-directory`,
          {
            signal: controller.signal,
            action: "Resolve execution-host working directory",
            fallbackMessage: "Failed to resolve the server working directory",
          },
        );
        if (!controller.signal.aborted) {
          setDirectory(resolved.directory);
          setDiscoveryDirectory(resolved.directory);
          setDirectoryConfigured(resolved.configured);
        }
      } catch (directoryError) {
        if (directoryError instanceof DOMException && directoryError.name === "AbortError") {
          return;
        }
        setError(String(directoryError));
      } finally {
        if (!controller.signal.aborted) {
          setDirectoryLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [apiPath, host.configurationRevision, host.repositoriesBasePath]);

  useEffect(() => {
    const preferred = host.preferredModel;
    setPreferredModel(preferred
      ? makeModelKey(
        preferred.providerID,
        preferred.modelID,
        preferred.variant,
      )
      : "");
  }, [
    apiPath,
    host.configurationRevision,
    host.preferredModel?.modelID,
    host.preferredModel?.providerID,
    host.preferredModel?.variant,
  ]);

  async function runAction<T>(name: string, action: () => Promise<T>): Promise<T | null> {
    setPendingAction(name);
    setError(null);
    try {
      return await action();
    } catch (actionError) {
      setError(String(actionError));
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  async function createVncSession() {
    const remotePort = Number.parseInt(vncPort, 10);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      setError("VNC port must be between 1 and 65535.");
      return;
    }

    const session = await runAction("vnc", () =>
      createOrResumeExecutionHostVncSessionApi({
        executionHost: host.ref,
        remotePort,
      }));
    if (session) {
      setVncSession(session);
    }
  }

  async function saveDefaults(repositoriesBasePath: string | null) {
    const parsedModel = parseModelKey(preferredModel);
    const updated = await runAction("defaults", () =>
      apiRequest<ExecutionHostDescriptor>(`${apiPath}/configuration`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoriesBasePath,
          preferredModel: parsedModel,
          expectedRevision: host.configurationRevision,
        }),
        action: "Save execution-host defaults",
        fallbackMessage: "Failed to save server defaults",
      }));
    if (!updated) {
      return;
    }
    setDirectoryConfigured(updated.repositoriesBasePath !== null);
    if (updated.repositoriesBasePath) {
      setDirectory(updated.repositoriesBasePath);
      setDiscoveryDirectory(updated.repositoriesBasePath);
    }
    await onRefresh();
    toast.success("Server defaults saved");
  }

  async function runArise() {
    const snapshot = await provisioning.startJob({
      name: host.name,
      executionHost: host.ref,
      repoUrl: "",
      basePath: getExecutionHostDefaultDirectory(host),
      devcontainerSubpath: null,
      devboxTemplate: null,
      provider: getExecutionHostAgentProvider(host),
      mode: "arise",
      targetDirectory: null,
      workspaceId: null,
    });
    if (snapshot) {
      onNavigate({
        view: "provisioning-job",
        provisioningJobId: snapshot.job.config.id,
        returnView: "execution-host",
        returnKind: host.ref.kind,
        returnId: host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId,
      });
    }
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorState description={error} /> : null}
      <Panel className="divide-y divide-gray-200 p-0 dark:divide-gray-800">
        <div className="grid gap-2 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm font-medium">Transport</span>
          <span className="text-sm sm:text-right">{host.ref.kind.toUpperCase()}</span>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm font-medium">Status</span>
          <span className="text-sm capitalize sm:text-right">{host.availability}</span>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm font-medium">Target</span>
          <div className="min-w-0 overflow-x-auto sm:text-right">
            <CodeValue value={host.targetKey} />
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel padding="compact">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Workspaces</p>
          <p className="mt-2 text-3xl font-semibold">{workspaces.length}</p>
        </Panel>
        <Panel padding="compact">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Terminals</p>
          <p className="mt-2 text-3xl font-semibold">{sessions.length}</p>
        </Panel>
        <Panel padding="compact">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Chats</p>
          <p className="mt-2 text-3xl font-semibold">{chats.length}</p>
        </Panel>
      </div>

      {workspaces.length > 0 ? (
        <Panel title="Workspaces">
          <div className="space-y-2">
            {workspaces.map((workspace) => (
              <ClankyListRow
                key={workspace.id}
                title={workspace.name}
                description={workspace.directory}
                onClick={() => onNavigate({ view: "workspace", workspaceId: workspace.id })}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {sessions.length > 0 ? (
        <Panel title="Terminals">
          <div className="space-y-2">
            {sessions.map((session) => (
              <ClankyListRow
                key={session.config.id}
                title={session.config.name}
                description={session.config.directory}
                badge={(
                  <StatusBadge variant={getTerminalSessionStatusBadgeVariant(session.state.status)}>
                    {getTerminalSessionStatusLabel(session.state.status)}
                  </StatusBadge>
                )}
                onClick={() => onNavigate({
                  view: "terminal",
                  terminalSessionId: session.config.id,
                })}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {chats.length > 0 ? (
        <Panel title="Chats">
          <div className="space-y-2">
            {chats.map((chat) => (
              <ClankyListRow
                key={chat.config.id}
                title={chat.config.name}
                description={chat.config.directory}
                badge={(
                  <StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>
                    {formatStatusLabel(chat.state.status)}
                  </StatusBadge>
                )}
                onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {sshServer ? (
        <SshServerSettingsForm
          server={sshServer}
          relatedSessionCount={sessions.length}
          formId="execution-host-ssh-settings"
          onSave={onUpdateSshServer}
          onDeleteServer={async () => await onDeleteSshServer(sshServer.config.id)}
          onSaved={async () => {
            await onRefresh();
            toast.success("Server settings saved");
          }}
          onDeleted={() => onNavigate({ view: "home" })}
          onValidityChange={setSshFormValid}
          onSubmittingChange={setSshFormSubmitting}
        />
      ) : host.ref.kind === "local" ? <Panel>
        <div className="space-y-4">
          <TextField
            id="execution-host-directory"
            label="Target directory"
            value={directory}
            onChange={(event) => {
              setDirectory(event.target.value);
              setDirectoryConfigured(true);
            }}
            onBlur={() => {
              if (directory.trim()) {
                setDiscoveryDirectory(directory.trim());
              }
            }}
            disabled={directoryLoading}
            className="font-mono"
          />
          <SelectField
            id="execution-host-provider"
            label="Preferred provider"
            value={discovery.provider}
            onChange={(event) => {
              discovery.setProvider(event.target.value as typeof discovery.provider);
              setPreferredModel("");
            }}
            disabled={discovery.providersLoading || discovery.providerOptions.length === 0}
          >
            {discovery.providerOptions.length === 0 ? (
              <option value="">
                {discovery.providersLoading ? "Loading providers..." : "No providers available"}
              </option>
            ) : discovery.providerOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </SelectField>
          <div>
            <label
              htmlFor="execution-host-model"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Preferred model
            </label>
            <ModelSelector
              id="execution-host-model"
              value={preferredModel}
              onChange={setPreferredModel}
              models={discovery.models}
              loading={discovery.modelsLoading}
              showDisconnected
              additionalOptions={[{ value: "", label: "No node preference" }]}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
              emptyText="Choose an available provider and directory"
            />
          </div>
          {discovery.error ? <ErrorState description={discovery.error} /> : null}
          <FormActions>
            {!directoryConfigured ? (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Using the server process directory
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void saveDefaults(null)}
                disabled={pendingAction !== null}
              >
                Use process directory
              </Button>
            )}
            <Button
              type="button"
              onClick={() => void saveDefaults(directory.trim())}
              loading={pendingAction === "defaults"}
              disabled={
                !available
                || directoryLoading
                || !directory.trim()
                || discovery.providersLoading
                || discovery.modelsLoading
              }
            >
              Save defaults
            </Button>
          </FormActions>
        </div>
      </Panel> : (
        <Panel>
          <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
            <span className="text-sm font-medium">Worker directory</span>
            <div className="min-w-0 overflow-x-auto sm:text-right">
              <CodeValue value={directoryLoading ? "Loading..." : directory} />
            </div>
          </div>
        </Panel>
      )}

      <FormGroup title="Arise">
        <div>
          <Button
            variant="secondary"
            onClick={() => void runArise()}
            loading={provisioning.starting}
            disabled={!available || !host.capabilities.devboxLifecycle}
          >
            Run Arise
          </Button>
        </div>
      </FormGroup>

      <FormGroup title="VNC">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              id="execution-host-vnc-port"
              label="Remote port"
              inputMode="numeric"
              value={vncPort}
              onChange={(event) => setVncPort(event.target.value)}
            />
            <TextField
              id="execution-host-vnc-username"
              label="VNC username"
              value={vncUsername}
              onChange={(event) => setVncUsername(event.target.value)}
            />
            <TextField
              id="execution-host-vnc-password"
              label="VNC password"
              type="password"
              value={vncPassword}
              onChange={(event) => setVncPassword(event.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => void createVncSession()}
            loading={pendingAction === "vnc"}
            disabled={!available || !host.capabilities.tcpTunnel}
          >
            {vncSession ? "Reconnect" : "Connect"}
          </Button>
          {vncSession ? (
            <Panel className="h-[min(65vh,48rem)] min-h-96 overflow-hidden p-0">
              <VncViewer
                session={vncSession}
                username={vncUsername || undefined}
                password={vncPassword || undefined}
                onDisconnect={() => setVncSession(null)}
                onError={setError}
              />
            </Panel>
          ) : null}
        </div>
      </FormGroup>
    </div>
  );
}
