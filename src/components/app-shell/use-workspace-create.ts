import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ToastService, WebAppRoute } from "@pablozaiden/webapp/web";
import type { ExecutionHostRef, Workspace, WorkspaceType } from "@/shared";
import {
  DEFAULT_EXECUTION_AGENT_PROVIDER,
  getCreateWorkspaceDefaultServerSettings,
} from "@/shared/settings";
import type { AgentProvider, ServerSettings } from "@/shared/settings";
import type { CreateWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { SshServer } from "@/shared/ssh-server";
import { apiRequest } from "../../lib/api-client";
import {
  getAutomaticWorkspaceBasePath,
  getDefaultAutomaticWorkspaceServer,
} from "../../lib/automatic-workspace-preferences";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getRouteString } from "./route-fields";

export interface UseWorkspaceCreateResult {
  workspaceCreateMode: "manual" | "automatic";
  setWorkspaceCreateMode: (mode: "manual" | "automatic") => void;
  workspaceName: string;
  setWorkspaceName: (name: string) => void;
  workspaceDirectory: string;
  setWorkspaceDirectory: (dir: string) => void;
  workspaceType: WorkspaceType;
  setWorkspaceType: (workspaceType: WorkspaceType) => void;
  workspaceServerSettings: ServerSettings;
  workspaceExecutionHost: ExecutionHostRef | null;
  setWorkspaceExecutionHost: (host: ExecutionHostRef | null) => void;
  setWorkspaceServerSettings: (settings: ServerSettings | ((current: ServerSettings) => ServerSettings)) => void;
  workspaceServerSettingsValid: boolean;
  setWorkspaceServerSettingsValid: (valid: boolean) => void;
  workspaceTesting: boolean;
  workspaceCreateSubmitting: boolean;
  automaticExecutionHost: ExecutionHostRef | null;
  setAutomaticExecutionHost: (host: ExecutionHostRef | null) => void;
  automaticRepoUrl: string;
  setAutomaticRepoUrl: (url: string) => void;
  automaticCreateNewRepository: boolean;
  setAutomaticCreateNewRepository: (createNewRepository: boolean) => void;
  automaticBasePath: string;
  setAutomaticBasePath: (path: string) => void;
  automaticDevcontainerSubpath: string;
  setAutomaticDevcontainerSubpath: (subpath: string) => void;
  automaticDevboxTemplate: string;
  setAutomaticDevboxTemplate: (template: string) => void;
  automaticGithubUser: string;
  setAutomaticGithubUser: (githubUser: string) => void;
  automaticAdvancedOpen: boolean;
  setAutomaticAdvancedOpen: (open: boolean) => void;
  automaticProvider: AgentProvider;
  setAutomaticProvider: (provider: AgentProvider) => void;
  automaticPassword: string;
  setAutomaticPassword: (password: string) => void;
  handleCreateWorkspace: (event: FormEvent<HTMLFormElement>) => void;
  handleTestWorkspaceConnection: (
    settings: ServerSettings,
    executionHost: ExecutionHostRef,
  ) => Promise<{ success: boolean; error?: string }>;
  handleBackToAutomaticWorkspaceForm: () => void;
}

interface UseWorkspaceCreateOptions {
  route: WebAppRoute;
  servers: SshServer[];
  provisioning: UseProvisioningJobResult;
  createWorkspace: (req: CreateWorkspaceRequest) => Promise<Workspace | null>;
  refreshWorkspaces: () => Promise<void>;
  toast: ToastService;
  navigateWithinShell: (route: WebAppRoute) => void;
}

export function useWorkspaceCreate({
  route,
  servers,
  provisioning,
  createWorkspace,
  refreshWorkspaces,
  toast,
  navigateWithinShell,
}: UseWorkspaceCreateOptions): UseWorkspaceCreateResult {
  const [workspaceCreateMode, setWorkspaceCreateMode] = useState<"manual" | "automatic">("manual");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceDirectory, setWorkspaceDirectory] = useState("");
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>("git");
  const [workspaceServerSettings, setWorkspaceServerSettings] = useState<ServerSettings>(() =>
    getCreateWorkspaceDefaultServerSettings(),
  );
  const [workspaceExecutionHost, setWorkspaceExecutionHost] = useState<ExecutionHostRef | null>(null);
  const [workspaceServerSettingsValid, setWorkspaceServerSettingsValid] = useState(true);
  const [workspaceTesting, setWorkspaceTesting] = useState(false);
  const [workspaceCreateSubmitting, setWorkspaceCreateSubmitting] = useState(false);
  const [automaticExecutionHost, setAutomaticExecutionHost] = useState<ExecutionHostRef | null>(null);
  const [automaticRepoUrl, setAutomaticRepoUrl] = useState("");
  const [automaticCreateNewRepository, setAutomaticCreateNewRepository] = useState(false);
  const [automaticBasePath, setAutomaticBasePath] = useState("/workspaces");
  const [automaticDevcontainerSubpath, setAutomaticDevcontainerSubpath] = useState("");
  const [automaticDevboxTemplate, setAutomaticDevboxTemplate] = useState("");
  const [automaticGithubUser, setAutomaticGithubUser] = useState("");
  const [automaticAdvancedOpen, setAutomaticAdvancedOpen] = useState(false);
  const [automaticProvider, setAutomaticProvider] = useState<AgentProvider>(
    DEFAULT_EXECUTION_AGENT_PROVIDER,
  );
  const [automaticPassword, setAutomaticPassword] = useState("");
  const lastProvisioningRefreshIdRef = useRef<string | null>(null);
  const wasOnComposeWorkspaceRef = useRef(false);
  const prefilledRetryJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    const isOnComposeWorkspace = route.view === "compose" && getRouteString(route, "kind") === "workspace";
    const retryJobId = isOnComposeWorkspace
      ? getRouteString(route, "retryProvisioningJobId")
      : undefined;
    const requestedWorkspaceMode = getRouteString(route, "workspaceMode") === "automatic"
      ? "automatic"
      : "manual";
    const wasOnComposeWorkspace = wasOnComposeWorkspaceRef.current;
    wasOnComposeWorkspaceRef.current = isOnComposeWorkspace;

    if (!isOnComposeWorkspace) {
      prefilledRetryJobIdRef.current = null;
      return;
    }

    if (retryJobId && prefilledRetryJobIdRef.current !== retryJobId) {
      const retrySnapshot = provisioning.snapshot?.job.config.id === retryJobId
        ? provisioning.snapshot
        : null;
      if (!retrySnapshot) {
        provisioning.openJob(retryJobId);
        return;
      }
      const retryStatus = retrySnapshot.job.state.status;
      if (retryStatus === "failed" || retryStatus === "cancelled" || retryStatus === "interrupted") {
        const config = retrySnapshot.job.config;
        const executionHost = config.executionHostBinding.host;
        setWorkspaceCreateMode("automatic");
        setWorkspaceName(config.name);
        setAutomaticExecutionHost(executionHost);
        setAutomaticRepoUrl(config.repoUrl ?? "");
        setAutomaticCreateNewRepository(config.createNewRepository ?? false);
        setAutomaticBasePath(config.basePath);
        setAutomaticDevcontainerSubpath(config.devcontainerSubpath ?? "");
        setAutomaticDevboxTemplate(config.devboxTemplate ?? "");
        setAutomaticGithubUser(config.githubUser ?? "");
        setAutomaticAdvancedOpen(Boolean(config.devboxTemplate ?? config.devcontainerSubpath ?? config.githubUser));
        setAutomaticProvider(config.provider);
        setAutomaticPassword("");
        prefilledRetryJobIdRef.current = retryJobId;
        provisioning.clearActiveJob();
        return;
      }
    }

    if (wasOnComposeWorkspace) {
      return;
    }

    setWorkspaceCreateMode(requestedWorkspaceMode);
    setWorkspaceName("");
    setWorkspaceDirectory("");
    setWorkspaceType("git");
    setWorkspaceServerSettings(getCreateWorkspaceDefaultServerSettings());
    setWorkspaceExecutionHost(null);
    setWorkspaceServerSettingsValid(true);
    setWorkspaceTesting(false);
    setWorkspaceCreateSubmitting(false);
    const defaultAutomaticServer = getDefaultAutomaticWorkspaceServer(servers);
    const requestedExecutionHostKind = getRouteString(route, "executionHostKind");
    const requestedExecutionHostId = getRouteString(route, "executionHostId");
    const requestedExecutionHost: ExecutionHostRef | null = requestedExecutionHostId
      ? requestedExecutionHostKind === "ssh"
        ? { kind: "ssh", serverId: requestedExecutionHostId }
        : requestedExecutionHostKind === "local" || requestedExecutionHostKind === "mesh"
          ? { kind: requestedExecutionHostKind, nodeId: requestedExecutionHostId }
          : null
      : null;
    const defaultExecutionHost: ExecutionHostRef | null = defaultAutomaticServer
      ? { kind: "ssh", serverId: defaultAutomaticServer.config.id }
      : null;
    setAutomaticExecutionHost(requestedExecutionHost ?? defaultExecutionHost);
    setAutomaticRepoUrl("");
    setAutomaticCreateNewRepository(false);
    setAutomaticBasePath(
      getRouteString(route, "basePath")
        ?? getAutomaticWorkspaceBasePath(
          requestedExecutionHost?.kind === "ssh"
            ? servers.find((server) => server.config.id === requestedExecutionHost.serverId) ?? null
            : defaultAutomaticServer,
        ),
    );
    setAutomaticDevcontainerSubpath("");
    setAutomaticDevboxTemplate("");
    setAutomaticGithubUser("");
    setAutomaticAdvancedOpen(false);
    setAutomaticProvider(DEFAULT_EXECUTION_AGENT_PROVIDER);
    setAutomaticPassword("");
  }, [
    provisioning.clearActiveJob,
    provisioning.openJob,
    provisioning.snapshot,
    route,
    servers,
  ]);

  useEffect(() => {
    if (
      route.view !== "compose"
      || getRouteString(route, "kind") !== "workspace"
      || automaticExecutionHost
      || servers.length === 0
    ) {
      return;
    }
    const defaultAutomaticServer = getDefaultAutomaticWorkspaceServer(servers);
    setAutomaticExecutionHost(defaultAutomaticServer
      ? { kind: "ssh", serverId: defaultAutomaticServer.config.id }
      : null);
    setAutomaticBasePath(getAutomaticWorkspaceBasePath(defaultAutomaticServer));
  }, [automaticExecutionHost, route, servers]);

  useEffect(() => {
    const jobId = provisioning.snapshot?.job.config.id ?? null;
    if (
      provisioning.snapshot?.job.state.status === "completed"
      && jobId
      && lastProvisioningRefreshIdRef.current !== jobId
    ) {
      lastProvisioningRefreshIdRef.current = jobId;
      void refreshWorkspaces();
    }
  }, [provisioning.snapshot?.job.config.id, provisioning.snapshot?.job.state.status, refreshWorkspaces]);

  async function handleTestWorkspaceConnection(
    settings: ServerSettings,
    executionHost: ExecutionHostRef,
  ) {
    const trimmedDirectory = workspaceDirectory.trim();
    if (!trimmedDirectory) {
      return { success: false, error: "Enter a workspace directory first." };
    }

    setWorkspaceTesting(true);
    try {
      return await apiRequest<{ success: boolean; error?: string }>("/api/server-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, directory: trimmedDirectory, executionHost }),
        action: "Test server connection",
        fallbackMessage: "Failed to test server connection",
      });
    } catch (error) {
      return { success: false, error: String(error) };
    } finally {
      setWorkspaceTesting(false);
    }
  }

  function handleBackToAutomaticWorkspaceForm() {
    const config = provisioning.snapshot?.job.config;
    if (!config) {
      provisioning.clearActiveJob();
      return;
    }

    setWorkspaceCreateMode("automatic");
    setWorkspaceName(config.name);
    setAutomaticExecutionHost(config.executionHostBinding.host);
    setAutomaticRepoUrl(config.repoUrl ?? "");
    setAutomaticCreateNewRepository(config.createNewRepository ?? false);
    setAutomaticBasePath(config.basePath);
    setAutomaticDevcontainerSubpath(config.devcontainerSubpath ?? "");
    setAutomaticDevboxTemplate(config.devboxTemplate ?? "");
    setAutomaticGithubUser(config.githubUser ?? "");
    setAutomaticAdvancedOpen(Boolean(config.devboxTemplate ?? config.devcontainerSubpath ?? config.githubUser));
    setAutomaticProvider(config.provider);
    setAutomaticPassword("");
    provisioning.clearActiveJob();
  }

  function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void (async () => {
      const name = workspaceName.trim();
      if (!name) {
        toast.error("Workspace name is required.");
        return;
      }

      if (workspaceCreateMode === "automatic") {
        if (!automaticExecutionHost || !automaticBasePath.trim()) {
          toast.error("An execution host and base path are required.");
          return;
        }
        if (!automaticCreateNewRepository && !automaticRepoUrl.trim()) {
          toast.error("Repository URL is required.");
          return;
        }
        if (automaticCreateNewRepository && !automaticDevboxTemplate.trim()) {
          toast.error("Devbox template is required when the repository doesn't exist yet.");
          return;
        }
        const snapshot = await provisioning.startJob({
          name,
          executionHost: automaticExecutionHost,
          repoUrl: automaticCreateNewRepository ? "" : automaticRepoUrl.trim(),
          basePath: automaticBasePath.trim(),
          devcontainerSubpath: automaticDevboxTemplate.trim()
            ? null
            : automaticDevcontainerSubpath.trim() || null,
          devboxTemplate: automaticDevboxTemplate.trim() || null,
          githubUser: automaticGithubUser.trim() || null,
          provider: automaticProvider,
          createNewRepository: automaticCreateNewRepository,
          password: automaticPassword,
          mode: "provision",
          targetDirectory: null,
          workspaceId: null,
        });
        if (snapshot) {
          setWorkspaceCreateMode("automatic");
          setAutomaticPassword("");
          navigateWithinShell({
            view: "provisioning-job",
            provisioningJobId: snapshot.job.config.id,
            returnView: "home",
          });
        }
        return;
      }

      const directory = workspaceDirectory.trim();
      if (!directory || !workspaceServerSettingsValid) {
        toast.error("Directory and valid connection settings are required.");
        return;
      }

      setWorkspaceCreateSubmitting(true);
      try {
        const request: CreateWorkspaceRequest = {
          name,
          directory,
          workspaceType,
          serverSettings: workspaceServerSettings,
          executionHost: workspaceExecutionHost!,
        };
        const workspace = await createWorkspace(request);
        if (!workspace) {
          toast.error("Failed to create workspace");
          return;
        }
        navigateWithinShell({ view: "workspace", workspaceId: workspace.id });
      } finally {
        setWorkspaceCreateSubmitting(false);
      }
    })();
  }

  return {
    workspaceCreateMode,
    setWorkspaceCreateMode,
    workspaceName,
    setWorkspaceName,
    workspaceDirectory,
    setWorkspaceDirectory,
    workspaceType,
    setWorkspaceType,
    workspaceServerSettings,
    workspaceExecutionHost,
    setWorkspaceExecutionHost,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticExecutionHost,
    setAutomaticExecutionHost,
    automaticRepoUrl,
    setAutomaticRepoUrl,
    automaticCreateNewRepository,
    setAutomaticCreateNewRepository,
    automaticBasePath,
    setAutomaticBasePath,
    automaticDevcontainerSubpath,
    setAutomaticDevcontainerSubpath,
    automaticDevboxTemplate,
    setAutomaticDevboxTemplate,
    automaticGithubUser,
    setAutomaticGithubUser,
    automaticAdvancedOpen,
    setAutomaticAdvancedOpen,
    automaticProvider,
    setAutomaticProvider,
    automaticPassword,
    setAutomaticPassword,
    handleCreateWorkspace,
    handleTestWorkspaceConnection,
    handleBackToAutomaticWorkspaceForm,
  };
}
