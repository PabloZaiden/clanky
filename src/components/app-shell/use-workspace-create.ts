import { type FormEvent, useEffect, useRef, useState } from "react";
import { createLogger, type ToastService, type WebAppRoute } from "@pablozaiden/webapp/web";
import {
  getRegisteredSshServerId,
  type ExecutionHostRef,
  type Workspace,
  type WorkspaceType,
} from "@/shared";
import {
  DEFAULT_EXECUTION_AGENT_PROVIDER,
  getCreateWorkspaceDefaultServerSettings,
} from "@/shared/settings";
import type { AgentProvider, ServerSettings } from "@/shared/settings";
import type {
  CreateWorkspaceRequest,
  WorkspaceSshTargetRequest,
} from "@/contracts/schemas/workspace";
import type { SshServer } from "@/shared/ssh-server";
import type { ProvisioningTransport } from "@/shared/provisioning";
import { apiRequest } from "../../lib/api-client";
import {
  getAutomaticWorkspaceBasePath,
  getDefaultAutomaticWorkspaceServer,
} from "../../lib/automatic-workspace-preferences";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getRouteString } from "./route-fields";
import { createRefreshCoordinator } from "../../lib/refresh-coordinator";
import { isAbortError } from "../../lib/request-lifecycle";

const log = createLogger("useWorkspaceCreate");

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
  workspaceSshTarget: WorkspaceSshTargetRequest | null;
  setWorkspaceSshTarget: (target: WorkspaceSshTargetRequest | null) => void;
  workspaceWorkerEnrollment: WorkspaceWorkerEnrollmentState | null;
  workspaceWorkerEnrollmentSelected: boolean;
  setWorkspaceWorkerEnrollmentSelected: (selected: boolean) => void;
  workspaceWorkerEnrollmentLoading: boolean;
  startWorkspaceWorkerEnrollment: () => Promise<void>;
  cancelWorkspaceWorkerEnrollment: () => Promise<void>;
  setWorkspaceServerSettings: (settings: ServerSettings | ((current: ServerSettings) => ServerSettings)) => void;
  workspaceServerSettingsValid: boolean;
  setWorkspaceServerSettingsValid: (valid: boolean) => void;
  workspaceTesting: boolean;
  workspaceCreateSubmitting: boolean;
  automaticExecutionHost: ExecutionHostRef | null;
  setAutomaticExecutionHost: (host: ExecutionHostRef | null) => void;
  automaticTransport: ProvisioningTransport;
  setAutomaticTransport: (transport: ProvisioningTransport) => void;
  automaticWorkerHostAddress: string;
  setAutomaticWorkerHostAddress: (address: string) => void;
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
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
  ) => Promise<{ success: boolean; error?: string }>;
  handleBackToAutomaticWorkspaceForm: () => void;
}

export interface WorkspaceWorkerEnrollmentState {
  enrollment: {
    id: string;
    name: string;
    status: string;
    workerNodeId: string | null;
    workspaceId: string | null;
  };
  worker: {
    workerNodeId: string;
    workerInstanceName: string | null;
    workerEndpoint: string;
  } | null;
  token?: string;
  workerJoinCommand?: string;
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
  const [workspaceSshTarget, setWorkspaceSshTarget] = useState<WorkspaceSshTargetRequest | null>(null);
  const [workspaceWorkerEnrollment, setWorkspaceWorkerEnrollment] =
    useState<WorkspaceWorkerEnrollmentState | null>(null);
  const [workspaceWorkerEnrollmentSelected, setWorkspaceWorkerEnrollmentSelected] = useState(false);
  const [workspaceWorkerEnrollmentLoading, setWorkspaceWorkerEnrollmentLoading] = useState(false);
  const [workspaceServerSettingsValid, setWorkspaceServerSettingsValid] = useState(true);
  const [workspaceTesting, setWorkspaceTesting] = useState(false);
  const [workspaceCreateSubmitting, setWorkspaceCreateSubmitting] = useState(false);
  const [automaticExecutionHost, setAutomaticExecutionHost] = useState<ExecutionHostRef | null>(null);
  const [automaticTransport, setAutomaticTransport] = useState<ProvisioningTransport>("worker");
  const [automaticWorkerHostAddress, setAutomaticWorkerHostAddress] = useState("");
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
  const enrollmentRefreshControllerRef = useRef<AbortController | null>(null);
  const enrollmentRefreshCoordinatorRef = useRef(
    createRefreshCoordinator<WorkspaceWorkerEnrollmentState>(),
  );

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
        setWorkspaceCreateMode("automatic");
        setWorkspaceName(config.name);
        setWorkspaceWorkerEnrollment(null);
        setWorkspaceWorkerEnrollmentSelected(false);
        setAutomaticExecutionHost(
          config.workspaceWorkerEnrollmentId
            ? null
            : config.executionHostBinding.host,
        );
        setAutomaticTransport(config.transport ?? "ssh");
        setAutomaticWorkerHostAddress(config.workerHostAddress ?? "");
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
        if (config.workspaceWorkerEnrollmentId) {
          void (async () => {
            try {
              const status = await apiRequest<WorkspaceWorkerEnrollmentState>(
                `/api/workspace-worker-enrollments/${encodeURIComponent(config.workspaceWorkerEnrollmentId!)}`,
                { action: "Restore dedicated worker enrollment" },
              );
              if (status.enrollment.status === "connected") {
                setWorkspaceWorkerEnrollment(status);
                setWorkspaceWorkerEnrollmentSelected(true);
                return;
              }
              toast.error(
                "The dedicated worker enrollment is no longer available. Enroll the worker again before retrying.",
              );
            } catch (error) {
              toast.error(`Failed to restore the dedicated worker enrollment: ${String(error)}`);
            }
          })();
        }
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
    setWorkspaceSshTarget(null);
    setWorkspaceWorkerEnrollment(null);
    setWorkspaceWorkerEnrollmentSelected(false);
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
          ? requestedExecutionHostKind === "local"
            ? { kind: "local", nodeId: requestedExecutionHostId }
            : { kind: "mesh", nodeId: requestedExecutionHostId }
          : null
      : null;
    const defaultExecutionHost: ExecutionHostRef | null = defaultAutomaticServer
      ? { kind: "ssh", serverId: defaultAutomaticServer.config.id }
      : null;
    setAutomaticExecutionHost(requestedExecutionHost ?? defaultExecutionHost);
    setAutomaticTransport("worker");
    setAutomaticWorkerHostAddress("");
    setAutomaticRepoUrl("");
    setAutomaticCreateNewRepository(false);
    setAutomaticBasePath(
      getRouteString(route, "basePath")
        ?? getAutomaticWorkspaceBasePath(
          requestedExecutionHost
            ? servers.find((server) => server.config.id === getRegisteredSshServerId(requestedExecutionHost)) ?? null
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
    const enrollmentId = workspaceWorkerEnrollment?.enrollment.id;
    if (!enrollmentId) {
      return;
    }
    let disposed = false;
    const refresh = () => enrollmentRefreshCoordinatorRef.current.run(async () => {
      const controller = new AbortController();
      enrollmentRefreshControllerRef.current = controller;
      try {
        const status = await apiRequest<WorkspaceWorkerEnrollmentState>(
          `/api/workspace-worker-enrollments/${encodeURIComponent(enrollmentId)}`,
          {
            signal: controller.signal,
            action: "Refresh dedicated worker enrollment",
          },
        );
        if (!disposed && !controller.signal.aborted) {
          setWorkspaceWorkerEnrollment((current) => ({
            ...status,
            workerJoinCommand: current?.workerJoinCommand,
          }));
        }
        return status;
      } finally {
        if (enrollmentRefreshControllerRef.current === controller) {
          enrollmentRefreshControllerRef.current = null;
        }
      }
    });
    const timer = setInterval(() => {
      void refresh().catch((error) => {
        if (!isAbortError(error)) {
          log.debug("Keeping the last known dedicated worker enrollment state after refresh failure", {
            error: String(error),
          });
        }
      });
    }, 1500);
    return () => {
      disposed = true;
      enrollmentRefreshControllerRef.current?.abort();
      enrollmentRefreshControllerRef.current = null;
      enrollmentRefreshCoordinatorRef.current.reset();
      clearInterval(timer);
    };
  }, [workspaceWorkerEnrollment?.enrollment.id]);

  useEffect(() => {
    if (
      route.view !== "compose"
      || getRouteString(route, "kind") !== "workspace"
      || workspaceWorkerEnrollmentSelected
      || automaticExecutionHost
      || servers.length === 0
    ) {
      return;
    }
    const defaultAutomaticServer = getDefaultAutomaticWorkspaceServer(servers);
    setAutomaticExecutionHost(defaultAutomaticServer
      ? { kind: "ssh", serverId: defaultAutomaticServer.config.id }
      : null);
    setAutomaticTransport("worker");
    setAutomaticWorkerHostAddress("");
    setAutomaticBasePath(getAutomaticWorkspaceBasePath(defaultAutomaticServer));
  }, [automaticExecutionHost, route, servers, workspaceWorkerEnrollmentSelected]);

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
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
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
        body: JSON.stringify({
          settings,
          directory: trimmedDirectory,
          ...(executionHost ? { executionHost } : {}),
          ...(sshTarget ? { sshTarget } : {}),
          ...(workspaceWorkerEnrollmentSelected && workspaceWorkerEnrollment
            ? { workspaceWorkerEnrollmentId: workspaceWorkerEnrollment.enrollment.id }
            : {}),
        }),
        action: "Test server connection",
        fallbackMessage: "Failed to test server connection",
      });
    } catch (error) {
      return { success: false, error: String(error) };
    } finally {
      setWorkspaceTesting(false);
    }
  }

  async function startWorkspaceWorkerEnrollment(): Promise<void> {
    setWorkspaceWorkerEnrollmentLoading(true);
    try {
      const created = await apiRequest<{
        enrollment: WorkspaceWorkerEnrollmentState["enrollment"];
        token: string;
        workerJoinCommand: string;
      }>("/api/workspace-worker-enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workspaceName.trim() || "Workspace worker" }),
        action: "Create dedicated worker enrollment",
        fallbackMessage: "Failed to create dedicated worker enrollment",
      });
      setWorkspaceExecutionHost(null);
      setWorkspaceSshTarget(null);
      setAutomaticExecutionHost(null);
      setAutomaticTransport("ssh");
      setAutomaticWorkerHostAddress("");
      setWorkspaceWorkerEnrollmentSelected(true);
      setWorkspaceWorkerEnrollment({ ...created, worker: null });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setWorkspaceWorkerEnrollmentLoading(false);
    }
  }

  async function cancelWorkspaceWorkerEnrollment(): Promise<void> {
    const enrollmentId = workspaceWorkerEnrollment?.enrollment.id;
    if (!enrollmentId) {
      setWorkspaceWorkerEnrollmentSelected(false);
      return;
    }
    try {
      await apiRequest(`/api/workspace-worker-enrollments/${encodeURIComponent(enrollmentId)}`, {
        method: "DELETE",
        action: "Cancel dedicated worker enrollment",
        fallbackMessage: "Failed to cancel dedicated worker enrollment",
      });
      setWorkspaceWorkerEnrollment(null);
      setWorkspaceWorkerEnrollmentSelected(false);
    } catch (error) {
      toast.error(String(error));
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
    setWorkspaceWorkerEnrollment(null);
    setWorkspaceWorkerEnrollmentSelected(Boolean(config.workspaceWorkerEnrollmentId));
    setAutomaticExecutionHost(
      config.workspaceWorkerEnrollmentId
        ? null
        : config.executionHostBinding.host,
    );
    setAutomaticTransport(config.transport ?? "ssh");
    setAutomaticWorkerHostAddress(config.workerHostAddress ?? "");
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
        if (
          (!automaticExecutionHost
            && !(workspaceWorkerEnrollmentSelected && workspaceWorkerEnrollment))
          || !automaticBasePath.trim()
        ) {
          toast.error("An execution host or connected dedicated worker and base path are required.");
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
          ...(automaticExecutionHost ? { executionHost: automaticExecutionHost } : {}),
          ...(workspaceWorkerEnrollmentSelected && workspaceWorkerEnrollment
            ? { workspaceWorkerEnrollmentId: workspaceWorkerEnrollment.enrollment.id }
            : {}),
          transport: workspaceWorkerEnrollmentSelected ? "ssh" : automaticTransport,
          ...(automaticTransport === "worker" && !workspaceWorkerEnrollmentSelected
            ? { workerHostAddress: automaticWorkerHostAddress }
            : {}),
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
      if (
        !directory
        || !workspaceServerSettingsValid
        || (!workspaceExecutionHost
          && !workspaceSshTarget
          && !(workspaceWorkerEnrollmentSelected && workspaceWorkerEnrollment))
      ) {
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
          ...(workspaceExecutionHost ? { executionHost: workspaceExecutionHost } : {}),
          ...(workspaceSshTarget ? { sshTarget: workspaceSshTarget } : {}),
          ...(workspaceWorkerEnrollmentSelected && workspaceWorkerEnrollment
            ? { workspaceWorkerEnrollmentId: workspaceWorkerEnrollment.enrollment.id }
            : {}),
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
    workspaceSshTarget,
    setWorkspaceSshTarget,
    workspaceWorkerEnrollment,
    workspaceWorkerEnrollmentSelected,
    setWorkspaceWorkerEnrollmentSelected,
    workspaceWorkerEnrollmentLoading,
    startWorkspaceWorkerEnrollment,
    cancelWorkspaceWorkerEnrollment,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticExecutionHost,
    setAutomaticExecutionHost,
    automaticTransport,
    setAutomaticTransport,
    automaticWorkerHostAddress,
    setAutomaticWorkerHostAddress,
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
