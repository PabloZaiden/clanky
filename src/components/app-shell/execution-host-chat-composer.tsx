import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ErrorState,
  Modal,
  SelectField,
  TextField,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
} from "@/shared";
import { getExecutionHostSourceId, getRegisteredSshServerId } from "@/shared";
import type {
  CreateExecutionHostChatRequest,
  ExecutionHostWorkingDirectory,
} from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import { isApiErrorCode } from "../../lib/api-error";
import {
  getStoredChatModelPreference,
  saveStoredChatModelPreference,
} from "../../lib/model-selection-preferences";
import {
  getStoredSshCredentialToken,
  invalidateStoredSshCredentialToken,
  storeSshServerPassword,
} from "../../lib/ssh-browser-credentials";
import {
  makeModelKey,
  ModelSelector,
  modelVariantExists,
  parseModelKey,
} from "../ModelSelector";
import { Button, PASSWORD_INPUT_PROPS } from "../common";
import { useShellHeaderActions } from "./shell-header-actions";
import { useExecutionHostModelDiscovery } from "./use-execution-host-model-discovery";

function executionHostApiPath(host: ExecutionHostDescriptor): string {
  const id = getExecutionHostSourceId(host.ref);
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function ExecutionHostChatComposer({
  host,
  navigateWithinShell,
}: {
  host: ExecutionHostDescriptor;
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  const apiPath = useMemo(() => executionHostApiPath(host), [host.ref]);
  const storedModel = useMemo(() => getStoredChatModelPreference(), []);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(host.repositoriesBasePath ?? "");
  const [directoryLoading, setDirectoryLoading] = useState(
    host.repositoriesBasePath === null,
  );
  const [discoveryDirectory, setDiscoveryDirectory] = useState(
    host.repositoriesBasePath ?? "",
  );
  const [selectedModel, setSelectedModel] = useState("");
  const [autoApprovePermissions, setAutoApprovePermissions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const sshServerId = getRegisteredSshServerId(host.ref);
  const [sshCredential, setSshCredential] = useState<{
    serverId: string;
    token: string | null;
  } | null>(null);
  const credentialToken = sshServerId && sshCredential?.serverId === sshServerId
    ? sshCredential?.token ?? null
    : null;
  const credentialsReady = sshServerId === null
    || sshCredential?.serverId === sshServerId;
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSshCredentials = useCallback(() => {
    if (!sshServerId) {
      return;
    }
    invalidateStoredSshCredentialToken(sshServerId);
    setSshCredential({ serverId: sshServerId, token: null });
    setPasswordModalOpen(true);
  }, [sshServerId]);
  const discovery = useExecutionHostModelDiscovery(
    host,
    discoveryDirectory,
    storedModel?.providerID,
    credentialToken,
    requestSshCredentials,
  );

  useEffect(() => {
    let cancelled = false;
    setSshCredential(null);
    setPassword("");
    setPasswordModalOpen(false);
    if (!sshServerId) {
      return;
    }
    void (async () => {
      try {
        const token = await getStoredSshCredentialToken(sshServerId);
        if (cancelled) {
          return;
        }
        setSshCredential({ serverId: sshServerId, token });
        if (!token) {
          setPasswordModalOpen(true);
        }
      } catch (credentialError) {
        if (!cancelled) {
          setError(String(credentialError));
          setSshCredential({ serverId: sshServerId, token: null });
          setPasswordModalOpen(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sshServerId]);

  useEffect(() => {
    const controller = new AbortController();
    setDirectory(host.repositoriesBasePath ?? "");
    setDiscoveryDirectory(host.repositoriesBasePath ?? "");
    setDirectoryLoading(host.repositoriesBasePath === null);
    setSelectedModel("");
    setError(null);
    if (!credentialsReady || (host.ref.kind === "ssh" && !credentialToken)) {
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
            body: JSON.stringify({ credentialToken }),
            signal: controller.signal,
            action: "Resolve execution-host working directory",
            fallbackMessage: "Failed to resolve the server working directory",
          },
        );
        if (!controller.signal.aborted) {
          setDirectory(resolved.directory);
          setDiscoveryDirectory(resolved.directory);
        }
      } catch (directoryError) {
        if (directoryError instanceof DOMException && directoryError.name === "AbortError") {
          return;
        }
        if (isApiErrorCode(directoryError, "invalid_credential_token")) {
          requestSshCredentials();
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
    credentialToken,
    credentialsReady,
    host.ref.kind,
    host.repositoriesBasePath,
    requestSshCredentials,
  ]);

  useEffect(() => {
    const candidates = [host.preferredModel, storedModel];
    for (const candidate of candidates) {
      if (
        candidate
        && candidate.providerID === discovery.provider
        && discovery.models.some((model) =>
          model.connected
          && model.providerID === candidate.providerID
          && model.modelID === candidate.modelID)
        && modelVariantExists(
          discovery.models,
          candidate.providerID,
          candidate.modelID,
          candidate.variant,
        )
      ) {
        setSelectedModel(makeModelKey(
          candidate.providerID,
          candidate.modelID,
          candidate.variant,
        ));
        return;
      }
    }
    const firstConnected = discovery.models.find((model) => model.connected);
    setSelectedModel(firstConnected
      ? makeModelKey(
        firstConnected.providerID,
        firstConnected.modelID,
        firstConnected.variants?.[0] ?? "",
      )
      : "");
  }, [discovery.models, discovery.provider, host.preferredModel, storedModel]);

  const handleCancel = useCallback(() => {
    const id = getExecutionHostSourceId(host.ref);
    navigateWithinShell({
      view: "execution-host",
      hostKind: host.ref.kind,
      hostId: id,
    });
  }, [host.ref, navigateWithinShell]);

  const handleSubmit = useCallback(async () => {
    const model = parseModelKey(selectedModel);
    if (
      !directory.trim()
      || !model
      || model.providerID !== discovery.provider
    ) {
      setError("Choose a directory and model before creating the chat.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const request: CreateExecutionHostChatRequest = {
        name: name.trim() || `${host.name} chat`,
        directory: directory.trim(),
        model: {
          providerID: discovery.provider,
          modelID: model.modelID,
          variant: model.variant,
        },
        autoApprovePermissions,
        credentialToken,
      };
      const chat = await apiRequest<Chat>(`${apiPath}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create execution-host chat",
        fallbackMessage: "Failed to create chat",
      });
      saveStoredChatModelPreference(model);
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } catch (submitError) {
      if (isApiErrorCode(submitError, "invalid_credential_token")) {
        requestSshCredentials();
      }
      setError(String(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [
    apiPath,
    autoApprovePermissions,
    directory,
    discovery.provider,
    credentialToken,
    host.name,
    name,
    navigateWithinShell,
    requestSshCredentials,
    selectedModel,
  ]);

  const handlePasswordSubmit = useCallback(async () => {
    if (!sshServerId) {
      return;
    }
    const trimmedPassword = password.trim();
    if (!trimmedPassword) {
      setError("Enter the SSH password for this server.");
      return;
    }
    setPasswordSaving(true);
    setError(null);
    try {
      await storeSshServerPassword(sshServerId, trimmedPassword);
      const token = await getStoredSshCredentialToken(sshServerId);
      if (!token) {
        throw new Error("Failed to exchange SSH credential.");
      }
      setSshCredential({ serverId: sshServerId, token });
      setPassword("");
      setPasswordModalOpen(false);
    } catch (passwordError) {
      setError(String(passwordError));
    } finally {
      setPasswordSaving(false);
    }
  }, [password, sshServerId]);

  const canSubmit = !submitting
    && !directoryLoading
    && !discovery.providersLoading
    && !discovery.modelsLoading
    && credentialsReady
    && (host.ref.kind !== "ssh" || Boolean(credentialToken))
    && Boolean(directory.trim())
    && Boolean(selectedModel);
  const headerActions = useMemo(() => (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={handleCancel} disabled={submitting}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        loading={submitting}
      >
        Create chat
      </Button>
    </>
  ), [canSubmit, handleCancel, handleSubmit, submitting]);
  useShellHeaderActions(headerActions);

  return (
    <>
      <div className="space-y-5">
        {error || discovery.error ? (
          <ErrorState description={error ?? discovery.error ?? ""} />
        ) : null}
        <TextField
          id="execution-host-chat-name"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={`${host.name} chat`}
        />
        <TextField
          id="execution-host-chat-directory"
          label="Directory"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          onBlur={() => {
            if (directory.trim()) {
              setDiscoveryDirectory(directory.trim());
            }
          }}
          disabled={directoryLoading}
          className="font-mono"
        />
        <SelectField
          id="execution-host-chat-provider"
          label="Provider"
          value={discovery.provider}
          onChange={(event) =>
            discovery.setProvider(event.target.value as typeof discovery.provider)}
          disabled={
            discovery.providersLoading || discovery.providerOptions.length === 0
          }
        >
          {discovery.providerOptions.length === 0 ? (
            <option value="">
              {discovery.providersLoading
                ? "Loading providers..."
                : "No providers available"}
            </option>
          ) : discovery.providerOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <div>
          <label
            htmlFor="execution-host-chat-model"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Model
          </label>
          <ModelSelector
            id="execution-host-chat-model"
            value={selectedModel}
            onChange={setSelectedModel}
            models={discovery.models}
            loading={discovery.modelsLoading}
            showDisconnected
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            emptyText="Choose an available provider and directory"
          />
        </div>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={autoApprovePermissions}
            onChange={(event) => setAutoApprovePermissions(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
          />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Auto-approve permissions
          </span>
        </label>
      </div>
      <Modal
        isOpen={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
        title="SSH password required"
        description={`Enter the SSH password for ${host.name} to discover models and start chats.`}
        footer={(
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPasswordModalOpen(false)}
              disabled={passwordSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handlePasswordSubmit()}
              loading={passwordSaving}
            >
              Save password
            </Button>
          </>
        )}
      >
        <TextField
          id="execution-host-chat-ssh-password"
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...PASSWORD_INPUT_PROPS}
        />
      </Modal>
    </>
  );
}
