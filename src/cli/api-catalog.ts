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
  SendChatMessageRequestSchema,
  ServerSettingsSchema,
  SetDashboardViewModeRequestSchema,
  SetFileExplorerFullTreeRequestSchema,
  SetLastCheapModelRequestSchema,
  SetLastDirectoryRequestSchema,
  SetLastModelRequestSchema,
  SetLogLevelRequestSchema,
  SetMarkdownRenderingRequestSchema,
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
  "/api/auth/issuer": {
    description: "Read or update the token issuer settings.",
    requestSchema: IssuerSettingsSchema,
  },
  "/api/passkey-auth/registration/verify": {
    description: "Complete passkey registration.",
    requestSchema: CompletePasskeyRegistrationRequestSchema,
  },
  "/api/passkey-auth/authentication/verify": {
    description: "Complete passkey authentication.",
    requestSchema: CompletePasskeyAuthenticationRequestSchema,
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
  "/api/loops/:id/plan/feedback": {
    description: "Submit feedback on a generated loop plan.",
    requestSchema: PlanFeedbackRequestSchema,
  },
  "/api/loops/:id/plan/accept": {
    description: "Accept a generated loop plan.",
    requestSchema: PlanAcceptRequestSchema,
  },
  "/api/loops/:id/address-comments": {
    description: "Address review comments for a loop.",
    requestSchema: AddressCommentsRequestSchema,
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
  "/api/loops/:id/port-forwards": {
    description: "Create or list loop port forwards.",
    requestSchema: CreatePortForwardRequestSchema,
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
  "/api/workspaces": {
    description: "List workspaces or create a workspace.",
    requestSchema: CreateWorkspaceRequestSchema,
  },
  "/api/workspaces/:id": {
    description: "Read, update, or delete a workspace.",
    requestSchema: UpdateWorkspaceRequestSchema,
  },
  "/api/workspaces/import": {
    description: "Import workspaces from an export bundle.",
    requestSchema: WorkspaceImportRequestSchema,
  },
  "/api/workspaces/:id/server-settings": {
    description: "Read or update workspace server settings.",
    requestSchema: ServerSettingsSchema,
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
  "/api/ssh-servers/:id/sessions": {
    description: "Create an ad-hoc SSH server session.",
    requestSchema: CreateSshServerSessionRequestSchema,
  },
  "/api/ssh-servers/:id/prerequisites": {
    description: "Check standalone SSH server prerequisites.",
    requestSchema: CheckSshServerPrerequisitesRequestSchema,
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
  "/api/provisioning-jobs": {
    description: "Start a remote provisioning job.",
    requestSchema: CreateProvisioningJobRequestSchema,
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
