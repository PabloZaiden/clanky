import { useEffect, useMemo, useState } from "react";
import {
  type ActionMenuItem,
  CodeValue,
  ErrorState,
  FormActions,
  Panel,
  SelectField,
  TextField,
  useHeaderActions,
  type WebAppRoute,
  useToast,
} from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
  TerminalSession,
  Workspace,
} from "@/shared";
import {
  getExecutionHostAgentProvider,
  getExecutionHostDefaultDirectory,
  getExecutionHostSourceId,
  supportsExecutionHostCapability,
} from "@/shared";
import type { ExecutionHostWorkingDirectory } from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import {
  makeModelKey,
  ModelSelector,
  parseModelKey,
} from "../ModelSelector";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { useExecutionHostModelDiscovery } from "./use-execution-host-model-discovery";
import { ExecutionHostPrerequisitesSection } from "./execution-host-prerequisites-section";
import { useExecutionHostPrerequisites } from "./use-execution-host-prerequisites";
import { ClankyListRow } from "./clanky-list-row";
import { WorkItemRow } from "./work-item-row";
import { PreviewSessionsView } from "./preview-sessions-view";
import { buildPreviewCliCommand } from "../../utils";
import {
  formatStatusLabel,
  getChatStatusBadgeVariant,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
  StatusBadge,
  StateText,
} from "../common";

interface ExecutionHostViewProps {
  host: ExecutionHostDescriptor;
  executionHosts: ExecutionHostDescriptor[];
  workspaces: Workspace[];
  sessions: TerminalSession[];
  chats: Chat[];
  provisioning: UseProvisioningJobResult;
  onNavigate: (route: WebAppRoute) => void;
  onRefresh: () => Promise<void>;
}

function hostApiPath(host: ExecutionHostDescriptor): string {
  const id = getExecutionHostSourceId(host.ref);
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function ExecutionHostView({
  host,
  executionHosts,
  workspaces,
  sessions,
  chats,
  provisioning,
  onNavigate,
  onRefresh,
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
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostUsable = host.acceptRemoteExecution;
  const supportsFileOperations = supportsExecutionHostCapability(
    host.capabilities,
    "fileOperations",
  );
  const discovery = useExecutionHostModelDiscovery(
    host,
    discoveryDirectory,
  );
  const prerequisites = useExecutionHostPrerequisites({
    executionHost: host.ref,
  });
  const apiPath = hostApiPath(host);
  const headerMenuActions = useMemo<ActionMenuItem[]>(() => [
    {
      id: "run-arise",
      label: "Run Arise",
      disabled: !hostUsable
        || !host.capabilities.provisioning
        || !host.capabilities.devboxLifecycle
        || provisioning.starting,
      onAction: () => void runArise(),
    },
  ], [
    host.capabilities.devboxLifecycle,
    host.capabilities.provisioning,
    hostUsable,
    prerequisites,
    provisioning.starting,
  ]);
  useHeaderActions({
    overflow: headerMenuActions,
  });

  useEffect(() => {
    const controller = new AbortController();
    setDirectory(host.repositoriesBasePath ?? "");
    setDiscoveryDirectory(host.repositoriesBasePath ?? "");
    setDirectoryConfigured(host.repositoriesBasePath !== null);
    setDirectoryLoading(host.repositoriesBasePath === null);
    setError(null);
    if (!supportsFileOperations) {
      setDirectoryLoading(false);
      return () => controller.abort();
    }
    void (async () => {
      try {
        const resolved = await apiRequest<ExecutionHostWorkingDirectory>(
          `${apiPath}/working-directory`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
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
  }, [
    apiPath,
    host.configurationRevision,
    host.repositoriesBasePath,
    supportsFileOperations,
  ]);

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
        returnId: getExecutionHostSourceId(host.ref),
      });
    }
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorState description={error} /> : null}

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

      {supportsExecutionHostCapability(host.capabilities, "tcpTunnel") ? (
        <PreviewSessionsView
          scope={{ kind: "server", executionHost: host.ref }}
          buildCommand={(port) => buildPreviewCliCommand({
            server: host,
            servers: executionHosts,
            port,
          })}
        />
      ) : null}

      {sessions.length > 0 ? (
        <Panel title="Terminals">
          <div className="space-y-2">
            {sessions.map((session) => (
              <WorkItemRow
                key={session.config.id}
                title={session.config.name}
                workspace={workspaces.find((workspace) => workspace.id === session.config.workspaceId)}
                subtitle={host.name}
                itemType="Terminal"
                lastInteractionAt={session.state.lastConnectedAt ?? session.config.createdAt}
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
              <WorkItemRow
                key={chat.config.id}
                title={chat.config.name}
                workspace={workspaces.find((workspace) => workspace.id === chat.config.workspaceId)}
                subtitle={host.name}
                itemType="Chat"
                lastInteractionAt={chat.state.lastUserMessageAt ?? chat.config.createdAt}
                badge={(
                  <StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>
                    <StateText>{formatStatusLabel(chat.state.status)}</StateText>
                  </StatusBadge>
                )}
                onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {host.ref.kind === "local" && supportsFileOperations ? <Panel>
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
          {host.capabilities.acpRuntime ? (
            <>
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
            </>
          ) : null}
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
                !hostUsable
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
      </Panel> : supportsFileOperations ? (
        <Panel>
          <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
            <span className="text-sm font-medium">Worker directory</span>
            <div className="min-w-0 overflow-x-auto sm:text-right">
              <CodeValue value={directoryLoading ? "Loading..." : directory} />
            </div>
          </div>
        </Panel>
      ) : null}

      {host.capabilities.provisioning ? (
        <ExecutionHostPrerequisitesSection
          error={prerequisites.error}
          report={prerequisites.report}
          checking={prerequisites.checking}
          disabled={!hostUsable || !host.capabilities.provisioning}
          onCheck={prerequisites.check}
        />
      ) : null}

    </div>
  );
}
