import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat, CreateSshServerChatRequest, ModelInfo, SshServer, Workspace } from "../../types";
import type { CreateChatRequest, ImportExistingChatRequest } from "../../types/api";
import type { AgentProvider } from "../../types/settings";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { useToast } from "../../hooks";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { appFetch } from "../../lib/public-path";
import { getStoredSshCredentialToken, invalidateStoredSshCredentialToken, storeSshServerPassword } from "../../lib/ssh-browser-credentials";
import {
  getStoredChatModelPreference,
  saveStoredChatModelPreference,
} from "../../lib/model-selection-preferences";
import {
  makeModelKey,
  ModelSelector,
  modelVariantExists,
  parseModelKey,
} from "../ModelSelector";
import { BranchSelector } from "../create-task/branch-selector";
import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";

interface ImportableChatSession {
  id: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  model?: string;
}

function getPreferredModelKey(
  models: UseDashboardDataResult["models"],
  preferredModel: UseDashboardDataResult["lastModel"],
  fallbackModel: UseDashboardDataResult["lastModel"],
): string {
  for (const candidate of [preferredModel, fallbackModel]) {
    if (!candidate) {
      continue;
    }
    const variant = candidate.variant ?? "";
    if (!modelVariantExists(models, candidate.providerID, candidate.modelID, variant)) {
      continue;
    }
    const matchingModel = models.find(
      (model) =>
        model.connected
        && model.providerID === candidate.providerID
        && model.modelID === candidate.modelID,
    );
    if (!matchingModel) {
      continue;
    }
    return makeModelKey(candidate.providerID, candidate.modelID, variant);
  }

  const firstConnected = models.find((model) => model.connected);
  if (!firstConnected) {
    return "";
  }
  return makeModelKey(
    firstConnected.providerID,
    firstConnected.modelID,
    firstConnected.variants?.[0] ?? "",
  );
}

export function ComposeChatView({
  composeWorkspace,
  composeServer = null,
  workspaces,
  workspacesLoading,
  workspaceError,
  dashboardData,
  shellHeaderOffsetClassName,
  navigateWithinShell,
  createChat,
  importExistingChat,
  createSshServerChat = async () => null,
}: {
  composeWorkspace: Workspace | null;
  composeServer?: SshServer | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  dashboardData: UseDashboardDataResult;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  createChat: (request: CreateChatRequest) => Promise<Chat | null>;
  importExistingChat: (request: ImportExistingChatRequest) => Promise<Chat | null>;
  createSshServerChat?: (serverId: string, request: CreateSshServerChatRequest) => Promise<Chat | null>;
}) {
  const { error: showError } = useToast();
  const {
    branches,
    branchesLoading,
    currentBranch,
    defaultBranch,
    handleWorkspaceChange,
    lastModel,
    models,
    modelsLoading,
    resetCreateModalState,
    setLastModel,
  } = dashboardData;
  const storedChatModel = useMemo(() => getStoredChatModelPreference(), []);
  const [name, setName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(composeWorkspace?.id ?? "");
  const [selectedModel, setSelectedModel] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [autoApprovePermissions, setAutoApprovePermissions] = useState(true);
  const [baseBranch, setBaseBranch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [importExistingSession, setImportExistingSession] = useState(false);
  const [importSessions, setImportSessions] = useState<ImportableChatSession[]>([]);
  const [importSessionsLoading, setImportSessionsLoading] = useState(false);
  const [selectedImportSessionId, setSelectedImportSessionId] = useState("");
  const [remoteDirectory, setRemoteDirectory] = useState(composeServer?.config.repositoriesBasePath ?? "~");
  const [remoteProvider, setRemoteProvider] = useState<AgentProvider>("copilot");
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([]);
  const [remoteModelsLoading, setRemoteModelsLoading] = useState(false);
  const [remoteCredentialToken, setRemoteCredentialToken] = useState<string | null>(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const loadedWorkspaceRef = useRef<string | null>(null);
  const isServerChat = Boolean(composeServer);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (isServerChat) {
      return;
    }
    loadedWorkspaceRef.current = null;
    setSelectedWorkspaceId(composeWorkspace?.id ?? "");
    setSelectedModel("");
  }, [composeWorkspace?.id, isServerChat]);

  useEffect(() => {
    if (isServerChat) {
      return;
    }
    if (!selectedWorkspace) {
      loadedWorkspaceRef.current = null;
      resetCreateModalState();
      setSelectedModel("");
      setBaseBranch("");
      return;
    }
    const workspaceKey = `${selectedWorkspace.id}:${selectedWorkspace.directory}`;
    if (loadedWorkspaceRef.current === workspaceKey) {
      return;
    }
    loadedWorkspaceRef.current = workspaceKey;
    setSelectedModel("");
    setBaseBranch("");
    handleWorkspaceChange(selectedWorkspace.id, selectedWorkspace.directory);
  }, [handleWorkspaceChange, isServerChat, resetCreateModalState, selectedWorkspace?.directory, selectedWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }
    setBaseBranch((current) => current || defaultBranch || currentBranch);
  }, [currentBranch, defaultBranch, selectedWorkspace?.id]);

  useEffect(() => {
    if (isServerChat || !importExistingSession || !selectedWorkspace) {
      setImportSessions([]);
      setSelectedImportSessionId("");
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setImportSessionsLoading(true);
      try {
        const response = await appFetch(`/api/chats/importable-sessions?workspaceId=${encodeURIComponent(selectedWorkspace.id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json() as { message?: string; error?: string };
          throw new Error(data.message ?? data.error ?? "Failed to list existing sessions");
        }
        const sessions = await response.json() as ImportableChatSession[];
        if (controller.signal.aborted) {
          return;
        }
        setImportSessions(sessions);
        setSelectedImportSessionId((current) => (
          current && sessions.some((session) => session.id === current)
            ? current
            : sessions[0]?.id ?? ""
        ));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setImportSessions([]);
        setSelectedImportSessionId("");
        showError(String(error));
      } finally {
        if (!controller.signal.aborted) {
          setImportSessionsLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [importExistingSession, isServerChat, selectedWorkspace?.id, showError]);

  useEffect(() => {
    if (importExistingSession) {
      setUseWorktree(false);
    }
  }, [importExistingSession]);

  useEffect(() => {
    if (isServerChat || selectedModel || models.length === 0) {
      return;
    }
    setSelectedModel(
      getPreferredModelKey(
        models,
        storedChatModel,
        lastModel,
      ),
    );
  }, [isServerChat, lastModel, models, selectedModel, storedChatModel]);

  useEffect(() => {
    if (!composeServer) {
      return;
    }
    setName("");
    setRemoteDirectory(composeServer.config.repositoriesBasePath ?? "~");
    setRemoteProvider("copilot");
    setSelectedModel("");
    setRemoteModels([]);
    setRemoteCredentialToken(null);
  }, [composeServer?.config.id, composeServer?.config.repositoriesBasePath]);

  useEffect(() => {
    if (!composeServer) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const token = await getStoredSshCredentialToken(composeServer.config.id);
        if (cancelled) {
          return;
        }
        if (!token) {
          setPasswordModalOpen(true);
          return;
        }
        setRemoteCredentialToken(token);
      } catch (error) {
        if (!cancelled) {
          showError(String(error));
          setPasswordModalOpen(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composeServer?.config.id, showError]);

  useEffect(() => {
    if (!composeServer || !remoteCredentialToken || !remoteDirectory.trim()) {
      setRemoteModels([]);
      setSelectedModel("");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      setRemoteModelsLoading(true);
      try {
        const response = await appFetch(`/api/ssh-servers/${composeServer.config.id}/chat-models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credentialToken: remoteCredentialToken,
            providerID: remoteProvider,
            directory: remoteDirectory.trim(),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json() as { code?: string; message?: string; error?: string };
          const errorCode = data.code ?? data.error;
          if (
            response.status === 400
            && errorCode === "invalid_credential_token"
            && composeServer
          ) {
            invalidateStoredSshCredentialToken(composeServer.config.id);
            setRemoteCredentialToken(null);
            setPasswordModalOpen(true);
          }
          throw new Error(data.message ?? data.error ?? "Failed to discover remote models");
        }
        const nextModels = await response.json() as ModelInfo[];
        if (controller.signal.aborted) {
          return;
        }
        setRemoteModels(nextModels);
        const firstModel = nextModels.find((model) => model.connected) ?? nextModels[0];
        setSelectedModel(firstModel
          ? makeModelKey(firstModel.providerID, firstModel.modelID, firstModel.variants?.[0] ?? "")
          : "");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setRemoteModels([]);
        setSelectedModel("");
        showError(String(error));
      } finally {
        if (!controller.signal.aborted) {
          setRemoteModelsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [composeServer, remoteCredentialToken, remoteDirectory, remoteProvider, showError]);

  async function handlePasswordSubmit(): Promise<void> {
    if (!composeServer) {
      return;
    }
    const trimmedPassword = password.trim();
    if (!trimmedPassword) {
      showError("Enter the SSH password for this server");
      return;
    }
    setPasswordSaving(true);
    try {
      await storeSshServerPassword(composeServer.config.id, trimmedPassword);
      const token = await getStoredSshCredentialToken(composeServer.config.id);
      if (!token) {
        throw new Error("Failed to exchange SSH credential");
      }
      setRemoteCredentialToken(token);
      setPassword("");
      setPasswordModalOpen(false);
    } catch (error) {
      showError(String(error));
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (composeServer) {
      const parsedModel = parseModelKey(effectiveSelectedModel);
      if (!parsedModel) {
        showError("Select a model first");
        return;
      }
      if (!remoteCredentialToken) {
        setPasswordModalOpen(true);
        return;
      }
      setIsSubmitting(true);
      try {
        const chat = await createSshServerChat(composeServer.config.id, {
          name: name.trim() || undefined,
          directory: remoteDirectory.trim(),
          model: {
            providerID: parsedModel.providerID,
            modelID: parsedModel.modelID,
            variant: parsedModel.variant ?? "",
          },
          autoApprovePermissions,
          credentialToken: remoteCredentialToken,
        });
        if (!chat) {
          showError("Failed to create chat");
          return;
        }
        navigateWithinShell({ view: "chat", chatId: chat.config.id });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!selectedWorkspace) {
      showError("Select a workspace first");
      return;
    }
    const parsedModel = parseModelKey(effectiveSelectedModel);
    if (!parsedModel) {
      showError("Select a model first");
      return;
    }

    setIsSubmitting(true);
    try {
      if (importExistingSession) {
        const selectedImportSession = importSessions.find((session) => session.id === selectedImportSessionId);
        const selectedSessionId = selectedImportSessionId.trim();
        if (!selectedSessionId || !selectedImportSession) {
          showError("Select an existing session");
          return;
        }
        const chat = await importExistingChat({
          name: name.trim() || selectedImportSession?.title,
          workspaceId: selectedWorkspace.id,
          model: {
            providerID: parsedModel.providerID,
            modelID: parsedModel.modelID,
            variant: parsedModel.variant ?? "",
          },
          sessionId: selectedSessionId,
          cwd: selectedImportSession.cwd,
          autoApprovePermissions,
        });
        if (!chat) {
          showError("Failed to import chat");
          return;
        }
        setLastModel({
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant,
        });
        saveStoredChatModelPreference({
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant,
        });
        navigateWithinShell({ view: "chat", chatId: chat.config.id });
        return;
      }

      const chat = await createChat({
        name: name.trim(),
        workspaceId: selectedWorkspace.id,
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant ?? "",
        },
        useWorktree,
        autoApprovePermissions,
        baseBranch: baseBranch.trim() || currentBranch.trim(),
        quick: false,
      });
      if (!chat) {
        showError("Failed to create chat");
        return;
      }
      setLastModel({
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      });
      saveStoredChatModelPreference({
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      });
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleCancel = () =>
    navigateWithinShell(
      composeServer
        ? { view: "ssh-server", serverId: composeServer.config.id }
        : composeWorkspace ? { view: "workspace", workspaceId: composeWorkspace.id } : { view: "home" },
    );

  const modelOptions = isServerChat ? remoteModels : models;
  const modelOptionsLoading = isServerChat ? remoteModelsLoading : modelsLoading;
  const effectiveSelectedModel = selectedModel || (
    !isServerChat && models.length > 0
      ? getPreferredModelKey(models, storedChatModel, lastModel)
      : ""
  );

  return (
    <>
      <ShellPanel
        eyebrow="Chat"
        title={
          composeServer
            ? `Start a new chat on ${composeServer.config.name}`
            : composeWorkspace ? `Start a new chat in ${composeWorkspace.name}` : "Start a new chat"
        }
      description={composeServer ? `${composeServer.config.username}@${composeServer.config.address}` : composeWorkspace?.directory}
      descriptionClassName="hidden font-mono sm:inline"
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      actions={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={handleCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={
              isSubmitting
              || (!isServerChat && branchesLoading)
              || modelOptionsLoading
              || importSessionsLoading
              || (!isServerChat && !selectedWorkspace)
              || (isServerChat && (!remoteDirectory.trim() || !remoteCredentialToken))
              || !effectiveSelectedModel
              || (!isServerChat && importExistingSession && !selectedImportSessionId.trim())
            }
            loading={isSubmitting}
          >
            {importExistingSession ? "Import chat" : "Create chat"}
          </Button>
        </>
      )}
    >
      <div className="space-y-5">
        <div>
          <label htmlFor="chat-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Name
          </label>
          <input
            id="chat-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Repository pairing session"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
          />
        </div>

        {!isServerChat && (
          <div>
          <label htmlFor="chat-workspace" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Workspace
          </label>
          <select
            id="chat-workspace"
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            disabled={Boolean(composeWorkspace) || workspacesLoading}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60"
          >
            <option value="">
              {workspacesLoading ? "Loading workspaces..." : "Select a workspace"}
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          {workspaceError && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{workspaceError}</p>
          )}
        </div>
        )}

        {isServerChat && (
          <>
            <div>
              <label htmlFor="chat-directory" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Remote directory
              </label>
              <input
                id="chat-directory"
                value={remoteDirectory}
                onChange={(event) => setRemoteDirectory(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
              />
            </div>

            <div>
              <label htmlFor="chat-provider" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Provider
              </label>
              <select
                id="chat-provider"
                value={remoteProvider}
                onChange={(event) => setRemoteProvider(event.target.value as AgentProvider)}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
              >
                {AGENT_PROVIDER_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {!isServerChat && (
          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={importExistingSession}
                onChange={(event) => setImportExistingSession(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
              />
              <div className="flex-1">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Import existing session
                </span>
              </div>
            </label>

            {importExistingSession && (
              <div className="mt-4">
                <div>
                  <label htmlFor="import-session-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Existing sessions
                  </label>
                  <select
                    id="import-session-select"
                    value={selectedImportSessionId}
                    onChange={(event) => setSelectedImportSessionId(event.target.value)}
                    disabled={importSessionsLoading || importSessions.length === 0}
                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60"
                  >
                    <option value="">
                      {importSessionsLoading
                        ? "Loading sessions..."
                        : importSessions.length === 0 ? "No discoverable sessions" : "Select a session"}
                    </option>
                    {importSessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {(session.title || session.id)}{session.cwd ? ` - ${session.cwd}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <label htmlFor="chat-model" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Model
          </label>
          <ModelSelector
            id="chat-model"
            value={effectiveSelectedModel}
            onChange={setSelectedModel}
            models={modelOptions}
            loading={modelOptionsLoading}
            showDisconnected
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            emptyText={isServerChat ? "Enter SSH credentials to load models" : "Select a workspace to load models"}
          />
        </div>

        {!isServerChat && (
          <BranchSelector
          selectedBranch={baseBranch}
          onBranchChange={setBaseBranch}
          branches={branches}
          branchesLoading={branchesLoading}
          defaultBranch={defaultBranch}
          currentBranch={currentBranch}
          disabled={importExistingSession}
          />
        )}

        {!isServerChat && (
          <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={importExistingSession ? false : useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
              disabled={importExistingSession}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Use worktree
              </span>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Keep the chat session isolated in its own Clanky worktree when supported.
              </p>
            </div>
          </label>
        </div>
        )}

        <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={autoApprovePermissions}
              onChange={(event) => setAutoApprovePermissions(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Auto-approve permissions
              </span>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Let the provider continue automatically when it requests permission to run actions.
              </p>
            </div>
          </label>
        </div>
      </div>
      </ShellPanel>

      <Modal
        isOpen={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
        title="SSH password required"
        description={composeServer ? `Enter the SSH password for ${composeServer.config.name} to discover models and start chats.` : undefined}
        footer={(
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPasswordModalOpen(false)} disabled={passwordSaving}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void handlePasswordSubmit()} loading={passwordSaving}>
              Save password
            </Button>
          </>
        )}
      >
        <label htmlFor="ssh-chat-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Password
        </label>
        <input
          id="ssh-chat-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
        />
      </Modal>
    </>
  );
}
