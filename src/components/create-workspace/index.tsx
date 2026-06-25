/**
 * CreateWorkspaceModal component for manual and automatic workspace creation.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from "react";
import { Modal } from "@pablozaiden/webapp/web";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import type { AgentProvider, ServerSettings, SshServer } from "../../types";
import type { CreateWorkspaceRequest } from "../../types/workspace";
import { appFetch } from "../../lib/public-path";
import { useDevboxTemplates } from "../../hooks/useDevboxTemplates";
import { useProvisioningJob } from "../../hooks/useProvisioningJob";
import { getCreateWorkspaceDefaultServerSettings } from "../../types/settings";
import { ModeTabs } from "./mode-tabs";
import { WorkspaceNameField } from "./workspace-name-field";
import { ManualWorkspaceForm } from "./manual-workspace-form";
import { AutomaticWorkspaceForm } from "./automatic-workspace-form";
import { FormError } from "./form-error";
import { ModalFooter } from "./modal-footer";

export interface CreateWorkspaceModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to create the workspace */
  onCreate: (request: CreateWorkspaceRequest) => Promise<boolean>;
  /** Whether creation is in progress */
  creating?: boolean;
  /** Error message from workspace creation */
  error?: string | null;
  /** Whether remote-only mode is enabled (CLANKY_REMOTE_ONLY) */
  remoteOnly?: boolean;
  /** Registered standalone SSH servers available for hostname selection */
  registeredSshServers?: SshServer[];
  /** Callback invoked when provisioning creates or reuses a workspace */
  onProvisioningSuccess?: () => Promise<void>;
}

/**
 * CreateWorkspaceModal provides UI for creating new workspaces with server settings.
 */
export function CreateWorkspaceModal({
  isOpen,
  onClose,
  onCreate,
  creating = false,
  error,
  remoteOnly = false,
  registeredSshServers = [],
  onProvisioningSuccess,
}: CreateWorkspaceModalProps) {
  const provisioning = useProvisioningJob();
  const defaultServerSettings = useMemo(() => getCreateWorkspaceDefaultServerSettings(), []);
  const hasActiveProvisioningJob = provisioning.activeJobId !== null;
  const lastProvisioningRefreshIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const lastSubmittedFormValuesRef = useRef<{
    jobId: string | null;
    name: string;
    automaticServerId: string;
    automaticRepoUrl: string;
    automaticBasePath: string;
    automaticDevcontainerSubpath: string;
    automaticDevboxTemplate: string;
    automaticCreateNewRepository: boolean;
    automaticProvider: AgentProvider;
  } | null>(null);
  const autoSelectedDevboxTemplateRef = useRef<string | null>(null);

  // Workspace form state
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [mode, setMode] = useState<"manual" | "automatic">("manual");
  const [automaticServerId, setAutomaticServerId] = useState("");
  const [automaticRepoUrl, setAutomaticRepoUrl] = useState("");
  const [automaticCreateNewRepository, setAutomaticCreateNewRepository] = useState(false);
  const [automaticBasePath, setAutomaticBasePath] = useState("/workspaces");
  const [automaticDevcontainerSubpath, setAutomaticDevcontainerSubpath] = useState("");
  const [automaticDevboxTemplate, setAutomaticDevboxTemplate] = useState("");
  const [automaticAdvancedOpen, setAutomaticAdvancedOpen] = useState(false);
  const [automaticProvider, setAutomaticProvider] = useState<AgentProvider>("copilot");
  const [automaticPassword, setAutomaticPassword] = useState("");

  // Server settings state
  const [serverSettings, setServerSettings] = useState<ServerSettings>(defaultServerSettings);
  const [isServerSettingsValid, setIsServerSettingsValid] = useState(true);

  // Test connection state (managed internally)
  const [testing, setTesting] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }

    if (wasOpenRef.current) {
      // Modal is already open — do not reset form values in response to any
      // dependency change (e.g. hasActiveProvisioningJob flipping after clearActiveJob).
      return;
    }

    wasOpenRef.current = true;
    if (hasActiveProvisioningJob) {
      setMode("automatic");
      return;
    }

    setMode("manual");
    setName("");
    setDirectory("");
    setAutomaticServerId(registeredSshServers[0]?.config.id ?? "");
    setAutomaticRepoUrl("");
    setAutomaticCreateNewRepository(false);
    setAutomaticBasePath("/workspaces");
    setAutomaticDevcontainerSubpath("");
    setAutomaticDevboxTemplate("");
    setAutomaticAdvancedOpen(false);
    setAutomaticProvider("copilot");
    setAutomaticPassword("");
    setServerSettings(defaultServerSettings);
    setIsServerSettingsValid(true);
    setTesting(false);
  }, [defaultServerSettings, hasActiveProvisioningJob, isOpen, registeredSshServers]);

  useEffect(() => {
    const jobId = provisioning.snapshot?.job.config.id ?? null;
    if (
      provisioning.snapshot?.job.state.status === "completed"
      && onProvisioningSuccess
      && jobId
      && lastProvisioningRefreshIdRef.current !== jobId
    ) {
      lastProvisioningRefreshIdRef.current = jobId;
      void onProvisioningSuccess();
    }
  }, [
    onProvisioningSuccess,
    provisioning.snapshot?.job.config.id,
    provisioning.snapshot?.job.state.status,
  ]);

  // Handle form submission
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (mode === "automatic") {
      lastSubmittedFormValuesRef.current = {
        jobId: null,
        name: name.trim(),
        automaticServerId,
        automaticRepoUrl: automaticRepoUrl.trim(),
        automaticBasePath: automaticBasePath.trim(),
        automaticDevcontainerSubpath: automaticDevcontainerSubpath.trim(),
        automaticDevboxTemplate: automaticDevboxTemplate.trim(),
        automaticCreateNewRepository,
        automaticProvider,
      };
      const snapshot = await provisioning.startJob({
        name: name.trim(),
        sshServerId: automaticServerId,
        repoUrl: automaticCreateNewRepository ? "" : automaticRepoUrl.trim(),
        basePath: automaticBasePath.trim(),
        devcontainerSubpath: automaticDevboxTemplate.trim()
          ? null
          : automaticDevcontainerSubpath.trim() || null,
        devboxTemplate: automaticDevboxTemplate.trim() || null,
        provider: automaticProvider,
        createNewRepository: automaticCreateNewRepository,
        password: automaticPassword,
        mode: "provision",
        targetDirectory: null,
        workspaceId: null,
      });
      if (snapshot) {
        // Associate the saved values with this specific job id so that
        // handleBackToAutomaticForm can distinguish them from values
        // submitted for an earlier (now inactive) job.
        if (lastSubmittedFormValuesRef.current) {
          lastSubmittedFormValuesRef.current.jobId = snapshot.job.config.id;
        }
        setMode("automatic");
        setAutomaticPassword("");
      }
      return;
    }

    const request: CreateWorkspaceRequest = {
      name: name.trim(),
      directory: directory.trim(),
      serverSettings,
    };

    const success = await onCreate(request);
    if (success) {
      onClose();
    }
  }

  // Handle server settings change
  function handleServerSettingsChange(settings: ServerSettings, isValid: boolean) {
    setServerSettings(settings);
    setIsServerSettingsValid(isValid);
  }

  // Handle test connection - uses the directory from the form
  const handleTestConnection = useCallback(async (settings: ServerSettings): Promise<{ success: boolean; error?: string }> => {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) {
      return { success: false, error: "Please enter a directory first" };
    }

    setTesting(true);
    try {
      const res = await appFetch("/api/server-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, directory: trimmedDirectory }),
      });
      const result = await res.json();
      return result;
    } catch (error) {
      return { success: false, error: String(error) };
    } finally {
      setTesting(false);
    }
  }, [directory]);

  // Validation
  const isNameValid = name.trim().length > 0;
  const isDirectoryValid = directory.trim().length > 0;
  const selectedServerHasStoredCredential = automaticServerId
    ? getStoredSshServerCredential(automaticServerId) !== null
    : false;
  const {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  } = useDevboxTemplates({
    serverId: automaticServerId,
    password: automaticPassword,
  });
  useEffect(() => {
    if (!automaticCreateNewRepository || automaticDevboxTemplate || templatesLoading) {
      return;
    }
    const firstTemplate = templates[0]?.name;
    if (firstTemplate) {
      autoSelectedDevboxTemplateRef.current = firstTemplate;
      setAutomaticDevboxTemplate(firstTemplate);
    }
  }, [automaticCreateNewRepository, automaticDevboxTemplate, templates, templatesLoading]);
  const isAutomaticValid = isNameValid
    && automaticServerId.trim().length > 0
    && (automaticCreateNewRepository || automaticRepoUrl.trim().length > 0)
    && automaticBasePath.trim().length > 0
    && (!automaticCreateNewRepository || automaticDevboxTemplate.trim().length > 0);
  const isManualValid = isNameValid && isDirectoryValid && isServerSettingsValid;
  const isValid = mode === "automatic" ? isAutomaticValid : isManualValid;
  const provisioningStatus = provisioning.snapshot?.job.state.status;
  const canReturnToAutomaticForm = provisioningStatus === "failed" || provisioningStatus === "cancelled";

  function handleBackToAutomaticForm(): void {
    const saved = lastSubmittedFormValuesRef.current;
    const config = provisioning.snapshot?.job.config;
    // Prefer the active job's snapshot config as the primary source so that the
    // form always reflects the job that is actually being dismissed.  The ref is
    // only used as a fallback (e.g. when the snapshot hasn't arrived yet) and
    // only when its stored job id matches the current active job — otherwise the
    // ref may contain stale values from an earlier submission.
    const refMatchesActiveJob = saved?.jobId != null && saved.jobId === provisioning.activeJobId;
    const values = config ? {
      name: config.name,
      automaticServerId: config.sshServerId,
      automaticRepoUrl: config.repoUrl ?? "",
      automaticCreateNewRepository: config.createNewRepository ?? false,
      automaticBasePath: config.basePath,
      automaticDevcontainerSubpath: config.devcontainerSubpath ?? "",
      automaticDevboxTemplate: config.devboxTemplate ?? "",
      automaticProvider: config.provider,
    } : (refMatchesActiveJob ? saved : null);

    if (values) {
      setMode("automatic");
      setName(values.name);
      setAutomaticServerId(values.automaticServerId);
      setAutomaticRepoUrl(values.automaticRepoUrl);
      setAutomaticCreateNewRepository(values.automaticCreateNewRepository);
      setAutomaticBasePath(values.automaticBasePath);
      setAutomaticDevcontainerSubpath(values.automaticDevcontainerSubpath);
      setAutomaticDevboxTemplate(values.automaticDevboxTemplate);
      setAutomaticAdvancedOpen(Boolean(values.automaticDevboxTemplate || values.automaticDevcontainerSubpath));
      setAutomaticProvider(values.automaticProvider);
      setAutomaticPassword("");
    }

    provisioning.clearActiveJob();
  }

  function handleClose(): void {
    const shouldClearProvisioning = provisioning.activeJobId
      && provisioningStatus
      && provisioningStatus !== "running"
      && provisioningStatus !== "pending";
    if (shouldClearProvisioning) {
      provisioning.clearActiveJob();
    }
    onClose();
  }

  const footer = (
    <ModalFooter
      hasActiveProvisioningJob={hasActiveProvisioningJob}
      provisioningStatus={provisioningStatus}
      canReturnToAutomaticForm={canReturnToAutomaticForm}
      creating={creating}
      provisioningStarting={provisioning.starting}
      mode={mode}
      isValid={isValid}
      onClose={handleClose}
      onBack={handleBackToAutomaticForm}
      onCancelJob={() => { void provisioning.cancelJob(); }}
    />
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create Workspace"
      description="Create a new workspace manually with server connection settings or provision one automatically over SSH."
      size="md"
      footer={footer}
    >
      {hasActiveProvisioningJob ? (
        <ProvisioningJobView
          snapshot={provisioning.snapshot}
          logs={provisioning.logs}
          websocketStatus={provisioning.websocketStatus}
          loading={provisioning.loading}
          error={provisioning.error}
        />
      ) : (
        <form id="create-workspace-form" onSubmit={handleSubmit} className="space-y-6">
          <ModeTabs mode={mode} onChange={setMode} />

          <WorkspaceNameField value={name} onChange={setName} />

          {mode === "manual" ? (
            <ManualWorkspaceForm
              directory={directory}
              onDirectoryChange={setDirectory}
              defaultServerSettings={defaultServerSettings}
              onServerSettingsChange={handleServerSettingsChange}
              onTestConnection={handleTestConnection}
              testing={testing}
              remoteOnly={remoteOnly}
              registeredSshServers={registeredSshServers}
            />
          ) : (
            <AutomaticWorkspaceForm
              serverId={automaticServerId}
              onServerIdChange={(serverId) => {
                setAutomaticServerId(serverId);
                setAutomaticDevboxTemplate("");
                const selectedServer = registeredSshServers.find((server) => server.config.id === serverId);
                if (selectedServer?.config.repositoriesBasePath) {
                  setAutomaticBasePath(selectedServer.config.repositoriesBasePath);
                }
              }}
              repoUrl={automaticRepoUrl}
              onRepoUrlChange={setAutomaticRepoUrl}
              createNewRepository={automaticCreateNewRepository}
              onCreateNewRepositoryChange={(createNewRepository) => {
                setAutomaticCreateNewRepository(createNewRepository);
                if (
                  !createNewRepository
                  && autoSelectedDevboxTemplateRef.current
                  && automaticDevboxTemplate === autoSelectedDevboxTemplateRef.current
                ) {
                  setAutomaticDevboxTemplate("");
                }
                autoSelectedDevboxTemplateRef.current = null;
              }}
              basePath={automaticBasePath}
              onBasePathChange={setAutomaticBasePath}
              devcontainerSubpath={automaticDevcontainerSubpath}
              onDevcontainerSubpathChange={setAutomaticDevcontainerSubpath}
              devboxTemplate={automaticDevboxTemplate}
              onDevboxTemplateChange={(template) => {
                autoSelectedDevboxTemplateRef.current = null;
                setAutomaticDevboxTemplate(template);
              }}
              provider={automaticProvider}
              onProviderChange={setAutomaticProvider}
              password={automaticPassword}
              onPasswordChange={setAutomaticPassword}
              registeredSshServers={registeredSshServers}
              selectedServerHasStoredCredential={selectedServerHasStoredCredential}
              templates={templates}
              templatesLoading={templatesLoading}
              templatesError={templatesError}
              onRetryTemplates={() => { void refreshTemplates(automaticPassword); }}
              advancedOpen={automaticAdvancedOpen}
              onAdvancedOpenChange={setAutomaticAdvancedOpen}
            />
          )}

          <FormError error={mode === "manual" ? error : provisioning.error} />
        </form>
      )}
    </Modal>
  );
}

export default CreateWorkspaceModal;
