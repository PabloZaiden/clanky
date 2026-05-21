import { z } from "zod";
import { apiRoutes } from "../api";
import {
  AddressCommentsRequestSchema,
  CheckSshServerPrerequisitesRequestSchema,
  CompletePasskeyAuthenticationRequestSchema,
  CompletePasskeyRegistrationRequestSchema,
  CreateChatRequestSchema,
  CreateLoopRequestSchema,
  CreatePortForwardRequestSchema,
  CreateProvisioningJobRequestSchema,
  CreateSshServerRequestSchema,
  CreateSshServerSessionRequestSchema,
  CreateSshSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  DeleteSshServerSessionRequestSchema,
  DeviceStartRequestSchema,
  DeviceVerificationActionSchema,
  FollowUpRequestSchema,
  GenerateLoopTitleRequestSchema,
  GetWorkspaceFileRequestSchema,
  GetWorkspaceFileTreeRequestSchema,
  InterruptChatRequestSchema,
  IssuerSettingsSchema,
  ListWorkspaceFilesRequestSchema,
  PendingPromptRequestSchema,
  PlanAcceptRequestSchema,
  PlanFeedbackRequestSchema,
  PublicRevokeRequestSchema,
  RefreshEndpointRequestSchema,
  ReplyToChatPermissionRequestSchema,
  SendChatMessageRequestSchema,
  ServerSettingsSchema,
  SetDashboardViewModeRequestSchema,
  SetFileExplorerFullTreeRequestSchema,
  SetLastCheapModelRequestSchema,
  SetLastDirectoryRequestSchema,
  SetLastModelRequestSchema,
  SetLogLevelRequestSchema,
  SetMarkdownRenderingRequestSchema,
  SetQuickChatSettingsRequestSchema,
  SetThemePreferenceRequestSchema,
  SetPendingRequestSchema,
  SshCredentialExchangeRequestSchema,
  StartDraftRequestSchema,
  TestConnectionRequestSchema,
  TokenRequestSchema,
  UpdateChatRequestSchema,
  UpdateLoopRequestSchema,
  UpdateSshServerRequestSchema,
  UpdateSshSessionRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceImportRequestSchema,
  WriteWorkspaceFileRequestSchema,
} from "../types/schemas";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

type RouteHandler = ((...args: never[]) => unknown) | Record<string, unknown>;

export interface ApiEndpointCatalogEntry {
  path: string;
  cliPath?: string;
  methods: HttpMethod[];
  description?: string;
  requestSchema?: z.ZodTypeAny;
  querySchema?: z.ZodTypeAny;
}

type ApiEndpointOverride = Pick<ApiEndpointCatalogEntry, "description" | "requestSchema" | "querySchema">;

const SensitiveQuerySchema = z.object({
  sensitive: z.enum(["true", "false"]).optional(),
});

const endpointOverrides: Record<string, ApiEndpointOverride> = {
  "/api/health": {
    description: "Server health check.",
  },
  "/api/config": {
    description: "Server configuration and runtime settings.",
  },
  "/api/auth/device": {
    description: "Start a device authorization flow for CLI login.",
    requestSchema: DeviceStartRequestSchema,
  },
  "/api/auth/device/verification": {
    description: "Inspect a pending device authorization request.",
    querySchema: z.object({
      user_code: z.string().trim().min(1),
    }),
  },
  "/api/auth/device/approve": {
    description: "Approve a pending device authorization request.",
    requestSchema: DeviceVerificationActionSchema,
  },
  "/api/auth/device/deny": {
    description: "Deny a pending device authorization request.",
    requestSchema: DeviceVerificationActionSchema,
  },
  "/api/auth/token": {
    description: "Exchange a device code or refresh token for bearer tokens.",
    requestSchema: TokenRequestSchema,
  },
  "/api/auth/refresh": {
    description: "Exchange a refresh token for a new bearer token set.",
    requestSchema: RefreshEndpointRequestSchema,
  },
  "/api/auth/revoke": {
    description: "Revoke a stored refresh token or session.",
    requestSchema: PublicRevokeRequestSchema,
  },
  "/api/auth/status": {
    description: "Validate the current bearer token and return auth details.",
  },
  "/api/auth/sessions": {
    description: "List active authentication sessions.",
  },
  "/api/auth/sessions/:id": {
    description: "Revoke an authentication session.",
  },
  "/api/auth/issuer": {
    description: "Read or update the token issuer settings.",
    requestSchema: IssuerSettingsSchema,
  },
  "/api/passkey-auth/status": {
    description: "Read the current passkey authentication status.",
  },
  "/api/passkey-auth/registration/options": {
    description: "Start passkey registration and return browser options.",
  },
  "/api/passkey-auth/registration/verify": {
    description: "Complete passkey registration.",
    requestSchema: CompletePasskeyRegistrationRequestSchema,
  },
  "/api/passkey-auth/authentication/options": {
    description: "Start passkey authentication and return browser options.",
  },
  "/api/passkey-auth/authentication/verify": {
    description: "Complete passkey authentication.",
    requestSchema: CompletePasskeyAuthenticationRequestSchema,
  },
  "/api/passkey-auth/logout": {
    description: "End the current passkey-backed browser session.",
  },
  "/api/passkey-auth/passkey": {
    description: "Delete configured passkeys for the current account.",
  },
  "/api/loops": {
    description: "List loops or create a new loop.",
    requestSchema: CreateLoopRequestSchema,
  },
  "/api/loops/title": {
    description: "Generate a loop title from a prompt.",
    requestSchema: GenerateLoopTitleRequestSchema,
  },
  "/api/loops/:id": {
    description: "Read, update, or delete a loop.",
    requestSchema: UpdateLoopRequestSchema,
  },
  "/api/loops/:id/accept": {
    description: "Accept a completed loop locally without pushing.",
  },
  "/api/loops/:id/close-local": {
    description: "Close a locally accepted loop without PR actions.",
  },
  "/api/loops/:id/push": {
    description: "Push a completed loop branch to the remote repository.",
  },
  "/api/loops/:id/update-branch": {
    description: "Sync a pushed loop branch with its base branch.",
  },
  "/api/loops/:id/mark-merged": {
    description: "Mark a loop as merged after an external merge.",
  },
  "/api/loops/:id/manual-complete": {
    description: "Promote a stopped or failed loop to completed.",
  },
  "/api/loops/:id/plan/feedback": {
    description: "Submit feedback on a generated loop plan.",
    requestSchema: PlanFeedbackRequestSchema,
  },
  "/api/loops/:id/plan": {
    description: "Read a loop's planning document.",
  },
  "/api/loops/:id/plan/accept": {
    description: "Accept a generated loop plan.",
    requestSchema: PlanAcceptRequestSchema,
  },
  "/api/loops/:id/plan/discard": {
    description: "Discard a generated loop plan and delete the loop.",
  },
  "/api/loops/:id/address-comments": {
    description: "Address review comments for a loop.",
    requestSchema: AddressCommentsRequestSchema,
  },
  "/api/loops/:id/review-history": {
    description: "Read review history for a loop.",
  },
  "/api/loops/:id/automatic-pr-flow/start": {
    description: "Enable automatic pull request monitoring for a loop.",
  },
  "/api/loops/:id/automatic-pr-flow/stop": {
    description: "Disable automatic pull request monitoring for a loop.",
  },
  "/api/loops/:id/pull-request/auto-merge": {
    description: "Enable pull request auto-merge for a loop.",
  },
  "/api/loops/:id/pending-prompt": {
    description: "Set the pending prompt used for the next loop iteration.",
    requestSchema: PendingPromptRequestSchema,
  },
  "/api/loops/:id/pending": {
    description: "Apply a pending message or model override for the next loop iteration.",
    requestSchema: SetPendingRequestSchema,
  },
  "/api/loops/:id/follow-up": {
    description: "Send a follow-up message to a loop.",
    requestSchema: FollowUpRequestSchema,
  },
  "/api/loops/:id/draft/start": {
    description: "Start draft generation for a loop.",
    requestSchema: StartDraftRequestSchema,
  },
  "/api/loops/:id/chat": {
    description: "Read or create the chat session attached to a loop.",
  },
  "/api/loops/:id/comments": {
    description: "List review comments for a loop.",
  },
  "/api/loops/:id/diff": {
    description: "Read the git diff produced by a loop.",
  },
  "/api/loops/:id/discard": {
    description: "Discard a loop and remove its working branch.",
  },
  "/api/loops/:id/port-forwards": {
    description: "Create or list loop port forwards.",
    requestSchema: CreatePortForwardRequestSchema,
  },
  "/api/loops/:id/port-forwards/:forwardId": {
    description: "Delete a loop port forward.",
  },
  "/api/loops/:id/pull-request": {
    description: "Read pull request navigation details for a loop.",
  },
  "/api/loops/:id/purge": {
    description: "Permanently delete a loop from storage.",
  },
  "/api/loops/:id/ssh-session": {
    description: "Read or create a loop-backed SSH session.",
  },
  "/api/loops/:id/status-file": {
    description: "Read a loop's status tracking document.",
  },
  "/api/loops/:id/stop": {
    description: "Stop an active loop run.",
  },
  "/api/chats": {
    description: "List chats or create a chat session.",
    requestSchema: CreateChatRequestSchema,
  },
  "/api/chats/:id": {
    description: "Read, update, or delete a chat session.",
    requestSchema: UpdateChatRequestSchema,
  },
  "/api/chats/:id/messages": {
    description: "Send a message to a chat session.",
    requestSchema: SendChatMessageRequestSchema,
  },
  "/api/chats/:id/interrupt": {
    description: "Interrupt an active chat run.",
    requestSchema: InterruptChatRequestSchema,
  },
  "/api/chats/:id/permissions/:requestId": {
    description: "Approve or deny a pending chat permission request.",
    requestSchema: ReplyToChatPermissionRequestSchema,
  },
  "/api/chats/:id/reconnect": {
    description: "Reconnect a chat session to its backend runtime.",
  },
  "/api/chats/:id/spawn-loop": {
    description: "Create a loop from an existing chat transcript.",
  },
  "/api/chats/:id/spawn-loop-from-current-plan": {
    description: "Create a loop from the current plan discussed in a chat.",
  },
  "/api/check-planning-dir": {
    description: "Inspect a directory for .ralph-planning files.",
  },
  "/api/git/branches": {
    description: "List local git branches for a workspace directory.",
  },
  "/api/git/default-branch": {
    description: "Detect the default git branch for a workspace directory.",
  },
  "/api/git/github-repository-url": {
    description: "Resolve the GitHub repository URL for a workspace directory.",
  },
  "/api/models": {
    description: "List available AI models for a workspace directory.",
  },
  "/api/workspaces": {
    description: "List workspaces or create a workspace.",
    requestSchema: CreateWorkspaceRequestSchema,
    querySchema: SensitiveQuerySchema,
  },
  "/api/workspaces/:id": {
    description: "Read, update, or delete a workspace.",
    requestSchema: UpdateWorkspaceRequestSchema,
    querySchema: SensitiveQuerySchema,
  },
  "/api/workspaces/import": {
    description: "Import workspaces from an export bundle.",
    requestSchema: WorkspaceImportRequestSchema,
  },
  "/api/workspaces/export": {
    description: "Export workspace configuration data.",
    querySchema: SensitiveQuerySchema,
  },
  "/api/workspaces/:id/agents-md": {
    description: "Read the AGENTS.md file and optimization status for a workspace.",
  },
  "/api/workspaces/:id/agents-md/preview": {
    description: "Preview AGENTS.md optimization changes for a workspace.",
  },
  "/api/workspaces/:id/agents-md/optimize": {
    description: "Apply AGENTS.md optimization changes to a workspace.",
  },
  "/api/workspaces/:id/archived-loops/purge": {
    description: "Purge archived loops for a workspace.",
  },
  "/api/workspaces/:id/pull-latest-changes": {
    description: "Pull the latest changes for a workspace's default branch.",
  },
  "/api/workspaces/:id/server-settings": {
    description: "Read or update workspace server settings.",
    requestSchema: ServerSettingsSchema,
    querySchema: SensitiveQuerySchema,
  },
  "/api/workspaces/:id/server-settings/status": {
    description: "Read the current workspace connection status.",
  },
  "/api/workspaces/:id/server-settings/test": {
    description: "Test the configured workspace connection using workspace settings.",
    requestSchema: TestConnectionRequestSchema,
  },
  "/api/server-settings/test": {
    description: "Test a server connection without creating a workspace.",
    requestSchema: TestConnectionRequestSchema,
  },
  "/api/workspaces/:id/files": {
    description: "List workspace files in the active explorer root.",
    querySchema: ListWorkspaceFilesRequestSchema,
  },
  "/api/workspaces/:id/files/content": {
    description: "Read a workspace file.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/workspaces/:id/files/preview": {
    description: "Preview a browser-renderable workspace image file.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/workspaces/:id/files/download": {
    description: "Download a workspace file from the active explorer root.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/workspaces/:id/files/tree": {
    description: "Load the full workspace file tree.",
    querySchema: GetWorkspaceFileTreeRequestSchema,
  },
  "/api/workspaces/:id/files/metadata": {
    description: "Read workspace file metadata.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/workspaces/:id/files/write": {
    description: "Write a workspace file with optional conflict checks.",
    requestSchema: WriteWorkspaceFileRequestSchema,
  },
  "/api/preferences/last-model": {
    description: "Persist the user's most recently used model.",
    requestSchema: SetLastModelRequestSchema,
  },
  "/api/preferences/last-cheap-model": {
    description: "Persist the user's most recently used cheap model.",
    requestSchema: SetLastCheapModelRequestSchema,
  },
  "/api/preferences/last-directory": {
    description: "Persist the user's last selected directory.",
    requestSchema: SetLastDirectoryRequestSchema,
  },
  "/api/preferences/markdown-rendering": {
    description: "Persist markdown rendering preferences.",
    requestSchema: SetMarkdownRenderingRequestSchema,
  },
  "/api/preferences/file-explorer-full-tree": {
    description: "Persist file explorer tree loading preferences.",
    requestSchema: SetFileExplorerFullTreeRequestSchema,
  },
  "/api/preferences/log-level": {
    description: "Persist the preferred application log level.",
    requestSchema: SetLogLevelRequestSchema,
  },
  "/api/preferences/dashboard-view-mode": {
    description: "Persist the preferred dashboard layout.",
    requestSchema: SetDashboardViewModeRequestSchema,
  },
  "/api/preferences/theme": {
    description: "Persist the preferred application theme.",
    requestSchema: SetThemePreferenceRequestSchema,
  },
  "/api/preferences/quick-chat": {
    description: "Persist quick chat workspace and model preferences.",
    requestSchema: SetQuickChatSettingsRequestSchema,
  },
  "/api/ssh-servers": {
    description: "List or create standalone SSH servers.",
    requestSchema: CreateSshServerRequestSchema,
  },
  "/api/ssh-servers/:id": {
    description: "Update or delete a standalone SSH server.",
    requestSchema: UpdateSshServerRequestSchema,
  },
  "/api/ssh-servers/:id/credential-token": {
    description: "Exchange SSH credentials for a temporary credential token.",
    requestSchema: SshCredentialExchangeRequestSchema,
  },
  "/api/ssh-servers/:id/public-key": {
    description: "Read the public key for a standalone SSH server.",
  },
  "/api/ssh-servers/:id/credentials": {
    description: "Exchange an encrypted SSH credential for a temporary token.",
    requestSchema: SshCredentialExchangeRequestSchema,
  },
  "/api/ssh-servers/:id/sessions": {
    description: "List or create standalone SSH server sessions.",
    requestSchema: CreateSshServerSessionRequestSchema,
  },
  "/api/ssh-servers/:id/prerequisites": {
    description: "Check standalone SSH server prerequisites.",
    requestSchema: CheckSshServerPrerequisitesRequestSchema,
  },
  "/api/ssh-servers/:id/prerequisites/check": {
    description: "Run prerequisite checks for a standalone SSH server.",
    requestSchema: CheckSshServerPrerequisitesRequestSchema,
  },
  "/api/ssh-servers/:id/devbox/templates": {
    description: "List available devbox templates for a standalone SSH server.",
  },
  "/api/ssh-servers/:id/sessions/:sessionId": {
    description: "Update or delete an SSH server session.",
    requestSchema: UpdateSshSessionRequestSchema,
  },
  "/api/ssh-servers/:id/sessions/:sessionId/delete": {
    description: "Delete an SSH server session with confirmation payload.",
    requestSchema: DeleteSshServerSessionRequestSchema,
  },
  "/api/ssh-servers/:id/files": {
    description: "List standalone SSH server files in the active explorer root.",
    querySchema: ListWorkspaceFilesRequestSchema,
  },
  "/api/ssh-servers/:id/files/content": {
    description: "Read a standalone SSH server file.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/ssh-servers/:id/files/preview": {
    description: "Preview a browser-renderable standalone SSH server image file.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/ssh-servers/:id/files/download": {
    description: "Download a standalone SSH server file from the active explorer root.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/ssh-servers/:id/files/tree": {
    description: "Load the full standalone SSH server file tree.",
    querySchema: GetWorkspaceFileTreeRequestSchema,
  },
  "/api/ssh-servers/:id/files/metadata": {
    description: "Read standalone SSH server file metadata.",
    querySchema: GetWorkspaceFileRequestSchema,
  },
  "/api/ssh-servers/:id/files/write": {
    description: "Write a standalone SSH server file.",
    requestSchema: WriteWorkspaceFileRequestSchema,
  },
  "/api/ssh-sessions": {
    description: "Create a workspace-backed SSH session.",
    requestSchema: CreateSshSessionRequestSchema,
  },
  "/api/ssh-sessions/:id": {
    description: "Update or delete a workspace-backed SSH session.",
    requestSchema: UpdateSshSessionRequestSchema,
  },
  "/api/ssh-server-sessions/:id": {
    description: "Read, update, or delete a standalone SSH server session.",
    requestSchema: z.union([
      UpdateSshSessionRequestSchema,
      DeleteSshServerSessionRequestSchema,
    ]),
  },
  "/api/provisioning-jobs": {
    description: "Start a remote provisioning job.",
    requestSchema: CreateProvisioningJobRequestSchema,
    querySchema: SensitiveQuerySchema,
  },
  "/api/provisioning-jobs/:id": {
    description: "Read or cancel a remote provisioning job.",
    querySchema: SensitiveQuerySchema,
  },
  "/api/provisioning-jobs/:id/logs": {
    description: "Read logs for a remote provisioning job.",
  },
  "/api/settings/reset-all": {
    description: "Reset all persisted settings and recreate the database.",
  },
  "/api/settings/purge-terminal-loops": {
    description: "Purge terminal-state loops across all workspaces.",
  },
  "/api/server/kill": {
    description: "Shut down the Ralpher server process.",
  },
};

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.includes(value as HttpMethod);
}

function getRouteMethods(handler: RouteHandler): HttpMethod[] {
  if (typeof handler === "function") {
    return ["GET"];
  }

  return Object.keys(handler)
    .filter(isHttpMethod)
    .sort() as HttpMethod[];
}

function getRouteEntries(): ApiEndpointCatalogEntry[] {
  return Object.entries(apiRoutes)
    .map(([path, handler]) => {
      const override = endpointOverrides[path] ?? {};
      return {
        path,
        cliPath: getCliEndpointPath(path),
        methods: getRouteMethods(handler as RouteHandler),
        description: override.description,
        requestSchema: override.requestSchema,
        querySchema: override.querySchema,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function getCliEndpointPath(path: string): string {
  return path.startsWith("/api/") ? path.slice("/api/".length) : path;
}

function normalizeEndpointPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("API endpoint is required");
  }

  if (trimmed.startsWith("/api/")) {
    return trimmed;
  }
  if (trimmed.startsWith("api/")) {
    return `/${trimmed}`;
  }
  if (trimmed.startsWith("/")) {
    return `/api${trimmed}`;
  }
  return `/api/${trimmed}`;
}

function stripEndpointSuffix(input: string): string {
  const queryIndex = input.indexOf("?");
  const fragmentIndex = input.indexOf("#");
  let endIndex = input.length;
  if (queryIndex >= 0) {
    endIndex = queryIndex;
  }
  if (fragmentIndex >= 0 && fragmentIndex < endIndex) {
    endIndex = fragmentIndex;
  }
  return input.slice(0, endIndex);
}

function matchesRoutePattern(routePath: string, endpointPath: string): boolean {
  const routePattern = routePath
    .split("/")
    .map((segment) => {
      if (!segment) {
        return "";
      }
      if (segment.startsWith(":")) {
        return "[^/]+";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const matcher = new RegExp(`^${routePattern}$`);
  return matcher.test(endpointPath);
}

export function listApiEndpoints(): ApiEndpointCatalogEntry[] {
  return getRouteEntries().filter((entry) => entry.path.startsWith("/api/"));
}

export function findApiEndpoint(input: string): ApiEndpointCatalogEntry | null {
  const normalizedPath = normalizeEndpointPath(stripEndpointSuffix(input));
  const entries = listApiEndpoints();
  return entries.find((entry) => entry.path === normalizedPath)
    ?? entries.find((entry) => matchesRoutePattern(entry.path, normalizedPath))
    ?? null;
}

export function normalizeApiEndpointPath(input: string): string {
  return normalizeEndpointPath(input);
}

export function formatSchema(schema: z.ZodTypeAny): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
