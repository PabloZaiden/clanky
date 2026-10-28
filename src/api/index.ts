/**
 * Central export for the API module.
 * 
 * Combines all API routes from individual modules into the webapp server's
 * native route table.
 * 
 * Route Modules:
 * - tasks: Task CRUD, lifecycle, transcript, control, data, and review operations
 * - models: AI model listing and user preferences
 * - settings: Server configuration and connection management
 * - git: Git repository and GitHub information
 * - workspaces: Workspace CRUD, server settings, previews, and file operations
 * - ssh-servers: SSH execution-host registration and credential exchange
 * - terminal-sessions: Transport-neutral terminal sessions
 * - provisioning: Remote workspace provisioning jobs
 * - chats: Standalone and task-linked chat sessions
 * - agents: Scheduled-agent management and runs
 * - previews: Workspace and direct server preview management
 * - mesh: Controller-managed worker enrollment and transport
 * - agent-prompt-bridge: Internal deterministic-agent prompt bridge
 * - raw websocket upgrades: Realtime, terminal, and preview transports are defined separately
 * 
 * @module api
 */

import { defineRoutes, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../context/user-context";
import { agentPromptBridgeRoutes } from "./agent-prompt-bridge";
import { tasksRoutes } from "./tasks";
import { modelsAndPreferencesRoutes } from "./models";
import { settingsRoutes } from "./settings";
import { gitRoutes } from "./git";
import { workspacesRoutes } from "./workspaces";
import { sshServersRoutes } from "./ssh-servers";
import { terminalSessionsRoutes } from "./terminal-sessions";
import { provisioningRoutes } from "./provisioning";
import { workerUpdateRoutes } from "./worker-update-jobs";
import { chatsRoutes } from "./chats/index";
import { trashRoutes } from "./trash";
import { agentsRoutes } from "./agents";
import { previewRoutes } from "./previews";
import { meshRoutes } from "./mesh";
import { meshRelayRoutes } from "./mesh-relay";
import { workspaceWorkerEnrollmentRoutes } from "./workspace-worker-enrollments";
import { executionHostRoutes } from "./execution-hosts";
import { executionHostFilesRoutes } from "./execution-host-files";
import { voiceRoutes } from "./voice";
import { liveVoiceRoutes } from "./live-voice";
import { controlUiActionRoutes } from "./control-ui-actions";
import { taskCreationContextRoutes } from "./task-creation-context";
import { withResourceReads } from "./resource-reads";
import { collaborationRoutes, workspaceClientInternalRoutes } from "./collaboration";
import { withUnifiedWorkspaceResources } from "./workspace-federation";
import { CONTROL_RESOURCE_TAG } from "../core/control-authority";
import { controlRoutes } from "./control";

function controlResources(routes: RouteTable): RouteTable {
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => [
    path, { ...route, tags: [...new Set([...(route.tags ?? []), CONTROL_RESOURCE_TAG])] },
  ]));
}

/**
 * All API routes combined.
 * 
 * Raw WebSocket upgrades are handled separately in src/server.ts; the framework
 * realtime endpoint is also registered by the webapp server.
 */
export const nativeApiRoutes = {
  ...controlResources(tasksRoutes),
  ...controlResources(modelsAndPreferencesRoutes),
  ...settingsRoutes,
  ...gitRoutes,
  ...controlResources(workspacesRoutes),
  ...controlResources(sshServersRoutes),
  ...terminalSessionsRoutes,
  ...controlResources(provisioningRoutes),
  ...workerUpdateRoutes,
  ...controlResources(chatsRoutes),
  ...controlResources(trashRoutes),
  ...agentsRoutes,
  ...previewRoutes,
  ...meshRoutes,
  ...meshRelayRoutes,
  ...workspaceWorkerEnrollmentRoutes,
  ...controlResources(executionHostRoutes),
  ...controlResources(executionHostFilesRoutes),
  ...voiceRoutes,
  ...liveVoiceRoutes,
  ...controlUiActionRoutes,
  ...controlRoutes,
  ...controlResources(taskCreationContextRoutes),
  ...agentPromptBridgeRoutes,
  ...collaborationRoutes,
};

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Establish Clanky's current-user context around native webapp route handlers.
 * Authorization and same-origin policy remain on each route.
 */
function withApiUserContext(routes: Record<string, RouteDefinition>): RouteTable {
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => {
    const routeWithContext: RouteDefinition = { ...route };
    for (const method of API_METHODS) {
      const handler = route[method];
      if (!handler) continue;
      routeWithContext[method] = async (req, ctx) => {
        const user = ctx.requireUser();
        return await runWithCurrentUser(user, async () => await handler(req, ctx));
      };
    }
    return [path, routeWithContext];
  }));
}

export const apiRoutes = defineRoutes({
  ...withApiUserContext(withResourceReads(withUnifiedWorkspaceResources(nativeApiRoutes))),
  ...workspaceClientInternalRoutes,
});

// Re-export individual route modules
export * from "./helpers";
export * from "./tasks";
export * from "./models";
export * from "./settings";
export * from "./git";
export * from "./workspaces";
export * from "./ssh-servers";
export * from "./terminal-sessions";
export * from "./websocket";
export * from "./provisioning";
export * from "./worker-update-jobs";
export * from "./chats/index";
export * from "./trash";
export * from "./agents";
export * from "./previews";
export * from "./agent-prompt-bridge";
export * from "./mesh";
export * from "./mesh-relay";
export * from "./workspace-worker-enrollments";
export * from "./execution-hosts";
export * from "./execution-host-files";
export * from "./voice";
export * from "./live-voice";
export * from "./control-ui-actions";
export * from "./task-creation-context";
export * from "./collaboration";
