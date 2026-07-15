import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ToastService, WebAppRoute } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { getCreateWorkspaceDefaultServerSettings } from "@/shared/settings";
import type { AgentProvider, ServerSettings } from "@/shared/settings";
import type { CreateWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { SshServer } from "@/shared/ssh-server";
import { appFetch } from "../../lib/public-path";
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
  workspaceServerSettings: ServerSettings;
  setWorkspaceServerSettings: (settings: ServerSettings | ((current: ServerSettings) => ServerSettings)) => void;
  workspaceServerSettingsValid: boolean;
  setWorkspaceServerSettingsValid: (valid: boolean) => void;
  workspaceTesting: boolean;
  workspaceCreateSubmitting: boolean;
  automaticServerId: string;
  setAutomaticServerId: (id: string) => void;
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
  handleTestWorkspaceConnection: (settings: ServerSettings) => Promise<{ success: boolean; error?: string }>;
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
  const [workspaceServerSettings, setWorkspaceServerSettings] = useState<ServerSettings>(() =>
    getCreateWorkspaceDefaultServerSettings(),
  );
  const [workspaceServerSettingsValid, setWorkspaceServerSettingsValid] = useState(true);
  const [workspaceTesting, setWorkspaceTesting] = useState(false);
  const [workspaceCreateSubmitting, setWorkspaceCreateSubmitting] = useState(false);
  const [automaticServerId, setAutomaticServerId] = useState("");
  const [automaticRepoUrl, setAutomaticRepoUrl] = useState("");
  const [automaticCreateNewRepository, setAutomaticCreateNewRepository] = useState(false);
  const [automaticBasePath, setAutomaticBasePath] = useState("/workspaces");
  const [automaticDevcontainerSubpath, setAutomaticDevcontainerSubpath] = useState("");
  const [automaticDevboxTemplate, setAutomaticDevboxTemplate] = useState("");
  const [automaticGithubUser, setAutomaticGithubUser] = useState("");
  const [automaticAdvancedOpen, setAutomaticAdvancedOpen] = useState(false);
  const [automaticProvider, setAutomaticProvider] = useState<AgentProvider>("copilot");
  const [automaticPassword, setAutomaticPassword] = useState("");
  const lastProvisioningRefreshIdRef = useRef<string | null>(null);
  const wasOnComposeWorkspaceRef = useRef(false);

  useEffect(() => {
    const isOnComposeWorkspace = route.view === "compose" && getRouteString(route, "kind") === "workspace";
    const wasOnComposeWorkspace = wasOnComposeWorkspaceRef.current;
    wasOnComposeWorkspaceRef.current = isOnComposeWorkspace;

    if (!isOnComposeWorkspace) {
      return;
    }

    if (provisioning.activeJobId) {
      // Auto-clear terminal jobs only on initial entry to compose/workspace,
      // not while already viewing the provisioning result.
      const jobStatus = provisioning.snapshot?.job.state.status;
      const isTerminal = jobStatus === "completed" || jobStatus === "failed" || jobStatus === "cancelled";
      if (isTerminal && !wasOnComposeWorkspace) {
        provisioning.clearActiveJob();
        return;
      }
      setWorkspaceCreateMode("automatic");
      return;
    }

    setWorkspaceCreateMode("manual");
    setWorkspaceName("");
    setWorkspaceDirectory("");
    setWorkspaceServerSettings(getCreateWorkspaceDefaultServerSettings());
    setWorkspaceServerSettingsValid(true);
    setWorkspaceTesting(false);
    setWorkspaceCreateSubmitting(false);
    const defaultAutomaticServer = getDefaultAutomaticWorkspaceServer(servers);
    setAutomaticServerId(defaultAutomaticServer?.config.id ?? "");
    setAutomaticRepoUrl("");
    setAutomaticCreateNewRepository(false);
    setAutomaticBasePath(getAutomaticWorkspaceBasePath(defaultAutomaticServer));
    setAutomaticDevcontainerSubpath("");
    setAutomaticDevboxTemplate("");
    setAutomaticGithubUser("");
    setAutomaticAdvancedOpen(false);
    setAutomaticProvider("copilot");
    setAutomaticPassword("");
  }, [provisioning.activeJobId, provisioning.snapshot?.job.state.status, route, servers]);

  useEffect(() => {
    if (route.view !== "compose" || getRouteString(route, "kind") !== "workspace" || automaticServerId || servers.length === 0) {
      return;
    }
    const defaultAutomaticServer = getDefaultAutomaticWorkspaceServer(servers);
    setAutomaticServerId(defaultAutomaticServer?.config.id ?? "");
    setAutomaticBasePath(getAutomaticWorkspaceBasePath(defaultAutomaticServer));
  }, [automaticServerId, route, servers]);

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

  async function handleTestWorkspaceConnection(settings: ServerSettings) {
    const trimmedDirectory = workspaceDirectory.trim();
    if (!trimmedDirectory) {
      return { success: false, error: "Enter a workspace directory first." };
    }

    setWorkspaceTesting(true);
    try {
      const response = await appFetch("/api/server-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, directory: trimmedDirectory }),
      });
      return await response.json() as { success: boolean; error?: string };
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
    setAutomaticServerId(config.sshServerId);
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
        if (!automaticServerId.trim() || !automaticBasePath.trim()) {
          toast.error("Saved SSH server and remote base path are required.");
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
          sshServerId: automaticServerId,
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
          serverSettings: workspaceServerSettings,
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
    workspaceServerSettings,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticServerId,
    setAutomaticServerId,
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
