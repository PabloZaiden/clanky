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
 * - agents-md: AGENTS.md optimization for Clanky
 * - ssh-servers: Standalone SSH server registry, credentials, sessions, VNC, and files
 * - terminal-sessions: Transport-neutral workspace terminal sessions
 * - provisioning: Remote workspace provisioning jobs
 * - chats: Standalone and task-linked chat sessions
 * - agents: Scheduled-agent management and runs
 * - vnc-sessions: VNC session management
 * - previews: Workspace preview management
 * - mesh: Linked-instance pairing and transport membership
 * - agent-prompt-bridge: Internal deterministic-agent prompt bridge
 * - raw websocket upgrades: Realtime, terminal, preview, and VNC transports are defined separately
 * 
 * @module api
 */

import { defineRoutes, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../core/user-context";
import { agentPromptBridgeRoutes } from "./agent-prompt-bridge";
import { tasksRoutes } from "./tasks";
import { modelsAndPreferencesRoutes } from "./models";
import { settingsRoutes } from "./settings";
import { gitRoutes } from "./git";
import { workspacesRoutes } from "./workspaces";
import { agentsMdRoutes } from "./agents-md";
import { sshServersRoutes } from "./ssh-servers";
import { sshServerFilesRoutes } from "./ssh-server-files";
import { terminalSessionsRoutes } from "./terminal-sessions";
import { provisioningRoutes } from "./provisioning";
import { chatsRoutes } from "./chats";
import { agentsRoutes } from "./agents";
import { vncSessionRoutes } from "./vnc-sessions";
import { previewRoutes } from "./previews";
import { meshRoutes } from "./mesh";

/**
 * All API routes combined.
 * 
 * Raw WebSocket upgrades are handled separately in src/server.ts; the framework
 * realtime endpoint is also registered by the webapp server.
 */
const nativeApiRoutes = {
  ...tasksRoutes,
  ...modelsAndPreferencesRoutes,
  ...settingsRoutes,
  ...gitRoutes,
  ...workspacesRoutes,
  ...agentsMdRoutes,
  ...sshServerFilesRoutes,
  ...sshServersRoutes,
  ...terminalSessionsRoutes,
  ...provisioningRoutes,
  ...chatsRoutes,
  ...agentsRoutes,
  ...vncSessionRoutes,
  ...previewRoutes,
  ...meshRoutes,
  ...agentPromptBridgeRoutes,
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

export const apiRoutes = defineRoutes(withApiUserContext(nativeApiRoutes));

// Re-export individual route modules
export * from "./helpers";
export * from "./tasks";
export * from "./models";
export * from "./settings";
export * from "./git";
export * from "./workspaces";
export * from "./agents-md";
export * from "./ssh-servers";
export * from "./ssh-server-files";
export * from "./terminal-sessions";
export * from "./websocket";
export * from "./provisioning";
export * from "./chats";
export * from "./agents";
export * from "./vnc-sessions";
export * from "./previews";
export * from "./agent-prompt-bridge";
export * from "./mesh";
